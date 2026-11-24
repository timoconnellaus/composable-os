// One free trial per Person per plan object (stage 32a, build step 3, ADR 0489). The rule is the
// host's, in `subscription.start`; no block, pack or caller decides it.
//
// - **Only a proved holder gets a trial.** A signed-in customer starting their own subscription,
//   or a person on staff with `subscriptions:manage` starting one for a Person. A guest only typed
//   an address: a trial on it would be the address's Person's, so a guest could spend someone
//   else's trial, and the page's answer would tell them whether that person had one. A guest pays
//   from the start (`noTrial: "sign_in"`); the owner decided (2026-11-22) that a later setting will
//   let a new visitor confirm their address with a code first, and that path hooks in there.
// - **A trial is used when the provider confirms it**, not when a page is opened: the verified
//   event that makes (or moves) a subscription opened with the plan's trial marks it used, in its
//   own batch. A continuation's free time until a date (step 4) is not the trial.
// - **A hold is released only on the provider's word.** A checkout opened with a trial holds it
//   (`core_subscription_trial`). Before a later start is given the trial, the host asks the
//   provider about every unreleased hold: expired (never completed) releases it; completed means
//   the trial is used; still open keeps it held. If the provider cannot be asked, no trial now.
// - **Two starts at once give one trial.** The database refuses a hold while another is
//   unreleased (migration 0531's trigger), so the second start's batch fails and nothing of it is
//   recorded.
// - **A page goes back only to whoever opened it**, with the terms it was opened with, and only
//   while the provider says it is still open. Anyone else gets a fresh page with no trial.
// - Per plan object (the spec's guess): a second course plan later gives no second trial.
// - **A Person is everyone sharing their folded address** (ADR 0692, #225): `a+1@x` and `a+2@x`
//   get one trial between them. Each check below counts every live Person with an address whose
//   `+tag`-less form is one of the holder's, and migration 0955's trigger refuses a hold for one
//   while another's is unreleased or used, so two starts at once by them give one trial.
import { samePeople } from "../customers/accounts.ts";
import type { HandlerContext } from "../operation.ts";
import { callSubscriptionGatekeeper, type PaymentsTarget } from "../orders/gateway.ts";

/**
 * How long after its page expires a hold is kept as live: the provider's confirmation of a page
 * completed just before it expired arrives after it, normally within seconds.
 */
export const TRIAL_HOLD_AFTER_EXPIRY_MS = 15 * 60_000;

/**
 * Why a plan's trial is not given:
 * - `sign_in`: a guest (only a signed-in customer gets one);
 * - `used`: the holder has had one on this plan object;
 * - `permission`: staff starting it without `subscriptions:manage`, or not a person;
 * - `held`: another page with the trial is open for the holder (someone else opened it, or for
 *   another plan record);
 * - `unconfirmed`: the provider could not be asked whether an earlier page was completed;
 * - `continuation`: the holder is in a continuation on this plan object (ADR 0492): an offer they
 *   can still take, or a subscription started from one that has not ended. Its free time is not
 *   the trial, so once that subscription ends (or the offer expired untaken) the one-trial rule
 *   applies as for anyone.
 */
export const NO_TRIAL_REASONS = [
  "sign_in",
  "used",
  "permission",
  "held",
  "unconfirmed",
  "continuation",
] as const;
export type NoTrial = (typeof NO_TRIAL_REASONS)[number];

export interface OpenPage {
  checkoutId: string;
  url: string;
  expiresAt: string;
  amount: number;
  trialDays: number;
}

export type TrialDecision =
  | { give: true }
  | { give: false; reason: NoTrial | null }
  /** The caller's own page for this plan, with its trial, is still open: give them that. */
  | { give: false; reason: null; open: OpenPage };

/**
 * Whether `holderPersonId` (or a Person sharing a folded address with them) has used the plan's
 * trial on any record of `planObject`: a hold the
 * provider's confirmation marked, or a subscription opened with the plan's trial days (never one
 * whose free time was only a date: a continuation, step 4). `except` leaves out one checkout
 * and its subscription (the one being confirmed).
 */
export async function trialUsed(
  ctx: Pick<HandlerContext, "db">,
  holderPersonId: string,
  planObject: string,
  except?: string,
): Promise<boolean> {
  const held = await ctx.db
    .selectFrom("core_subscription_trial")
    .select("checkout_id")
    .where("holder_person_id", "in", samePeople(ctx.db, holderPersonId))
    .where("plan_object", "=", planObject)
    .where("used_at", "is not", null)
    .$if(except !== undefined, (q) => q.where("checkout_id", "!=", except ?? ""))
    .executeTakeFirst();
  if (held) return true;
  const had = await ctx.db
    .selectFrom("core_subscription as s")
    .innerJoin("core_subscription_checkout as c", "c.id", "s.id")
    .select("s.id")
    .where("s.holder_person_id", "in", samePeople(ctx.db, holderPersonId))
    .where("s.plan_object", "=", planObject)
    .where("s.trial_end", "is not", null)
    .where("c.trial_days", "is not", null)
    .$if(except !== undefined, (q) => q.where("s.id", "!=", except ?? ""))
    .executeTakeFirst();
  return Boolean(had);
}

/**
 * Whether `holderPersonId` (or a Person sharing a folded address with them, ADR 0692) is in a
 * continuation on `planObject` now (ADR 0492): an offer they can
 * still take (not taken, not expired, not withdrawn), or a subscription started from an offer that
 * has not ended. No trial then, on top of the continuation or by cancelling and starting again
 * during it. Once that subscription has ended, or the offer expired untaken, the one-trial rule
 * alone applies: a continuation is not the trial (owner decision, 2026-11-22).
 */
export async function hasContinuation(
  ctx: Pick<HandlerContext, "db" | "now">,
  holderPersonId: string,
  planObject: string,
): Promise<boolean> {
  const open = await ctx.db
    .selectFrom("core_subscription_offer")
    .select("id")
    .where("person_id", "in", samePeople(ctx.db, holderPersonId))
    .where("plan_object", "=", planObject)
    .where("subscription_id", "is", null)
    .where("withdrawn_at", "is", null)
    .where("free_until", ">", ctx.now)
    .executeTakeFirst();
  if (open) return true;
  const running = await ctx.db
    .selectFrom("core_subscription as s")
    .innerJoin("core_subscription_checkout as c", "c.id", "s.id")
    .select("s.id")
    .where("s.holder_person_id", "in", samePeople(ctx.db, holderPersonId))
    .where("s.plan_object", "=", planObject)
    .where("c.offer_id", "is not", null)
    .where("s.state", "not in", ["ended", "expired"])
    .executeTakeFirst();
  return Boolean(running);
}

/** The provider's word on one page: open, complete, expired, or null when it cannot be asked. */
export async function pageStatus(
  ctx: HandlerContext,
  target: PaymentsTarget,
  ref: string,
): Promise<"open" | "complete" | "expired" | null> {
  try {
    const result = await callSubscriptionGatekeeper(
      ctx.integrations,
      target,
      "getSubscriptionCheckout",
      ref,
    );
    const status = (result.value as { status?: unknown } | null)?.status;
    return status === "open" || status === "complete" || status === "expired" ? status : null;
  } catch {
    return null;
  }
}

/**
 * Whether a start gets the plan's trial. `caller` is who is starting it (`customer:<id>`,
 * `staff:<user id>`), and `allowed` whether that caller may give a trial at all (a proved holder).
 * Queues, in the start's batch, the release of a lapsed page the provider says expired, and the
 * use of the trial for one it says was completed.
 */
export async function decideTrial(
  ctx: HandlerContext,
  start: {
    holderPersonId: string;
    planObject: string;
    planId: string;
    caller: string;
    allowed: "yes" | "guest" | "no_permission";
    target: PaymentsTarget;
  },
  trialDays: number | null,
): Promise<TrialDecision> {
  if (!trialDays || trialDays <= 0) return { give: false, reason: null };
  if (start.allowed === "guest") return { give: false, reason: "sign_in" };
  if (start.allowed === "no_permission") return { give: false, reason: "permission" };
  if (await trialUsed(ctx, start.holderPersonId, start.planObject)) {
    return { give: false, reason: "used" };
  }
  if (await hasContinuation(ctx, start.holderPersonId, start.planObject)) {
    return { give: false, reason: "continuation" };
  }
  const pending = await ctx.db
    .selectFrom("core_subscription_trial")
    .selectAll()
    .where("holder_person_id", "in", samePeople(ctx.db, start.holderPersonId))
    .where("plan_object", "=", start.planObject)
    .where("used_at", "is", null)
    .where("released_at", "is", null)
    .orderBy("created_at", "desc")
    .execute();
  let held: OpenPage | null = null;
  let blocked: NoTrial | null = null;
  for (const row of pending) {
    const status = await pageStatus(ctx, start.target, row.checkout_ref);
    if (status === "complete") {
      // Completed: the provider started a subscription with the trial; it is used, whether or not
      // its confirmation has arrived yet.
      ctx.write(
        ctx.db
          .updateTable("core_subscription_trial")
          .set({ used_at: ctx.now })
          .where("checkout_id", "=", row.checkout_id)
          .where("used_at", "is", null),
      );
      return { give: false, reason: "used" };
    }
    if (status === "expired") {
      ctx.write(
        ctx.db
          .updateTable("core_subscription_trial")
          .set({ released_at: ctx.now })
          .where("checkout_id", "=", row.checkout_id)
          .where("used_at", "is", null)
          .where("released_at", "is", null),
      );
      continue;
    }
    if (status === null) {
      blocked = "unconfirmed";
      continue;
    }
    // Still open. The caller's own page for this plan and this holder comes back, with its terms;
    // anyone else's is never handed out. The holder is compared too: the holds read are those of
    // every Person sharing a folded address, and staff opening one for `+1` and then starting one
    // for `+2` must get `+2` a page of their own (ADR 0692).
    const expiresAt = new Date(
      Date.parse(row.held_until) - TRIAL_HOLD_AFTER_EXPIRY_MS,
    ).toISOString();
    if (
      !held &&
      row.opened_by === start.caller &&
      row.plan_id === start.planId &&
      row.holder_person_id === start.holderPersonId
    ) {
      held = {
        checkoutId: row.checkout_id,
        url: row.url,
        expiresAt,
        amount: row.amount,
        trialDays: row.trial_days,
      };
    } else if (!blocked) {
      blocked = "held";
    }
  }
  if (held) return { give: false, reason: null, open: held };
  if (blocked) return { give: false, reason: blocked };
  return { give: true };
}

/** A moment the gatekeeper reported, or null when it is not one (never thrown on). */
export function readableInstant(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : new Date(at).toISOString();
}

/** The hold a checkout opened with a trial takes, for the start's batch. */
export function holdTrialStatement(
  ctx: HandlerContext,
  hold: {
    checkoutId: string;
    checkoutRef: string;
    holderPersonId: string;
    planObject: string;
    planId: string;
    url: string;
    openedBy: string;
    amount: number;
    trialDays: number;
    expiresAt: string | null;
  },
) {
  // A page with no readable expiry is held for a day (Stripe's longest lifetime).
  const expires =
    readableInstant(hold.expiresAt) ?? new Date(Date.parse(ctx.now) + 24 * 3_600_000).toISOString();
  return ctx.db.insertInto("core_subscription_trial").values({
    checkout_id: hold.checkoutId,
    holder_person_id: hold.holderPersonId,
    plan_object: hold.planObject,
    plan_id: hold.planId,
    url: hold.url,
    checkout_ref: hold.checkoutRef,
    opened_by: hold.openedBy,
    amount: hold.amount,
    trial_days: hold.trialDays,
    held_until: new Date(Date.parse(expires) + TRIAL_HOLD_AFTER_EXPIRY_MS).toISOString(),
    created_at: ctx.now,
  });
}

/**
 * Marks the trial of the checkout `row` was opened by used, for a verified event's batch, when the
 * checkout was opened with the plan's trial days and the provider's read has a trial on it. A free
 * time until a date (a continuation, step 4) is not the trial and marks nothing. Never fails the
 * batch (an update, not an insert). Returns whether the holder had used a trial on this plan
 * object before (a second trial the hold did not stop: staff are told).
 */
export async function useTrial(
  ctx: HandlerContext,
  row: {
    id: string;
    holder_person_id: string | null;
    plan_object: string;
    trial_end: string | null;
  },
): Promise<{ second: boolean }> {
  if (!row.trial_end || !row.holder_person_id) return { second: false };
  const checkout = await ctx.db
    .selectFrom("core_subscription_checkout")
    .select("trial_days")
    .where("id", "=", row.id)
    .executeTakeFirst();
  if (!checkout?.trial_days) return { second: false };
  const mine = await ctx.db
    .selectFrom("core_subscription_trial")
    .select(["used_at"])
    .where("checkout_id", "=", row.id)
    .executeTakeFirst();
  if (mine?.used_at) return { second: false };
  const second = await trialUsed(ctx, row.holder_person_id, row.plan_object, row.id);
  if (mine) {
    ctx.write(
      ctx.db
        .updateTable("core_subscription_trial")
        .set({ used_at: ctx.now })
        .where("checkout_id", "=", row.id)
        .where("used_at", "is", null),
    );
  }
  return { second };
}
