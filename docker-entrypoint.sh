#!/bin/sh
set -e

# Seed web frontend if not present in persistent volume
if [ ! -d /app/data/web ]; then
  echo "Seeding /app/data/web..."
  mkdir -p /app/data
  cp -r /app/seed-data/web /app/data/web
fi

# Seed embedding models if not present in persistent volume
if [ ! -d /app/data/models ]; then
  echo "Seeding /app/data/models..."
  mkdir -p /app/data
  cp -r /app/seed-data/models /app/data/models
fi

# Seed skills subdirs if missing (app.ts auto-creates the parent dir as empty on startup)
if [ ! -d /app/data/skills/art_skills ] || [ ! -d /app/data/skills/story_skills ]; then
  echo "Seeding /app/data/skills/..."
  mkdir -p /app/data/skills
  cp -rn /app/seed-data/skills/. /app/data/skills/
fi

# Seed video model prompt templates if missing
if [ ! -d /app/data/modelPrompt/video ]; then
  echo "Seeding /app/data/modelPrompt/..."
  mkdir -p /app/data/modelPrompt
  cp -rn /app/seed-data/modelPrompt/. /app/data/modelPrompt/
fi

# Seed default assets if missing (app.ts auto-creates the parent dir as empty on startup)
if [ ! -f /app/data/assets/ending.mp4 ]; then
  echo "Seeding /app/data/assets/..."
  mkdir -p /app/data/assets
  cp -rn /app/seed-data/assets/. /app/data/assets/
fi

# Apply Postgres World schema if a connection URL is configured. The migration
# script is idempotent — safe to run on every boot. Skipped silently if env not
# set, in which case the app falls back to Local World (dev only; no durable
# resume across restart).
if [ -n "$WORKFLOW_POSTGRES_URL" ]; then
  # workflow-postgres-setup only creates TABLES, not the database itself. When
  # the target DB lives in a shared Postgres instance (reused across projects),
  # the dedicated logical database must exist first. Connect to the instance's
  # default "postgres" admin DB and CREATE the target DB if missing (idempotent).
  echo "Ensuring workflow database exists..."
  node -e '
    const { Client } = require("pg");
    const url = new URL(process.env.WORKFLOW_POSTGRES_URL);
    const rawPath = decodeURIComponent(url.pathname.replace(/^\//, ""));
    if (!rawPath) { console.warn("[db] WORKFLOW_POSTGRES_URL has no /<database> path — workflow tables would be created in the connection default DB; specify a dedicated database"); }
    const target = rawPath || "postgres";
    if (target === "postgres") { console.log("[db] target is the default postgres DB; skipping create"); process.exit(0); }
    const admin = new URL(process.env.WORKFLOW_POSTGRES_URL);
    admin.pathname = "/postgres";
    (async () => {
      const c = new Client({ connectionString: admin.toString() });
      await c.connect();
      const { rowCount } = await c.query("SELECT 1 FROM pg_database WHERE datname = $1", [target]);
      if (rowCount === 0) {
        // identifier cannot be parameterized; target comes from our own env, not user input
        await c.query(`CREATE DATABASE "${target.replace(/"/g, "\"\"")}"`);
        console.log(`[db] created database ${target}`);
      } else {
        console.log(`[db] database ${target} already exists`);
      }
      await c.end();
    })().catch((e) => { console.error("[db] ensure-database failed:", e.message); process.exit(1); });
  ' || echo "WARN: could not ensure workflow database exists (transient admin-DB issue?); continuing — workflow-postgres-setup below will gate on the real schema"

  echo "Applying workflow-postgres schema (idempotent)..."
  npx workflow-postgres-setup || { echo "ERROR: workflow-postgres-setup failed"; exit 1; }
fi

exec node /app/serve/app.js
