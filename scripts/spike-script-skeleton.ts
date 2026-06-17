/**
 * Smoke test for the scriptAgent read-only workflow path (storySkeleton).
 *
 * Uses a mock model + fake socket so it needs no API key and no DB rows. It
 * exercises: vendor-snapshot mock fallback, planData pre-fetch via the
 * "getPlanData" socket event, the in-workflow get_planData tool, and the
 * UIMessageChunk → ResTool stream mapping.
 */

import express from "express";
import http from "node:http";
import ResTool from "@/socket/resTool";
import { bootstrapWorkflowRuntime } from "@/agents/productionAgent/workflowAdapter";
import { runScriptSubAgent } from "@/agents/scriptAgent/workflowAdapter";

process.env.TOONFLOW_WORKFLOW_FORCE_MOCK = "1";

const PORT = 14141;

interface EmittedEvent {
  event: string;
  payload: any;
}

function createFakeSocket() {
  const events: EmittedEvent[] = [];
  const socket = {
    emit: (event: string, payload: any, callback?: any) => {
      events.push({ event, payload });
      if (event === "getPlanData" && typeof callback === "function") {
        callback({ storySkeleton: "测试故事骨架", adaptationStrategy: "测试改编策略", script: "测试剧本" });
      } else if (typeof callback === "function") {
        callback();
      }
    },
  } as any;
  return { socket, events };
}

async function main() {
  console.log("=== Spike: scriptAgent read-only workflow (storySkeleton) ===\n");

  const app = express();
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(PORT, r));
  console.log(`spike host on http://localhost:${PORT}`);

  await bootstrapWorkflowRuntime(app, server, PORT);
  app.use(express.json({ limit: "10mb" }));

  const { socket, events } = createFakeSocket();
  const resTool = new ResTool(socket, { projectId: 99997 });

  console.log("\n--- running runScriptSubAgent ---");
  const t0 = Date.now();
  const result = await runScriptSubAgent({
    agentKey: "scriptAgent:storySkeletonAgent",
    systemPrompt: "你是一个测试 agent，先调用 get_planData 读取工作区，再输出故事骨架。",
    messages: [{ role: "user", content: "生成故事骨架。" }],
    planDataKeys: ["storySkeleton", "adaptationStrategy", "script"],
    agentLabel: "编剧",
    msgName: "编剧",
    resTool,
    mockResponses: [
      {
        type: "tool-call",
        toolName: "get_planData",
        input: JSON.stringify({ key: "storySkeleton" }),
      },
      {
        type: "text",
        text: "<storySkeleton>故事骨架已生成</storySkeleton>",
      },
    ],
  });
  const elapsed = ((Date.now() - t0) / 1000).toFixed(2);

  console.log(`\n--- DONE in ${elapsed}s ---`);
  console.log(`result: ${result}`);

  // The planData pre-fetch must have hit the frontend over "getPlanData".
  const prefetch = events.find((e) => e.event === "getPlanData");
  if (!prefetch) {
    throw new Error("getPlanData prefetch socket event was never emitted");
  }
  console.log(`prefetched planData via getPlanData for key=${JSON.stringify(prefetch.payload)}`);

  if (!result.includes("故事骨架")) {
    throw new Error(`unexpected workflow result: ${result}`);
  }

  server.close();
  console.log("\n=== spike passed ===");
  process.exit(0);
}

main().catch((e) => {
  console.error("\nERROR:", e);
  process.exit(1);
});
