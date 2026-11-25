// Stage 52 step 4 (ADR 0793), proof e at the host: the daily payout read is bounded. A new
// connection with a year of payouts (one a day, and one of 250 lines) is read over several runs,
// each making at most PAYOUT_CALLS_PER_RUN provider calls and carrying on from its marker the
// next minute; every payout and line is recorded once; and the next day, with nothing new, the
// read is one call. The cron's statements on a quiet minute are counted in the runner
// (apps/runner/test/finance-payouts.test.ts and idle-minute-cost.test.ts).
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { PAYOUT_CALLS_PER_RUN } from "../src/finance/payout-sync.ts";
import { runPayoutsDue } from "../src/index.ts";
import { createUser, db } from "./helpers.ts";
import { payoutsDouble } from "./payouts-double.ts";

const double = payoutsDouble("AUD");
const integrations = double.runtime;
const sync = (now: string) => runPayoutsDue(db, { integrations, clock: () => new Date(now) });

async function count(table: string): Promise<number> {
  return (
    (await env.DB.prepare(`SELECT count(*) AS n FROM ${table}`).first<{ n: number }>())?.n ?? 0
  );
}

const DAYS = 365;

beforeAll(async () => {
  const admin = await createUser("admin");
  await env.DB.prepare(
    "INSERT INTO core_settings (key, value, updated_at) VALUES ('org_timezone', ?, 'now') ON CONFLICT (key) DO UPDATE SET value = excluded.value",
  )
    .bind(JSON.stringify("Australia/Sydney"))
    .run();
  // Finance counts from a year back (an admin picked it), so the first pass reads the year.
  await env.DB.prepare(
    "INSERT INTO core_settings (key, value, updated_at) VALUES ('finance_settings', ?, 'now') ON CONFLICT (key) DO UPDATE SET value = excluded.value",
  )
    .bind(JSON.stringify({ yearStartMonth: 7, firstPeriod: "2025-11", categoryLabels: {} }))
    .run();
  await double.connect(admin.id);
  for (let i = 0; i < DAYS; i++) {
    const day = new Date(Date.UTC(2025, 10, 1) + i * 86_400_000).toISOString().slice(0, 10);
    double.pay(day, [
      { kind: "payment", amount: 1000 + i, fee: 30, paymentRef: null, refundRef: null },
      { kind: "fee", amount: -5, fee: 0, paymentRef: null, refundRef: null },
    ]);
  }
  double.pay(
    "2026-06-15",
    Array.from({ length: 250 }, (_, i) => ({
      kind: "payment" as const,
      amount: 100 + i,
      fee: 3,
      paymentRef: null,
      refundRef: null,
    })),
  );
});

describe("a year of payouts on a new connection", () => {
  it("is read over several runs, each bounded, each payout and line once", async () => {
    const start = Date.parse("2026-11-01T00:00:00.000Z");
    const runs: { calls: number; more: boolean }[] = [];
    for (let minute = 0; minute < 200; minute++) {
      const before = double.calls.listPayouts + double.calls.payoutLines;
      const result = await sync(new Date(start + minute * 60_000).toISOString());
      const made = double.calls.listPayouts + double.calls.payoutLines - before;
      if (!result) {
        expect(made).toBe(0);
        break;
      }
      expect(result.calls).toBe(made);
      expect(made).toBeLessThanOrEqual(PAYOUT_CALLS_PER_RUN);
      runs.push({ calls: made, more: result.more });
      if (!result.more) break;
    }
    // 366 payouts, 100 a page, each payout's lines a call (the big one three): many runs.
    expect(runs.length).toBeGreaterThan(10);
    expect(runs.at(-1)?.more).toBe(false);
    expect(runs.slice(0, -1).every((r) => r.more)).toBe(true);
    expect(await count("core_payout")).toBe(DAYS + 1);
    expect(await count("core_payout_line")).toBe(DAYS * 2 + 250);
    const big = await env.DB.prepare(
      "SELECT line_count, lines_net, amount FROM core_payout WHERE arrival_date = '2026-06-15' AND line_count = 250",
    ).first<{ line_count: number; lines_net: number; amount: number }>();
    expect(big?.lines_net).toBe(big?.amount);
  });

  it("the next day, with nothing new, is one call; a quiet minute makes none", async () => {
    // 2 November 05:00 in Sydney: before the day's read.
    expect(await sync("2026-11-01T18:00:00.000Z")).toBeNull();
    const before = { ...double.calls };
    // 07:00: the day's read looks back two weeks, and finds nothing new.
    const next = await sync("2026-11-01T20:00:00.000Z");
    expect(next).toMatchObject({ recorded: 0, more: false, state: "ok" });
    expect(double.calls.listPayouts - before.listPayouts).toBe(1);
    expect(double.calls.payoutLines - before.payoutLines).toBe(0);
    expect(await sync("2026-11-01T20:01:00.000Z")).toBeNull();
  });
});
