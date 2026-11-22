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

import type { PendingApproval } from "../errors.ts";
import { ConflictError, ValidationError } from "../errors.ts";
import { newId } from "../ids.ts";
import type { HandlerContext } from "../operation.ts";
import { paymentsTarget, requestProviderRefund } from "./gateway.ts";
import { formatMoney, type OrderRow } from "./orders.ts";

export interface RefundablePayment {
  provider: string;
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
    .select(["provider", "payment_ref", "amount", "received_at", "invoice_ref"])
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
  const payments = (await refundablePayments(ctx, row.id)).filter((p) => p.refundable > 0);
  const available = payments.reduce((sum, p) => sum + p.refundable, 0);
  if (available <= 0) {
    throw new ConflictError("Everything paid on this order has been refunded or asked for", {
      order: row.id,
    });
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
