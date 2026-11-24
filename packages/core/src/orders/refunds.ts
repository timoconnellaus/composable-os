// Refunds (stage 25, ADR 0429): staff ask, a person approves, the provider confirms.
//
//   - `order.refund` (permission `orders:refund`) works out which payments the money goes back
//     to and asks the payments gatekeeper for one refund per payment, as the caller. Each is the
//     outbound action `payments.refund`: always reviewed, and approved only by a person with
//     `orders:refund` (integrations/outbound.ts, operations/approval.ts). Nothing is sent before.
//   - The order moves to `refunded` only when the provider's webhook confirms the refund and
//     everything paid has gone back (orders/events.ts). A partial refund is recorded as an amount.
//
// What can still be refunded on a payment is what was paid on it, less the refunds confirmed and
// the ones asked for whose action is still waiting or applied and not yet confirmed.
//
// Refunds go back the way the money came (stage 34, ADR 0694, amending ADR 0429): the provider's
// payments as above; a payment a person recorded (a transfer, cash) is paid back by a person, who
// records how (`order.recordRefund`, `orders:refund`, a person only): the host sends nothing.

import type { PaymentMethod, RecordedKind } from "@composable-os/db";
import type { PendingApproval } from "../errors.ts";
import { ConflictError, NotFoundError, ValidationError } from "../errors.ts";
import { newId } from "../ids.ts";
import type { HandlerContext } from "../operation.ts";
import { paymentsTarget, requestProviderRefund } from "./gateway.ts";
import { changeOrder, formatMoney, type OrderRow } from "./orders.ts";
import { HOST_PROVIDER } from "./payments.ts";

export interface RefundablePayment {
  provider: string;
  /** How it was paid (ADR 0694): only the provider's go back through the gatekeeper. */
  method: PaymentMethod;
  paymentRef: string;
  paid: number;
  refundable: number;
  /** A subscription period's invoice the payment paid: its refund is credited on it (ADR 0486). */
  invoiceRef?: string | null;
}

/** Each payment on the order that money can go back to, newest first, and how much. */
export async function refundablePayments(
  ctx: Pick<HandlerContext, "db" | "now">,
  orderId: string,
): Promise<RefundablePayment[]> {
  const payments = await ctx.db
    .selectFrom("core_order_payment")
    .select(["provider", "payment_ref", "amount", "received_at", "invoice_ref", "method"])
    .where("order_id", "=", orderId)
    .where("payment_ref", "is not", null)
    .orderBy("received_at", "desc")
    .execute();
  const refunds = await ctx.db
    .selectFrom("core_order_refund as r")
    .leftJoin("core_pending_action as p", "p.id", "r.pending_action_id")
    .select([
      "r.provider",
      "r.payment_ref",
      "r.amount",
      "r.status",
      "p.status as action",
      "p.expires_at",
    ])
    .where("r.order_id", "=", orderId)
    .execute();
  const byPayment = new Map<string, RefundablePayment>();
  for (const p of payments) {
    const key = `${p.provider}\u0000${p.payment_ref}`;
    const entry = byPayment.get(key) ?? {
      provider: p.provider,
      method: p.method,
      paymentRef: p.payment_ref as string,
      paid: 0,
      refundable: 0,
      invoiceRef: p.invoice_ref,
    };
    entry.paid += p.amount;
    entry.refundable += p.amount;
    byPayment.set(key, entry);
  }
  for (const r of refunds) {
    const counts =
      r.status === "confirmed" ||
      r.action === "applied" ||
      (r.action === "pending" && r.expires_at !== null && r.expires_at > ctx.now);
    if (!counts) continue;
    const entry = byPayment.get(`${r.provider}\u0000${r.payment_ref}`);
    if (entry) entry.refundable = Math.max(0, entry.refundable - r.amount);
  }
  return [...byPayment.values()];
}

export interface RequestedRefund {
  id: string;
  paymentRef: string;
  amount: number;
  pendingActionId: string | null;
}

/**
 * Asks for a refund of `amount` (default: everything that can be) on `row`, split over its
 * payments newest first, in the calling operation's batch. Returns the refunds asked for and the
 * actions waiting for approval.
 */
export async function requestRefund(
  ctx: HandlerContext,
  row: OrderRow,
  input: {
    amount?: number | undefined;
    reason: string;
    /**
     * The id of the n-th refund asked for, when the caller needs it known in advance (the host's
     * owed refunds, ADR 0560): the provider's idempotency key, so one asked twice is one refund.
     */
    refundId?: ((n: number) => string) | undefined;
    /** Only this payment (a duplicate or late one owed back on its own, ADR 0560). */
    paymentRef?: string | undefined;
  },
): Promise<{ refunds: RequestedRefund[]; pending: PendingApproval[] }> {
  if (row.state === "pending" || row.state === "part_paid") {
    throw new ConflictError(
      row.state === "pending"
        ? "Nothing has been paid on this order"
        : "A part-paid order is cancelled first; then what was paid can be refunded",
      { order: row.id, state: row.state },
    );
  }
  const refundable = (await refundablePayments(ctx, row.id)).filter(
    (p) =>
      p.refundable > 0 && (input.paymentRef === undefined || p.paymentRef === input.paymentRef),
  );
  // Only the provider's payments go back through it (ADR 0694): money taken another way is paid
  // back by a person, who records it (order.recordRefund).
  const payments = refundable.filter((p) => p.method === "provider");
  const available = payments.reduce((sum, p) => sum + p.refundable, 0);
  if (available <= 0) {
    throw new ConflictError(
      refundable.length
        ? "What is left to refund on this order was taken another way: pay it back and record it (order.recordRefund)"
        : "Everything paid on this order has been refunded or asked for",
      { order: row.id, ...(refundable.length ? { rule: "refund_method" } : {}) },
    );
  }
  const wanted = input.amount ?? available;
  if (!Number.isSafeInteger(wanted) || wanted <= 0 || wanted > available) {
    throw new ValidationError(
      `A refund on this order is at most ${formatMoney(available, row.currency)}`,
      { field: "amount", rule: "refund_amount", available },
    );
  }
  const target = await paymentsTarget(ctx.db);
  const refunds: RequestedRefund[] = [];
  const pending: PendingApproval[] = [];
  let left = wanted;
  for (const payment of payments) {
    if (left <= 0) break;
    const amount = Math.min(left, payment.refundable);
    left -= amount;
    const id = input.refundId ? input.refundId(refunds.length) : newId("refund");
    const result = await requestProviderRefund(
      ctx.integrations,
      target,
      {
        actor: ctx.actor,
        userId: ctx.user.id,
        userName: ctx.user.name,
        role: ctx.user.role,
        origin: ctx.origin,
        grantedPermissions: ctx.grantedPermissions,
        reason: ctx.reason ?? input.reason,
      },
      {
        orderId: row.id,
        paymentRef: payment.paymentRef,
        amount,
        currency: row.currency,
        reason: input.reason,
        refundId: id,
        ...(payment.invoiceRef ? { invoiceRef: payment.invoiceRef } : {}),
      },
    );
    const action = result.pending[0] ?? null;
    if (action) pending.push(action);
    ctx.write(
      ctx.db.insertInto("core_order_refund").values({
        id,
        order_id: row.id,
        provider: payment.provider,
        payment_ref: payment.paymentRef,
        amount,
        currency: row.currency,
        reason: input.reason,
        status: "requested",
        pending_action_id: action?.actionId ?? null,
        requested_by: ctx.user.id,
        requested_at: ctx.now,
        created_at: ctx.now,
      }),
    );
    refunds.push({
      id,
      paymentRef: payment.paymentRef,
      amount,
      pendingActionId: action?.actionId ?? null,
    });
  }
  return { refunds, pending };
}

/**
 * Records money a person paid back on a recorded payment (ADR 0694), in the calling operation's
 * batch: a confirmed refund row of method `recorded` naming how, and the order's `refunded` up by
 * it; the order moves to `refunded`, as the host, when it was paid and everything paid has gone
 * back. Nothing is sent anywhere. At most what is still refundable on that payment; as for the
 * provider's, a part-paid order is cancelled first.
 */
export async function recordRefund(
  ctx: HandlerContext,
  row: OrderRow,
  input: {
    paymentId: string;
    amount?: number | undefined;
    kind: RecordedKind;
    reference: string | null;
    reason: string;
  },
): Promise<{ order: OrderRow; refundId: string; amount: number }> {
  if (row.state === "pending" || row.state === "part_paid") {
    throw new ConflictError(
      row.state === "pending"
        ? "Nothing has been paid on this order"
        : "A part-paid order is cancelled first; then what was paid can be refunded",
      { order: row.id, state: row.state },
    );
  }
  const payment = await ctx.db
    .selectFrom("core_order_payment")
    .select(["method", "reverses"])
    .where("provider", "=", HOST_PROVIDER)
    .where("event_id", "=", input.paymentId)
    .where("order_id", "=", row.id)
    .executeTakeFirst();
  if (!payment || payment.reverses !== null) throw new NotFoundError("payment", input.paymentId);
  if (payment.method !== "recorded") {
    throw new ConflictError("This payment goes back onto what paid it, not by hand", {
      rule: "refund_method",
      method: payment.method,
    });
  }
  const left =
    (await refundablePayments(ctx, row.id)).find(
      (p) => p.provider === HOST_PROVIDER && p.paymentRef === input.paymentId,
    )?.refundable ?? 0;
  const amount = input.amount ?? left;
  if (left <= 0) {
    throw new ConflictError("Everything paid by this payment has been paid back or reversed", {
      order: row.id,
    });
  }
  if (!Number.isSafeInteger(amount) || amount <= 0 || amount > left) {
    throw new ValidationError(
      `At most ${formatMoney(left, row.currency)} can be paid back on this payment`,
      { field: "amount", rule: "refund_amount", available: left },
    );
  }
  const refundId = newId("refund");
  ctx.write(
    ctx.db.insertInto("core_order_refund").values({
      id: refundId,
      order_id: row.id,
      provider: HOST_PROVIDER,
      payment_ref: input.paymentId,
      amount,
      currency: row.currency,
      reason: input.reason,
      status: "confirmed",
      requested_by: ctx.user.id,
      requested_at: ctx.now,
      confirmed_at: ctx.now,
      created_at: ctx.now,
      method: "recorded",
      recorded_kind: input.kind,
      reference: input.reference,
    }),
  );
  const refunded = row.refunded + amount;
  const whole = row.state === "paid" && refunded >= row.paid;
  const order = await changeOrder(
    ctx,
    row,
    whole ? "refunded" : row.state,
    { refunded, ...(whole ? { refunded_at: ctx.now } : {}) },
    // The host's move: a person with the refund permission says the money went back.
    "host",
  );
  if (!whole && row.person_id) {
    ctx.postActivity({
      subject: `Order refund: ${formatMoney(amount, row.currency)}`,
      payload: {
        kind: "order.refunded",
        orderId: row.id,
        amount,
        refunded,
        currency: row.currency,
      },
      links: [{ object: "person", id: row.person_id }],
    });
  }
  return { order, refundId, amount };
}
