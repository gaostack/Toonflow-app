import { DurableAgent } from "@workflow/ai/agent";
import { mockSequenceModel, type MockResponseDescriptor } from "@workflow/ai/test";
import { getWritable } from "workflow";
import { z } from "zod";
import type { UIMessageChunk } from "ai";
import { toonflowModel, type VendorSnapshot } from "./toonflow-model.js";
import { getDb } from "./_db.js";
import { queryNovelEvents, queryNovelText, queryScriptContent } from "./_queries.js";

/**
 * Generic workflow for any "read-only" Toonflow scriptAgent sub-agent
 * (storySkeleton / adaptationStrategy / script / supervision).
 *
 * Unlike the productionAgent read-only workflow — where ALL workspace data is
 * pre-fetched into a single `get_flowData` snapshot — scriptAgent sub-agents
 * use four read tools, two of which take agent-chosen arguments and therefore
 * cannot be pre-fetched:
 *
 *  - get_planData      → served from the pre-fetched `planData` snapshot
 *                        (socket "getPlanData" can't be called inside a step)
 *  - get_novel_events  → 'use step' SQLite read (o_novel, by chapterIndexs)
 *  - get_novel_text    → 'use step' SQLite read (o_novel, by chapterIndex)
 *  - get_script_content→ 'use step' SQLite read (o_script, by ids)
 *
 * All tools are read-only — no DB writes, no socket side-effects — so there is
 * no descriptor-replay machinery here (cf. mutation-agent.ts).
 */

export interface ScriptReadOnlyAgentInput {
  vendorSnapshot: VendorSnapshot | null;
  systemPrompt: string;
  /** Conversation messages (some sub-agents prime an assistant context turn). */
  messages: { role: "user" | "assistant" | "system"; content: string }[];
  /** Pre-fetched workspace snapshot, keyed by planData key. */
  planData: Record<string, unknown>;
  /** Allowed planData keys (drives get_planData validation; from the caller's prefetch). */
  planDataKeys: string[];
  /** Absolute path to the SQLite database file (for the DB-read steps). */
  dbPath: string;
  projectId: number;
  /** Label echoed in mock fallback for visibility when no real vendor is configured. */
  agentLabel: string;
  /** Optional deterministic mock responses for integration testing. */
  mockResponses?: MockResponseDescriptor[];
}

async function readPlanData(args: { key: string; planDataJson: string }): Promise<string> {
  "use step";

  const data = JSON.parse(args.planDataJson) as Record<string, unknown>;
  const value = data[args.key];
  // Only null/undefined means "not preloaded". An empty string is a legitimate
  // value (workspace field intentionally cleared) and must pass through, matching
  // the original get_planData tool (planData[key] ?? "无数据").
  if (value === undefined || value === null) {
    return `(no preloaded data for key "${args.key}")`;
  }
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

async function getNovelEvents(args: { chapterIndexs: number[]; projectId: number; dbPath: string }): Promise<string> {
  "use step";
  return queryNovelEvents(getDb(args.dbPath), args.projectId, args.chapterIndexs);
}

async function getNovelText(args: { chapterIndex: string; projectId: number; dbPath: string }): Promise<string> {
  "use step";
  return queryNovelText(getDb(args.dbPath), args.projectId, args.chapterIndex);
}

async function getScriptContent(args: { ids: string[]; dbPath: string }): Promise<string> {
  "use step";
  return queryScriptContent(getDb(args.dbPath), args.ids);
}

export async function scriptReadOnlyAgentWorkflow(input: ScriptReadOnlyAgentInput): Promise<{
  finalText: string;
  steps: number;
}> {
  "use workflow";

  // A mock model is only ever legitimate when explicit mockResponses are
  // supplied (integration tests / FORCE_MOCK). A null vendorSnapshot with no
  // mockResponses means the vendor config is broken — fail loudly rather than
  // emit placeholder "mock <label>" text as if it were a real generation.
  if (!input.vendorSnapshot && !input.mockResponses) {
    throw new Error(`scriptReadOnlyAgentWorkflow: no vendor configured for "${input.agentLabel}" and no mockResponses supplied`);
  }

  const model = input.vendorSnapshot
    ? toonflowModel(input.vendorSnapshot)
    : mockSequenceModel(input.mockResponses!);

  // Serialize the pre-fetched snapshot once so the inner step closure only
  // captures a string — safer than letting workflow-sdk serialize nested values.
  const planDataJson = JSON.stringify(input.planData ?? {});

  // Validate against the keys the caller actually prefetched rather than a
  // hardcoded literal, so the workflow stays in sync with whatever planData the
  // adapter supplies. Fall back to a free string if none were provided.
  const planKeySchema =
    input.planDataKeys && input.planDataKeys.length > 0
      ? z.enum(input.planDataKeys as [string, ...string[]])
      : z.string();

  const agent = new DurableAgent({
    model,
    system: input.systemPrompt,
    tools: {
      get_planData: {
        description: "获取工作区数据（preloaded snapshot — 不再走前端 socket）",
        inputSchema: z.object({
          key: planKeySchema.describe("工作区数据 key"),
        }),
        execute: ({ key }: { key: string }) => readPlanData({ key, planDataJson }),
      },
      get_novel_events: {
        description: "获取章节事件",
        inputSchema: z.object({
          chapterIndexs: z.array(z.number()).describe("章节的编号"),
        }),
        execute: ({ chapterIndexs }: { chapterIndexs: number[] }) =>
          getNovelEvents({ chapterIndexs, projectId: input.projectId, dbPath: input.dbPath }),
      },
      get_novel_text: {
        description: "获取小说章节原始文本内容",
        inputSchema: z.object({
          chapterIndex: z.string().describe("章节编号"),
        }),
        execute: ({ chapterIndex }: { chapterIndex: string }) =>
          getNovelText({ chapterIndex, projectId: input.projectId, dbPath: input.dbPath }),
      },
      get_script_content: {
        description: "获取剧本本内容",
        inputSchema: z.object({
          ids: z.array(z.string()).describe("脚本id"),
        }),
        execute: ({ ids }: { ids: string[] }) => getScriptContent({ ids, dbPath: input.dbPath }),
      },
    },
  });

  const writable = getWritable<UIMessageChunk>();
  const result = await agent.stream({
    messages: input.messages,
    writable,
    maxSteps: 8,
  });

  const finalText = result.messages
    .filter((m) => m.role === "assistant")
    .flatMap((m) => (Array.isArray(m.content) ? m.content : [{ type: "text", text: m.content }]))
    .filter((p: any) => p.type === "text")
    .map((p: any) => p.text)
    .join("\n");

  return { finalText, steps: result.messages.length };
}
