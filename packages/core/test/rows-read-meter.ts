// D1 bills rows read, i.e. rows scanned, not rows returned (docs/research/cloudflare-cost-audit.md).
// A cold call also scans sqlite_master once (the extension schema's index list, query.sql's
// guard, erase's x_* tables): sqlite_master has no index, so that read is a row per table, index
// and trigger in the database and grows with every migration, whatever the path does. The meter
// counts it apart, so a budget holds the path's own rows and stays put when a migration adds a
// table elsewhere (CONTRIBUTING.md, Working in parallel). A test still bounds how often a path
// scans sqlite_master (`schemaScans`): a second scan, or one on every call, is a regression.

const SCHEMA = /\bsqlite_(master|schema)\b/i;

export interface RowsReadMeter {
  /** The binding to hand to createCrmDb: every statement through it is counted. */
  db: D1Database;
  /** Zeroes the counts before the call being measured. */
  reset(): void;
  /** Rows read by the path itself: everything but the sqlite_master scans. */
  readonly rows: number;
  /** Statements that read sqlite_master since the last reset. */
  readonly schemaScans: number;
}

/** Wraps `binding`, counting meta.rows_read for every statement run through prepare or batch. */
export function meterRowsRead(binding: D1Database): RowsReadMeter {
  let rows = 0;
  let schemaScans = 0;
  const sqlOf = new WeakMap<object, string>();

  async function count(query: string, readRows: number): Promise<void> {
    if (!SCHEMA.test(query)) {
      rows += readRows;
      return;
    }
    // One scan of sqlite_master reads all of it; anything beyond that is the statement's own.
    schemaScans += 1;
    const schema = await binding
      .prepare("SELECT count(*) AS n FROM sqlite_master")
      .first<{ n: number }>();
    rows += Math.max(0, readRows - (schema?.n ?? 0));
  }

  const wrap = (stmt: D1PreparedStatement, query: string): D1PreparedStatement => {
    const proxy = new Proxy(stmt, {
      get(s, p) {
        if (p === "bind") return (...args: unknown[]) => wrap(s.bind(...args), query);
        if (p === "all" || p === "run") {
          return async () => {
            const result = await (s[p] as () => Promise<D1Result>)();
            await count(query, result.meta.rows_read);
            return result;
          };
        }
        const value = Reflect.get(s, p);
        return typeof value === "function" ? value.bind(s) : value;
      },
    });
    sqlOf.set(proxy, query);
    return proxy;
  };

  const db = new Proxy(binding, {
    get(target, prop) {
      if (prop === "prepare") return (query: string) => wrap(target.prepare(query), query);
      if (prop === "batch") {
        return async (statements: D1PreparedStatement[]) => {
          const results = await target.batch(statements);
          for (const [i, r] of results.entries()) {
            await count(sqlOf.get(statements[i] as object) ?? "", r.meta.rows_read);
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
      rows = 0;
      schemaScans = 0;
    },
    get rows() {
      return rows;
    },
    get schemaScans() {
      return schemaScans;
    },
  };
}
