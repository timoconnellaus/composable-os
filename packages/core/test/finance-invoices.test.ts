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
    {
      taxRates: [
        { key: "gst", label: "GST", rate: 1000 },
        { key: "free", label: "GST free", rate: 0 },
      ],
      defaultTaxRate: "gst",
    },
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

// --- The second review of PR #460: mixed rates and credit notes (item 1) ---------------------------

/** An invoice of 100.00 with GST inside (9.09) and 50.00 GST free: 150.00 with 9.09 of tax. */
async function mixedInvoice() {
  const draft = await run<{ id: string; lines: { id: string; total: number; tax: number }[] }>(
    "invoice.create",
    {
      billTo: { personId },
      lines: [
        { description: unique("Coaching"), quantity: 1, unitPrice: 10_000, taxRate: "gst" },
        { description: unique("Room"), quantity: 1, unitPrice: 5_000, taxRate: "free" },
      ],
    },
    staff(),
  );
  const issued = await run<{ id: string; orderId: string; total: number; taxTotal: number }>(
    "invoice.issue",
    { id: draft.id, version: await versionOf("core_invoice", draft.id) },
    staff(),
  );
  return {
    ...issued,
    taxed: draft.lines[0] as { id: string },
    free: draft.lines[1] as { id: string },
  };
}

async function creditIssued(input: Record<string, unknown>) {
  const note = await run<{ id: string }>(
    "creditNote.create",
    { reason: "Fixture", ...input },
    staff(),
  );
  return run<{ id: string; refunds: { amount: number }[] }>(
    "creditNote.issue",
    { id: note.id, version: await versionOf("core_credit_note", note.id) },
    staff(),
  );
}

async function carried(orderId: string) {
  const row = (await env.DB.prepare(
    "SELECT tax_amount - tax_refunded AS net FROM core_order WHERE id = ?",
  )
    .bind(orderId)
    .first()) as { net: number };
  return row.net;
}

describe("mixed rates and credit notes (second review, item 1)", () => {
  it("T1: crediting and refunding the GST-free line gives back no tax", async () => {
    const inv = await mixedInvoice();
    expect(inv).toMatchObject({ total: 15_000, taxTotal: 909 });
    const paid = await record(inv.id, 15_000);
    expect(await carried(inv.orderId)).toBe(909);
    await creditIssued({ invoiceId: inv.id, lines: [{ lineId: inv.free.id }], settle: "refund" });
    await run(
      "order.recordRefund",
      { id: inv.orderId, paymentId: paid.paymentId, kind: "transfer", reason: "Room" },
      staff(),
    );
    const refund = await env.DB.prepare(
      "SELECT amount, tax_amount FROM core_order_refund WHERE order_id = ?",
    )
      .bind(inv.orderId)
      .first();
    expect(refund).toEqual({ amount: 5_000, tax_amount: null });
    expect(await carried(inv.orderId)).toBe(909);
  });

  it("T2: the GST-free part paid after the taxed line is credited carries no tax", async () => {
    const inv = await mixedInvoice();
    await creditIssued({ invoiceId: inv.id, lines: [{ lineId: inv.taxed.id }], settle: "reduce" });
    await record(inv.id, 5_000);
    const pay = await env.DB.prepare("SELECT tax_amount FROM core_order_payment WHERE order_id = ?")
      .bind(inv.orderId)
      .first();
    expect(pay).toEqual({ tax_amount: null });
    expect(await carried(inv.orderId)).toBe(0);
  });

  it("a tiny last payment never carries more tax than its amount", async () => {
    const inv = await mixedInvoice();
    await record(inv.id, 14_999);
    await record(inv.id, 1);
    const { results } = await env.DB.prepare(
      "SELECT amount, coalesce(tax_amount, 0) AS tax FROM core_order_payment WHERE order_id = ?",
    )
      .bind(inv.orderId)
      .all<{ amount: number; tax: number }>();
    for (const r of results) expect(r.tax).toBeLessThanOrEqual(r.amount);
    expect(await carried(inv.orderId)).toBe(909);
  });

  it("property: over random sequences, the tax kept never exceeds what is still asked, and is exactly it once settled by a payment or refund", async () => {
    // A seeded generator: the same sequences each run.
    let seed = 35;
    const random = (n: number) => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed % n;
    };
    let runs = 0;
    let settledByMoney = 0;
    let clamped = 0;
    for (let round = 0; round < 40; round += 1) {
      const inv = await mixedInvoice();
      const recorded: string[] = [];
      let settled = false;
      for (let step = 0; step < 8 && !settled; step += 1) {
        const order = await env.DB.prepare(
          "SELECT state, total, paid, credited, refunded FROM core_order WHERE id = ?",
        )
          .bind(inv.orderId)
          .first<{
            state: string;
            total: number;
            paid: number;
            credited: number;
            refunded: number;
          }>();
        if (!order || order.state === "cancelled" || order.state === "refunded") break;
        const owed = order.total - order.paid - order.credited;
        const choice = random(5);
        let moneyAct = false;
        let paymentAct = false;
        try {
          if (choice <= 1 && owed > 0) {
            const amount = Math.max(1, Math.min(owed, random(owed) + 1));
            recorded.push((await record(inv.id, amount)).paymentId);
            moneyAct = true;
            paymentAct = true;
          } else if (choice === 2 && recorded.length) {
            const paymentId = recorded.splice(random(recorded.length), 1)[0] as string;
            await run("invoice.reversePayment", { paymentId, reason: "Bounced" }, staff());
          } else if (choice === 3) {
            const byLine = random(2) === 0;
            const settle = (["reduce", "both", "refund"] as const)[random(3)];
            await creditIssued({
              invoiceId: inv.id,
              settle,
              ...(byLine
                ? { lines: [{ lineId: random(2) ? inv.taxed.id : inv.free.id, quantity: 0.5 }] }
                : { amount: { value: 500 + random(1_000), taxRate: random(2) ? "gst" : "free" } }),
            });
          } else {
            // Pay back what a credit note owes by hand, if any.
            const owedBack = await env.DB.prepare(
              "SELECT payment_ref FROM core_credit_note_refund WHERE order_id = ? AND method = 'recorded' AND paid_back_at IS NULL LIMIT 1",
            )
              .bind(inv.orderId)
              .first<{ payment_ref: string }>();
            if (owedBack) {
              await run(
                "order.recordRefund",
                { id: inv.orderId, paymentId: owedBack.payment_ref, kind: "cash", reason: "Back" },
                staff(),
              );
              moneyAct = true;
            }
          }
        } catch {
          // A refused act (nothing left to credit, owed first, reversal of one paid back) is fine.
          continue;
        }
        runs += 1;
        // What is still asked: the invoice less its credit notes, and the tax in it.
        const docs = (await env.DB.prepare(
          "SELECT i.total - coalesce((SELECT sum(total) FROM core_credit_note WHERE invoice_id = i.id AND state = 'issued'), 0) AS asked, i.tax_total - coalesce((SELECT sum(tax_total) FROM core_credit_note WHERE invoice_id = i.id AND state = 'issued'), 0) AS tax FROM core_invoice i WHERE i.id = ?",
        )
          .bind(inv.id)
          .first()) as { asked: number; tax: number };
        const now = await env.DB.prepare(
          "SELECT paid, refunded, tax_amount - tax_refunded AS kept FROM core_order WHERE id = ?",
        )
          .bind(inv.orderId)
          .first<{ paid: number; refunded: number; kept: number }>();
        if (!now) break;
        expect(now.kept).toBeGreaterThanOrEqual(0);
        if (moneyAct) {
          expect(now.kept, `round ${round} step ${step}`).toBeLessThanOrEqual(
            Math.max(0, docs.tax),
          );
          // Settled by a payment: exactly the tax still asked. (A refund only ever takes tax
          // off: when a credit note covered the rest first, what was carried stands, and the
          // credit note's own tax is the adjustment, ADR 0735.)
          if (paymentAct && now.paid - now.refunded >= docs.asked) {
            expect(now.kept, `round ${round} settled`).toBe(Math.max(0, docs.tax));
            settledByMoney += 1;
            settled = true;
          }
        }
      }
      // Then settle it with money: pay back what is owed back by hand, and pay what is owed.
      if (!settled) {
        for (;;) {
          const owedBack = await env.DB.prepare(
            "SELECT payment_ref FROM core_credit_note_refund WHERE order_id = ? AND method = 'recorded' AND paid_back_at IS NULL LIMIT 1",
          )
            .bind(inv.orderId)
            .first<{ payment_ref: string }>();
          if (!owedBack) break;
          await run(
            "order.recordRefund",
            { id: inv.orderId, paymentId: owedBack.payment_ref, kind: "cash", reason: "Back" },
            staff(),
          );
        }
        const order = await env.DB.prepare(
          "SELECT state, total, paid, credited FROM core_order WHERE id = ?",
        )
          .bind(inv.orderId)
          .first<{ state: string; total: number; paid: number; credited: number }>();
        const owed = order ? order.total - order.paid - order.credited : 0;
        if (order && owed > 0 && (order.state === "pending" || order.state === "part_paid")) {
          const last = await record(inv.id, owed);
          const docs = (await env.DB.prepare(
            "SELECT i.tax_total - coalesce((SELECT sum(tax_total) FROM core_credit_note WHERE invoice_id = i.id AND state = 'issued'), 0) AS tax FROM core_invoice i WHERE i.id = ?",
          )
            .bind(inv.id)
            .first()) as { tax: number };
          const lastTax = (await env.DB.prepare(
            "SELECT coalesce(tax_amount, 0) AS tax FROM core_order_payment WHERE event_id = ?",
          )
            .bind(last.paymentId)
            .first()) as { tax: number };
          const kept = await carried(inv.orderId);
          expect(kept).toBeLessThanOrEqual(Math.max(0, docs.tax));
          // Exact, unless the settling payment could not carry all it should (never more than its
          // own amount): then what was carried before (a credit note covered part of what was
          // owed with nothing moving) stands.
          if (lastTax.tax < owed) {
            expect(kept, `round ${round} paid off`).toBe(Math.max(0, docs.tax));
            settledByMoney += 1;
          } else {
            clamped += 1;
          }
        }
      }
    }
    expect(runs).toBeGreaterThan(20);
    expect(settledByMoney).toBeGreaterThan(0);
    // Measured 2026-11-26: 287 acts, 36 settlements exact, 1 whose last payment was too small.
    expect(clamped).toBeLessThan(settledByMoney);
  });
});
