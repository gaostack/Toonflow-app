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

There are two options for the Postgres instance. **Reusing an existing instance
with a dedicated logical database is what production currently uses** — it saves
a whole container while keeping Toonflow's workflow tables isolated.

### Option A (production default) — reuse an existing Postgres instance

1. **Pick any healthy Postgres in the same Coolify network.** Production reuses
   the shared `pgvector/pgvector` instance (container name = its Coolify UUID,
   e.g. `uowwkc00csc4ckcgoc4sok4c`). Because both containers are on the
   `coolify` network, the app reaches it by container name — no public port.

2. **Do NOT manually create the `toonflow_wf` database.** `docker-entrypoint.sh`
   creates it automatically on boot: it parses the DB name out of
   `WORKFLOW_POSTGRES_URL`, connects to the instance's default `postgres` admin
   DB, and runs `CREATE DATABASE` if it doesn't exist (idempotent). This keeps
   the workflow tables in their own logical DB instead of polluting the shared
   `postgres` DB. (Requires the `pg` package, which is a direct dependency.)

3. **Set env vars on the Toonflow application** (runtime):
   - `WORKFLOW_TARGET_WORLD=@workflow/world-postgres`
   - `WORKFLOW_POSTGRES_URL=postgres://postgres:<pw>@<instance-container-name>:5432/toonflow_wf`
   - (existing) `NODE_ENV=prod`, `PORT=10588`, etc.

### Option B — dedicated Postgres container

1. **Add a Postgres service** in the Toonflow project.
   - Image: `postgres:16-alpine` (or 15+; any version graphile-worker supports)
   - Persistent volume for `/var/lib/postgresql/data`
2. Set the same env vars; point `WORKFLOW_POSTGRES_URL` at the new container.
   The entrypoint auto-create step is a no-op when the DB name is `postgres`,
   so either name the DB `toonflow_wf` in the URL (auto-created) or rely on the
   container's own `POSTGRES_DB`.

### First deploy & verify (both options)

The entrypoint detects `WORKFLOW_POSTGRES_URL`, ensures the database exists, runs
the (idempotent) schema migration, then boots the app. Startup logs should show:
```
Ensuring workflow database exists...
[db] created database toonflow_wf            # first boot only; "already exists" after
Applying workflow-postgres schema (idempotent)...
✅ Database schema created successfully!
[workflow] world worker started: @workflow/world-postgres
[workflow] runtime mounted on http://localhost:10588
[服务启动成功]: http://localhost:10588
```
If you instead see no `[workflow] world worker started` line, the app is running
in **Local World** (env vars not set) — state won't survive redeploys.

> **Image-based deploys**: the Coolify app pulls a prebuilt image from the
> registry (tag = git short SHA). Code changes only take effect after CI builds
> and pushes a new image tag and the app redeploys onto it — setting env vars
> alone won't pull new code.

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
