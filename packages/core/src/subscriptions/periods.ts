// An order per paid period (stage 32a, decision 3, ADR 0486). When the provider says a period's
// invoice is paid, the host writes a `core_order` born paid: created `pending` and moved to `paid`
// by the host in one batch, from the verified event, with one line for the plan, the period's
// dates, the provider's tax figures and its invoice and payment references. So revenue,
// `rec_order`, tax reports, the confirmation email, refunds and the dashboards stay one path.
//
// - An invoice with nothing paid (a trial's, a free continuation's) is no order.
// - One invoice is one order, however often or by whichever event it is reported (the unique
//   index on core_order (provider, invoice_ref) holds it under two deliveries at once).
// - Money paid never vanishes from orders. A period paid other than as agreed (less: a coupon or
//   the customer's balance; more; or in another currency, or on a subscription whose terms were
//   changed at the provider) is an order for what was actually paid, flagged (`period_flag`), and
//   staff are told once for the subscription.
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

/**
 * What a period is paid on: a subscription, or (id null) the terms of a checkout whose provider
 * subscription was not made here because it was not as agreed.
 */
export type PeriodTerms = Omit<SubscriptionRow, "id"> & { id: string | null };

export type PeriodFlag = "paid_less" | "paid_more" | "not_as_agreed";

export interface PaidPeriod {
  outcome: "period_paid" | "period_flagged" | "period_duplicate" | "period_free";
  orderId: string | null;
  confirmation: { orderId: string; token: string } | null;
}

/** Why a paid invoice is not as agreed, or null when it is. */
export function periodFlag(
  terms: Pick<PeriodTerms, "amount" | "currency">,
  invoice: Pick<ProviderInvoice, "amountPaid" | "currency">,
  termsChanged: boolean,
): PeriodFlag | null {
  if (termsChanged || invoice.currency !== terms.currency) return "not_as_agreed";
  if (invoice.amountPaid < terms.amount) return "paid_less";
  if (invoice.amountPaid > terms.amount) return "paid_more";
  return null;
}

const FLAG_WORDS: Record<PeriodFlag, string> = {
  paid_less: "less than its price (a coupon or the payer's balance at the provider, say)",
  paid_more: "more than its price",
  not_as_agreed: "on terms that are not the ones agreed",
};

/**
 * Writes the paid order for one paid invoice, in the calling batch. `termsChanged`: the
 * subscription's price, currency or interval is no longer what was agreed at the provider.
 */
export async function recordPaidPeriod(
  ctx: HandlerContext,
  sub: PeriodTerms,
  event: SubscriptionEvent,
  invoice: ProviderInvoice,
  termsChanged = false,
  /**
   * Part of a period the host asked for (stage 32b): an upgrade's prorated charge or the first
   * period after a pause. Recorded for what was paid, with this title and plan, not flagged.
   */
  part: { title: string; planId: string } | null = null,
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

  const amount = invoice.amountPaid;
  const currency = invoice.currency;
  const flag = part ? null : periodFlag(sub, invoice, termsChanged);
  // Only a taxed subscription's figure is kept, as the provider said it, and only while it fits.
  const tax = sub.tax_code && invoice.tax && invoice.tax.amount <= amount ? invoice.tax : null;
  const id = newId("order");
  const lineId = newId("orderLine");
  const pending: OrderRow = {
    id,
    person_id: sub.payer_person_id,
    email: sub.email,
    currency,
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
    period_flag: flag,
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
      record_id: part?.planId ?? sub.plan_id,
      title: part?.title ?? sub.plan_title,
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
      currency,
      outcome: "applied",
      payment_ref: invoice.paymentRef,
      invoice_ref: invoice.ref,
      received_at: ctx.now,
      ...(tax ? { tax_amount: tax.amount, tax_country: tax.country } : {}),
    }),
  );
  recordHostChange(ctx, { object: "order", id, action: "create", after: orderSnapshot(pending) });
  if (flag) {
    const plan = await notifyStatements(
      ctx.db,
      {
        to: [{ role: "admin" }],
        type: "system.message",
        title: "A subscription period was paid other than as agreed",
        body:
          `Invoice ${invoice.ref} (${sub.id ? `subscription ${sub.id}` : `provider subscription ${event.subscription.ref}`}) ` +
          `was paid ${formatMoney(amount, currency)}, ${FLAG_WORDS[flag]}; the subscription is ` +
          `${formatMoney(sub.amount, sub.currency)}. It is recorded as order ${id}, flagged. ` +
          "Check it with the provider.",
        link: { kind: "record", object: "order", id },
        // Once for the subscription (or the provider's subscription), not once per period.
        dedupeKey: `subscription.period_flag:${event.provider}:${sub.id ?? event.subscription.ref}`,
        source: { actor: "system" },
      },
      ctx.now,
    );
    ctx.write(...plan.statements);
  }
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
    outcome: flag ? "period_flagged" : "period_paid",
    orderId: id,
    confirmation: token ? { orderId: id, token } : null,
  };
}
