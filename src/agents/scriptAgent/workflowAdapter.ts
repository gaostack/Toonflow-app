import type { MockResponseDescriptor } from "@workflow/ai/test";
import ResTool from "@/socket/resTool";
import u from "@/utils";
import { prefetchSocketData, runInProcessWorkflow, snapshotVendor } from "@/agents/_shared/workflowRuntime";

/**
 * High-level helper for scriptAgent's read-only sub-agents (storySkeleton,
 * adaptationStrategy, script, supervision). Resolves the vendor, pre-fetches
 * the workspace planData via the frontend "getPlanData" socket event, then
 * dispatches the generic scriptReadOnlyAgentWorkflow and maps its
 * UIMessageChunk stream back to ResTool.
 *
 * DB-backed tools (get_novel_events / get_novel_text / get_script_content) read
 * inside the workflow steps via the SQLite path, so they are NOT pre-fetched —
 * only the socket-only planData is.
 */
export async function runScriptSubAgent(opts: {
  agentKey: string;
  systemPrompt: string;
  messages: { role: "user" | "assistant" | "system"; content: string }[];
  /** planData keys to pre-fetch via "getPlanData" (storySkeleton/adaptationStrategy/script). */
  planDataKeys: string[];
  agentLabel: string;
  msgName: string;
  resTool: ResTool;
  abortSignal?: AbortSignal;
  /** Caller's runtime reasoning config (parentCtx.thinkConfig). */
  thinkConfig?: { think: boolean; thinkLevel: 0 | 1 | 2 | 3 };
  /** Deterministic mock responses for integration testing. */
  mockResponses?: MockResponseDescriptor[];
}): Promise<string> {
  const [vendorSnapshot, planData] = await Promise.all([
    snapshotVendor(opts.agentKey, opts.thinkConfig),
    // "getPlanData" returns the whole planData object on any request, so one
    // round-trip (combined) serves all keys.
    prefetchSocketData(opts.resTool, opts.planDataKeys, "getPlanData", true),
  ]);

  // No resolvable vendor AND no explicit mock means a real misconfiguration
  // (missing deploy/vendor row, blank apiKey, model not in list). Fail loudly
  // instead of silently running a mock model that would write placeholder text
  // ("mock 编剧") into the workspace and memory.
  if (!vendorSnapshot && !opts.mockResponses) {
    throw new Error(
      `scriptAgent: no model configured for "${opts.agentKey}" — check o_agentDeploy / o_vendorConfig (apiKey, model)`,
    );
  }

  const { projectId } = opts.resTool.data as any;
  if (!projectId) {
    throw new Error("resTool.data missing projectId for scriptAgent workflow");
  }

  const dbPath = u.getPath("db2.sqlite");

  return runInProcessWorkflow({
    workflowId: "workflow//./src/workflows/script-read-only-agent//scriptReadOnlyAgentWorkflow",
    args: [
      {
        vendorSnapshot,
        systemPrompt: opts.systemPrompt,
        messages: opts.messages,
        planData,
        planDataKeys: opts.planDataKeys,
        dbPath,
        projectId,
        agentLabel: opts.agentLabel,
        mockResponses: opts.mockResponses,
      },
    ],
    resTool: opts.resTool,
    msgName: opts.msgName,
    abortSignal: opts.abortSignal,
  });
}
