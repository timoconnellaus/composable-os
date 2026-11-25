// Stage 52 step 4 (ADRs 0791 and 0793): payouts read from the provider, their entries and the
// Payouts report, against a month worked out by hand. April 2026 in Auckland. The provider (the
// gatekeeper's double, payouts-double.ts) paid out on 15 April a payout of two payments, a late
// payment the host never honoured, a refund, a charge made at the provider directly (the host
// has no payment for it), a dispute of the first payment with its fee, and an adjustment; on 20
// April a payout whose lines do not sum to it; on 2 May a payout of a payment received on 28
// April; and a payout still in transit. A payment recorded by hand (a bank transfer) never
// reaches the provider. Every clock is injected.
//
// The proofs: (a) a payout's entry balances and its lines sum to it, and every provider payment
// and refund is in exactly one payout or in "not yet paid out"; (b) reading the same payouts twice,
// and two reads at once, record each once; (c) a recorded payout cannot be changed by any write
// path, and a provider correction (a failure after arrival) becomes a new entry; (d) a payout
// dated in a closed month does not change it: it is counted, late, in the next.
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { type ActingUser, type Actor, invokeByName, newId, runPayoutsDue } from "../src/index.ts";
import { context, createUser, db } from "./helpers.ts";
import { type DoublePayout, payoutsDouble } from "./payouts-double.ts";

const ZONE = "Pacific/Auckland";
const CURRENCY = "NZD";
const at = (iso: string) => () => new Date(iso);
// 5 May, 12:00 local (NZST, +12).
const MAY5 = "2026-05-05T00:00:00.000Z";
const MAY6 = "2026-05-06T00:00:00.000Z";
const MAY7 = "2026-05-07T00:00:00.000Z";
const JUNE = "2026-06-03T00:00:00.000Z";

const double = payoutsDouble(CURRENCY);
const integrations = double.runtime;

async function call<T>(
  name: string,
  input: unknown,
  user: ActingUser,
  now: string,
  actor: Actor = "human",
): Promise<T> {
  const surface = actor === "assistant" ? "assistant" : actor === "mcp" ? "mcp" : "ui";
  return (await invokeByName(
    name,
    input,
    context(user, { actor, origin: { surface }, clock: at(now), integrations }),
  )) as T;
}

async function refusal(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (e) {
    return e as { code: string; message: string; details?: Record<string, unknown> };
  }
  throw new Error("expected a refusal");
}

const sync = (now: string) => runPayoutsDue(db, { integrations, clock: at(now) });

async function setSetting(key: string, value: unknown) {
  await env.DB.prepare(
    "INSERT INTO core_settings (key, value, updated_at) VALUES (?, ?, 'now') ON CONFLICT (key) DO UPDATE SET value = excluded.value",
  )
    .bind(key, JSON.stringify(value))
    .run();
}

async function order(total: number, paid: number, refunded = 0): Promise<string> {
  const id = newId("order");
  const now = "2026-04-01T00:00:00.000Z";
  await env.DB.prepare(
    `INSERT INTO core_order (id, email, currency, total, paid, refunded, state, placed_as,
       created_at, updated_at) VALUES (?, NULL, ?, ?, ?, ?, 'paid', 'public', ?, ?)`,
  )
    .bind(id, CURRENCY, total, paid, refunded, now, now)
    .run();
  await env.DB.prepare(
    `INSERT INTO core_order_line (id, order_id, position, object_type, record_id, title, quantity,
       unit_price, line_total, created_at) VALUES (?, ?, 1, 'x_goods', 'rec_goods', 'Mat', 1, ?, ?, ?)`,
  )
    .bind(newId("orderLine"), id, total, total, now)
    .run();
  return id;
}

async function payment(
  orderId: string,
  event: string,
  ref: string | null,
  amount: number,
  receivedAt: string,
  outcome = "applied",
) {
  await env.DB.prepare(
    `INSERT INTO core_order_payment (provider, event_id, order_id, amount, currency, outcome,
       payment_ref, received_at) VALUES ('fake', ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(event, orderId, amount, CURRENCY, outcome, ref, receivedAt)
    .run();
}

async function refund(
  orderId: string,
  ref: string,
  paymentRef: string,
  amount: number,
  at: string,
) {
  const id = newId("refund");
  await env.DB.prepare(
    `INSERT INTO core_order_refund (id, order_id, provider, payment_ref, amount, currency, status,
       provider_refund_ref, confirmed_at, created_at) VALUES (?, ?, 'fake', ?, ?, ?, 'confirmed', ?, ?, ?)`,
  )
    .bind(id, orderId, paymentRef, amount, CURRENCY, ref, at, at)
    .run();
  return id;
}

type Row = Record<string, unknown>;
interface ReportOut {
  preview: boolean;
  version: number | null;
  notes: string[];
  rows: Row[];
  totals: Record<string, number>;
}
interface EntriesOut {
  entries: {
    key: string;
    kind: string;
    date: string;
    belongsTo: string | null;
    fingerprint: string;
    lines: { heading: string; side: string; amount: number }[];
  }[];
}

const linesOf = (entry: EntriesOut["entries"][number]) =>
  Object.fromEntries(entry.lines.map((l) => [`${l.heading} ${l.side}`, l.amount]));
const balanced = (entry: EntriesOut["entries"][number]) =>
  entry.lines.reduce((n, l) => n + (l.side === "debit" ? l.amount : -l.amount), 0) === 0;

let admin: ActingUser;
let member: ActingUser;
let refundR2: string;
let p1: DoublePayout;
let p2: DoublePayout;
let p3: DoublePayout;

const report = (input: Record<string, unknown>, now = MAY5, user = admin, actor: Actor = "human") =>
  call<ReportOut>("finance.report", { report: "payouts", ...input }, user, now, actor);
const payoutRow = (r: ReportOut, ref: string) =>
  r.rows.find((x) => x.type === "payout" && x.payoutRef === ref) as Row;

beforeAll(async () => {
  admin = await createUser("admin");
  member = await createUser("member");
  await setSetting("org_timezone", ZONE);
  await setSetting("order_currency", CURRENCY);
  await setSetting("finance_installed_at", "2026-04-02T00:00:00.000Z");
  await double.connect(admin.id);

  const o1 = await order(11000, 11000);
  await payment(o1, "evt_a1", "fpi_a1", 11000, "2026-04-03T01:00:00.000Z");
  const o2 = await order(5000, 5000, 2000);
  await payment(o2, "evt_a2", "fpi_a2", 5000, "2026-04-10T01:00:00.000Z");
  refundR2 = await refund(o2, "fre_r2", "fpi_a2", 2000, "2026-04-12T01:00:00.000Z");
  // A bank transfer recorded by hand: the provider never sees it.
  const o3 = await order(3000, 3000);
  await env.DB.prepare(
    `INSERT INTO core_order_payment (provider, event_id, order_id, amount, currency, outcome,
       received_at, method, recorded_kind, recorded_by, received_on)
     VALUES ('host', 'rec_1', ?, 3000, ?, 'applied', '2026-04-11T01:00:00.000Z', 'recorded',
       'transfer', ?, '2026-04-11')`,
  )
    .bind(o3, CURRENCY, admin.id)
    .run();
  // Paid after the order had closed, never honoured: not a sale, but the provider pays it out.
  const o5 = await order(1500, 0);
  await payment(o5, "evt_late", "fpi_late", 1500, "2026-04-12T02:00:00.000Z", "late");
  // 28 April: paid out on 2 May.
  const o4 = await order(7000, 7000);
  await payment(o4, "evt_a4", "fpi_a4", 7000, "2026-04-28T01:00:00.000Z");

  p1 = double.pay("2026-04-15", [
    { kind: "payment", amount: 11000, fee: 223, paymentRef: "fpi_a1", refundRef: null },
    { kind: "payment", amount: 5000, fee: 118, paymentRef: "fpi_a2", refundRef: null },
    { kind: "refund", amount: -2000, fee: 0, paymentRef: "fpi_a2", refundRef: "fre_r2" },
    { kind: "payment", amount: 1500, fee: 56, paymentRef: "fpi_late", refundRef: null },
    // A charge made at the provider directly: the host has no payment for it.
    { kind: "payment", amount: 4000, fee: 100, paymentRef: "fpi_direct", refundRef: null },
    { kind: "dispute", amount: -1000, fee: 1500, paymentRef: "fpi_a1", refundRef: null },
    { kind: "adjustment", amount: 50, fee: 0, paymentRef: null, refundRef: null },
  ]);
  p2 = double.pay(
    "2026-04-20",
    [{ kind: "adjustment", amount: 300, fee: 0, paymentRef: null, refundRef: null }],
    { skew: 100 },
  );
  p3 = double.pay("2026-05-02", [
    { kind: "payment", amount: 7000, fee: 153, paymentRef: "fpi_a4", refundRef: null },
  ]);
  double.pay(
    "2026-04-29",
    [{ kind: "payment", amount: 999, fee: 0, paymentRef: "fpi_zz", refundRef: null }],
    { status: "in_transit" },
  );
});

async function count(table: string): Promise<number> {
  return (
    (await env.DB.prepare(`SELECT count(*) AS n FROM ${table}`).first<{ n: number }>())?.n ?? 0
  );
}

describe("reading payouts (proof b: once each, however often and however many at once)", () => {
  it("two runs at once record each arrived payout once, with every line", async () => {
    const [a, b] = await Promise.all([sync(MAY5), sync(MAY5)]);
    expect(a?.state).toBe("ok");
    expect(b?.state).toBe("ok");
    expect(await count("core_payout")).toBe(3);
    expect(await count("core_payout_line")).toBe(9);
    expect(await count("core_payout_sync")).toBe(1);
    // The payout still in transit is not recorded until it arrives.
    const refs = (
      await env.DB.prepare("SELECT ref FROM core_payout ORDER BY arrival_date").all<{
        ref: string;
      }>()
    ).results.map((r) => r.ref);
    expect(refs).toEqual([p1.ref, p2.ref, p3.ref]);
    const recorded = await env.DB.prepare(
      "SELECT amount, line_count, lines_net, arrival_date FROM core_payout WHERE ref = ?",
    )
      .bind(p1.ref)
      .first();
    expect(recorded).toEqual({
      amount: 16553,
      line_count: 7,
      lines_net: 16553,
      arrival_date: "2026-04-15",
    });
  });

  it("is not read again the same day; the next day's read records nothing again", async () => {
    expect(await sync(MAY5)).toBeNull();
    const before = { ...double.calls };
    const next = await sync(MAY6);
    expect(next).toMatchObject({ recorded: 0, lines: 0, state: "ok", more: false });
    // One page of payouts, no lines: everything it listed was recorded already.
    expect(double.calls.listPayouts - before.listPayouts).toBe(1);
    expect(double.calls.payoutLines - before.payoutLines).toBe(0);
    expect(await count("core_payout")).toBe(3);
    expect(await count("core_payout_line")).toBe(9);
  });

  it("a payout whose lines do not sum to it tells those who may close the books, once", async () => {
    const rows = (
      await env.DB.prepare(
        "SELECT user_id FROM core_notifications WHERE dedupe_key LIKE 'finance.payout_mismatch:%'",
      ).all<{ user_id: string }>()
    ).results;
    // Admins only here: one notification each, for the one payout that does not sum (P2).
    expect(rows.filter((r) => r.user_id === admin.id)).toHaveLength(1);
    expect(rows.some((r) => r.user_id === member.id)).toBe(false);
    const keys = (
      await env.DB.prepare(
        "SELECT DISTINCT dedupe_key AS k FROM core_notifications WHERE dedupe_key LIKE 'finance.payout_mismatch:%'",
      ).all<{ k: string }>()
    ).results.map((r) => r.k);
    expect(keys).toEqual([`finance.payout_mismatch:fake:${p2.ref}`]);
  });
});

describe("the Payouts report (proof a: every line matched or listed, every payment once)", () => {
  it("April's payouts, line by line, by hand", async () => {
    const r = await report({ month: "2026-04" });
    expect(r.preview).toBe(true);
    expect(payoutRow(r, p1.ref)).toMatchObject({
      date: "2026-04-15",
      belongsTo: null,
      amount: 16553,
      // fpi_a1, fpi_a2 and the late payment the host holds: matched.
      payments: 17500,
      refunds: 2000,
      // The charge made at the provider directly.
      unmatched: 4000,
      disputes: -1000,
      adjustments: 50,
      fees: 223 + 118 + 56 + 100 + 1500,
      linesNet: 16553,
      difference: 0,
      lineCount: 7,
    });
    expect(payoutRow(r, p2.ref)).toMatchObject({
      amount: 400,
      adjustments: 300,
      linesNet: 300,
      difference: 100,
    });
    expect(payoutRow(r, p3.ref)).toBeUndefined();
    const lines = r.rows.filter((x) => x.type === "line" && x.payoutRef === p1.ref);
    expect(lines.map((l) => [l.kind, l.matched, l.source])).toEqual([
      ["payment", true, "payment"],
      ["payment", true, "payment"],
      ["refund", true, "refund"],
      ["payment", true, "payment"],
      ["payment", false, null],
      ["dispute", false, null],
      ["adjustment", false, null],
    ]);
    expect(lines.find((l) => l.kind === "refund")?.sourceId).toBe(refundR2);
    // The dispute is traced to the payment it disputes, never counted as settling it.
    expect(lines.find((l) => l.kind === "dispute")?.orderId).toBe(lines[0]?.orderId);
    // Not yet paid out at 30 April: the payment of 28 April (paid out 2 May); the transfer
    // recorded by hand never reaches the provider and is in neither.
    const unpaid = r.rows.find((x) => x.type === "unpaid") as Row;
    expect(unpaid).toMatchObject({
      asAt: "2026-04-30",
      payments: 7000,
      refunds: 0,
      amount: 7000,
      sources: ["fake:evt_a4"],
    });
    expect(r.totals).toMatchObject({
      rows: 2,
      amount: 16953,
      fees: 1997,
      difference: 100,
      notPaidOut: 7000,
    });
  });

  it("every provider payment and refund is in exactly one payout, or not yet paid out", async () => {
    const all = (
      await env.DB.prepare(
        `SELECT provider || ':' || event_id AS id FROM core_order_payment WHERE method = 'provider'
         UNION ALL SELECT id FROM core_order_refund WHERE method = 'provider' AND status = 'confirmed'`,
      ).all<{ id: string }>()
    ).results
      .map((x) => x.id)
      .sort();
    for (const [month, now] of [
      ["2026-04", MAY5],
      ["2026-05", JUNE],
    ] as const) {
      const r = await report({ month }, now);
      const april = month === "2026-04" ? r : await report({ month: "2026-04" }, now);
      // Matched in April's or May's payouts, or still waiting at the month's end.
      const matched = [...april.rows, ...(month === "2026-05" ? r.rows : [])]
        .filter((x) => x.type === "line" && x.matched)
        .map((x) => x.sourceId as string);
      const waiting = (r.rows.find((x) => x.type === "unpaid")?.sources ?? []) as string[];
      // Once each: no payment or refund is matched by two lines, nor matched and waiting.
      expect(new Set(matched).size).toBe(matched.length);
      expect(matched.filter((id) => waiting.includes(id))).toEqual([]);
      expect([...matched, ...waiting].sort()).toEqual(all);
    }
  });

  it("is staff's with finance:read: a member is refused, the assistant reads for an admin", async () => {
    const refused = await refusal(report({ month: "2026-04" }, MAY5, member));
    expect(refused.code).toBe("forbidden");
    const read = await report({ month: "2026-04" }, MAY5, admin, "assistant");
    expect(payoutRow(read, p1.ref)?.amount).toBe(16553);
    // The read itself is the host's: no person or agent runs it.
    const sync = await refusal(call("finance.payouts.sync", {}, admin, MAY5));
    expect(["forbidden", "not_found", "unknown_operation"]).toContain(sync.code);
  });
});

let aprilEntries: EntriesOut;
let aprilFile: string;

describe("closing April: one payout entry per payout, each balanced", () => {
  it("writes payout entries from the same lines as the report", async () => {
    const preview = await report({ month: "2026-04" });
    await call("finance.close", { month: "2026-04" }, admin, MAY5);
    aprilEntries = await call<EntriesOut>("finance.entries", { month: "2026-04" }, admin, MAY5);
    for (const e of aprilEntries.entries) expect(balanced(e)).toBe(true);
    const e1 = aprilEntries.entries.find((e) => e.key === `payout:${p1.ref}`);
    expect(e1).toMatchObject({ kind: "payout", date: "2026-04-15", belongsTo: null });
    expect(linesOf(e1 as EntriesOut["entries"][number])).toEqual({
      "bank debit": 16553,
      "fees:provider debit": 1997,
      "money_out:provider debit": 2000,
      "disputes debit": 1000,
      "money_in:provider credit": 17500,
      "unmatched credit": 4000,
      "adjustments credit": 50,
    });
    const e2 = aprilEntries.entries.find((e) => e.key === `payout:${p2.ref}`);
    expect(linesOf(e2 as EntriesOut["entries"][number])).toEqual({
      "bank debit": 400,
      "adjustments credit": 300,
      "unmatched credit": 100,
    });
    // The closed report is the preview as it was.
    const closed = await report({ month: "2026-04" });
    expect(closed.preview).toBe(false);
    expect(closed.rows).toEqual(preview.rows);
    aprilFile = (
      await call<{ csv: string }>(
        "finance.export",
        { report: "payouts", month: "2026-04" },
        admin,
        MAY5,
      )
    ).csv;
    expect(aprilFile).toContain('"Payouts arriving"');
    expect(aprilFile).toContain(`"${p1.ref}",`);
  });
});

describe("a recorded payout never changes (proof c)", () => {
  it("is refused every write: update, delete, replace, upsert, update or replace", async () => {
    const tries = [
      "UPDATE core_payout SET amount = 1 WHERE ref = ?1",
      "DELETE FROM core_payout WHERE ref = ?1",
      "INSERT OR REPLACE INTO core_payout (provider, ref, amount, currency, arrival_date, status, itemised, line_count, lines_net, created_at, read_at) VALUES ('fake', ?1, 1, 'NZD', '2026-04-15', 'paid', 1, 0, 0, 'x', 'x')",
      "INSERT INTO core_payout (provider, ref, amount, currency, arrival_date, status, itemised, line_count, lines_net, created_at, read_at) VALUES ('fake', ?1, 1, 'NZD', '2026-04-15', 'paid', 1, 7, 16553, 'x', 'x') ON CONFLICT (provider, ref) DO UPDATE SET amount = 1",
      "UPDATE OR REPLACE core_payout SET amount = 1 WHERE ref = ?1",
      "UPDATE core_payout_line SET amount = 1 WHERE payout_ref = ?1",
      "DELETE FROM core_payout_line WHERE payout_ref = ?1",
      "UPDATE OR REPLACE core_payout_line SET fee = 0 WHERE payout_ref = ?1",
      "INSERT OR REPLACE INTO core_payout_line (provider, ref, payout_ref, kind, amount, fee, currency, occurred_at) SELECT provider, ref, payout_ref, kind, 1, 0, currency, occurred_at FROM core_payout_line WHERE payout_ref = ?1",
      // A new line onto a payout already recorded.
      "INSERT INTO core_payout_line (provider, ref, payout_ref, kind, amount, fee, currency, occurred_at) VALUES ('fake', 'ftx_new', ?1, 'adjustment', 5, 0, 'NZD', 'x')",
    ];
    for (const q of tries) {
      await expect(env.DB.prepare(q).bind(p1.ref).run(), q).rejects.toThrow(/core_payout_fixed/);
    }
    // A payout whose lines are not those read for it is refused too.
    await expect(
      env.DB.prepare(
        "INSERT INTO core_payout (provider, ref, amount, currency, arrival_date, status, itemised, line_count, lines_net, created_at, read_at) VALUES ('fake', 'fpo_made_up', 100, 'NZD', '2026-04-15', 'paid', 1, 1, 100, 'x', 'x')",
      ).run(),
    ).rejects.toThrow(/core_payout_fixed/);
    expect(
      await env.DB.prepare("SELECT amount, lines_net FROM core_payout WHERE ref = ?")
        .bind(p1.ref)
        .first(),
    ).toEqual({ amount: 16553, lines_net: 16553 });
  });

  it("the provider reporting something else of a recorded payout rewrites nothing", async () => {
    // The provider now says the payout was for another amount: the host keeps what it recorded.
    const provider = double.payouts.find((p) => p.ref === p2.ref) as DoublePayout;
    provider.amount = 999_999;
    await sync(MAY7);
    expect(
      await env.DB.prepare("SELECT amount FROM core_payout WHERE ref = ?").bind(p2.ref).first(),
    ).toEqual({ amount: 400 });
    provider.amount = 400;
  });
});

describe("after April closed (proof d, and a correction as a new entry)", () => {
  let p5: DoublePayout;
  it("a payout arriving in closed April, read in May, is May's, late, and April stays as it was", async () => {
    p5 = double.pay("2026-04-25", [
      { kind: "adjustment", amount: 700, fee: 0, paymentRef: null, refundRef: null },
    ]);
    // P3 came back from the bank: the provider now reports it failed (within the days each read
    // looks back over, as a bank's return is).
    (double.payouts.find((p) => p.ref === p3.ref) as DoublePayout).status = "failed";
    const read = await sync("2026-05-08T00:00:00.000Z");
    expect(read).toMatchObject({ recorded: 1, failed: 1 });
    // A second read records neither again.
    await sync("2026-05-09T00:00:00.000Z");
    expect(await count("core_payout_failure")).toBe(1);
    expect(
      await env.DB.prepare("SELECT date FROM core_payout_failure WHERE payout_ref = ?")
        .bind(p3.ref)
        .first(),
    ).toEqual({ date: "2026-05-08" });

    const april = await report({ month: "2026-04" }, JUNE);
    expect(april.preview).toBe(false);
    expect(payoutRow(april, p5.ref)).toBeUndefined();
    expect(
      (
        await call<{ csv: string }>(
          "finance.export",
          { report: "payouts", month: "2026-04" },
          admin,
          JUNE,
        )
      ).csv,
    ).toBe(aprilFile);

    const may = await report({ month: "2026-05" }, JUNE);
    expect(payoutRow(may, p5.ref)).toMatchObject({ belongsTo: "2026-04", amount: 700 });
    expect(payoutRow(may, p3.ref)).toMatchObject({ belongsTo: null, payments: 7000 });
    expect(may.rows.find((x) => x.type === "failure")).toMatchObject({
      payoutRef: p3.ref,
      date: "2026-05-08",
      arrivalDate: "2026-05-02",
      amount: 6847,
    });
    expect(may.totals.failed).toBe(6847);

    await call("finance.close", { month: "2026-05" }, admin, JUNE);
    const entries = await call<EntriesOut>("finance.entries", { month: "2026-05" }, admin, JUNE);
    for (const e of entries.entries) expect(balanced(e)).toBe(true);
    const late = entries.entries.find((e) => e.key === "late:2026-04@2026-05-01");
    expect(late).toMatchObject({ kind: "late", belongsTo: "2026-04" });
    expect(linesOf(late as EntriesOut["entries"][number])).toEqual({
      "bank debit": 700,
      "adjustments credit": 700,
    });
    // The payout's own entry stays as it arrived; its failure is an entry of its own.
    const arrived = entries.entries.find((e) => e.key === `payout:${p3.ref}`);
    expect(linesOf(arrived as EntriesOut["entries"][number])).toEqual({
      "bank debit": 6847,
      "fees:provider debit": 153,
      "money_in:provider credit": 7000,
    });
    const failed = entries.entries.find((e) => e.key === `payout:${p3.ref}:failed`);
    expect(failed).toMatchObject({ kind: "payout", date: "2026-05-08" });
    expect(linesOf(failed as EntriesOut["entries"][number])).toEqual({
      "adjustments debit": 6847,
      "bank credit": 6847,
    });
    // April's entries are as they were closed.
    const againApril = await call<EntriesOut>("finance.entries", { month: "2026-04" }, admin, JUNE);
    expect(againApril.entries).toEqual(aprilEntries.entries);
    // And the recorded payout itself never changed.
    expect(
      await env.DB.prepare("SELECT amount, status FROM core_payout WHERE ref = ?")
        .bind(p3.ref)
        .first(),
    ).toEqual({ amount: 6847, status: "paid" });
  });
});

describe("a read that fails soft", () => {
  it("a key that may not read payouts: the report says so; nothing breaks", async () => {
    double.mode.reads = "unavailable";
    const read = await sync("2026-06-04T00:00:00.000Z");
    expect(read?.state).toBe("unavailable");
    const june = await report({ month: "2026-06" }, "2026-06-04T00:00:00.000Z");
    expect(june.notes.some((n) => /not available for this connection/.test(n))).toBe(true);
    // Tried again the next day, not every minute.
    expect(await sync("2026-06-04T00:05:00.000Z")).toBeNull();
    double.mode.reads = "ok";
    expect((await sync("2026-06-05T00:00:00.000Z"))?.state).toBe("ok");
  });

  it("a failing provider is retried later, keeping its place, and records nothing twice", async () => {
    double.mode.reads = "error";
    const failed = await sync("2026-06-06T00:00:00.000Z");
    expect(failed?.state).toBe("failing");
    expect(await sync("2026-06-06T00:10:00.000Z")).toBeNull();
    double.mode.reads = "ok";
    const again = await sync("2026-06-06T00:16:00.000Z");
    expect(again?.state).toBe("ok");
    expect(await count("core_payout")).toBe(4);
  });
});
