/**
 * In-process spike against REAL Kimi For Coding.
 *
 * Stands up a minimal Express + http server, bootstraps the workflow runtime
 * into it, runs the generic read-only-agent workflow with directorPlan-style
 * input, and emits chunks to a stub ResTool. Mirrors what
 * src/agents/productionAgent/index.ts now does in production.
 *
 * Prereq: yarn build:workflows (produces .output/server/index.mjs)
 * Run:    npx tsx scripts/spike-kimi.ts
 */

import express from "express";
import http from "node:http";
import {
  bootstrapWorkflowRuntime,
  snapshotVendor,
  runInProcessWorkflow,
} from "../src/agents/productionAgent/workflowAdapter";

const PORT = 14100;

class FakeStream {
  buffer = "";
  append(t: string) {
    process.stdout.write(t);
    this.buffer += t;
    return this;
  }
  complete() {
    process.stdout.write("\n");
    return this;
  }
  error() {
    return this;
  }
}

class FakeMsg {
  toolCalls: any[] = [];
  activities: { type: string; data: any }[] = [];
  texts: FakeStream[] = [];
  thinkings: FakeStream[] = [];
  finalState: "running" | "complete" | "error" = "running";
  text() {
    const s = new FakeStream();
    this.texts.push(s);
    console.log("\n[msg.text]");
    return s;
  }
  thinking(title: string) {
    const s = new FakeStream();
    this.thinkings.push(s);
    console.log(`\n[msg.thinking: ${title}]`);
    return s;
  }
  toolCall(data: any) {
    this.toolCalls.push(data);
    console.log(`\n[msg.toolCall] ${data.toolName}: ${JSON.stringify(data.args).slice(0, 120)}...`);
    return new FakeStream();
  }
  activity(type: string, data: any) {
    this.activities.push({ type, data });
    console.log(`\n[msg.activity:${type}] ${JSON.stringify(data).slice(0, 120)}`);
  }
  complete() {
    this.finalState = "complete";
    console.log("\n[msg.complete]");
  }
  error(m?: string) {
    this.finalState = "error";
    console.log(`\n[msg.error] ${m}`);
  }
}

class FakeResTool {
  data = {};
  msgs: FakeMsg[] = [];
  newMessage(role: string, name: string) {
    const m = new FakeMsg();
    this.msgs.push(m);
    console.log(`\n[resTool.newMessage] ${role}/${name}`);
    return m as any;
  }
}

async function main() {
  console.log("=== Spike: in-process workflow runtime + real Kimi ===\n");

  const app = express();
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(PORT, r));
  console.log(`spike host on http://localhost:${PORT}`);

  await bootstrapWorkflowRuntime(app, server, PORT);
  app.use(express.json({ limit: "10mb" }));

  const snap = await snapshotVendor("productionAgent:directorPlanAgent");
  console.log(`\nresolved vendor snapshot: ${snap ? snap.vendorId : "(null → mock)"}`);
  if (snap) {
    console.log(`  modelName=${snap.modelMeta?.modelName}  apiKeyPrefix=${snap.vendorInputs?.apiKey?.slice(0, 12)}...`);
  } else {
    console.warn("WARN: no vendor configured — workflow will use mock provider");
  }

  const resTool = new FakeResTool() as any;
  const script = [
    "场景一：森林深处。",
    "主角：穿过这片雾，应该就能看到精灵了。",
    "精灵：你已经走得太远了，回头还来得及。",
    "主角：我必须找到她。",
    "精灵：那就跟着光走。",
    "（精灵消失，主角继续前行）",
  ].join("\n");

  console.log(`\n--- runInProcessWorkflow (read-only-agent / directorPlan style) ---`);
  const t0 = Date.now();
  const result = await runInProcessWorkflow({
    workflowId: "workflow//./src/workflows/read-only-agent//readOnlyAgentWorkflow",
    args: [
      {
        vendorSnapshot: snap,
        systemPrompt:
          "# 导演规划\n你是导演规划 Agent。先调用 get_flowData('script') 拿到剧本，然后基于剧本拆 1-2 场，" +
          "用 <scriptPlan>...</scriptPlan> XML 完整输出。",
        userPrompt: "请完成最简单的导演规划。",
        flowData: { script },
        agentLabel: "directorPlan",
      },
    ],
    resTool,
    msgName: "执行导演",
  });

  const elapsed = ((Date.now() - t0) / 1000).toFixed(2);

  console.log(`\n\n--- DONE in ${elapsed}s ---`);
  console.log(`Returned text length: ${result.length}`);
  console.log(`Returned text: ${result}`);

  const m = resTool.msgs[0];
  console.log(`\n--- Summary ---`);
  console.log(
    JSON.stringify(
      {
        toolCalls: m.toolCalls.length,
        activities: m.activities.length,
        textStreams: m.texts.length,
        thinkings: m.thinkings.length,
        finalState: m.finalState,
      },
      null,
      2,
    ),
  );

  server.close();
  process.exit(m.finalState === "complete" ? 0 : 1);
}

main().catch((e) => {
  console.error("\nERROR:", e);
  process.exit(1);
});
