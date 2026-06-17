import type { Knex } from "knex";
import knex from "knex";

/**
 * Shared SQLite (knex + better-sqlite3) connection helper for workflow steps.
 *
 * Workflow steps run in the nitro bundle and can't import Toonflow's `u.db`, so
 * they open their own connection by absolute path. Instances are cached per
 * dbPath so repeated steps in the same process reuse the connection; the cache
 * is lost on process restart, which is fine — the next step opens a new one.
 *
 * `knex` and `better-sqlite3` are marked external in nitro.config.ts.
 */
const dbCache = new Map<string, Knex>();

export function getDb(dbPath: string): Knex {
  if (!dbCache.has(dbPath)) {
    dbCache.set(
      dbPath,
      knex({
        client: "better-sqlite3",
        connection: { filename: dbPath },
        useNullAsDefault: true,
      }),
    );
  }
  return dbCache.get(dbPath)!;
}
