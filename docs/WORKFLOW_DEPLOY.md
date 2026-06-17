# Workflow Runtime Deployment

How to deploy Toonflow with the durable workflow runtime enabled.

## Architecture

Toonflow runs as a single Node process that hosts:
- Express + Socket.IO (existing)
- Workflow runtime bundle (loaded from `/app/.output/server/index.mjs`)
- Workflow worker (in-process for Local World, separate consumer for Postgres World)

The workflow bundle is produced at build time by `nitro build` (called from `scripts/build.ts` alongside esbuild) and shipped in the Docker image.

## Modes

### Dev — Local World (default)
Just `yarn dev`. State in `.workflow-data/` next to the project. No env vars needed.
**Limitation**: kill the process mid-flight, the in-flight workflow is lost on restart. Acceptable for local development only.

### Production — Postgres World

Required env vars:
```
WORKFLOW_TARGET_WORLD=@workflow/world-postgres
WORKFLOW_POSTGRES_URL=postgres://user:password@host:5432/database
```

Optional:
```
WORKFLOW_POSTGRES_JOB_PREFIX=toonflow_      # default empty
WORKFLOW_POSTGRES_WORKER_CONCURRENCY=50     # default 50
WORKFLOW_POSTGRES_MAX_POOL_SIZE=10          # default 10
```

On every boot, `docker-entrypoint.sh` runs `npx workflow-postgres-setup` (idempotent) to apply schema migrations. First-boot creates the tables; subsequent boots are no-ops.

The Postgres World worker pulls runs from the queue, executes steps, and automatically resumes orphan runs left over from prior crashes.

## Coolify setup

1. **Add a Postgres service** alongside the Toonflow application in the same Coolify project.
   - Image: `postgres:16-alpine` (or 15+; any version graphile-worker supports)
   - Persistent volume for `/var/lib/postgresql/data`
   - Database name e.g. `toonflow_wf` (separate from any application data DB)

2. **Set env vars on the Toonflow service**:
   - `WORKFLOW_TARGET_WORLD=@workflow/world-postgres`
   - `WORKFLOW_POSTGRES_URL=postgres://postgres:<pw>@<coolify-pg-host>:5432/toonflow_wf`
   - (existing) `NODE_ENV=prod`, `PORT=10588`, plus whatever Toonflow already uses

3. **First deploy** — the entrypoint will detect `WORKFLOW_POSTGRES_URL` and run schema migration before booting the app. Subsequent deploys are idempotent.

4. **Verify** — startup logs should show:
   ```
   [workflow] world worker started: @workflow/world-postgres
   [workflow] runtime mounted on http://localhost:10588
   [服务启动成功]: http://localhost:10588
   ```

## At-least-once semantics

When the worker recovers a workflow that was killed mid-step, **the unfinished step is re-run from the beginning**. There is no partial-step state.

Implications for sub-agents:
- **Workspace writes**: safe — `writeScriptPlan` etc. overwrite, not append.
- **DB writes**: must be idempotent (UPSERT, not INSERT-only).
- **External API calls**: can be billed twice on retry. For expensive ops (image generation, video generation), implement content-hash deduplication at the boundary, or accept the cost.

Standard durable-workflow behavior — same as Temporal, Inngest, etc.

## Smoke tests

Local (dev mode):
```bash
yarn build                                                # builds .output/server + data/serve
yarn start                                                # boots prod-bundled app on :10588
```

Postgres (manual):
```bash
docker run -d --name toonflow-pg-dev -e POSTGRES_PASSWORD=toonflow \
  -e POSTGRES_DB=toonflow_wf -p 5433:5432 postgres:16-alpine
WORKFLOW_POSTGRES_URL=postgres://postgres:toonflow@localhost:5433/toonflow_wf \
  npx workflow-postgres-setup
WORKFLOW_TARGET_WORLD=@workflow/world-postgres \
WORKFLOW_POSTGRES_URL=postgres://postgres:toonflow@localhost:5433/toonflow_wf \
yarn start
```

Durability test (in dev source mode):
```bash
docker start toonflow-pg-dev
WORKFLOW_TARGET_WORLD=@workflow/world-postgres \
WORKFLOW_POSTGRES_URL=postgres://postgres:toonflow@localhost:5433/toonflow_wf \
npx tsx scripts/spike-durability.ts start
# wait for "SUICIDE" message, copy the runId, then:
WORKFLOW_TARGET_WORLD=@workflow/world-postgres \
WORKFLOW_POSTGRES_URL=postgres://postgres:toonflow@localhost:5433/toonflow_wf \
npx tsx scripts/spike-durability.ts resume <runId>
# expect: 6/6 steps complete across both processes
```

## Build artifacts

`yarn build` produces three things:
- `data/serve/app.js` — main Toonflow CJS bundle (esbuild)
- `build/main.js` — Electron main process (esbuild)
- `.output/server/index.mjs` — workflow runtime bundle (nitro, ~4 MB)

Dockerfile copies `.output/` alongside `serve/`. Both live outside the `/app/data` persistent volume so each deployment ships fresh code (workflow source changes require a rebuild + redeploy).

## Gotchas

See `wf-poc/FINDINGS.md` "Critical findings" section for the full list. Most relevant for deployment:

1. **Middleware mount order**: workflow middleware MUST be mounted before `express.json()` and before any auth middleware. Already handled in `src/app.ts`.
2. **Step idempotency**: see "At-least-once semantics" above.
3. **Bundle path**: `bootstrapWorkflowRuntime` resolves `process.cwd()/.output/server/index.mjs`. Container WORKDIR is `/app`, so bundle lives at `/app/.output/server/index.mjs`. If you change Dockerfile WORKDIR, also adjust the bundle path or move the bundle.
4. **No workflow on/off flag**: as of Step 6 the `TOONFLOW_WORKFLOW_SIDECAR` flag and the legacy `runAgent` fallback were removed. All 7 productionAgent sub-agents always run through the workflow runtime. To roll back, `git revert` the decommission commit and redeploy. (The decision layer `runDecisionAI` never used the workflow and is unaffected.)
