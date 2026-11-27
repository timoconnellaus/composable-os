// A database out as SQL and back in (stage 66 step 2, ADR 0614): what `cos client export` and
// `cos client import` call (step 7), for a move between hosts and for the leaving promise (stage 46,
// decisions 17 and 22). It works over any `D1Database`, so the same code exports a client's
// database (`clientDatabase`) or a D1 database, and imports into either: a client exported from
// the host installs on D1 in its own account, and a D1 deployment moves onto the host.
//
// The export is a list of parts, each a list of plain SQL statements with no parameters, each
// under SQLite's and D1's 100 KB a statement, so a part runs on D1, on a client's database, or in
// the `sqlite3` shell (`partToSql`). It is taken in bounded parts (`exportPart`, a cursor between
// calls), so a large database never crosses one call or fills a Worker's memory. What it carries,
// exactly:
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
// - Indexes, views and triggers after the rows, in the order they were made, so no trigger fires
//   while the rows go in; then FTS5 tables are filled: an external-content index rebuilt from its
//   content (a table or a view), an index with its own content given its rows. Their shadow
//   tables are not copied (SQLite refuses writes to them); a contentless FTS5 table, or another
//   virtual table, is refused at export.
//
// **The database is held still for the whole export** (review of #511, S3). A client's database
// is held by the object itself (`clientDbHold`: every set that may write is refused until the
// export ends, and the export fails if the hold ever lapsed); a database the caller holds still
// itself (a single-client deployment's D1, paused by the operator's command) is exported with
// `hold: "caller-paused"`. The schema is fingerprinted at the first part and every part checks it.
//
// **An import trusts nothing in the file** (S5). Each statement must be one of the shapes
// `exportPart` writes (CREATEs only as the first part declared them; INSERTs and keyed UPDATEs
// of literals; the scratch table; `sqlite_sequence`; an FTS5 rebuild), and after the last part
// the whole schema is compared with what the importing code says it should be
// (`options.expectedSchema`: for core objects, `migrationsSchema()`, the code's own migrations
// applied to an empty database; for extension objects, what the reconciler derives from the
// manifests the import brought). Any difference, or a row count that differs from the export's
// (checked inside the last part's transaction), empties the database and refuses the import.
//
// Not carried: the object's own storage (`_cf_*`: its key-value records, alarms), `sqlite_stat*`
// (ANALYZE's statistics, rebuilt by SQLite), and the runner's record of its last shipped install
// (`core_meta`, `HOST_ONLY_META`): it vouches for packs' code in this host's workspace object,
// which an export does not carry (issue #558). An import deletes it too, for an older export.
//
// An import into a database that holds any table is refused. It is resumable: each part is one
// transaction that also records the next part due (`_cos_import`), so after a failure the same
// parts are given again and those already in are skipped; an import whose last part is in but
// whose verification did not finish is finished by giving the last part again.
import { applyMigrations, type Migration } from "./migrate.ts";

/** `core_meta` keys that hold for this host only: never exported, deleted by an import. */
export const HOST_ONLY_META = ["shipped_install"] as const;

const hostOnlyMeta = `key NOT IN (${HOST_ONLY_META.map((k) => `'${k}'`).join(", ")})`;

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
const CHECK_TABLE = "_cos_import_check";

/** What the first part says about the export. */
export interface ExportSource {
  exportedAt: string;
  schemaVersion: number | null;
  tables: number;
  /** Every CREATE the export runs, in order: the import runs no other. */
  schema: string[];
  /** The core migrations the exported database had (`core_migrations`), by name. */
  migrations: string[];
}

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
  source?: ExportSource;
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
  /** The schema's fingerprint at the first part: a part refuses a schema that changed. */
  schema: string;
  /** The hold's token, or null when the caller holds the database still. */
  hold: string | null;
}

type Stage = "schema" | "rows" | "fixups" | "sequence" | "objects" | "rebuild" | "done";

/**
 * Holds a database still for an export (S3): `begin` before the first part, `renew` at each
 * part's start and end (it throws when the hold lapsed at any moment since `begin`: writes may
 * have been taken), `end` after the last.
 */
export interface ExportHold {
  begin(): Promise<string>;
  renew(token: string): Promise<void>;
  end(token: string): Promise<void>;
}

export interface ExportOptions {
  maxBytes?: number;
  /**
   * What holds the database still: `clientDbHold(namespace, client)` for a client's database, or
   * `"caller-paused"` when the caller guarantees nothing writes (a single-client deployment's
   * D1, paused by the operator's command, which this code cannot hold itself).
   */
  hold: ExportHold | "caller-paused";
}

/** Refused: the export cannot be taken, or an import cannot be applied, and why. */
export class SqlExportError extends Error {
  override name = "SqlExportError";
}

/** A row of `sqlite_master`, as the schema is compared. */
export interface SchemaRow {
  type: string;
  name: string;
  tbl_name: string;
  sql: string | null;
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
  /** The rowid's name (written bare, never quoted) for a rowid table; null WITHOUT ROWID. */
  rowid: string | null;
  /** Columns inserted as NULL and set after all the table's rows (a foreign key to itself or later). */
  deferred: string[];
  kind: "table" | "fts5-content";
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
  /** A hash of the whole schema. */
  fingerprint: string;
}

/** An identifier as SQL. */
export function ident(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

/** A column of `table` as SQL: its rowid bare (a quoted "rowid" can fall back to a string). */
const ref = (table: TablePlan, column: string) => (column === table.rowid ? column : ident(column));

const FTS5_SHADOWS = ["data", "idx", "content", "docsize", "config"];

/** Names the export never carries: SQLite's, Cloudflare's, and the import's own. */
function internal(name: string): boolean {
  return /^(sqlite_|_cf_|_cos_)/i.test(name);
}

const quoteList = (names: string[]) => names.map((n) => `'${n.replaceAll("'", "''")}'`).join(", ");

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

async function readPlan(db: D1Database): Promise<Plan> {
  const { results: master } = await db
    .prepare("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY rowid")
    .all<SchemaRow>();
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

  // Every table's columns and foreign keys, and which have no rowid, in three queries.
  const names = dataTables.map(({ row }) => row.name);
  const columns = new Map<string, Column[]>();
  const parents = new Map<string, { table: string; from: string }[]>();
  const withoutRowid = new Set<string>();
  if (names.length > 0) {
    const list = quoteList(names);
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
    // WITHOUT ROWID from SQLite itself, never from the CREATE text (a trailing comment fools that).
    const { results: wr } = await db
      .prepare(
        `SELECT name FROM pragma_table_list WHERE schema = 'main' AND wr = 1 AND name IN (${list})`,
      )
      .all<{ name: string }>();
    for (const row of wr) withoutRowid.add(row.name);
    if (ordinary.length > 0) {
      const { results: fks } = await db
        .prepare(
          `SELECT m.name AS t, f."table" AS parent, f."from" AS col
           FROM sqlite_master m JOIN pragma_foreign_key_list(m.name) f
           WHERE m.type = 'table' AND m.name IN (${quoteList(ordinary.map((r) => r.name))})`,
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

  const kinds = new Map(dataTables.map(({ row, kind }) => [row.name, kind]));
  const tables = order.map((name): TablePlan => {
    const kind = kinds.get(name) as TablePlan["kind"];
    const cols = columns.get(name) ?? [];
    let key: string[];
    let rowid: string | null = null;
    if (withoutRowid.has(name)) {
      key = cols
        .filter((c) => c.pk > 0)
        .sort((a, b) => a.pk - b.pk)
        .map((c) => c.name);
    } else {
      const taken = new Set(cols.map((c) => lower(c.name)));
      rowid = ["rowid", "_rowid_", "oid"].find((n) => !taken.has(n)) ?? null;
      if (!rowid) throw new SqlExportError(`${name} has columns named rowid, _rowid_ and oid`);
      key = [rowid];
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
    return { name, columns: cols, key, rowid, deferred, kind };
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
    fingerprint: await sha256(
      JSON.stringify(master.map((row) => [row.type, row.name, row.tbl_name, row.sql])),
    ),
  };
}

// --- Values as SQL ---------------------------------------------------------------------------------

/** A value, encoded in SQL so that nothing is lost on the way: text as hex, else quote(). */
function encode(c: string): string {
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
  const head = `INSERT INTO ${ident(table)} (${columns.join(", ")}) VALUES (`;
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
    return [...before, `${head}${sql.join(", ")})`, `DELETE FROM ${ident(SCRATCH_TABLE)}`];
  }
  return [`${head}${sql.join(", ")})`];
}

/** The literal of a key value: text by its bytes, so a key of any bytes is matched exactly. */
function keyLiteral(encoded: string): string {
  return encoded.startsWith("T") ? castText(encoded.slice(1)) : encoded;
}

const keyTuple = (table: TablePlan) =>
  table.key.length === 1
    ? ref(table, table.key[0] as string)
    : `(${table.key.map((k) => ref(table, k)).join(", ")})`;
const valueTuple = (values: string[]) =>
  values.length === 1 ? (values[0] as string) : `(${values.join(", ")})`;

// --- Holding still ---------------------------------------------------------------------------------

/** What a client's database answers a hold with (`ClientDb.hold`, `renewHold`, `release`). */
interface HoldingStub {
  hold(ms?: number): Promise<{ ok: true; token: string } | { ok: false; error: string }>;
  renewHold(token: string, ms?: number): Promise<{ ok: true } | { ok: false; error: string }>;
  release(token: string): Promise<{ ok: boolean }>;
}

/** Holds a client's database still for an export, through its object (the operator's binding). */
export function clientDbHold(
  namespace: DurableObjectNamespace,
  client: string,
  ms?: number,
): ExportHold {
  const stub = () => namespace.get(namespace.idFromName(client)) as unknown as HoldingStub;
  return {
    async begin() {
      const hold = await stub().hold(ms);
      if (!hold.ok) throw new SqlExportError(`the database could not be held still: ${hold.error}`);
      return hold.token;
    },
    async renew(token) {
      const renewed = await stub().renewHold(token, ms);
      if (!renewed.ok) throw new SqlExportError(`the export was refused: ${renewed.error}`);
    },
    async end(token) {
      await stub().release(token);
    },
  };
}

// --- Export ----------------------------------------------------------------------------------------

/**
 * The next part of an export of `db`: the first when `cursor` is null. Returns the part and the
 * cursor for the one after it, null after the last. Each call reads at most about `maxBytes` of
 * SQL from the database, a page at a time, with the database held still throughout.
 */
export async function exportPart(
  db: D1Database,
  cursor: ExportCursor | null,
  options: ExportOptions,
): Promise<{ part: ExportPart; next: ExportCursor | null }> {
  const maxBytes = options.maxBytes ?? DEFAULT_PART_BYTES;
  const hold = options.hold === "caller-paused" ? null : options.hold;
  if (!hold && options.hold !== "caller-paused") {
    throw new SqlExportError('an export needs a hold: clientDbHold(...) or "caller-paused"');
  }
  let at: ExportCursor;
  if (cursor) {
    if (cursor.format !== EXPORT_FORMAT)
      throw new SqlExportError(`not a cursor of ${EXPORT_FORMAT}`);
    at = structuredClone(cursor);
    if (hold) {
      if (!at.hold) throw new SqlExportError("this export was begun without a hold");
      await hold.renew(at.hold);
    }
  } else {
    at = {
      format: EXPORT_FORMAT,
      id: crypto.randomUUID(),
      index: 0,
      stage: "schema",
      table: 0,
      after: null,
      counts: {},
      schema: "",
      hold: hold ? await hold.begin() : null,
    };
  }
  const plan = await readPlan(db);
  if (cursor && plan.fingerprint !== at.schema) {
    throw new SqlExportError("the schema changed during the export; it must start again");
  }
  at.schema = plan.fingerprint;
  const statements: string[] = [];
  let bytes = 0;
  const push = (...sql: string[]) => {
    for (const s of sql) {
      statements.push(s);
      bytes += sizeOf(s);
    }
  };
  const full = () => bytes >= maxBytes || statements.length >= MAX_PART_STATEMENTS;
  let source: ExportSource | undefined;

  if (at.stage === "schema") {
    let schemaVersion: number | null = null;
    let migrations: string[] = [];
    try {
      const row = await db
        .prepare("SELECT value FROM core_meta WHERE key = 'schema_version'")
        .first<{ value: string }>();
      schemaVersion = row ? Number(row.value) : null;
      const { results } = await db
        .prepare("SELECT name FROM core_migrations ORDER BY id")
        .all<{ name: string }>();
      migrations = results.map((r) => r.name);
    } catch {
      // Not a host's database: no version to report.
    }
    source = {
      exportedAt: new Date().toISOString(),
      schemaVersion,
      tables: plan.tables.length,
      schema: [...plan.creates, ...plan.objects],
      migrations,
    };
    push(SCRATCH_CREATE);
    push(...plan.creates);
    at.stage = "rows";
    at.table = 0;
    at.after = null;
  }

  while (!full() && at.stage !== "done") {
    if (at.stage === "rows" || at.stage === "fixups") {
      const table = plan.tables[at.table];
      if (!table) {
        at.stage = at.stage === "rows" ? "fixups" : "sequence";
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
        ? await fixupPage(db, table, at, push)
        : await rowsPage(db, table, at, maxBytes - bytes, push);
      if (done) {
        at.table += 1;
        at.after = null;
      }
      continue;
    }
    if (at.stage === "sequence") {
      if (plan.hasSequence) {
        const { results } = await db
          .prepare(`SELECT ${encode("name")} AS name, quote(seq) AS seq FROM sqlite_sequence`)
          .all<{ name: string; seq: string }>();
        push(SEQUENCE_DELETE);
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
      push(...plan.objects);
      at.stage = "rebuild";
      continue;
    }
    if (at.stage === "rebuild") {
      // After the views, so an index whose content is a view finds it.
      for (const name of plan.rebuilds) {
        push(`INSERT INTO ${ident(name)} (${ident(name)}) VALUES ('rebuild')`);
      }
      push(SCRATCH_DROP);
      at.stage = "done";
    }
  }

  // The hold covered every read of this part.
  if (hold && at.hold) await hold.renew(at.hold);
  const last = at.stage === "done";
  if (last && hold && at.hold) await hold.end(at.hold);
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

const SCRATCH_CREATE = `CREATE TABLE IF NOT EXISTS ${ident(SCRATCH_TABLE)} (k INTEGER PRIMARY KEY, v)`;
const SCRATCH_DROP = `DROP TABLE IF EXISTS ${ident(SCRATCH_TABLE)}`;
const SCRATCH_CLEAR = `DELETE FROM ${ident(SCRATCH_TABLE)}`;
const SEQUENCE_DELETE = "DELETE FROM sqlite_sequence";

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
  const conditions = [
    ...(at.after ? [`${keyTuple(table)} > ${valueTuple(at.after)}`] : []),
    ...(table.name === "core_meta" ? [hostOnlyMeta] : []),
  ];
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const order = key.map((k) => ref(table, k)).join(", ");
  const keys = key.map((k, i) => `${encode(ref(table, k))} AS k${i}`).join(", ");
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
  const values = table.columns.map((c, i) => `${encode(ident(c.name))} AS v${i}`).join(", ");
  const range = `${where ? `${where} AND` : "WHERE"} ${keyTuple(table)} <= ${valueTuple(upTo)}`;
  const { results } = await db
    .prepare(
      `SELECT ${keys}${values ? `, ${values}` : ""} FROM ${ident(table.name)} ${range} ORDER BY ${order}`,
    )
    .all<Record<string, string>>();
  const names = [...(table.rowid ? [table.rowid] : []), ...table.columns.map((c) => ident(c.name))];
  const deferred = new Set(table.deferred);
  for (const row of results) {
    const rowid = table.rowid ? [literal(row.k0 as string)] : [];
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
  push: (...sql: string[]) => void,
): Promise<boolean> {
  const { key } = table;
  const order = key.map((k) => ref(table, k)).join(", ");
  const keys = key.map((k, i) => `${encode(ref(table, k))} AS k${i}`).join(", ");
  const values = table.deferred.map((c, i) => `${encode(ident(c))} AS v${i}`).join(", ");
  const set = table.deferred.map((c) => `${ident(c)} IS NOT NULL`).join(" OR ");
  const where = `WHERE (${set})${at.after ? ` AND ${keyTuple(table)} > ${valueTuple(at.after)}` : ""}`;
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
      .map((k, i) => `${ref(table, k)} = ${keyLiteral(row[`k${i}`] as string)}`)
      .join(" AND ");
    push(`UPDATE ${ident(table.name)} SET ${assignments} WHERE ${match}`);
  }
  const lastRow = results.at(-1);
  if (lastRow) at.after = key.map((_, i) => keyLiteral(lastRow[`k${i}`] as string));
  return results.length < PAGE_ROWS;
}

/** Every part of an export of `db`, in order; the hold is released if the export stops. */
export async function* exportDatabase(
  db: D1Database,
  options: ExportOptions,
): AsyncGenerator<ExportPart> {
  let cursor: ExportCursor | null = null;
  let done = false;
  try {
    do {
      const { part, next }: { part: ExportPart; next: ExportCursor | null } = await exportPart(
        db,
        cursor,
        options,
      );
      cursor = next;
      if (!next) done = true;
      yield part;
    } while (cursor);
  } finally {
    if (!done && cursor?.hold && options.hold !== "caller-paused") {
      await options.hold.end(cursor.hold).catch(() => {});
    }
  }
}

/** A part as a `.sql` text, for the `sqlite3` shell or a person to read. */
export function partToSql(part: ExportPart): string {
  return `-- ${part.format} ${part.id} part ${part.index}${part.last ? " (last)" : ""}\n${part.statements
    .map((s) => `${s};`)
    .join("\n")}\n`;
}

// --- What an import accepts ------------------------------------------------------------------------

/** A scanner over one statement, for the shapes `exportPart` writes and nothing else. */
class Scan {
  i = 0;
  constructor(readonly s: string) {}

  done(): boolean {
    return this.i === this.s.length;
  }

  /** Consumes `text` exactly, or fails. */
  word(text: string): boolean {
    if (this.s.startsWith(text, this.i)) {
      this.i += text.length;
      return true;
    }
    return false;
  }

  /** Consumes a match of the sticky `pattern` here, or fails. */
  pattern(pattern: RegExp): boolean {
    pattern.lastIndex = this.i;
    if (!pattern.test(this.s)) return false;
    this.i = pattern.lastIndex;
    return true;
  }

  /** A quoted identifier, or (with `bare`) the rowid's bare names. Returns the name. */
  ident(bare = false): string | null {
    if (this.s[this.i] === '"') {
      let j = this.i + 1;
      let name = "";
      for (;;) {
        const k = this.s.indexOf('"', j);
        if (k < 0) return null;
        name += this.s.slice(j, k);
        if (this.s[k + 1] === '"') {
          name += '"';
          j = k + 2;
          continue;
        }
        this.i = k + 1;
        return name.length > 0 ? name : null;
      }
    }
    if (bare) {
      for (const name of ["_rowid_", "rowid", "oid"]) {
        if (this.s.startsWith(name, this.i) && !/[\w"]/.test(this.s[this.i + name.length] ?? "")) {
          this.i += name.length;
          return name;
        }
      }
    }
    return null;
  }

  /** A literal as `literal()` writes it: NULL, a number, text, bytes, or bytes cast to text. */
  literal(): boolean {
    const s = this.s;
    if (this.word("NULL")) return true;
    const number = /-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/iy;
    number.lastIndex = this.i;
    if (number.test(s)) {
      this.i = number.lastIndex;
      return true;
    }
    if (s[this.i] === "'") {
      let j = this.i + 1;
      for (;;) {
        const k = s.indexOf("'", j);
        if (k < 0) return false;
        if (s[k + 1] === "'") {
          j = k + 2;
          continue;
        }
        this.i = k + 1;
        return true;
      }
    }
    const hex = /X'[0-9A-Fa-f]*'/y;
    const cast = /CAST\(X'[0-9A-Fa-f]*' AS TEXT\)/y;
    for (const pattern of [hex, cast]) {
      pattern.lastIndex = this.i;
      if (pattern.test(s)) {
        this.i = pattern.lastIndex;
        return true;
      }
    }
    return false;
  }

  /** A literal, or a value built in the scratch table. */
  value(): boolean {
    if (this.literal()) return true;
    const scratch = new RegExp(
      `\\(SELECT (?:v|CAST\\(v AS BLOB\\)) FROM ${ident(SCRATCH_TABLE).replaceAll('"', '\\"')} WHERE k = \\d+\\)`,
      "y",
    );
    scratch.lastIndex = this.i;
    if (scratch.test(this.s)) {
      this.i = scratch.lastIndex;
      return true;
    }
    return false;
  }

  /** `item (", " item)*`, counting the items. */
  list(item: () => boolean): number | null {
    let n = 0;
    do {
      if (!item()) return null;
      n += 1;
    } while (this.word(", "));
    return n;
  }
}

const SCRATCH = ident(SCRATCH_TABLE);

/**
 * Why `sql` is not a statement an export writes, or null when it is one. `declared` is every CREATE
 * the export's first part said it runs.
 */
export function statementProblem(sql: string, declared: ReadonlySet<string>): string | null {
  if (typeof sql !== "string") return "a statement is not text";
  if ([SCRATCH_CREATE, SCRATCH_DROP, SCRATCH_CLEAR, SEQUENCE_DELETE].includes(sql)) return null;
  if (/^\s*CREATE\b/i.test(sql)) {
    return declared.has(sql) ? null : "a CREATE the export's first part did not declare";
  }
  const scan = new Scan(sql);
  const at = () => `at ${scan.i}`;
  if (scan.word(`INSERT INTO ${SCRATCH} (k, v) VALUES (`)) {
    return scan.pattern(/\d+, /y) && scan.literal() && scan.word(")") && scan.done()
      ? null
      : `not the scratch table's insert (${at()})`;
  }
  if (scan.word(`UPDATE ${SCRATCH} SET v = v || `)) {
    return scan.literal() && scan.pattern(/ WHERE k = \d+/y) && scan.done()
      ? null
      : `not the scratch table's append (${at()})`;
  }
  if (scan.word("INSERT INTO sqlite_sequence (name, seq) VALUES (")) {
    return scan.literal() && scan.pattern(/, -?\d+\)/y) && scan.done()
      ? null
      : `not a sqlite_sequence row (${at()})`;
  }
  if (scan.word("INSERT INTO ")) {
    const table = scan.ident();
    if (!table || internal(table)) return "an INSERT into a table an export does not write";
    if (!scan.word(" (")) return `not an export's INSERT (${at()})`;
    // The rebuild of an FTS5 index: its own name as its only column.
    const rest = sql.slice(scan.i);
    if (rest === `${ident(table)}) VALUES ('rebuild')`) return null;
    const columns = scan.list(() => scan.ident(true) !== null);
    if (columns === null || !scan.word(") VALUES (")) return `not an export's INSERT (${at()})`;
    const values = scan.list(() => scan.value());
    if (values === null || !scan.word(")") || !scan.done()) {
      return `an INSERT whose values are not literals (${at()})`;
    }
    return values === columns ? null : "an INSERT with more or fewer values than columns";
  }
  if (scan.word("UPDATE ")) {
    const table = scan.ident();
    if (!table || internal(table)) return "an UPDATE of a table an export does not write";
    if (!scan.word(" SET ")) return `not an export's UPDATE (${at()})`;
    const sets = scan.list(() => scan.ident() !== null && scan.word(" = ") && scan.literal());
    if (sets === null || !scan.word(" WHERE ")) return `not an export's UPDATE (${at()})`;
    do {
      if (!(scan.ident(true) !== null && scan.word(" = ") && scan.literal())) {
        return `an UPDATE not matched by its key (${at()})`;
      }
    } while (scan.word(" AND "));
    return scan.done() ? null : `an UPDATE not matched by its key (${at()})`;
  }
  return "not a statement an export writes";
}

/** Why `part` is not a part of an export, or null (its fields' types: review of #511, M4). */
export function partProblem(part: unknown): string | null {
  if (!part || typeof part !== "object") return "a part is not an object";
  const p = part as Record<string, unknown>;
  if (p.format !== EXPORT_FORMAT) return `not a part of ${EXPORT_FORMAT}`;
  if (typeof p.id !== "string" || p.id.length === 0 || p.id.length > 128)
    return "its id is not text";
  if (typeof p.index !== "number" || !Number.isSafeInteger(p.index) || p.index < 0) {
    return "its index is not a whole number from 0";
  }
  if (typeof p.last !== "boolean") return "its last is not true or false";
  if (!Array.isArray(p.statements) || !p.statements.every((s) => typeof s === "string")) {
    return "its statements are not a list of text";
  }
  if (p.last) {
    const counts = p.counts as Record<string, unknown> | undefined;
    if (!counts || typeof counts !== "object") return "the last part has no counts";
    for (const [table, n] of Object.entries(counts)) {
      if (internal(table)) return "a count of a table an export does not write";
      if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 0)
        return "a count is not a whole number";
    }
  }
  if (p.index === 0) {
    const source = p.source as Record<string, unknown> | undefined;
    if (!source || typeof source !== "object") return "the first part has no source";
    if (!Array.isArray(source.schema) || !source.schema.every((s) => typeof s === "string")) {
      return "the first part's schema is not a list of text";
    }
    if (
      !Array.isArray(source.migrations) ||
      !source.migrations.every((s) => typeof s === "string")
    ) {
      return "the first part's migrations are not a list of text";
    }
  }
  return null;
}

// --- Schemas compared --------------------------------------------------------------------------

/** The schema as the import compares it: every object but SQLite's, Cloudflare's and its own. */
export async function schemaRows(db: D1Database): Promise<SchemaRow[]> {
  const { results } = await db
    .prepare("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name")
    .all<SchemaRow>();
  return results.filter((row) => !internal(row.name) && !internal(row.tbl_name));
}

/**
 * The core schema the importing code's own migrations produce, for the migrations an export says
 * its database had (`source.migrations`): each applied in the code's order to `reference`, an
 * empty database. A name the code does not know is refused.
 */
export async function migrationsSchema(
  reference: D1Database,
  migrations: Migration[],
  names: string[],
): Promise<SchemaRow[]> {
  const known = new Map(migrations.map((m) => [m.name, m]));
  const unknown = names.filter((name) => !known.has(name));
  if (unknown.length > 0) {
    throw new SqlExportError(`the export has migrations this code does not: ${unknown.join(", ")}`);
  }
  if ((await schemaRows(reference)).length > 0) {
    throw new SqlExportError("the reference database for the expected schema is not empty");
  }
  await applyMigrations(
    reference,
    names.map((name) => known.get(name) as Migration),
  );
  return schemaRows(reference);
}

/**
 * The names a piece of SQL refers to, lowercased: every identifier outside a comment, bare or
 * quoted (`"…"`, `` `…` ``, `[…]`), with a quoted one unquoted, and the text of every
 * single-quoted string, which SQLite also takes as a name. Keywords come back
 * too; a caller compares the result with the names of objects, so a keyword never matches one.
 * A tokeniser, not a parser (review of #526, N3): it cannot be dodged by quoting, casing or a
 * comment, and it errs towards finding a name (a column named like a table counts as the table).
 */
export function namesIn(sql: string): Set<string> {
  const out = new Set<string>();
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i] as string;
    if (ch === "-" && sql[i + 1] === "-") {
      const end = sql.indexOf("\n", i);
      i = end === -1 ? sql.length : end + 1;
      continue;
    }
    if (ch === "/" && sql[i + 1] === "*") {
      const end = sql.indexOf("*/", i + 2);
      i = end === -1 ? sql.length : end + 2;
      continue;
    }
    if (ch === "'") {
      // SQLite takes a single-quoted string where a name goes (`UPDATE 'core_user' …`), so a
      // string's text counts as a name too (review of #530, R1): erring towards refusal.
      let j = i + 1;
      let text = "";
      while (j < sql.length) {
        if (sql[j] === "'" && sql[j + 1] === "'") {
          text += "'";
          j += 2;
        } else if (sql[j] === "'") break;
        else {
          text += sql[j];
          j += 1;
        }
      }
      out.add(text.toLowerCase());
      i = j + 1;
      continue;
    }
    if (ch === '"' || ch === "`" || ch === "[") {
      const close = ch === "[" ? "]" : ch;
      let j = i + 1;
      let name = "";
      while (j < sql.length) {
        if (sql[j] === close && close !== "]" && sql[j + 1] === close) {
          name += close;
          j += 2;
          continue;
        }
        if (sql[j] === close) break;
        name += sql[j];
        j += 1;
      }
      out.add(name.toLowerCase());
      i = j + 1;
      continue;
    }
    if (/[A-Za-z_\u0080-\uffff]/.test(ch)) {
      let j = i;
      while (j < sql.length && /[A-Za-z0-9_$\u0080-\uffff]/.test(sql[j] as string)) j += 1;
      out.add(sql.slice(i, j).toLowerCase());
      i = j;
      continue;
    }
    i += 1;
  }
  return out;
}

/** Name prefixes of what is never an extension's own: core tables and views, the platform's. */
const NOT_EXTENSION = /^(core_|rec_|crm_|pub_|sqlite_|_cf_|_cos_)/;

/**
 * Which objects of an imported database an import accepts as its extensions' own, beside the core
 * schema the code's migrations make (`core`): stage 66 step 7, the reviews of #526 (S4, N3). Their
 * text is the export's own (a check against what the reconciler would make from the imported
 * manifests is not built), so what is taken is narrow:
 * - a table (`x_…`), or an index of one;
 * - a trigger on an extension table, and only when every object its SQL names (`namesIn`, matched
 *   against the imported database's objects, case-insensitively) is an extension table, and it
 *   names nothing with a core or platform prefix. So no imported trigger writes, or reads, a core
 *   table. (A pack whose triggers keep a core table, such as `occupies`' claims, cannot be imported
 *   this way: the import is refused, failing closed.)
 * - no view at all: an import leaves views out (`ImportOptions.skipViews`) and the host makes them
 *   again from its own definitions after the import.
 * Never another object of a name the core schema has. Anything else is then a difference, and the
 * import is refused and the database emptied.
 */
export function importedExtensionObjects(actual: SchemaRow[], core: SchemaRow[]): SchemaRow[] {
  const coreNames = new Set(core.map((row) => row.name.toLowerCase()));
  const extensionTables = new Set(
    actual
      .filter(
        (row) => row.type === "table" && row.name.startsWith("x_") && row.tbl_name === row.name,
      )
      .map((row) => row.name.toLowerCase()),
  );
  const objects = new Set(actual.map((row) => row.name.toLowerCase()));
  /** Every name `row`'s SQL refers to is an extension table (or the row itself). */
  const namesOnlyExtension = (row: SchemaRow): boolean => {
    for (const name of namesIn(row.sql ?? "")) {
      if (NOT_EXTENSION.test(name)) return false;
      if (objects.has(name) && name !== row.name.toLowerCase() && !extensionTables.has(name)) {
        return false;
      }
    }
    return true;
  };
  return actual.filter((row) => {
    if (coreNames.has(row.name.toLowerCase())) return false;
    switch (row.type) {
      case "table":
        // No virtual table: an FTS5 table's external content reads any table it names (review
        // of #530, R2). And a table's own SQL (DEFAULT, CHECK, generated columns) names nothing
        // but extension tables.
        if (/^\s*CREATE\s+VIRTUAL\b/i.test(row.sql ?? "")) return false;
        return extensionTables.has(row.name.toLowerCase()) && namesOnlyExtension(row);
      case "index":
        // Its expressions and a partial index's WHERE, the same.
        return extensionTables.has(row.tbl_name.toLowerCase()) && namesOnlyExtension(row);
      case "trigger":
        return extensionTables.has(row.tbl_name.toLowerCase()) && namesOnlyExtension(row);
      default:
        return false;
    }
  });
}

/** Whether `sql` (one statement of a part) makes a view. */
export function isCreateView(sql: string): boolean {
  return /^\s*CREATE\s+(TEMP\s+|TEMPORARY\s+)?VIEW\b/i.test(sql);
}

/** Whether `sql` makes an `INSTEAD OF` trigger (one that runs on a write to a view). */
function isInsteadOfTrigger(sql: string): boolean {
  if (!/^\s*CREATE\s+(TEMP\s+|TEMPORARY\s+)?TRIGGER\b/i.test(sql)) return false;
  const words = [...namesIn(sql)];
  return words.includes("instead");
}

/** The names of objects in which two schemas differ (one has it, or their text differs). */
export function schemaDifferences(actual: SchemaRow[], expected: SchemaRow[]): string[] {
  const key = (row: SchemaRow) => `${row.type} ${row.name}`;
  const a = new Map(actual.map((row) => [key(row), JSON.stringify(row)]));
  const e = new Map(expected.map((row) => [key(row), JSON.stringify(row)]));
  const differ: string[] = [];
  for (const name of new Set([...a.keys(), ...e.keys()])) {
    if (a.get(name) !== e.get(name)) differ.push(name);
  }
  return differ.sort();
}

/** Drops everything an import wrote, so a refused import leaves the database empty. */
export async function emptyDatabase(db: D1Database): Promise<void> {
  const read = async () =>
    (await db.prepare("SELECT type, name, sql FROM sqlite_master").all<SchemaRow>()).results.filter(
      (row) => !/^(sqlite_|_cf_)/i.test(row.name),
    );
  const drop = async (rows: SchemaRow[]) => {
    if (rows.length === 0) return;
    await db.batch(
      [
        "PRAGMA defer_foreign_keys = ON",
        ...rows.map((row) => `DROP ${row.type.toUpperCase()} IF EXISTS ${ident(row.name)}`),
      ].map((sql) => db.prepare(sql)),
    );
  };
  let rows = await read();
  await drop(rows.filter((row) => row.type === "trigger" || row.type === "view"));
  // Virtual tables first: their shadow tables go with them.
  rows = await read();
  await drop(rows.filter((row) => /^\s*CREATE\s+VIRTUAL/i.test(row.sql ?? "")));
  // Children before their parents: SQLite resolves a dropped table's foreign keys as it goes.
  const tables = (await read()).filter((row) => row.type === "table").map((row) => row.name);
  const { results: edges } =
    tables.length > 0
      ? await db
          .prepare(
            `SELECT m.name AS child, f."table" AS parent FROM sqlite_master m
             JOIN pragma_foreign_key_list(m.name) f WHERE m.type = 'table' AND m.name IN (${quoteList(tables)})`,
          )
          .all<{ child: string; parent: string }>()
      : { results: [] };
  const order: string[] = [];
  const left = new Set(tables);
  while (left.size > 0) {
    const leaf =
      [...left].find(
        (t) =>
          !edges.some(
            (e) => e.parent.toLowerCase() === t.toLowerCase() && e.child !== t && left.has(e.child),
          ),
      ) ?? ([...left][0] as string);
    order.push(leaf);
    left.delete(leaf);
  }
  await drop(order.map((name) => ({ type: "table", name, tbl_name: name, sql: null })));
  const sequence = await db
    .prepare("SELECT name FROM sqlite_master WHERE name = 'sqlite_sequence'")
    .first();
  if (sequence) await db.prepare(SEQUENCE_DELETE).run();
}

// --- Import ----------------------------------------------------------------------------------------

/** What `importPart` did with a part. */
export interface ImportStep {
  /** False when the part was already in (a resumed import). */
  applied: boolean;
  /** True once the last part is in and the import is verified. */
  done: boolean;
}

export interface ImportOptions {
  /**
   * The whole schema (`schemaRows`' form) the importing code expects once this export is in.
   * Called after the last part, with the imported database (whose extension manifests are then
   * there) and the export's source. Core objects: `migrationsSchema()` at `source.migrations`;
   * extension objects (`x_*`, their views and indexes): what the reconciler derives from the
   * manifests, never the file's own CREATEs.
   */
  expectedSchema(db: D1Database, source: ExportSource): Promise<SchemaRow[]>;
  /**
   * Leave out every view the export makes (stage 66 step 7, review of #526 N3): the importing
   * host makes its views again from its own definitions once the import is in, so no view's text
   * comes from the file. An `INSTEAD OF` trigger (one on a view) is then refused outright.
   */
  skipViews?: boolean;
}

/** Does the database hold anything an export would carry? */
async function holdsTables(db: D1Database): Promise<string[]> {
  const { results } = await db
    .prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'view') ORDER BY name")
    .all<{ name: string }>();
  return results.map((row) => row.name).filter((name) => !/^(sqlite_|_cf_)/i.test(name));
}

interface Marker {
  id: string;
  next: number;
  source: ExportSource;
}

async function readMarker(db: D1Database): Promise<Marker | null> {
  const row = await db
    .prepare(`SELECT export_id AS id, next_part AS next, source FROM ${ident(IMPORT_TABLE)}`)
    .first<{ id: string; next: number; source: string }>();
  return row
    ? { id: row.id, next: row.next, source: JSON.parse(row.source) as ExportSource }
    : null;
}

/** Verifies the imported schema; on any difference empties the database and refuses. */
async function finish(db: D1Database, source: ExportSource, options: ImportOptions): Promise<void> {
  const actual = await schemaRows(db);
  let expected: SchemaRow[];
  try {
    expected = await options.expectedSchema(db, source);
  } catch (error) {
    await emptyDatabase(db);
    throw new SqlExportError(
      `the import was refused and the database emptied: its expected schema could not be made (${(error as Error).message})`,
    );
  }
  const differ = schemaDifferences(actual, expected);
  if (differ.length > 0) {
    await emptyDatabase(db);
    throw new SqlExportError(
      `the import was refused and the database emptied: its schema is not what this code makes (${differ.slice(0, 10).join("; ")}${differ.length > 10 ? `; and ${differ.length - 10} more` : ""})`,
    );
  }
  // An older export may carry the host-only records: they vouch for another host's objects.
  if (actual.some((row) => row.type === "table" && row.name === "core_meta")) {
    await db.prepare(`DELETE FROM core_meta WHERE NOT (${hostOnlyMeta})`).run();
  }
  await db.prepare(`DROP TABLE ${ident(IMPORT_TABLE)}`).run();
}

/**
 * Imports one part of an export into `db`, in one transaction. Part 0 needs a database that holds
 * no table; a later part needs the one before it in, and a part already in is skipped. Every
 * statement must be one an export writes. The last part checks every table's row count in its own
 * transaction; then the whole schema is compared with `options.expectedSchema`, and the import's
 * own table is dropped. A refused verification empties the database.
 */
export async function importPart(
  db: D1Database,
  part: ExportPart,
  options: ImportOptions,
): Promise<ImportStep> {
  const problem = partProblem(part);
  if (problem) throw new SqlExportError(`not a part of an export: ${problem}`);
  const tables = await holdsTables(db);
  let marker: Marker | null = null;
  if (tables.includes(IMPORT_TABLE)) {
    marker = await readMarker(db);
    if (!marker || marker.id !== part.id) {
      throw new SqlExportError(
        "an earlier import of another export did not finish here; empty the database and import again",
      );
    }
    if (part.index < marker.next) {
      // The last part is in but its verification did not finish: finish it now.
      if (part.last && marker.next === part.index + 1) {
        await finish(db, marker.source, options);
        return { applied: false, done: true };
      }
      return { applied: false, done: false };
    }
    if (part.index > marker.next) {
      throw new SqlExportError(`part ${marker.next} is missing before part ${part.index}`);
    }
  } else if (tables.length > 0) {
    throw new SqlExportError(
      `the database is not empty (it holds ${tables.length} tables or views, such as ${tables[0]}); an import goes only into an empty one`,
    );
  } else if (part.index !== 0) {
    throw new SqlExportError(`an import starts with part 0, not part ${part.index}`);
  }
  const source = (marker?.source ?? part.source) as ExportSource;
  const declared = new Set(source.schema);
  const statements = options.skipViews
    ? part.statements.filter((sql) => !isCreateView(sql))
    : part.statements;
  if (options.skipViews && statements.some(isInsteadOfTrigger)) {
    await emptyDatabase(db);
    throw new SqlExportError(
      "the import was refused and the database emptied: it makes a trigger on a view (INSTEAD OF)",
    );
  }
  for (const sql of statements) {
    const wrong = statementProblem(sql, declared);
    if (wrong) {
      throw new SqlExportError(
        `part ${part.index} holds a statement an export does not write (${wrong}): ${sql.slice(0, 120)}`,
      );
    }
  }

  // The import's own record; the source (the declared schema) is bound, not written into SQL.
  const record: D1PreparedStatement[] =
    part.index === 0
      ? [
          db.prepare(
            `CREATE TABLE ${ident(IMPORT_TABLE)} (export_id TEXT NOT NULL, next_part INTEGER NOT NULL, source TEXT NOT NULL)`,
          ),
          db
            .prepare(`INSERT INTO ${ident(IMPORT_TABLE)} VALUES (?, 1, ?)`)
            .bind(part.id, JSON.stringify(part.source)),
        ]
      : [db.prepare(`UPDATE ${ident(IMPORT_TABLE)} SET next_part = ?`).bind(part.index + 1)];
  // The last part's row counts, checked in its own transaction: a mismatch rolls the part back.
  const check = part.last
    ? [
        `CREATE TABLE ${ident(CHECK_TABLE)} (t TEXT NOT NULL, ok INTEGER NOT NULL CHECK (ok = 1))`,
        ...Object.entries(part.counts ?? {}).map(
          ([table, n]) =>
            `INSERT INTO ${ident(CHECK_TABLE)} VALUES (${textLiteral(table)}, (SELECT count(*) FROM ${ident(table)}) = ${n})`,
        ),
        `DROP TABLE ${ident(CHECK_TABLE)}`,
      ]
    : [];
  try {
    await db.batch([
      ...["PRAGMA defer_foreign_keys = ON", ...statements, ...check].map((sql) => db.prepare(sql)),
      ...record,
    ]);
  } catch (error) {
    const committed = (error as { committed?: unknown }).committed === true;
    if (!committed) {
      if (part.last && /CHECK constraint failed/.test((error as Error).message)) {
        await emptyDatabase(db);
        throw new SqlExportError(
          "the import was refused and the database emptied: its row counts do not match the export's",
        );
      }
      throw error;
    }
    // Committed, its answer lost: carry on as applied.
  }
  if (!part.last) return { applied: true, done: false };
  await finish(db, source, options);
  return { applied: true, done: true };
}

/** Imports every part, in order; resumes an unfinished import of the same export. */
export async function importDatabase(
  db: D1Database,
  parts: AsyncIterable<ExportPart> | Iterable<ExportPart>,
  options: ImportOptions,
): Promise<{ parts: number }> {
  let count = 0;
  let done = false;
  for await (const part of parts) {
    ({ done } = await importPart(db, part, options));
    count += 1;
  }
  if (!done) throw new SqlExportError("the export ended before its last part");
  return { parts: count };
}
