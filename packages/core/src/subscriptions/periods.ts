// An order per paid period (stage 32a, decision 3, ADR 0486). When the provider says a period's
// invoice is paid, the host writes a `core_order` born paid: created `pending` and moved to `paid`
// by the host in one batch, from the verified event, with one line for the plan, the period's
// dates, the provider's tax figures and its invoice and payment references. So revenue,
// `rec_order`, tax reports, the confirmation email, refunds and the dashboards stay one path.
//
// - An invoice with nothing paid (a trial's, a free continuation's) is no order.
// - One invoice is one order, however often or by whichever event it is reported (the unique
//   index on core_order (provider, invoice_ref) holds it under two deliveries at once).
// - A paid amount or currency that is not the subscription's agreed price writes no order and
//   tells staff: the money was taken, and staff check it with the provider.
// - The provider's tax is kept only for a subscription opened with tax, and only while it fits
//   (no more than what was paid), as for a checkout (ADR 0479).
import { getObject } from "../fields/index.ts";
import { orderObject } from "../fields/order.ts";
import { newId } from "../ids.ts";
import { notifyStatements } from "../notifications/send.ts";
import { type HandlerContext, recordHostChange } from "../operation.ts";
import type { PaymentsEvent, ProviderInvoice } from "../orders/gateway.ts";
import { hashOrderToken, newOrderToken } from "../orders/guests.ts";
import { changeOrder, formatMoney, type OrderRow, orderSnapshot } from "../orders/orders.ts";
import { applyTransition } from "../records/lifecycle.ts";
import type { SubscriptionRow } from "./events.ts";

type SubscriptionEvent = Extract<PaymentsEvent, { kind: "subscription" }>;

export interface PaidPeriod {
  outcome: "period_paid" | "period_duplicate" | "period_free" | "period_mismatch";
  orderId: string | null;
  confirmation: { orderId: string; token: string } | null;
}

/** Writes the paid order for one paid invoice of `sub`, in the calling batch. */
export async function recordPaidPeriod(
  ctx: HandlerContext,
  sub: SubscriptionRow,
  event: SubscriptionEvent,
  invoice: ProviderInvoice,
): Promise<PaidPeriod> {
  const none = (outcome: PaidPeriod["outcome"], orderId: string | null = null): PaidPeriod => ({
    outcome,
    orderId,
    confirmation: null,
  });
  if (invoice.amountPaid === 0) return none("period_free");
  const seen = await ctx.db
    .selectFrom("core_order")
    .select("id")
    .where("provider", "=", event.provider)
    .where("invoice_ref", "=", invoice.ref)
    .executeTakeFirst();
  if (seen) return none("period_duplicate", seen.id);
  if (invoice.currency !== sub.currency || invoice.amountPaid !== sub.amount) {
    const plan = await notifyStatements(
      ctx.db,
      {
        to: [{ role: "admin" }],
        type: "system.message",
        title: "A subscription period was paid an amount that was not agreed",
        body:
          `Invoice ${invoice.ref} of subscription ${sub.id} was paid ` +
          `${formatMoney(invoice.amountPaid, invoice.currency)}; the subscription is ` +
          `${formatMoney(sub.amount, sub.currency)}. No order was written. Check it with the provider.`,
        link: { kind: "record", object: "subscription", id: sub.id },
        dedupeKey: `subscription.period_mismatch:${event.provider}:${invoice.ref}`,
        source: { actor: "system" },
      },
      ctx.now,
    );
    ctx.write(...plan.statements);
    return none("period_mismatch");
  }

  const amount = invoice.amountPaid;
  // Only a taxed subscription's figure is kept, as the provider said it, and only while it fits.
  const tax = sub.tax_code && invoice.tax && invoice.tax.amount <= amount ? invoice.tax : null;
  const id = newId("order");
  const lineId = newId("orderLine");
  const pending: OrderRow = {
    id,
    person_id: sub.payer_person_id,
    email: sub.email,
    currency: sub.currency,
    total: amount,
    paid: 0,
    state: "pending",
    pay: "full",
    deposit: null,
    balance_due_at: null,
    // Never pending past this batch: nothing can expire it.
    expires_at: null,
    placed_as: sub.placed_as,
    provider: event.provider,
    provider_ref: null,
    access_hash: null,
    access_until: null,
    email_link_hash: null,
    refunded: 0,
    tax_amount: 0,
    tax_refunded: 0,
    tax_country: null,
    subscription_id: sub.id,
    period_start: invoice.periodStart,
    period_end: invoice.periodEnd,
    invoice_ref: invoice.ref,
    paid_at: null,
    cancelled_at: null,
    refunded_at: null,
    created_at: ctx.now,
    updated_at: ctx.now,
    version: 0,
  };
  const order = getObject("order") ?? orderObject;
  // Created as the host, then paid as the host: two history rows, one batch.
  const started = await applyTransition(ctx, order, id, null, { state: "pending" }, { by: "host" });
  ctx.write(
    ctx.db.insertInto("core_order").values(pending),
    ctx.db.insertInto("core_order_line").values({
      id: lineId,
      order_id: id,
      position: 0,
      object_type: sub.plan_object,
      record_id: sub.plan_id,
      title: sub.plan_title,
      quantity: 1,
      unit_price: amount,
      line_total: amount,
      created_at: ctx.now,
      ...(tax ? { tax_amount: tax.amount, tax_code: sub.tax_code } : {}),
    }),
    ...started.history,
    ctx.db.insertInto("core_order_payment").values({
      provider: event.provider,
      event_id: event.eventId,
      order_id: id,
      amount,
      currency: sub.currency,
      outcome: "applied",
      payment_ref: invoice.paymentRef,
      invoice_ref: invoice.ref,
      received_at: ctx.now,
      ...(tax ? { tax_amount: tax.amount, tax_country: tax.country } : {}),
    }),
  );
  recordHostChange(ctx, { object: "order", id, action: "create", after: orderSnapshot(pending) });
  // The confirmation email's own way back to this one order (ADR 0428), as for any paid order.
  const token = sub.email ? newOrderToken() : null;
  await changeOrder(
    ctx,
    pending,
    "paid",
    {
      paid: amount,
      paid_at: ctx.now,
      ...(tax ? { tax_amount: tax.amount, tax_country: tax.country } : {}),
    },
    // The host's move: a verified invoice of the provider's said this period is paid.
    "host",
  );
  if (token) {
    ctx.write(
      ctx.db
        .updateTable("core_order")
        .set({ email_link_hash: await hashOrderToken(token) })
        .where("id", "=", id),
    );
  }
  return {
    outcome: "period_paid",
    orderId: id,
    confirmation: token ? { orderId: id, token } : null,
  };
}
