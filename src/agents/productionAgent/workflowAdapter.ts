import ResTool from "@/socket/resTool";
import u from "@/utils";
import * as dotenv from "dotenv";
import * as path from "path";
import * as fs from "fs";
import { transform } from "sucrase";
import type { Express } from "express";
import type { Server as HttpServer } from "http";
import type { MutationDescriptor } from "@/types/mutation-descriptors";

dotenv.config({ path: path.resolve(process.cwd(), ".env"), quiet: true } as any);

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
}

interface RunWorkflowArgs {
  workflowId: string;
  args: unknown[];
  resTool: ResTool;
  msgName: string;
  abortSignal?: AbortSignal;
}

let bundle: any = null;
let runtimeBootstrapped = false;

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
 * For dev convenience: if KIMI_API_KEY is set in env and DB has no Kimi key,
 * patch the inputValues with the env key so we don't have to round-trip
 * through the UI.
 */
export async function snapshotVendor(agentKey: string): Promise<VendorSnapshot | null> {
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

  // Dev fallback: if there's no deploy mapping yet but KIMI_API_KEY is in env,
  // pretend the agent is wired to kimicoding so we can dogfood end-to-end
  // without the UI round-trip. Production paths must rely on real DB config.
  let resolvedModelName: string | undefined = deployRow?.modelName;
  if (!resolvedModelName && process.env.KIMI_API_KEY) {
    resolvedModelName = "kimicoding:kimi-for-coding";
    console.warn(`[workflowAdapter] no deploy config for ${agentKey} — using KIMI_API_KEY env fallback`);
  }
  if (!resolvedModelName) {
    console.warn(`[workflowAdapter] no deploy config for ${agentKey}`);
    return null;
  }

  const [vendorId, modelName] = resolvedModelName.split(/:(.+)/);

  const vendorRow = await u.db("o_vendorConfig").where("id", vendorId).first();
  if (!vendorRow) {
    console.warn(`[workflowAdapter] vendor ${vendorId} not registered`);
    return null;
  }

  let vendorInputs: Record<string, string> = {};
  try {
    vendorInputs = JSON.parse(vendorRow.inputValues ?? "{}");
  } catch { }

  // Dev fallback: env-supplied Kimi key beats empty DB.
  if (vendorId === "kimicoding" && !vendorInputs.apiKey && process.env.KIMI_API_KEY) {
    vendorInputs = {
      ...vendorInputs,
      apiKey: process.env.KIMI_API_KEY.replace(/^Bearer\s+/i, ""),
      baseUrl: vendorInputs.baseUrl || process.env.KIMI_BASE_URL || "https://api.kimi.com/coding/v1",
    };
  }

  if (!vendorInputs.apiKey) {
    console.warn(`[workflowAdapter] vendor ${vendorId} has no apiKey configured`);
    return null;
  }

  const modelList = await u.vendor.getModelList(vendorId);
  const modelMeta = modelList.find((m: any) => m.modelName === modelName);
  if (!modelMeta) {
    console.warn(`[workflowAdapter] model ${modelName} not in vendor ${vendorId} model list`);
    return null;
  }

  const tsCode = u.vendor.getCode(vendorId);
  if (!tsCode) {
    console.warn(`[workflowAdapter] vendor ${vendorId} code file missing`);
    return null;
  }
  const vendorCodeJs = transform(tsCode, { transforms: ["typescript"] }).code;

  return {
    vendorId,
    vendorCodeJs,
    vendorInputs,
    modelMeta,
    think: !!modelMeta.think,
    thinkLevel: 0,
  };
}

/**
 * Pre-fetch workspace data via Socket.IO callback to the frontend. Runs in the
 * Toonflow main process BEFORE the workflow starts so the workflow itself can
 * be deterministic + replayable.
 */
export async function prefetchFlowData(resTool: ResTool, keys: string[]): Promise<Record<string, unknown>> {
  const socket = resTool.socket;
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    // Network/timeout failures throw — silently substituting null would cause
    // the LLM to hallucinate without input data. Frontend explicitly returning
    // a value (including null/undefined for "no data") is fine and preserved.
    const flowData: any = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`prefetchFlowData "${key}" timed out after 30s`)), 30_000);
      try {
        socket.emit("getFlowData", { key }, (res: any) => {
          clearTimeout(timeout);
          resolve(res);
        });
      } catch (e) {
        clearTimeout(timeout);
        reject(e);
      }
    });
    result[key] = flowData?.[key];
    if (result[key] == null) {
      console.warn(`[workflowAdapter] prefetch "${key}" returned no data — agent will see (no preloaded data...) when it calls get_flowData`);
    }
  }
  return result;
}

/**
 * High-level helper for read-only sub-agents (director_plan, supervision,
 * storyboard_table). Resolves vendor + pre-fetches workspace data + calls
 * the generic readOnlyAgentWorkflow + maps UIMessageChunk → ResTool.
 */
export async function runReadOnlySubAgent(opts: {
  agentKey: string;
  systemPrompt: string;
  userPrompt: string;
  flowDataKeys: string[];
  agentLabel: string;
  msgName: string;
  resTool: ResTool;
  abortSignal?: AbortSignal;
}): Promise<string> {
  const [vendorSnapshot, flowData] = await Promise.all([
    snapshotVendor(opts.agentKey),
    prefetchFlowData(opts.resTool, opts.flowDataKeys),
  ]);

  return runInProcessWorkflow({
    workflowId: "workflow//./src/workflows/read-only-agent//readOnlyAgentWorkflow",
    args: [
      {
        vendorSnapshot,
        systemPrompt: opts.systemPrompt,
        userPrompt: opts.userPrompt,
        flowData,
        agentLabel: opts.agentLabel,
      },
    ],
    resTool: opts.resTool,
    msgName: opts.msgName,
    abortSignal: opts.abortSignal,
  });
}

/**
 * Start a workflow in-process via the mounted runtime, read its UIMessageChunk
 * stream, and emit each chunk as the equivalent ResTool method on a new sub-agent
 * message. Returns the accumulated assistant text.
 */
export async function runInProcessWorkflow({ workflowId, args, resTool, msgName, abortSignal }: RunWorkflowArgs): Promise<string> {
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

  return accumulatedText;
}

/**
 * High-level helper for mutation-heavy sub-agents (derive_assets first).
 *
 * Mirrors runReadOnlySubAgent but passes project/script context and the DB path
 * into the workflow so the workflow steps can perform idempotent DB writes.
 * After the run completes, side-effect descriptors collected in the
 * "mutation-descriptors" stream are replayed as Socket.IO events.
 */
export async function runMutationSubAgent(opts: {
  agentKey: string;
  systemPrompt: string;
  userPrompt: string;
  flowDataKeys: string[];
  agentLabel: string;
  msgName: string;
  resTool: ResTool;
  abortSignal?: AbortSignal;
  allowedTools: (
    | "add_deriveAsset"
    | "del_deriveAsset"
    | "generate_deriveAsset"
    | "generate_storyboard"
    | "add_flowData_storyboard"
  )[];
  /** Deterministic mock responses for integration testing. */
  mockResponses?: any[];
}): Promise<string> {
  const [vendorSnapshot, flowData] = await Promise.all([
    snapshotVendor(opts.agentKey),
    prefetchFlowData(opts.resTool, opts.flowDataKeys),
  ]);

  const { projectId, scriptId } = opts.resTool.data as any;
  if (!projectId || !scriptId) {
    throw new Error("resTool.data missing projectId or scriptId for mutation workflow");
  }

  const dbPath = u.getPath("db2.sqlite");

  const { finalText, descriptors } = await runMutationWorkflow({
    workflowId: "workflow//./src/workflows/mutation-agent//mutationAgentWorkflow",
    args: [
      {
        vendorSnapshot,
        systemPrompt: opts.systemPrompt,
        userPrompt: opts.userPrompt,
        flowData,
        agentLabel: opts.agentLabel,
        dbPath,
        projectId,
        scriptId,
        allowedTools: opts.allowedTools,
        mockResponses: opts.mockResponses,
      },
    ],
    resTool: opts.resTool,
    msgName: opts.msgName,
    abortSignal: opts.abortSignal,
  });

  if (descriptors.length) {
    await replayDescriptors(opts.resTool, descriptors);
  }

  return finalText;
}

/**
 * Run a mutation workflow, consume its default UIMessageChunk stream, and then
 * collect the side-effect descriptors from the "mutation-descriptors" namespace.
 */
async function runMutationWorkflow({
  workflowId,
  args,
  resTool,
  msgName,
  abortSignal,
}: RunWorkflowArgs): Promise<{ finalText: string; descriptors: MutationDescriptor[] }> {
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
    try {
      reader.cancel();
    } catch {}
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

  // Collect side-effect descriptors from the namespaced stream.
  const descriptors: MutationDescriptor[] = [];
  try {
    const descriptorReader = run.getReadable({ namespace: "mutation-descriptors" }).getReader();
    try {
      while (true) {
        const { done, value } = await descriptorReader.read();
        if (done) break;
        if (value) descriptors.push(value);
      }
    } finally {
      descriptorReader.releaseLock();
    }
  } catch (e) {
    console.error("[workflowAdapter] failed to read mutation-descriptors stream:", e);
  }

  return { finalText: accumulatedText, descriptors };
}

/**
 * Small serial queue for socket emits, mirroring the 800ms delay used in
 * src/agents/productionAgent/tools.ts for storyboard operations.
 */
function createSocketQueue(delayMs = 800) {
  let lastPromise: Promise<any> = Promise.resolve();
  return <T>(fn: () => Promise<T>): Promise<T> => {
    lastPromise = lastPromise.then(
      () =>
        new Promise<T>((resolve, reject) => {
          setTimeout(() => fn().then(resolve, reject), delayMs);
        }),
    );
    return lastPromise;
  };
}

/**
 * Replay recorded side-effect descriptors as Socket.IO events to the frontend.
 * These are fire-and-forget: the workflow already performed the DB write and
 * returned the result to the LLM, so we only need the UI to observe the change.
 */
async function replayDescriptors(resTool: ResTool, descriptors: MutationDescriptor[]): Promise<void> {
  const { socket } = resTool;
  if (!socket) {
    console.warn("[workflowAdapter] no socket available to replay descriptors");
    return;
  }

  // Storyboard operations are queued in the legacy path; preserve the same pacing.
  // We collect the queued promises and await them so the caller knows all emits
  // have been delivered before returning.
  const storyboardQueue = createSocketQueue(800);
  const pending: Promise<any>[] = [];

  for (const d of descriptors) {
    switch (d.type) {
      case "addDeriveAsset":
        socket.emit("addDeriveAsset", d.data, () => {});
        break;
      case "delDeriveAsset":
        socket.emit("delDeriveAsset", d.data, () => {});
        break;
      case "generateDeriveAsset":
        socket.emit("generateDeriveAsset", d.data, () => {});
        break;
      case "generateStoryboard":
        pending.push(
          storyboardQueue(
            () =>
              new Promise((resolve, reject) =>
                socket.emit("generateStoryboard", d.data, (res: any) => (res?.error ? reject(new Error(res.error)) : resolve(res))),
              ),
          ),
        );
        break;
      case "addStoryboard":
        pending.push(
          storyboardQueue(
            () =>
              new Promise((resolve, reject) =>
                socket.emit("addStoryboard", d.data, (res: any) => (res?.error ? reject(new Error(res.error)) : resolve(res))),
              ),
          ),
        );
        break;
      default:
        console.warn("[workflowAdapter] unknown descriptor type:", (d as any).type);
    }
  }

  // Wait for all queued storyboard emits to be acknowledged by the frontend.
  await Promise.allSettled(pending);
}
