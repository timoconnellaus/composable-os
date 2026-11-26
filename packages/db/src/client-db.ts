// A client's database (stage 66, ADR 0612): a Durable Object with SQLite storage, one object per
// client, behind the `D1Database` interface the host's code already uses. `ClientDb` is the
// object; `clientDatabase()` returns something that stands where a D1 binding stands and sends
// each call to that client's object, with D1's result shape, error text and value conversions
// (the binding's own code, `cloudflare-internal:d1-api`, and the local D1 object it talks to were
// the reference). What differs from D1, and why, is the table in ADR 0612.
//
// Every query set a call sends (one statement, a batch, or `exec`'s lines) runs in one
// transaction inside the object, as D1 runs it: all apply or none do.
//
// Not here yet (stage 66 step 2): bookmarks and restore, export and import, a location hint.
// `withSession` gives a session that never has a bookmark, `dump` refuses, as D1's does today.
import { DurableObject } from "cloudflare:workers";
import { applyMigrations, type Migration } from "./migrate.ts";

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

/** What the object answers a query set with: D1's answer, a failure as data (not thrown). */
export type ClientDbAnswer = { ok: true; results: ClientDbResult[] } | { ok: false; error: string };

/** What a client's database reports itself as, where D1 says `miniflare.db` or its region. */
export const CLIENT_DB_SERVED_BY = "cos-client-db";

/** A statement that is only blank lines and comments, which D1 leaves out of a query set. */
function isEmptyStatement(sql: string): boolean {
  // The local D1 object's own test, character for character: a comment counts only when
  // whitespace comes before it on its line.
  return sql.replace(/^\s+--.*/gm, "").trim().length === 0;
}

/**
 * Runs `queries` against `storage` in one transaction, as D1's object does: each statement's
 * meta from the connection's `total_changes()` and `last_insert_rowid()` around it (so a
 * trigger's writes count in `changes`, as on D1), the database's size after it, and the cursor's
 * rows read and written.
 */
export function runQueries(
  storage: DurableObjectStorage,
  queries: ClientDbQuery[],
): ClientDbAnswer {
  const set = queries.filter((query) => !isEmptyStatement(query.sql));
  if (set.length === 0) return { ok: false, error: "No SQL statements detected." };
  const sql = storage.sql;
  const counters = () =>
    sql
      .exec<{ t: number; l: number }>("SELECT total_changes() AS t, last_insert_rowid() AS l")
      .one();
  try {
    const results = storage.transactionSync(() =>
      set.map((query): ClientDbResult => {
        const sizeBefore = sql.databaseSize;
        const before = counters();
        const started = performance.now();
        const cursor = sql.exec(query.sql, ...query.params);
        const columns = cursor.columnNames;
        const rows = Array.from(cursor.raw()) as ClientDbValue[][];
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
      }),
    );
    return { ok: true, results };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** What runs a query set against one client's database: the object itself, or a stub of it. */
export interface ClientDbTransport {
  query(queries: ClientDbQuery[]): Promise<ClientDbAnswer>;
  /** A remote object's: a query set too large for one call goes in parts (`ClientDb.stage`). */
  stage?(batch: string, queries: ClientDbQuery[]): Promise<void>;
  commit?(batch: string, partsBefore: number, queries: ClientDbQuery[]): Promise<ClientDbAnswer>;
}

/**
 * The most a part of a query set carries, by the estimate below: well inside Workers RPC's 32 MiB
 * a call, whatever the strings' encoding.
 */
export const PART_BYTES = 8 * 1024 * 1024;

/** A generous estimate of a query's size on the wire: two bytes a character. */
function wireBytes(query: ClientDbQuery): number {
  let bytes = 2 * query.sql.length + 16;
  for (const param of query.params) {
    if (typeof param === "string") bytes += 2 * param.length + 8;
    else if (param instanceof ArrayBuffer) bytes += param.byteLength + 8;
    else bytes += 9;
  }
  return bytes;
}

/** `queries` in order, cut into parts of at most PART_BYTES each (a part holds one at least). */
export function splitParts(queries: ClientDbQuery[], limit = PART_BYTES): ClientDbQuery[][] {
  const parts: ClientDbQuery[][] = [];
  let part: ClientDbQuery[] = [];
  let size = 0;
  for (const query of queries) {
    const bytes = wireBytes(query);
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

/**
 * How long the object keeps the parts of a batch sent in parts before forgetting them. The parts
 * of one batch arrive one after another within a call of `batch`, so a minute is far more than
 * enough; a batch whose commit never comes is dropped unapplied.
 */
const STAGED_BATCH_TTL_MS = 60_000;

/** A client's database: one per client and environment, named by the client's id. */
export class ClientDb extends DurableObject {
  readonly #staged = new Map<string, { queries: ClientDbQuery[]; parts: number; at: number }>();

  /** One query set, in one transaction. What every call of `clientDatabase()` sends. */
  query(queries: ClientDbQuery[]): ClientDbAnswer {
    return runQueries(this.ctx.storage, queries);
  }

  /**
   * Holds part of a batch too large for one call (Workers RPC carries at most 32 MiB a call; D1
   * takes a batch of any size whose statements are each within its limits). Nothing runs until
   * `commit`.
   */
  stage(batch: string, queries: ClientDbQuery[]): void {
    const now = Date.now();
    for (const [id, staged] of this.#staged) {
      if (now - staged.at > STAGED_BATCH_TTL_MS) this.#staged.delete(id);
    }
    const staged = this.#staged.get(batch) ?? { queries: [], parts: 0, at: now };
    staged.queries.push(...queries);
    staged.parts += 1;
    this.#staged.set(batch, staged);
  }

  /**
   * Runs the staged parts of `batch` and the last part in one transaction, as one batch. Refused
   * whole, with nothing applied, when any earlier part is missing (the object restarted between
   * calls, or a part was forgotten).
   */
  commit(batch: string, partsBefore: number, queries: ClientDbQuery[]): ClientDbAnswer {
    const staged = this.#staged.get(batch);
    this.#staged.delete(batch);
    if ((staged?.parts ?? 0) !== partsBefore) {
      return {
        ok: false,
        error: "a batch sent in parts lost a part before it was committed; nothing was applied",
      };
    }
    return runQueries(this.ctx.storage, [...(staged?.queries ?? []), ...queries]);
  }

  /**
   * Applies every migration this database does not have yet, inside the object, from the list
   * the host's code carries: the same `applyMigrations` a D1 database is migrated with, one
   * transaction per migration. Returns the names it applied.
   */
  async migrate(migrations: Migration[]): Promise<string[]> {
    const local = databaseOver({ query: async (queries) => runQueries(this.ctx.storage, queries) });
    return applyMigrations(local, migrations);
  }

  /** The database's size in bytes (usage reports and the 10 GB limit, stage 66 step 2). */
  size(): number {
    return this.ctx.storage.sql.databaseSize;
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

function d1Error(message: string, prefix = "D1_ERROR"): Error {
  return new Error(`${prefix}: ${message}`, { cause: new Error(message) });
}

async function send(transport: ClientDbTransport, queries: ClientDbQuery[]) {
  let answer: ClientDbAnswer;
  try {
    const parts = transport.stage && transport.commit ? splitParts(queries) : [queries];
    if (parts.length === 1) {
      answer = await transport.query(queries);
    } else {
      // Too large for one call: the earlier parts are held by the object, and the last commits
      // them all in one transaction, so the batch is still all or nothing.
      const batch = crypto.randomUUID();
      for (const part of parts.slice(0, -1)) await transport.stage?.(batch, part);
      answer = (await transport.commit?.(
        batch,
        parts.length - 1,
        parts.at(-1) ?? [],
      )) as ClientDbAnswer;
    }
  } catch (error) {
    // The object could not be reached or was reset: D1's binding reports its own failures so.
    throw d1Error(error instanceof Error ? error.message : String(error));
  }
  if (!answer.ok) throw d1Error(answer.error);
  return answer.results;
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

/** A session that never has a bookmark: one object is always consistent with itself. */
function session(transport: ClientDbTransport, database: D1Database) {
  return {
    prepare: (sql: string) => database.prepare(sql),
    batch: (statements: D1PreparedStatement[]) => database.batch(statements),
    getBookmark: () => null,
    transport,
  };
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
        throw new Error(`D1_EXEC_ERROR: ${legacy}`, { cause: new Error(legacy) });
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
      // D1's own dump is retired; a client's database is exported as SQL in step 2.
      throw new Error("D1_DUMP_ERROR: dump is not supported by a client's database");
    },
  };
  return database as unknown as D1Database;
}

/**
 * A client's database, standing where a D1 binding stands. A stub is made for every call: a
 * Durable Object stub belongs to the request (or object) that made it and cannot be used from
 * another, where a D1 binding can, so holding one would break the first time the database is
 * reached from a second request, a queue message or another Durable Object (ADR 0612).
 */
export function clientDatabase(
  namespace: DurableObjectNamespace<ClientDb>,
  client: string,
  /** Where the object is created, the first time it is reached (step 2 takes it from the registry). */
  options?: DurableObjectNamespaceGetDurableObjectOptions,
): D1Database {
  const id = namespace.idFromName(client);
  const stub = () => namespace.get(id, options);
  return databaseOver({
    query: (queries) => stub().query(queries) as Promise<ClientDbAnswer>,
    stage: (batch, queries) => stub().stage(batch, queries) as Promise<void>,
    commit: (batch, partsBefore, queries) =>
      stub().commit(batch, partsBefore, queries) as Promise<ClientDbAnswer>,
  });
}
