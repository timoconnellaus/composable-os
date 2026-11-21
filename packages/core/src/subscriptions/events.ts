// Verified subscription events (stage 32a, ADR 0485): what the payments gatekeeper's subscription
// events become in the host. Reached only from `order.applyPaymentEvent`, which takes the stored
// event's key alone: nothing a caller sends describes a subscription or a paid period.
//
//   - The event carries a current read of the subscription, made by the gatekeeper when it
//     arrived. The host moves the subscription to what that read says, as the host, unless it has
//     already moved from a later read (events arrive in any order; the latest read wins) or the
//     subscription has ended (final).
//   - The first event for a subscription makes the host's record, from the checkout the host
//     opened (the id the provider carries). An event no checkout of this host's explains, or one
//     whose price, currency or interval is not what was agreed, moves nothing and tells staff.
//   - `invoice_paid` with money on it is a paid period: an order born paid (periods.ts).
//   - A failed renewal and an invoice the provider cannot finalize tell staff once each; a
//     renewal needing the payer to confirm it keeps the provider's link for the payer.
import type { CoreDatabase, CoreSubscriptionTable } from "@composable-os/db";
import type { Kysely, Selectable } from "kysely";
import { NotFoundError } from "../errors.ts";
import { getObject } from "../fields/index.ts";
import { type SubscriptionState, subscriptionObject } from "../fields/subscription.ts";
import { notifyStatements } from "../notifications/send.ts";
import { type HandlerContext, recordHostChange } from "../operation.ts";
import type { PaymentsEvent, ProviderSubscription } from "../orders/gateway.ts";
import { formatMoney } from "../orders/orders.ts";
import { applyTransition } from "../records/lifecycle.ts";
import { recordPaidPeriod } from "./periods.ts";

export type SubscriptionRow = Selectable<CoreSubscriptionTable>;
type SubscriptionEvent = Extract<PaymentsEvent, { kind: "subscription" }>;

/** The host's state for each of the provider's statuses. */
export const STATE_OF: Record<ProviderSubscription["status"], SubscriptionState> = {
  incomplete: "incomplete",
  incomplete_expired: "expired",
  trialing: "trialing",
  active: "active",
  past_due: "past_due",
  unpaid: "unpaid",
  paused: "paused",
  canceled: "ended",
};

const FINAL: ReadonlySet<SubscriptionState> = new Set(["ended", "expired"]);
const FAILING: ReadonlySet<SubscriptionState> = new Set(["past_due", "unpaid"]);

const subscription = () => getObject("subscription") ?? subscriptionObject;

/** A subscription as the audit log and the transition engine see it: registry field names. */
export function subscriptionSnapshot(row: SubscriptionRow): Record<string, unknown> {
  return {
    payerPersonId: row.payer_person_id,
    holderPersonId: row.holder_person_id,
    planObject: row.plan_object,
    planId: row.plan_id,
    planTitle: row.plan_title,
    amount: row.amount,
    currency: row.currency,
    interval: row.interval,
    state: row.state,
    trialEnd: row.trial_end,
    currentPeriodStart: row.current_period_start,
    currentPeriodEnd: row.current_period_end,
    cancelAtPeriodEnd: row.cancel_at_period_end === 1,
    canceledAt: row.canceled_at,
    endedAt: row.ended_at,
    endReason: row.end_reason,
  };
}

export async function loadSubscriptionRow(
  db: Kysely<CoreDatabase>,
  id: string,
): Promise<SubscriptionRow> {
  const row = await db
    .selectFrom("core_subscription")
    .selectAll()
    .where("id", "=", id)
    .executeTakeFirst();
  if (!row) throw new NotFoundError("subscription", id);
  return row;
}

/** What applying an event did (the same shape as an order event's, for the one adapter). */
export interface AppliedSubscriptionEvent {
  outcome: string;
  orderId: string | null;
  state: "pending" | "part_paid" | "paid" | "cancelled" | "expired" | "refunded" | null;
  confirmation: { orderId: string; token: string } | null;
}

async function tellStaff(
  ctx: HandlerContext,
  title: string,
  body: string,
  subscriptionId: string | null,
  key: string,
): Promise<void> {
  const plan = await notifyStatements(
    ctx.db,
    {
      to: [{ role: "admin" }],
      type: "system.message",
      title,
      body,
      link: subscriptionId ? { kind: "record", object: "subscription", id: subscriptionId } : null,
      dedupeKey: key,
      source: { actor: "system" },
    },
    ctx.now,
  );
  ctx.write(...plan.statements);
}

/** The columns a read sets, as the subscription row would hold them after it. */
function fromRead(row: SubscriptionRow, read: ProviderSubscription, now: string): SubscriptionRow {
  const state = STATE_OF[read.status];
  return {
    ...row,
    state,
    customer_ref: read.customerRef ?? row.customer_ref,
    trial_end: read.trialEnd,
    current_period_start: read.currentPeriodStart,
    current_period_end: read.currentPeriodEnd,
    cancel_at_period_end: read.cancelAtPeriodEnd ? 1 : 0,
    canceled_at: read.canceledAt,
    ended_at: read.endedAt ?? (state === "ended" || state === "expired" ? now : null),
    end_reason: read.endReason,
    failing_since: FAILING.has(state) ? (row.failing_since ?? now) : null,
    // A renewal paid, or the subscription over: nothing is waiting for the payer to confirm.
    action_url: FAILING.has(state) ? row.action_url : null,
    observed_at: read.observedAt,
    updated_at: now,
    version: row.version + 1,
  };
}

/** Applies one stored subscription event, in the calling operation's batch. */
export async function applySubscriptionEvent(
  ctx: HandlerContext,
  event: SubscriptionEvent,
  done: (outcome: string) => void,
): Promise<AppliedSubscriptionEvent> {
  const read = event.subscription;
  const nothing = (outcome: string): AppliedSubscriptionEvent => {
    done(outcome);
    return { outcome, orderId: null, state: null, confirmation: null };
  };
  const existing = await ctx.db
    .selectFrom("core_subscription")
    .selectAll()
    .where("provider", "=", event.provider)
    .where("provider_ref", "=", read.ref)
    .executeTakeFirst();

  let row: SubscriptionRow;
  let moved = false;
  if (!existing) {
    const made = await createFromCheckout(ctx, event);
    if (typeof made === "string") return nothing(made);
    row = made;
    moved = true;
  } else {
    if (
      (read.subscriptionId !== null && read.subscriptionId !== existing.id) ||
      read.currency !== existing.currency ||
      read.amount !== existing.amount ||
      (read.interval !== null && read.interval !== existing.interval)
    ) {
      await tellStaff(
        ctx,
        "A subscription event does not match its subscription",
        `The ${event.provider} subscription ${read.ref} now says ` +
          `${formatMoney(read.amount, read.currency)} every ${read.interval ?? "period"}, and ` +
          `subscription ${existing.id} was agreed at ${formatMoney(existing.amount, existing.currency)} ` +
          `every ${existing.interval}. Nothing was changed. Check it with the provider.`,
        existing.id,
        `subscription.mismatch:${event.provider}:${event.eventId}`,
      );
      return nothing("subscription_mismatch");
    }
    row = existing;
    // An older read than the one the record was last moved from, or a record that has ended,
    // moves nothing (an invoice it carries is still a fact, below).
    if (read.observedAt >= existing.observed_at && !FINAL.has(existing.state)) {
      row = await moveFromRead(ctx, existing, read);
      moved = true;
    }
  }

  let outcome = moved ? "applied" : "stale";
  let orderId: string | null = null;
  let orderState: AppliedSubscriptionEvent["state"] = null;
  let confirmation: AppliedSubscriptionEvent["confirmation"] = null;
  const invoice = event.invoice;
  switch (event.trigger) {
    case "invoice_paid": {
      if (!invoice) break;
      const period = await recordPaidPeriod(ctx, row, event, invoice);
      outcome = period.outcome;
      orderId = period.orderId;
      orderState = period.orderId ? "paid" : null;
      confirmation = period.confirmation;
      break;
    }
    case "invoice_payment_failed":
      if (!invoice) break;
      await tellStaff(
        ctx,
        "A subscription's payment failed",
        `Subscription ${row.id} (${row.plan_title}) could not be charged ` +
          `${formatMoney(invoice.amountDue, invoice.currency)} (attempt ${invoice.attemptCount}). ` +
          "The provider retries on its own schedule and emails the payer; access stays while it " +
          "retries and stops if it gives up.",
        row.id,
        `subscription.payment_failed:${event.provider}:${invoice.ref}`,
      );
      outcome = "payment_failed";
      break;
    case "invoice_action_required":
      if (!invoice?.hostedUrl) break;
      // Kept for the payer's "confirm your payment" link; not a record change of its own.
      ctx.write(
        ctx.db
          .updateTable("core_subscription")
          .set({ action_url: invoice.hostedUrl })
          .where("id", "=", row.id),
      );
      outcome = "action_required";
      break;
    case "invoice_finalization_failed":
      await tellStaff(
        ctx,
        "A subscription's invoice cannot be collected",
        `The provider could not finalize invoice ${invoice?.ref ?? "(unknown)"} of subscription ` +
          `${row.id}, often for want of a tax location, so nothing can be collected on it. ` +
          "Fix it in the provider's dashboard.",
        row.id,
        `subscription.finalization_failed:${event.provider}:${invoice?.ref ?? event.eventId}`,
      );
      outcome = "finalization_failed";
      break;
    default:
      break;
  }
  if (moved && row.state === "ended" && row.end_reason === "payment_failed") {
    await tellStaff(
      ctx,
      "A subscription ended: its payments failed",
      `The provider's retries for subscription ${row.id} (${row.plan_title}) ran out, and it ` +
        "ended. Its access has stopped.",
      row.id,
      `subscription.ended_failed:${event.provider}:${row.id}`,
    );
  }
  done(outcome);
  return { outcome, orderId, state: orderState, confirmation };
}

/**
 * The host's record for a subscription the provider just reported, from the checkout the host
 * opened for it. Returns why not when no checkout of this host's explains it or it is not what
 * was agreed (staff are told).
 */
async function createFromCheckout(
  ctx: HandlerContext,
  event: SubscriptionEvent,
): Promise<SubscriptionRow | string> {
  const read = event.subscription;
  const checkout = read.subscriptionId
    ? await ctx.db
        .selectFrom("core_subscription_checkout")
        .selectAll()
        .where("id", "=", read.subscriptionId)
        .where("provider", "=", event.provider)
        .executeTakeFirst()
    : undefined;
  if (!checkout || (checkout.subscription_ref && checkout.subscription_ref !== read.ref)) {
    await tellStaff(
      ctx,
      "A subscription event arrived that this host did not start",
      `The ${event.provider} subscription ${read.ref} names no subscription checkout this host ` +
        "opened. Nothing was changed. Check it with the provider.",
      null,
      `subscription.unknown:${event.provider}:${read.ref}`,
    );
    return "unknown_subscription";
  }
  if (
    read.currency !== checkout.currency ||
    read.amount !== checkout.amount ||
    (read.interval !== null && read.interval !== checkout.interval)
  ) {
    await tellStaff(
      ctx,
      "A subscription does not match what was agreed",
      `The ${event.provider} subscription ${read.ref} says ${formatMoney(read.amount, read.currency)} ` +
        `every ${read.interval ?? "period"}; the checkout for ${checkout.id} was ` +
        `${formatMoney(checkout.amount, checkout.currency)} every ${checkout.interval}. Nothing was ` +
        "changed. Check it with the provider.",
      null,
      `subscription.mismatch:${event.provider}:${event.eventId}`,
    );
    return "subscription_mismatch";
  }
  const base: SubscriptionRow = {
    id: checkout.id,
    payer_person_id: checkout.payer_person_id,
    holder_person_id: checkout.holder_person_id,
    email: checkout.email,
    placed_as: checkout.placed_as,
    plan_object: checkout.plan_object,
    plan_id: checkout.plan_id,
    plan_title: checkout.plan_title,
    amount: checkout.amount,
    currency: checkout.currency,
    interval: checkout.interval,
    tax_code: checkout.tax_code,
    state: "incomplete",
    provider: event.provider,
    provider_ref: read.ref,
    customer_ref: null,
    trial_end: null,
    current_period_start: null,
    current_period_end: null,
    cancel_at_period_end: 0,
    canceled_at: null,
    ended_at: null,
    end_reason: null,
    action_url: null,
    failing_since: null,
    observed_at: read.observedAt,
    created_at: ctx.now,
    updated_at: ctx.now,
    version: -1,
  };
  const row = { ...fromRead(base, read, ctx.now), created_at: ctx.now };
  // The host makes the record, in the state the provider's read says: its first history row is
  // the host's, whoever started the checkout.
  const outcome = await applyTransition(
    ctx,
    subscription(),
    row.id,
    null,
    { state: row.state },
    { by: "host" },
  );
  ctx.write(
    ctx.db.insertInto("core_subscription").values(row),
    ctx.db
      .updateTable("core_subscription_checkout")
      .set({ subscription_ref: read.ref })
      .where("id", "=", checkout.id),
    ...outcome.history,
  );
  recordHostChange(ctx, {
    object: "subscription",
    id: row.id,
    action: "create",
    after: subscriptionSnapshot(row),
  });
  postSubscriptionMove(ctx, row, null);
  return row;
}

/** Moves a subscription to what a later read says, as the host, in the calling batch. */
async function moveFromRead(
  ctx: HandlerContext,
  row: SubscriptionRow,
  read: ProviderSubscription,
): Promise<SubscriptionRow> {
  const next = fromRead(row, read, ctx.now);
  const before = subscriptionSnapshot(row);
  const outcome = await applyTransition(
    ctx,
    subscription(),
    row.id,
    before,
    subscriptionSnapshot(next),
    // The host's move: only a verified provider event reaches this function.
    { by: "host" },
  );
  const { id: _id, ...columns } = next;
  ctx.write(
    ctx.db.updateTable("core_subscription").set(columns).where("id", "=", row.id),
    ...outcome.history,
  );
  recordHostChange(ctx, {
    object: "subscription",
    id: row.id,
    action: "update",
    before,
    after: subscriptionSnapshot(next),
  });
  if (next.state !== row.state) postSubscriptionMove(ctx, next, row.state);
  return next;
}

const MOVE_WORDS: Record<SubscriptionState, string> = {
  incomplete: "started, waiting for its first payment",
  expired: "never started: its first payment did not go through",
  trialing: "on trial",
  active: "active",
  past_due: "past due: a payment failed",
  unpaid: "unpaid",
  paused: "paused",
  ended: "ended",
};

/** A subscription's move on its payer's timeline, in the move's own batch. */
function postSubscriptionMove(
  ctx: HandlerContext,
  row: SubscriptionRow,
  from: SubscriptionState | null,
): void {
  if (!row.payer_person_id) return;
  ctx.postActivity({
    subject: `Subscription ${MOVE_WORDS[row.state]}: ${row.plan_title}`,
    payload: {
      kind: "subscription.moved",
      subscriptionId: row.id,
      from,
      to: row.state,
      amount: row.amount,
      currency: row.currency,
      interval: row.interval,
    },
    links: [{ object: "person", id: row.payer_person_id }],
  });
}
