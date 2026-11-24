// Stage 52 step 1 (ADR 0790), what the biggest close costs: a month of 100,000 lines (the most
// one close writes), 1,000 entries, 100,000 report rows and 100,000 counted sources, written as
// one batch. D1 allows 1,000 statements an invocation and 100 bound parameters a statement (the
// local runtime enforces neither): the close writes 500 rows to a statement, one JSON parameter
// each. Listing the months reads a handful of statements whatever has been closed.
import { env } from "cloudflare:workers";
import { createCrmDb } from "@composable-os/db";
import { beforeAll, describe, expect, it } from "vitest";
import { CLOSE_CHUNK, closePlan, MAX_CLOSE_LINES, type PeriodBook } from "../src/finance/close.ts";
import { monthRange } from "../src/finance/day.ts";
import { type ActingUser, invokeByName, newId } from "../src/index.ts";
import { createUser } from "./helpers.ts";

let queries = 0;
let maxParams = 0;

/** env.DB, counting statements and the most parameters any one binds. */
const metered = new Proxy(env.DB, {
  get(target, prop) {
    if (prop === "prepare") {
      return (query: string) => {
        const wrap = (stmt: D1PreparedStatement): D1PreparedStatement =>
          new Proxy(stmt, {
            get(s, p) {
              if (p === "bind") {
                return (...args: unknown[]) => {
                  maxParams = Math.max(maxParams, args.length);
                  return wrap(s.bind(...args));
                };
              }
              if (p === "all" || p === "run" || p === "first" || p === "raw") {
                return async (...args: unknown[]) => {
                  queries += 1;
                  return (s[p] as (...a: unknown[]) => Promise<unknown>)(...args);
                };
              }
              const value = Reflect.get(s, p);
              return typeof value === "function" ? value.bind(s) : value;
            },
          });
        return wrap(target.prepare(query));
      };
    }
    if (prop === "batch") {
      return async (statements: D1PreparedStatement[]) => {
        queries += statements.length;
        return target.batch(statements);
      };
    }
    const value = Reflect.get(target, prop);
    return typeof value === "function" ? value.bind(target) : value;
  },
});
const db = createCrmDb(metered);
const ZONE = "Europe/London";

describe("the cost of a close", () => {
  let admin: ActingUser;
  beforeAll(async () => {
    admin = await createUser("admin");
  });

  it("writes a month of 100,000 lines, rows and sources in one batch of a few hundred statements", async () => {
    const entries: PeriodBook["entries"] = [];
    for (let e = 0; e < 1000; e++) {
      const lines: PeriodBook["entries"][number]["lines"] = [];
      for (let i = 0; i < 50; i++) {
        lines.push(
          { heading: "money_in:provider", side: "debit", amount: 100 + i, method: "provider" },
          { heading: `sales:cat_${i}`, side: "credit", amount: 100 + i, category: `cat_${i}` },
        );
      }
      entries.push({
        key: `payout:po_${e}`,
        kind: "payout",
        date: "2023-04-15",
        belongsTo: null,
        lines,
      });
    }
    const rows: PeriodBook["rows"] = [];
    const counted: PeriodBook["counted"] = [];
    for (let i = 0; i < MAX_CLOSE_LINES; i++) {
      rows.push({
        report: "sales",
        personId: null,
        name: null,
        email: null,
        data: { order: `ord_${i}`, amount: 100 },
      });
      counted.push({ kind: "payment", id: `pay_${i}` });
    }
    const book: PeriodBook = {
      entries,
      rows,
      counted,
      guards: ["SELECT count(*) FROM core_finance_counted"],
    };
    const id = newId("financePeriod");
    const plan = await closePlan(
      { db: db.query, now: "2026-11-24T00:00:00.000Z" },
      {
        id,
        month: "2023-04",
        range: monthRange("2023-04", ZONE),
        version: 1,
        by: admin.id,
        book,
        guardValues: [0],
      },
    );
    const writes =
      3 * (MAX_CLOSE_LINES / CLOSE_CHUNK) + 1000 / CLOSE_CHUNK + book.guards.length + 2;
    expect(plan.statements).toHaveLength(writes);
    queries = 0;
    maxParams = 0;
    const started = Date.now();
    await db.batch(plan.statements);
    const took = Date.now() - started;
    expect(queries).toBe(writes);
    expect(queries).toBeLessThan(700);
    expect(maxParams).toBeLessThanOrEqual(100);
    const stored = await env.DB.prepare(
      "SELECT state, entry_count, line_count, row_count FROM core_finance_period WHERE id = ?",
    )
      .bind(id)
      .first();
    expect(stored).toEqual({
      state: "closed",
      entry_count: 1000,
      line_count: MAX_CLOSE_LINES,
      row_count: MAX_CLOSE_LINES,
    });
    // Locally the batch runs in seconds; a Worker's limit is minutes of wall time for D1.
    expect(took).toBeLessThan(120_000);
  }, 180_000);

  it("lists the months in a few statements, however many are closed", async () => {
    await env.DB.prepare(
      "INSERT INTO core_settings (key, value, updated_at) VALUES ('finance_installed_at', ?, 'now') ON CONFLICT (key) DO UPDATE SET value = excluded.value",
    )
      .bind(JSON.stringify("2023-01-01T00:00:00.000Z"))
      .run();
    queries = 0;
    await invokeByName(
      "finance.periods",
      {},
      {
        actor: "human",
        user: admin,
        origin: { surface: "ui" },
        db,
        clock: () => new Date("2026-11-24T00:00:00.000Z"),
      },
    );
    // The pipeline's own reads and audit, the settings, the versions and the names: never a read
    // per month listed (25 here).
    expect(queries).toBeLessThan(20);
  });
});
