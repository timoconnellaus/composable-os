// A client's database (stage 66, ADRs 0612 and 0614): a Durable Object with SQLite storage, one
// object per client, behind the `D1Database` interface the host's code already uses. `ClientDb` is
// the object; `clientDatabase()` returns something that stands where a D1 binding stands and sends
// each call to that client's object, with D1's result shape, error text and value conversions
// (the binding's own code, `cloudflare-internal:d1-api`, and the local D1 object it talks to were
// the reference). What differs from D1, and why, is the table in ADR 0612.
//
// Every query set a call sends (one statement, a batch, or `exec`'s lines) runs in one
// transaction inside the object, as D1 runs it: all apply or none do. A set is never committed
// unless its answer can be returned (ADR 0614): an answer too large for one Workers RPC call is
// held by the object and fetched in parts, and one too large to hold rolls the set back. Every set
// that wrote is recorded under its id, so a caller whose answer was lost can ask whether it
// committed instead of sending it again.
//
// Step 2 also gave the object: migrations with a report (`migrateAndReport`, `level`), bookmarks
// and restore (`bookmark`, `bookmarkAt`, `restore`, `restart`, `restoreClientDb`), its size against
// the storage limit (`usage`, a clear refusal before the limit), and where it was first placed
// (`place`). Export and import as SQL are in `sql-export.ts`, over any `D1Database`.
import { DurableObject } from "cloudflare:workers";
import type { ClientDbQueryService, ClientDbTarget } from "./client-db-service.ts";
import { isReadOnlySql } from "./handle.ts";
import {
  applyMigrations,
  getMigrationLevel,
  type Migration,
  type MigrationLevel,
} from "./migrate.ts";

/** A value on its way to or from the object: what D1's binding sends, with bytes as a buffer. */
export type ClientDbValue = string | number | null | ArrayBuffer;

export interface ClientDbQuery {
  sql: string;
  params: ClientDbValue[];
}

/** One statement's result, in D1's rows-and-columns form. */
export interface ClientDbResult {
  columns: string[];
  rows: ClientDbValue[][];
  meta: ClientDbMeta;
}

/** The meta D1 reports for a statement, as the local D1 object fills it. */
export interface ClientDbMeta {
  served_by: string;
  served_by_primary: boolean;
  total_attempts: number;
  timings: { sql_duration_ms: number };
  duration: number;
  changes: number;
  last_row_id: number;
  changed_db: boolean;
  size_after: number;
  rows_read: number;
  rows_written: number;
}

/**
 * A statement's meta as it crosses RPC: the numbers only, in this order. The constant parts
 * (`served_by` and the rest) are filled in on the binding's side. A full meta object is about 244
 * bytes on the wire; this is about 40, so a batch of many statements stays well inside a call.
 */
export type PackedMeta = [
  duration: number,
  changes: number,
  lastRowId: number,
  changedDb: 0 | 1,
  sizeAfter: number,
  rowsRead: number,
  rowsWritten: number,
];

/**
 * Part of one statement's result: the statement's index in the set, its columns and meta (on its
 * first piece only, null on later ones), and some of its rows. A result too large for one part is
 * cut between rows into several pieces.
 */
export type ClientDbPiece = [
  statement: number,
  columns: string[] | null,
  meta: PackedMeta | null,
  rows: ClientDbValue[][],
];

/**
 * What the object answers a query set with: D1's answer, a failure as data (not thrown). When the
 * answer is larger than one part, `pieces` is its first part and `held` names the rest, which the
 * object holds for `HELD_TTL_MS` and gives out with `take`. A failure means nothing was applied.
 */
export type ClientDbAnswer =
  | {
      ok: true;
      statements: number;
      pieces: ClientDbPiece[];
      held: { id: string; parts: number } | null;
    }
  | { ok: false; error: string };

/** One part of a held answer, or why it is gone. */
export type ClientDbAnswerPart =
  | { ok: true; pieces: ClientDbPiece[] }
  | { ok: false; error: string };

/** Whether a query set sent with an id committed (`outcome`). */
export interface ClientDbOutcome {
  /** True when a set with this id wrote and committed. */
  committed: boolean;
  /** Its answer's parts, while the object still holds them. */
  held: number | null;
}

/** What a client's database reports itself as, where D1 says `miniflare.db` or its region. */
export const CLIENT_DB_SERVED_BY = "cos-client-db";

/**
 * The most a part of a request or an answer carries, by the estimate below: well inside Workers
 * RPC's 32 MiB a call.
 */
export const PART_BYTES = 8 * 1024 * 1024;

/**
 * The largest answer a query set may have. Above it the set is refused and, if it wrote, rolled
 * back: D1 returns larger results, but an object holding more than this for a caller to fetch
 * risks its 128 MB of memory. A read that large is read in pages (`LIMIT`), as an export is.
 */
export const MAX_ANSWER_BYTES = 48 * 1024 * 1024;

/** The most the object holds at once for callers: staged request parts and held answers. */
export const MAX_HELD_BYTES = 64 * 1024 * 1024;

/**
 * How long the object keeps the parts of a batch sent in parts, or of an answer held for its
 * caller, before forgetting them. They are sent or fetched one after another within one call of
 * `batch`, so a minute is far more than enough; a batch whose commit never comes is dropped
 * unapplied.
 */
export const HELD_TTL_MS = 60_000;

/** How long a query set's outcome is kept, for a caller to ask whether it committed. */
export const OUTCOME_TTL_MS = 60 * 60 * 1000;

/** At most this many expired outcome records are dropped by one sweep. */
export const OUTCOME_SWEEP_BATCH = 256;

/**
 * A Durable Object's SQLite storage limit on the Workers Paid plan: 10 GB (Cloudflare's Durable
 * Objects limits, 2026-11). Writes past it fail with `SQLITE_FULL`; reads and deletes still work.
 */
export const STORAGE_LIMIT_BYTES = 10_000_000_000;

/** Where the object refuses a write that grows it, before the platform's opaque failure. */
export const DEFAULT_REFUSE_AT_BYTES = 9_500_000_000;

/** Where usage reports a client's database as near its limit. */
export const DEFAULT_WARN_AT_BYTES = 8_000_000_000;

/** How full a client's database is (`ClientDb.usage`), for usage reports and the operator. */
export interface ClientDbUsage {
  bytes: number;
  limitBytes: number;
  warnAtBytes: number;
  refuseAtBytes: number;
  /** Above `refuseAtBytes`, the room small sets (an erase, a delete) may still use. */
  reserveBytes: number;
  /** `ok`, `warning` past `warnAtBytes`, `refusing` past `refuseAtBytes` (writes that grow it). */
  state: "ok" | "warning" | "refusing";
}

/** What `migrateAndReport` did: what it applied, the migration that failed, the level after. */
export interface MigrationReport {
  applied: string[];
  /** The migration that failed, rolled back whole; the ones before it stay applied. */
  failed: { name: string; error: string } | null;
  level: MigrationLevel;
}

/** Where the object was first reached from, and what a later caller asked for (`place`). */
export interface ClientDbPlace {
  /** The hint passed the first time `place` was called, null when none was. */
  locationHint: string | null;
  /** When that was. */
  at: number;
  /** True when this call recorded it. */
  first: boolean;
  /** True when this call passed a different hint, which Cloudflare ignores. */
  differs: boolean;
}

/** A statement that is only blank lines and comments, which D1 leaves out of a query set. */
function isEmptyStatement(sql: string): boolean {
  // The local D1 object's own test, character for character: a comment counts only when
  // whitespace comes before it on its line.
  return sql.replace(/^\s+--.*/gm, "").trim().length === 0;
}

/** A refusal raised inside a transaction, so that it rolls back, with its own message. */
class Refusal extends Error {}

/** A character past U+00FF: V8 then writes the string two bytes a character. */
const NOT_ONE_BYTE = /[Ā-￿]/;

/**
 * A value's size on the wire, as Workers RPC (V8's serializer) writes it: a string of one-byte
 * characters one byte each, any other two; bytes as they are; a number nine.
 */
function valueBytes(value: ClientDbValue): number {
  if (typeof value === "string") {
    return (NOT_ONE_BYTE.test(value) ? 2 * value.length : value.length) + 8;
  }
  if (value instanceof ArrayBuffer) return value.byteLength + 8;
  return 9;
}

function queryBytes(query: ClientDbQuery): number {
  let bytes = 2 * query.sql.length + 16;
  for (const param of query.params) bytes += valueBytes(param);
  return bytes;
}

/** `queries` in order, cut into parts of at most PART_BYTES each (a part holds one at least). */
export function splitParts(queries: ClientDbQuery[], limit = PART_BYTES): ClientDbQuery[][] {
  const parts: ClientDbQuery[][] = [];
  let part: ClientDbQuery[] = [];
  let size = 0;
  for (const query of queries) {
    const bytes = queryBytes(query);
    if (part.length > 0 && size + bytes > limit) {
      parts.push(part);
      part = [];
      size = 0;
    }
    part.push(query);
    size += bytes;
  }
  parts.push(part);
  return parts;
}

function packMeta(meta: ClientDbMeta): PackedMeta {
  return [
    meta.duration,
    meta.changes,
    meta.last_row_id,
    meta.changed_db ? 1 : 0,
    meta.size_after,
    meta.rows_read,
    meta.rows_written,
  ];
}

function unpackMeta(packed: PackedMeta): ClientDbMeta {
  const [duration, changes, lastRowId, changedDb, sizeAfter, rowsRead, rowsWritten] = packed;
  return {
    served_by: CLIENT_DB_SERVED_BY,
    served_by_primary: true,
    total_attempts: 1,
    timings: { sql_duration_ms: duration },
    duration,
    changes,
    last_row_id: lastRowId,
    changed_db: changedDb === 1,
    size_after: sizeAfter,
    rows_read: rowsRead,
    rows_written: rowsWritten,
  };
}

/**
 * `results` as parts of pieces, each part at most `limit` bytes by the estimate (a part holds one
 * row at least), and the total.
 */
export function packAnswer(
  results: ClientDbResult[],
  limit = PART_BYTES,
): { parts: ClientDbPiece[][]; bytes: number } {
  const parts: ClientDbPiece[][] = [];
  let part: ClientDbPiece[] = [];
  let size = 0;
  let total = 0;
  const close = () => {
    parts.push(part);
    part = [];
    size = 0;
  };
  results.forEach((result, statement) => {
    let piece: ClientDbPiece = [statement, result.columns, packMeta(result.meta), []];
    const head = 64 + result.columns.reduce((sum, column) => sum + 2 * column.length + 8, 0);
    if (part.length > 0 && size + head > limit) close();
    part.push(piece);
    size += head;
    total += head;
    for (const row of result.rows) {
      let bytes = 8;
      for (const value of row) bytes += valueBytes(value);
      if (piece[3].length > 0 && size + bytes > limit) {
        close();
        piece = [statement, null, null, []];
        part.push(piece);
        size += 32;
        total += 32;
      }
      piece[3].push(row);
      size += bytes;
      total += bytes;
    }
  });
  if (part.length > 0 || parts.length === 0) close();
  return { parts, bytes: total };
}

/** The pieces of an answer, in order, put back together as one result per statement. */
export function unpackAnswer(statements: number, pieces: ClientDbPiece[]): ClientDbResult[] {
  const results: (ClientDbResult | undefined)[] = new Array(statements);
  for (const [statement, columns, meta, rows] of pieces) {
    let result = results[statement];
    if (!result) {
      if (!columns || !meta)
        throw new Error(`a part of statement ${statement}'s result is missing`);
      result = { columns, rows: [], meta: unpackMeta(meta) };
      results[statement] = result;
    }
    for (const row of rows) result.rows.push(row);
  }
  for (let i = 0; i < statements; i += 1) {
    if (!results[i]) throw new Error(`statement ${i}'s result is missing`);
  }
  return results as ClientDbResult[];
}

/** The message of a write refused because the database is at its limit. */
export function fullMessage(bytes: number, refuseAt: number, original?: string): string {
  const gb = (n: number) => `${(n / 1e9).toFixed(2)} GB`;
  return (
    `this client's database is full: it holds ${gb(bytes)}, and writes that grow it are refused ` +
    `past ${gb(refuseAt)} (a Durable Object stores at most ${gb(STORAGE_LIMIT_BYTES)}); reads, ` +
    `deletes and small writes such as an erase still work${original ? ` (${original})` : ""}`
  );
}

/** Thrown inside `execute` when a result passes its budget while it is still being read. */
function tooLarge(bytes: number): Refusal {
  const mib = (n: number) => `${Math.ceil(n / 1024 / 1024)} MiB`;
  return new Refusal(
    `the result is more than ${mib(bytes)}, the most a client's database returns for one ` +
      "query set; read it in pages. Nothing was applied",
  );
}

/**
 * Runs `queries` against `storage`, as D1's object does: each statement's meta from the
 * connection's `total_changes()` and `last_insert_rowid()` around it (so a trigger's writes count
 * in `changes`, as on D1), the database's size after it, and the cursor's rows read and written.
 * The caller holds the transaction. The rows are counted as they are read, and a set whose
 * results pass `budget` bytes is refused there, before the rest is read into memory.
 */
function execute(
  storage: DurableObjectStorage,
  set: ClientDbQuery[],
  budget = Number.POSITIVE_INFINITY,
): ClientDbResult[] {
  const sql = storage.sql;
  const counters = () =>
    sql
      .exec<{ t: number; l: number }>("SELECT total_changes() AS t, last_insert_rowid() AS l")
      .one();
  let bytes = 0;
  return set.map((query): ClientDbResult => {
    const sizeBefore = sql.databaseSize;
    const before = counters();
    const started = performance.now();
    const cursor = sql.exec(query.sql, ...query.params);
    const columns = cursor.columnNames;
    const rows: ClientDbValue[][] = [];
    let over = false;
    for (const row of cursor.raw() as Iterable<ClientDbValue[]>) {
      if (over) continue;
      bytes += 8;
      for (const value of row) bytes += valueBytes(value);
      if (bytes > budget) {
        // Past the budget: keep nothing more, but run the statement to its end, so that the
        // transaction can roll back (SQLite cannot roll back under a statement still running).
        over = true;
        rows.length = 0;
        continue;
      }
      rows.push(row);
    }
    if (over) throw tooLarge(budget);
    const duration = performance.now() - started;
    const sizeAfter = sql.databaseSize;
    const after = counters();
    const changes = Number(after.t) - Number(before.t);
    return {
      columns,
      rows,
      meta: {
        served_by: CLIENT_DB_SERVED_BY,
        served_by_primary: true,
        total_attempts: 1,
        timings: { sql_duration_ms: duration },
        duration,
        changes,
        last_row_id: Number(after.l),
        changed_db: changes !== 0 || after.l !== before.l || sizeAfter !== sizeBefore,
        size_after: sizeAfter,
        rows_read: cursor.rowsRead,
        rows_written: cursor.rowsWritten,
      },
    };
  });
}

/**
 * Whether every statement of a set only reads (`isReadOnlySql`, an allow-list: a single SELECT,
 * VALUES or WITH … SELECT). Any other set (DML, DDL, a PRAGMA) may have written, even with
 * `total_changes()` unmoved (DDL does not count there), so it is recorded as one that wrote.
 */
export function provablyReadOnly(queries: { sql: string }[]): boolean {
  return queries.every((query) => isReadOnlySql(query.sql));
}

/**
 * Runs `queries` against `storage` in one transaction and returns D1's results, or the failure as
 * data. For code inside an object that holds no caller's answer (tests, a proof); `ClientDb`
 * itself runs a set through its own `#run`, which bounds the answer.
 */
export function runQueries(
  storage: DurableObjectStorage,
  queries: ClientDbQuery[],
): { ok: true; results: ClientDbResult[] } | { ok: false; error: string } {
  const set = queries.filter((query) => !isEmptyStatement(query.sql));
  if (set.length === 0) return { ok: false, error: "No SQL statements detected." };
  try {
    return { ok: true, results: storage.transactionSync(() => execute(storage, set)) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** What runs a query set against one client's database: the object itself, or a stub of it. */
export interface ClientDbTransport {
  query(queries: ClientDbQuery[], id?: string): Promise<ClientDbAnswer>;
  /** A remote object's: a query set too large for one call goes in parts (`ClientDb.stage`). */
  stage?(batch: string, index: number, queries: ClientDbQuery[]): Promise<ClientDbStaged>;
  commit?(batch: string, partsBefore: number, queries: ClientDbQuery[]): Promise<ClientDbAnswer>;
  /** The later parts of an answer the object holds. */
  take?(id: string, part: number): Promise<ClientDbAnswerPart>;
  /** Whether a set sent with `id` committed; also fences it, so it can no longer run. */
  outcome?(id: string): Promise<ClientDbOutcome>;
}

export type ClientDbStaged = { ok: true } | { ok: false; error: string };

/** Keys in the object's own key-value storage (`_cf_KV`, never in the client's SQL schema). */
const OUTCOME_KEY = "cos:outcome:";
/** The same records by time, so a sweep reads only those due (`cos:outcome-at:<ms>:<id>`). */
const OUTCOME_AT_KEY = "cos:outcome-at:";
const LIMITS_KEY = "cos:limits";
const PLACE_KEY = "cos:place";
const HOLD_KEY = "cos:hold";

const atKey = (at: number, id: string) => `${OUTCOME_AT_KEY}${String(at).padStart(15, "0")}:${id}`;

interface OutcomeRecord {
  state: "committed" | "fenced";
  at: number;
}

interface Staged {
  parts: Map<number, ClientDbQuery[]>;
  bytes: number;
  /** When a part last arrived. */
  touched: number;
  /** A part arrived twice: the batch is refused at its commit. */
  broken: boolean;
}

interface Held {
  parts: ClientDbPiece[][];
  bytes: number;
  /** When it was made or a part last taken. */
  touched: number;
  taken: Set<number>;
}

/** A hold on the database for an export: writes are refused until `until`, or its release. */
interface HoldRecord {
  token: string;
  until: number;
}

/** What a restore answers: the bookmark that undoes it, and the session it ends. */
export type ClientDbRestore =
  | { ok: true; undo: string; session: string }
  | { ok: false; error: string };

/** The message while a restore is waiting for the object to restart. */
export const RESTORING_MESSAGE =
  "this client's database is being restored to a bookmark; nothing was applied";

/** The message of a write refused while the database is held for an export. */
export const HELD_MESSAGE =
  "this client's database is held still while it is exported; nothing was applied";

/**
 * How long a restore waits for its caller's `restart` before restarting the object itself, so an
 * object whose caller died does not refuse queries until it is evicted.
 */
const RESTART_FALLBACK_MS = 5_000;

/**
 * A held answer or staged batch untouched this long may be dropped to make room for another
 * caller's; one untouched for `HELD_TTL_MS` is dropped anyway. Live callers fetch or send the
 * next part within milliseconds.
 */
export const HELD_IDLE_MS = 2_000;

/** A hold for an export lasts this long unless renewed (each part of the export renews it). */
export const DEFAULT_HOLD_MS = 5 * 60 * 1000;

/** Growth a set may add past `refuseAtBytes`, inside the reserve: an erase, a delete with its audit. */
export const SMALL_SET_GROWTH_BYTES = 1024 * 1024;

/** The reserve above `refuseAtBytes` that only small sets may use. */
export const DEFAULT_RESERVE_BYTES = 250_000_000;

/** Size thresholds (`setSizeLimits`). */
export interface ClientDbLimits {
  warnAtBytes: number;
  refuseAtBytes: number;
  reserveBytes: number;
}

// --- Checking what crosses RPC -----------------------------------------------------------------

/** A refusal of a call's arguments: nothing was applied. */
function badArgument(what: string): { ok: false; error: string } {
  return { ok: false, error: `a client's database refused the call: ${what}; nothing was applied` };
}

const isIndex = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

const isId = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 128;

/** Whether `queries` is what the binding sends: SQL text and D1's wire values. */
export function queriesProblem(queries: unknown): string | null {
  if (!Array.isArray(queries)) return "the queries are not a list";
  for (const query of queries) {
    if (!query || typeof query !== "object") return "a query is not an object";
    const { sql, params } = query as { sql?: unknown; params?: unknown };
    if (typeof sql !== "string") return "a query's SQL is not text";
    if (!Array.isArray(params)) return "a query's parameters are not a list";
    for (const param of params) {
      const ok =
        param === null ||
        typeof param === "string" ||
        typeof param === "number" ||
        param instanceof ArrayBuffer;
      if (!ok) return "a parameter is not text, a number, null or bytes";
    }
  }
  return null;
}

/** A client's database: one per client and environment, named by the client's id. */
export class ClientDb extends DurableObject {
  readonly #staged = new Map<string, Staged>();
  readonly #held = new Map<string, Held>();
  #sweepTimer: ReturnType<typeof setTimeout> | undefined;
  #outcomesSweptAt = 0;
  /** A new value each time the object starts: how a restore's caller sees the restart. */
  readonly #session = crypto.randomUUID();
  #restoring = false;

  /** One query set, in one transaction. What every call of `clientDatabase()` sends. */
  query(queries: ClientDbQuery[], id?: string): ClientDbAnswer {
    const problem = queriesProblem(queries);
    if (problem) return badArgument(problem);
    if (id !== undefined && !isId(id))
      return badArgument("the id is not text of 1 to 128 characters");
    return this.#run(queries, id);
  }

  /**
   * Holds part `index` of a batch too large for one call (Workers RPC carries at most 32 MiB a
   * call; D1 takes a batch of any size whose statements are each within its limits). Nothing runs
   * until `commit`. A part sent twice breaks the batch, which its commit then refuses.
   */
  stage(batch: string, index: number, queries: ClientDbQuery[]): ClientDbStaged {
    if (this.#restoring) return { ok: false, error: RESTORING_MESSAGE };
    if (!isId(batch)) return badArgument("the batch is not text of 1 to 128 characters");
    if (!isIndex(index)) return badArgument("the part's index is not a whole number from 0");
    const problem = queriesProblem(queries);
    if (problem) return badArgument(problem);
    this.#sweep();
    const now = Date.now();
    const staged = this.#staged.get(batch) ?? {
      parts: new Map(),
      bytes: 0,
      touched: now,
      broken: false,
    };
    this.#staged.set(batch, staged);
    staged.touched = now;
    if (staged.parts.has(index)) {
      staged.broken = true;
      return { ok: false, error: `part ${index} of a batch sent in parts arrived twice` };
    }
    const bytes = queries.reduce((sum, query) => sum + queryBytes(query), 0);
    if (!this.#makeRoom(bytes, batch)) {
      this.#staged.delete(batch);
      return {
        ok: false,
        error:
          "this client's database is holding as much as it may for other callers; the batch was not applied",
      };
    }
    staged.parts.set(index, queries);
    staged.bytes += bytes;
    this.#sweepLater();
    return { ok: true };
  }

  /**
   * Runs the staged parts of `batch`, in order, and the last part in one transaction, as one
   * batch. Refused whole, with nothing applied, unless parts 0 to `partsBefore - 1` each arrived
   * exactly once (the object restarted between calls, a part was lost or repeated).
   */
  commit(batch: string, partsBefore: number, queries: ClientDbQuery[]): ClientDbAnswer {
    if (!isId(batch)) return badArgument("the batch is not text of 1 to 128 characters");
    if (!isIndex(partsBefore)) return badArgument("the count of parts is not a whole number");
    const problem = queriesProblem(queries);
    if (problem) return badArgument(problem);
    const staged = this.#staged.get(batch);
    this.#staged.delete(batch);
    const parts = staged?.parts ?? new Map<number, ClientDbQuery[]>();
    const complete =
      !staged?.broken &&
      parts.size === partsBefore &&
      Array.from({ length: partsBefore }, (_, i) => parts.has(i)).every(Boolean);
    if (!complete) {
      return {
        ok: false,
        error:
          "a batch sent in parts lost or repeated a part before it was committed; nothing was applied",
      };
    }
    const all: ClientDbQuery[] = [];
    for (let i = 0; i < partsBefore; i += 1) all.push(...(parts.get(i) ?? []));
    all.push(...queries);
    return this.#run(all, batch);
  }

  /**
   * Part `part` of an answer the object holds (`ClientDbAnswer.held`). The answer is forgotten
   * once every later part has been taken, after `HELD_TTL_MS`, or sooner when it has been idle
   * `HELD_IDLE_MS` and another caller needs the room; part 0 can be taken again until then, for a
   * caller whose first answer was lost.
   */
  take(id: string, part: number): ClientDbAnswerPart {
    if (this.#restoring) return { ok: false, error: RESTORING_MESSAGE };
    if (!isId(id)) return badArgument("the id is not text of 1 to 128 characters");
    if (!isIndex(part)) return badArgument("the part is not a whole number from 0");
    this.#sweep();
    const held = this.#held.get(id);
    const pieces = held?.parts[part];
    if (!held || !pieces) {
      return {
        ok: false,
        error: "the rest of this answer is no longer held (the object restarted or it expired)",
      };
    }
    held.taken.add(part);
    held.touched = Date.now();
    if (held.taken.size >= held.parts.length) this.#held.delete(id);
    return { ok: true, pieces };
  }

  /**
   * Whether a query set sent with `id` wrote and committed. One that did not is fenced: if it
   * is still on its way, it is refused when it arrives, so the answer stays true. Refused while a
   * restore waits (a fence written then would be discarded by the restore).
   */
  outcome(id: string): ClientDbOutcome {
    if (this.#restoring) throw new Error(RESTORING_MESSAGE);
    if (!isId(id)) throw new Error("a client's database refused the call: the id is not text");
    const kv = this.ctx.storage.kv;
    const record = kv.get<OutcomeRecord>(OUTCOME_KEY + id);
    if (!record) this.#record(id, "fenced");
    return {
      committed: record?.state === "committed",
      held: this.#held.get(id)?.parts.length ?? null,
    };
  }

  /** Writes an outcome record and its entry by time. */
  #record(id: string, state: OutcomeRecord["state"]): void {
    const kv = this.ctx.storage.kv;
    const at = Date.now();
    kv.put(OUTCOME_KEY + id, { state, at } satisfies OutcomeRecord);
    kv.put(atKey(at, id), id);
  }

  /** One query set, bounded: committed only when its answer can be returned. */
  #run(queries: ClientDbQuery[], id?: string): ClientDbAnswer {
    if (this.#restoring) return { ok: false, error: RESTORING_MESSAGE };
    const set = queries.filter((query) => !isEmptyStatement(query.sql));
    if (set.length === 0) return { ok: false, error: "No SQL statements detected." };
    const storage = this.ctx.storage;
    const kv = storage.kv;
    const answerId = id ?? crypto.randomUUID();
    const readOnly = provablyReadOnly(set);
    if (id !== undefined) {
      const record = kv.get<OutcomeRecord>(OUTCOME_KEY + id);
      if (record) {
        return {
          ok: false,
          error:
            record.state === "committed"
              ? "this batch was already committed; it was not applied again"
              : "this batch was given up by its caller; it was not applied",
        };
      }
    }
    if (!readOnly && this.#holdActive()) return { ok: false, error: HELD_MESSAGE };
    const { refuseAtBytes, reserveBytes } = this.#limits();
    try {
      const packed = storage.transactionSync(() => {
        const sizeBefore = storage.sql.databaseSize;
        const results = execute(storage, set, MAX_ANSWER_BYTES);
        const answer = packAnswer(results);
        if (answer.parts.length > 1) {
          if (answer.bytes > MAX_ANSWER_BYTES) throw tooLarge(MAX_ANSWER_BYTES);
          if (!this.#makeRoom(answer.bytes)) {
            throw new Refusal(
              "this client's database is holding as much as it may for other callers; nothing was applied",
            );
          }
        }
        const sizeAfter = storage.sql.databaseSize;
        const growth = sizeAfter - sizeBefore;
        if (
          growth > 0 &&
          (sizeAfter > refuseAtBytes + reserveBytes ||
            (sizeAfter > refuseAtBytes && growth > SMALL_SET_GROWTH_BYTES))
        ) {
          throw new Refusal(fullMessage(sizeAfter, refuseAtBytes));
        }
        // A set that may have written is recorded in the same transaction: it committed if and
        // only if its record did. Only a set every statement of which provably reads goes
        // unrecorded (`total_changes()` misses DDL, so it cannot decide this).
        if (id !== undefined && !readOnly) this.#record(id, "committed");
        return answer;
      });
      const [first = []] = packed.parts;
      let held: { id: string; parts: number } | null = null;
      if (packed.parts.length > 1) {
        this.#held.set(answerId, {
          parts: packed.parts,
          bytes: packed.bytes,
          touched: Date.now(),
          taken: new Set([0]),
        });
        held = { id: answerId, parts: packed.parts.length };
        this.#sweepLater();
      }
      if (!readOnly) this.#sweepOutcomes();
      return { ok: true, statements: set.length, pieces: first, held };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!(error instanceof Refusal) && message.includes("SQLITE_FULL")) {
        return { ok: false, error: fullMessage(storage.sql.databaseSize, refuseAtBytes, message) };
      }
      return { ok: false, error: message };
    }
  }

  #heldBytes(): number {
    let bytes = 0;
    for (const staged of this.#staged.values()) bytes += staged.bytes;
    for (const held of this.#held.values()) bytes += held.bytes;
    return bytes;
  }

  /**
   * Whether `bytes` more fit in what the object holds for callers, after dropping, oldest first,
   * held answers and staged batches idle for `HELD_IDLE_MS` (their callers are gone or slow; a
   * dropped answer's caller is told so, and asks `outcome`). `keep` is never dropped.
   */
  #makeRoom(bytes: number, keep?: string): boolean {
    if (this.#heldBytes() + bytes <= MAX_HELD_BYTES) return true;
    const now = Date.now();
    const idle = [
      ...[...this.#held].map(([id, h]) => ({ id, touched: h.touched, held: true })),
      ...[...this.#staged].map(([id, s]) => ({ id, touched: s.touched, held: false })),
    ]
      .filter((entry) => entry.id !== keep && now - entry.touched >= HELD_IDLE_MS)
      .sort((a, b) => a.touched - b.touched);
    for (const entry of idle) {
      if (entry.held) this.#held.delete(entry.id);
      else this.#staged.delete(entry.id);
      if (this.#heldBytes() + bytes <= MAX_HELD_BYTES) return true;
    }
    return false;
  }

  /** Forgets staged batches and held answers untouched for `HELD_TTL_MS`. */
  #sweep(): void {
    const now = Date.now();
    for (const [id, staged] of this.#staged) {
      if (now - staged.touched > HELD_TTL_MS) this.#staged.delete(id);
    }
    for (const [id, held] of this.#held) {
      if (now - held.touched > HELD_TTL_MS) this.#held.delete(id);
    }
  }

  /** A timer that sweeps while anything is held, so an abandoned batch does not stay in memory. */
  #sweepLater(): void {
    if (this.#sweepTimer !== undefined) return;
    this.#sweepTimer = setTimeout(() => {
      this.#sweepTimer = undefined;
      this.#sweep();
      if (this.#staged.size > 0 || this.#held.size > 0) this.#sweepLater();
    }, HELD_TTL_MS + 1_000);
  }

  /**
   * Drops outcome records older than `OUTCOME_TTL_MS`: at most every ten seconds, and at most
   * `OUTCOME_SWEEP_BATCH` a time, read in time order, so a busy client's sweep stays small.
   */
  #sweepOutcomes(): void {
    const now = Date.now();
    if (now - this.#outcomesSweptAt < 10_000) return;
    this.#outcomesSweptAt = now;
    const kv = this.ctx.storage.kv;
    const end = atKey(now - OUTCOME_TTL_MS, "");
    for (const [key, id] of kv.list<string>({
      prefix: OUTCOME_AT_KEY,
      end,
      limit: OUTCOME_SWEEP_BATCH,
    })) {
      kv.delete(key);
      kv.delete(OUTCOME_KEY + id);
    }
  }

  /** How many outcome records exist (tests). */
  outcomeRecords(): number {
    return [...this.ctx.storage.kv.list({ prefix: OUTCOME_KEY })].length;
  }

  // --- Holding still for an export ---------------------------------------------------------------

  #holdActive(): boolean {
    const hold = this.ctx.storage.kv.get<HoldRecord>(HOLD_KEY);
    return hold !== undefined && hold.until > Date.now();
  }

  /**
   * Holds the database still for an export: until `release` or `ms` from now (renewed by each
   * `renewHold`), every set that may write is refused with `HELD_MESSAGE`, nothing applied; reads
   * go on. The hold is in the object's storage, so it outlives a restart. Refused while another
   * hold is live.
   */
  hold(
    ms = DEFAULT_HOLD_MS,
  ): { ok: true; token: string; until: number } | { ok: false; error: string } {
    if (this.#restoring) return { ok: false, error: RESTORING_MESSAGE };
    if (!isIndex(ms) || ms < 1_000 || ms > 60 * 60 * 1000) {
      return badArgument("a hold lasts 1 second to 1 hour");
    }
    if (this.#holdActive())
      return { ok: false, error: "the database is already held for another export" };
    const record = { token: crypto.randomUUID(), until: Date.now() + ms };
    this.ctx.storage.kv.put(HOLD_KEY, record);
    return { ok: true, ...record };
  }

  /**
   * Renews hold `token` for `ms` more. Refused when it is not the live hold or it lapsed at any
   * time since it was taken: writes may then have been accepted, so the export must start again.
   */
  renewHold(
    token: string,
    ms = DEFAULT_HOLD_MS,
  ): { ok: true; until: number } | { ok: false; error: string } {
    if (this.#restoring) return { ok: false, error: RESTORING_MESSAGE };
    const hold = this.ctx.storage.kv.get<HoldRecord>(HOLD_KEY);
    if (!hold || hold.token !== token || hold.until <= Date.now()) {
      return {
        ok: false,
        error:
          "the database was not held still for the whole export (the hold lapsed or was replaced)",
      };
    }
    const until = Date.now() + Math.min(Math.max(ms, 1_000), 60 * 60 * 1000);
    this.ctx.storage.kv.put(HOLD_KEY, { token, until });
    return { ok: true, until };
  }

  /** Ends hold `token`; writes are taken again. */
  release(token: string): { ok: boolean } {
    const hold = this.ctx.storage.kv.get<HoldRecord>(HOLD_KEY);
    if (!hold || hold.token !== token) return { ok: false };
    this.ctx.storage.kv.delete(HOLD_KEY);
    return { ok: true };
  }

  /**
   * Applies every migration this database does not have yet, inside the object, from the list
   * the host's code carries: the same `applyMigrations` a D1 database is migrated with, in the
   * same order and with the same bookkeeping (`core_migrations`, `core_meta.schema_version`), one
   * transaction per migration. Returns the names it applied; throws on a failure, as on D1.
   */
  async migrate(migrations: Migration[]): Promise<string[]> {
    return applyMigrations(this.#local(), migrations);
  }

  /**
   * `migrate` with a report instead of a throw: what it applied, the migration that failed (rolled
   * back whole, with the ones before it kept, so a second call resumes from it), and the level
   * after, whose `schemaVersion` is what the host compares with the code's. What the update and
   * `cos client add` call (stage 66 step 7).
   */
  async migrateAndReport(migrations: Migration[]): Promise<MigrationReport> {
    const local = this.#local();
    const before = new Set(await this.#appliedNames());
    const pending = [...migrations]
      .sort((a, b) => a.name.localeCompare(b.name))
      .filter((migration) => !before.has(migration.name))
      .map((migration) => migration.name);
    let failed: MigrationReport["failed"] = null;
    try {
      await applyMigrations(local, migrations);
    } catch (error) {
      const after = new Set(await this.#appliedNames());
      const name = pending.find((n) => !after.has(n)) ?? "(unknown)";
      failed = { name, error: error instanceof Error ? error.message : String(error) };
    }
    const after = new Set(await this.#appliedNames());
    return {
      applied: pending.filter((name) => after.has(name)),
      failed,
      level: await getMigrationLevel(local),
    };
  }

  /** Which core migrations this database has, as `getMigrationLevel` reads it on D1. */
  async level(): Promise<MigrationLevel> {
    return getMigrationLevel(this.#local());
  }

  async #appliedNames(): Promise<string[]> {
    const exists = this.ctx.storage.sql
      .exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'core_migrations'")
      .toArray();
    if (exists.length === 0) return [];
    return this.ctx.storage.sql
      .exec<{ name: string }>("SELECT name FROM core_migrations")
      .toArray()
      .map((row) => row.name);
  }

  /** This database as a `D1Database`, from inside the object. */
  #local(): D1Database {
    return databaseOver({
      query: async (queries, id) => this.#run(queries, id),
      take: async (id, part) => this.take(id, part),
    });
  }

  /** The database's size in bytes (`meta.size_after` reports the same). */
  size(): number {
    return this.ctx.storage.sql.databaseSize;
  }

  /** How full the database is, against the Durable Object's storage limit. */
  usage(): ClientDbUsage {
    const bytes = this.ctx.storage.sql.databaseSize;
    const { warnAtBytes, refuseAtBytes, reserveBytes } = this.#limits();
    return {
      bytes,
      limitBytes: STORAGE_LIMIT_BYTES,
      warnAtBytes,
      refuseAtBytes,
      reserveBytes,
      state: bytes > refuseAtBytes ? "refusing" : bytes > warnAtBytes ? "warning" : "ok",
    };
  }

  /**
   * Sets where usage warns, where sets that grow the database by more than
   * `SMALL_SET_GROWTH_BYTES` are refused, and the reserve above that which small sets (an erase,
   * a delete with its audit rows) may still use, below the platform's limit. For the operator,
   * and for tests of the refusal.
   */
  setSizeLimits(limits: {
    warnAtBytes: number;
    refuseAtBytes: number;
    reserveBytes?: number;
  }): ClientDbUsage {
    if (this.#restoring) throw new Error(RESTORING_MESSAGE);
    const reserveBytes = limits?.reserveBytes ?? DEFAULT_RESERVE_BYTES;
    if (
      !isIndex(limits?.warnAtBytes) ||
      !isIndex(limits?.refuseAtBytes) ||
      !isIndex(reserveBytes) ||
      !(limits.warnAtBytes > 0) ||
      !(limits.refuseAtBytes >= limits.warnAtBytes) ||
      limits.refuseAtBytes + reserveBytes > STORAGE_LIMIT_BYTES
    ) {
      throw new Error(
        "size limits: 0 < warnAtBytes <= refuseAtBytes, and refuseAtBytes + reserveBytes <= the storage limit",
      );
    }
    this.ctx.storage.kv.put(LIMITS_KEY, {
      warnAtBytes: limits.warnAtBytes,
      refuseAtBytes: limits.refuseAtBytes,
      reserveBytes,
    } satisfies ClientDbLimits);
    return this.usage();
  }

  #limits(): ClientDbLimits {
    const stored = this.ctx.storage.kv.get<Partial<ClientDbLimits>>(LIMITS_KEY);
    return {
      warnAtBytes: stored?.warnAtBytes ?? DEFAULT_WARN_AT_BYTES,
      refuseAtBytes: stored?.refuseAtBytes ?? DEFAULT_REFUSE_AT_BYTES,
      reserveBytes: stored?.reserveBytes ?? DEFAULT_RESERVE_BYTES,
    };
  }

  /**
   * Records the location hint the object was first reached with, and answers with it. Cloudflare
   * places a Durable Object where its first `get()` asks and ignores the hint on every later one,
   * so a later different hint changes nothing; `differs` says so.
   */
  place(locationHint?: string): ClientDbPlace {
    if (this.#restoring) throw new Error(RESTORING_MESSAGE);
    if (
      locationHint !== undefined &&
      (typeof locationHint !== "string" || locationHint.length > 16)
    ) {
      throw new Error("a client's database refused the call: the location hint is not a hint");
    }
    const kv = this.ctx.storage.kv;
    const recorded = kv.get<{ locationHint: string | null; at: number }>(PLACE_KEY);
    if (!recorded) {
      const record = { locationHint: locationHint ?? null, at: Date.now() };
      kv.put(PLACE_KEY, record);
      return { ...record, first: true, differs: false };
    }
    return {
      ...recorded,
      first: false,
      differs: locationHint !== undefined && locationHint !== recorded.locationHint,
    };
  }

  // --- Bookmarks and restore (point-in-time recovery) ---------------------------------------------

  /**
   * A bookmark of the database as it is now: Cloudflare's `getCurrentBookmark()`, kept for 30
   * days. Locally the runtime answers a bookmark of zeros it cannot restore. An update takes it
   * with the client already paused: a write acknowledged between the bookmark and a restore is
   * discarded by the restore (stage 66 step 7).
   */
  async bookmark(): Promise<string> {
    return this.ctx.storage.getCurrentBookmark();
  }

  /** A bookmark of the database at about `time` (ms), within the last 30 days. */
  async bookmarkAt(time: number): Promise<string> {
    if (typeof time !== "number" || !Number.isFinite(time))
      throw new Error("the time is not a number");
    return this.ctx.storage.getBookmarkForTime(time);
  }

  /**
   * Arranges for the database to be restored to `bookmark` when the object next starts, and from
   * now until then refuses every call that reads or writes (queries, parts, outcomes, place,
   * limits, holds), so nothing is accepted that the restore would discard unseen. The caller then
   * calls `restart` (or the object restarts itself after `RESTART_FALLBACK_MS`). Everything written
   * after the bookmark is discarded, the object's own records included (outcomes, limits, its
   * place, a hold); the answer's `undo` bookmark puts it all back.
   */
  async restore(bookmark: string): Promise<ClientDbRestore> {
    if (this.#restoring) return { ok: false, error: RESTORING_MESSAGE };
    if (typeof bookmark !== "string" || bookmark.length === 0 || bookmark.length > 256) {
      return badArgument("the bookmark is not a bookmark");
    }
    this.#restoring = true;
    try {
      const undo = await this.ctx.storage.onNextSessionRestoreBookmark(bookmark);
      this.#staged.clear();
      this.#held.clear();
      setTimeout(() => {
        try {
          this.restart();
        } catch {
          // abort throws as the object goes.
        }
      }, RESTART_FALLBACK_MS);
      return { ok: true, undo, session: this.#session };
    } catch (error) {
      this.#restoring = false;
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /** Restarts the object (`ctx.abort`); the call itself fails as the object goes. */
  restart(): void {
    this.ctx.abort("restarting a client's database");
  }

  /** The object's current session, and whether it is waiting to be restored. */
  session(): { id: string; restoring: boolean } {
    return { id: this.#session, restoring: this.#restoring };
  }

  /**
   * Deletes everything the object holds, its tables and its own records, for good: what `cos
   * client remove` calls once the client's export is kept (stage 66 step 7, ADR 0617). Refused
   * while a restore waits or an export holds the database. Point-in-time recovery can still bring
   * it back for 30 days, as for any write.
   */
  async erase(): Promise<{ ok: true } | { ok: false; error: string }> {
    if (this.#restoring) return { ok: false, error: RESTORING_MESSAGE };
    const hold = this.ctx.storage.kv.get<HoldRecord>(HOLD_KEY);
    if (hold && hold.until > Date.now()) return { ok: false, error: HELD_MESSAGE };
    this.#staged.clear();
    this.#held.clear();
    await this.ctx.storage.deleteAll();
    return { ok: true };
  }
}

// --- The D1 binding's side -----------------------------------------------------------------------

/** A value as D1's binding holds it after `bind`: bytes as an array of numbers. */
type BoundValue = string | number | null | number[];

/** D1's `bind` conversions and refusals, as its binding does them. */
function bindValue(value: unknown): BoundValue {
  const type = typeof value;
  if (type === "number" || type === "string") return value as number | string;
  if (type === "boolean") return value ? 1 : 0;
  if (type === "object") {
    if (value == null) return null;
    if (Array.isArray(value) && value.every((b) => typeof b === "number" && b >= 0 && b < 256)) {
      return value as number[];
    }
    if (value instanceof ArrayBuffer) return Array.from(new Uint8Array(value));
    if (ArrayBuffer.isView(value)) return Array.from(value as unknown as ArrayLike<number>);
  }
  const message = `Type '${type}' not supported for value '${String(value)}'`;
  throw new Error(`D1_TYPE_ERROR: ${message}`, { cause: new Error(message) });
}

/**
 * A bound value as it reaches SQLite through D1: D1's binding sends JSON, so a number that is
 * not finite arrives as null; an array of bytes is a BLOB.
 */
function toWire(value: BoundValue): ClientDbValue {
  if (Array.isArray(value)) return new Uint8Array(value).buffer;
  if (typeof value === "number" && !Number.isFinite(value)) return null;
  return value;
}

/** A value as D1 hands it back: a BLOB as an array of numbers, through JSON. */
function fromWire(value: ClientDbValue): unknown {
  if (value instanceof ArrayBuffer) return Array.from(new Uint8Array(value));
  if (typeof value === "number" && !Number.isFinite(value)) return null;
  return value;
}

interface D1Shaped {
  success: true;
  results: Record<string, unknown>[];
  meta: ClientDbMeta;
}

function rowsOf(result: ClientDbResult): unknown[][] {
  return result.rows.map((row) => row.map(fromWire));
}

/** D1's array of objects: a later column of the same name wins, as `Object.fromEntries` does. */
function toObjects(result: ClientDbResult): D1Shaped {
  const { columns } = result;
  return {
    success: true,
    results: rowsOf(result).map((row) =>
      Object.fromEntries(row.map((cell, i) => [columns[i], cell])),
    ),
    meta: result.meta,
  };
}

/** The flags the runtime sets on an error it raises, which callers decide retries on. */
const ERROR_FLAGS = ["retryable", "overloaded", "remote", "durableObjectReset"] as const;

/** A failure of a client's database, with what D1's errors carry and what the runtime said. */
export interface ClientDbError extends Error {
  retryable?: boolean;
  overloaded?: boolean;
  /**
   * True when the set committed but its answer was lost: it must not be sent again. `"unknown"`
   * when the call failed and the object could not say whether a set that may write committed:
   * that is not a failure to retry blind either (`retryable` is then false).
   */
  committed?: boolean | "unknown";
}

function d1Error(message: string, prefix = "D1_ERROR", from?: unknown): ClientDbError {
  const error: ClientDbError = new Error(`${prefix}: ${message}`, { cause: new Error(message) });
  if (from && typeof from === "object") {
    for (const flag of ERROR_FLAGS) {
      const value = (from as Record<string, unknown>)[flag];
      if (value !== undefined) (error as unknown as Record<string, unknown>)[flag] = value;
    }
  }
  return error;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The rest of a held answer, fetched part by part, put together with its first part. */
async function collect(
  transport: ClientDbTransport,
  statements: number,
  pieces: ClientDbPiece[],
  held: { id: string; parts: number } | null,
  from = 1,
): Promise<ClientDbResult[]> {
  const all = [...pieces];
  if (held) {
    if (!transport.take) throw new Error("this transport cannot fetch a held answer");
    for (let part = from; part < held.parts; part += 1) {
      const answer = await transport.take(held.id, part);
      if (!answer.ok) throw new Error(answer.error);
      all.push(...answer.pieces);
    }
  }
  return unpackAnswer(statements, all);
}

/**
 * After a call's answer was lost (the call threw, or a held part is gone): asks the object whether
 * the set committed. If it did and the object still holds its answer, the answer is fetched
 * again; if it did and the answer is gone, the error says it committed, so it is not sent again.
 * If it did not, it is fenced and can no longer run, and the original error stands.
 */
async function recover(
  transport: ClientDbTransport,
  id: string,
  statements: number,
  original: unknown,
  readOnly: boolean,
): Promise<ClientDbResult[]> {
  // A set that only reads wrote nothing: there is no outcome to learn or to fence, and the
  // runtime's flags (retryable, overloaded) stand.
  if (readOnly) throw d1Error(messageOf(original), "D1_ERROR", original);
  let outcome: ClientDbOutcome;
  try {
    if (!transport.outcome) throw original;
    outcome = await transport.outcome(id);
  } catch {
    // A set that may write, whose outcome cannot be learned, may have committed: never
    // retryable, its outcome unknown.
    const error = d1Error(messageOf(original), "D1_ERROR", original);
    error.committed = "unknown";
    error.retryable = false;
    throw error;
  }
  if (outcome.committed && outcome.held !== null) {
    try {
      return await collect(transport, statements, [], { id, parts: outcome.held }, 0);
    } catch {
      // Gone between the two calls: reported as committed below.
    }
  }
  if (outcome.committed) {
    const error = d1Error(
      `the batch committed, but its answer was lost before it was read (${messageOf(original)}); it must not be sent again`,
    );
    error.committed = true;
    error.retryable = false;
    throw error;
  }
  throw d1Error(messageOf(original), "D1_ERROR", original);
}

async function send(transport: ClientDbTransport, queries: ClientDbQuery[]) {
  const id = crypto.randomUUID();
  const nonEmpty = queries.filter((query) => !isEmptyStatement(query.sql));
  const set = nonEmpty.length;
  const readOnly = provablyReadOnly(nonEmpty);
  let answer: ClientDbAnswer;
  try {
    const parts = transport.stage && transport.commit ? splitParts(queries) : [queries];
    if (parts.length === 1) {
      answer = await transport.query(queries, id);
    } else {
      // Too large for one call: the earlier parts are held by the object, and the last commits
      // them all in one transaction, so the batch is still all or nothing.
      for (const [index, part] of parts.slice(0, -1).entries()) {
        const staged = await transport.stage?.(id, index, part);
        if (staged && !staged.ok) throw d1Error(staged.error);
      }
      answer = (await transport.commit?.(
        id,
        parts.length - 1,
        parts.at(-1) ?? [],
      )) as ClientDbAnswer;
    }
  } catch (error) {
    if ((error as Error).message?.startsWith("D1_ERROR: ")) throw error;
    // The object could not be reached, was reset, or the answer was lost on the way back.
    return recover(transport, id, set, error, readOnly);
  }
  if (!answer.ok) throw d1Error(answer.error);
  try {
    return await collect(transport, answer.statements, answer.pieces, answer.held);
  } catch (error) {
    return recover(transport, id, answer.statements, error, readOnly);
  }
}

class ClientDbStatement {
  constructor(
    readonly transport: ClientDbTransport,
    readonly statement: string,
    readonly params: BoundValue[] = [],
  ) {}

  bind(...values: unknown[]): ClientDbStatement {
    return new ClientDbStatement(this.transport, this.statement, values.map(bindValue));
  }

  /** For `batch`: this statement as the object takes it. */
  toQuery(): ClientDbQuery {
    return { sql: this.statement, params: this.params.map(toWire) };
  }

  async #one(): Promise<ClientDbResult> {
    const [result] = await send(this.transport, [this.toQuery()]);
    return result as ClientDbResult;
  }

  async first(column?: string): Promise<unknown> {
    const { results } = toObjects(await this.#one());
    const row = results[0];
    if (!row) return null;
    if (column === undefined) return row;
    if (row[column] === undefined) {
      throw new Error(`D1_COLUMN_NOTFOUND: Column not found (${column})`, {
        cause: new Error("Column not found"),
      });
    }
    return row[column];
  }

  async all(): Promise<D1Shaped> {
    return toObjects(await this.#one());
  }

  /** D1's `run`: the same result as `all`, rows included. */
  async run(): Promise<D1Shaped> {
    return this.all();
  }

  async raw(options?: { columnNames?: boolean }): Promise<unknown[][]> {
    const result = await this.#one();
    return [...(options?.columnNames ? [result.columns] : []), ...rowsOf(result)];
  }
}

/**
 * A session over the same object. D1's session bookmark is a read-replication token (which
 * replica has seen which writes), not a restore point; one object has no replicas and is always
 * consistent with itself, so there is no such token to give and `getBookmark` answers null, as a
 * D1 session does before its first query. A restore point is `ClientDb.bookmark()`.
 */
function session(transport: ClientDbTransport, database: D1Database) {
  return {
    prepare: (sql: string) => database.prepare(sql),
    batch: (statements: D1PreparedStatement[]) => database.batch(statements),
    getBookmark: () => null,
    transport,
  };
}

/** The calls each database made to its object (`clientDbCalls`). */
const CALLS = Symbol("cos.clientDbCalls");

/**
 * How many calls a database from `clientDatabase` has made to its object, since it was made: one
 * a query, a batch or an `exec`, plus one for each further part of a batch or an answer sent in
 * parts. Each is a Durable Object call, which Cloudflare counts against the invocation's
 * subrequests (ADR 0614), where D1 counted queries on their own. Null for any other database. A
 * meter takes the difference before and after a path.
 */
export function clientDbCalls(db: D1Database): number | null {
  const counter = (db as unknown as { [CALLS]?: { calls: number } })[CALLS];
  return counter ? counter.calls : null;
}

/** A `D1Database` over any transport: a client's object from outside, or itself from inside. */
export function databaseOver(transport: ClientDbTransport): D1Database {
  const database = {
    prepare: (sql: string) => new ClientDbStatement(transport, sql),
    async batch(statements: ClientDbStatement[]) {
      const results = await send(
        transport,
        statements.map((statement) => statement.toQuery()),
      );
      return results.map(toObjects);
    },
    /**
     * D1's `exec`: each line of the string is a statement, all in one transaction; an error names
     * the first line, as D1's does.
     */
    async exec(query: string) {
      const lines = query.trim().split("\n");
      let results: ClientDbResult[];
      try {
        results = await send(
          transport,
          lines.map((sql) => ({ sql, params: [] })),
        );
      } catch (error) {
        const message = (error as Error).message.replace(/^D1_ERROR: /, "");
        const legacy = `Error in line 1: ${lines[0]}: ${message}`;
        const wrapped = new Error(`D1_EXEC_ERROR: ${legacy}`, { cause: new Error(legacy) });
        // What the caller decides on (committed, retryable and the runtime's flags) carries over.
        for (const flag of [...ERROR_FLAGS, "committed"] as const) {
          const value = (error as Record<string, unknown>)[flag];
          if (value !== undefined) (wrapped as unknown as Record<string, unknown>)[flag] = value;
        }
        throw wrapped;
      }
      return {
        count: results.length,
        duration: results.reduce((sum, result) => sum + result.meta.duration, 0),
      };
    },
    withSession(_constraintOrBookmark?: string) {
      return session(transport, database as unknown as D1Database);
    },
    async dump(): Promise<ArrayBuffer> {
      // D1's own dump is retired; a client's database is exported as SQL (sql-export.ts).
      throw new Error(
        "D1_DUMP_ERROR: dump is not supported by a client's database; export it as SQL (exportPart in @composable-os/db/sql-export)",
      );
    },
    /** D1's `query()` behind the `d1_binding_jsrpc` flag: not offered; nothing in the host uses it. */
    async query(): Promise<never> {
      throw new Error(
        "D1_ERROR: query() (d1_binding_jsrpc) is not supported by a client's database; use prepare()",
      );
    },
  };
  return database as unknown as D1Database;
}

/**
 * A client's database, standing where a D1 binding stands. A stub is made for every call: a
 * Durable Object stub belongs to the request (or object) that made it and cannot be used from
 * another, where a D1 binding can, so holding one would break the first time the database is
 * reached from a second request, a queue message or another Durable Object (ADR 0612).
 *
 * `options.locationHint` is where the object is created the first time it is reached (stage 43:
 * Oceania for new clients). Cloudflare honours only the first `get()`'s hint; every later call
 * may pass the same hint (the registry's) and a different one changes nothing (`ClientDb.place`).
 */
export function clientDatabase(
  namespace: DurableObjectNamespace<ClientDb>,
  client: string,
  options?: DurableObjectNamespaceGetDurableObjectOptions,
): D1Database {
  const id = namespace.idFromName(client);
  const counter = { calls: 0 };
  const stub = () => {
    counter.calls += 1;
    return namespace.get(id, options);
  };
  const database = databaseOver({
    query: (queries, call) => stub().query(queries, call) as Promise<ClientDbAnswer>,
    stage: (batch, index, queries) =>
      stub().stage(batch, index, queries) as Promise<ClientDbStaged>,
    commit: (batch, partsBefore, queries) =>
      stub().commit(batch, partsBefore, queries) as Promise<ClientDbAnswer>,
    take: (call, part) => stub().take(call, part) as Promise<ClientDbAnswerPart>,
    outcome: (call) => stub().outcome(call) as Promise<ClientDbOutcome>,
  });
  Object.defineProperty(database, CALLS, { value: counter });
  return database;
}

/**
 * A client's database over `cos-client-db`'s query service (`ClientDbQueries`, bound as
 * `CLIENT_DB_QUERIES`), which serves the query path only: what the host's Workers use, so that
 * nothing in them can reach the operator's methods (ADR 0614). The same `D1Database` as
 * `clientDatabase`, and the same calls counted.
 */
export function clientDatabaseService(
  service: ClientDbQueryService,
  client: string,
  options?: { locationHint?: DurableObjectLocationHint; proof?: string },
): D1Database {
  const target: ClientDbTarget = Object.freeze({
    client,
    ...(options?.locationHint ? { locationHint: options.locationHint } : {}),
    ...(options?.proof ? { proof: options.proof } : {}),
  });
  const counter = { calls: 0 };
  const call = () => {
    counter.calls += 1;
    return service;
  };
  const database = databaseOver({
    query: (queries, id) => call().query(target, queries, id),
    stage: (batch, index, queries) => call().stage(target, batch, index, queries),
    commit: (batch, partsBefore, queries) => call().commit(target, batch, partsBefore, queries),
    take: (id, part) => call().take(target, id, part),
    outcome: (id) => call().outcome(target, id),
  });
  Object.defineProperty(database, CALLS, { value: counter });
  return database;
}

/**
 * Restores a client's database to `bookmark` and waits for the object to come back restored:
 * what the update calls for a client whose migration or smoke check failed (stage 66 step 7).
 * Returns the bookmark that undoes the restore. Everything written after `bookmark` is gone, and
 * any call in flight at the restart fails; calls made while the restore waits are refused with
 * nothing applied. Point-in-time recovery exists only on Cloudflare: the local runtime refuses it.
 */
export async function restoreClientDb(
  namespace: DurableObjectNamespace<ClientDb>,
  client: string,
  bookmark: string,
  options?: DurableObjectNamespaceGetDurableObjectOptions & { waitMs?: number },
): Promise<{ undo: string }> {
  const id = namespace.idFromName(client);
  const stub = () => namespace.get(id, options);
  const restore = (await stub().restore(bookmark)) as ClientDbRestore;
  if (!restore.ok) throw new Error(`could not restore ${client}'s database: ${restore.error}`);
  try {
    await stub().restart();
  } catch {
    // Expected: the object goes as it restarts.
  }
  const deadline = Date.now() + (options?.waitMs ?? 30_000);
  for (let attempt = 1; Date.now() < deadline; attempt += 1) {
    try {
      const now = (await stub().session()) as { id: string; restoring: boolean };
      if (now.id !== restore.session && !now.restoring) return { undo: restore.undo };
    } catch {
      // Still restarting.
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(1_000, 50 * attempt)));
  }
  throw new Error(
    `${client}'s database was set to restore, but it did not come back within the wait; it restores when it next starts`,
  );
}
