// Counts what a path costs in D1 (docs/cloudflare-costs.md): statements, rows read and rows
// written, statement by statement, through the binding handed to the path. Unlike
// packages/core/test/rows-read-meter.ts it also counts `first` and `raw` and rows written, and
// keeps each statement's SQL and parameters so a test can read its query plan.
import { env } from "cloudflare:workers";

export interface MeteredStatement {
  sql: string;
  params: unknown[];
  rowsRead: number;
  rowsWritten: number;
}

export interface StatementMeter {
  /** The binding to hand to the path: every statement through it is counted. */
  db: D1Database;
  /** Zeroes the counts before the call being measured. */
  reset(): void;
  readonly statements: readonly MeteredStatement[];
  readonly rowsRead: number;
  readonly rowsWritten: number;
}

export function meterStatements(binding: D1Database): StatementMeter {
  let statements: MeteredStatement[] = [];
  const meta = new WeakMap<object, { sql: string; params: unknown[] }>();
  const record = (sql: string, params: unknown[], result: D1Result) => {
    statements.push({
      sql,
      params,
      rowsRead: result.meta.rows_read,
      rowsWritten: result.meta.rows_written,
    });
  };

  const wrap = (stmt: D1PreparedStatement, sql: string, params: unknown[]): D1PreparedStatement => {
    const proxy = new Proxy(stmt, {
      get(s, p) {
        if (p === "bind") return (...args: unknown[]) => wrap(s.bind(...args), sql, args);
        if (p === "all" || p === "run" || p === "first" || p === "raw") {
          return async (...args: unknown[]) => {
            const result = await s.all();
            record(sql, params, result);
            if (p === "first") {
              const row = result.results[0] as Record<string, unknown> | undefined;
              const column = args[0] as string | undefined;
              return column ? (row?.[column] ?? null) : (row ?? null);
            }
            if (p === "raw") return result.results.map((r) => Object.values(r as object));
            return result;
          };
        }
        const value = Reflect.get(s, p);
        return typeof value === "function" ? value.bind(s) : value;
      },
    });
    meta.set(proxy, { sql, params });
    return proxy;
  };

  const db = new Proxy(binding, {
    get(target, prop) {
      if (prop === "prepare") return (sql: string) => wrap(target.prepare(sql), sql, []);
      if (prop === "batch") {
        return async (batch: D1PreparedStatement[]) => {
          const results = await target.batch(batch);
          for (const [i, result] of results.entries()) {
            const m = meta.get(batch[i] as object);
            record(m?.sql ?? "", m?.params ?? [], result);
          }
          return results;
        };
      }
      const value = Reflect.get(target, prop);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });

  return {
    db,
    reset() {
      statements = [];
    },
    get statements() {
      return statements;
    },
    get rowsRead() {
      return statements.reduce((n, s) => n + s.rowsRead, 0);
    },
    get rowsWritten() {
      return statements.reduce((n, s) => n + s.rowsWritten, 0);
    },
  };
}

/**
 * The full table scans in the statements' query plans: `SCAN t` with no index, the step whose
 * rows read grow with the table, unless `t` (or its alias) is in `allowed`. A walk of an index in
 * order (`SCAN t USING INDEX i`, a page of a queue, a partial index of pending rows) is bounded by
 * its LIMIT or by the index and is not reported.
 */
export async function fullScans(
  statements: readonly MeteredStatement[],
  allowed: readonly string[] = [],
): Promise<string[]> {
  const found: string[] = [];
  for (const { sql, params } of statements) {
    if (!/^\s*(SELECT|WITH|UPDATE|DELETE)/i.test(sql)) continue;
    const plan = await env.DB.prepare(`EXPLAIN QUERY PLAN ${sql}`)
      .bind(...params)
      .all<{ detail: string }>();
    for (const { detail } of plan.results) {
      const scan = /^SCAN (\w+)/.exec(detail);
      if (!scan || allowed.includes(scan[1] as string)) continue;
      if (/USING (COVERING )?INDEX|USING INTEGER PRIMARY KEY/.test(detail)) continue;
      // A subquery's own result, a constant row or a JSON array's elements are not a table.
      if (/^SCAN (SUBQUERY|CONSTANT ROW|json_each)/.test(detail)) continue;
      found.push(`${detail} <- ${sql.replace(/\s+/g, " ").slice(0, 140)}`);
    }
  }
  return found;
}
