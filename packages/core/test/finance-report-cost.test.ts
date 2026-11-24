// Stage 52 step 3 (ADR 0796), what a month's report and close cost over 50,000 orders: a report
// reads the month's own payments, refunds, orders and lines through the date indexes (migration
// 1153) and nothing of the months either side, in a handful of statements with a few bound
// parameters each (D1: 100 a statement; the local runtime enforces none); the close of that month
// is one batch well under D1's 1,000 statements.
import { env } from "cloudflare:workers";
import { createCrmDb } from "@composable-os/db";
import { beforeAll, describe, expect, it } from "vitest";
import { closePlan, MAX_CLOSE_STATEMENTS, periodBook, readGuards } from "../src/finance/close.ts";
import { monthRange } from "../src/finance/day.ts";
import { type ActingUser, invokeByName, newId } from "../src/index.ts";
import type { HandlerContext } from "../src/operation.ts";
import { context, createUser } from "./helpers.ts";
import { meterRowsRead } from "./rows-read-meter.ts";

const ZONE = "Europe/London";
const ORDERS = 50_000;
const NOW = "2026-04-02T12:00:00.000Z";

let statements = 0;
let maxParams = 0;
/** env.DB, counting statements and the most parameters any one binds. */
function counting(binding: D1Database): D1Database {
  return new Proxy(binding, {
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
                    statements += 1;
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
        return async (list: D1PreparedStatement[]) => {
          statements += list.length;
          return target.batch(list);
        };
      }
      const value = Reflect.get(target, prop);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

const meter = meterRowsRead(env.DB);
const metered = createCrmDb(counting(meter.db));

/** `n` paid orders of one line each, paid in [from, from + span) seconds, ids `ord_<prefix>…`. */
async function seed(prefix: string, n: number, from: string, span: number) {
  const start = Date.parse(from) / 1000;
  const series = `WITH RECURSIVE s(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM s WHERE i < ${n})`;
  const at = `strftime('%Y-%m-%dT%H:%M:%fZ', ${start} + ((i - 1) * ${span}) / ${n}, 'unixepoch')`;
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO core_order (id, currency, total, paid, state, placed_as, tax_amount, tax_country,
         created_at, updated_at)
       ${series} SELECT 'ord_${prefix}' || i, 'GBP', 1200, 1200, 'paid', 'public', 200, 'GB', ${at}, ${at} FROM s`,
    ),
    env.DB.prepare(
      `INSERT INTO core_order_line (id, order_id, position, object_type, record_id, title, quantity,
         unit_price, line_total, tax_amount, tax_code, created_at)
       ${series} SELECT 'orl_${prefix}' || i, 'ord_${prefix}' || i, 1, 'x_none.thing', 'rec_' || (i % 50),
         'Thing ' || (i % 50), 1, 1200, 1200, 200, 'txcd_S', ${at} FROM s`,
    ),
    env.DB.prepare(
      `INSERT INTO core_order_payment (provider, event_id, order_id, amount, currency, outcome,
         payment_ref, received_at, tax_amount, tax_country)
       ${series} SELECT 'fake', 'evt_${prefix}' || i, 'ord_${prefix}' || i, 1200, 'GBP', 'applied',
         'pi_${prefix}' || i, ${at}, 200, 'GB' FROM s`,
    ),
  ]);
}

let admin: ActingUser;

beforeAll(async () => {
  admin = await createUser("admin");
  for (const [key, value] of [
    ["org_timezone", ZONE],
    ["order_currency", "GBP"],
    ["finance_installed_at", "2026-03-01T12:00:00.000Z"],
  ] as const) {
    await env.DB.prepare(
      "INSERT INTO core_settings (key, value, updated_at) VALUES (?, ?, 'now') ON CONFLICT (key) DO UPDATE SET value = excluded.value",
    )
      .bind(key, JSON.stringify(value))
      .run();
  }
  // March 2026 in London: 31 days less the hour the clocks went forward.
  await seed("m", ORDERS, "2026-03-01T00:00:00.000Z", 31 * 86_400 - 3_600);
}, 120_000);

async function readMarch() {
  meter.reset();
  statements = 0;
  maxParams = 0;
  const out = (await invokeByName(
    "finance.report",
    { report: "sales", month: "2026-03" },
    context(admin, { db: metered, clock: () => new Date(NOW) }),
  )) as { totals: Record<string, number> };
  return { out, rows: meter.rows, statements, maxParams };
}

describe("the cost of a month of 50,000 orders", () => {
  it("a report reads only the month's rows, in a handful of statements", async () => {
    const first = await readMarch();
    expect(first.out.totals).toMatchObject({ sold: ORDERS * 1200, tax: ORDERS * 200 });
    // The payments, then each order (its person, its first payment) and its lines by id from one
    // JSON parameter: about eleven rows read an order, all of them the month's.
    expect(first.rows).toBeLessThan(ORDERS * 12);
    expect(first.statements).toBeLessThanOrEqual(30);
    expect(first.maxParams).toBeLessThanOrEqual(20);
    // February and April gain 20,000 orders each: March's report reads no more than it did.
    await seed("f", 20_000, "2026-02-01T00:00:00.000Z", 28 * 86_400 - 1);
    await seed("a", 20_000, "2026-04-01T00:00:00.000Z", 86_400);
    const again = await readMarch();
    expect(again.out.totals).toEqual(first.out.totals);
    expect(Math.abs(again.rows - first.rows)).toBeLessThan(200);
  }, 120_000);

  it("its close is one batch of a few hundred statements", async () => {
    const range = monthRange("2026-03", ZONE);
    const ctx = { db: metered.query, now: NOW } as unknown as HandlerContext;
    const book = await periodBook(ctx, range);
    expect(book.counted).toHaveLength(ORDERS);
    const plan = await closePlan(ctx, {
      id: newId("financePeriod"),
      month: "2026-03",
      range,
      version: 1,
      by: admin.id,
      book,
      guardValues: await readGuards(ctx.db, book.guards),
    });
    expect(plan.statements.length).toBeLessThan(MAX_CLOSE_STATEMENTS / 2);
    statements = 0;
    await invokeByName(
      "finance.close",
      { month: "2026-03" },
      context(admin, { db: metered, clock: () => new Date(NOW) }),
    );
    expect(statements).toBeLessThan(1000);
  }, 120_000);
});
