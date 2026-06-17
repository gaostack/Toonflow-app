import { defineNitroConfig } from "nitro/config";

/**
 * Nitro config for building Toonflow's workflow runtime bundle.
 *
 * Source:  src/workflows/**
 * Output:  .output/server/index.mjs (consumed by src/app.ts via bootstrapWorkflowRuntime)
 *
 * Run:     yarn build:workflows  (always use this; direct `npx nitro build` can
 *          choke on stale esbuild output in data/serve/app.js).
 */
export default defineNitroConfig({
  modules: ["workflow/nitro"],
  preset: "node_middleware",
  // Constrain directive discovery so it does NOT scan esbuild's data/serve/app.js
  // bundle (which co-exists with this build via yarn build).
  // @ts-expect-error workflow.dirs is typed via module augmentation.
  workflow: { dirs: ["src/workflows"] },
  // Native DB modules are used inside workflow steps via the runtime Node process.
  // Leaving them external avoids bundling better-sqlite3 binaries and lets the
  // workflow bundle import them at runtime from node_modules.
  rolldownConfig: {
    external: ["knex", "better-sqlite3"],
  },
  routes: {
    // Keep a concrete route so nitro has at least one handler to build. A
    // catch-all /** would make the node_middleware bundle intercept every
    // request on the host Express app, breaking Toonflow's own API routes.
    "/health": { handler: "./src/workflows/entry.ts", format: "node" },
  },
});
