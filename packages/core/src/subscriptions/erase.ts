// What erase does to a subscription (issue #293, ADR 0649): the rule of a member's own deletion
// (stage 48, decision 1) for every subscription an erased Person is on. One that still runs is
// asked at the provider to end when the period already paid for ends: nothing is refunded and
// nothing more is charged, and what it gives lasts until then. One whose paid period is already
// over (paused, unpaid, or waiting for its first payment) is ended at once, which charges and
// refunds nothing either. It applies whoever started the erase, whichever of payer and holder the
// erased Person is, and to one resumed since a deletion set it to end. A checkout the provider
// confirms after the erase (events.ts) is asked to end the same way.
//
// The provider runs the schedule: the host asks, and the record moves when the provider's verified
// event says so (events.ts). Erase asks before its batch commits, as subscription.cancel does; one
// that could not be asked, and one another live Person is on, is told to the admins in the batch,
// naming nobody.
import type { SqlBool } from "kysely";
import { sql } from "kysely";
import type { SubscriptionState } from "../fields/subscription.ts";
import { notifyStatements } from "../notifications/send.ts";
import type { HandlerContext } from "../operation.ts";
import { callSubscriptionGatekeeper, paymentsTarget } from "../orders/gateway.ts";
import { jsonList } from "../records/common.ts";

/** Still charging: ended when the period paid for ends. */
const AT_PERIOD_END: ReadonlySet<SubscriptionState> = new Set(["trialing", "active", "past_due"]);
/** Its paid period already over: ended at once (nothing charged or refunded either way). */
const AT_ONCE: ReadonlySet<SubscriptionState> = new Set(["incomplete", "unpaid", "paused"]);

/** The reason sent to the provider: it names nobody. */
const REASON = "Ended because a person on it was erased";

export type EraseEnd = "period_end" | "now";

/**
 * How a subscription in `state` is ended for an erase, or null when nothing is to be asked: it has
 * ended, or it is already set to end at or before its period's end.
 */
export function eraseEndFor(sub: {
  state: SubscriptionState;
  cancelAtPeriodEnd: boolean;
  cancelAt: string | null;
  currentPeriodEnd: string | null;
}): EraseEnd | null {
  if (AT_ONCE.has(sub.state)) return "now";
  if (!AT_PERIOD_END.has(sub.state) || sub.cancelAtPeriodEnd) return null;
  // A date set at the provider (its dashboard) on or before the period's end already stops it in
  // time; a later one would charge another period, so the period's end is asked for.
  if (sub.cancelAt && (!sub.currentPeriodEnd || sub.cancelAt <= sub.currentPeriodEnd)) return null;
  return "period_end";
}

/**
 * Asks the provider to end one subscription (`id` is the host's, `ref` the provider's). True when
 * the host's call was applied or is waiting for approval; false when it could not be made (no
 * payments connection, another provider, the gatekeeper refused or did not answer).
 */
export async function askEraseEnd(
  ctx: HandlerContext,
  sub: { id: string; provider: string; ref: string },
  when: EraseEnd,
): Promise<boolean> {
  try {
    const target = await paymentsTarget(ctx.db);
    if (target.provider !== sub.provider) return false;
    const result = await callSubscriptionGatekeeper(
      ctx.integrations,
      target,
      "cancelSubscription",
      {
        subscriptionId: sub.id,
        subscriptionRef: sub.ref,
        when,
        reason: REASON,
      },
    );
    return result.applied.length > 0 || result.pending.length > 0;
  } catch {
    return false;
  }
}

export interface EraseSubscriptions {
  /** Asked to end when the period paid for ends. */
  atPeriodEnd: number;
  /** Asked to end at once (paused, unpaid, or waiting for a first payment). */
  now: number;
  /** Could not be asked: the admins are told to end them with the provider. */
  leftForStaff: number;
}

/**
 * Ends every subscription one of `ids` (the erased Person and everyone merged into them) is payer
 * or holder of, before erase's batch: the Person's delete clears both references (ON DELETE SET
 * NULL), so they are found now. Writes the admins' notices into the batch. A simulated erase asks
 * nothing and reports what it would ask.
 */
export async function endErasedSubscriptions(
  ctx: HandlerContext,
  ids: readonly string[],
): Promise<EraseSubscriptions> {
  const people = jsonList(ids);
  const rows = await ctx.db
    .selectFrom("core_subscription")
    .select([
      "id",
      "provider",
      "provider_ref",
      "state",
      "cancel_at_period_end",
      "cancel_at",
      "current_period_end",
      "payer_person_id",
      "holder_person_id",
    ])
    .where(sql<SqlBool>`(payer_person_id IN ${people} OR holder_person_id IN ${people})`)
    .where("state", "not in", ["ended", "expired"])
    .orderBy("id")
    .execute();
  const out: EraseSubscriptions = { atPeriodEnd: 0, now: 0, leftForStaff: 0 };
  const left: string[] = [];
  const shared: string[] = [];
  for (const row of rows) {
    const when = eraseEndFor({
      state: row.state,
      cancelAtPeriodEnd: row.cancel_at_period_end === 1,
      cancelAt: row.cancel_at,
      currentPeriodEnd: row.current_period_end,
    });
    // Another live Person on it (a guardian paying for a child, or the child a payer pays for):
    // staff tell them, whether or not it still had to be asked.
    const other = [row.payer_person_id, row.holder_person_id].some((p) => p && !ids.includes(p));
    if (other) shared.push(row.id);
    if (!when) continue;
    const asked = ctx.simulation
      ? true
      : await askEraseEnd(ctx, { id: row.id, provider: row.provider, ref: row.provider_ref }, when);
    if (!asked) {
      out.leftForStaff += 1;
      left.push(row.id);
    } else if (when === "now") out.now += 1;
    else out.atPeriodEnd += 1;
  }
  if (left.length) {
    await tellAdmins(
      ctx,
      left,
      "A subscription of an erased person could not be ended",
      "A person on these subscriptions was erased. The payment provider could not be asked to " +
        "end them, so they may keep charging: cancel each at its period's end (subscription.cancel, " +
        "or with the provider). Nothing is refunded.",
      "subscription.erase_left",
    );
  }
  if (shared.length) {
    await tellAdmins(
      ctx,
      shared,
      "A subscription someone else is on ends because a person on it was erased",
      "A person on these subscriptions was erased, and another person (who pays, or holds what " +
        "it gives) is still on each. Each ends when the period already paid for ends; nothing is " +
        "refunded and nothing more is charged. Tell the other person: a new subscription keeps it " +
        "going for them.",
      "subscription.erase_shared",
    );
  }
  return out;
}

async function tellAdmins(
  ctx: HandlerContext,
  subscriptionIds: string[],
  title: string,
  body: string,
  key: string,
): Promise<void> {
  const plan = await notifyStatements(
    ctx.db,
    {
      to: [{ role: "admin" }],
      type: "system.message",
      title,
      body: `${body}\n\nSubscriptions: ${subscriptionIds.slice(0, 20).join(", ")}${
        subscriptionIds.length > 20 ? ` and ${subscriptionIds.length - 20} more` : ""
      }`,
      link: { kind: "record", object: "subscription", id: subscriptionIds[0] as string },
      dedupeKey: `${key}:${subscriptionIds[0]}:${ctx.now}`,
      source: { actor: "system" },
    },
    ctx.now,
  );
  ctx.write(...plan.statements);
}
