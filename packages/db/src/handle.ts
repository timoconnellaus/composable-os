// The database handle operations receive: typed Kysely for reads and query building, plus an
// atomic batch for writes. D1 has no interactive transactions (ADR 0014), so a unit of work is a
// list of compiled statements run with D1Database.batch(), which D1 executes as one transaction.
import { type Compilable, type CompiledQuery, Kysely } from "kysely";
import { D1Dialect } from "./dialect.ts";
import type { CoreDatabase } from "./schema.ts";

export interface CrmDb {
  /** Typed query builder over core tables and rec_* views. Executing it runs immediately. */
  readonly query: Kysely<CoreDatabase>;
  /**
   * Runs the statements in order as one transaction: all apply or none do. Statements see the
   * effects of earlier ones in the same batch.
   */
  batch(statements: readonly (Compilable | CompiledQuery)[]): Promise<void>;
  /**
   * The database's size in bytes, from D1's `meta.size_after` on a statement that reads no rows,
   * or null where the runtime does not report it.
   */
  size?(): Promise<number | null>;
  /**
   * The same database, read-only: a statement that writes (insert, update, delete, replace, DDL)
   * is refused when it runs, not when it is built, and `batch` refuses. What a dry run reads with
   * (ADR 0022 amendment, 2026-11-22).
   */
  readOnly?(): CrmDb;
}

/**
 * Whether `sql` is one statement that only reads: after its comments, string literals and quoted
 * names are set aside, it is a single `SELECT`, `VALUES`, or `WITH … SELECT` (a `WITH` that
 * prefixes no insert, update, delete or replace; SQLite allows no write inside a SELECT). An
 * allow-list: anything else (a write, DDL, `PRAGMA`, `ATTACH`, `SAVEPOINT`,
 * `ANALYZE`, a second statement after `;`) is not a read. D1 has no read-only session, so this
 * check is what a read-only handle is.
 */
export function isReadOnlySql(sql: string): boolean {
  let bare = "";
  for (let i = 0; i < sql.length; ) {
    const c = sql[i] as string;
    const next = sql[i + 1];
    if (c === "-" && next === "-") {
      const end = sql.indexOf("\n", i);
      i = end < 0 ? sql.length : end + 1;
      bare += " ";
    } else if (c === "/" && next === "*") {
      const end = sql.indexOf("*/", i + 2);
      if (end < 0) return false;
      i = end + 2;
      bare += " ";
    } else if (c === "'" || c === '"' || c === "`" || c === "[") {
      const close = c === "[" ? "]" : c;
      let j = i + 1;
      for (;;) {
        const k = sql.indexOf(close, j);
        if (k < 0) return false;
        // A doubled quote is an escaped one inside the literal.
        if (close !== "]" && sql[k + 1] === close) {
          j = k + 2;
          continue;
        }
        i = k + 1;
        break;
      }
      bare += " x ";
    } else {
      bare += c;
      i += 1;
    }
  }
  const statements = bare
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean);
  if (statements.length !== 1) return false;
  const [statement] = statements as [string];
  const first = /^[a-z]+/i.exec(statement)?.[0].toLowerCase();
  if (first === "select" || first === "values") return true;
  // In SQLite a CTE prefixes one statement, which may be a write: `WITH … INSERT/UPDATE/DELETE`.
  if (first === "with") return !/\b(insert|update|delete)\b|\breplace\s+into\b/i.test(statement);
  return false;
}

/** Thrown by a read-only handle; the pipeline reports it as an internal error. */
export class ReadOnlyDatabaseError extends Error {
  override name = "ReadOnlyDatabaseError";
  constructor(what: string) {
    super(
      `A dry run tried to ${what}; a call waiting for approval changes nothing until it is approved`,
    );
  }
}

/** A D1 binding that runs reads and refuses writes. */
function readOnlyD1(d1: D1Database): D1Database {
  const refuse = (what: string) => async () => {
    throw new ReadOnlyDatabaseError(what);
  };
  return {
    prepare(sql: string) {
      if (isReadOnlySql(sql)) return d1.prepare(sql);
      const write = refuse("write to the database");
      const statement = { bind: () => statement, first: write, run: write, all: write, raw: write };
      return statement as unknown as D1PreparedStatement;
    },
    batch: refuse("commit a batch"),
    exec: refuse("run SQL directly"),
    dump: refuse("dump the database"),
    withSession: () => {
      throw new ReadOnlyDatabaseError("open a session");
    },
  } as unknown as D1Database;
}

function compile(statement: Compilable | CompiledQuery): CompiledQuery {
  return "compile" in statement ? statement.compile() : statement;
}

/**
 * The database each handle reaches: the D1 binding (or a client's database, stage 66) it was made
 * over. A handle is made per request; the database it reaches is one object per client and
 * isolate, so it is what a cache that must never serve one client's rows to another is keyed by
 * (`databaseOf`, stage 66 step 5, ADR 0617). Weak: a handle and its entry go together.
 */
const databases = new WeakMap<object, object>();

/** Records that `handle` reaches `database`. */
export function reaches<T extends object>(handle: T, database: object): T {
  databases.set(handle, databases.get(database) ?? database);
  return handle;
}

/**
 * The database a handle made here reaches (a `CrmDb`, its `query`, its read-only twin, or a
 * Kysely from `createDb`): the binding it was made over, the same object for every handle of one
 * database in an isolate. Anything else is its own database.
 */
export function databaseOf(handle: object): object {
  return databases.get(handle) ?? handle;
}

export function createCrmDb(d1: D1Database): CrmDb {
  let readOnly: CrmDb | undefined;
  const handle: CrmDb = {
    readOnly: () => {
      if (!readOnly) {
        const twin = createCrmDb(reaches(readOnlyD1(d1), d1));
        readOnly = { ...twin, readOnly: () => readOnly as CrmDb };
        reaches(readOnly, d1);
      }
      return readOnly;
    },
    query: reaches(new Kysely<CoreDatabase>({ dialect: new D1Dialect(d1) }), d1),
    async batch(statements) {
      if (statements.length === 0) return;
      await d1.batch(
        statements.map((statement) => {
          const { sql, parameters } = compile(statement);
          return d1.prepare(sql).bind(...parameters);
        }),
      );
    },
    async size() {
      const result = await d1.prepare("SELECT 1").all();
      const size = (result.meta as { size_after?: unknown }).size_after;
      return typeof size === "number" && size > 0 ? size : null;
    },
  };
  return reaches(handle, d1);
}
