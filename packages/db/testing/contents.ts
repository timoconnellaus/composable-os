// Everything a database holds, read without the export's code (stage 66 step 2, ADR 0614): its
// schema, then every table's rows (every column, generated ones included, and the rowid), each
// value as its type and its bytes (text and BLOBs in hex, numbers by quote()'s exact digits), and
// what its search indexes find. Two databases with equal contents hold the same data. Used by
// test/sql-export.test.ts, and table by table (`contentTables`, `tableContents`) by the proof
// Worker's /step2/export on Cloudflare, which reads a few tables a call.

const SHADOW = /_(data|idx|content|docsize|config)$/;

export interface DatabaseContents {
  schema: Record<string, unknown>[];
  tables: Record<string, unknown[][]>;
  /** For each FTS5 table: the rowids every one of `terms` matches. */
  search: Record<string, unknown[][]>;
}

type MasterRow = {
  type: string;
  name: string;
  tbl_name: string;
  sql: string | null;
};

/** The schema, and the tables whose rows a reading holds (FTS5 shadow tables left out). */
export async function contentTables(
  db: D1Database,
): Promise<{ schema: MasterRow[]; tables: MasterRow[]; virtual: string[] }> {
  const { results: schema } = await db
    .prepare(
      "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE '\\_cf\\_%' ESCAPE '\\' ORDER BY type, name",
    )
    .all<MasterRow>();
  const virtual = schema.filter((m) => /^CREATE VIRTUAL/i.test(m.sql ?? "")).map((m) => m.name);
  const tables = schema.filter(
    (m) =>
      m.type === "table" && !virtual.some((v) => SHADOW.test(m.name) && m.name.startsWith(`${v}_`)),
  );
  return { schema, tables, virtual };
}

/** One table's rows, and, for an FTS5 table, what each of `terms` finds. */
export async function tableContents(
  db: D1Database,
  table: MasterRow,
  virtual: string[],
  terms: string[] = ["a*", "e*"],
): Promise<{ rows: unknown[][]; search: Record<string, unknown[][]> }> {
  const quoted = `"${table.name.replaceAll('"', '""')}"`;
  const search: Record<string, unknown[][]> = {};
  if (virtual.includes(table.name)) {
    for (const term of terms) {
      search[`${table.name} ${term}`] = await db
        .prepare(`SELECT rowid FROM ${quoted} WHERE ${quoted} MATCH ? ORDER BY rowid`)
        .bind(term)
        .raw();
    }
  }
  const { results: cols } = await db
    .prepare("SELECT name FROM pragma_table_xinfo(?) WHERE hidden != 1")
    .bind(table.name)
    .all<{ name: string }>();
  const values = cols.map(({ name }) => {
    const c = `"${name.replaceAll('"', '""')}"`;
    return `typeof(${c}) || ':' || CASE typeof(${c}) WHEN 'text' THEN hex(${c}) WHEN 'blob' THEN hex(${c}) ELSE quote(${c}) END`;
  });
  // From SQLite itself: a trailing comment in the CREATE text would fool a pattern.
  const withoutRowid =
    (await db
      .prepare("SELECT wr FROM pragma_table_list WHERE schema = 'main' AND name = ?")
      .bind(table.name)
      .first<number>("wr")) === 1;
  const select = [...(withoutRowid ? [] : ["quote(rowid)"]), ...values].join(", ");
  const rows = await db
    .prepare(`SELECT ${select || "1"} FROM ${quoted} ORDER BY 1${values.length ? ", 2" : ""}`)
    .raw();
  return { rows, search };
}

export async function databaseContents(
  db: D1Database,
  terms: string[] = ["a*", "e*"],
): Promise<DatabaseContents> {
  const { schema, tables, virtual } = await contentTables(db);
  const contents: DatabaseContents = { schema, tables: {}, search: {} };
  for (const table of tables) {
    const { rows, search } = await tableContents(db, table, virtual, terms);
    contents.tables[table.name] = rows;
    Object.assign(contents.search, search);
  }
  return contents;
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
