/**
 * Durability test: start a 6-step (~12s total) workflow, optionally suicide
 * mid-flight, restart, verify the run completes without losing prior step
 * results.
 *
 * Usage:
 *   First run (kicks off + dies):   npx tsx scripts/spike-durability.ts start
 *   Second run (resumes):           npx tsx scripts/spike-durability.ts resume <runId>
 *   One-shot completion (no kill):  npx tsx scripts/spike-durability.ts whole
 */

import express from "express";
import http from "node:http";
import * as fs from "node:fs";
import { bootstrapWorkflowRuntime } from "../src/agents/productionAgent/workflowAdapter";

const PORT = 14110;
const mode = process.argv[2] || "whole";

async function bootHost() {
  const app = express();
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(PORT, r));
  console.log(`durability host on :${PORT}`);
  await bootstrapWorkflowRuntime(app, server, PORT);
  app.use(express.json());
  return { app, server };
}

async function main() {
  await bootHost();

  // @ts-ignore — subpath import
  const { start } = await import("workflow/api");

  if (mode === "start") {
    const runId = `dur-${Date.now()}`;
    console.log(`\n=== start mode: enqueueing durabilityWorkflow runId=${runId} ===`);
    const run: any = await start(
      { workflowId: "workflow//./src/workflows/durability-demo//durabilityWorkflow" } as any,
      [runId],
    );
    console.log(`enqueued workflowRunId=${run.runId}`);
    console.log(`tail -f /tmp/wf-durability-${runId}.log`);
    console.log(`\nWaiting 5s then dying mid-flight...`);
    await new Promise((r) => setTimeout(r, 5000));
    console.log(`\n--- step log so far ---`);
    try { console.log(fs.readFileSync(`/tmp/wf-durability-${runId}.log`, "utf-8")); } catch {}
    console.log(`\n=== SUICIDE — re-run with: npx tsx scripts/spike-durability.ts resume ${runId} ===`);
    process.exit(0);
  }

  if (mode === "resume") {
    const runId = process.argv[3];
    if (!runId) {
      console.error("ERROR: pass runId from previous start, e.g. resume dur-1234567890");
      process.exit(1);
    }
    console.log(`\n=== resume mode: monitoring /tmp/wf-durability-${runId}.log ===`);
    const file = `/tmp/wf-durability-${runId}.log`;
    let prior = "";
    try { prior = fs.readFileSync(file, "utf-8"); } catch {}
    console.log(`prior log (before this restart):\n${prior}`);
    console.log(`\nWatching for new lines for 20s...`);
    const t0 = Date.now();
    let lastSize = prior.length;
    while (Date.now() - t0 < 20_000) {
      await new Promise((r) => setTimeout(r, 1000));
      try {
        const now = fs.readFileSync(file, "utf-8");
        if (now.length > lastSize) {
          process.stdout.write(now.slice(lastSize));
          lastSize = now.length;
        }
      } catch {}
    }
    const final = fs.readFileSync(file, "utf-8");
    const doneSteps = (final.match(/DONE/g) || []).length;
    console.log(`\n\n=== final: ${doneSteps}/6 steps completed across both processes ===`);
    process.exit(doneSteps === 6 ? 0 : 1);
  }

  if (mode === "whole") {
    const runId = `dur-${Date.now()}`;
    console.log(`\n=== whole mode: one-shot, no kill ===`);
    const run: any = await start(
      { workflowId: "workflow//./src/workflows/durability-demo//durabilityWorkflow" } as any,
      [runId],
    );
    console.log(`runId=${run.runId}, watching log /tmp/wf-durability-${runId}.log`);
    const file = `/tmp/wf-durability-${runId}.log`;
    const t0 = Date.now();
    while (Date.now() - t0 < 30_000) {
      await new Promise((r) => setTimeout(r, 1500));
      try {
        const now = fs.readFileSync(file, "utf-8");
        if ((now.match(/DONE/g) || []).length === 6) {
          console.log(now);
          console.log(`\n=== all 6 done in ${((Date.now() - t0) / 1000).toFixed(1)}s ===`);
          process.exit(0);
        }
      } catch {}
    }
    console.error("TIMEOUT");
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
