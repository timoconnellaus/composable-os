// SPIKE (not for merge): one SQLite database per client in a Durable Object, behind the
// D1Database interface the platform already uses. `ClientDb` is the object; `clientDatabase()`
// returns something that looks like a D1 binding and sends each call to that client's object.
import { DurableObject } from "cloudflare:workers";

type Param = string | number | null | ArrayBuffer | boolean;
interface Statement {
  sql: string;
  params: Param[];
}
interface RawResult {
  columns: string[];
  rows: unknown[][];
  changes: number;
  lastRowId: number;
  rowsRead: number;
  rowsWritten: number;
}

export class ClientDb extends DurableObject {
  #one(statement: Statement): RawResult {
    const sql = this.ctx.storage.sql;
    const cursor = sql.exec(statement.sql, ...statement.params.map(toSqlValue));
    const columns = cursor.columnNames;
    const rows = [...cursor.raw()].map((row) => row.map(fromSqlValue));
    const wrote = cursor.rowsWritten > 0;
    let changes = 0;
    let lastRowId = 0;
    if (wrote) {
      const meta = sql.exec("SELECT changes() AS c, last_insert_rowid() AS l").one();
      changes = Number(meta.c);
      lastRowId = Number(meta.l);
    }
    return { columns, rows, changes, lastRowId, rowsRead: cursor.rowsRead, rowsWritten: cursor.rowsWritten };
  }

  /** One statement, or several as one transaction (D1's batch). */
  run(statements: Statement[]): RawResult[] {
    try {
      if (statements.length === 1) return [this.#one(statements[0] as Statement)];
      return this.ctx.storage.transactionSync(() => statements.map((s) => this.#one(s)));
    } catch (error) {
      throw new Error(`D1_ERROR: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** D1's exec: several statements in one string, no parameters. */
  exec(sql: string): number {
    try {
      this.ctx.storage.sql.exec(sql).toArray();
      return sql.split(";").filter((part) => part.trim()).length;
    } catch (error) {
      throw new Error(`D1_ERROR: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

function toSqlValue(value: Param): string | number | null | ArrayBuffer {
  if (typeof value === "boolean") return value ? 1 : 0;
  return value;
}

/** D1 hands a BLOB back as an array of numbers. */
function fromSqlValue(value: unknown): unknown {
  if (value instanceof ArrayBuffer) return Array.from(new Uint8Array(value));
  return value;
}

function toResult(raw: RawResult, started: number) {
  const results = raw.rows.map((row) => {
    const object: Record<string, unknown> = {};
    raw.columns.forEach((column, index) => {
      object[column] = row[index];
    });
    return object;
  });
  return {
    success: true as const,
    results,
    meta: {
      served_by: "client-db",
      duration: Date.now() - started,
      changes: raw.changes,
      last_row_id: raw.lastRowId,
      changed_db: raw.rowsWritten > 0,
      size_after: 0,
      rows_read: raw.rowsRead,
      rows_written: raw.rowsWritten,
    },
  };
}

class ShimStatement {
  constructor(
    readonly stub: DurableObjectStub<ClientDb>,
    readonly sql: string,
    readonly params: Param[] = [],
  ) {}

  bind(...values: unknown[]) {
    for (const value of values) {
      if (value === undefined) throw new Error("D1_TYPE_ERROR: Type 'undefined' not supported for value 'undefined'");
    }
    return new ShimStatement(this.stub, this.sql, values as Param[]);
  }

  async #raw(): Promise<RawResult> {
    const [raw] = await this.stub.run([{ sql: this.sql, params: this.params }]);
    return raw as RawResult;
  }

  async all() {
    const started = Date.now();
    return toResult(await this.#raw(), started);
  }

  async run() {
    return this.all();
  }

  async first(column?: string) {
    const { results } = await this.all();
    const row = results[0];
    if (!row) return null;
    if (column === undefined) return row;
    if (!(column in row)) throw new Error(`D1_COLUMN_NOTFOUND: Column not found (${column})`);
    return row[column];
  }

  async raw(options?: { columnNames?: boolean }) {
    const raw = await this.#raw();
    return options?.columnNames ? [raw.columns, ...raw.rows] : raw.rows;
  }
}

/** Something that can stand where a D1 binding stands, for one client. */
export function clientDatabase(namespace: DurableObjectNamespace<ClientDb>, client: string): D1Database {
  const stub = namespace.get(namespace.idFromName(client));
  const database = {
    prepare: (sql: string) => new ShimStatement(stub, sql),
    async batch(statements: ShimStatement[]) {
      const started = Date.now();
      const raws = await stub.run(statements.map((s) => ({ sql: s.sql, params: s.params })));
      return raws.map((raw) => toResult(raw as RawResult, started));
    },
    async exec(sql: string) {
      const started = Date.now();
      const count = await stub.exec(sql);
      return { count, duration: Date.now() - started };
    },
    withSession() {
      return { ...database, getBookmark: () => "client-db" };
    },
    async dump(): Promise<ArrayBuffer> {
      throw new Error("dump is not supported");
    },
  };
  return database as unknown as D1Database;
}
