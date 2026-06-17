import { DurableAgent } from "@workflow/ai/agent";
import { mockSequenceModel } from "@workflow/ai/test";
import { getWritable } from "workflow";
import { z } from "zod";
import type { UIMessageChunk } from "ai";
import { toonflowModel, type VendorSnapshot } from "./toonflow-model.js";

/**
 * Generic workflow for any "read-only" Toonflow sub-agent:
 * - System prompt + user prompt are pre-rendered by the caller
 * - All workspace data the agent might read (script / assets / scriptPlan /
 *   storyboardTable / storyboard) is pre-fetched by the caller and embedded in
 *   `flowData`. The in-workflow `get_flowData` tool just looks up by key from
 *   this snapshot — deterministic, no socket callback, replay-safe.
 * - Output is plain text (typically an XML tag like <scriptPlan> or a markdown
 *   report). No mutation tools.
 *
 * Used by director_plan, supervision, storyboard_table. Mutation-heavy
 * sub-agents (derive_assets, generate_assets, storyboard_gen, storyboard_panel)
 * need a separate workflow with socket-callback hooks.
 */

export interface ReadOnlyAgentInput {
  vendorSnapshot: VendorSnapshot | null;
  systemPrompt: string;
  userPrompt: string;
  flowData: Record<string, unknown>;
  /** Label echoed in mock fallback for visibility when no real vendor is configured. */
  agentLabel: string;
}

async function readFlowData(args: { key: string; flowDataJson: string }): Promise<string> {
  "use step";

  const data = JSON.parse(args.flowDataJson) as Record<string, unknown>;
  const value = data[args.key];
  if (value === undefined || value === null) {
    return `(no preloaded data for key "${args.key}")`;
  }
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

export async function readOnlyAgentWorkflow(input: ReadOnlyAgentInput): Promise<{
  finalText: string;
  steps: number;
}> {
  "use workflow";

  const model = input.vendorSnapshot
    ? toonflowModel(input.vendorSnapshot)
    : mockSequenceModel([{ type: "text", text: `mock ${input.agentLabel}` }]);

  // Serialize flowData once so the inner step closure only captures a string —
  // safer than letting workflow-sdk try to serialize arbitrary nested values.
  const flowDataJson = JSON.stringify(input.flowData ?? {});

  const tools = {
    get_flowData: {
      description: "获取工作区数据（preloaded snapshot — 不再走前端 socket）",
      inputSchema: z.object({
        key: z.string().describe("工作区数据 key: script / assets / scriptPlan / storyboardTable / storyboard"),
      }),
      execute: ({ key }: { key: string }) => readFlowData({ key, flowDataJson }),
    },
  };

  // Sampling config from the snapshot (deploy row), matching the old
  // u.Ai.Text().stream() path. Empty in mock mode (no vendorSnapshot).
  const gen: { temperature?: number; maxOutputTokens?: number } = {};
  if (input.vendorSnapshot?.temperature != null) gen.temperature = input.vendorSnapshot.temperature;
  if (input.vendorSnapshot?.maxOutputTokens != null) gen.maxOutputTokens = input.vendorSnapshot.maxOutputTokens;

  const agent = new DurableAgent({
    model,
    system: input.systemPrompt,
    tools,
    ...gen,
  });

  const writable = getWritable<UIMessageChunk>();
  const result = await agent.stream({
    messages: [{ role: "user", content: input.userPrompt }],
    writable,
    // Step budget = tool count × 50, matching the old u.Ai.Text().stream() path
    // (stopWhen: stepCountIs(tools×50)). Durable steps make a high ceiling cheap.
    maxSteps: Object.keys(tools).length * 50,
  });

  const finalText = result.messages
    .filter((m) => m.role === "assistant")
    .flatMap((m) => (Array.isArray(m.content) ? m.content : [{ type: "text", text: m.content }]))
    .filter((p: any) => p.type === "text")
    .map((p: any) => p.text)
    .join("\n");

  return { finalText, steps: result.messages.length };
}
