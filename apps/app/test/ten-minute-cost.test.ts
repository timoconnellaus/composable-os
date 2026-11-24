// What an idle host costs every ten minutes (docs/cloudflare-costs.md): cos-app's `*/10 * * * *`
// cron (the embedding catch-up, the adjudicator's sweep, the blob deletion drain and the agents'
// sweep) on a host with nothing to do. It writes no row and reads a handful.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { runAdjudicatorCron } from "../src/server/adjudicator.ts";
import { runEmbeddingCron } from "../src/server/ai.ts";
import { runAgentJobCron } from "../src/server/assistant/job-cron.ts";
import { runBlobDeletionCron } from "../src/server/purge.ts";

interface Counted {
  sql: string;
  rowsRead: number;
  rowsWritten: number;
}

/** env.DB, counting every statement's rows read and written. */
function metered(binding: D1Database) {
  const counted: Counted[] = [];
  const sqlOf = new WeakMap<object, string>();
  const wrap = (stmt: D1PreparedStatement, sql: string): D1PreparedStatement => {
    const proxy = new Proxy(stmt, {
      get(s, p) {
        if (p === "bind") return (...args: unknown[]) => wrap(s.bind(...args), sql);
        if (p === "all" || p === "run" || p === "first" || p === "raw") {
          return async (...args: unknown[]) => {
            const result = await s.all();
            counted.push({
              sql,
              rowsRead: result.meta.rows_read,
              rowsWritten: result.meta.rows_written,
            });
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
    sqlOf.set(proxy, sql);
    return proxy;
  };
  const db = new Proxy(binding, {
    get(target, prop) {
      if (prop === "prepare") return (sql: string) => wrap(target.prepare(sql), sql);
      if (prop === "batch") {
        return async (batch: D1PreparedStatement[]) => {
          const results = await target.batch(batch);
          for (const [i, r] of results.entries()) {
            counted.push({
              sql: sqlOf.get(batch[i] as object) ?? "",
              rowsRead: r.meta.rows_read,
              rowsWritten: r.meta.rows_written,
            });
          }
          return results;
        };
      }
      const value = Reflect.get(target, prop);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { db, counted };
}

describe("an idle ten minutes", () => {
  it("the four steps write no row and read a few", async () => {
    const { db, counted } = metered(env.DB);
    const idle = { ...env, DB: db } as typeof env;
    // Twice: the first run on a new host may record where a backfill stands.
    for (let round = 0; round < 2; round++) {
      counted.length = 0;
      await runEmbeddingCron(idle);
      await runAdjudicatorCron(idle);
      await runBlobDeletionCron(idle);
      await runAgentJobCron(idle);
    }
    // An UPDATE that matches no queued agent is a statement but writes no row.
    expect(counted.reduce((n, c) => n + c.rowsWritten, 0)).toBe(0);
    // 7 statements today.
    expect(counted.length).toBeLessThanOrEqual(10);
    expect(counted.reduce((n, c) => n + c.rowsRead, 0)).toBeLessThanOrEqual(20);
  });
});
