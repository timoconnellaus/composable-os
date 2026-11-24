// Stage 52 step 3 (ADRs 0791 and 0796): the day summaries, Sales, Tax and Refunds, their files and
// `finance.entries`, against a month worked out by hand. April 2026 in Auckland (UTC+13 until the
// clocks go back at 03:00 on 5 April, then UTC+12): a payment at 00:30 local on 1 April and on
// 3 April (still 31 March and 2 April in UTC), a payment at 00:30 on 1 May (in May, though it is
// 30 April in UTC), an order of two lines at two tax codes with a discount on one, a deposit on an
// untaxed order, a one-off refund with no tax figure from the provider (an estimate) and a
// membership period's refund with one, a late payment never honoured and its refund (neither is a
// sale), and a payment in another currency (listed, never summed). Orders are written as the
// order code leaves them (real tables, real triggers); every clock is injected.
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { closePlan, periodBook, readGuards } from "../src/finance/close.ts";
import { monthRange } from "../src/finance/day.ts";
import { type ActingUser, type Actor, invokeByName, newId } from "../src/index.ts";
import type { HandlerContext } from "../src/operation.ts";
import { extId, manifest, reconcile } from "./extension-helpers.ts";
import { context, createUser, db } from "./helpers.ts";

const ZONE = "Pacific/Auckland";
const CURRENCY = "NZD";
const at = (iso: string) => () => new Date(iso);
const MAY = "2026-05-03T00:00:00.000Z";
const JUNE = "2026-06-03T00:00:00.000Z";

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
    context(user, { actor, origin: { surface }, clock: at(now) }),
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

async function setSetting(key: string, value: unknown) {
  await env.DB.prepare(
    "INSERT INTO core_settings (key, value, updated_at) VALUES (?, ?, 'now') ON CONFLICT (key) DO UPDATE SET value = excluded.value",
  )
    .bind(key, JSON.stringify(value))
    .run();
}

const EXT = extId("fin");
const PASS = `${EXT}.pass`;
const PLAN = `${EXT}.plan`;
const TICKET = `${EXT}.ticket`;
const GOODS = `${EXT}.goods`;
const PLAIN = `${EXT}.plain`;

interface Line {
  object: string;
  title: string;
  total: number;
  discount?: number;
  tax?: number;
  code?: string;
}

/** An order as the order code leaves it once its payments and refunds below have applied. */
async function order(
  lines: Line[],
  money: { paid: number; refunded?: number; tax?: number; taxRefunded?: number; country?: string },
  personId: string | null = null,
  currency = CURRENCY,
): Promise<string> {
  const id = newId("order");
  const now = "2026-04-01T00:00:00.000Z";
  const total = lines.reduce((n, l) => n + l.total - (l.discount ?? 0), 0);
  await env.DB.prepare(
    `INSERT INTO core_order (id, person_id, email, currency, total, paid, refunded, state, placed_as,
       tax_amount, tax_refunded, tax_country, discount, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'public', ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      personId,
      personId ? "buyer@buyers.example" : null,
      currency,
      total,
      money.paid,
      money.refunded ?? 0,
      money.paid >= total ? "paid" : "part_paid",
      money.tax ?? 0,
      money.taxRefunded ?? 0,
      money.country ?? null,
      lines.reduce((n, l) => n + (l.discount ?? 0), 0),
      now,
      now,
    )
    .run();
  for (const [i, l] of lines.entries()) {
    await env.DB.prepare(
      `INSERT INTO core_order_line (id, order_id, position, object_type, record_id, title, quantity,
         unit_price, line_total, line_discount, tax_amount, tax_code, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        newId("orderLine"),
        id,
        i + 1,
        l.object,
        `rec_${l.title.replace(/\W/g, "")}`,
        l.title,
        l.total,
        l.total,
        l.discount ?? 0,
        l.tax ?? 0,
        l.code ?? null,
        now,
      )
      .run();
  }
  return id;
}

let events = 0;
async function payment(
  orderId: string,
  amount: number,
  receivedAt: string,
  tax: { amount: number; country: string } | null = null,
  extra: { outcome?: string; ref?: string; currency?: string } = {},
) {
  events += 1;
  await env.DB.prepare(
    `INSERT INTO core_order_payment (provider, event_id, order_id, amount, currency, outcome,
       payment_ref, received_at, tax_amount, tax_country)
     VALUES ('fake', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      `fevt_${events}`,
      orderId,
      amount,
      extra.currency ?? CURRENCY,
      extra.outcome ?? "applied",
      extra.ref ?? `fpi_${events}`,
      receivedAt,
      tax?.amount ?? null,
      tax?.country ?? null,
    )
    .run();
}

async function refund(
  orderId: string,
  amount: number,
  confirmedAt: string,
  tax: number | null,
  requestedBy: string | null,
  paymentRef: string | null = null,
): Promise<string> {
  const id = newId("refund");
  await env.DB.prepare(
    `INSERT INTO core_order_refund (id, order_id, provider, payment_ref, amount, currency, reason,
       status, requested_by, requested_at, confirmed_at, created_at, tax_amount)
     VALUES (?, ?, 'fake', ?, ?, ?, 'Class cancelled', 'confirmed', ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      orderId,
      paymentRef,
      amount,
      CURRENCY,
      requestedBy,
      confirmedAt,
      confirmedAt,
      confirmedAt,
      tax,
    )
    .run();
  return id;
}

type Row = Record<string, unknown>;
interface ReportOut {
  preview: boolean;
  version: number | null;
  currency: string | null;
  notes: string[];
  rows: Row[];
  totals: Record<string, number>;
}
interface EntriesOut {
  version: number;
  entries: {
    key: string;
    kind: string;
    date: string;
    belongsTo: string | null;
    fingerprint: string;
    lines: { heading: string; side: string; amount: number }[];
  }[];
  next: number | null;
}
interface FileOut {
  filename: string;
  csv: string;
  preview: boolean;
  version: number | null;
}

/** An entry's lines as `heading side` → amount. */
const linesOf = (entry: EntriesOut["entries"][number]) =>
  Object.fromEntries(entry.lines.map((l) => [`${l.heading} ${l.side}`, l.amount]));

let admin: ActingUser;
let member: ActingUser;
let personId: string;
let o1: string;
let o5: string;
let o9: string;
let refundO1: string;

beforeAll(async () => {
  admin = await createUser("admin");
  member = await createUser("member");
  await setSetting("org_timezone", ZONE);
  await setSetting("order_currency", CURRENCY);
  await setSetting("finance_installed_at", "2026-04-02T00:00:00.000Z");
  const priced = (label: string, category?: { key: string; label: string }) => ({
    label,
    plural: `${label}s`,
    titleField: "name",
    fields: {
      name: { type: "text" as const, label: "Name", required: true },
      price: { type: "currency" as const, label: "Price", currency: CURRENCY },
    },
    sellable: { price: "price", ...(category ? { finance: { category } } : {}) },
  });
  await reconcile(
    manifest(EXT, {
      objects: {
        pass: priced("Pass", { key: "passes", label: "Class passes" }),
        plan: priced("Plan", { key: "memberships", label: "Memberships" }),
        ticket: priced("Ticket", { key: "tickets", label: "Tickets" }),
        goods: priced("Goods", { key: "goods", label: "Goods" }),
        plain: priced("Plain"),
      },
    }),
  );
  personId = (
    (await call("person.create", { givenName: "Ada", familyName: "Buyer" }, admin, MAY)) as {
      id: string;
    }
  ).id;

  // 1 April 00:30 local (NZDT, +13) = 31 March 11:30 UTC. Untaxed goods, 2,000.
  o9 = await order([{ object: GOODS, title: "Towel", total: 2000 }], { paid: 2000 });
  await payment(o9, 2000, "2026-03-31T11:30:00.000Z");
  // 3 April 00:30 local = 2 April 11:30 UTC. A pass, 11,000 with 1,000 tax; half refunded on
  // 20 April with no tax figure from the provider (an estimate: 5,500 x 1,000 / 11,000 = 500).
  o1 = await order(
    [{ object: PASS, title: "Ten class pass", total: 11000, tax: 1000, code: "txcd_A" }],
    { paid: 11000, refunded: 5500, tax: 1000, country: "NZ" },
    personId,
  );
  await payment(o1, 11000, "2026-04-02T11:30:00.000Z", { amount: 1000, country: "NZ" });
  refundO1 = await refund(o1, 5500, "2026-04-20T02:00:00.000Z", null, admin.id);
  // 5 April 11:00 local, after the clocks went back (NZST, +12). A membership period, 22,000 with
  // 2,000 tax; half refunded on 25 April through its credit note, which said 1,000 tax.
  o5 = await order(
    [{ object: PLAN, title: "Monthly membership", total: 22000, tax: 2000, code: "txcd_M" }],
    { paid: 22000, refunded: 11000, tax: 2000, taxRefunded: 1000, country: "NZ" },
  );
  await payment(o5, 22000, "2026-04-04T23:00:00.000Z", { amount: 2000, country: "NZ" });
  await refund(o5, 11000, "2026-04-25T02:00:00.000Z", 1000, admin.id);
  // 10 April: two lines at two codes, 1,000 off the bottle: 6,000 and 3,000, tax 600 and 300.
  await payment(
    await order(
      [
        { object: TICKET, title: "Gala ticket", total: 6000, tax: 600, code: "txcd_T" },
        {
          object: GOODS,
          title: '=HYPERLINK("http://x.example")',
          total: 4000,
          discount: 1000,
          tax: 300,
          code: "txcd_G",
        },
      ],
      { paid: 9000, tax: 900, country: "NZ" },
    ),
    9000,
    "2026-04-10T01:00:00.000Z",
    { amount: 900, country: "NZ" },
  );
  // 15 April: a deposit of 3,000 on 10,000, untaxed, of an object declaring no category (Other).
  await payment(
    await order([{ object: PLAIN, title: "Workshop", total: 10000 }], { paid: 3000 }),
    3000,
    "2026-04-15T01:00:00.000Z",
  );
  // 12 April: a payment for an order that had closed (late, not honoured), refunded on the 13th.
  const late = await order([{ object: GOODS, title: "Late mat", total: 1500 }], {
    paid: 0,
    refunded: 1500,
  });
  await payment(late, 1500, "2026-04-12T01:00:00.000Z", null, { outcome: "late", ref: "fpi_late" });
  await refund(late, 1500, "2026-04-13T01:00:00.000Z", null, admin.id, "fpi_late");
  // 14 April: in another currency.
  await payment(
    await order([{ object: GOODS, title: "Import", total: 700 }], { paid: 700 }, null, "USD"),
    700,
    "2026-04-14T01:00:00.000Z",
    null,
    { currency: "USD" },
  );
  // 1 May 00:30 local (NZST, +12) = 30 April 12:30 UTC: May's.
  await payment(
    await order([{ object: GOODS, title: "May mat", total: 800 }], { paid: 800 }),
    800,
    "2026-04-30T12:30:00.000Z",
  );
});

const report = (r: string, input: Record<string, unknown>, now = MAY, user = admin) =>
  call<ReportOut>("finance.report", { report: r, ...input }, user, now);
const item = (rows: Row[], title: string) =>
  rows.find((r) => r.type === "item" && r.title === title) as Row;

describe("April by hand", () => {
  it("Sales: every item's figures, a discount beside, the other currency apart", async () => {
    const sales = await report("sales", { month: "2026-04" });
    expect(sales).toMatchObject({ preview: true, version: null, currency: CURRENCY });
    expect(item(sales.rows, "Ten class pass")).toMatchObject({
      category: "passes",
      categoryLabel: "Class passes",
      sold: 11000,
      refunded: 5500,
      net: 5500,
      taxOnSales: 1000,
      taxRefunded: 0,
      taxRefundedEstimated: 500,
      tax: 500,
      netOfTax: 5000,
      orders: [o1],
      orderCount: 1,
    });
    expect(item(sales.rows, "Monthly membership")).toMatchObject({
      sold: 22000,
      refunded: 11000,
      taxRefunded: 1000,
      tax: 1000,
      netOfTax: 10000,
    });
    expect(item(sales.rows, "Gala ticket")).toMatchObject({ sold: 6000, tax: 600, netOfTax: 5400 });
    expect(item(sales.rows, '=HYPERLINK("http://x.example")')).toMatchObject({
      sold: 3000,
      discounts: 1000,
      tax: 300,
      netOfTax: 2700,
    });
    expect(item(sales.rows, "Towel")).toMatchObject({ sold: 2000, tax: 0, netOfTax: 2000 });
    expect(item(sales.rows, "Workshop")).toMatchObject({
      category: "other",
      categoryLabel: "Other",
      sold: 3000,
      netOfTax: 3000,
    });
    // Neither the late payment nor its refund, nor May's payment, is in April's sales.
    expect(item(sales.rows, "Late mat")).toBeUndefined();
    expect(item(sales.rows, "May mat")).toBeUndefined();
    expect(sales.rows.filter((r) => r.type === "exception")).toEqual([
      expect.objectContaining({ currency: "USD", amount: 700, date: "2026-04-14" }),
    ]);
    expect(sales.totals).toMatchObject({
      sold: 47000,
      refunded: 16500,
      net: 30500,
      tax: 2400,
      netOfTax: 28100,
      discounts: 1000,
    });
    // By day: the 00:30 payments are on their local days.
    const days = sales.rows.filter((r) => r.type === "day");
    expect(days.map((d) => `${d.date} ${d.category}`)).toEqual([
      "2026-04-01 goods",
      "2026-04-03 passes",
      "2026-04-05 memberships",
      "2026-04-10 goods",
      "2026-04-10 tickets",
      "2026-04-15 other",
      "2026-04-20 passes",
      "2026-04-25 memberships",
    ]);
  });

  it("Sales' net of tax is rec_order.net's movement, but for the estimate", async () => {
    const sales = await report("sales", { month: "2026-04" });
    const { results } = await env.DB.prepare(
      `SELECT coalesce(sum(net), 0) AS net FROM rec_order WHERE id IN (
         SELECT order_id FROM core_order_payment WHERE outcome = 'applied' AND currency = ?
           AND received_at >= ? AND received_at < ?)`,
    )
      .bind(CURRENCY, "2026-03-31T11:00:00.000Z", "2026-04-30T12:00:00.000Z")
      .all<{ net: number }>();
    // rec_order.net keeps only the provider's refund tax as given back; Sales also gives back
    // the estimate.
    expect((sales.totals.netOfTax ?? 0) - (sales.totals.taxRefundedEstimated ?? 0)).toBe(
      results[0]?.net,
    );
  });

  it("Tax: by code and country, the estimate marked, untaxed sales beside", async () => {
    const tax = await report("tax", { month: "2026-04" });
    const rate = (code: string | null) => tax.rows.find((r) => r.taxCode === code) as Row;
    expect(rate("txcd_A")).toMatchObject({
      type: "rate",
      taxCountry: "NZ",
      sold: 11000,
      taxOnSales: 1000,
      refunded: 5500,
      taxRefundedEstimated: 500,
    });
    expect(rate("txcd_M")).toMatchObject({ sold: 22000, taxOnSales: 2000, taxRefunded: 1000 });
    expect(rate("txcd_T")).toMatchObject({ sold: 6000, taxOnSales: 600 });
    expect(rate("txcd_G")).toMatchObject({ sold: 3000, taxOnSales: 300 });
    expect(rate(null)).toMatchObject({ type: "untaxed", sold: 5000, taxOnSales: 0 });
    expect(tax.totals).toMatchObject({ sold: 47000, refunded: 16500, tax: 2400 });
    expect(tax.notes.join(" ")).toContain("the payment provider's own tax report is the authority");
  });

  it("Refunds: each confirmed refund, its tax as reported or estimated, who asked, the customer", async () => {
    const refunds = await report("refunds", { month: "2026-04" });
    expect(refunds.rows).toHaveLength(2);
    expect(refunds.rows[0]).toMatchObject({
      refundId: refundO1,
      orderId: o1,
      date: "2026-04-20",
      items: ["Ten class pass"],
      amount: 5500,
      method: "provider",
      tax: 500,
      taxEstimated: true,
      requestedByName: "admin user",
      name: "Ada Buyer",
      email: "buyer@buyers.example",
    });
    expect(refunds.rows[1]).toMatchObject({ orderId: o5, tax: 1000, taxEstimated: false });
    expect(refunds.totals).toMatchObject({ amount: 16500, tax: 1500 });
  });

  it("a span of days is previewed in the business's days", async () => {
    const span = await report("sales", { start: "2026-04-01", end: "2026-04-03" });
    expect(span.preview).toBe(true);
    expect(span.totals.sold).toBe(13000);
    expect((await refusal(report("sales", { start: "2026-04-01", end: "2027-06-01" }))).code).toBe(
      "invalid_input",
    );
    expect((await refusal(report("sales", { month: "2026-04", start: "2026-04-01" }))).code).toBe(
      "invalid_input",
    );
  });
});

describe("closing April, the files and the entries", () => {
  let v1Sales: FileOut;
  let v1: EntriesOut;

  it("a preview's file says so on its first row; a preview has no entries", async () => {
    const file = await call<FileOut>(
      "finance.export",
      { report: "sales", month: "2026-04" },
      admin,
      MAY,
    );
    expect(file.preview).toBe(true);
    expect(file.csv.split("\r\n")[0]).toBe(
      '"PREVIEW: this period is not closed; its figures may still change"',
    );
    expect(file.filename).toBe("sales-2026-04-preview.csv");
    expect(
      (await refusal(call("finance.entries", { month: "2026-04" }, admin, MAY))).details?.rule,
    ).toBe("finance_period_not_closed");
  });

  it("the close writes one balanced day summary per day money moved, matching the reports", async () => {
    const closed = await call<{ version: number; entries: number }>(
      "finance.close",
      { month: "2026-04" },
      admin,
      MAY,
    );
    expect(closed).toMatchObject({ version: 1, entries: 7 });
    v1 = await call<EntriesOut>("finance.entries", { month: "2026-04" }, admin, MAY);
    expect(v1.entries.map((e) => e.key)).toEqual([
      "day:2026-04-01",
      "day:2026-04-03",
      "day:2026-04-05",
      "day:2026-04-10",
      "day:2026-04-15",
      "day:2026-04-20",
      "day:2026-04-25",
    ]);
    const byKey = Object.fromEntries(v1.entries.map((e) => [e.key, linesOf(e)]));
    expect(byKey["day:2026-04-03"]).toEqual({
      "money_in:provider debit": 11000,
      "sales:passes credit": 10000,
      "tax:txcd_A:NZ credit": 1000,
    });
    expect(byKey["day:2026-04-10"]).toEqual({
      "money_in:provider debit": 9000,
      "sales:tickets credit": 5400,
      "sales:goods credit": 2700,
      "tax:txcd_T:NZ credit": 600,
      "tax:txcd_G:NZ credit": 300,
    });
    expect(byKey["day:2026-04-20"]).toEqual({
      "refunds:passes debit": 5000,
      "tax_estimated:txcd_A:NZ debit": 500,
      "money_out:provider credit": 5500,
    });
    expect(byKey["day:2026-04-25"]).toEqual({
      "refunds:memberships debit": 10000,
      "tax:txcd_M:NZ debit": 1000,
      "money_out:provider credit": 11000,
    });
    // Every entry balances; the entries add up to Sales and Tax exactly.
    let sales = 0;
    let tax = 0;
    for (const e of v1.entries) {
      const debit = e.lines.filter((l) => l.side === "debit").reduce((n, l) => n + l.amount, 0);
      const credit = e.lines.filter((l) => l.side === "credit").reduce((n, l) => n + l.amount, 0);
      expect(debit).toBe(credit);
      for (const l of e.lines) {
        const sign = l.side === "credit" ? 1 : -1;
        if (/^(sales|refunds):/.test(l.heading)) sales += sign * l.amount;
        if (/^tax(_estimated)?:/.test(l.heading)) tax += sign * l.amount;
      }
    }
    const report = await call<ReportOut>(
      "finance.report",
      { report: "sales", month: "2026-04" },
      admin,
      MAY,
    );
    expect(report).toMatchObject({ preview: false, version: 1 });
    expect(sales).toBe(report.totals.netOfTax);
    expect(tax).toBe(report.totals.tax);
  });

  it("a closed file names its version, is guarded, and downloads the same every time", async () => {
    v1Sales = await call<FileOut>(
      "finance.export",
      { report: "sales", month: "2026-04" },
      admin,
      MAY,
    );
    expect(v1Sales).toMatchObject({ preview: false, version: 1, filename: "sales-2026-04-v1.csv" });
    const lines = v1Sales.csv.split("\r\n");
    expect(lines[0]).toBe('"Finance report","Sales"');
    expect(lines[1]).toBe('"Period","2026-04","2026-04-01","2026-04-30","Pacific/Auckland"');
    expect(lines[2]).toMatch(
      /^"Version",1,"Closed at","2026-05-03T00:00:00.000Z","Closed by","admin user"$/,
    );
    // The title a buyer saw is a formula to a spreadsheet: neutralised, every text cell quoted.
    expect(v1Sales.csv).toContain(`"'=HYPERLINK(""http://x.example"")"`);
    expect(v1Sales.csv).toContain(",11000,110.00,");
    const again = await call<FileOut>(
      "finance.export",
      { report: "sales", month: "2026-04" },
      admin,
      MAY,
    );
    expect(again.csv).toBe(v1Sales.csv);
    const tax = await call<FileOut>(
      "finance.export",
      { report: "tax", month: "2026-04" },
      admin,
      MAY,
    );
    expect(tax.csv).toContain("the payment provider's own tax report is the authority");
    expect(tax.csv).toContain('"estimate"');
  });

  it("something dated in closed April is counted once, late, in May; April is unchanged", async () => {
    // A payment the host records for April after April was closed (as a dated-back recorded
    // payment will, stage 34): on a goods order, 1,500 untaxed, on 28 April.
    await payment(
      await order([{ object: GOODS, title: "Dated back", total: 1500 }], { paid: 1500 }),
      1500,
      "2026-04-28T01:00:00.000Z",
    );
    const april = await call<FileOut>(
      "finance.export",
      { report: "sales", month: "2026-04" },
      admin,
      JUNE,
    );
    expect(april.csv).toBe(v1Sales.csv);
    const may = await call<ReportOut>(
      "finance.report",
      { report: "sales", month: "2026-05" },
      admin,
      JUNE,
    );
    expect(item(may.rows, "Dated back")).toMatchObject({ belongsTo: "2026-04", sold: 1500 });
    expect(item(may.rows, "May mat")).toMatchObject({ belongsTo: null, sold: 800 });
    await call("finance.close", { month: "2026-05" }, admin, JUNE);
    const entries = await call<EntriesOut>("finance.entries", { month: "2026-05" }, admin, JUNE);
    expect(entries.entries.map((e) => [e.key, e.kind, e.belongsTo])).toEqual([
      ["day:2026-05-01", "day", null],
      ["late:2026-04@2026-05-01", "late", "2026-04"],
    ]);
    expect(linesOf(entries.entries[1] as EntriesOut["entries"][number])).toEqual({
      "money_in:provider debit": 1500,
      "sales:goods credit": 1500,
    });
    const aprilEntries = await call<EntriesOut>(
      "finance.entries",
      { month: "2026-04" },
      admin,
      JUNE,
    );
    expect(aprilEntries).toEqual(v1);
  });

  it("reopened and closed again: version 2 keeps every key, and only a changed entry's fingerprint moves", async () => {
    await call(
      "finance.reopen",
      { month: "2026-05", reason: "April's refund tax came" },
      admin,
      JUNE,
    );
    await call(
      "finance.reopen",
      { month: "2026-04", reason: "The refund's credit note" },
      admin,
      JUNE,
    );
    // The provider's tax for the pass refund arrives: 450, not the estimate of 500.
    await env.DB.prepare("UPDATE core_order_refund SET tax_amount = 450 WHERE id = ?")
      .bind(refundO1)
      .run();
    await call("finance.close", { month: "2026-04" }, admin, JUNE);
    const v2 = await call<EntriesOut>("finance.entries", { month: "2026-04" }, admin, JUNE);
    expect(v2.version).toBe(2);
    const was = new Map(v1.entries.map((e) => [e.key, e.fingerprint]));
    for (const e of v2.entries) {
      if (e.key === "day:2026-04-20" || e.key === "day:2026-04-28") {
        expect(e.fingerprint).not.toBe(was.get(e.key));
      } else {
        expect(e.fingerprint).toBe(was.get(e.key));
      }
    }
    // The dated-back payment is April's own now, counted by its version 2.
    expect(v2.entries.map((e) => e.key)).toContain("day:2026-04-28");
    expect(
      linesOf(v2.entries.find((e) => e.key === "day:2026-04-20") as EntriesOut["entries"][number]),
    ).toEqual({
      "refunds:passes debit": 5050,
      "tax:txcd_A:NZ debit": 450,
      "money_out:provider credit": 5500,
    });
    // Version 1 still reads and downloads byte for byte as before.
    expect(await call("finance.entries", { month: "2026-04", version: 1 }, admin, JUNE)).toEqual({
      ...v1,
      state: "reopened",
    });
    const old = await call<FileOut>(
      "finance.export",
      { report: "sales", month: "2026-04", version: 1 },
      admin,
      JUNE,
    );
    expect(old.csv).toBe(v1Sales.csv);
    // May closed again no longer counts it: it is no one's late source twice.
    await call("finance.close", { month: "2026-05" }, admin, JUNE);
    const may = await call<EntriesOut>("finance.entries", { month: "2026-05" }, admin, JUNE);
    expect(may.entries.map((e) => e.key)).toEqual(["day:2026-05-01"]);
  });
});

describe("erase", () => {
  it("a person's name leaves every closed version's refunds; figures and entries stay", async () => {
    const before = await call<EntriesOut>(
      "finance.entries",
      { month: "2026-04", version: 1 },
      admin,
      JUNE,
    );
    await call("person.erase", { id: personId }, admin, JUNE);
    for (const version of [1, 2]) {
      const refunds = await call<ReportOut>(
        "finance.report",
        { report: "refunds", month: "2026-04", version },
        admin,
        JUNE,
      );
      const row = refunds.rows.find((r) => r.orderId === o1) as Row;
      expect(row).toMatchObject({ name: "Erased person", email: null, amount: 5500 });
      expect(refunds.totals.amount).toBe(16500);
    }
    expect(await call("finance.entries", { month: "2026-04", version: 1 }, admin, JUNE)).toEqual(
      before,
    );
  });
});

describe("the close's guard", () => {
  it("a payment applied between the close's read and its batch fails the close whole", async () => {
    const zone = ZONE;
    const range = monthRange("2026-06", zone);
    const ctx = { db: db.query, now: "2026-07-02T00:00:00.000Z" } as unknown as HandlerContext;
    const book = await periodBook(ctx, range);
    const values = await readGuards(ctx.db, book.guards);
    await payment(
      await order([{ object: GOODS, title: "Racing mat", total: 900 }], { paid: 900 }),
      900,
      "2026-06-10T01:00:00.000Z",
    );
    const plan = await closePlan(ctx, {
      id: newId("financePeriod"),
      month: "2026-06",
      range,
      version: 1,
      by: admin.id,
      book,
      guardValues: values,
    });
    await expect(db.batch(plan.statements)).rejects.toThrow(/core_finance_changed/);
    // Retried, it closes with the new payment in it.
    await call("finance.close", { month: "2026-06" }, admin, "2026-07-02T00:00:00.000Z");
    const sales = await call<ReportOut>(
      "finance.report",
      { report: "sales", month: "2026-06" },
      admin,
      "2026-07-02T00:00:00.000Z",
    );
    expect(item(sales.rows, "Racing mat")).toMatchObject({ sold: 900 });
  });
});

describe("who may", () => {
  it("a member is refused; an assistant reads reports and entries but never downloads", async () => {
    expect((await refusal(report("sales", { month: "2026-04" }, MAY, member))).code).toBe(
      "forbidden",
    );
    const read = await call<ReportOut>(
      "finance.report",
      { report: "refunds", month: "2026-04" },
      admin,
      JUNE,
      "assistant",
    );
    expect(read.rows.length).toBe(2);
    await call("finance.entries", { month: "2026-04" }, admin, JUNE, "mcp");
    expect(
      (
        await refusal(
          call("finance.export", { report: "sales", month: "2026-04" }, admin, JUNE, "assistant"),
        )
      ).code,
    ).toBe("forbidden");
  });

  it("the audit log names the report and version, never a figure", async () => {
    const { results } = await env.DB.prepare(
      "SELECT operation, result FROM core_audit WHERE operation IN ('finance.report', 'finance.export', 'finance.entries')",
    ).all<{ operation: string; result: string | null }>();
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
      expect(r.result ?? "").not.toMatch(/11000|5500|47000|HYPERLINK|Ada Buyer/);
    }
  });
});
