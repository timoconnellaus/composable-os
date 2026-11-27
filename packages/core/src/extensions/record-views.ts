// The record views of a database, made again from the host's own definitions (stage 66 step 7,
// review of #526 N3): what an import runs once a client's database is in, because no view's text
// is taken from an export. The core views the migrations make come first (`coreViews`, the
// host's own migrations' text), then every `rec_…` and `pub_x_…` view the reconciler would make
// from the extensions the database records (`buildViews`), dropped and created again.
import { createDb } from "@composable-os/db";
import { buildViews, loadSchemaState } from "./schema.ts";

/** One view as `sqlite_master` holds it. */
export interface ViewDefinition {
  name: string;
  sql: string;
}

/**
 * Makes `db`'s views again: `coreViews` (from the host's migrations), then the record views built
 * from the database's own extension state. Returns how many views were made, and the formulas
 * that did not compile (each becomes NULL, as the reconciler leaves it).
 */
export async function rebuildRecordViews(
  db: D1Database,
  coreViews: readonly ViewDefinition[],
): Promise<{ views: number; formulaErrors: number }> {
  const existing = await db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'view'")
    .all<{ name: string }>();
  const statements = [
    ...existing.results.map((row) => `DROP VIEW IF EXISTS "${row.name.replaceAll('"', '""')}"`),
    ...coreViews.map((view) => view.sql),
  ];
  if (statements.length) await db.batch(statements.map((sql) => db.prepare(sql)));
  // A database older than the extensions' tables has no record views to make.
  const extensible = await db
    .prepare(
      "SELECT 1 AS one FROM sqlite_master WHERE type = 'table' AND name = 'core_extension_objects'",
    )
    .first();
  if (!extensible) return { views: coreViews.length, formulaErrors: 0 };
  const build = buildViews(await loadSchemaState(createDb(db)));
  const rebuilt = [...build.drops, ...build.creates];
  if (rebuilt.length) await db.batch(rebuilt.map((sql) => db.prepare(sql)));
  const { results } = await db
    .prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'view'")
    .all<{ n: number }>();
  return { views: Number(results[0]?.n ?? 0), formulaErrors: build.errors.length };
}
