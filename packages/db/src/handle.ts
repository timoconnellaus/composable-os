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

/** Statements a read-only handle refuses to run. Kysely's and the host's own SQL start with one. */
const WRITE_SQL =
  /^\s*(insert|update|delete|replace|create|drop|alter|pragma|vacuum|reindex)\b|^\s*with\b[\s\S]*\)\s*(insert|update|delete|replace)\b/i;

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
      if (!WRITE_SQL.test(sql)) return d1.prepare(sql);
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

export function createCrmDb(d1: D1Database): CrmDb {
  let readOnly: CrmDb | undefined;
  return {
    readOnly: () => {
      readOnly ??= { ...createCrmDb(readOnlyD1(d1)), readOnly: () => readOnly as CrmDb };
      return readOnly;
    },
    query: new Kysely<CoreDatabase>({ dialect: new D1Dialect(d1) }),
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
}
