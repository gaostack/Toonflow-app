/**
 * Smoke test for the mutation workflow path (storyboard_panel).
 */

import express from "express";
import http from "node:http";
import ResTool from "@/socket/resTool";
import { bootstrapWorkflowRuntime, runMutationSubAgent } from "@/agents/productionAgent/workflowAdapter";

process.env.TOONFLOW_WORKFLOW_FORCE_MOCK = "1";

const PORT = 14150;
const TEST_SCRIPT_ID = 99996;

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
        callback({ script: "测试剧本", assets: [], scriptPlan: "", storyboardTable: "" });
      } else if (typeof callback === "function") {
        callback();
      }
    },
  } as any;
  return { socket, events };
}

async function main() {
  console.log("=== Spike: mutation workflow (storyboard_panel) ===\n");

  const app = express();
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(PORT, r));
  console.log(`spike host on http://localhost:${PORT}`);

  await bootstrapWorkflowRuntime(app, server, PORT);
  app.use(express.json({ limit: "10mb" }));

  const { socket, events } = createFakeSocket();
  const resTool = new ResTool(socket, { projectId: 99996, scriptId: TEST_SCRIPT_ID });

  const mockInput = {
    videoDesc: "测试分镜画面",
    prompt: "test prompt",
    track: "default",
    duration: 3,
    associateAssetsIds: [1, 2],
    shouldGenerateImage: "true",
  };

  console.log("\n--- running runMutationSubAgent ---");
  const t0 = Date.now();
  const result = await runMutationSubAgent({
    agentKey: "productionAgent:storyboardPanelAgent",
    systemPrompt: "你是一个测试 agent，必须调用 add_flowData_storyboard 工具。",
    userPrompt: "新增一个分镜面板。",
    flowDataKeys: ["script", "assets", "scriptPlan", "storyboardTable"],
    agentLabel: "storyboardPanel",
    msgName: "执行导演",
    resTool,
    allowedTools: ["add_flowData_storyboard"],
    mockResponses: [
      {
        type: "tool-call",
        toolName: "add_flowData_storyboard",
        input: JSON.stringify(mockInput),
      },
      {
        type: "text",
        text: "分镜面板已新增",
      },
    ] as any,
  });
  const elapsed = ((Date.now() - t0) / 1000).toFixed(2);

  console.log(`\n--- DONE in ${elapsed}s ---`);
  console.log(`result: ${result}`);

  const event = events.find((e) => e.event === "addStoryboard");
  if (!event) {
    throw new Error("addStoryboard socket event was not replayed");
  }
  if (event.payload.videoDesc !== mockInput.videoDesc) {
    throw new Error(`unexpected replay payload: ${JSON.stringify(event.payload)}`);
  }
  console.log(`replayed addStoryboard event for videoDesc="${event.payload.videoDesc}"`);

  server.close();
  console.log("\n=== spike passed ===");
  process.exit(0);
}

main().catch((e) => {
  console.error("\nERROR:", e);
  process.exit(1);
});
