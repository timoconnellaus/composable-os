// A database out as SQL and back in (stage 66 step 2, ADR 0614): what `cos client export` and
// `cos client import` call (step 7), for a move between hosts and for the leaving promise (stage 46,
// decisions 17 and 22). It works over any `D1Database`, so the same code exports a client's
// database (`clientDatabase`) or a D1 database, and imports into either: a client exported from
// the host installs on D1 in its own account, and a D1 deployment moves onto the host.
//
// The export is a list of parts, each a list of plain SQL statements with no parameters, each
// under SQLite's and D1's 100 KB a statement, so a part runs on D1, on a client's database, or in
// the `sqlite3` shell (`partToSql`). It is taken in bounded parts (`exportPart`, a cursor between
// calls), so a large database never crosses one call or fills a Worker's memory, and a call stays
// far inside an invocation's subrequests. What it carries, exactly:
//
// - Every ordinary table and its rows, every value as it is stored: integers past 2^53, reals to
//   the last bit (`quote()`), NULLs, BLOBs, and text of any bytes (hex on the way out; text that is
//   not valid UTF-8, or holds a NUL, goes back as `CAST(X'…' AS TEXT)`). A rowid that is not a
//   column is kept. A generated column is left to its table to compute.
// - A value too large for one statement is built in `_cos_import_scratch` a chunk at a time and
//   inserted whole, so the row's constraints (`CHECK (json_valid(...))`) see only the whole value.
// - Foreign keys: tables in an order where a parent comes before its children. A column that
//   refers to its own table (a person merged into another) is inserted as NULL and set once all
//   the table's rows are in, so a part never commits a row whose parent is in a later part.
// - `sqlite_sequence`, as it was (an AUTOINCREMENT table's next id is not lowered).
// - FTS5 tables: created again, and filled the way they were: an external-content index rebuilt
//   from its content table, an index with its own content given its rows. Their shadow tables are
//   not copied (SQLite refuses writes to them); a contentless FTS5 table, or another virtual
//   table, is refused at export.
// - Indexes, views and triggers last, in the order they were made, so no trigger fires while the
//   rows go in (the search index's triggers would index every row twice).
//
// Not carried: the object's own storage (`_cf_*`: its key-value records, alarms), `sqlite_stat*`
// (ANALYZE's statistics, rebuilt by SQLite), and anything written during the export: nothing may
// write to the database while it is exported (step 7 pauses the client first). The last part's
// row counts are checked when it is imported.
//
// An import into a database that holds any table is refused. It is resumable: each part is one
// transaction that also records the next part due (`_cos_import`), so after a failure the same
// parts are given again and those already in are skipped.

/** The export's format; a part of another format is refused. */
export const EXPORT_FORMAT = "cos-sql-export/1";

/** The largest statement an export writes: inside the 100,000 bytes D1 and SQLite take. */
export const MAX_STATEMENT_BYTES = 90_000;

/** The most a chunk of a large value carries, in bytes of SQL. */
const CHUNK_BYTES = 60_000;

/** A part's default size in bytes of SQL. */
export const DEFAULT_PART_BYTES = 4 * 1024 * 1024;

/** At most this many statements a part, so one part is one modest batch. */
export const MAX_PART_STATEMENTS = 20_000;

/** Rows looked at per page of a table. */
const PAGE_ROWS = 1_000;

/** Where a large value is built (and the import's own record), never in an export's tables. */
export const SCRATCH_TABLE = "_cos_import_scratch";
export const IMPORT_TABLE = "_cos_import";

/** One part of an export: statements to run in order, as one transaction. */
export interface ExportPart {
  format: typeof EXPORT_FORMAT;
  /** The export this part belongs to. */
  id: string;
  /** 0, 1, 2…: the order the parts are imported in. */
  index: number;
  statements: string[];
  /** True on the export's last part. */
  last: boolean;
  /** On the last part: every table's row count, which the import checks. */
  counts?: Record<string, number>;
  /** On the first part: what was exported. */
  source?: { exportedAt: string; schemaVersion: number | null; tables: number };
}

/** Where an export has got to: give it back to `exportPart` for the next part. */
export interface ExportCursor {
  format: typeof EXPORT_FORMAT;
  id: string;
  index: number;
  stage: Stage;
  /** The table within the stage. */
  table: number;
  /** The last key written, as SQL literals. */
  after: string[] | null;
  counts: Record<string, number>;
}

type Stage = "schema" | "rows" | "fixups" | "rebuild" | "sequence" | "objects" | "done";

/** Refused: the export cannot be taken, or an import cannot be applied, and why. */
export class SqlExportError extends Error {
  override name = "SqlExportError";
}

// --- What the schema holds -----------------------------------------------------------------------

interface Column {
  name: string;
  notNull: boolean;
  /** Position in the primary key, 0 when not in it. */
  pk: number;
}

interface TablePlan {
  name: string;
  /** The columns an INSERT names (no generated or hidden ones). */
  columns: Column[];
  /** How rows are ordered and found: the rowid (by a name no column has) or the primary key. */
  key: string[];
  /** Columns inserted as NULL and set after all the table's rows (a foreign key to itself or later). */
  deferred: string[];
  kind: "table" | "fts5-content" | "fts5-external";
}

interface Plan {
  /** Ordinary tables in creation order, then virtual tables: what `schema` creates. */
  creates: string[];
  /** Tables whose rows are copied, parents first. */
  tables: TablePlan[];
  /** External-content FTS5 tables, rebuilt from their content. */
  rebuilds: string[];
  /** Indexes, views and triggers, in creation order. */
  objects: string[];
  hasSequence: boolean;
}

/** An identifier as SQL. */
export function ident(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

const FTS5_SHADOWS = ["data", "idx", "content", "docsize", "config"];

/** Names the export never carries: SQLite's, Cloudflare's, and the import's own. */
function internal(name: string): boolean {
  return /^(sqlite_|_cf_|_cos_import)/i.test(name);
}

interface MasterRow {
  type: string;
  name: string;
  tbl_name: string;
  sql: string | null;
}

async function readPlan(db: D1Database): Promise<Plan> {
  const { results: master } = await db
    .prepare("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY rowid")
    .all<MasterRow>();
  const virtual = master.filter(
    (row) => row.type === "table" && /^\s*CREATE\s+VIRTUAL\s+TABLE/i.test(row.sql ?? ""),
  );
  const shadows = new Set<string>();
  const rebuilds: string[] = [];
  const contentFts = new Set<string>();
  for (const row of virtual) {
    if (internal(row.name)) continue;
    const sql = row.sql ?? "";
    const module = /\bUSING\s+(\w+)/i.exec(sql)?.[1]?.toLowerCase();
    if (module !== "fts5") {
      throw new SqlExportError(
        `${row.name} is a virtual table of the ${module ?? "unknown"} module, which an export cannot carry`,
      );
    }
    for (const suffix of FTS5_SHADOWS) shadows.add(`${row.name}_${suffix}`.toLowerCase());
    const content = /\bcontent\s*=\s*(?:'((?:[^']|'')*)'|"((?:[^"]|"")*)"|([\w]+))/i.exec(sql);
    const contentTable = content ? (content[1] ?? content[2] ?? content[3] ?? "") : null;
    if (contentTable === null) contentFts.add(row.name);
    else if (contentTable === "") {
      throw new SqlExportError(
        `${row.name} is a contentless FTS5 table, whose text an export cannot read back`,
      );
    } else rebuilds.push(row.name);
  }
  const ordinary = master.filter(
    (row) =>
      row.type === "table" &&
      !internal(row.name) &&
      !shadows.has(row.name.toLowerCase()) &&
      !virtual.includes(row),
  );
  const dataTables = [
    ...ordinary.map((row) => ({ row, kind: "table" as const })),
    ...virtual
      .filter((row) => contentFts.has(row.name))
      .map((row) => ({ row, kind: "fts5-content" as const })),
  ];

  // Every table's columns and foreign keys in two queries, not two a table.
  const names = dataTables.map(({ row }) => row.name);
  const columns = new Map<string, Column[]>();
  const parents = new Map<string, { table: string; from: string }[]>();
  if (names.length > 0) {
    const list = names.map((name) => `'${name.replaceAll("'", "''")}'`).join(", ");
    const { results: cols } = await db
      .prepare(
        `SELECT m.name AS t, p.name AS name, p."notnull" AS nn, p.pk AS pk, p.hidden AS hidden
         FROM sqlite_master m JOIN pragma_table_xinfo(m.name) p
         WHERE m.type = 'table' AND m.name IN (${list}) ORDER BY m.name, p.cid`,
      )
      .all<{ t: string; name: string; nn: number; pk: number; hidden: number }>();
    for (const col of cols) {
      if (col.hidden !== 0) continue; // generated (2, 3) or a virtual table's hidden column (1)
      const list = columns.get(col.t) ?? [];
      list.push({ name: col.name, notNull: col.nn === 1, pk: col.pk });
      columns.set(col.t, list);
    }
    const ordinaryNames = ordinary.map((row) => `'${row.name.replaceAll("'", "''")}'`).join(", ");
    if (ordinary.length > 0) {
      const { results: fks } = await db
        .prepare(
          `SELECT m.name AS t, f."table" AS parent, f."from" AS col
           FROM sqlite_master m JOIN pragma_foreign_key_list(m.name) f
           WHERE m.type = 'table' AND m.name IN (${ordinaryNames})`,
        )
        .all<{ t: string; parent: string; col: string }>();
      for (const fk of fks) {
        const list = parents.get(fk.t) ?? [];
        list.push({ table: fk.parent, from: fk.col });
        parents.set(fk.t, list);
      }
    }
  }

  // Parents before children, in creation order otherwise; a cycle is broken at its earliest table.
  const order: string[] = [];
  const placed = new Set<string>();
  const remaining = [...names];
  const lower = (name: string) => name.toLowerCase();
  const known = new Set(names.map(lower));
  while (remaining.length > 0) {
    const ready = remaining.findIndex((name) =>
      (parents.get(name) ?? []).every(
        (p) =>
          lower(p.table) === lower(name) ||
          placed.has(lower(p.table)) ||
          !known.has(lower(p.table)),
      ),
    );
    const [next] = remaining.splice(Math.max(ready, 0), 1) as [string];
    order.push(next);
    placed.add(lower(next));
  }

  const kinds = new Map(dataTables.map(({ row, kind }) => [row.name, { row, kind }]));
  const tables = order.map((name): TablePlan => {
    const entry = kinds.get(name) as { row: MasterRow; kind: TablePlan["kind"] };
    const cols = columns.get(name) ?? [];
    const withoutRowid =
      entry.kind === "table" && /\bWITHOUT\s+ROWID\b[\s,a-z]*;?\s*$/i.test(entry.row.sql ?? "");
    let key: string[];
    if (withoutRowid) {
      key = cols
        .filter((c) => c.pk > 0)
        .sort((a, b) => a.pk - b.pk)
        .map((c) => c.name);
    } else {
      const taken = new Set(cols.map((c) => lower(c.name)));
      const alias = ["rowid", "_rowid_", "oid"].find((n) => !taken.has(n));
      if (!alias) throw new SqlExportError(`${name} has columns named rowid, _rowid_ and oid`);
      key = [alias];
    }
    const before = new Set(order.slice(0, order.indexOf(name)).map(lower));
    const keyNames = new Set(key.map(lower));
    const deferred = [
      ...new Set(
        (parents.get(name) ?? [])
          .filter((p) => !before.has(lower(p.table)) && known.has(lower(p.table)))
          .map((p) => p.from),
      ),
    ].filter((from) => {
      const col = cols.find((c) => lower(c.name) === lower(from));
      return col !== undefined && !col.notNull && !keyNames.has(lower(from));
    });
    return { name, columns: cols, key, deferred, kind: entry.kind };
  });

  return {
    creates: [...ordinary, ...virtual.filter((row) => !internal(row.name))].map(
      (row) => row.sql as string,
    ),
    tables,
    rebuilds,
    objects: master
      .filter(
        (row) =>
          row.type !== "table" &&
          row.sql !== null &&
          !internal(row.name) &&
          !internal(row.tbl_name) &&
          !shadows.has(row.tbl_name.toLowerCase()),
      )
      .map((row) => row.sql as string),
    hasSequence: master.some((row) => row.name === "sqlite_sequence"),
  };
}

// --- Values as SQL ---------------------------------------------------------------------------------

/** A column's value, encoded in SQL so that nothing is lost on the way: text as hex, else quote(). */
function encode(column: string): string {
  const c = ident(column);
  return `CASE typeof(${c}) WHEN 'text' THEN 'T' || hex(${c}) ELSE quote(${c}) END`;
}

const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function bytesOf(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = Number.parseInt(hex.slice(2 * i, 2 * i + 2), 16);
  }
  return bytes;
}

/** A value as the export carries it: a literal, or the chunks of one too large for a statement. */
interface Literal {
  sql: string;
  /** Its size in bytes of SQL. */
  bytes: number;
  /** For a large value: its chunks, and whether it is bytes (a BLOB) or text. */
  chunks?: () => string[];
  blob?: boolean;
}

/** Splits `text` into pieces of at most `limit` bytes of UTF-8, between code points. */
function splitText(text: string, limit: number): string[] {
  const pieces: string[] = [];
  let start = 0;
  let bytes = 0;
  for (let i = 0; i < text.length; ) {
    const code = text.codePointAt(i) as number;
    const width = code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
    const units = code >= 0x10000 ? 2 : 1;
    // A quote is written twice.
    const cost = code === 0x27 ? 2 : width;
    if (bytes + cost > limit && i > start) {
      pieces.push(text.slice(start, i));
      start = i;
      bytes = 0;
    }
    bytes += cost;
    i += units;
  }
  pieces.push(text.slice(start));
  return pieces;
}

function hexChunks(hex: string, wrap: (h: string) => string): string[] {
  const size = CHUNK_BYTES - (CHUNK_BYTES % 2);
  const chunks: string[] = [];
  for (let i = 0; i < hex.length; i += size) chunks.push(wrap(hex.slice(i, i + size)));
  return chunks.length > 0 ? chunks : [wrap("")];
}

const textLiteral = (s: string) => `'${s.replaceAll("'", "''")}'`;
const castText = (hex: string) => `CAST(X'${hex}' AS TEXT)`;

/** The encoded value (from `encode`) as a literal. */
function literal(encoded: string): Literal {
  if (encoded.startsWith("T")) {
    const hex = encoded.slice(1);
    let text: string | null = null;
    try {
      text = decoder.decode(bytesOf(hex));
      if (text.includes("\u0000")) text = null;
    } catch {
      text = null;
    }
    if (text === null) {
      const sql = castText(hex);
      return { sql, bytes: sql.length, chunks: () => hexChunks(hex, castText), blob: false };
    }
    const valid = text;
    const quotes = valid.split("'").length - 1;
    return {
      sql: textLiteral(valid),
      bytes: hex.length / 2 + quotes + 2,
      chunks: () => splitText(valid, CHUNK_BYTES).map(textLiteral),
      blob: false,
    };
  }
  if (encoded.startsWith("X'")) {
    const hex = encoded.slice(2, -1);
    return {
      sql: encoded,
      bytes: encoded.length,
      chunks: () => hexChunks(hex, (h) => `X'${h}'`),
      blob: true,
    };
  }
  // NULL, an integer or a real, exactly as quote() wrote it.
  return { sql: encoded, bytes: encoded.length };
}

const utf8 = new TextEncoder();
const sizeOf = (sql: string) => utf8.encode(sql).length;

/**
 * The statements that insert one row: one INSERT, or, when the row is too large for one statement,
 * its largest values built in the scratch table first and inserted from there.
 */
function insertRow(table: string, columns: string[], values: Literal[]): string[] {
  const head = `INSERT INTO ${ident(table)} (${columns.map(ident).join(", ")}) VALUES (`;
  const headBytes = sizeOf(head) + 2 * values.length + 2;
  let total = headBytes + values.reduce((sum, v) => sum + v.bytes, 0);
  const sql = values.map((v) => v.sql);
  const before: string[] = [];
  if (total > MAX_STATEMENT_BYTES) {
    const order = values
      .map((value, i) => ({ value, i }))
      .filter(({ value }) => value.chunks)
      .sort((a, b) => b.value.bytes - a.value.bytes);
    let k = 0;
    for (const { value, i } of order) {
      if (total <= MAX_STATEMENT_BYTES) break;
      k += 1;
      const chunks = (value.chunks as () => string[])();
      const scratch = ident(SCRATCH_TABLE);
      before.push(`INSERT INTO ${scratch} (k, v) VALUES (${k}, ${chunks[0]})`);
      for (const chunk of chunks.slice(1)) {
        before.push(`UPDATE ${scratch} SET v = v || ${chunk} WHERE k = ${k}`);
      }
      sql[i] = value.blob
        ? `(SELECT CAST(v AS BLOB) FROM ${scratch} WHERE k = ${k})`
        : `(SELECT v FROM ${scratch} WHERE k = ${k})`;
      total += sizeOf(sql[i] as string) - value.bytes;
    }
    if (total > MAX_STATEMENT_BYTES) {
      throw new SqlExportError(`a row of ${table} is too large to export even in chunks`);
    }
    before.push(`DELETE FROM ${ident(SCRATCH_TABLE)}`);
    return [...before.slice(0, -1), `${head}${sql.join(", ")})`, before.at(-1) as string];
  }
  return [`${head}${sql.join(", ")})`];
}

/** The literal of a key value: text by its bytes, so a key of any bytes is matched exactly. */
function keyLiteral(encoded: string): string {
  return encoded.startsWith("T") ? castText(encoded.slice(1)) : encoded;
}

const keyTuple = (key: string[]) =>
  key.length === 1 ? ident(key[0] as string) : `(${key.map(ident).join(", ")})`;
const valueTuple = (values: string[]) =>
  values.length === 1 ? (values[0] as string) : `(${values.join(", ")})`;

// --- Export ----------------------------------------------------------------------------------------

/**
 * The next part of an export of `db`: the first when `cursor` is null. Returns the part and the
 * cursor for the one after it, null after the last. Each call reads at most about `maxBytes` of
 * SQL from the database, a page at a time.
 */
export async function exportPart(
  db: D1Database,
  cursor: ExportCursor | null = null,
  options: { maxBytes?: number } = {},
): Promise<{ part: ExportPart; next: ExportCursor | null }> {
  const maxBytes = options.maxBytes ?? DEFAULT_PART_BYTES;
  const plan = await readPlan(db);
  const at: ExportCursor = cursor
    ? structuredClone(cursor)
    : {
        format: EXPORT_FORMAT,
        id: crypto.randomUUID(),
        index: 0,
        stage: "schema",
        table: 0,
        after: null,
        counts: {},
      };
  if (at.format !== EXPORT_FORMAT) throw new SqlExportError(`not a cursor of ${EXPORT_FORMAT}`);
  const statements: string[] = [];
  let bytes = 0;
  const push = (...sql: string[]) => {
    for (const s of sql) {
      statements.push(s);
      bytes += sizeOf(s);
    }
  };
  const full = () => bytes >= maxBytes || statements.length >= MAX_PART_STATEMENTS;
  let source: ExportPart["source"];

  if (at.stage === "schema") {
    let schemaVersion: number | null = null;
    try {
      const row = await db
        .prepare("SELECT value FROM core_meta WHERE key = 'schema_version'")
        .first<{ value: string }>();
      schemaVersion = row ? Number(row.value) : null;
    } catch {
      // Not a host's database: no version to report.
    }
    source = { exportedAt: new Date().toISOString(), schemaVersion, tables: plan.tables.length };
    push(`CREATE TABLE IF NOT EXISTS ${ident(SCRATCH_TABLE)} (k INTEGER PRIMARY KEY, v)`);
    push(...plan.creates);
    at.stage = "rows";
    at.table = 0;
    at.after = null;
  }

  while (!full() && at.stage !== "done") {
    if (at.stage === "rows" || at.stage === "fixups") {
      const table = plan.tables[at.table];
      if (!table) {
        at.stage = at.stage === "rows" ? "fixups" : "rebuild";
        at.table = 0;
        at.after = null;
        continue;
      }
      const fixups = at.stage === "fixups";
      if (fixups && table.deferred.length === 0) {
        at.table += 1;
        continue;
      }
      const done = fixups
        ? await fixupPage(db, table, at, maxBytes - bytes, push)
        : await rowsPage(db, table, at, maxBytes - bytes, push);
      if (done) {
        at.table += 1;
        at.after = null;
      }
      continue;
    }
    if (at.stage === "rebuild") {
      for (const name of plan.rebuilds)
        push(`INSERT INTO ${ident(name)} (${ident(name)}) VALUES ('rebuild')`);
      at.stage = "sequence";
      continue;
    }
    if (at.stage === "sequence") {
      if (plan.hasSequence) {
        const { results } = await db
          .prepare(`SELECT ${encode("name")} AS name, quote(seq) AS seq FROM sqlite_sequence`)
          .all<{ name: string; seq: string }>();
        push("DELETE FROM sqlite_sequence");
        for (const row of results) {
          push(
            `INSERT INTO sqlite_sequence (name, seq) VALUES (${literal(row.name).sql}, ${row.seq})`,
          );
        }
      }
      at.stage = "objects";
      continue;
    }
    if (at.stage === "objects") {
      push(...plan.objects, `DROP TABLE IF EXISTS ${ident(SCRATCH_TABLE)}`);
      at.stage = "done";
    }
  }

  const last = at.stage === "done";
  const part: ExportPart = {
    format: EXPORT_FORMAT,
    id: at.id,
    index: at.index,
    statements,
    last,
    ...(last ? { counts: at.counts } : {}),
    ...(source ? { source } : {}),
  };
  at.index += 1;
  return { part, next: last ? null : at };
}

/** Writes one page of `table`'s rows; true when the table is done. */
async function rowsPage(
  db: D1Database,
  table: TablePlan,
  at: ExportCursor,
  budget: number,
  push: (...sql: string[]) => void,
): Promise<boolean> {
  const { key } = table;
  at.counts[table.name] ??= 0;
  const where = at.after ? `WHERE ${keyTuple(key)} > ${valueTuple(at.after)}` : "";
  const order = key.map(ident).join(", ");
  const keys = key.map((k, i) => `${encode(k)} AS k${i}`).join(", ");
  const length =
    table.columns.map((c) => `coalesce(length(CAST(${ident(c.name)} AS BLOB)), 4)`).join(" + ") ||
    "0";
  // First the keys and sizes of the next rows, so that what is fetched is bounded.
  const { results: sizes } = await db
    .prepare(
      `SELECT ${keys}, ${length} AS n FROM ${ident(table.name)} ${where} ORDER BY ${order} LIMIT ${PAGE_ROWS}`,
    )
    .all<Record<string, string | number>>();
  if (sizes.length === 0) return true;
  let take = 0;
  let planned = 0;
  for (const row of sizes) {
    const n = 2 * Number(row.n) + 64;
    if (take > 0 && planned + n > Math.max(budget, 0)) break;
    take += 1;
    planned += n;
  }
  const lastRow = sizes[take - 1] as Record<string, string>;
  const upTo = key.map((_, i) => keyLiteral(lastRow[`k${i}`] as string));
  const values = table.columns.map((c, i) => `${encode(c.name)} AS v${i}`).join(", ");
  const range = `${where ? `${where} AND` : "WHERE"} ${keyTuple(key)} <= ${valueTuple(upTo)}`;
  const { results } = await db
    .prepare(
      `SELECT ${keys}${values ? `, ${values}` : ""} FROM ${ident(table.name)} ${range} ORDER BY ${order}`,
    )
    .all<Record<string, string>>();
  const insertColumns = [
    ...(key.length === 1 && !table.columns.some((c) => c.name === key[0]) ? key : []),
  ];
  const names = [...insertColumns, ...table.columns.map((c) => c.name)];
  const deferred = new Set(table.deferred);
  for (const row of results) {
    const rowid = insertColumns.length ? [literal(row.k0 as string)] : [];
    const cells = table.columns.map((c, i) =>
      deferred.has(c.name) ? { sql: "NULL", bytes: 4 } : literal(row[`v${i}`] as string),
    );
    push(...insertRow(table.name, names, [...rowid, ...cells]));
  }
  at.counts[table.name] = (at.counts[table.name] ?? 0) + results.length;
  at.after = upTo;
  return sizes.length < PAGE_ROWS && take === sizes.length;
}

/** Writes one page of the deferred foreign keys of `table`; true when the table is done. */
async function fixupPage(
  db: D1Database,
  table: TablePlan,
  at: ExportCursor,
  _budget: number,
  push: (...sql: string[]) => void,
): Promise<boolean> {
  const { key } = table;
  const order = key.map(ident).join(", ");
  const keys = key.map((k, i) => `${encode(k)} AS k${i}`).join(", ");
  const values = table.deferred.map((c, i) => `${encode(c)} AS v${i}`).join(", ");
  const set = table.deferred.map((c) => `${ident(c)} IS NOT NULL`).join(" OR ");
  const where = `WHERE (${set})${at.after ? ` AND ${keyTuple(key)} > ${valueTuple(at.after)}` : ""}`;
  const { results } = await db
    .prepare(
      `SELECT ${keys}, ${values} FROM ${ident(table.name)} ${where} ORDER BY ${order} LIMIT ${PAGE_ROWS}`,
    )
    .all<Record<string, string>>();
  for (const row of results) {
    const assignments = table.deferred
      .map((c, i) => `${ident(c)} = ${literal(row[`v${i}`] as string).sql}`)
      .join(", ");
    const match = key
      .map((k, i) => `${ident(k)} = ${keyLiteral(row[`k${i}`] as string)}`)
      .join(" AND ");
    push(`UPDATE ${ident(table.name)} SET ${assignments} WHERE ${match}`);
  }
  const lastRow = results.at(-1);
  if (lastRow) at.after = key.map((_, i) => keyLiteral(lastRow[`k${i}`] as string));
  return results.length < PAGE_ROWS;
}

/** Every part of an export of `db`, in order. */
export async function* exportDatabase(
  db: D1Database,
  options: { maxBytes?: number } = {},
): AsyncGenerator<ExportPart> {
  let cursor: ExportCursor | null = null;
  do {
    const { part, next }: { part: ExportPart; next: ExportCursor | null } = await exportPart(
      db,
      cursor,
      options,
    );
    yield part;
    cursor = next;
  } while (cursor);
}

/** A part as a `.sql` text, for the `sqlite3` shell or a person to read. */
export function partToSql(part: ExportPart): string {
  return `-- ${part.format} ${part.id} part ${part.index}${part.last ? " (last)" : ""}\n${part.statements
    .map((s) => `${s};`)
    .join("\n")}\n`;
}

// --- Import ----------------------------------------------------------------------------------------

/** What `importPart` did with a part. */
export interface ImportStep {
  /** False when the part was already in (a resumed import). */
  applied: boolean;
  /** True once the last part is in and the row counts are checked. */
  done: boolean;
}

/** Does the database hold anything an export would carry? */
async function holdsTables(db: D1Database): Promise<string[]> {
  const { results } = await db
    .prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'view') ORDER BY name")
    .all<{ name: string }>();
  return results.map((row) => row.name).filter((name) => !/^(sqlite_|_cf_)/i.test(name));
}

/**
 * Imports one part of an export into `db`, in one transaction. Part 0 needs a database that holds
 * no table; a later part needs the one before it in, and a part already in is skipped. After the
 * last, every table's row count is checked against the export's, and the import's own table is
 * dropped.
 */
export async function importPart(db: D1Database, part: ExportPart): Promise<ImportStep> {
  if (part.format !== EXPORT_FORMAT) {
    throw new SqlExportError(`not a part of ${EXPORT_FORMAT}: ${String(part.format)}`);
  }
  const tables = await holdsTables(db);
  const marker = tables.includes(IMPORT_TABLE);
  let next = 0;
  if (marker) {
    const row = await db
      .prepare(`SELECT export_id AS id, next_part AS next FROM ${ident(IMPORT_TABLE)}`)
      .first<{ id: string; next: number }>();
    if (!row || row.id !== part.id) {
      throw new SqlExportError(
        "an earlier import of another export did not finish here; empty the database and import again",
      );
    }
    next = row.next;
    if (part.index < next) return { applied: false, done: false };
    if (part.index > next)
      throw new SqlExportError(`part ${next} is missing before part ${part.index}`);
  } else if (tables.length > 0) {
    throw new SqlExportError(
      `the database is not empty (it holds ${tables.length} tables or views, such as ${tables[0]}); an import goes only into an empty one`,
    );
  } else if (part.index !== 0) {
    throw new SqlExportError(`an import starts with part 0, not part ${part.index}`);
  }

  const record =
    part.index === 0
      ? [
          `CREATE TABLE ${ident(IMPORT_TABLE)} (export_id TEXT NOT NULL, next_part INTEGER NOT NULL)`,
          `INSERT INTO ${ident(IMPORT_TABLE)} VALUES (${textLiteral(part.id)}, 1)`,
        ]
      : [`UPDATE ${ident(IMPORT_TABLE)} SET next_part = ${part.index + 1}`];
  await db.batch(
    ["PRAGMA defer_foreign_keys = ON", ...part.statements, ...record].map((sql) => db.prepare(sql)),
  );
  if (!part.last) return { applied: true, done: false };

  const wrong: string[] = [];
  for (const [table, expected] of Object.entries(part.counts ?? {})) {
    const row = await db
      .prepare(`SELECT count(*) AS n FROM ${ident(table)}`)
      .first<{ n: number }>();
    if (row?.n !== expected) wrong.push(`${table}: ${row?.n} rows, the export has ${expected}`);
  }
  if (wrong.length > 0) {
    throw new SqlExportError(`the import does not match its export: ${wrong.join("; ")}`);
  }
  await db.prepare(`DROP TABLE ${ident(IMPORT_TABLE)}`).run();
  return { applied: true, done: true };
}

/** Imports every part, in order; resumes an unfinished import of the same export. */
export async function importDatabase(
  db: D1Database,
  parts: AsyncIterable<ExportPart> | Iterable<ExportPart>,
): Promise<{ parts: number }> {
  let count = 0;
  let done = false;
  for await (const part of parts) {
    ({ done } = await importPart(db, part));
    count += 1;
  }
  if (!done) throw new SqlExportError("the export ended before its last part");
  return { parts: count };
}
