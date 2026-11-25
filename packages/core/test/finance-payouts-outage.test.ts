// Stage 52 step 4 (ADR 0793), the review of PR #474: an outage of any length loses no payout. The
// next read starts from 14 days before the last pass that read everything, so payouts that arrived
// while the key lacked the permission (40 days), while it could list payouts but not their lines
// (Payouts: read without Balance: read), or while it was refused (a revoked key: a failure that
// keeps its place and says the connection needs attention) are all read once it works again. A
// month closed while the read is failing says so in its closed version. A page cursor that does
// not move stops the run. Another account starts its own history, and the old account's marker is
// retired rather than left due every minute.
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { PAYOUT_CALLS_PER_RUN, RETIRED_AT } from "../src/finance/payout-sync.ts";
import { type ActingUser, invokeByName, runPayoutsDue } from "../src/index.ts";
import { context, createUser, db } from "./helpers.ts";
import { payoutsDouble } from "./payouts-double.ts";

const double = payoutsDouble("AUD");
const integrations = double.runtime;
let admin: ActingUser;
let connection: string;

/** 08:00 in Sydney on the day `n` days after 1 January 2026 (21:00 UTC the day before). */
const morning = (n: number) => new Date(Date.UTC(2026, 0, n, 21)).toISOString();
const dayOf = (n: number) => new Date(Date.UTC(2026, 0, n + 1)).toISOString().slice(0, 10);
const sync = (iso: string) => runPayoutsDue(db, { integrations, clock: () => new Date(iso) });

async function count(table: string): Promise<number> {
  return (
    (await env.DB.prepare(`SELECT count(*) AS n FROM ${table}`).first<{ n: number }>())?.n ?? 0
  );
}

/** One payout a day from day `from` to `to`, each synced that morning; the last day's minute. */
async function daily(from: number, to: number) {
  for (let n = from; n <= to; n++) {
    double.pay(dayOf(n), [
      { kind: "adjustment", amount: 1000 + n, fee: 0, paymentRef: null, refundRef: null },
    ]);
    await sync(morning(n));
  }
}

/** Syncs a minute at a time from `iso` until the pass is done; the runs. */
async function catchUp(iso: string) {
  const runs: { calls: number; more: boolean; state: string }[] = [];
  let at = Date.parse(iso);
  for (let i = 0; i < 50; i++, at += 60_000) {
    const result = await sync(new Date(at).toISOString());
    if (!result) break;
    expect(result.calls).toBeLessThanOrEqual(PAYOUT_CALLS_PER_RUN);
    runs.push(result);
    if (!result.more) break;
  }
  return runs;
}

const notes = async (month: string, now: string) =>
  (
    (await invokeByName(
      "finance.report",
      { report: "payouts", month },
      context(admin, { clock: () => new Date(now), integrations }),
    )) as { notes: string[]; preview: boolean }
  ).notes;

beforeAll(async () => {
  admin = await createUser("admin");
  const set = (key: string, value: unknown) =>
    env.DB.prepare(
      "INSERT INTO core_settings (key, value, updated_at) VALUES (?, ?, 'now') ON CONFLICT (key) DO UPDATE SET value = excluded.value",
    )
      .bind(key, JSON.stringify(value))
      .run();
  await set("org_timezone", "Australia/Sydney");
  await set("order_currency", "AUD");
  await set("finance_settings", { yearStartMonth: 7, firstPeriod: "2026-01", categoryLabels: {} });
  connection = await double.connect(admin.id);
});

describe("an outage longer than the lookback loses no payout", () => {
  it("40 days of a key without the permission, then every payout is read, once", async () => {
    double.mode.reads = "unavailable";
    await daily(1, 40);
    expect(await count("core_payout")).toBe(0);
    double.mode.reads = "ok";
    const runs = await catchUp(morning(41));
    expect(runs.length).toBeGreaterThan(1);
    expect(runs.at(-1)).toMatchObject({ more: false, state: "ok" });
    expect(await count("core_payout")).toBe(40);
    // Read again the next day: nothing twice.
    await catchUp(morning(42));
    expect(await count("core_payout")).toBe(40);
  });

  it("a revoked key is a failure: it keeps its place, says the connection needs attention, and a month closed meanwhile says so", async () => {
    double.mode.reads = "revoked";
    await daily(43, 62);
    const marker = await env.DB.prepare(
      "SELECT state, done, reason FROM core_payout_sync WHERE next_at != ?",
    )
      .bind(RETIRED_AT)
      .first<{ state: string; done: number; reason: string }>();
    expect(marker).toMatchObject({ state: "failing", done: 0 });
    expect(marker?.reason).toMatch(/401/);
    const preview = await notes("2026-02", morning(55));
    expect(preview.some((n) => /needs? attention/.test(n))).toBe(true);
    // January closes while the read fails: its closed version says so, as it was.
    await invokeByName(
      "finance.close",
      { month: "2026-01" },
      context(admin, { clock: () => new Date(morning(56)), integrations }),
    );
    double.mode.reads = "ok";
    const runs = await catchUp(morning(63));
    expect(runs.at(-1)).toMatchObject({ more: false, state: "ok" });
    expect(await count("core_payout")).toBe(60);
    const closed = await notes("2026-01", morning(64));
    expect(closed.some((n) => /needs? attention/.test(n))).toBe(true);
    // A preview now says nothing of the read: it is all read.
    expect((await notes("2026-03", morning(64))).some((n) => /payouts \(fake\)/.test(n))).toBe(
      false,
    );
  });

  it("a key that lists payouts but not their lines loses none either", async () => {
    double.mode.linesUnavailable = true;
    await daily(65, 84);
    expect(await count("core_payout")).toBe(60);
    const marker = await env.DB.prepare(
      "SELECT state FROM core_payout_sync WHERE next_at != ?",
    )
      .bind(RETIRED_AT)
      .first<{ state: string }>();
    expect(marker?.state).toBe("unavailable");
    double.mode.linesUnavailable = false;
    await catchUp(morning(85));
    expect(await count("core_payout")).toBe(80);
    expect(await count("core_payout_line")).toBe(80);
  });
});

describe("the read never calls without end", () => {
  it("a page cursor that does not move stops the run as a failure", async () => {
    double.mode.pageSize = 1;
    double.mode.stuck = true;
    const before = double.calls.listPayouts + double.calls.payoutLines;
    const result = await sync(morning(86));
    expect(result?.state).toBe("failing");
    expect(double.calls.listPayouts + double.calls.payoutLines - before).toBeLessThanOrEqual(3);
    const marker = await env.DB.prepare(
      "SELECT reason FROM core_payout_sync WHERE next_at != ?",
    )
      .bind(RETIRED_AT)
      .first<{ reason: string }>();
    expect(marker?.reason).toMatch(/cursor/);
    double.mode.stuck = false;
    double.mode.pageSize = 100;
    await catchUp(morning(87));
    expect(await count("core_payout")).toBe(80);
  });
});

describe("one history per account", () => {
  it("another account starts its own; the old marker is retired, not due every minute", async () => {
    await env.DB.prepare("UPDATE core_integration_connection SET status = 'disconnected' WHERE id = ?")
      .bind(connection)
      .run();
    const other = await double.connect(admin.id);
    // The old account's marker is due the next morning: that run starts the new account's.
    const result = await sync(morning(88));
    expect(result?.provider).toBe("fake");
    const rows = (
      await env.DB.prepare(
        "SELECT account, since, next_at FROM core_payout_sync ORDER BY account",
      ).all<{ account: string; since: string; next_at: string }>()
    ).results;
    const mine = rows.find((r) => r.account.startsWith(other));
    const old = rows.find((r) => r.account.startsWith(connection));
    // From the first month finance counts, less 14 days: its own history.
    expect(mine?.since).toBe("2025-12-18");
    expect(old?.next_at).toBe(RETIRED_AT);
    await catchUp(morning(88));
    // The next minutes are quiet: nothing is due.
    expect(await sync(new Date(Date.parse(morning(88)) + 3_600_000).toISOString())).toBeNull();
  });
});
