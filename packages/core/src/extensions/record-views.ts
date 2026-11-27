// The record views of a database, made again from the host's own definitions (stage 66 step 7,
// review of #526 N3): what an import runs once a client's database is in, because no view's text
// is taken from an export. The core views the migrations make come first (`coreViews`, the
// host's own migrations' text), then every `rec_…` and `pub_x_…` view the reconciler would make
// from the extensions the database records (`buildViews`), dropped and created again.
//
// The extension state the record views are built from (`core_extension_objects`,
// `core_extension_fields`) came with the import, so it is checked first (review of #530, R3):
// every object's table is the one its name derives and an imported extension table, every field's
// table is its own object's (or its side table) and its column a real column there, and every
// relation names an object that passes too. Anything else refuses the import and empties the
// database, so no view is ever made over a core table from imported rows.
import { createDb } from "@composable-os/db";
import { emptyDatabase } from "@composable-os/db/sql-export";
import { isCoreTarget, objectTable, sideTable, splitObjectName } from "./naming.ts";
import { buildViews, loadSchemaState } from "./schema.ts";

/** One view as `sqlite_master` holds it. */
export interface ViewDefinition {
  name: string;
  sql: string;
}

/** An import refused because of the extension state it brought. */
export class ImportedStateRefused extends Error {
  override name = "ImportedStateRefused";
}

function derived(fn: () => string): string | null {
  try {
    return fn();
  } catch {
    return null;
  }
}

/**
 * What is wrong with the extension state of an imported database, one line each: none when every
 * object, field and relation is the reconciler's own shape over the database's own extension
 * tables.
 */
export async function importedStateProblems(db: D1Database): Promise<string[]> {
  const tables = new Set(
    (
      await db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'x\\_%' ESCAPE '\\'",
        )
        .all<{ name: string }>()
    ).results.map((r) => r.name),
  );
  const objects = (
    await db
      .prepare("SELECT name, extension_id, local_name, table_name FROM core_extension_objects")
      .all<{ name: string; extension_id: string; local_name: string; table_name: string }>()
  ).results;
  const fields = (
    await db
      .prepare(
        "SELECT extension_id, object, local_name, table_name, column_name, definition FROM core_extension_fields",
      )
      .all<{
        extension_id: string;
        object: string;
        local_name: string;
        table_name: string;
        column_name: string | null;
        definition: string;
      }>()
  ).results;
  const problems: string[] = [];
  const good = new Set<string>();
  for (const object of objects) {
    const parts = splitObjectName(object.name);
    const table = parts ? derived(() => objectTable(parts.extension, parts.object)) : null;
    if (!parts || parts.extension !== object.extension_id || parts.object !== object.local_name) {
      problems.push(`object ${object.name} is not named for its extension`);
    } else if (!table || object.table_name !== table) {
      problems.push(
        `object ${object.name}'s table ${object.table_name} is not ${table ?? "an extension table"}`,
      );
    } else if (!tables.has(table)) {
      problems.push(`object ${object.name}'s table ${table} is not in the database`);
    } else {
      good.add(object.name);
    }
  }
  const columns = new Map<string, Set<string>>();
  const columnsOf = async (table: string) => {
    let known = columns.get(table);
    if (!known) {
      const { results } = await db
        .prepare(`SELECT name FROM pragma_table_info(?)`)
        .bind(table)
        .all<{ name: string }>();
      known = new Set(results.map((r) => r.name));
      columns.set(table, known);
    }
    return known;
  };
  for (const field of fields) {
    const where = `field ${field.local_name} of ${field.extension_id} on ${field.object}`;
    if (!isCoreTarget(field.object) && !good.has(field.object)) {
      problems.push(`${where}: its object is not one the import has`);
      continue;
    }
    const own = field.object.startsWith(`${field.extension_id}.`);
    const parts = own ? splitObjectName(field.object) : null;
    const table = own
      ? parts
        ? derived(() => objectTable(parts.extension, parts.object))
        : null
      : derived(() => sideTable(field.extension_id, field.object));
    if (!table || field.table_name !== table || !tables.has(table)) {
      problems.push(`${where}: its table ${field.table_name} is not its object's extension table`);
      continue;
    }
    if (field.column_name !== null && !(await columnsOf(table)).has(field.column_name)) {
      problems.push(`${where}: its column ${field.column_name} is not a column of ${table}`);
      continue;
    }
    let to: unknown;
    try {
      to = (JSON.parse(field.definition) as { to?: unknown }).to;
    } catch {
      problems.push(`${where}: its definition is not JSON`);
      continue;
    }
    if (to !== undefined && (typeof to !== "string" || !(isCoreTarget(to) || good.has(to)))) {
      problems.push(`${where}: it relates to ${String(to)}, not an object the import has`);
    }
  }
  return problems;
}

/**
 * Makes `db`'s views again: `coreViews` (from the host's migrations), then the record views built
 * from the database's own extension state, once that state is checked (`importedStateProblems`;
 * a problem empties the database and throws `ImportedStateRefused`). Returns how many views were
 * made, and the formulas that did not compile (each becomes NULL, as the reconciler leaves it).
 */
export async function rebuildRecordViews(
  db: D1Database,
  coreViews: readonly ViewDefinition[],
): Promise<{ views: number; formulaErrors: number }> {
  // A database older than the extensions' tables has no record views to make.
  const extensible = await db
    .prepare(
      "SELECT 1 AS one FROM sqlite_master WHERE type = 'table' AND name = 'core_extension_objects'",
    )
    .first();
  if (extensible) {
    const problems = await importedStateProblems(db);
    if (problems.length) {
      await emptyDatabase(db);
      throw new ImportedStateRefused(
        `the import was refused and the database emptied: its extension state is not the reconciler's (${problems.slice(0, 5).join("; ")}${problems.length > 5 ? `; and ${problems.length - 5} more` : ""})`,
      );
    }
  }
  const existing = await db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'view'")
    .all<{ name: string }>();
  const statements = [
    ...existing.results.map((row) => `DROP VIEW IF EXISTS "${row.name.replaceAll('"', '""')}"`),
    ...coreViews.map((view) => view.sql),
  ];
  if (statements.length) await db.batch(statements.map((sql) => db.prepare(sql)));
  if (!extensible) return { views: coreViews.length, formulaErrors: 0 };
  const build = buildViews(await loadSchemaState(createDb(db)));
  const rebuilt = [...build.drops, ...build.creates];
  if (rebuilt.length) await db.batch(rebuilt.map((sql) => db.prepare(sql)));
  const { results } = await db
    .prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'view'")
    .all<{ n: number }>();
  return { views: Number(results[0]?.n ?? 0), formulaErrors: build.errors.length };
}
