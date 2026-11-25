// Stage 52's book with stage 35's invoices (review of PR #460, item 7): each payment applied to an
// invoice's order carries its share of the document's tax, and each refund the refunded payment's
// share, so tax collected on invoice payments is the document's (never zero), a refund's tax is
// its own (an 11.00 refund of a 110.00 invoice gives back 1.00, not the invoice's 10.00), and
// `rec_order.net` is nothing for an invoice nothing was paid on, unpaid or voided.
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { localMonthAt } from "../src/finance/day.ts";
import { type ActingUser, memoryEventSink } from "../src/index.ts";
import { context, createUser, unique } from "./helpers.ts";
import { CURRENCY, run } from "./order-fixtures.ts";
import { paymentsDouble } from "./payments-double.ts";

const ZONE = "Australia/Sydney";
const TODAY = new Date().toISOString().slice(0, 10);

const events = memoryEventSink();
const payments = paymentsDouble(() => events);
const { runtime } = payments;
let admin: ActingUser;
let personId: string;

const staff = () => context(admin, { integrations: runtime, events });

async function versionOf(table: "core_invoice" | "core_credit_note", id: string) {
  return (
    (await env.DB.prepare(`SELECT version FROM ${table} WHERE id = ?`).bind(id).first()) as {
      version: number;
    }
  ).version;
}

/** An invoice of one typed line, 110.00 with 10.00 GST inside, issued. */
async function invoice110(): Promise<{ id: string; orderId: string; lineId: string }> {
  const draft = await run<{ id: string; lines: { id: string }[] }>(
    "invoice.create",
    {
      billTo: { personId },
      lines: [{ description: unique("Workshop"), quantity: 1, unitPrice: 11_000 }],
    },
    staff(),
  );
  const issued = await run<{ id: string; orderId: string }>(
    "invoice.issue",
    { id: draft.id, version: await versionOf("core_invoice", draft.id) },
    staff(),
  );
  return { id: issued.id, orderId: issued.orderId, lineId: draft.lines[0]?.id as string };
}

async function record(invoiceId: string, amount: number) {
  return run<{ paymentId: string }>(
    "invoice.recordPayment",
    {
      invoiceId,
      amount,
      kind: "transfer",
      receivedOn: TODAY,
      version: await versionOf("core_invoice", invoiceId),
    },
    staff(),
  );
}

beforeAll(async () => {
  admin = await createUser("admin");
  await env.DB.prepare(
    "INSERT INTO core_settings (key, value, updated_at) VALUES ('org_timezone', ?, 'now') ON CONFLICT (key) DO UPDATE SET value = excluded.value",
  )
    .bind(JSON.stringify(ZONE))
    .run();
  await run(
    "order.settings.update",
    { currency: CURRENCY, returnOrigins: ["https://shop.example.com"] },
    context(admin),
  );
  await run(
    "invoice.settings.update",
    { taxRates: [{ key: "gst", label: "GST", rate: 1000 }], defaultTaxRate: "gst" },
    context(admin),
  );
  personId = (
    await run<{ id: string }>(
      "person.create",
      { givenName: unique("Fin"), emails: [{ email: `${unique("fin")}@example.com` }] },
      context(admin),
    )
  ).id;
}, 60_000);

async function orderRow(id: string) {
  return (await env.DB.prepare(
    "SELECT o.tax_amount, o.tax_refunded, v.net FROM core_order o JOIN rec_order v ON v.id = o.id WHERE o.id = ?",
  )
    .bind(id)
    .first()) as { tax_amount: number; tax_refunded: number; net: number };
}

describe("invoice payments and refunds in the book (review item 7)", () => {
  it("each payment carries its share of the document's tax; the shares add up to it", async () => {
    const inv = await invoice110();
    // Nothing paid: no tax collected, and nothing net.
    expect(await orderRow(inv.orderId)).toEqual({ tax_amount: 0, tax_refunded: 0, net: 0 });
    await record(inv.id, 3_333);
    await record(inv.id, 7_667);
    const { results } = await env.DB.prepare(
      "SELECT amount, tax_amount FROM core_order_payment WHERE order_id = ? ORDER BY received_at, amount",
    )
      .bind(inv.orderId)
      .all<{ amount: number; tax_amount: number }>();
    // 10.00 of tax: 3.03 on the first payment (half up), and what is left on the last.
    expect(results.map((r) => r.tax_amount).sort((a, b) => a - b)).toEqual([303, 697]);
    expect(await orderRow(inv.orderId)).toEqual({
      tax_amount: 1_000,
      tax_refunded: 0,
      net: 10_000,
    });
    // The month's tax report counts it as tax collected, not nothing.
    const month = localMonthAt(Math.floor(Date.now() / 1000), ZONE);
    const tax = await run<{ totals: Record<string, number> }>(
      "finance.report",
      { report: "tax", month },
      context(admin),
    );
    expect(tax.totals.taxOnSales).toBeGreaterThanOrEqual(1_000);
  });

  it("an 11.00 refund of a 110.00 invoice gives back 1.00 of tax, not the invoice's 10.00", async () => {
    const inv = await invoice110();
    const paid = await record(inv.id, 1_100);
    expect(await orderRow(inv.orderId)).toMatchObject({ tax_amount: 100 });
    // Credited in full: 99.00 owed is taken off, the 11.00 paid goes back by hand.
    const note = await run<{ id: string }>(
      "creditNote.create",
      { invoiceId: inv.id, lines: [{ lineId: inv.lineId }], reason: "Cancelled", settle: "both" },
      staff(),
    );
    await run(
      "creditNote.issue",
      { id: note.id, version: await versionOf("core_credit_note", note.id) },
      staff(),
    );
    await run(
      "order.recordRefund",
      { id: inv.orderId, paymentId: paid.paymentId, kind: "transfer", reason: "Cancelled" },
      staff(),
    );
    const refund = await env.DB.prepare(
      "SELECT amount, tax_amount FROM core_order_refund WHERE order_id = ?",
    )
      .bind(inv.orderId)
      .first();
    expect(refund).toEqual({ amount: 1_100, tax_amount: 100 });
    expect(await orderRow(inv.orderId)).toEqual({ tax_amount: 100, tax_refunded: 100, net: 0 });
    const month = localMonthAt(Math.floor(Date.now() / 1000), ZONE);
    const report = await run<{ rows: Record<string, unknown>[] }>(
      "finance.report",
      { report: "refunds", month },
      context(admin),
    );
    const row = report.rows.find((r) => r.orderId === inv.orderId);
    expect(row).toBeDefined();
    expect(JSON.stringify(row)).not.toContain('"estimated":true');
  });

  it("a voided invoice has no tax and nothing net", async () => {
    const inv = await invoice110();
    await run(
      "invoice.void",
      { id: inv.id, reason: "Twice", version: await versionOf("core_invoice", inv.id) },
      staff(),
    );
    expect(await orderRow(inv.orderId)).toEqual({ tax_amount: 0, tax_refunded: 0, net: 0 });
  });
});
