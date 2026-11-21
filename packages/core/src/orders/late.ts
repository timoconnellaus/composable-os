// Expiry, late payments and the daily notices (stage 25, ADR 0429).
//
// - The minute cron expires pending orders past their time (`order.expireDue`, as the host). A
//   part-paid order never expires: it has a balance due date instead.
// - A verified payment for an order that had closed is recorded `late` and never makes it paid
//   (orders/payments.ts). It stays on the paid-late list until staff honour it
//   (`order.honourLate`) or it is refunded.
// - Once a day admins are told about late payments still undecided and balances past due.
import type { CrmDb } from "@composable-os/db";
import { ConflictError } from "../errors.ts";
import { notifyStatements } from "../notifications/send.ts";
import type { HandlerContext } from "../operation.ts";
import { changeOrder, formatMoney, type OrderRow, overdueOrders } from "./orders.ts";

/** How many pending orders one sweep expires. */
export const EXPIRE_BATCH = 50;

/** Expires pending orders whose time is up, in the calling operation's batch. */
export async function expireDueOrders(
  ctx: HandlerContext,
  limit = EXPIRE_BATCH,
): Promise<string[]> {
  const rows = await ctx.db
    .selectFrom("core_order")
    .selectAll()
    .where("state", "=", "pending")
    .where("expires_at", "<=", ctx.now)
    .orderBy("expires_at")
    .limit(Math.min(Math.max(limit, 1), EXPIRE_BATCH))
    .execute();
  for (const row of rows) {
    // The host's move: nothing was paid in time. Its places go back (orders/holds.ts).
    await changeOrder(ctx, row, "expired", {}, "host");
  }
  return rows.map((row) => row.id);
}

export interface LatePayment {
  orderId: string;
  provider: string;
  eventId: string;
  amount: number;
  currency: string;
  receivedAt: string;
  orderState: OrderRow["state"];
  orderTotal: number;
}

/** Late payments staff have not decided on, oldest first (core_order_payment_late_idx). */
export async function paidLate(db: CrmDb["query"], limit = 200): Promise<LatePayment[]> {
  const rows = await db
    .selectFrom("core_order_payment as p")
    .innerJoin("core_order as o", "o.id", "p.order_id")
    .select([
      "p.order_id",
      "p.provider",
      "p.event_id",
      "p.amount",
      "p.currency",
      "p.received_at",
      "o.state",
      "o.total",
    ])
    .where("p.outcome", "=", "late")
    .where("p.resolved", "is", null)
    .orderBy("p.received_at")
    .limit(Math.min(Math.max(limit, 1), 200))
    .execute();
  return rows.map((r) => ({
    orderId: r.order_id,
    provider: r.provider,
    eventId: r.event_id,
    amount: r.amount,
    currency: r.currency,
    receivedAt: r.received_at,
    orderState: r.state,
    orderTotal: r.total,
  }));
}

/**
 * Honours a late payment on an expired order: the order becomes paid (or part paid, for a late
 * deposit) as the host, and with a capacity its places are claimed again in this batch, which
 * fails when they have gone (staff refund instead). The payment leaves the paid-late list.
 */
export async function honourLatePayment(ctx: HandlerContext, row: OrderRow): Promise<OrderRow> {
  if (row.state !== "expired") {
    throw new ConflictError(
      row.state === "cancelled"
        ? "A cancelled order cannot be honoured: refund the payment"
        : `An order that is ${row.state} has no late payment to honour`,
      { order: row.id, state: row.state },
    );
  }
  const late = await ctx.db
    .selectFrom("core_order_payment")
    .select(["provider", "event_id", "amount", "currency"])
    .where("order_id", "=", row.id)
    .where("outcome", "=", "late")
    .where("resolved", "is", null)
    .orderBy("received_at")
    .execute();
  const due = row.pay === "deposit" ? (row.deposit as number) : row.total;
  const payment = late.find(
    (p) => p.currency === row.currency && (p.amount === row.total || p.amount === due),
  );
  if (!payment) {
    throw new ConflictError(
      late.length
        ? `The late payment does not match what this order costs (${formatMoney(due, row.currency)}): refund it`
        : "This order has no late payment to honour",
      { order: row.id, rule: "late_payment" },
    );
  }
  const paid = row.paid + payment.amount;
  const settled = paid >= row.total;
  const next = await changeOrder(
    ctx,
    row,
    settled ? "paid" : "part_paid",
    { paid: Math.min(paid, row.total), ...(settled ? { paid_at: ctx.now } : {}) },
    // The host's move: the provider verified this payment, and staff chose to keep it.
    "host",
  );
  ctx.write(
    ctx.db
      .updateTable("core_order_payment")
      .set({ resolved: "honoured", resolved_at: ctx.now })
      .where("provider", "=", payment.provider)
      .where("event_id", "=", payment.event_id),
  );
  return next;
}

/**
 * The daily notices to admins: late payments still undecided, and balances past their due date.
 * One notice of each a day (by dedupe key), only when there is something to say.
 */
export async function runOrderNotices(
  crm: CrmDb,
  now: string,
): Promise<{ paidLate: number; overdue: number }> {
  const db = crm.query;
  const day = now.slice(0, 10);
  const late = await paidLate(db);
  const overdue = await overdueOrders(db, now);
  const statements = [];
  if (late.length) {
    const plan = await notifyStatements(
      db,
      {
        to: [{ role: "admin" }],
        type: "system.message",
        title: `${late.length} late ${late.length === 1 ? "payment needs" : "payments need"} a decision`,
        body:
          "A payment arrived after its order had closed. Honour it (the order becomes paid) or " +
          "refund it. It stays on the paid-late list until one happens.",
        link: { kind: "record", object: "order", id: "paid-late" },
        dedupeKey: `order.paid_late_daily:${day}`,
        source: { actor: "system" },
      },
      now,
    );
    statements.push(...plan.statements);
  }
  if (overdue.length) {
    const plan = await notifyStatements(
      db,
      {
        to: [{ role: "admin" }],
        type: "system.message",
        title: `${overdue.length} ${overdue.length === 1 ? "balance is" : "balances are"} past due`,
        body:
          "Part-paid orders whose balance was due before today. Nothing happens by itself: " +
          "extend the date, cancel the order, or wait for the buyer to pay.",
        link: { kind: "record", object: "order", id: "overdue" },
        dedupeKey: `order.overdue_daily:${day}`,
        source: { actor: "system" },
      },
      now,
    );
    statements.push(...plan.statements);
  }
  if (statements.length) await crm.batch(statements);
  return { paidLate: late.length, overdue: overdue.length };
}
