// Plan changes and pauses (stage 32b, decisions 10, 11 and 12; ADRs 0530 and 0531). The provider
// runs both; the host asks it, through the payments gatekeeper, and moves nothing until a verified
// read shows what happened (events.ts calls `followChange` in each event's batch).
//
//   an upgrade      the new plan costs more: the provider charges the rest of the period at once,
//                   prorated, and applies the new price only once that charge is paid (a pending
//                   update). The member holds the new plan from the read that shows the new price.
//   a downgrade     costs the same or less: nothing is prorated or refunded; the provider charges
//                   the new price from the next invoice. The member keeps the plan paid for until
//                   the period the provider showed it in ends, and holds the new one from the read
//                   of the next period.
//   a pause         staff only, for a set time within the plan's bounds: the provider's own pause
//                   (status `paused`: no invoices; the host gives and spends nothing), resumed by
//                   the provider on its date with a new period, charged less the unused time of the
//                   period it was paused in. Ended early, or withdrawn before it starts, by staff.
//
// Each is a row of core_subscription_change, written in the operation's batch before the provider
// is asked (the call is made after the commit, so two asked at once ask the provider once: the
// open-change index refuses the second batch). A dry run commits nothing and so changes nothing at
// the provider; it may make the one read of the subscription a lost renewal needs (`requireActive`).
//
// One definition of "open" (review of 32b): state requested or waiting, and `expires_at` ahead
// (`isOpen`). Every reader here and in events.ts takes the change through `openChange`, and a row
// found past it is closed as lapsed in the reader's batch; the subscription view's `change_state`
// says the same in SQL. What came of each provider call is kept on the row (`call_outcome`,
// `end_outcome`), written with an audit row: only a refusal closes a change; an unknown outcome
// leaves it open for verified reads to decide, until it expires.
import type { CoreDatabase, CoreSubscriptionChangeTable } from "@composable-os/db";
import type { Kysely, Selectable } from "kysely";
import { ConflictError, ValidationError } from "../errors.ts";
import { getObject } from "../fields/index.ts";
import { newId } from "../ids.ts";
import { type AfterCommit, afterCommit, type HandlerContext } from "../operation.ts";
import type { ProviderInvoice, ProviderSubscription } from "../orders/gateway.ts";
import { callSubscriptionGatekeeper, paymentsTarget } from "../orders/gateway.ts";
import { grantFieldValue, readGrantItem } from "../orders/grants.ts";
import { formatMoney, priceLines } from "../orders/orders.ts";
import { callerOf } from "../records/transitions.ts";
import type { SubscriptionRow } from "./events.ts";

export type ChangeRow = Selectable<CoreSubscriptionChangeTable>;
export type CallOutcome = "sent" | "pending" | "unknown" | "refused";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** An asked change the provider has not shown within a day is lapsed: a pending update expires in 23 hours. */
export const ASKED_LIFE_MS = DAY;
/** A waiting downgrade the provider's renewal has not shown within a week of its period's end. */
export const WAITING_LIFE_MS = 7 * DAY;
/** A paid upgrade's prorated charge is matched for two days after the upgrade applied. */
const PRORATION_MATCH_MS = 2 * DAY;
/**
 * A verified read that arrives late (the provider retries a webhook for days) and matches a change
 * that lapsed meanwhile is followed as that change, for this long after it lapsed (review of 32b).
 */
export const LATE_READ_MS = 3 * DAY;
/** The longest pause the host asks for (the gatekeeper's limit too). */
export const MAX_PAUSE_DAYS = 366;

const plus = (iso: string, ms: number) => new Date(Date.parse(iso) + ms).toISOString();

/** Whether a change is open and still trusted: asked or waiting, and not past its life. */
export function isOpen(change: ChangeRow, now: string): boolean {
  return (
    (change.state === "requested" || change.state === "waiting") &&
    Date.parse(change.expires_at) > Date.parse(now)
  );
}

/**
 * The subscription's change in the requested or waiting state: `open` when it is still trusted,
 * `stale` when it is past its life (the caller closes it as lapsed in its own batch).
 */
export async function openChange(
  db: Kysely<CoreDatabase>,
  subscriptionId: string,
  now: string,
): Promise<{ open: ChangeRow | null; stale: ChangeRow | null }> {
  const row =
    (await db
      .selectFrom("core_subscription_change")
      .selectAll()
      .where("subscription_id", "=", subscriptionId)
      .where("state", "in", ["requested", "waiting"])
      .executeTakeFirst()) ?? null;
  if (!row) return { open: null, stale: null };
  return isOpen(row, now) ? { open: row, stale: null } : { open: null, stale: row };
}

/** Closes a change found past its life, as lapsed, in the calling batch. */
export function closeStale(ctx: HandlerContext, stale: ChangeRow | null): void {
  if (!stale) return;
  ctx.write(
    ctx.db
      .updateTable("core_subscription_change")
      .set({ state: "lapsed", action_url: null, updated_at: ctx.now })
      .where("id", "=", stale.id)
      .where("state", "=", stale.state),
  );
}

/**
 * A change that stopped being trusted (past its life, or lapsed) that a late verified read still
 * shows (review of 32b): the provider took it before its life ran out, and the event that says so
 * arrived after. Followed as that change, within `LATE_READ_MS` of its life's end, and never one the
 * provider refused or staff withdrew:
 * - an upgrade, only with its subscription-update invoice paid in this event, at most the price
 *   difference (the pending update applies only once paid);
 * - a downgrade, when the read shows its price;
 * - a pause, when the read shows the subscription paused.
 * Returns the change as it is to be followed (asked again, with a fresh life), and writes that in
 * the event's batch, or null.
 */
export async function lateChange(
  ctx: HandlerContext,
  row: SubscriptionRow,
  read: ProviderSubscription,
  invoice: Pick<ProviderInvoice, "amountPaid" | "billingReason" | "status"> | undefined,
  paid: boolean,
): Promise<ChangeRow | null> {
  const change =
    (await ctx.db
      .selectFrom("core_subscription_change")
      .selectAll()
      .where("subscription_id", "=", row.id)
      .orderBy("requested_at", "desc")
      .executeTakeFirst()) ?? null;
  // Only the newest change of the subscription (round three): when anything newer was applied,
  // withdrawn or refused, nothing older is revived.
  if (!change || isOpen(change, ctx.now)) return null;
  if (!["requested", "waiting", "lapsed"].includes(change.state)) return null;
  if (change.call_outcome === "refused") return null;
  if (Date.parse(change.expires_at) + LATE_READ_MS < Date.parse(ctx.now)) return null;
  const sameTerms =
    read.currency === row.currency && (read.interval === null || read.interval === row.interval);
  const shows =
    change.kind === "pause"
      ? // The read carries no resume date: a pause is matched only while its own window is open,
        // started (or due) and not past the date it resumes on.
        read.status === "paused" &&
        change.pause_until !== null &&
        Date.parse(ctx.now) < Date.parse(change.pause_until) &&
        Date.parse(read.observedAt) >= Date.parse(change.pause_from ?? change.requested_at)
      : change.kind === "downgrade"
        ? sameTerms && read.amount === change.to_amount
        : sameTerms &&
          read.amount === change.to_amount &&
          paid &&
          invoice?.billingReason === "subscription_update" &&
          change.to_amount !== null &&
          invoice.amountPaid > 0 &&
          invoice.amountPaid <= change.to_amount - change.from_amount;
  if (!shows) return null;
  const revived: ChangeRow = {
    ...change,
    state: change.kind === "downgrade" && change.state === "waiting" ? "waiting" : "requested",
    expires_at: plus(ctx.now, ASKED_LIFE_MS),
  };
  ctx.write(
    ctx.db
      .updateTable("core_subscription_change")
      .set({ state: revived.state, expires_at: revived.expires_at, updated_at: ctx.now })
      .where("id", "=", change.id)
      .where("state", "=", change.state),
  );
  return revived;
}

function requestedBy(ctx: HandlerContext): string {
  const caller = ctx.principal;
  return caller.kind === "customer"
    ? `customer:${caller.customerId}`
    : caller.kind === "staff"
      ? `staff:${caller.userId}`
      : "public";
}

/** The subscription's one open change slot: refused when a change is open; a stale one is closed. */
async function claimChangeSlot(ctx: HandlerContext, row: SubscriptionRow): Promise<void> {
  const { open, stale } = await openChange(ctx.db, row.id, ctx.now);
  closeStale(ctx, stale);
  if (!open) return;
  throw new ConflictError(
    open.kind === "pause"
      ? "A pause is already asked for on this subscription: end or withdraw it first"
      : open.state === "waiting"
        ? `This subscription already changes to ${open.to_plan_title} when its period ends, on ${open.effective_at?.slice(0, 10)}`
        : `A change to ${open.to_plan_title} is waiting for the payment provider`,
    { subscription: row.id, change: open.id, rule: "change_open" },
  );
}

/**
 * Refused unless the subscription is active, not set to end and priced. When the host's period has
 * ended (a renewal event not arrived, or lost), the provider is read once through the gatekeeper,
 * as the host (review of 32b), and the change proceeds from its period; the host's record is not
 * moved by it (only a verified event moves it). Returns the subscription as the change is to read it.
 */
async function requireActive(
  ctx: HandlerContext,
  row: SubscriptionRow,
  what: string,
): Promise<SubscriptionRow> {
  if (row.state !== "active") {
    throw new ConflictError(`A subscription that is ${row.state} cannot be ${what}`, {
      subscription: row.id,
      state: row.state,
      rule: "state",
    });
  }
  if (row.cancel_at_period_end === 1 || row.cancel_at !== null) {
    throw new ConflictError(
      `This subscription is set to end: keep it going first, then it can be ${what}`,
      { subscription: row.id, rule: "ending" },
    );
  }
  if (row.amount <= 0) {
    throw new ValidationError(`A subscription with nothing to pay cannot be ${what}`, {
      rule: "total",
    });
  }
  if (row.current_period_end && row.current_period_end > ctx.now) return row;
  const fresh = await readFromProvider(ctx, row);
  if (
    fresh &&
    fresh.status === "active" &&
    fresh.amount === row.amount &&
    fresh.currency === row.currency &&
    !fresh.cancelAtPeriodEnd &&
    fresh.cancelAt === null &&
    fresh.currentPeriodEnd !== null &&
    fresh.currentPeriodEnd > ctx.now
  ) {
    return {
      ...row,
      current_period_start: fresh.currentPeriodStart,
      current_period_end: fresh.currentPeriodEnd,
    };
  }
  throw new ConflictError(
    "This subscription's period has ended and the payment provider does not show it renewed as " +
      "agreed yet: try again once it has",
    { subscription: row.id, rule: "period_ended" },
  );
}

/** One read of the subscription at the provider, through the gatekeeper (an observation), or null. */
async function readFromProvider(
  ctx: HandlerContext,
  row: SubscriptionRow,
): Promise<ProviderSubscription | null> {
  try {
    const target = await paymentsTarget(ctx.db);
    if (target.provider !== row.provider) return null;
    const result = await callSubscriptionGatekeeper(
      ctx.integrations,
      target,
      "getSubscription",
      row.provider_ref,
    );
    const read = result.value as ProviderSubscription | null;
    return read && read.ref === row.provider_ref ? read : null;
  } catch {
    return null;
  }
}

export interface RequestedChange {
  id: string;
  changeId: string;
  kind: "upgrade" | "downgrade";
  /**
   * When the member holds the new plan: null for an upgrade (once its charge is paid); for a
   * downgrade, the current period's end as the host has it (the provider's read fixes it).
   */
  effectiveAt: string | null;
  amount: number;
  currency: string;
  /** What came of asking the provider: sent, pending approval, or unknown (verified reads decide). */
  asked: "sent" | "pending" | "unknown" | "not_needed";
  requested: true;
}

/**
 * Asks the provider to move `row` to another plan of the same object (decision 12): an upgrade
 * now, prorated and applied only once paid; a downgrade from the next period. The host prices the
 * plan, as at the start; a customer may only choose a plan they could subscribe to.
 */
export async function requestPlanChange(
  ctx: HandlerContext,
  row: SubscriptionRow,
  input: { planId: string; reason: string },
): Promise<AfterCommit<RequestedChange>> {
  row = await requireActive(ctx, row, "changed");
  if (input.planId === row.plan_id) {
    throw new ValidationError("This is the plan the subscription is on", {
      field: "planId",
      rule: "same_plan",
    });
  }
  const [plan] = await priceLines(
    ctx.db,
    [{ object: row.plan_object, id: input.planId, quantity: 1 }],
    row.currency,
    ctx.now,
    callerOf(ctx),
    { plans: true },
  );
  if (!plan?.recurring) throw new ValidationError("This is not a plan", { rule: "not_for_sale" });
  if (plan.recurring.interval !== row.interval || plan.unitPrice <= 0) {
    throw new ValidationError(
      `A subscription changes only to a plan paid every ${row.interval}, with a price`,
      { field: "planId", rule: "interval" },
    );
  }
  await claimChangeSlot(ctx, row);
  const kind = plan.unitPrice > row.amount ? "upgrade" : "downgrade";
  const id = newId("subscriptionChange");
  // A downgrade to the same price moves no money: the provider has nothing to change, and the
  // member holds the new plan from the next period.
  const samePrice = plan.unitPrice === row.amount;
  const periodEnd = row.current_period_end as string;
  const effectiveAt = kind === "downgrade" ? periodEnd : null;
  ctx.write(
    ctx.db.insertInto("core_subscription_change").values({
      id,
      subscription_id: row.id,
      kind,
      state: samePrice ? "waiting" : "requested",
      from_plan_id: row.plan_id,
      from_plan_title: row.plan_title,
      from_amount: row.amount,
      to_plan_id: plan.recordId,
      to_plan_title: plan.title,
      to_amount: plan.unitPrice,
      pause_from: null,
      pause_until: null,
      effective_at: effectiveAt,
      expires_at: samePrice ? plus(periodEnd, WAITING_LIFE_MS) : plus(ctx.now, ASKED_LIFE_MS),
      call_outcome: null,
      call_error: null,
      action_url: null,
      end_outcome: null,
      end_error: null,
      end_at: null,
      reason: input.reason,
      requested_by: requestedBy(ctx),
      requested_at: ctx.now,
      applied_at: null,
      updated_at: ctx.now,
    }),
  );
  const out = (asked: RequestedChange["asked"]): RequestedChange => ({
    id: row.id,
    changeId: id,
    kind,
    effectiveAt,
    amount: plan.unitPrice,
    currency: row.currency,
    asked,
    requested: true,
  });
  if (samePrice) return afterCommit(async () => out("not_needed"));
  return afterCommit(async () => {
    const asked = await askProvider(ctx, row, id, "call", "changeSubscription", {
      subscriptionId: row.id,
      subscriptionRef: row.provider_ref,
      changeId: id,
      amount: plan.unitPrice,
      currency: row.currency,
      interval: row.interval,
      description: plan.title.slice(0, 200) || plan.recordId,
      when: kind === "upgrade" ? "now" : "next_period",
      taxed: row.tax_code !== null,
      reason: input.reason,
    });
    return out(asked);
  });
}

/**
 * Staff close a subscription's open plan change (review of 32b): one stuck asked, one whose call's
 * outcome is unknown, or a downgrade waiting for its period (undoing it). A pause is ended with
 * `subscription.unpause`. Where the provider may hold it, it is undone there first, through the
 * gatekeeper, after the commit, and the change is closed only once that is sent (second review):
 * - a downgrade the provider may show: its old price put back, from the next invoice, nothing
 *   prorated;
 * - an upgrade whose pending update may be open: its invoice voided, so it can no longer be paid.
 * While that is refused or its outcome unknown the change stays open, showing what came of it, and
 * staff ask again. With nothing at the provider to undo, it is closed in the operation's batch.
 */
export async function withdrawPlanChange(
  ctx: HandlerContext,
  row: SubscriptionRow,
  reason: string,
): Promise<AfterCommit<{ id: string; changeId: string; asked: RequestedChange["asked"] }>> {
  if (ctx.principal.kind !== "staff") {
    throw new ValidationError("Only staff withdraw a plan change", { rule: "staff" });
  }
  const { open, stale } = await openChange(ctx.db, row.id, ctx.now);
  const change = open ?? stale;
  if (!change) {
    throw new ConflictError("No plan change is waiting on this subscription", {
      subscription: row.id,
      rule: "no_change",
    });
  }
  if (change.kind === "pause") {
    throw new ConflictError("This is a pause: end or withdraw it with subscription.unpause", {
      subscription: row.id,
      change: change.id,
      rule: "pause",
    });
  }
  const asked = change.call_outcome !== "refused";
  const putBack =
    change.kind === "downgrade" &&
    change.to_amount !== change.from_amount &&
    (change.state === "waiting" || asked);
  const voidIt =
    change.kind === "upgrade" && change.state === "requested" && asked && open !== null;
  if (!putBack && !voidIt) {
    ctx.write(
      ctx.db
        .updateTable("core_subscription_change")
        .set({ state: "withdrawn", action_url: null, updated_at: ctx.now })
        .where("id", "=", change.id)
        .where("state", "=", change.state),
    );
    return afterCommit(async () => ({
      id: row.id,
      changeId: change.id,
      asked: "not_needed" as const,
    }));
  }
  return afterCommit(async () => {
    const outcome = putBack
      ? await askProvider(ctx, row, change.id, "end", "changeSubscription", {
          subscriptionId: row.id,
          subscriptionRef: row.provider_ref,
          // A fresh id each attempt (round three): a retry follows a fresh read at the gatekeeper,
          // never the cached answer of a failed one.
          changeId: `${change.id}_b${Date.now().toString(36)}`,
          amount: change.from_amount,
          currency: row.currency,
          interval: row.interval,
          description: change.from_plan_title.slice(0, 200) || change.from_plan_id,
          when: "next_period",
          taxed: row.tax_code !== null,
          reason,
        })
      : await askProvider(ctx, row, change.id, "end", "voidPendingUpdate", {
          subscriptionId: row.id,
          subscriptionRef: row.provider_ref,
          changeId: change.id,
          reason,
        });
    if (outcome === "sent") {
      await recordOutcome(ctx, change.id, "withdraw", { state: "withdrawn", action_url: null }, [
        "requested",
        "waiting",
      ]);
    }
    return { id: row.id, changeId: change.id, asked: outcome };
  });
}

/** The pause bounds the plan allows, in days (ADR 0531), or null when it is never paused. */
async function pauseBounds(
  ctx: HandlerContext,
  row: SubscriptionRow,
): Promise<{ min: number; max: number } | null> {
  const object = getObject(row.plan_object);
  const declared = object?.sellable?.recurring?.pause;
  if (!object || !declared) return null;
  const planRow = await readGrantItem(ctx, object, row.plan_id);
  const days = (field: string | undefined, fallback: number) => {
    const value = field ? grantFieldValue(object, planRow, field) : null;
    return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
  };
  const min = days(declared.minDays, 1);
  return {
    min,
    max: Math.max(min, Math.min(MAX_PAUSE_DAYS, days(declared.maxDays, MAX_PAUSE_DAYS))),
  };
}

function moment(value: string, field: string): string {
  const at = Date.parse(value);
  if (Number.isNaN(at)) throw new ValidationError(`${field} must be a moment`, { field });
  return new Date(at).toISOString();
}

export interface RequestedPause {
  id: string;
  changeId: string;
  from: string | null;
  until: string;
  asked: "sent" | "pending" | "unknown";
  requested: true;
}

/**
 * Asks the provider to pause `row` from now (or `from`) until `until` (decision 10: staff only,
 * for a set time within the plan's bounds). The host refuses what the provider would (on trial,
 * unpaid, paused, set to end) before asking.
 */
export async function requestPause(
  ctx: HandlerContext,
  row: SubscriptionRow,
  input: { from?: string | undefined; until: string; reason: string },
): Promise<AfterCommit<RequestedPause>> {
  if (ctx.principal.kind !== "staff") {
    throw new ValidationError("Only staff pause a subscription", { rule: "staff" });
  }
  const bounds = await pauseBounds(ctx, row);
  if (!bounds) {
    throw new ValidationError("Subscriptions to this plan are not paused", { rule: "no_pause" });
  }
  row = await requireActive(ctx, row, "paused");
  const from = input.from ? moment(input.from, "from") : null;
  if (from !== null && from <= ctx.now) {
    throw new ValidationError("A pause starts now or later", { field: "from", rule: "past" });
  }
  const until = moment(input.until, "until");
  const days = (Date.parse(until) - Date.parse(from ?? ctx.now)) / DAY;
  if (days < bounds.min || days > bounds.max) {
    throw new ValidationError(
      `A pause of this plan is from ${bounds.min} to ${bounds.max} days; this is ${Math.round(days * 10) / 10}`,
      { field: "until", rule: "pause_length", min: bounds.min, max: bounds.max },
    );
  }
  await claimChangeSlot(ctx, row);
  const id = newId("subscriptionChange");
  ctx.write(
    ctx.db.insertInto("core_subscription_change").values({
      id,
      subscription_id: row.id,
      kind: "pause",
      state: "requested",
      from_plan_id: row.plan_id,
      from_plan_title: row.plan_title,
      from_amount: row.amount,
      to_plan_id: null,
      to_plan_title: null,
      to_amount: null,
      pause_from: from,
      pause_until: until,
      effective_at: from ?? ctx.now,
      // A day after it was due to start, never shown paused: lapsed.
      expires_at: plus(from ?? ctx.now, ASKED_LIFE_MS),
      call_outcome: null,
      call_error: null,
      action_url: null,
      end_outcome: null,
      end_error: null,
      end_at: null,
      reason: input.reason,
      requested_by: requestedBy(ctx),
      requested_at: ctx.now,
      applied_at: null,
      updated_at: ctx.now,
    }),
  );
  return afterCommit(async () => {
    const asked = await askProvider(ctx, row, id, "call", "pauseSubscription", {
      subscriptionId: row.id,
      subscriptionRef: row.provider_ref,
      pauseId: id,
      from,
      until,
      reason: input.reason,
    });
    return {
      id: row.id,
      changeId: id,
      from,
      until,
      asked,
      requested: true as const,
    };
  });
}

/**
 * Asks the provider to end `row`'s pause now (a new period charged from today), or to withdraw a
 * pause asked for that has not started. Staff only. What came of it is kept on the pause
 * (`end_outcome`): one refused or unknown shows on the subscription, and is asked again the same way.
 * A pause not yet started is withdrawn only once the gatekeeper says the call was sent; one running
 * ends when the provider's read says so.
 */
export async function requestUnpause(
  ctx: HandlerContext,
  row: SubscriptionRow,
  reason: string,
): Promise<AfterCommit<{ id: string; asked: "sent" | "pending" | "unknown"; requested: true }>> {
  if (ctx.principal.kind !== "staff") {
    throw new ValidationError("Only staff end a pause", { rule: "staff" });
  }
  const { open, stale } = await openChange(ctx.db, row.id, ctx.now);
  const asked = open ?? stale;
  const scheduled = asked?.kind === "pause" ? asked : null;
  if (row.state !== "paused" && !scheduled) {
    throw new ConflictError("This subscription is not paused, and no pause is asked for", {
      subscription: row.id,
      state: row.state,
    });
  }
  const pause =
    row.state === "paused"
      ? ((await ctx.db
          .selectFrom("core_subscription_change")
          .selectAll()
          .where("subscription_id", "=", row.id)
          .where("kind", "=", "pause")
          .where("state", "in", ["applied", "requested"])
          .orderBy("requested_at", "desc")
          .executeTakeFirst()) ?? null)
      : scheduled;
  if (!pause) {
    throw new ConflictError(
      "This subscription was paused at the payment provider, not by the host: resume it there",
      { subscription: row.id, rule: "provider_pause" },
    );
  }
  const withdrawing = row.state !== "paused";
  return afterCommit(async () => {
    const outcome = await askProvider(ctx, row, pause.id, "end", "unpauseSubscription", {
      subscriptionId: row.id,
      subscriptionRef: row.provider_ref,
      pauseId: pause.id,
      reason,
    });
    if (withdrawing && outcome === "sent") {
      await recordOutcome(ctx, pause.id, "withdraw", { state: "withdrawn" }, ["requested"]);
    }
    return {
      id: row.id,
      asked: outcome,
      requested: true as const,
    };
  });
}

/**
 * What came of an at-once action, from the integration host's answer: applied (`sent`), waiting for
 * approval (`pending`), refused by the gatekeeper with nothing changed (`refused`), or anything else
 * (`unknown`: it may have reached the provider).
 */
function outcomeOf(result: {
  pending: unknown[];
  applied: unknown[];
  failed?: { outcome: "refused" | "unknown" | "retryable"; message: string }[];
}): { outcome: CallOutcome; error: string | null } {
  if (result.applied.length) return { outcome: "sent", error: null };
  if (result.pending.length) return { outcome: "pending", error: null };
  const failed = result.failed?.[0];
  // The gatekeeper's typed outcome (`integrations/outcome.ts`), never its wording. A retryable
  // failure sent nothing (the action is pending again at the gatekeeper): nothing changed.
  if (failed && (failed.outcome === "refused" || failed.outcome === "retryable")) {
    return { outcome: "refused", error: failed.message.slice(0, 500) };
  }
  return {
    outcome: "unknown",
    error: failed
      ? failed.message.slice(0, 500)
      : "The payment provider's answer did not say whether it changed",
  };
}

/**
 * Writes what came of a call on the change, with an audit row of the host's (review of 32b).
 * Conditional on the change's state, so a verified read applied meanwhile is not undone; the audit
 * row says whether it was written (second review: it never claims a write that matched nothing).
 * Two statements, not a batch: a member's call has no pipeline after the commit.
 */
async function recordOutcome(
  ctx: HandlerContext,
  changeId: string,
  what: "call" | "end" | "withdraw",
  values: Partial<ChangeRow>,
  fromStates: ChangeRow["state"][],
): Promise<boolean> {
  const at = new Date().toISOString();
  const updated = await ctx.db
    .updateTable("core_subscription_change")
    .set({ ...values, updated_at: at })
    .where("id", "=", changeId)
    .where("state", "in", fromStates)
    .executeTakeFirst();
  const written = Number(updated.numUpdatedRows ?? 0) > 0;
  await ctx.db
    .insertInto("core_audit")
    .values({
      id: newId("audit"),
      at,
      operation: "subscription.change.outcome",
      risk: "write",
      // The host's own record of what the provider answered, not a caller's act.
      actor: "automation",
      user_id: null,
      origin: JSON.stringify({ surface: "system", automationId: "subscription.change.outcome" }),
      input: JSON.stringify({ changeId, what, by: ctx.operation ?? null }),
      result: JSON.stringify(
        written
          ? { written: true, values }
          : { written: false, values, why: "the change had moved on: nothing was written" },
      ),
      gate_decision: "auto",
      outcome: "ok",
      error: null,
    })
    .execute();
  return written;
}

/**
 * The provider asked, after the change's row is committed. `which`: the change's own call, or the
 * call that ends or undoes it. Only a refusal (nothing changed) closes an asked change, as lapsed;
 * an unknown outcome leaves it open for verified reads to decide until it expires. Throws a
 * refusal to the caller.
 */
async function askProvider(
  ctx: HandlerContext,
  row: SubscriptionRow,
  changeId: string,
  which: "call" | "end",
  method: "changeSubscription" | "pauseSubscription" | "unpauseSubscription" | "voidPendingUpdate",
  request: Record<string, unknown>,
): Promise<"sent" | "pending" | "unknown"> {
  const at = new Date().toISOString();
  const record = (outcome: CallOutcome, error: string | null) =>
    which === "call"
      ? recordOutcome(
          ctx,
          changeId,
          "call",
          {
            call_outcome: outcome,
            call_error: error,
            ...(outcome === "refused" ? { state: "lapsed" as const } : {}),
          },
          ["requested", "waiting"],
        )
      : recordOutcome(
          ctx,
          changeId,
          "end",
          { end_outcome: outcome, end_error: error, end_at: at },
          ["requested", "waiting", "applied"],
        );
  const target = await paymentsTarget(ctx.db);
  if (target.provider !== row.provider) {
    const message = `This subscription is with ${row.provider}, and payments now use ${target.provider}`;
    await record("refused", message);
    throw new ConflictError(message, { rule: "provider" });
  }
  let result: Awaited<ReturnType<typeof callSubscriptionGatekeeper>>;
  try {
    result = await callSubscriptionGatekeeper(ctx.integrations, target, method, request);
  } catch (error) {
    // The call itself failed: it may have been submitted before the answer was lost.
    await record("unknown", error instanceof Error ? error.message.slice(0, 500) : String(error));
    return "unknown";
  }
  const { outcome, error } = outcomeOf(result);
  await record(outcome, error);
  if (outcome === "refused") {
    throw new ConflictError(`The payment provider refused it, so nothing changed: ${error}`, {
      subscription: row.id,
      change: changeId,
      rule: "provider_refused",
    });
  }
  return outcome;
}

// --- Following a verified read (events.ts) ----------------------------------------------------

/** What a read does to a subscription's open change. */
export interface FollowedChange {
  /** The subscription with the plan it holds after this read (a change applied, or not). */
  row: SubscriptionRow;
  /** The member now holds another plan: what the subscription grants follows it. */
  planChanged: boolean;
}

/**
 * The price the provider may show for `row` besides the agreed one: an open plan change's new
 * price (an upgrade waiting on its charge, a downgrade waiting for its period). Only an open
 * change (`openChange`'s `open`): a lapsed or withdrawn one's price is a change at the provider.
 */
export function alsoAgreed(open: ChangeRow | null): number | null {
  return open && open.kind !== "pause" ? open.to_amount : null;
}

/**
 * Applies what a fresh verified read says of `row`'s open change, in the event's batch, and
 * returns the subscription with the plan it now holds. Called only with a read the host moves
 * from (not stale, the subscription not ended), and only with an open change.
 */
export function followChange(
  ctx: HandlerContext,
  row: SubscriptionRow,
  read: ProviderSubscription,
  change: ChangeRow | null,
): FollowedChange {
  if (!change || !isOpen(change, ctx.now)) return { row, planChanged: false };
  const set = (values: Partial<ChangeRow>) =>
    ctx.write(
      ctx.db
        .updateTable("core_subscription_change")
        .set({ ...values, updated_at: ctx.now })
        .where("id", "=", change.id)
        .where("state", "=", change.state),
    );
  if (change.kind === "pause") {
    if (change.state === "requested" && read.status === "paused") {
      set({ state: "applied", applied_at: ctx.now });
    }
    return { row, planChanged: false };
  }
  const sameTerms =
    read.currency === row.currency && (read.interval === null || read.interval === row.interval);
  const shown = sameTerms && read.amount === change.to_amount;
  const toPlan = (): SubscriptionRow => ({
    ...row,
    plan_id: change.to_plan_id ?? row.plan_id,
    plan_title: change.to_plan_title ?? row.plan_title,
    amount: change.to_amount ?? row.amount,
  });
  if (change.kind === "upgrade") {
    if (change.state !== "requested" || !shown) return { row, planChanged: false };
    set({ state: "applied", applied_at: ctx.now, effective_at: ctx.now, action_url: null });
    postChange(ctx, row, change);
    return { row: toPlan(), planChanged: true };
  }
  const samePrice = change.to_amount === row.amount;
  // A waiting downgrade the provider no longer shows (its price put back at the provider): closed.
  if (change.state === "waiting" && !samePrice && sameTerms && read.amount === row.amount) {
    set({ state: "withdrawn" });
    return { row, planChanged: false };
  }
  if (change.state === "requested") {
    if (!shown) return { row, planChanged: false };
    // Shown at the provider. Which period is the first billed at the new price (round three: the
    // renewal invoice's amount is not used, since a coupon or account credit changes it): a read
    // period begun after the change was asked was invoiced after the provider took the new price
    // (the call is made after the change is written), so it is the first at it; one begun before,
    // the next one is. The one ordering this cannot tell is a renewal in the seconds between the
    // change being written and the provider's call landing (ADR 0530).
    const billedNew =
      read.currentPeriodStart !== null &&
      Date.parse(read.currentPeriodStart) > Date.parse(change.requested_at);
    const effective = billedNew
      ? (read.currentPeriodStart ?? ctx.now)
      : (read.currentPeriodEnd ?? change.effective_at ?? ctx.now);
    if (billedNew) {
      set({ state: "applied", applied_at: ctx.now, effective_at: effective });
      postChange(ctx, row, change);
      return { row: toPlan(), planChanged: true };
    }
    set({
      state: "waiting",
      effective_at: effective,
      expires_at: plus(effective, WAITING_LIFE_MS),
    });
    return { row, planChanged: false };
  }
  const effective = change.effective_at ?? ctx.now;
  const nextPeriod =
    read.currentPeriodStart !== null &&
    Date.parse(read.currentPeriodStart) >= Date.parse(effective);
  if (!nextPeriod) return { row, planChanged: false };
  // The same price never needed the provider; any other, its read must show the new price.
  if (!shown && !samePrice) return { row, planChanged: false };
  set({ state: "applied", applied_at: ctx.now });
  postChange(ctx, row, change);
  return { row: toPlan(), planChanged: true };
}

/**
 * The provider's page to confirm an open upgrade's charge (3D Secure), in the event's batch: the
 * subscription stays active under a pending update, so 32a's `action_url` (for owing states) never
 * shows it (review of 32b). Shown to the payer on the change.
 */
export function upgradeNeedsAction(
  ctx: HandlerContext,
  change: ChangeRow | null,
  invoice: Pick<ProviderInvoice, "status" | "hostedUrl" | "billingReason">,
): boolean {
  if (
    !change ||
    change.kind !== "upgrade" ||
    change.state !== "requested" ||
    invoice.status !== "open" ||
    invoice.billingReason !== "subscription_update" ||
    !invoice.hostedUrl
  ) {
    return false;
  }
  ctx.write(
    ctx.db
      .updateTable("core_subscription_change")
      .set({ action_url: invoice.hostedUrl, updated_at: ctx.now })
      .where("id", "=", change.id)
      .where("state", "=", "requested"),
  );
  return true;
}

function postChange(ctx: HandlerContext, row: SubscriptionRow, change: ChangeRow): void {
  if (!row.payer_person_id) return;
  ctx.postActivity({
    subject: `Plan changed: ${change.from_plan_title} to ${change.to_plan_title}`,
    payload: {
      kind: "subscription.plan_changed",
      subscriptionId: row.id,
      changeId: change.id,
      from: change.from_plan_id,
      to: change.to_plan_id,
      amount: change.to_amount,
      currency: row.currency,
    },
    links: [{ object: "person", id: row.payer_person_id }],
  });
}

/**
 * A paid invoice that is part of a period the host asked for, and so not flagged:
 * - an upgrade's prorated charge: an invoice the provider raised for a subscription update
 *   (`billing_reason` `subscription_update`), at most the difference in price, for an upgrade
 *   still open or applied in the last two days;
 * - the first period after a pause: the period's price less the unused time of the one paused in.
 * Null for any other invoice.
 */
export async function expectedPart(
  db: Kysely<CoreDatabase>,
  row: SubscriptionRow,
  invoice: Pick<ProviderInvoice, "amountPaid" | "currency" | "periodStart" | "billingReason">,
  now: string,
  /** A change this event revived or applied (written in its batch, not yet in the database). */
  known: ChangeRow | null = null,
): Promise<{ title: string; planId: string } | null> {
  if (invoice.currency !== row.currency || invoice.amountPaid <= 0) return null;
  const stored = await db
    .selectFrom("core_subscription_change")
    .selectAll()
    .where("subscription_id", "=", row.id)
    .where("state", "in", ["requested", "applied", "lapsed"])
    .orderBy("requested_at", "desc")
    .limit(5)
    .execute();
  const changes = stored.map((c) => (known && c.id === known.id ? known : c));
  for (const change of changes) {
    if (
      change.kind === "upgrade" &&
      change.to_amount !== null &&
      invoice.billingReason === "subscription_update"
    ) {
      const live =
        change.state === "requested"
          ? isOpen(change, now)
          : change.applied_at !== null &&
            Date.parse(change.applied_at) + PRORATION_MATCH_MS > Date.parse(now);
      if (live && invoice.amountPaid <= change.to_amount - change.from_amount) {
        return {
          title: `${change.to_plan_title}: the rest of the period (upgrade from ${change.from_plan_title})`,
          planId: change.to_plan_id ?? row.plan_id,
        };
      }
    }
    if (change.kind === "pause" && change.state === "applied" && change.applied_at) {
      const after = invoice.periodStart && invoice.periodStart >= change.applied_at;
      const first = await db
        .selectFrom("core_order")
        .select("id")
        .where("subscription_id", "=", row.id)
        .where("period_start", ">=", change.applied_at)
        .executeTakeFirst();
      if (after && !first && invoice.amountPaid <= row.amount) {
        return {
          title: `${row.plan_title} (after a pause: the paused time credited)`,
          planId: row.plan_id,
        };
      }
    }
  }
  return null;
}

/** Words for staff about a declined upgrade (events.ts): the plan stays until the charge is paid. */
export function declinedUpgradeWords(
  change: ChangeRow,
  amountDue: number,
  currency: string,
): string {
  return (
    `The charge of ${formatMoney(amountDue, currency)} for the upgrade to ${change.to_plan_title} ` +
    `failed. The subscription stays on ${change.from_plan_title} and keeps running; the upgrade ` +
    "applies only if the payer pays it (the provider keeps it for up to 23 hours)."
  );
}
