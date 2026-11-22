// Plan changes and pauses (stage 32b, decisions 10, 11 and 12; ADRs 0530 and 0531). The provider
// runs both; the host asks it, through the payments gatekeeper, and moves nothing until a verified
// read shows what happened (events.ts calls `followChange` in each event's batch).
//
//   an upgrade      the new plan costs more: the provider charges the rest of the period at once,
//                   prorated, and applies the new price only once that charge is paid (a pending
//                   update). The member holds the new plan from the read that shows the new price.
//   a downgrade     costs the same or less: nothing is prorated or refunded; the provider charges
//                   the new price from the next invoice. The member keeps the plan paid for until
//                   the period ends, and holds the new one from the read that shows the next period.
//   a pause         staff only, for a set time within the plan's bounds: the provider's own pause
//                   (status `paused`: no invoices; the host gives and spends nothing), resumed by
//                   the provider on its date with a new period, charged less the unused time of the
//                   period it was paused in. Ended early by staff.
//
// Each is a row of core_subscription_change, written in the operation's batch before the provider
// is asked (the call is made after the commit, so two asked at once ask the provider once: the
// open-change index refuses the second batch). A dry run commits nothing and so asks nothing.
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

/** An upgrade the provider has not shown within a day is lapsed: its pending update expires in 23 hours. */
export const UPGRADE_LAPSES_MS = 24 * 3_600_000;
/** The longest pause the host asks for (the gatekeeper's limit too). */
export const MAX_PAUSE_DAYS = 366;
const DAY = 86_400_000;

/** The subscription's open change (asked, or a downgrade waiting for its period), or null. */
export async function openChange(
  db: Kysely<CoreDatabase>,
  subscriptionId: string,
): Promise<ChangeRow | null> {
  return (
    (await db
      .selectFrom("core_subscription_change")
      .selectAll()
      .where("subscription_id", "=", subscriptionId)
      .where("state", "in", ["requested", "waiting"])
      .executeTakeFirst()) ?? null
  );
}

/** Whether an open change is an upgrade the provider never showed within a day. */
function lapsed(change: ChangeRow, now: string): boolean {
  return (
    change.kind === "upgrade" &&
    change.state === "requested" &&
    Date.parse(change.requested_at) + UPGRADE_LAPSES_MS < Date.parse(now)
  );
}

function requestedBy(ctx: HandlerContext): string {
  const caller = ctx.principal;
  return caller.kind === "customer"
    ? `customer:${caller.customerId}`
    : caller.kind === "staff"
      ? `staff:${caller.userId}`
      : "public";
}

/**
 * The subscription's one open change, refused when there is one; an upgrade the provider never
 * showed (lapsed) is closed in this batch instead.
 */
async function claimChangeSlot(ctx: HandlerContext, row: SubscriptionRow): Promise<void> {
  const open = await openChange(ctx.db, row.id);
  if (!open) return;
  if (lapsed(open, ctx.now)) {
    ctx.write(
      ctx.db
        .updateTable("core_subscription_change")
        .set({ state: "lapsed", updated_at: ctx.now })
        .where("id", "=", open.id)
        .where("state", "=", "requested"),
    );
    return;
  }
  throw new ConflictError(
    open.kind === "pause"
      ? "A pause is already asked for on this subscription: end it first"
      : open.state === "waiting"
        ? `This subscription already changes to ${open.to_plan_title} when its period ends, on ${open.effective_at?.slice(0, 10)}`
        : `A change to ${open.to_plan_title} is waiting for the payment provider`,
    { subscription: row.id, change: open.id, rule: "change_open" },
  );
}

/** Refused unless the subscription is active and not set to end. */
function requireActive(row: SubscriptionRow, what: string): void {
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
}

export interface RequestedChange {
  id: string;
  changeId: string;
  kind: "upgrade" | "downgrade";
  /** When the member holds the new plan: null for an upgrade (once its charge is paid). */
  effectiveAt: string | null;
  amount: number;
  currency: string;
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
  requireActive(row, "changed");
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
  const effectiveAt = kind === "downgrade" ? (row.current_period_end ?? ctx.now) : null;
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
      reason: input.reason,
      requested_by: requestedBy(ctx),
      requested_at: ctx.now,
      applied_at: null,
      updated_at: ctx.now,
    }),
  );
  const out: RequestedChange = {
    id: row.id,
    changeId: id,
    kind,
    effectiveAt,
    amount: plan.unitPrice,
    currency: row.currency,
    requested: true,
  };
  if (samePrice) return afterCommit(async () => out);
  return afterCommit(async () => {
    await askProvider(ctx, row, id, "changeSubscription", {
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
    return out;
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
  requireActive(row, "paused");
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
      reason: input.reason,
      requested_by: requestedBy(ctx),
      requested_at: ctx.now,
      applied_at: null,
      updated_at: ctx.now,
    }),
  );
  return afterCommit(async () => {
    await askProvider(ctx, row, id, "pauseSubscription", {
      subscriptionId: row.id,
      subscriptionRef: row.provider_ref,
      pauseId: id,
      from,
      until,
      reason: input.reason,
    });
    return { id: row.id, changeId: id, from, until, requested: true as const };
  });
}

/**
 * Asks the provider to end `row`'s pause now (a new period charged from today), or to withdraw a
 * pause asked for later that has not started. Staff only.
 */
export async function requestUnpause(
  ctx: HandlerContext,
  row: SubscriptionRow,
  reason: string,
): Promise<AfterCommit<{ id: string; requested: true }>> {
  if (ctx.principal.kind !== "staff") {
    throw new ValidationError("Only staff end a pause", { rule: "staff" });
  }
  const open = await openChange(ctx.db, row.id);
  const scheduled = open?.kind === "pause" ? open : null;
  if (row.state !== "paused" && !scheduled) {
    throw new ConflictError("This subscription is not paused, and no pause is asked for", {
      subscription: row.id,
      state: row.state,
    });
  }
  const pause =
    scheduled ??
    (await ctx.db
      .selectFrom("core_subscription_change")
      .selectAll()
      .where("subscription_id", "=", row.id)
      .where("kind", "=", "pause")
      .where("state", "=", "applied")
      .orderBy("requested_at", "desc")
      .executeTakeFirst());
  const pauseId = pause?.id ?? newId("subscriptionChange");
  return afterCommit(async () => {
    await callSubscriptionGatekeeper(
      ctx.integrations,
      await paymentsTarget(ctx.db),
      "unpauseSubscription",
      {
        subscriptionId: row.id,
        subscriptionRef: row.provider_ref,
        pauseId,
        reason,
      },
    );
    // A pause not yet started is withdrawn: the provider will not start it. One running ends when
    // the provider's read says so.
    if (scheduled && row.state !== "paused") {
      await ctx.db
        .updateTable("core_subscription_change")
        .set({ state: "withdrawn", updated_at: new Date().toISOString() })
        .where("id", "=", scheduled.id)
        .where("state", "=", "requested")
        .execute();
    }
    return { id: row.id, requested: true as const };
  });
}

/**
 * The provider asked, after the change's row is committed. A call refused, or one that failed
 * before reaching the provider, closes the row (lapsed), so the member can ask again.
 */
async function askProvider(
  ctx: HandlerContext,
  row: SubscriptionRow,
  changeId: string,
  method: "changeSubscription" | "pauseSubscription",
  request: Record<string, unknown>,
): Promise<void> {
  try {
    const target = await paymentsTarget(ctx.db);
    if (target.provider !== row.provider) {
      throw new ConflictError(
        `This subscription is with ${row.provider}, and payments now use ${target.provider}`,
      );
    }
    await callSubscriptionGatekeeper(ctx.integrations, target, method, request);
  } catch (error) {
    await ctx.db
      .updateTable("core_subscription_change")
      .set({ state: "lapsed", updated_at: new Date().toISOString() })
      .where("id", "=", changeId)
      .where("state", "=", "requested")
      .execute();
    throw error;
  }
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
 * price (an upgrade waiting on its charge, a downgrade waiting for its period). A read at that
 * price is the change the host asked for, not a change made at the provider some other way.
 */
export function alsoAgreed(change: ChangeRow | null): number | null {
  return change && change.kind !== "pause" ? change.to_amount : null;
}

/**
 * Applies what a fresh verified read says of `row`'s open change, in the event's batch, and
 * returns the subscription with the plan it now holds. Called only with a read the host moves
 * from (not stale, the subscription not ended).
 */
export function followChange(
  ctx: HandlerContext,
  row: SubscriptionRow,
  read: ProviderSubscription,
  change: ChangeRow | null,
): FollowedChange {
  if (!change) return { row, planChanged: false };
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
  const shown =
    read.amount === change.to_amount &&
    read.currency === row.currency &&
    (read.interval === null || read.interval === row.interval);
  const toPlan = (): SubscriptionRow => ({
    ...row,
    plan_id: change.to_plan_id ?? row.plan_id,
    plan_title: change.to_plan_title ?? row.plan_title,
    amount: change.to_amount ?? row.amount,
  });
  if (change.kind === "upgrade") {
    if (change.state !== "requested" || !shown) return { row, planChanged: false };
    set({ state: "applied", applied_at: ctx.now, effective_at: ctx.now });
    postChange(ctx, row, change);
    return { row: toPlan(), planChanged: true };
  }
  // A downgrade: shown at the provider (its price changed), then held from the next period.
  const effective = change.effective_at ?? ctx.now;
  const nextPeriod =
    read.currentPeriodStart !== null &&
    Date.parse(read.currentPeriodStart) >= Date.parse(effective);
  if (change.state === "requested" && !shown) return { row, planChanged: false };
  if (!nextPeriod) {
    if (change.state === "requested") set({ state: "waiting" });
    return { row, planChanged: false };
  }
  // The same price never needed the provider; any other, its read must show the new price.
  if (!shown && change.to_amount !== row.amount) return { row, planChanged: false };
  set({ state: "applied", applied_at: ctx.now });
  postChange(ctx, row, change);
  return { row: toPlan(), planChanged: true };
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
 * A paid invoice that is part of a period the host asked for, and so not flagged: an upgrade's
 * prorated charge (at most the difference in price), or the first period after a pause (the
 * period's price less the unused time of the one paused in). Null for any other invoice.
 */
export async function expectedPart(
  db: Kysely<CoreDatabase>,
  row: SubscriptionRow,
  invoice: Pick<ProviderInvoice, "amountPaid" | "currency" | "periodStart">,
  now: string,
): Promise<{ title: string; planId: string } | null> {
  if (invoice.currency !== row.currency || invoice.amountPaid <= 0) return null;
  const changes = await db
    .selectFrom("core_subscription_change")
    .selectAll()
    .where("subscription_id", "=", row.id)
    .where("state", "in", ["requested", "applied"])
    .orderBy("requested_at", "desc")
    .limit(5)
    .execute();
  for (const change of changes) {
    if (change.kind === "upgrade" && change.to_amount !== null) {
      const recent =
        change.state === "requested" ||
        Date.parse(change.applied_at ?? change.requested_at) + 2 * UPGRADE_LAPSES_MS >
          Date.parse(now);
      const proration =
        invoice.amountPaid <= change.to_amount - change.from_amount &&
        invoice.amountPaid !== change.from_amount &&
        invoice.amountPaid !== change.to_amount;
      if (recent && proration) {
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
