// Stage 52 step 4 (ADR 0793), the review of PR #474: failed payouts whenever they fail, matching
// only what the books counted, and nothing dropped without a word. In May (UTC): payout P of
// 25,000 arrives on 1 May; the bank returns it three weeks later, long after the days each read
// looks back over, and its money is paid again in payout Y on 25 May, as Y's `payout_reversal`
// line. Payout X, still in transit when last listed, failed before it arrived; Y pays its 6,000
// again too, and X's lines (a payment of 6,000) are read from the reversal. Y also carries a
// payment for 8,500 where the host recorded 9,000, a refund the host has only as requested, a
// line in another currency, and two lines the gatekeeper could not read. A payment received in
// December is still in no payout. The bank shows what landed: 39,100, not 70,100.
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { type ActingUser, invokeByName, newId, runPayoutsDue } from "../src/index.ts";
import { context, createUser, db } from "./helpers.ts";
import { type DoublePayout, payoutsDouble } from "./payouts-double.ts";

const double = payoutsDouble("AUD");
const integrations = double.runtime;
let admin: ActingUser;
let p: DoublePayout;
let x: DoublePayout;
let y: DoublePayout;

const at = (day: string, hour = 8) => `${day}T${String(hour).padStart(2, "0")}:00:00.000Z`;
const sync = (iso: string) => runPayoutsDue(db, { integrations, clock: () => new Date(iso) });
const call = <T>(name: string, input: unknown, now: string) =>
  invokeByName(
    name,
    input,
    context(admin, { clock: () => new Date(now), integrations }),
  ) as Promise<T>;

async function order(total: number): Promise<string> {
  const id = newId("order");
  await env.DB.prepare(
    `INSERT INTO core_order (id, currency, total, paid, state, placed_as, created_at, updated_at)
     VALUES (?, 'AUD', ?, ?, 'paid', 'public', '2025-12-01T00:00:00.000Z', '2025-12-01T00:00:00.000Z')`,
  )
    .bind(id, total, total)
    .run();
  return id;
}

async function payment(orderId: string, ref: string, amount: number, receivedAt: string) {
  await env.DB.prepare(
    `INSERT INTO core_order_payment (provider, event_id, order_id, amount, currency, outcome,
       payment_ref, received_at) VALUES ('fake', ?, ?, ?, 'AUD', 'applied', ?, ?)`,
  )
    .bind(`evt_${ref}`, orderId, amount, ref, receivedAt)
    .run();
}

type Row = Record<string, unknown>;

beforeAll(async () => {
  admin = await createUser("admin");
  const set = (key: string, value: unknown) =>
    env.DB.prepare(
      "INSERT INTO core_settings (key, value, updated_at) VALUES (?, ?, 'now') ON CONFLICT (key) DO UPDATE SET value = excluded.value",
    )
      .bind(key, JSON.stringify(value))
      .run();
  await set("org_timezone", "UTC");
  await set("order_currency", "AUD");
  await set("finance_settings", { yearStartMonth: 7, firstPeriod: "2026-04", categoryLabels: {} });
  await double.connect(admin.id);

  await payment(await order(6000), "fpi_b1", 6000, "2026-05-02T01:00:00.000Z");
  const o2 = await order(9000);
  await payment(o2, "fpi_b2", 9000, "2026-05-03T01:00:00.000Z");
  // A refund the host asked for and the provider has not confirmed to it.
  await env.DB.prepare(
    `INSERT INTO core_order_refund (id, order_id, provider, payment_ref, amount, currency, status,
       provider_refund_ref, created_at) VALUES (?, ?, 'fake', 'fpi_b2', 500, 'AUD', 'requested',
       'fre_req', '2026-05-20T00:00:00.000Z')`,
  )
    .bind(newId("refund"), o2)
    .run();
  // December: paid, and still in no payout.
  await payment(await order(3000), "fpi_old", 3000, "2025-12-01T01:00:00.000Z");
});

describe("a payout that fails, whenever it fails", () => {
  it("is recorded failed from the reversal line that pays its money again", async () => {
    p = double.pay("2026-05-01", [
      { kind: "adjustment", amount: 25_000, fee: 0, paymentRef: null, refundRef: null },
    ]);
    x = double.pay(
      "2026-05-04",
      [{ kind: "payment", amount: 6000, fee: 0, paymentRef: "fpi_b1", refundRef: null }],
      { status: "in_transit" },
    );
    // A read every day: each looks back 14 days from the day before.
    for (let d = 2; d <= 24; d++) await sync(at(`2026-05-${String(d).padStart(2, "0")}`));
    expect(
      (await env.DB.prepare("SELECT ref FROM core_payout").all<{ ref: string }>()).results.map(
        (r) => r.ref,
      ),
    ).toEqual([p.ref]);
    y = double.pay(
      "2026-05-25",
      [
        {
          kind: "payout_reversal",
          amount: 25_000,
          fee: 0,
          paymentRef: null,
          refundRef: null,
          reversalOf: p.ref,
        },
        {
          kind: "payout_reversal",
          amount: 6000,
          fee: 0,
          paymentRef: null,
          refundRef: null,
          reversalOf: x.ref,
        },
        { kind: "payment", amount: 8500, fee: 0, paymentRef: "fpi_b2", refundRef: null },
        { kind: "refund", amount: -500, fee: 0, paymentRef: "fpi_b2", refundRef: "fre_req" },
        {
          kind: "adjustment",
          amount: 100,
          fee: 0,
          paymentRef: null,
          refundRef: null,
          currency: "NZD",
        },
      ],
      { unreadable: 2 },
    );
    for (let i = 0; i < 5; i++) await sync(at("2026-05-26", 8 + i));
    const recorded = (
      await env.DB.prepare(
        "SELECT ref, status, amount, line_count, unreadable_lines FROM core_payout ORDER BY status DESC, arrival_date",
      ).all()
    ).results;
    expect(recorded).toEqual([
      { ref: p.ref, status: "paid", amount: 25_000, line_count: 1, unreadable_lines: 0 },
      { ref: y.ref, status: "paid", amount: 39_100, line_count: 5, unreadable_lines: 2 },
      // Never arrived: read from the reversal, its payment explained.
      { ref: x.ref, status: "failed", amount: 6000, line_count: 1, unreadable_lines: 0 },
    ]);
    const failures = (
      await env.DB.prepare(
        "SELECT payout_ref, date FROM core_payout_failure ORDER BY payout_ref",
      ).all()
    ).results;
    expect(failures).toEqual(
      [
        { payout_ref: p.ref, date: "2026-05-26" },
        { payout_ref: x.ref, date: "2026-05-26" },
      ].sort((a, b) => a.payout_ref.localeCompare(b.payout_ref)),
    );
  });

  it("the bank shows what landed, and the payments the failed payout settled are explained", async () => {
    await call("finance.close", { month: "2026-04" }, at("2026-06-02"));
    await call("finance.close", { month: "2026-05" }, at("2026-06-02"));
    const entries = await call<{
      entries: { key: string; lines: { heading: string; side: string; amount: number }[] }[];
    }>("finance.entries", { month: "2026-05" }, at("2026-06-02"));
    const bank = entries.entries
      .flatMap((e) => e.lines)
      .filter((l) => l.heading === "bank")
      .reduce((n, l) => n + (l.side === "debit" ? l.amount : -l.amount), 0);
    expect(bank).toBe(39_100);
    expect(entries.entries.map((e) => e.key)).toEqual(
      expect.arrayContaining([`payout:${p.ref}:failed`, `payout:${x.ref}:failed`]),
    );
    for (const e of entries.entries) {
      expect(e.lines.reduce((n, l) => n + (l.side === "debit" ? l.amount : -l.amount), 0)).toBe(0);
    }
    const may = await call<{ rows: Row[]; totals: Record<string, number> }>(
      "finance.report",
      { report: "payouts", month: "2026-05" },
      at("2026-06-02"),
    );
    // fpi_b1, settled by the payout that failed, is no longer waiting to be paid out.
    const unpaid = may.rows.find((r) => r.type === "unpaid") as Row;
    expect(unpaid.sources).not.toContain("fake:evt_fpi_b1");
    expect(may.totals.amount - may.totals.failed).toBe(39_100);
  });
});

describe("a line settles only what the books counted", () => {
  it("an amount that differs, a refund not confirmed and another currency match nothing, with the reason", async () => {
    const may = await call<{ rows: Row[] }>(
      "finance.report",
      { report: "payouts", month: "2026-05" },
      at("2026-06-02"),
    );
    const lines = may.rows.filter((r) => r.type === "line" && r.payoutRef === y.ref);
    const by = (kind: string, extra: (r: Row) => boolean = () => true) =>
      lines.find((r) => r.kind === kind && extra(r));
    expect(by("payment")).toMatchObject({ matched: false, reason: "amount_differs" });
    expect(by("refund")).toMatchObject({ matched: false, reason: "not_counted" });
    expect(by("adjustment")).toMatchObject({ reason: "currency_differs" });
    expect(by("payout_reversal", (r) => r.reversalOf === p.ref)).toMatchObject({ amount: 25_000 });
    const xLine = may.rows.find((r) => r.type === "line" && r.payoutRef === x.ref);
    expect(xLine).toMatchObject({ matched: true, source: "payment" });
  });
});

describe("nothing dropped without a word", () => {
  it("lines the gatekeeper could not read are counted on the payout and in the notice", async () => {
    const may = await call<{ rows: Row[]; totals: Record<string, number> }>(
      "finance.report",
      { report: "payouts", month: "2026-05" },
      at("2026-06-02"),
    );
    expect(may.rows.find((r) => r.type === "payout" && r.payoutRef === y.ref)).toMatchObject({
      unreadableLines: 2,
    });
    expect(may.totals.unreadableLines).toBe(2);
    const notice = await env.DB.prepare(
      "SELECT body FROM core_notifications WHERE dedupe_key = ? LIMIT 1",
    )
      .bind(`finance.payout_mismatch:fake:${y.ref}`)
      .first<{ body: string }>();
    expect(notice?.body).toMatch(/2 of its lines could not be read/);
  });

  it("the provider's payments older than the window and in no payout are counted", async () => {
    const may = await call<{ rows: Row[]; totals: Record<string, number> }>(
      "finance.report",
      { report: "payouts", month: "2026-05" },
      at("2026-06-02"),
    );
    expect(may.rows.find((r) => r.type === "unpaid")).toMatchObject({
      olderCount: 1,
      olderAmount: 3000,
    });
    expect(may.totals.notPaidOutOlder).toBe(3000);
  });
});
