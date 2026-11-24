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
import { type Kysely, type Selectable, sql } from "kysely";
import { guestMinorNotice } from "../agreements/enforce.ts";
import { NotFoundError } from "../errors.ts";
import { getObject } from "../fields/index.ts";
import { type SubscriptionState, subscriptionObject } from "../fields/subscription.ts";
import { notifyStatements } from "../notifications/send.ts";
import { type HandlerContext, recordHostChange } from "../operation.ts";
import type { PaymentsEvent, ProviderSubscription } from "../orders/gateway.ts";
import { formatMoney } from "../orders/orders.ts";
import { applyTransition } from "../records/lifecycle.ts";
import {
  alsoAgreed,
  type ChangeRow,
  closeStale,
  declinedUpgradeWords,
  expectedPart,
  followChange,
  lateChange,
  openChange,
  upgradeNeedsAction,
} from "./changes.ts";
import { followCoolOff } from "./cooling-off.ts";
import { followSubscriptionGrant } from "./grants.ts";
import { type PeriodTerms, recordPaidPeriod } from "./periods.ts";
import { useTrial } from "./trial.ts";

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
const OWING: ReadonlySet<SubscriptionState> = new Set(["incomplete", "past_due", "unpaid"]);

/**
 * How much a state gives its holder: everything (on trial or active), everything while the
 * provider retries (decision 4), nothing while it waits or is paused, nothing ever again.
 */
const HOLDS: Record<SubscriptionState, number> = {
  trialing: 3,
  active: 3,
  past_due: 2,
  incomplete: 1,
  unpaid: 1,
  paused: 1,
  expired: 0,
  ended: 0,
};

/** The provider's status for each of the host's states (the inverse of STATE_OF). */
const PROVIDER_STATUS: Record<SubscriptionState, ProviderSubscription["status"]> = {
  incomplete: "incomplete",
  expired: "incomplete_expired",
  trialing: "trialing",
  active: "active",
  past_due: "past_due",
  unpaid: "unpaid",
  paused: "paused",
  ended: "canceled",
};

/**
 * What of a read on terms that are not the agreed ones may still be applied (review of 32a): only
 * what removes or reduces what the member holds (a move to a state that gives less, or a set end),
 * never what keeps it going longer (a later period, a trial extended, a failing one paid). Null
 * when nothing of it reduces anything.
 */
export function reductionsOnly(
  row: SubscriptionRow,
  read: ProviderSubscription,
): ProviderSubscription | null {
  const to = STATE_OF[read.status];
  const reducing = HOLDS[to] < HOLDS[row.state];
  const ending =
    (read.cancelAtPeriodEnd && row.cancel_at_period_end !== 1) ||
    (read.cancelAt !== null && row.cancel_at === null);
  if (!reducing && !ending) return null;
  return {
    ...read,
    status: reducing ? read.status : PROVIDER_STATUS[row.state],
    trialEnd: row.trial_end,
    currentPeriodStart: row.current_period_start,
    currentPeriodEnd: row.current_period_end,
    cancelAtPeriodEnd: read.cancelAtPeriodEnd || row.cancel_at_period_end === 1,
    cancelAt: read.cancelAt ?? row.cancel_at,
    canceledAt: read.canceledAt ?? row.canceled_at,
    endedAt: reducing ? read.endedAt : row.ended_at,
    endReason: read.endReason ?? row.end_reason,
  };
}

/**
 * Whether a read's price, currency or interval is not what the subscription was agreed at. `other`:
 * a price also agreed, a plan change the host asked for (stage 32b, ADR 0530).
 */
function termsDiffer(
  row: SubscriptionRow,
  read: ProviderSubscription,
  other: number | null = null,
): boolean {
  return (
    read.currency !== row.currency ||
    (read.amount !== row.amount && read.amount !== other) ||
    (read.interval !== null && read.interval !== row.interval)
  );
}

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
    cancelAt: row.cancel_at,
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
    cancel_at: read.cancelAt,
    canceled_at: read.canceledAt,
    ended_at: read.endedAt ?? (state === "ended" || state === "expired" ? now : null),
    end_reason: read.endReason,
    failing_since: FAILING.has(state) ? (row.failing_since ?? now) : null,
    // Paid, or over: nothing is waiting for the payer to confirm. Kept only while a payment is
    // still owed (incomplete, past due, unpaid).
    action_url: OWING.has(state) ? row.action_url : null,
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
  let terms = false;
  let change: ChangeRow | null = null;
  if (!existing) {
    const made = await createFromCheckout(ctx, event);
    if ("refused" in made) {
      // Nothing is made from terms that are not the agreed ones; money paid on them is still an
      // order, for what was paid, flagged (periods.ts).
      if (made.terms && event.trigger === "invoice_paid" && event.invoice) {
        const period = await recordPaidPeriod(ctx, made.terms, event, event.invoice, true);
        done(period.outcome);
        return {
          outcome: period.outcome,
          orderId: period.orderId,
          state: period.orderId ? "paid" : null,
          confirmation: period.confirmation,
        };
      }
      return nothing(made.refused);
    }
    row = made.row;
    moved = true;
  } else {
    // A provider subscription that names another of this host's subscriptions is not this one.
    if (read.subscriptionId !== null && read.subscriptionId !== existing.id) {
      await tellStaff(
        ctx,
        "A subscription event does not match its subscription",
        `The ${event.provider} subscription ${read.ref} names subscription ${read.subscriptionId}, ` +
          `and is recorded as ${existing.id}. Nothing was changed. Check it with the provider.`,
        existing.id,
        `subscription.mismatch:${event.provider}:${event.eventId}`,
      );
      return nothing("subscription_mismatch");
    }
    row = existing;
    // A plan change or a pause the host asked for (ADRs 0530, 0531): a read at its new price is
    // the change asked for, not one made at the provider.
    // Only an open change is trusted (one definition, `openChange`); one past its life is closed
    // as lapsed in this batch, and a read at its price is a change at the provider.
    const found = await openChange(ctx.db, existing.id, ctx.now);
    change = found.open;
    // A late read (second review) that shows a change which lapsed meanwhile is that change: the
    // provider took it in time and its event came after. Otherwise a stale one is closed.
    if (!change && read.observedAt >= existing.observed_at && !FINAL.has(existing.state)) {
      change = await lateChange(
        ctx,
        existing,
        read,
        event.invoice,
        event.trigger === "invoice_paid" && event.invoice?.status === "paid",
      );
    }
    if (!change) closeStale(ctx, found.stale);
    // Its price, currency or interval changed at the provider (its dashboard): staff are told
    // once for the subscription, and only what reduces what the member holds is applied.
    terms = termsDiffer(existing, read, alsoAgreed(change));
    if (terms) {
      await tellStaff(
        ctx,
        "A subscription was changed at the provider",
        `The ${event.provider} subscription ${read.ref} now says ` +
          `${formatMoney(read.amount, read.currency)} every ${read.interval ?? "period"}; ` +
          `subscription ${existing.id} was agreed at ${formatMoney(existing.amount, existing.currency)} ` +
          `every ${existing.interval}. Only its ending, pausing or failing is mirrored until it is ` +
          "put back as agreed; periods paid on it are recorded as paid, flagged. Check it with the provider.",
        existing.id,
        `subscription.terms_changed:${event.provider}:${existing.id}`,
      );
    }
    // An older read than the one the record was last moved from, or a record that has ended,
    // moves nothing (an invoice it carries is still a fact, below).
    if (read.observedAt >= existing.observed_at && !FINAL.has(existing.state)) {
      const applied = terms ? reductionsOnly(existing, read) : read;
      if (applied) {
        // The plan the member holds after this read: a change asked for, once the read shows it.
        const followed = terms
          ? { row: existing, planChanged: false }
          : followChange(ctx, existing, read, change);
        row = await moveFromRead(ctx, existing, applied, followed.row, followed.planChanged);
        moved = true;
      }
    }
  }

  let outcome = moved ? "applied" : terms ? "terms_changed" : "stale";
  let orderId: string | null = null;
  let orderState: AppliedSubscriptionEvent["state"] = null;
  let confirmation: AppliedSubscriptionEvent["confirmation"] = null;
  const invoice = event.invoice;
  switch (event.trigger) {
    case "invoice_paid": {
      if (!invoice) break;
      // Part of a period the host asked for (an upgrade's prorated charge, the first period after
      // a pause) is not flagged.
      const part = terms ? null : await expectedPart(ctx.db, row, invoice, ctx.now, change);
      const period = await recordPaidPeriod(ctx, row, event, invoice, terms, part);
      // A subscription update's charge paid with no upgrade open to take it (its pending update
      // expired, or it was withdrawn): money was taken and nothing here moved. Staff are told for
      // each such invoice, never once per subscription.
      if (!part && invoice.billingReason === "subscription_update" && invoice.amountPaid > 0) {
        await tellStaff(
          ctx,
          "An upgrade's charge was paid, and no upgrade is waiting for it",
          `Invoice ${invoice.ref} of subscription ${row.id} (${row.plan_title}), raised by the ` +
            `provider for a change of plan, was paid ${formatMoney(invoice.amountPaid, invoice.currency)}, ` +
            "and no upgrade the host asked for is open to take it. It is recorded as an order. " +
            "Check the subscription's price with the provider, and refund the order if no upgrade applies.",
          row.id,
          `subscription.update_paid:${event.provider}:${invoice.ref}`,
        );
      }
      outcome = period.outcome;
      orderId = period.orderId;
      orderState = period.orderId ? "paid" : null;
      confirmation = period.confirmation;
      break;
    }
    case "invoice_payment_failed":
      if (!invoice) break;
      // An upgrade's charge declined: the subscription keeps its plan and runs on (a pending
      // update), so this is not a failing renewal.
      if (
        change?.kind === "upgrade" &&
        change.state === "requested" &&
        invoice.billingReason === "subscription_update" &&
        read.status === "active"
      ) {
        await tellStaff(
          ctx,
          "A plan upgrade's charge failed",
          `Subscription ${row.id}: ${declinedUpgradeWords(change, invoice.amountDue, invoice.currency)}`,
          row.id,
          `subscription.upgrade_failed:${event.provider}:${invoice.ref}`,
        );
        outcome = "upgrade_failed";
        break;
      }
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
      // An open upgrade's charge waiting on the payer (3D Secure): the subscription stays active
      // under its pending update, so the link is the change's, shown with it (review of 32b).
      if (invoice && moved && upgradeNeedsAction(ctx, change, invoice)) {
        outcome = "action_required";
        break;
      }
      // Only from a read applied now (not a stale one), for an invoice still open, on a
      // subscription still owing: the payer's "confirm your payment" link.
      if (!invoice?.hostedUrl || !moved || invoice.status !== "open" || !OWING.has(row.state)) {
        break;
      }
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
  // Paused with no pause of the host's open to explain it (round three): one made at the provider
  // (its dashboard). Mirrored, as every move is, and staff are told.
  if (
    moved &&
    existing &&
    row.state === "paused" &&
    existing.state !== "paused" &&
    change?.kind !== "pause"
  ) {
    await tellStaff(
      ctx,
      "A subscription was changed at the provider",
      `The ${event.provider} subscription ${read.ref} was paused, and no pause the host asked for ` +
        `explains it. Subscription ${row.id} (${row.plan_title}) is mirrored as paused. Pause and ` +
        "end pauses in the host, never in the provider's dashboard.",
      row.id,
      `subscription.paused_at_provider:${event.provider}:${row.id}:${read.observedAt}`,
    );
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
  // A cooling off asked for (stage 44 step 7, ADR 0647): once the provider shows it ended, every
  // paid order of it is owed back in this batch, a period paid on it later too.
  await followCoolOff(ctx, row);
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
): Promise<{ row: SubscriptionRow } | { refused: string; terms?: PeriodTerms }> {
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
    return { refused: "unknown_subscription" };
  }
  // Its Person or address was erased before the provider confirmed it (ADR 0646): nothing of
  // theirs is made again. Staff cancel it with the provider; the notice names nobody.
  if (checkout.erased_at) {
    await tellStaff(
      ctx,
      "A subscription was confirmed for someone who was erased",
      `The ${event.provider} subscription ${read.ref} was started by a person since erased, before ` +
        "the provider confirmed it. Nothing was made here. Cancel it, and refund it, with the " +
        "provider.",
      null,
      `subscription.erased:${event.provider}:${read.ref}`,
    );
    return { refused: "checkout_erased" };
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
    cancel_at: null,
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
  if (termsDiffer(base, read)) {
    // Once per checkout: a subscription is never made from terms that are not the agreed ones.
    await tellStaff(
      ctx,
      "A subscription does not match what was agreed",
      `The ${event.provider} subscription ${read.ref} says ${formatMoney(read.amount, read.currency)} ` +
        `every ${read.interval ?? "period"}; the checkout for ${checkout.id} was ` +
        `${formatMoney(checkout.amount, checkout.currency)} every ${checkout.interval}. No ` +
        "subscription was made here; a period paid on it is recorded as an order, flagged. Check " +
        "it with the provider.",
      null,
      `subscription.mismatch:${event.provider}:${checkout.id}`,
    );
    return { refused: "subscription_mismatch", terms: { ...base, id: null } };
  }
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
  // What a membership plan's subscription grants (ADR 0510), once its record is written.
  // A guest's subscription landing on a minor tells staff (ADR 0644); its acceptances settle by
  // trigger in this batch (migration 0853).
  await guestMinorNotice(ctx, { subscriptionCheckout: checkout.id }, checkout.holder_person_id);
  await followSubscriptionGrant(ctx, row);
  await trialConfirmed(ctx, row);
  if (checkout.offer_id) await offerConfirmed(ctx, checkout.offer_id, checkout.trial_end, row);
  return { row };
}

/**
 * The provider confirmed a subscription opened from a continuation offer: the offer is taken,
 * by this subscription, in the event's batch (ADR 0491). One the hold could not stop (taken by
 * another subscription already, or withdrawn while its page was open) tells staff.
 */
async function offerConfirmed(
  ctx: HandlerContext,
  offerId: string,
  trialEnd: string | null,
  row: SubscriptionRow,
): Promise<void> {
  const offer = await ctx.db
    .selectFrom("core_subscription_offer")
    .select(["id", "email", "subscription_id", "withdrawn_at"])
    .where("id", "=", offerId)
    .executeTakeFirst();
  // Erased since: nothing to mark.
  if (!offer) return;
  if (offer.subscription_id && offer.subscription_id !== row.id) {
    await tellStaff(
      ctx,
      "A continuation offer was taken twice",
      `Subscription ${row.id} (${row.plan_title}) was opened from the continuation offer for ` +
        `${offer.email}, which subscription ${offer.subscription_id} had already taken. The ` +
        "provider has given its free time: end it in the provider's dashboard if it should not run.",
      row.id,
      `subscription.offer_twice:${row.provider}:${row.id}`,
    );
    return;
  }
  ctx.write(
    ctx.db
      .updateTable("core_subscription_offer")
      .set({
        subscription_id: row.id,
        taken_at: ctx.now,
        charged_from_start: trialEnd ? 0 : 1,
        updated_at: ctx.now,
        version: sql<number>`version + 1`,
      })
      .where("id", "=", offerId)
      .where("subscription_id", "is", null),
  );
  if (offer.withdrawn_at) {
    await tellStaff(
      ctx,
      "A withdrawn continuation offer was taken",
      `The continuation offer for ${offer.email} was withdrawn while its checkout was open, and ` +
        `the checkout was completed: subscription ${row.id} (${row.plan_title}) has its free ` +
        "time. End it in the provider's dashboard if it should not run.",
      row.id,
      `subscription.offer_withdrawn_taken:${row.provider}:${row.id}`,
    );
  }
}

/**
 * The provider confirmed a subscription with a trial on it: the holder's trial on its plan object
 * is used from now on (ADR 0489), in the event's batch. A second one the hold did not stop (a
 * confirmation that arrived after its hold lapsed) tells staff, who can end its trial at the
 * provider.
 */
async function trialConfirmed(ctx: HandlerContext, row: SubscriptionRow): Promise<void> {
  const { second } = await useTrial(ctx, row);
  if (!second) return;
  await tellStaff(
    ctx,
    "A second free trial was confirmed",
    `Subscription ${row.id} (${row.plan_title}) started with a free trial, and its holder has had ` +
      "a trial on this plan before. The provider has given it: end the trial in the provider's " +
      "dashboard if it should not run.",
    row.id,
    `subscription.second_trial:${row.provider}:${row.id}`,
  );
}

/** Moves a subscription to what a later read says, as the host, in the calling batch. */
async function moveFromRead(
  ctx: HandlerContext,
  row: SubscriptionRow,
  read: ProviderSubscription,
  /** The row with the plan it holds after this read (a plan change applied), else `row`. */
  planned: SubscriptionRow = row,
  planChanged = false,
): Promise<SubscriptionRow> {
  const next = fromRead(planned, read, ctx.now);
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
  await followSubscriptionGrant(ctx, next, { planChanged });
  if (next.trial_end && !row.trial_end) await trialConfirmed(ctx, next);
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
