/**
 * Smoke test for the mutation workflow path (derive_assets).
 *
 * Stands up a minimal Express server, bootstraps the workflow runtime, and runs
 * the derive-assets agent with deterministic mock tool calls. Verifies that:
 * - the workflow completes successfully
 - DB rows are written inside the workflow step
 * - side-effect descriptors are replayed as Socket.IO events
 */

import express from "express";
import http from "node:http";
import u from "@/utils";
import ResTool from "@/socket/resTool";
import { bootstrapWorkflowRuntime, runMutationSubAgent } from "@/agents/productionAgent/workflowAdapter";
import type { MutationDescriptor } from "@/types/mutation-descriptors";

process.env.TOONFLOW_WORKFLOW_FORCE_MOCK = "1";

const PORT = 14120;
const TEST_PROJECT_ID = 99999;
const TEST_SCRIPT_ID = 99999;
const DERIVE_ASSET_NAME = "spike-derive-asset";

interface EmittedEvent {
  event: string;
  payload: any;
}

function createFakeSocket() {
  const events: EmittedEvent[] = [];
  const socket = {
    emit: (event: string, payload: any, callback?: any) => {
      events.push({ event, payload });
      if (event === "getFlowData" && typeof callback === "function") {
        callback({ script: "测试剧本", assets: [] });
      } else if (typeof callback === "function") {
        callback();
      }
    },
  } as any;
  return { socket, events };
}

async function cleanup() {
  await u.db("o_scriptAssets").where("scriptId", TEST_SCRIPT_ID).del();
  await u.db("o_assets").where("projectId", TEST_PROJECT_ID).del();
}

async function main() {
  console.log("=== Spike: mutation workflow (derive_assets) ===\n");

  const app = express();
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(PORT, r));
  console.log(`spike host on http://localhost:${PORT}`);

  await bootstrapWorkflowRuntime(app, server, PORT);
  app.use(express.json({ limit: "10mb" }));

  // Clean any leftover test rows from a previous failed run.
  await cleanup();

  // Insert a parent asset that the derive-asset tool can reference.
  const [parentId] = await u.db("o_assets").insert({
    projectId: TEST_PROJECT_ID,
    scriptId: TEST_SCRIPT_ID,
    name: "spike-parent-asset",
    type: "role",
    assetsId: null,
  });
  console.log(`created parent asset id=${parentId}`);

  const { socket, events } = createFakeSocket();
  const resTool = new ResTool(socket, { projectId: TEST_PROJECT_ID, scriptId: TEST_SCRIPT_ID });

  const mockAddInput = {
    assetsId: parentId,
    id: null,
    name: DERIVE_ASSET_NAME,
    desc: "spike 测试描述",
  };

  console.log("\n--- running runMutationSubAgent ---");
  const t0 = Date.now();
  const result = await runMutationSubAgent({
    agentKey: "productionAgent:deriveAssetsAgent",
    systemPrompt: "你是一个测试 agent，必须调用 add_deriveAsset 工具。",
    userPrompt: "新增一个测试衍生资产。",
    flowDataKeys: ["script", "assets"],
    agentLabel: "deriveAssets",
    msgName: "执行导演",
    resTool,
    allowedTools: ["add_deriveAsset", "del_deriveAsset", "generate_deriveAsset"],
    // Force the agent to execute add_deriveAsset deterministically.
    mockResponses: [
      {
        type: "tool-call",
        toolName: "add_deriveAsset",
        input: JSON.stringify(mockAddInput),
      },
      {
        type: "text",
        text: "衍生资产分析完成",
      },
    ] as any,
  });
  const elapsed = ((Date.now() - t0) / 1000).toFixed(2);

  console.log(`\n--- DONE in ${elapsed}s ---`);
  console.log(`result: ${result}`);

  // Verify DB state.
  const deriveRow = await u.db("o_assets")
    .where({ assetsId: parentId, name: DERIVE_ASSET_NAME })
    .first();
  if (!deriveRow) {
    throw new Error("derive asset row not found in o_assets");
  }
  console.log(`DB row in o_assets: id=${deriveRow.id}, name=${deriveRow.name}`);

  const linkRow = await u.db("o_scriptAssets")
    .where({ scriptId: TEST_SCRIPT_ID, assetId: deriveRow.id })
    .first();
  if (!linkRow) {
    throw new Error("script/asset link not found in o_scriptAssets");
  }
  console.log(`DB row in o_scriptAssets: scriptId=${linkRow.scriptId}, assetId=${linkRow.assetId}`);

  // Verify descriptor replay.
  const addEvent = events.find((e) => e.event === "addDeriveAsset");
  if (!addEvent) {
    throw new Error("addDeriveAsset socket event was not replayed");
  }
  if (addEvent.payload.name !== DERIVE_ASSET_NAME) {
    throw new Error(`unexpected replay payload name: ${addEvent.payload.name}`);
  }
  console.log(`replayed addDeriveAsset event for id=${addEvent.payload.id}`);

  // Cleanup.
  await cleanup();

  server.close();
  console.log("\n=== spike passed ===");
  process.exit(0);
}

main().catch(async (e) => {
  console.error("\nERROR:", e);
  try {
    await cleanup();
  } catch {}
  process.exit(1);
});
