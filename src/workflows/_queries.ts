import type { Knex } from "knex";

/**
 * Shared read-only query bodies for scriptAgent's novel/script tools.
 *
 * Both the in-process tools (src/agents/scriptAgent/tools.ts, via `u.db`) and
 * the durable workflow steps (src/workflows/script-read-only-agent.ts, via the
 * bundle's `getDb(dbPath)`) call these, so the query + formatting logic lives in
 * exactly one place and cannot drift. Each function takes the Knex instance as
 * its first argument and returns the formatted string the agent sees ("无数据"
 * when there is nothing to return).
 *
 * Pure data access only — no socket, no UI streaming, no `u`/`@/` imports — so
 * it is safe to bundle into both the main app (esbuild) and the nitro workflow
 * bundle. `knex` is a type-only import here (erased at runtime).
 */

export async function queryNovelEvents(db: Knex, projectId: number, chapterIndexs: number[]): Promise<string> {
  const data = await db("o_novel")
    .where("projectId", projectId)
    .select("chapterIndex as index", "chapter", "event")
    .whereIn("chapterIndex", chapterIndexs);
  const eventString = data.map((i: any) => `第${i.index}章，标题:${i.chapter}，事件:${i.event}`).join("\n");
  return eventString || "无数据";
}

export async function queryNovelText(db: Knex, projectId: number, chapterIndex: string | number): Promise<string> {
  const row = await db("o_novel").where("projectId", projectId).where({ chapterIndex }).select("chapterData").first();
  const text = row?.chapterData ? row.chapterData : "";
  return text || "无数据";
}

export async function queryScriptContent(db: Knex, ids: string[]): Promise<string> {
  const data = await db("o_script").whereIn("id", ids).select("content", "name");
  const text = data.length ? data.map((d: any) => `<scriptItem name="${d.name}">${d.content}</scriptItem>`).join("\n") : "";
  return text || "无数据";
}
