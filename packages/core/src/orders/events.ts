// Verified payment events (stage 25, ADR 0429): what the payments gatekeeper's webhook becomes in
// the host.
//
//   1. The gatekeeper verifies the provider's signature and delivers the typed event to the hook
//      the integration host bound (packages/gatekeeper-payments).
//   2. The host's adapter stores it in core_payment_event (`recordPaymentEvent`), keyed by the
//      provider's own event id. Only that adapter writes the table; no operation does.
//   3. `order.applyPaymentEvent { provider, eventId }` applies the stored event: its input is the
//      key alone, so no caller can describe a payment. A payment goes to `applyVerifiedPayment`;
//      a refund the provider confirmed goes to `confirmRefund`.
//   4. On a conflict with `reason: "order_stale"` (the order changed between the read and the
//      commit) the adapter applies it again. The minute cron applies anything left.
//
// The return page a buyer comes back to never reaches any of this.
import type { CrmDb } from "@composable-os/db";
import { z } from "zod";
import type { EventSink } from "../automations/types.ts";
import { ConflictError, NotFoundError } from "../errors.ts";
import type { GateFloor } from "../gate.ts";
import { newId } from "../ids.ts";
import type { IntegrationRuntime } from "../integrations/runtime.ts";
import { eventStatement } from "../invoices/events.ts";
import { invokeByName } from "../invoke.ts";
import { errorForLog } from "../log.ts";
import { resolveChannelTarget } from "../notifications/channels.ts";
import { loadDeliverySettings } from "../notifications/preferences.ts";
import { notifyStatements } from "../notifications/send.ts";
import type { HandlerContext } from "../operation.ts";
import { jsonList } from "../records/common.ts";
import { applySubscriptionEvent } from "../subscriptions/events.ts";
import { SYSTEM_USER } from "../users.ts";
import { type PaymentsEvent, sendHostEmail } from "./gateway.ts";
import { hashOrderToken, newOrderToken } from "./guests.ts";
import { changeOrder, formatMoney, loadOrderRow, type OrderRow } from "./orders.ts";
import { applyVerifiedPayment, type SentTaxLine } from "./payments.ts";

const id = z.string().min(1).max(200);
const amount = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const currency = z
  .string()
  .regex(/^[A-Za-z]{3}$/)
  .transform((c) => c.toUpperCase());
const provider = z.enum(["stripe", "fake"]);
const minor = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const country = z
  .string()
  .regex(/^[A-Z]{2}$/)
  .nullable();
/** The provider's tax on a payment (ADR 0479), as it said it. */
const taxReport = z.object({
  amount: minor,
  country,
  lines: z.array(z.object({ ref: id, amount: minor })).max(100),
});

const moment = z.iso.datetime({ offset: true }).transform((t) => new Date(t).toISOString());
const reason = z
  .string()
  .regex(/^[a-z_]{1,60}$/)
  .nullable();
/** A subscription read (stage 32a, ADR 0485), as the gatekeeper delivers it. */
const subscriptionRead = z.object({
  provider,
  ref: id,
  customerRef: id.nullable(),
  subscriptionId: id.nullable(),
  status: z.enum([
    "incomplete",
    "incomplete_expired",
    "trialing",
    "active",
    "past_due",
    "unpaid",
    "paused",
    "canceled",
  ]),
  amount: minor,
  currency,
  interval: z.enum(["week", "month", "year"]).nullable(),
  cancelAtPeriodEnd: z.boolean(),
  cancelAt: moment.nullable().default(null),
  trialEnd: moment.nullable(),
  currentPeriodStart: moment.nullable(),
  currentPeriodEnd: moment.nullable(),
  canceledAt: moment.nullable(),
  endedAt: moment.nullable(),
  endReason: reason,
  observedAt: moment,
});
const invoiceRead = z.object({
  ref: id,
  status: z.string().regex(/^[a-z_]{1,60}$/),
  amountPaid: minor,
  amountDue: minor,
  currency,
  paymentRef: id.nullable(),
  periodStart: moment.nullable(),
  periodEnd: moment.nullable(),
  billingReason: reason,
  attemptCount: minor,
  nextAttemptAt: moment.nullable(),
  hostedUrl: z
    .url({ protocol: /^https$/ })
    .max(2000)
    .nullable(),
  tax: z.object({ amount: minor, country }).optional(),
});

/** The event as the gatekeeper's hook delivers it, checked before it is stored. */
export const paymentsEventSchema: z.ZodType<PaymentsEvent> = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("payment"),
    provider,
    eventId: id,
    orderId: id,
    checkoutRef: id,
    amount,
    currency,
    paymentRef: id.nullable(),
    occurredAt: z.string().max(40),
    tax: taxReport.optional(),
  }),
  z.object({
    kind: z.literal("refund"),
    provider,
    eventId: id,
    orderId: id.nullable(),
    refundId: id.nullable(),
    refundRef: id,
    paymentRef: id.nullable(),
    amount,
    currency,
    occurredAt: z.string().max(40),
    tax: z.object({ amount: minor }).optional(),
    creditNote: z.boolean().optional(),
  }),
  z.object({
    kind: z.literal("subscription"),
    provider,
    eventId: id,
    trigger: z.enum([
      "checkout_completed",
      "created",
      "updated",
      "deleted",
      "paused",
      "resumed",
      "trial_will_end",
      "invoice_paid",
      "invoice_payment_failed",
      "invoice_action_required",
      "invoice_finalization_failed",
    ]),
    subscription: subscriptionRead,
    invoice: invoiceRead.optional(),
    occurredAt: z.string().max(40),
  }),
]);

export interface PaymentEventKey {
  provider: string;
  eventId: string;
}

/**
 * Stores one verified event, once (the host's adapter only). Returns its key, or null when the
 * delivery is not an event this host understands (nothing is stored then).
 */
export async function recordPaymentEvent(
  crm: CrmDb,
  event: unknown,
  connectionId: string | null,
  now: string,
): Promise<PaymentEventKey | null> {
  const parsed = paymentsEventSchema.safeParse(event);
  if (!parsed.success) return null;
  const e = parsed.data;
  await crm.query
    .insertInto("core_payment_event")
    .values({
      provider: e.provider,
      event_id: e.eventId,
      kind: e.kind,
      connection_id: connectionId,
      payload: JSON.stringify(e),
      received_at: now,
    })
    .onConflict((oc) => oc.columns(["provider", "event_id"]).doNothing())
    .execute();
  return { provider: e.provider, eventId: e.eventId };
}

/** What applying an event did, and the confirmation to send once it has committed. */
export interface AppliedPaymentEvent {
  outcome: string;
  orderId: string | null;
  state: OrderRow["state"] | null;
  /** A new link for the confirmation email: the token is in this answer only. */
  confirmation: { orderId: string; token: string } | null;
}

async function tellAdmins(
  ctx: HandlerContext,
  title: string,
  body: string,
  orderId: string | null,
  key: string,
): Promise<void> {
  const plan = await notifyStatements(
    ctx.db,
    {
      to: [{ role: "admin" }],
      type: "system.message",
      title,
      body,
      link: orderId ? { kind: "record", object: "order", id: orderId } : null,
      dedupeKey: key,
      source: { actor: "system" },
    },
    ctx.now,
  );
  ctx.write(...plan.statements);
}

/** Applies one stored event in the calling operation's batch (order.applyPaymentEvent). */
export async function applyPaymentEvent(
  ctx: HandlerContext,
  key: PaymentEventKey,
): Promise<AppliedPaymentEvent> {
  const stored = await ctx.db
    .selectFrom("core_payment_event")
    .selectAll()
    .where("provider", "=", key.provider)
    .where("event_id", "=", key.eventId)
    .executeTakeFirst();
  if (!stored) throw new NotFoundError("payment event", key.eventId);
  if (stored.applied_at) {
    return { outcome: "duplicate", orderId: null, state: null, confirmation: null };
  }
  const event = paymentsEventSchema.parse(JSON.parse(stored.payload));
  const done = (outcome: string) =>
    ctx.write(
      ctx.db
        .updateTable("core_payment_event")
        .set((eb) => ({ applied_at: ctx.now, outcome, attempts: eb("attempts", "+", 1) }))
        .where("provider", "=", key.provider)
        .where("event_id", "=", key.eventId)
        .where("applied_at", "is", null),
    );
  if (event.kind === "subscription") return applySubscriptionEvent(ctx, event, done);
  if (event.kind === "refund" && event.creditNote) return reportCreditNoteTax(ctx, event, done);
  return event.kind === "payment"
    ? applyPayment(ctx, event, done)
    : confirmRefund(ctx, event, done);
}

/**
 * A credit note's report of the tax a period's refund gave back (ADR 0486). It confirms nothing:
 * the refund's own event does. Arriving after the confirmation, it fills in the refund's tax and
 * the order's; arriving before, it waits on the refund asked for, and the confirmation uses it.
 * A figure that does not fit the payment's tax is not stored, as for any refund (ADR 0479).
 */
async function reportCreditNoteTax(
  ctx: HandlerContext,
  event: Extract<PaymentsEvent, { kind: "refund" }>,
  done: (outcome: string) => void,
): Promise<AppliedPaymentEvent> {
  const said = event.tax?.amount;
  const none = (outcome: string, orderId: string | null = null) => {
    done(outcome);
    return { outcome, orderId, state: null, confirmation: null };
  };
  if (said === undefined) return none("credit_note_without_tax");
  const confirmed = await ctx.db
    .selectFrom("core_order_refund")
    .selectAll()
    .where("provider", "=", event.provider)
    .where("provider_refund_ref", "=", event.refundRef)
    .executeTakeFirst();
  if (confirmed) {
    if (confirmed.tax_amount !== null) return none("duplicate", confirmed.order_id);
    const row = await loadOrderRow(ctx.db, confirmed.order_id);
    const tax = await refundTaxOf(ctx, row.id, {
      ...event,
      amount: confirmed.amount,
      paymentRef: confirmed.payment_ref,
    });
    if (tax === null) return none("credit_note_tax_mismatch", row.id);
    ctx.write(
      ctx.db
        .updateTable("core_order_refund")
        .set({ tax_amount: tax })
        .where("id", "=", confirmed.id),
    );
    const next = await changeOrder(
      ctx,
      row,
      row.state,
      { tax_refunded: row.tax_refunded + tax },
      // The host's change: the provider said what tax went back.
      "host",
    );
    done("credit_note_tax");
    return { outcome: "credit_note_tax", orderId: row.id, state: next.state, confirmation: null };
  }
  const requested = event.refundId
    ? await ctx.db
        .selectFrom("core_order_refund")
        .select(["id", "order_id", "amount"])
        .where("id", "=", event.refundId)
        .where("provider", "=", event.provider)
        .where("status", "=", "requested")
        .executeTakeFirst()
    : undefined;
  if (requested && said <= requested.amount) {
    ctx.write(
      ctx.db
        .updateTable("core_order_refund")
        .set({ reported_tax: said })
        .where("id", "=", requested.id),
    );
    return none("credit_note_waiting", requested.order_id);
  }
  return none("credit_note_unmatched");
}

async function applyPayment(
  ctx: HandlerContext,
  event: Extract<PaymentsEvent, { kind: "payment" }>,
  done: (outcome: string) => void,
): Promise<AppliedPaymentEvent> {
  // The order is the one the host opened this checkout for, not what the event's metadata says.
  const checkout = await ctx.db
    .selectFrom("core_order_checkout")
    .select(["order_id", "tax_lines"])
    .where("provider", "=", event.provider)
    .where("ref", "=", event.checkoutRef)
    .executeTakeFirst();
  if (!checkout) {
    done("unknown_checkout");
    await tellAdmins(
      ctx,
      "A payment arrived for a checkout this CRM did not open",
      `The ${event.provider} payment ${event.paymentRef ?? event.eventId} of ` +
        `${formatMoney(event.amount, event.currency)} names a checkout (${event.checkoutRef}) ` +
        "that no order has. Nothing was changed. Check it with the provider.",
      null,
      `order.unknown_checkout:${event.provider}:${event.eventId}`,
    );
    return { outcome: "unknown_checkout", orderId: null, state: null, confirmation: null };
  }
  const result = await applyVerifiedPayment(ctx, {
    provider: event.provider,
    eventId: event.eventId,
    orderId: checkout.order_id,
    amount: event.amount,
    currency: event.currency,
    paymentRef: event.paymentRef ?? undefined,
    // What the host asked the provider to tax, and what the provider said it was (ADR 0479).
    sentTax: checkout.tax_lines ? (JSON.parse(checkout.tax_lines) as SentTaxLine[]) : null,
    tax: event.tax,
  });
  done(result.outcome);
  if (result.outcome !== "applied") {
    return { outcome: result.outcome, orderId: result.orderId, state: null, confirmation: null };
  }
  const order = result.order;
  let confirmation: AppliedPaymentEvent["confirmation"] = null;
  if (order.email) {
    // The confirmation email's own way back to this one order (ADR 0428): only its hash is kept.
    const token = newOrderToken();
    ctx.write(
      ctx.db
        .updateTable("core_order")
        .set({ email_link_hash: await hashOrderToken(token) })
        .where("id", "=", order.id),
    );
    confirmation = { orderId: order.id, token };
  }
  return { outcome: "applied", orderId: order.id, state: order.state, confirmation };
}

/**
 * A refund the provider confirmed: recorded once (by the provider's refund reference), added to
 * what the order has refunded, and the order moved to `refunded` when it was paid and everything
 * paid has gone back. A late payment refunded in full leaves the paid-late list.
 */
async function confirmRefund(
  ctx: HandlerContext,
  event: Extract<PaymentsEvent, { kind: "refund" }>,
  done: (outcome: string) => void,
): Promise<AppliedPaymentEvent> {
  const seen = await ctx.db
    .selectFrom("core_order_refund")
    .select(["order_id"])
    .where("provider", "=", event.provider)
    .where("provider_refund_ref", "=", event.refundRef)
    .executeTakeFirst();
  if (seen) {
    done("duplicate");
    return { outcome: "duplicate", orderId: seen.order_id, state: null, confirmation: null };
  }
  const requested = event.refundId
    ? await ctx.db
        .selectFrom("core_order_refund")
        .selectAll()
        .where("id", "=", event.refundId)
        .where("provider", "=", event.provider)
        .executeTakeFirst()
    : undefined;
  let orderId = requested?.order_id ?? null;
  if (!orderId && event.paymentRef) {
    const payment = await ctx.db
      .selectFrom("core_order_payment")
      .select(["order_id"])
      .where("provider", "=", event.provider)
      .where("payment_ref", "=", event.paymentRef)
      .executeTakeFirst();
    orderId = payment?.order_id ?? null;
  }
  if (!orderId) {
    done("unknown_order");
    await tellAdmins(
      ctx,
      "A refund was made that no order here matches",
      `The ${event.provider} refund ${event.refundRef} of ` +
        `${formatMoney(event.amount, event.currency)} does not match a payment this CRM ` +
        "recorded. Nothing was changed.",
      null,
      `order.unknown_refund:${event.provider}:${event.eventId}`,
    );
    return { outcome: "unknown_order", orderId: null, state: null, confirmation: null };
  }
  const row = await loadOrderRow(ctx.db, orderId);
  if (event.currency !== row.currency) {
    done("mismatch");
    await tellAdmins(
      ctx,
      "A refund does not match its order's currency",
      `Order ${row.id} is in ${row.currency}, and the provider refunded ` +
        `${formatMoney(event.amount, event.currency)}. Nothing was changed.`,
      row.id,
      `order.refund_mismatch:${event.provider}:${event.eventId}`,
    );
    return { outcome: "mismatch", orderId: row.id, state: row.state, confirmation: null };
  }
  // A credit note's tax that arrived first (ADR 0486) stands for the provider's word on this one.
  const reported = requested?.reported_tax ?? null;
  const refundTax = await refundTaxOf(
    ctx,
    row.id,
    event.tax === undefined && reported !== null ? { ...event, tax: { amount: reported } } : event,
  );
  const confirmed = {
    status: "confirmed" as const,
    amount: event.amount,
    provider_refund_ref: event.refundRef,
    event_id: event.eventId,
    confirmed_at: ctx.now,
    tax_amount: refundTax,
  };
  if (requested && requested.status === "requested") {
    ctx.write(
      ctx.db.updateTable("core_order_refund").set(confirmed).where("id", "=", requested.id),
    );
  } else {
    ctx.write(
      ctx.db.insertInto("core_order_refund").values({
        id: newId("refund"),
        order_id: row.id,
        provider: event.provider,
        payment_ref: event.paymentRef,
        currency: row.currency,
        created_at: ctx.now,
        ...confirmed,
      }),
    );
  }
  const refunded = row.refunded + event.amount;
  const whole = row.state === "paid" && refunded >= row.paid;
  const next = await changeOrder(
    ctx,
    row,
    whole ? "refunded" : row.state,
    {
      refunded,
      ...(whole ? { refunded_at: ctx.now } : {}),
      ...(refundTax ? { tax_refunded: row.tax_refunded + refundTax } : {}),
    },
    // The host's move: the provider confirmed the money went back.
    "host",
  );
  if (row.invoice_id) {
    // An invoice's order (ADR 0735): in the document event log, under the credit note that asked
    // for it (or the invoice, for a late payment given back).
    const credit = requested
      ? await ctx.db
          .selectFrom("core_credit_note_refund")
          .select("credit_note_id")
          .where("refund_id", "=", requested.id)
          .executeTakeFirst()
      : undefined;
    ctx.write(
      eventStatement(ctx.db, {
        documentKind: credit ? "credit_note" : "invoice",
        documentId: credit ? credit.credit_note_id : row.invoice_id,
        invoiceId: row.invoice_id,
        event: "refund_confirmed",
        paymentId: requested?.id ?? null,
        method: "provider",
        amount: event.amount,
        currency: row.currency,
        at: ctx.now,
      }),
    );
  }
  if (!whole && row.person_id) {
    ctx.postActivity({
      subject: `Order refund: ${formatMoney(event.amount, row.currency)}`,
      payload: {
        kind: "order.refunded",
        orderId: row.id,
        amount: event.amount,
        refunded,
        currency: row.currency,
      },
      links: [{ object: "person", id: row.person_id }],
    });
  }
  if (event.paymentRef) await resolveRefundedLatePayment(ctx, row.id, event);
  done("refunded");
  return { outcome: "refunded", orderId: row.id, state: next.state, confirmation: null };
}

/**
 * The tax a confirmed refund gave back (ADR 0479): the provider's own figure, when its refund
 * event carries one, and only while it fits the payment the refund went back to: no more than the
 * refund, and no more than that payment's tax less what its earlier refunds gave back. Null when
 * the provider did not say (Stripe's Refund carries no tax figure) or the figure does not fit, so
 * the host never stores a tax amount it worked out itself.
 */
async function refundTaxOf(
  ctx: HandlerContext,
  orderId: string,
  event: Extract<PaymentsEvent, { kind: "refund" }>,
): Promise<number | null> {
  const said = event.tax?.amount;
  if (said === undefined || !event.paymentRef) return null;
  if (said > event.amount) return null;
  const payment = await ctx.db
    .selectFrom("core_order_payment")
    .select((eb) => eb.fn.coalesce(eb.fn.sum<number>("tax_amount"), eb.val(0)).as("tax"))
    .where("order_id", "=", orderId)
    .where("provider", "=", event.provider)
    .where("payment_ref", "=", event.paymentRef)
    .executeTakeFirst();
  const back = await ctx.db
    .selectFrom("core_order_refund")
    .select((eb) => eb.fn.coalesce(eb.fn.sum<number>("tax_amount"), eb.val(0)).as("tax"))
    .where("order_id", "=", orderId)
    .where("provider", "=", event.provider)
    .where("payment_ref", "=", event.paymentRef)
    .where("status", "=", "confirmed")
    .executeTakeFirst();
  const left = Number(payment?.tax ?? 0) - Number(back?.tax ?? 0);
  return said <= left ? said : null;
}

/** A late payment whose money has all gone back leaves the paid-late list. */
async function resolveRefundedLatePayment(
  ctx: HandlerContext,
  orderId: string,
  event: Extract<PaymentsEvent, { kind: "refund" }>,
): Promise<void> {
  const late = await ctx.db
    .selectFrom("core_order_payment")
    .select(["event_id", "amount"])
    .where("order_id", "=", orderId)
    .where("provider", "=", event.provider)
    .where("payment_ref", "=", event.paymentRef)
    .where("outcome", "=", "late")
    .where("resolved", "is", null)
    .execute();
  if (!late.length) return;
  const before = await ctx.db
    .selectFrom("core_order_refund")
    .select((eb) => eb.fn.coalesce(eb.fn.sum<number>("amount"), eb.val(0)).as("total"))
    .where("order_id", "=", orderId)
    .where("provider", "=", event.provider)
    .where("payment_ref", "=", event.paymentRef)
    .where("status", "=", "confirmed")
    .executeTakeFirst();
  const back = Number(before?.total ?? 0) + event.amount;
  const paidIn = late.reduce((sum, p) => sum + p.amount, 0);
  if (back < paidIn) return;
  ctx.write(
    ctx.db
      .updateTable("core_order_payment")
      .set({ resolved: "refunded", resolved_at: ctx.now })
      .where("provider", "=", event.provider)
      .where("event_id", "in", jsonList(late.map((p) => p.event_id))),
  );
}

// --- The host's adapter --------------------------------------------------------------------------

export interface PaymentEventDeps {
  crm: CrmDb;
  /** For the confirmation email. Absent: no email is sent. */
  integrations?: IntegrationRuntime | undefined;
  events?: EventSink | undefined;
  floor?: GateFloor | undefined;
  /** The CRM's public origin, for the confirmation email's link. */
  appOrigin?: string | null | undefined;
  clock?: (() => Date) | undefined;
}

/** How many times an event is applied again after the order changed under it. */
const PAYMENT_EVENT_RETRIES = 5;
const RETRIED_REASONS = new Set([
  "order_stale",
  "subscription_stale",
  "moved_meanwhile",
  // Two events for one subscription granting at once (ADR 0510): read again, it is then granted.
  "subscription_grant",
]);

/**
 * Applies one stored event through `order.applyPaymentEvent`, again (up to PAYMENT_EVENT_RETRIES
 * times) when another event for the same order or subscription committed first, then sends the
 * confirmation email once the payment has committed. Returns the outcome.
 */
export async function applyStoredPaymentEvent(
  deps: PaymentEventDeps,
  key: PaymentEventKey,
): Promise<AppliedPaymentEvent> {
  let attempt = 0;
  for (;;) {
    try {
      const result = (await invokeByName("order.applyPaymentEvent", key, {
        actor: "automation",
        user: SYSTEM_USER,
        origin: { surface: "system", automationId: "system.payments" },
        db: deps.crm,
        ...(deps.events ? { events: deps.events } : {}),
        ...(deps.integrations ? { integrations: deps.integrations } : {}),
        ...(deps.floor ? { floor: deps.floor } : {}),
        ...(deps.clock ? { clock: deps.clock } : {}),
      })) as AppliedPaymentEvent;
      if (result.confirmation) {
        await sendOrderConfirmation(deps, result.confirmation).catch((error: unknown) =>
          console.error("order confirmation email failed", errorForLog(error)),
        );
      }
      return result;
    } catch (error) {
      // Another event for the same order or subscription committed first (two deliveries at
      // once): read it again. A subscription made by both, or one invoice's order by both, is the
      // same: the second application sees the first's row.
      const details = (error instanceof ConflictError ? error.details : undefined) as
        | { reason?: unknown; constraint?: unknown }
        | undefined;
      const stale =
        error instanceof ConflictError &&
        (RETRIED_REASONS.has(String(details?.reason)) ||
          (typeof details?.constraint === "string" &&
            /^core_(subscription|order)\./.test(details.constraint)));
      if (stale && attempt < PAYMENT_EVENT_RETRIES) {
        attempt += 1;
        continue;
      }
      throw error;
    }
  }
}

/** How many unapplied events one cron tick picks up. */
export const PAYMENT_EVENT_SWEEP = 50;
/** After this many failed applications admins are told (once per event), and it backs off. */
export const PAYMENT_EVENT_TELL_AFTER = 5;

/**
 * Whether a stored event that has failed `attempts` times is tried again at `now`: every tick for
 * the first `PAYMENT_EVENT_TELL_AFTER`, then backing off from when it arrived (an hour, two, four
 * and so on, at most a day apart), so one that keeps failing never stops being tried and never
 * crowds out the others.
 */
function paymentEventDue(attempts: number, receivedAt: string, now: string): boolean {
  if (attempts < PAYMENT_EVENT_TELL_AFTER) return true;
  const n = attempts - PAYMENT_EVENT_TELL_AFTER;
  // The cumulative wait after the first few tries: 1h, then +2h, +4h… each step at most a day.
  let wait = 0;
  for (let i = 0; i <= n; i += 1) wait += Math.min(2 ** i, 24) * 3_600_000;
  return Date.parse(now) - Date.parse(receivedAt) >= wait;
}

/**
 * The minute cron's catch-up: applies stored events their first delivery did not (the adapter
 * crashed, or kept conflicting), the least-tried first. One that keeps failing is tried with
 * backoff for good, and admins are told once when it has failed `PAYMENT_EVENT_TELL_AFTER` times.
 * One indexed read when there are none.
 */
export async function applyPendingPaymentEvents(
  deps: PaymentEventDeps,
): Promise<{ applied: number; failed: number }> {
  const now = (deps.clock?.() ?? new Date()).toISOString();
  const rows = (
    await deps.crm.query
      .selectFrom("core_payment_event")
      .select(["provider", "event_id", "attempts", "received_at"])
      .where("applied_at", "is", null)
      .orderBy("attempts")
      .orderBy("received_at")
      .limit(PAYMENT_EVENT_SWEEP * 4)
      .execute()
  )
    .filter((r) => paymentEventDue(Number(r.attempts ?? 0), r.received_at, now))
    .slice(0, PAYMENT_EVENT_SWEEP);
  let applied = 0;
  let failed = 0;
  for (const row of rows) {
    try {
      await applyStoredPaymentEvent(deps, { provider: row.provider, eventId: row.event_id });
      applied += 1;
    } catch (error) {
      failed += 1;
      console.error("payment event not applied", row.event_id, errorForLog(error));
      await deps.crm.query
        .updateTable("core_payment_event")
        .set((eb) => ({ attempts: eb("attempts", "+", 1) }))
        .where("provider", "=", row.provider)
        .where("event_id", "=", row.event_id)
        .execute();
      if (Number(row.attempts ?? 0) + 1 === PAYMENT_EVENT_TELL_AFTER) {
        const plan = await notifyStatements(
          deps.crm.query,
          {
            to: [{ role: "admin" }],
            type: "system.message",
            title: "A payment event keeps failing to apply",
            body:
              `The ${row.provider} event ${row.event_id} has failed to apply ` +
              `${PAYMENT_EVENT_TELL_AFTER} times. The host keeps trying it, less often. Until ` +
              "it applies, what it says (a payment, a subscription's change or end) is not " +
              "recorded here: check it with the provider.",
            dedupeKey: `payment-event.failing:${row.provider}:${row.event_id}`,
            source: { actor: "system" },
          },
          now,
        );
        await deps.crm.batch(plan.statements);
      }
    }
  }
  return { applied, failed };
}

// --- The confirmation email ----------------------------------------------------------------------

/**
 * The buyer's confirmation (ADR 0429): what was paid, what is still owed and by when, and a link
 * to this one order with a fresh token. Sent by the host through the email channel an admin chose
 * in Settings → Notification delivery, from a fixed template.
 */
export async function sendOrderConfirmation(
  deps: PaymentEventDeps,
  confirmation: { orderId: string; token: string },
): Promise<"sent" | "pending" | "skipped"> {
  const db = deps.crm.query;
  const row = await loadOrderRow(db, confirmation.orderId);
  if (!row.email) return "skipped";
  const settings = await loadDeliverySettings(db);
  if (!settings.email) {
    console.warn("order confirmation: no email channel is set in Settings → Notification delivery");
    return "skipped";
  }
  const resolved = await resolveChannelTarget(db, "email", settings.email);
  if ("problem" in resolved) {
    console.warn(`order confirmation: ${resolved.problem}`);
    return "skipped";
  }
  const message = confirmationMessage(row, confirmation.token, deps.appOrigin ?? null);
  const result = await sendHostEmail(deps.integrations, resolved.target, {
    to: row.email,
    ...message,
  });
  return result.pending.length ? "pending" : "sent";
}

/** The confirmation's subject and text. The link opens this order only. */
export function confirmationMessage(
  row: OrderRow,
  token: string,
  appOrigin: string | null,
): { subject: string; text: string } {
  const money = (n: number) => formatMoney(n, row.currency);
  const lines = [
    row.state === "paid"
      ? "Thank you: your order is paid."
      : "Thank you: your payment was received.",
    "",
    `Order ${row.id}`,
    `Paid: ${money(row.paid)} of ${money(row.total)}`,
  ];
  // The provider's own figure (ADR 0479); prices include it, so what was paid does not change.
  if (row.tax_amount > 0) lines.push(`Including tax: ${money(row.tax_amount)}`);
  if (row.state === "part_paid" && row.balance_due_at) {
    lines.push(
      `Still to pay: ${money(row.total - row.paid)} by ${row.balance_due_at.slice(0, 10)}`,
    );
  }
  if (appOrigin) {
    lines.push(
      "",
      "See your order:",
      `${appOrigin}/order/${encodeURIComponent(row.id)}?token=${encodeURIComponent(token)}`,
    );
  }
  return {
    subject: row.state === "paid" ? "Your order is confirmed" : "We received your payment",
    text: lines.join("\n"),
  };
}
