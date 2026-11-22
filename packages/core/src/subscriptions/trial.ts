// One free trial per Person per plan object (stage 32a, build step 3, ADR 0489). The rule is the
// host's, in `subscription.start`; no block, pack or caller decides it.
//
// - **Only a proved holder gets a trial.** A signed-in customer starting their own subscription,
//   or staff starting one for a Person. A guest only typed an address: a trial on it would be the
//   address's Person's, so a guest could spend someone else's trial, and the page's answer (a
//   trial or not) would tell them whether that person had one. A guest pays from the start, and
//   the block says to sign in for the free trial.
// - **A trial is used when the provider confirms it**, not when a page is opened: the verified
//   event that makes (or moves) a subscription with a trial on it marks the holder's trial used,
//   in its own batch. A page given up gives the trial back once it can no longer be completed.
// - **Two starts at once give one trial.** A checkout opened with a trial holds the holder's trial
//   for that plan object while its page can be completed (`core_subscription_trial`); the
//   database refuses a second hold (migration 0531's trigger), so the second start's batch fails
//   and nothing of it is recorded. The same holder starting the same plan again while their page
//   is open gets that page back.
// - Per plan object (the spec's guess): a second course plan later gives no second trial.
import { ConflictError } from "../errors.ts";
import type { HandlerContext } from "../operation.ts";

/**
 * How long after its page expires a hold is kept: the provider's confirmation of a page completed
 * just before it expired arrives after it, normally within seconds.
 */
export const TRIAL_HOLD_AFTER_EXPIRY_MS = 15 * 60_000;

/** Why a plan's trial is not given: a guest (sign in for it), or the holder has had one. */
export type NoTrial = "sign_in" | "used";

export type TrialDecision =
  | { give: true }
  | { give: false; reason: NoTrial | null }
  /** The holder's own page for this plan, with its trial, is still open: give them that. */
  | { give: false; reason: null; open: { checkoutId: string; url: string; expiresAt: string } };

/** Whether `holderPersonId` has used their trial on any record of `planObject`. */
export async function trialUsed(
  ctx: Pick<HandlerContext, "db">,
  holderPersonId: string,
  planObject: string,
): Promise<boolean> {
  const held = await ctx.db
    .selectFrom("core_subscription_trial")
    .select("checkout_id")
    .where("holder_person_id", "=", holderPersonId)
    .where("plan_object", "=", planObject)
    .where("used_at", "is not", null)
    .executeTakeFirst();
  if (held) return true;
  // A subscription the provider confirmed with a trial counts whatever made it.
  const had = await ctx.db
    .selectFrom("core_subscription")
    .select("id")
    .where("holder_person_id", "=", holderPersonId)
    .where("plan_object", "=", planObject)
    .where("trial_end", "is not", null)
    .executeTakeFirst();
  return Boolean(had);
}

/**
 * Whether a start gets the plan's trial. `proved`: the caller is the signed-in holder or staff.
 * Throws a ConflictError while another of the holder's pages with a trial on this plan object is
 * open for another plan record, or could still be confirmed.
 */
export async function decideTrial(
  ctx: HandlerContext,
  start: { holderPersonId: string; planObject: string; planId: string; proved: boolean },
  trialDays: number | null,
): Promise<TrialDecision> {
  if (!trialDays || trialDays <= 0) return { give: false, reason: null };
  if (!start.proved) return { give: false, reason: "sign_in" };
  if (await trialUsed(ctx, start.holderPersonId, start.planObject)) {
    return { give: false, reason: "used" };
  }
  const live = await ctx.db
    .selectFrom("core_subscription_trial")
    .selectAll()
    .where("holder_person_id", "=", start.holderPersonId)
    .where("plan_object", "=", start.planObject)
    .where("used_at", "is", null)
    .where("held_until", ">", ctx.now)
    .orderBy("created_at", "desc")
    .executeTakeFirst();
  if (!live) return { give: true };
  const expiresAt = new Date(
    Date.parse(live.held_until) - TRIAL_HOLD_AFTER_EXPIRY_MS,
  ).toISOString();
  if (live.plan_id === start.planId && expiresAt > ctx.now) {
    return {
      give: false,
      reason: null,
      open: { checkoutId: live.checkout_id, url: live.url, expiresAt },
    };
  }
  throw new ConflictError(
    expiresAt > ctx.now
      ? "A checkout with this free trial is already open for another plan. Finish it there, or " +
          `start again after ${expiresAt.slice(11, 16)} UTC`
      : `A checkout with this free trial was being completed. Try again after ${live.held_until.slice(11, 16)} UTC`,
    { rule: "trial_held", heldUntil: live.held_until },
  );
}

/** The hold a checkout opened with a trial takes, for the start's batch. */
export function holdTrialStatement(
  ctx: HandlerContext,
  hold: {
    checkoutId: string;
    holderPersonId: string;
    planObject: string;
    planId: string;
    url: string;
    expiresAt: string | null;
  },
) {
  // A page with no expiry the gatekeeper reported is held for a day (Stripe's default lifetime).
  const expires = hold.expiresAt ?? new Date(Date.parse(ctx.now) + 24 * 3_600_000).toISOString();
  return ctx.db.insertInto("core_subscription_trial").values({
    checkout_id: hold.checkoutId,
    holder_person_id: hold.holderPersonId,
    plan_object: hold.planObject,
    plan_id: hold.planId,
    url: hold.url,
    held_until: new Date(Date.parse(expires) + TRIAL_HOLD_AFTER_EXPIRY_MS).toISOString(),
    created_at: ctx.now,
  });
}

/**
 * Marks the trial of the checkout `subscriptionId` was opened by used, for a verified event's
 * batch, when the provider's read says the subscription has a trial. Never fails the batch (an
 * update, not an insert). Returns whether the holder had used a trial on this plan object before
 * (a second trial the hold did not stop: staff are told).
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
  const mine = await ctx.db
    .selectFrom("core_subscription_trial")
    .select(["used_at"])
    .where("checkout_id", "=", row.id)
    .executeTakeFirst();
  if (mine?.used_at) return { second: false };
  const before = await ctx.db
    .selectFrom("core_subscription_trial")
    .select("checkout_id")
    .where("holder_person_id", "=", row.holder_person_id)
    .where("plan_object", "=", row.plan_object)
    .where("used_at", "is not", null)
    .where("checkout_id", "!=", row.id)
    .executeTakeFirst();
  const otherSubscription = await ctx.db
    .selectFrom("core_subscription")
    .select("id")
    .where("holder_person_id", "=", row.holder_person_id)
    .where("plan_object", "=", row.plan_object)
    .where("trial_end", "is not", null)
    .where("id", "!=", row.id)
    .executeTakeFirst();
  if (mine) {
    ctx.write(
      ctx.db
        .updateTable("core_subscription_trial")
        .set({ used_at: ctx.now })
        .where("checkout_id", "=", row.id)
        .where("used_at", "is", null),
    );
  }
  return { second: Boolean(before || otherSubscription) };
}
