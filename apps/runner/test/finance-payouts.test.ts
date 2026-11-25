// Stage 52 step 4 (ADR 0793) in the real host: the minute cron reads the fake provider's payouts
// through the real payments gatekeeper (the host's own `callAsHost`, purpose `orders`), records
// each once, and stays bounded: a year of payouts on a new connection is read over many minutes,
// each with at most PAYOUT_CALLS_PER_RUN provider calls and a bounded number of statements; a day
// with nothing new is one provider call; a quiet minute is one indexed read; a failing provider
// is retried later while the cron's other steps run. Proof e of the step; the figures themselves
// are worked out by hand in packages/core/test/finance-payouts.test.ts.
import { env } from "cloudflare:workers";
import { invokeByName, PAYOUT_CALLS_PER_RUN, runPayoutsDue } from "@composable-os/core";
import { beforeAll, describe, expect, it } from "vitest";
import { minuteTick } from "../src/index.ts";
import { integrationRuntime } from "../src/integrations/runtime.ts";
import { createAdmin, db } from "./helpers.ts";
import { fullScans, meterStatements } from "./statement-meter.ts";

const meter = meterStatements(env.DB);
const metered = { ...env, DB: meter.db } as typeof env;
const fake = env.TEST_PAYMENTS;

async function setSetting(key: string, value: unknown) {
  await env.DB.prepare(
    "INSERT INTO core_settings (key, value, updated_at) VALUES (?, ?, 'now') ON CONFLICT (key) DO UPDATE SET value = excluded.value",
  )
    .bind(key, JSON.stringify(value))
    .run();
}

async function count(table: string): Promise<number> {
  return (
    (await env.DB.prepare(`SELECT count(*) AS n FROM ${table}`).first<{ n: number }>())?.n ?? 0
  );
}

const reads = async () => (await fake.payoutState()).reads;
const tick = (iso: string) => minuteTick(metered, new Date(iso));

beforeAll(async () => {
  const admin = await createAdmin();
  const staff = {
    actor: "human" as const,
    user: admin,
    origin: { surface: "ui" as const },
    db,
    integrations: integrationRuntime(env),
  };
  await setSetting("org_timezone", "Australia/Sydney");
  await setSetting("order_currency", "AUD");
  await setSetting("finance_settings", { yearStartMonth: 7, firstPeriod: "2025-11", categoryLabels: {} });
  await fake.configurePayoutReads({ auto: false, pageSize: 10, reads: "ok" });
  await invokeByName("integration.setVendor", { vendor: "payments", enabled: true }, staff);
  const connection = (await invokeByName(
    "connection.create",
    { vendor: "payments", scope: "org" },
    staff,
  )) as { connection: { id: string } };
  await invokeByName(
    "connection.bindResource",
    { id: connection.connection.id, url: "payments://merchant/fake" },
    staff,
  );
  // An order the host recorded a provider payment for, which the first payout settles.
  await env.DB.prepare(
    `INSERT INTO core_order (id, currency, total, paid, state, placed_as, created_at, updated_at)
     VALUES ('ord_payout_1', 'AUD', 4500, 4500, 'paid', 'public', '2025-11-01T00:00:00.000Z',
       '2025-11-01T00:00:00.000Z')`,
  ).run();
  await env.DB.prepare(
    `INSERT INTO core_order_payment (provider, event_id, order_id, amount, currency, outcome,
       payment_ref, received_at) VALUES ('fake', 'fevt_payout_1', 'ord_payout_1', 4500, 'AUD',
       'applied', 'fpi_payout_1', '2025-11-01T01:00:00.000Z')`,
  ).run();
  // A year of daily payouts at the fake provider, the first of them settling that payment.
  const list = Array.from({ length: 150 }, (_, i) => ({
    none: true,
    currency: "AUD",
    arrivalDate: new Date(Date.UTC(2025, 10, 2) + i * 2 * 86_400_000).toISOString().slice(0, 10),
    extra: [
      {
        kind: "payment" as const,
        amount: i === 0 ? 4500 : 1000 + i,
        fee: 30,
        paymentRef: i === 0 ? "fpi_payout_1" : `fpi_elsewhere_${i}`,
      },
    ],
  }));
  await fake.makePayouts(list);
});

describe("the daily payout read in the minute cron", () => {
  it("reads a year's backlog over many minutes, each bounded, and records each payout once", async () => {
    const start = Date.parse("2026-11-01T00:00:00.000Z");
    let minutes = 0;
    for (; minutes < 60; minutes++) {
      const before = await reads();
      meter.reset();
      const result = await tick(new Date(start + minutes * 60_000).toISOString());
      const calls = (await reads()) - before;
      expect(calls).toBeLessThanOrEqual(PAYOUT_CALLS_PER_RUN);
      if (!result.payouts) break;
      expect(result.payouts.calls).toBe(calls);
      // The payouts step's own statements, a few per provider call (the tick's others aside).
      const own = meter.statements.filter((s) => /core_payout/.test(s.sql));
      expect(own.length).toBeLessThanOrEqual(3 * PAYOUT_CALLS_PER_RUN + 5);
      expect(await fullScans(own)).toEqual([]);
      if (!result.payouts.more) break;
    }
    expect(minutes).toBeGreaterThan(5);
    expect(await count("core_payout")).toBe(150);
    expect(await count("core_payout_line")).toBe(150);
    const first = await env.DB.prepare(
      "SELECT amount, lines_net FROM core_payout WHERE arrival_date = '2025-11-02'",
    ).first();
    expect(first).toEqual({ amount: 4470, lines_net: 4470 });
  });

  it("a quiet minute reads the marker by its key and calls nothing", async () => {
    const before = await reads();
    meter.reset();
    const result = await tick("2026-11-01T02:00:00.000Z");
    expect(result.payouts).toBeNull();
    expect(await reads()).toBe(before);
    const own = meter.statements.filter((s) => /core_payout/.test(s.sql));
    expect(own.map((s) => s.sql.replace(/\s+/g, " ").slice(0, 60))).toEqual([
      expect.stringMatching(/^select "next_at" from "core_payout_sync"/),
    ]);
    // Two key lookups (one per provider) and the one row: never the payouts themselves.
    expect(own[0]?.rowsRead).toBeLessThanOrEqual(3);
    expect(meter.statements.filter((s) => /core_payout/.test(s.sql) && !/^\s*select/i.test(s.sql))).toEqual([]);
  });

  it("the next day, with nothing new, is one provider call; two runs at once record nothing twice", async () => {
    const before = await reads();
    // 2 November, 07:00 in Sydney.
    const runtime = integrationRuntime(env);
    const at = () => new Date("2026-11-01T20:00:00.000Z");
    const [a, b] = await Promise.all([
      runPayoutsDue(db, { integrations: runtime, clock: at }),
      runPayoutsDue(db, { integrations: runtime, clock: at }),
    ]);
    expect([a?.recorded ?? 0, b?.recorded ?? 0]).toEqual([0, 0]);
    expect((await reads()) - before).toBeLessThanOrEqual(2);
    expect(await count("core_payout")).toBe(150);
  });

  it("a new payout is read the next day, once, through the gatekeeper", async () => {
    const made = await fake.makePayout({
      none: true,
      currency: "AUD",
      arrivalDate: "2026-11-02",
      extra: [{ kind: "adjustment", amount: 250 }],
    });
    const result = await tick("2026-11-02T20:00:00.000Z");
    expect(result.payouts).toMatchObject({ recorded: 1, state: "ok", more: false });
    expect(
      await env.DB.prepare("SELECT amount FROM core_payout WHERE ref = ?")
        .bind(made?.ref)
        .first(),
    ).toEqual({ amount: 250 });
    expect(await count("core_payout")).toBe(151);
  });

  it("a failing provider is retried later and holds up none of the cron's other steps", async () => {
    await fake.configurePayoutReads({ reads: "error" });
    const result = await tick("2026-11-03T20:00:00.000Z");
    expect(result.payouts?.state).toBe("failing");
    // The other steps ran.
    expect(result.orders).not.toBeNull();
    expect(result.notifications).not.toBeNull();
    // Not every minute: fifteen minutes on.
    expect((await tick("2026-11-03T20:05:00.000Z")).payouts).toBeNull();
    await fake.configurePayoutReads({ reads: "unavailable" });
    expect((await tick("2026-11-03T20:16:00.000Z")).payouts?.state).toBe("unavailable");
    await fake.configurePayoutReads({ reads: "ok" });
    expect((await tick("2026-11-04T20:00:00.000Z")).payouts?.state).toBe("ok");
    expect(await count("core_payout")).toBe(151);
  });
});
