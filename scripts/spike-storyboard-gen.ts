/**
 * Smoke test for the mutation workflow path (storyboard_gen).
 */

import express from "express";
import http from "node:http";
import ResTool from "@/socket/resTool";
import { bootstrapWorkflowRuntime, runMutationSubAgent } from "@/agents/productionAgent/workflowAdapter";

process.env.TOONFLOW_WORKFLOW_FORCE_MOCK = "1";

const PORT = 14140;
const TEST_SCRIPT_ID = 99997;

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
        callback({ storyboardTable: "测试分镜表", storyboard: [] });
      } else if (typeof callback === "function") {
        callback();
      }
    },
  } as any;
  return { socket, events };
}

async function main() {
  console.log("=== Spike: mutation workflow (storyboard_gen) ===\n");

  const app = express();
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(PORT, r));
  console.log(`spike host on http://localhost:${PORT}`);

  await bootstrapWorkflowRuntime(app, server, PORT);
  app.use(express.json({ limit: "10mb" }));

  const { socket, events } = createFakeSocket();
  const resTool = new ResTool(socket, { projectId: 99997, scriptId: TEST_SCRIPT_ID });

  console.log("\n--- running runMutationSubAgent ---");
  const t0 = Date.now();
  const result = await runMutationSubAgent({
    agentKey: "productionAgent:storyboardGenAgent",
    systemPrompt: "你是一个测试 agent，必须调用 generate_storyboard 工具。",
    userPrompt: "生成分镜图片。",
    flowDataKeys: ["storyboardTable", "storyboard"],
    agentLabel: "storyboardGen",
    msgName: "执行导演",
    resTool,
    allowedTools: ["generate_storyboard"],
    mockResponses: [
      {
        type: "tool-call",
        toolName: "generate_storyboard",
        input: JSON.stringify({ ids: [101, 102] }),
      },
      {
        type: "text",
        text: "分镜图片生成已触发",
      },
    ] as any,
  });
  const elapsed = ((Date.now() - t0) / 1000).toFixed(2);

  console.log(`\n--- DONE in ${elapsed}s ---`);
  console.log(`result: ${result}`);

  const event = events.find((e) => e.event === "generateStoryboard");
  if (!event) {
    throw new Error("generateStoryboard socket event was not replayed");
  }
  if (!event.payload.ids.includes(101)) {
    throw new Error(`unexpected replay payload ids: ${JSON.stringify(event.payload.ids)}`);
  }
  console.log(`replayed generateStoryboard event for ids=${JSON.stringify(event.payload.ids)}`);

  server.close();
  console.log("\n=== spike passed ===");
  process.exit(0);
}

main().catch((e) => {
  console.error("\nERROR:", e);
  process.exit(1);
});
