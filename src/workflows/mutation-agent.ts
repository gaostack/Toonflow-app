import { DurableAgent } from "@workflow/ai/agent";
import { mockSequenceModel, type MockResponseDescriptor } from "@workflow/ai/test";
import { getWritable } from "workflow";
import { z } from "zod";
import type { UIMessageChunk } from "ai";
import { toonflowModel, type VendorSnapshot } from "./toonflow-model.js";
import { getDb } from "./_db.js";
import type { ReadOnlyAgentInput } from "./read-only-agent.js";

/**
 * Re-export the read-only input shape and extend it with the mutation-specific
 * context the workflow steps need to perform idempotent DB writes.
 */
export interface MutationAgentInput extends ReadOnlyAgentInput {
  /** Absolute path to the SQLite database file. */
  dbPath: string;
  projectId: number;
  scriptId: number;
  /** Which mutation tools this agent is allowed to call. */
  allowedTools: (
    | "add_deriveAsset"
    | "del_deriveAsset"
    | "generate_deriveAsset"
    | "generate_storyboard"
    | "add_flowData_storyboard"
  )[];
  /** Optional deterministic mock responses for integration testing. */
  mockResponses?: MockResponseDescriptor[];
}

export type MutationDescriptor =
  | {
      type: "addDeriveAsset";
      data: {
        id: number;
        assetsId: number;
        projectId: number;
        name: string;
        type: string;
        describe: string;
        startTime: number;
      };
    }
  | {
      type: "delDeriveAsset";
      data: {
        assetsId: number;
        id: number;
      };
    }
  | {
      type: "generateDeriveAsset";
      data: {
        ids: number[];
      };
    }
  | {
      type: "generateStoryboard";
      data: {
        ids: number[];
      };
    }
  | {
      type: "addStoryboard";
      data: {
        videoDesc: string;
        prompt: string | null;
        track: string;
        duration: number;
        associateAssetsIds: number[];
        shouldGenerateImage: string;
      };
    };

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

async function emitDescriptor(descriptor: MutationDescriptor): Promise<void> {
  "use step";

  const writer = getWritable<MutationDescriptor>({ namespace: "mutation-descriptors" }).getWriter();
  try {
    await writer.write(descriptor);
  } finally {
    writer.releaseLock();
  }
}

async function closeDescriptorStream(): Promise<void> {
  "use step";

  const writer = getWritable<MutationDescriptor>({ namespace: "mutation-descriptors" }).getWriter();
  try {
    await writer.close();
  } catch {
    // Already closed or never written to — safe to ignore.
  } finally {
    writer.releaseLock();
  }
}

async function addDeriveAsset(args: {
  assetsId: number;
  id: number | null;
  name: string;
  desc: string;
  projectId: number;
  scriptId: number;
  dbPath: string;
}): Promise<string> {
  "use step";

  const idRaw = args.id as unknown;
  const normalizedId =
    idRaw === "null" || idRaw === "" || idRaw === undefined || idRaw === null
      ? null
      : (idRaw as number);

  const db = getDb(args.dbPath);
  const parentAssets = await db("o_assets").where("id", args.assetsId).select("id", "type").first();
  if (!parentAssets) {
    return "关联的资产不存在";
  }

  const baseData = {
    assetsId: args.assetsId,
    projectId: args.projectId,
    name: args.name,
    type: parentAssets.type,
    describe: args.desc,
    startTime: Date.now(),
  };

  let resultText: string;
  let rowId: number;

  if (normalizedId) {
    await db("o_assets").where("id", normalizedId).update(baseData);
    rowId = normalizedId;
    resultText = `已更新衍生资产，ID: ${rowId}`;
  } else {
    // Idempotent insert: on replay, reuse the row with the same parent/name.
    const existing = await db("o_assets").where({ assetsId: args.assetsId, name: args.name }).first();
    if (existing) {
      await db("o_assets").where("id", existing.id).update(baseData);
      rowId = existing.id;
      resultText = `已更新衍生资产，ID: ${rowId}`;
    } else {
      const [insertedId] = await db("o_assets").insert(baseData);
      rowId = insertedId;
      await db("o_scriptAssets").insert({ scriptId: args.scriptId, assetId: insertedId });
      resultText = `已新增衍生资产，ID: ${insertedId}`;
    }
  }

  await emitDescriptor({
    type: "addDeriveAsset",
    data: { ...baseData, id: rowId },
  });

  return resultText;
}

async function delDeriveAsset(args: {
  assetsId: number;
  id: number;
  scriptId: number;
  dbPath: string;
}): Promise<string> {
  "use step";

  const db = getDb(args.dbPath);
  await db("o_assets").where("id", args.id).del();
  await db("o_scriptAssets").where({ scriptId: args.scriptId, assetId: args.id }).del();

  await emitDescriptor({
    type: "delDeriveAsset",
    data: { assetsId: args.assetsId, id: args.id },
  });

  return "删除成功";
}

async function generateDeriveAsset(args: { ids: number[] }): Promise<string> {
  "use step";

  await emitDescriptor({
    type: "generateDeriveAsset",
    data: { ids: args.ids },
  });

  return "开始生成衍生资产";
}

async function generateStoryboard(args: { ids: number[] }): Promise<string> {
  "use step";

  await emitDescriptor({
    type: "generateStoryboard",
    data: { ids: args.ids },
  });

  return "开始生成分镜";
}

async function addFlowDataStoryboard(args: {
  videoDesc: string;
  prompt: string | null;
  track: string;
  duration: number;
  associateAssetsIds: number[] | null;
  shouldGenerateImage: string;
}): Promise<true> {
  "use step";

  const data = {
    videoDesc: args.videoDesc,
    prompt: args.prompt,
    track: args.track,
    duration: args.duration,
    associateAssetsIds: args.associateAssetsIds ?? [],
    shouldGenerateImage: args.shouldGenerateImage,
  };

  await emitDescriptor({
    type: "addStoryboard",
    data,
  });

  return true;
}

export async function mutationAgentWorkflow(
  input: MutationAgentInput,
): Promise<{
  finalText: string;
  steps: number;
}> {
  "use workflow";

  const model = input.vendorSnapshot
    ? toonflowModel(input.vendorSnapshot)
    : input.mockResponses
      ? mockSequenceModel(input.mockResponses)
      : mockSequenceModel([{ type: "text", text: `mock ${input.agentLabel}` }]);

  const flowDataJson = JSON.stringify(input.flowData ?? {});

  const tools: Record<string, any> = {
    get_flowData: {
      description: "获取工作区数据（preloaded snapshot — 不再走前端 socket）",
      inputSchema: z.object({
        key: z.string().describe("工作区数据 key: script / assets / scriptPlan / storyboardTable / storyboard"),
      }),
      execute: ({ key }: { key: string }) => readFlowData({ key, flowDataJson }),
    },
  };

  if (input.allowedTools.includes("add_deriveAsset")) {
    tools.add_deriveAsset = {
      description: "新增或更新衍生资产",
      inputSchema: z.object({
        assetsId: z.number().describe("关联的资产ID"),
        id: z.number().nullable().describe("衍生资产ID，如果新增则为空"),
        name: z.string().describe("衍生资产名称"),
        desc: z.string().describe("衍生资产描述"),
      }),
      execute: (raw: any) =>
        addDeriveAsset({
          assetsId: raw.assetsId,
          id: raw.id,
          name: raw.name,
          desc: raw.desc,
          projectId: input.projectId,
          scriptId: input.scriptId,
          dbPath: input.dbPath,
        }),
    };
  }

  if (input.allowedTools.includes("del_deriveAsset")) {
    tools.del_deriveAsset = {
      description: "删除衍生资产",
      inputSchema: z.object({
        assetsId: z.number().describe("关联的资产ID"),
        id: z.number().describe("衍生资产ID"),
      }),
      execute: (raw: any) =>
        delDeriveAsset({
          assetsId: raw.assetsId,
          id: raw.id,
          scriptId: input.scriptId,
          dbPath: input.dbPath,
        }),
    };
  }

  if (input.allowedTools.includes("generate_deriveAsset")) {
    tools.generate_deriveAsset = {
      description: "生成衍生资产图片",
      inputSchema: z.object({
        ids: z.array(z.number()).describe("需要生成的衍生资产ID"),
      }),
      execute: (raw: any) => generateDeriveAsset({ ids: raw.ids }),
    };
  }

  if (input.allowedTools.includes("generate_storyboard")) {
    tools.generate_storyboard = {
      description: "生成分镜图片",
      inputSchema: z.object({
        ids: z.array(z.number()).describe("必须获取真实的分镜ID，支持批量生成"),
      }),
      execute: (raw: any) => generateStoryboard({ ids: raw.ids }),
    };
  }

  if (input.allowedTools.includes("add_flowData_storyboard")) {
    tools.add_flowData_storyboard = {
      description: "新增分镜面板到工作区",
      inputSchema: z.object({
        videoDesc: z.string().describe("画面描述、场景、关联资产名称、时长、景别、运镜、角色动作、情绪、光影氛围、台词、音效、关联资产ID"),
        prompt: z.string().nullable().describe("分镜图片提示词"),
        track: z.string().describe("分组"),
        duration: z.number().describe("视频推荐时间"),
        associateAssetsIds: z.array(z.number()).nullable().describe("该分镜所需的资产ID列表"),
        shouldGenerateImage: z.enum(["true", "false"]).describe("是否需要生成分镜图片"),
      }),
      execute: (raw: any) =>
        addFlowDataStoryboard({
          videoDesc: raw.videoDesc,
          prompt: raw.prompt,
          track: raw.track,
          duration: raw.duration,
          associateAssetsIds: raw.associateAssetsIds,
          shouldGenerateImage: raw.shouldGenerateImage,
        }),
    };
  }

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

  // Close the descriptor stream so the caller's reader terminates cleanly.
  await closeDescriptorStream();

  return { finalText, steps: result.messages.length };
}
