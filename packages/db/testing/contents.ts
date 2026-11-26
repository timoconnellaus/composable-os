// Everything a database holds, read without the export's code (stage 66 step 2, ADR 0614): its
// schema, then every table's rows (every column, generated ones included, and the rowid), each
// value as its type and its bytes (text and BLOBs in hex, numbers by quote()'s exact digits), and
// what its search indexes find. Two databases with equal contents hold the same data. Used by
// test/sql-export.test.ts and by the proof Worker's /export on Cloudflare.

const SHADOW = /_(data|idx|content|docsize|config)$/;

export interface DatabaseContents {
  schema: Record<string, unknown>[];
  tables: Record<string, unknown[][]>;
  /** For each FTS5 table: the rowids every one of `terms` matches. */
  search: Record<string, unknown[][]>;
}

export async function databaseContents(
  db: D1Database,
  terms: string[] = ["a*", "e*"],
): Promise<DatabaseContents> {
  const { results: schema } = await db
    .prepare(
      "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE '\\_cf\\_%' ESCAPE '\\' ORDER BY type, name",
    )
    .all<{ type: string; name: string; sql: string | null }>();
  const virtual = schema.filter((m) => /^CREATE VIRTUAL/i.test(m.sql ?? "")).map((m) => m.name);
  const tables: Record<string, unknown[][]> = {};
  const search: Record<string, unknown[][]> = {};
  for (const m of schema) {
    if (m.type !== "table") continue;
    if (virtual.some((v) => SHADOW.test(m.name) && m.name.startsWith(`${v}_`))) continue;
    const quoted = `"${m.name.replaceAll('"', '""')}"`;
    if (virtual.includes(m.name)) {
      for (const term of terms) {
        search[`${m.name} ${term}`] = await db
          .prepare(`SELECT rowid FROM ${quoted} WHERE ${quoted} MATCH ? ORDER BY rowid`)
          .bind(term)
          .raw();
      }
    }
    const { results: cols } = await db
      .prepare("SELECT name FROM pragma_table_xinfo(?) WHERE hidden != 1")
      .bind(m.name)
      .all<{ name: string }>();
    const values = cols.map(({ name }) => {
      const c = `"${name.replaceAll('"', '""')}"`;
      return `typeof(${c}) || ':' || CASE typeof(${c}) WHEN 'text' THEN hex(${c}) WHEN 'blob' THEN hex(${c}) ELSE quote(${c}) END`;
    });
    // From SQLite itself: a trailing comment in the CREATE text would fool a pattern.
    const withoutRowid =
      (await db
        .prepare("SELECT wr FROM pragma_table_list WHERE schema = 'main' AND name = ?")
        .bind(m.name)
        .first<number>("wr")) === 1;
    const select = [...(withoutRowid ? [] : ["quote(rowid)"]), ...values].join(", ");
    tables[m.name] = await db
      .prepare(`SELECT ${select || "1"} FROM ${quoted} ORDER BY 1${values.length ? ", 2" : ""}`)
      .raw();
  }
  return { schema, tables, search };
}

/** The tables of two readings whose rows differ, and those only one has. */
export function contentsDiffer(a: DatabaseContents, b: DatabaseContents): string[] {
  const differ: string[] = [];
  if (JSON.stringify(a.schema) !== JSON.stringify(b.schema)) differ.push("(schema)");
  for (const name of new Set([...Object.keys(a.tables), ...Object.keys(b.tables)])) {
    if (JSON.stringify(a.tables[name]) !== JSON.stringify(b.tables[name])) differ.push(name);
  }
  if (JSON.stringify(a.search) !== JSON.stringify(b.search)) differ.push("(search)");
  return differ;
}
