# Workflow Migration — Next Steps

Quick reference for what's done, what's next, and what to read first in any follow-up session.

## Status at a glance

| Phase | What | Status |
|---|---|---|
| POC | workflow-sdk validation in `wf-poc/` | ✅ done — see `wf-poc/FINDINGS.md` |
| Step 1 | In-process integration (no sidecar) | ✅ done |
| Step 2 | Generic vendor abstraction (`toonflow-model.ts`) | ✅ done |
| Step 3 | Postgres World — durable resume verified | ✅ done |
| Step 4 | Build pipeline + Dockerfile + Coolify playbook | ✅ done — see `docs/WORKFLOW_DEPLOY.md` |
| Step 5a | Read-only sub-agents migrated | ✅ done — `director_plan`, `storyboard_table`, `supervision` |
| Step 5b | Mutation-heavy sub-agents migrated | ✅ done — `derive_assets`, `generate_assets`, `storyboard_gen`, `storyboard_panel` (Option A: side-effect descriptors) |
| Step 6 | Decommission legacy sub-agent path + `TOONFLOW_WORKFLOW_SIDECAR` flag | ✅ done — workflow is the only path for all 7 sub-agents |

## To deploy this version

1. **Coolify side**:
   - Add a Postgres service (postgres:16-alpine) to the same project as Toonflow
   - DB name: `toonflow_wf` (or whatever — just match the URL below)
   - Persistent volume mounted at `/var/lib/postgresql/data`
2. **Toonflow service env vars**:
   ```
   WORKFLOW_TARGET_WORLD=@workflow/world-postgres
   WORKFLOW_POSTGRES_URL=postgres://postgres:<pw>@<coolify-pg-host>:5432/toonflow_wf
   ```
   The workflow path is **always on** — all 7 productionAgent sub-agents run through the workflow runtime. There is no opt-in flag anymore.
3. **First deploy** — `docker-entrypoint.sh` auto-runs `npx workflow-postgres-setup` (idempotent) before booting. Verify startup logs contain:
   ```
   [workflow] world worker started: @workflow/world-postgres
   [workflow] runtime mounted on http://localhost:10588
   [服务启动成功]: http://localhost:10588
   ```
4. **Smoke test in prod**:
   - Trigger a `导演规划` task from the UI — should produce a `<scriptPlan>` via workflow
   - Trigger a `分镜表` task — same, via workflow
   - Trigger a `衍生资产分析` task — via workflow (Option A: DB write in step, socket replayed after run).

## To roll back

There is no env-var rollback anymore. To revert to the legacy in-process sub-agent path, `git revert` the decommission commit and redeploy. The legacy `runAgent` helper has been deleted; the decision layer (`runDecisionAI`) is unchanged and never went through the workflow.

## ✅ Step 5b + Step 6 done — mutation-heavy sub-agents migrated (Option A), switch removed

All 4 mutation-heavy sub-agents run through the workflow (now the only path):

- `run_sub_agent_derive_assets` → `add_deriveAsset` / `del_deriveAsset` / `generate_deriveAsset`
- `run_sub_agent_generate_assets` → `generate_deriveAsset`
- `run_sub_agent_storyboard_gen` → `generate_storyboard`
- `run_sub_agent_storyboard_panel` → `add_flowData_storyboard`

**Pattern (Option A) as implemented:**
- `src/workflows/mutation-agent.ts` — generic mutation workflow. Each mutation tool is a `'use step'` function that does the idempotent DB write (knex + better-sqlite3, externalized in `nitro.config.ts`) and writes a **side-effect descriptor** to the `mutation-descriptors` namespaced stream.
- After the run, `workflowAdapter.ts` `runMutationSubAgent` reads the `mutation-descriptors` stream and `replayDescriptors` emits the matching `socket.emit(...)` events. Storyboard emits go through an 800ms socket queue (matching legacy pacing) and are awaited before returning.
- Idempotency: `add_deriveAsset` dedupes inserts by `(assetsId, name)`. `memory.add` stays a synchronous post-workflow action in the main process (not part of the descriptor protocol).
- Smoke tests: `scripts/spike-derive-assets.ts`, `spike-generate-assets.ts`, `spike-storyboard-gen.ts`, `spike-storyboard-panel.ts` (all pass with the mock model).

**Switch removed (Step 6):** `TOONFLOW_WORKFLOW_SIDECAR` and the legacy `runAgent` helper are gone. Each sub-agent has a single workflow path. `consumeFullStream` + `useTools` are kept because the **decision layer** (`runDecisionAI`) still streams in-process and uses them — it was never part of this migration. `tools.ts` is kept (it still exports `flowDataSchema`/`FlowData`/`assetItemSchema` used by routes, and the decision layer's tools).

## Next session priorities (ranked)

### 2. Operational polish (≈half day, can be parallel)

- Workflow run observability: read Postgres `workflow_*` tables for status; expose a `/api/workflow/runs` endpoint for the admin UI
- Backup/retention: Postgres workflow tables grow with every run — set up periodic cleanup of finished-and-old rows (or check what graphile-worker does by default)
- Alerts: if any workflow run is "running" for >30 min, surface in admin UI (probably stuck on LLM timeout)

### 3. ✅ `scriptAgent` migrated (2026-06-18)

All 4 `scriptAgent` read-only sub-agents now run through the workflow runtime (the only path); legacy in-process `runAgent` is deleted. The decision layer (`runDecisionAI`) still streams in-process — unchanged, same as productionAgent.

- **Shared runtime extracted** → `src/agents/_shared/workflowRuntime.ts` (`VendorSnapshot`, `bootstrapWorkflowRuntime`, `snapshotVendor`, `prefetchSocketData`, `runInProcessWorkflow`). `productionAgent/workflowAdapter.ts` now imports + re-exports these (so `app.ts` + all spikes are unchanged); it keeps only the mutation-specific code.
- **Read-only workflow** → `src/workflows/script-read-only-agent.ts`. Hybrid design: `get_planData` is served from a pre-fetched snapshot (socket `getPlanData`, can't run inside a step), while `get_novel_events` / `get_novel_text` / `get_script_content` run as `'use step'` SQLite reads (knex + better-sqlite3 externalized) because they take agent-chosen args and can't be pre-fetched. All read-only — no descriptor-replay machinery.
- **Adapter** → `src/agents/scriptAgent/workflowAdapter.ts` `runScriptSubAgent` (snapshot vendor + prefetch planData via `getPlanData` + dispatch).
- **Wiring** → `src/agents/scriptAgent/index.ts` `runWorkflowSubAgent` helper; all 4 sub-agent tools call it.
- **Smoke test** → `scripts/spike-script-skeleton.ts` (mock model + fake socket, no API key / no DB rows needed).
- **Remaining**: real-Kimi end-to-end UI verification (storySkeleton / adaptationStrategy / script / supervision); productionAgent regression re-checked (storyboard-gen + derive-assets spikes still pass).

## Where to read first in a follow-up session

1. **`docs/NEXT_STEPS.md`** — this file
2. **`docs/WORKFLOW_DEPLOY.md`** — deployment + gotchas
3. **`wf-poc/FINDINGS.md`** — full architectural rationale + 8 SDK gotchas
4. **`src/agents/_shared/workflowRuntime.ts`** — shared runtime (bootstrap, vendor snapshot, socket prefetch, UIMessageChunk→ResTool mapper) used by both agent stacks
5. **`src/workflows/read-only-agent.ts`** — template for productionAgent read-only workflows (single pre-fetched `get_flowData` snapshot)
6. **`src/workflows/script-read-only-agent.ts`** — scriptAgent read-only workflow (hybrid: pre-fetched `get_planData` snapshot + in-step SQLite read tools)
7. **`src/workflows/mutation-agent.ts`** — template for mutation workflows + side-effect descriptor protocol
8. **`src/agents/productionAgent/workflowAdapter.ts`** — `runReadOnlySubAgent`/`runMutationSubAgent`/`replayDescriptors` (imports shared runtime)
9. **`src/agents/scriptAgent/workflowAdapter.ts`** — `runScriptSubAgent` (imports shared runtime)
10. **`src/agents/productionAgent/index.ts`** / **`src/agents/scriptAgent/index.ts`** — sub-agents call the workflow helpers directly (no switch). Both decision layers (`runDecisionAI`) still stream in-process via `consumeFullStream` + `useTools`.

## What NOT to do without explicit direction

- **Don't delete `consumeFullStream` / `useTools` / `tools.ts`** (in either `productionAgent/` or `scriptAgent/`). They look like leftover legacy code but each decision layer (`runDecisionAI`) still depends on them, and `tools.ts` exports schemas used by routes. The sub-agent `runAgent` helper was the only legacy piece — now deleted in both stacks.
- **Don't change `nitro.config.ts` `workflow.dirs` scope.** It's currently `["src/workflows"]` for a reason — wider scope makes nitro try to bundle `data/serve/app.js` and fail.
- **Don't switch dev away from Local World** unless you specifically need durability testing. Local World is faster + simpler; Postgres adds an external dep + slower startup.

## Open review findings (from 2026-06-17 code review)

**Fixed in this session:**
- ✅ Electron `randomPort` + Local World base URL mismatch — `src/app.ts` now `listen()` first to know `realPort`, then bootstraps workflow
- ✅ `prefetchFlowData` no longer swallows socket errors — timeout/network failures now throw, only "frontend explicitly returned empty" path stays soft

**Still open (low priority — fix when convenient):**

1. **`memory.add` is not retry-idempotent** — in each sub-agent's post-workflow block in `src/agents/productionAgent/index.ts`. On caller-side re-invocation (NOT workflow replay; that's already handled), the post-workflow `memory.add("assistant:execution", ...)` could create duplicate memory entries. Practical impact: small. **Fix:** include a memoryKey hash (timestamp + content hash) and dedupe in `memory.add`.

2. **`worker.start()` gate too narrow** — `workflowAdapter.ts:71` keys solely on `process.env.WORKFLOW_TARGET_WORLD`. Future Vercel/other Worlds configured via different env vars would silently no-op. **Fix:** gate on `WORKFLOW_TARGET_WORLD !== undefined && WORKFLOW_TARGET_WORLD !== "@workflow/world-local"`.

3. ✅ **`toonflow-model.ts` vendor sandbox uses `new Function`, not `vm2`** — RESOLVED: SECURITY comment added explaining the deliberate divergence + trust assumption (vendor code from `data/vendor/`).

4. **`KIMI_API_KEY` env fallback in production code** — `workflowAdapter.ts` ship in the Docker image. Harmless because env var won't be set in prod, but feels like dev-only code. **Fix:** wrap in `if (process.env.NODE_ENV !== "prod")`.

5. **`@workflow/cli` in `dependencies` instead of `devDependencies`** — runtime never uses it, only `npx workflow-postgres-setup` in `docker-entrypoint.sh`. Wastes ~10 MB in production image. **Fix:** move to `devDependencies` and update Dockerfile to install with `--include=dev` if needed.

6. ✅ **`nitro.config.ts` used `as any`** — RESOLVED: replaced with `// @ts-expect-error workflow.dirs typed via module augmentation`.

7. **Mutation idempotency relies on `(assetsId, name)` dedupe** — `mutation-agent.ts` `add_deriveAsset` dedupes new inserts by parent + name. If the agent legitimately needs two derive assets with the same name under one parent, they collapse into one row. **Fix (if needed):** add an explicit `idempotencyKey` column to `o_assets`.

## Verification scripts (keep these in repo)

```bash
# Basic smoke (real Kimi via read-only workflow)
npx tsx scripts/spike-kimi.ts

# scriptAgent read-only workflow smoke test (mock model, no API key / DB rows needed)
npx tsx scripts/spike-script-skeleton.ts

# Mutation workflow smoke tests (mock model, no API key needed)
npx tsx scripts/spike-derive-assets.ts
npx tsx scripts/spike-generate-assets.ts
npx tsx scripts/spike-storyboard-gen.ts
npx tsx scripts/spike-storyboard-panel.ts

# Workflow source validation (serde compliance)
yarn validate:workflows

# Durability resume (Postgres required)
docker start toonflow-pg-dev  # one-time setup: see WORKFLOW_DEPLOY.md
WORKFLOW_TARGET_WORLD=@workflow/world-postgres \
WORKFLOW_POSTGRES_URL=postgres://postgres:toonflow@localhost:5433/toonflow_wf \
npx tsx scripts/spike-durability.ts start
# ... wait for "SUICIDE", copy runId ...
WORKFLOW_TARGET_WORLD=@workflow/world-postgres \
WORKFLOW_POSTGRES_URL=postgres://postgres:toonflow@localhost:5433/toonflow_wf \
npx tsx scripts/spike-durability.ts resume <runId>
```
