import { sleep } from "workflow";

/**
 * Workflow for testing durable execution across process restart.
 *
 * Each iteration writes a start marker, sleeps for 2 seconds using the workflow
 * sleep primitive, then writes a DONE marker. Using sleep at the workflow level
 * (instead of setTimeout inside a step) exercises the SDK's suspend/resume
 * machinery and is the recommended pattern for durable delays.
 */

async function recordStart(stepIndex: number, runId: string): Promise<number> {
  "use step";
  const fs = await import("node:fs");
  const path = await import("node:path");
  const file = path.join("/tmp", `wf-durability-${runId}.log`);
  fs.appendFileSync(file, `step-${stepIndex} @ ${new Date().toISOString()}\n`);
  return stepIndex;
}

async function recordDone(stepIndex: number, runId: string): Promise<number> {
  "use step";
  const fs = await import("node:fs");
  const path = await import("node:path");
  const file = path.join("/tmp", `wf-durability-${runId}.log`);
  fs.appendFileSync(file, `step-${stepIndex}-DONE @ ${new Date().toISOString()}\n`);
  return stepIndex;
}

export async function durabilityWorkflow(runId: string): Promise<{ totalSteps: number }> {
  "use workflow";

  for (let i = 1; i <= 6; i++) {
    await recordStart(i, runId);
    await sleep("2s");
    await recordDone(i, runId);
  }

  return { totalSteps: 6 };
}
