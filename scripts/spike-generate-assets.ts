/**
 * Smoke test for the mutation workflow path (generate_assets).
 *
 * Verifies that the generate_deriveAsset tool records a descriptor and that the
 * descriptor is replayed as a Socket.IO event after the run completes.
 */

import express from "express";
import http from "node:http";
import u from "@/utils";
import ResTool from "@/socket/resTool";
import { bootstrapWorkflowRuntime, runMutationSubAgent } from "@/agents/productionAgent/workflowAdapter";

process.env.TOONFLOW_WORKFLOW_FORCE_MOCK = "1";

const PORT = 14130;
const TEST_PROJECT_ID = 99998;
const TEST_SCRIPT_ID = 99998;

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
  console.log("=== Spike: mutation workflow (generate_assets) ===\n");

  const app = express();
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(PORT, r));
  console.log(`spike host on http://localhost:${PORT}`);

  await bootstrapWorkflowRuntime(app, server, PORT);
  app.use(express.json({ limit: "10mb" }));

  await cleanup();

  // Insert a parent asset and a derived asset that we will ask to generate.
  const [parentId] = await u.db("o_assets").insert({
    projectId: TEST_PROJECT_ID,
    scriptId: TEST_SCRIPT_ID,
    name: "spike-parent-asset",
    type: "role",
    assetsId: null,
  });
  const [deriveId] = await u.db("o_assets").insert({
    projectId: TEST_PROJECT_ID,
    scriptId: TEST_SCRIPT_ID,
    name: "spike-derive-asset",
    type: "role",
    assetsId: parentId,
  });
  await u.db("o_scriptAssets").insert({ scriptId: TEST_SCRIPT_ID, assetId: deriveId });
  console.log(`created parent id=${parentId}, derive id=${deriveId}`);

  const { socket, events } = createFakeSocket();
  const resTool = new ResTool(socket, { projectId: TEST_PROJECT_ID, scriptId: TEST_SCRIPT_ID });

  console.log("\n--- running runMutationSubAgent ---");
  const t0 = Date.now();
  const result = await runMutationSubAgent({
    agentKey: "productionAgent:generateAssetsAgent",
    systemPrompt: "你是一个测试 agent，必须调用 generate_deriveAsset 工具。",
    userPrompt: "生成衍生资产图片。",
    flowDataKeys: ["assets"],
    agentLabel: "generateAssets",
    msgName: "执行导演",
    resTool,
    allowedTools: ["generate_deriveAsset"],
    mockResponses: [
      {
        type: "tool-call",
        toolName: "generate_deriveAsset",
        input: JSON.stringify({ ids: [deriveId] }),
      },
      {
        type: "text",
        text: "衍生资产图片生成已触发",
      },
    ] as any,
  });
  const elapsed = ((Date.now() - t0) / 1000).toFixed(2);

  console.log(`\n--- DONE in ${elapsed}s ---`);
  console.log(`result: ${result}`);

  // Verify descriptor replay.
  const generateEvent = events.find((e) => e.event === "generateDeriveAsset");
  if (!generateEvent) {
    throw new Error("generateDeriveAsset socket event was not replayed");
  }
  if (!generateEvent.payload.ids.includes(deriveId)) {
    throw new Error(`unexpected replay payload ids: ${JSON.stringify(generateEvent.payload.ids)}`);
  }
  console.log(`replayed generateDeriveAsset event for ids=${JSON.stringify(generateEvent.payload.ids)}`);

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
