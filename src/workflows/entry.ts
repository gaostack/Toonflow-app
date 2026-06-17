import express from "express";

/**
 * Workflow runtime needs at least one route handler for nitro to build. We
 * never invoke this from Toonflow's main process — start() is called in-
 * process via the imported bundle. The workflow runtime's own internal
 * handler dispatch (Local World POSTing to /.well-known/workflow/...) is
 * served by the workflow/nitro middleware injected into the bundle, not by
 * routes in this file.
 */
const app = express();

app.get("/health", (_req, res) => {
  res.json({ ok: true, runtime: "toonflow-workflow" });
});

export default app;
