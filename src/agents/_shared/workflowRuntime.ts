import ResTool from "@/socket/resTool";
import u from "@/utils";
import * as dotenv from "dotenv";
import * as path from "path";
import * as fs from "fs";
import { transform } from "sucrase";
import type { Express } from "express";
import type { Server as HttpServer } from "http";

dotenv.config({ path: path.resolve(process.cwd(), ".env"), quiet: true } as any);

/**
 * Shared workflow runtime used by every Toonflow agent stack (productionAgent,
 * scriptAgent, ...). It owns the single in-process workflow bundle, vendor
 * snapshotting, socket pre-fetch, and the generic UIMessageChunk → ResTool
 * stream mapper. Agent-specific orchestration (which workflow to dispatch, how
 * to replay mutation side-effects) lives in each agent's own workflowAdapter.ts.
 */

/**
 * Serializable snapshot of a Toonflow vendor at workflow-start time.
 * Crosses the workflow step boundary and is materialized back into a
 * LanguageModelV3 inside the step by toonflowModel().
 */
export interface VendorSnapshot {
  vendorId: string;
  vendorCodeJs: string;
  vendorInputs: Record<string, string>;
  modelMeta: any;
  think: boolean;
  thinkLevel: 0 | 1 | 2 | 3;
  /** Sampling config from o_agentDeploy; passed to DurableAgent's GenerationSettings. */
  temperature?: number;
  maxOutputTokens?: number;
}

export interface RunWorkflowArgs {
  workflowId: string;
  args: unknown[];
  resTool: ResTool;
  msgName: string;
  abortSignal?: AbortSignal;
}

let bundle: any = null;
let runtimeBootstrapped = false;

export function isRuntimeBootstrapped(): boolean {
  return runtimeBootstrapped;
}

/**
 * Mount the workflow runtime middleware onto Toonflow's existing Express app
 * and configure Local World to dispatch handler requests back to this process.
 *
 * Must be called BEFORE server.listen() and BEFORE any auth middleware that
 * would reject the Local World's internal handler dispatches.
 */
export async function bootstrapWorkflowRuntime(app: Express, server: HttpServer, port: number): Promise<void> {
  if (runtimeBootstrapped) return;

  const bundlePath = path.resolve(process.cwd(), ".output/server/index.mjs");
  if (!fs.existsSync(bundlePath)) {
    console.warn(`[workflow] bundle not found at ${bundlePath} — run "yarn build:workflows" first`);
    return;
  }

  // Local World handler dispatches back to this very process; Postgres World
  // doesn't need the base URL (its worker pulls from PG queue directly).
  process.env.WORKFLOW_LOCAL_BASE_URL = `http://localhost:${port}`;

  // Dynamic specifier so esbuild does NOT inline the multi-MB bundle.
  const specifier = bundlePath;
  bundle = await import(specifier);

  // The bundled workflow runtime contains a catch-all /** route (from
  // nitro.config.ts) that would otherwise swallow every request before it
  // reaches Toonflow's own static files / API router. Only dispatch into it
  // for the workflow-internal endpoints Local World actually uses.
  app.use((req: any, res: any, next: any) => {
    if (
      req.path?.startsWith("/.well-known/workflow") ||
      req.path === "/_workflow"
    ) {
      return bundle.middleware(req, res, next);
    }
    next();
  });
  server.on("upgrade", (req: any, socket: any, head: any) => {
    if (req.url?.startsWith?.("/socket.io")) return;
    if (typeof bundle.handleUpgrade === "function") bundle.handleUpgrade(req, socket, head);
  });

  // Production Worlds (Postgres / Vercel) require explicit start() to subscribe
  // their worker to the queue and recover orphan runs. Local World's worker is
  // implicit + in-process, and start() trips on the bundled "version" sentinel
  // in esbuild output, so skip it there.
  if (process.env.WORKFLOW_TARGET_WORLD) {
    try {
      const { getWorld } = await import("workflow/runtime");
      const world = await getWorld();
      await world.start?.();
      console.log(`[workflow] world worker started: ${process.env.WORKFLOW_TARGET_WORLD}`);
    } catch (e) {
      console.error("[workflow] failed to start world worker:", e);
    }
  }

  runtimeBootstrapped = true;
  console.log(`[workflow] runtime mounted on http://localhost:${port}`);
}

/**
 * Build a VendorSnapshot for the given agent by replaying Toonflow's existing
 * vendor abstraction (o_agentDeploy → o_vendorConfig → data/vendor/<id>.ts).
 *
 * Returns null if no vendor can be resolved — caller should fall back to mock.
 *
 * `thinkConfig` carries the caller's runtime reasoning toggle/level (e.g.
 * scriptAgent's parentCtx.thinkConfig). When omitted, think defaults to the
 * model's own capability and level 0 (the productionAgent behavior).
 */
export async function snapshotVendor(
  agentKey: string,
  thinkConfig?: { think: boolean; thinkLevel: 0 | 1 | 2 | 3 },
): Promise<VendorSnapshot | null> {
  if (process.env.TOONFLOW_WORKFLOW_FORCE_MOCK === "1") return null;

  const setting = await u.db("o_setting").where("key", "agentUseMode").first();
  const useAdvanced = setting?.value === "1";

  let deployRow: any = null;
  if (useAdvanced) {
    deployRow = await u.db("o_agentDeploy").where("key", agentKey).first();
  }
  if (!deployRow?.modelName) {
    const [mainly] = agentKey.split(/:(.+)/);
    deployRow = await u.db("o_agentDeploy").where("key", mainly).first();
  }

  if (!deployRow?.modelName) {
    console.warn(`[workflowRuntime] no deploy config for ${agentKey}`);
    return null;
  }

  const [vendorId, modelName] = deployRow.modelName.split(/:(.+)/);

  const vendorRow = await u.db("o_vendorConfig").where("id", vendorId).first();
  if (!vendorRow) {
    console.warn(`[workflowRuntime] vendor ${vendorId} not registered`);
    return null;
  }

  let vendorInputs: Record<string, string> = {};
  try {
    vendorInputs = JSON.parse(vendorRow.inputValues ?? "{}");
  } catch { }

  if (!vendorInputs.apiKey) {
    console.warn(`[workflowRuntime] vendor ${vendorId} has no apiKey configured`);
    return null;
  }

  const modelList = await u.vendor.getModelList(vendorId);
  const modelMeta = modelList.find((m: any) => m.modelName === modelName);
  if (!modelMeta) {
    console.warn(`[workflowRuntime] model ${modelName} not in vendor ${vendorId} model list`);
    return null;
  }

  const tsCode = u.vendor.getCode(vendorId);
  if (!tsCode) {
    console.warn(`[workflowRuntime] vendor ${vendorId} code file missing`);
    return null;
  }
  const vendorCodeJs = transform(tsCode, { transforms: ["typescript"] }).code;

  return {
    vendorId,
    vendorCodeJs,
    vendorInputs,
    modelMeta,
    think: thinkConfig ? thinkConfig.think : !!modelMeta.think,
    thinkLevel: thinkConfig?.thinkLevel ?? 0,
    // Carry the deploy-row sampling config so DurableAgent matches the old
    // u.Ai.Text().stream() path (which injected these via streamText). Only set
    // when truthy, mirroring ai.ts (`config?.temperature && {...}`).
    temperature: deployRow.temperature || undefined,
    maxOutputTokens: deployRow.maxOutputTokens || undefined,
  };
}

/**
 * Pre-fetch workspace data via a Socket.IO callback to the frontend. Runs in the
 * Toonflow main process BEFORE the workflow starts so the workflow itself can
 * be deterministic + replayable.
 *
 * `eventName` is the socket event the frontend listens on — "getFlowData" for
 * productionAgent, "getPlanData" for scriptAgent. In both cases the callback
 * returns an object keyed by the requested `key`.
 *
 * `combined`: when the frontend returns the WHOLE keyed object on any single
 * request (scriptAgent's "getPlanData" ignores the requested key and returns
 * all of planData), one round-trip serves every key. Per-key mode (default) is
 * for events whose payload differs per key (productionAgent's "getFlowData").
 */
export async function prefetchSocketData(
  resTool: ResTool,
  keys: string[],
  eventName = "getFlowData",
  combined = false,
): Promise<Record<string, unknown>> {
  const socket = resTool.socket;

  // Network/timeout failures throw — silently substituting null would cause the
  // LLM to hallucinate without input data. The frontend explicitly returning a
  // value (including null/undefined for "no data") is fine and preserved.
  const emitGet = (key: string): Promise<any> =>
    new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`prefetch "${key}" via ${eventName} timed out after 30s`)), 30_000);
      try {
        socket.emit(eventName, { key }, (res: any) => {
          clearTimeout(timeout);
          resolve(res);
        });
      } catch (e) {
        clearTimeout(timeout);
        reject(e);
      }
    });

  const result: Record<string, unknown> = {};
  const warnMissing = (key: string) => {
    if (result[key] == null) {
      console.warn(`[workflowRuntime] prefetch "${key}" via ${eventName} returned no data — agent will see "(no preloaded data...)"`);
    }
  };

  if (combined) {
    const data = await emitGet(keys[0] ?? "");
    for (const key of keys) {
      result[key] = data?.[key];
      warnMissing(key);
    }
    return result;
  }

  for (const key of keys) {
    const data = await emitGet(key);
    result[key] = data?.[key];
    warnMissing(key);
  }
  return result;
}

/**
 * Start a workflow in-process via the mounted runtime, read its default
 * UIMessageChunk stream, and emit each chunk as the equivalent ResTool method on
 * a new sub-agent message. Returns the accumulated assistant text AND the run
 * handle, so callers that also need namespaced streams (e.g. mutation
 * descriptors) can read them after the main stream drains.
 */
export async function startAndStreamWorkflow({ workflowId, args, resTool, msgName, abortSignal }: RunWorkflowArgs): Promise<{ text: string; run: any }> {
  if (!runtimeBootstrapped) {
    throw new Error("workflow runtime not bootstrapped — call bootstrapWorkflowRuntime() during app startup");
  }

  const msg = resTool.newMessage("assistant", msgName);
  const textStreams = new Map<string, ReturnType<typeof msg.text>>();
  const thinkingStreams = new Map<string, ReturnType<typeof msg.thinking>>();
  let accumulatedText = "";

  const { start } = await import("workflow/api");
  let run: any;
  try {
    run = await start({ workflowId } as any, args as any);
  } catch (e: any) {
    msg.error(`workflow start failed: ${e?.message ?? e}`);
    throw e;
  }

  const reader = run.readable.getReader();
  const onAbort = () => {
    try { reader.cancel(); } catch { }
  };
  abortSignal?.addEventListener?.("abort", onAbort);

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk: any = value;
      if (!chunk || typeof chunk !== "object" || !chunk.type) continue;

      switch (chunk.type) {
        case "text-start": {
          const stream = msg.text();
          textStreams.set(chunk.id, stream);
          break;
        }
        case "text-delta": {
          const stream = textStreams.get(chunk.id);
          if (stream && chunk.delta) {
            stream.append(chunk.delta);
            accumulatedText += chunk.delta;
          }
          break;
        }
        case "text-end": {
          textStreams.get(chunk.id)?.complete();
          textStreams.delete(chunk.id);
          break;
        }
        case "reasoning-start": {
          const stream = msg.thinking("思考中...");
          thinkingStreams.set(chunk.id, stream);
          break;
        }
        case "reasoning-delta": {
          thinkingStreams.get(chunk.id)?.append(chunk.delta ?? "");
          break;
        }
        case "reasoning-end": {
          thinkingStreams.get(chunk.id)?.complete();
          thinkingStreams.delete(chunk.id);
          break;
        }
        case "tool-input-available": {
          msg.toolCall({
            toolCallId: chunk.toolCallId,
            toolName: chunk.toolName,
            args: chunk.input,
          } as any);
          break;
        }
        case "tool-output-available": {
          msg.activity("toolResult", { toolCallId: chunk.toolCallId, output: chunk.output });
          break;
        }
        case "error": {
          // A mid-stream error chunk means the model/tool failed after the run
          // started. Throw so the catch below completes open streams, surfaces
          // msg.error(), and propagates — otherwise the partial accumulated text
          // would be returned as if it were a complete, successful result.
          throw new Error(chunk.errorText ?? chunk.error?.message ?? chunk.error ?? "workflow stream error");
        }
        default: {
          if (typeof chunk.type === "string" && chunk.type.startsWith("data-")) {
            msg.activity(chunk.type.slice(5), chunk.data ?? {});
          }
          break;
        }
      }
    }
    msg.complete();
  } catch (err: any) {
    for (const s of textStreams.values()) s.complete();
    for (const s of thinkingStreams.values()) s.complete();
    msg.error(err?.message ?? String(err));
    throw err;
  } finally {
    abortSignal?.removeEventListener?.("abort", onAbort);
    reader.releaseLock();
  }

  return { text: accumulatedText, run };
}

/**
 * Thin wrapper over startAndStreamWorkflow for callers that only need the
 * accumulated assistant text (read-only sub-agents).
 */
export async function runInProcessWorkflow(args: RunWorkflowArgs): Promise<string> {
  const { text } = await startAndStreamWorkflow(args);
  return text;
}
