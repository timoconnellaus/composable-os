// A `D1Database` on Node's own SQLite (stage 66 step 7): the empty reference database an import's
// expected schema is made on (`migrationsSchema`), on the operator's machine, and the registry in
// the commands' tests. Only what that code uses: prepare, bind, first, all, run, raw, batch.
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

type Row = Record<string, unknown>;

function toNode(value: unknown): SQLInputValue {
  if (value === undefined) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return value as SQLInputValue;
}

function fromNode(row: Row): Row {
  const out: Row = {};
  for (const [key, value] of Object.entries(row)) {
    // D1 hands BLOBs back as arrays of numbers.
    out[key] = value instanceof Uint8Array ? Array.from(value) : value;
  }
  return out;
}

const READS = /^\s*(select|with|pragma|values)\b/i;

export function nodeD1(path = ":memory:"): D1Database & { close(): void } {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = ON");
  const runOne = (sql: string, params: unknown[]) => {
    const statement = db.prepare(sql);
    const values = params.map(toNode);
    const returns = READS.test(sql) || /\breturning\b/i.test(sql);
    if (returns) return { rows: (statement.all(...values) as Row[]).map(fromNode), changes: 0 };
    const result = statement.run(...values);
    return { rows: [] as Row[], changes: Number(result.changes) };
  };
  const shaped = (out: { rows: Row[]; changes: number }) => ({
    success: true as const,
    results: out.rows,
    meta: { changes: out.changes, duration: 0 },
  });
  const statementOf = (sql: string, params: unknown[] = []) => {
    const run = async () => shaped(runOne(sql, params));
    return {
      sql,
      params,
      bind: (...values: unknown[]) => statementOf(sql, values),
      first: async (column?: string) => {
        const row = runOne(sql, params).rows[0];
        if (!row) return null;
        return column === undefined ? row : (row[column] ?? null);
      },
      all: run,
      run,
      raw: async () => runOne(sql, params).rows.map((row) => Object.values(row)),
    };
  };
  const database = {
    prepare: (sql: string) => statementOf(sql),
    async batch(statements: { sql: string; params: unknown[] }[]) {
      db.exec("BEGIN");
      try {
        const out = statements.map((s) => shaped(runOne(s.sql, s.params)));
        db.exec("COMMIT");
        return out;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    async exec(sql: string) {
      db.exec(sql);
      return { count: 1, duration: 0 };
    },
    close: () => db.close(),
  };
  return database as unknown as D1Database & { close(): void };
}
