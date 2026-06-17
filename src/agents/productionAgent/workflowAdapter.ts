import ResTool from "@/socket/resTool";
import u from "@/utils";
import type { MutationDescriptor } from "@/types/mutation-descriptors";
import {
  bootstrapWorkflowRuntime,
  prefetchSocketData,
  runInProcessWorkflow,
  snapshotVendor,
  startAndStreamWorkflow,
  type RunWorkflowArgs,
  type VendorSnapshot,
} from "@/agents/_shared/workflowRuntime";

// Re-export the shared runtime surface so existing import sites
// (src/app.ts, scripts/spike-*.ts) keep importing from this module unchanged.
export { bootstrapWorkflowRuntime, snapshotVendor, runInProcessWorkflow };
export type { VendorSnapshot };

/**
 * Pre-fetch productionAgent workspace data via the frontend "getFlowData"
 * socket event. Thin wrapper over the shared prefetch helper.
 */
export async function prefetchFlowData(resTool: ResTool, keys: string[]): Promise<Record<string, unknown>> {
  return prefetchSocketData(resTool, keys, "getFlowData");
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
 * Run a mutation workflow, consume its default UIMessageChunk stream (via the
 * shared mapper), and then collect the side-effect descriptors from the
 * "mutation-descriptors" namespace.
 */
async function runMutationWorkflow(opts: RunWorkflowArgs): Promise<{ finalText: string; descriptors: MutationDescriptor[] }> {
  const { text, run } = await startAndStreamWorkflow(opts);

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

  return { finalText: text, descriptors };
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
