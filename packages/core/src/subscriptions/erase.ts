// What erase does to a subscription (issue #293, ADR 0533): the rule of a member's own deletion
// (stage 48, decision 1) for every subscription an erased Person is on. One whose current period
// is paid is asked at the provider to end when that period ends: nothing is refunded and nothing
// more is charged, and what it gives lasts until then. One with nothing of its period paid
// (past due, unpaid, paused, or waiting for its first payment) is ended at once, so the provider
// stops retrying the card; that refunds nothing either. It applies whoever started the erase,
// whichever of payer and holder the erased Person is, and to one resumed since a deletion set it
// to end. A checkout confirmed after the erase is asked to end the same way (events.ts), and one
// whose payer or holder no longer exists makes nothing.
//
// The provider runs the schedule: the host asks, and the record moves when the provider's verified
// event says so (events.ts). Erase asks before its batch commits, as subscription.cancel does, and
// once more after the commit for any of the Person's checkouts the provider confirmed meanwhile
// (the commit clears who is on it, so nothing else would find it). One that could not be asked,
// and one another live Person is on, is told to the admins, naming nobody. A subscription with
// nobody left on one side is never resumed (subscriptions.ts).
import type { CoreDatabase } from "@composable-os/db";
import type { Kysely, SqlBool } from "kysely";
import { sql } from "kysely";
import { ConflictError } from "../errors.ts";
import type { SubscriptionState } from "../fields/subscription.ts";
import { notifyStatements } from "../notifications/send.ts";
import type { HandlerContext } from "../operation.ts";
import { callSubscriptionGatekeeper, paymentsTarget } from "../orders/gateway.ts";
import { jsonList } from "../records/common.ts";

/** Its current period paid: ended when that period ends. */
const AT_PERIOD_END: ReadonlySet<SubscriptionState> = new Set(["trialing", "active"]);
/**
 * Nothing of its current period paid: ended at once, so nothing more is charged (a past due one
 * left to its period's end would still be retried by the provider until then).
 */
const AT_ONCE: ReadonlySet<SubscriptionState> = new Set([
  "incomplete",
  "past_due",
  "unpaid",
  "paused",
]);

/** The reason sent to the provider: it names nobody. */
const REASON = "Ended because a person on it was erased";

export type EraseEnd = "period_end" | "now";

/**
 * How a subscription in `state` is ended for an erase, or null when nothing is to be asked: it has
 * ended, or its paid period is running and it is already set to end at or before that period's end.
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
 * Asks the provider to end one subscription (`id` is the host's, `ref` the provider's). True only
 * when the host's call was applied. False when it could not be made (no payments connection,
 * another provider, the gatekeeper refused or did not answer) or waits for an approval that may be
 * refused: staff then see to it.
 */
export async function askEraseEnd(
  ctx: Pick<HandlerContext, "db" | "integrations">,
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
    return result.applied.length > 0;
  } catch {
    return false;
  }
}

export interface EraseSubscriptions {
  /** Asked to end when the period paid for ends. */
  atPeriodEnd: number;
  /** Asked to end at once (nothing of its period paid). */
  now: number;
  /** Could not be asked: the admins are told to end them with the provider. */
  leftForStaff: number;
}

const READ = [
  "id",
  "provider",
  "provider_ref",
  "state",
  "cancel_at_period_end",
  "cancel_at",
  "current_period_end",
  "payer_person_id",
  "holder_person_id",
] as const;

type SubscriptionRead = {
  id: string;
  provider: string;
  provider_ref: string;
  state: SubscriptionState;
  cancel_at_period_end: number;
  cancel_at: string | null;
  current_period_end: string | null;
  payer_person_id: string | null;
  holder_person_id: string | null;
};

/** What one pass of asking came to: counts, and which ids each notice names. */
interface Asked {
  out: EraseSubscriptions;
  left: string[];
  shared: string[];
}

async function askEach(
  ctx: HandlerContext,
  rows: readonly SubscriptionRead[],
  ids: readonly string[],
  simulate: boolean,
): Promise<Asked> {
  const asked: Asked = { out: { atPeriodEnd: 0, now: 0, leftForStaff: 0 }, left: [], shared: [] };
  for (const row of rows) {
    const when = eraseEndFor({
      state: row.state,
      cancelAtPeriodEnd: row.cancel_at_period_end === 1,
      cancelAt: row.cancel_at,
      currentPeriodEnd: row.current_period_end,
    });
    // Another live Person on it (a guardian paying for a child, or the child a payer pays for).
    const other = [row.payer_person_id, row.holder_person_id].some((p) => p && !ids.includes(p));
    if (!when) {
      // Already ending in time: only the other Person needs telling.
      if (other) asked.shared.push(row.id);
      continue;
    }
    const ok =
      simulate ||
      (await askEraseEnd(ctx, { id: row.id, provider: row.provider, ref: row.provider_ref }, when));
    if (!ok) {
      // Told once, in the notice that says it may keep charging.
      asked.out.leftForStaff += 1;
      asked.left.push(row.id);
      continue;
    }
    if (when === "now") asked.out.now += 1;
    else asked.out.atPeriodEnd += 1;
    if (other) asked.shared.push(row.id);
  }
  return asked;
}

/**
 * Ends every subscription one of `ids` (the erased Person and everyone merged into them) is payer
 * or holder of, before erase's batch: the Person's delete clears both references (ON DELETE SET
 * NULL), so they are found now. Writes the admins' notices into the batch. A simulated erase asks
 * nothing and reports what it would ask.
 *
 * Returns the counts and `afterCommit`, which the erase runs once its batch has committed: a
 * checkout of theirs the provider confirmed while the erase was asking became a subscription this
 * read did not see, and is asked (and told) the same way then.
 */
export async function endErasedSubscriptions(
  ctx: HandlerContext,
  ids: readonly string[],
): Promise<{ counts: EraseSubscriptions; afterCommit: () => Promise<void> }> {
  const people = jsonList(ids);
  const onIt = sql<SqlBool>`(payer_person_id IN ${people} OR holder_person_id IN ${people})`;
  const rows = await ctx.db
    .selectFrom("core_subscription")
    .select(READ)
    .where(onIt)
    .where("state", "not in", ["ended", "expired"])
    .orderBy("id")
    .execute();
  // Their checkouts not yet confirmed: a subscription takes its checkout's id.
  const pending = (
    await ctx.db
      .selectFrom("core_subscription_checkout")
      .select("id")
      .where(onIt)
      .where("subscription_ref", "is", null)
      .execute()
  ).map((c) => c.id);
  const simulate = Boolean(ctx.simulation);
  const asked = await askEach(ctx, rows, ids, simulate);
  ctx.write(...(await noticeStatements(ctx.db, ctx.now, asked)));
  return {
    counts: asked.out,
    async afterCommit() {
      if (simulate || !pending.length) return;
      const late = await ctx.db
        .selectFrom("core_subscription")
        .select(READ)
        .where("id", "in", jsonList(pending))
        .where("state", "not in", ["ended", "expired"])
        .orderBy("id")
        .execute();
      if (!late.length) return;
      // Made from their checkout, so theirs: asked as any of theirs. Who was on it is gone now
      // (or is another live Person, whom the read still shows).
      const again = await askEach(ctx, late, ids, false);
      const at = new Date().toISOString();
      for (const statement of await noticeStatements(ctx.db, at, again)) {
        await ctx.db.executeQuery(statement.compile());
      }
    },
  };
}

async function noticeStatements(db: Kysely<CoreDatabase>, now: string, asked: Asked) {
  const statements = [];
  if (asked.left.length) {
    statements.push(
      ...(await notice(
        db,
        now,
        asked.left,
        "A subscription of an erased person could not be ended",
        "A person on these subscriptions was erased. The payment provider could not be asked to " +
          "end them, or the request waits for an approval, so they may keep charging: end each " +
          "(subscription.cancel, or with the provider), at its period's end when that period is " +
          "paid and at once otherwise. Nothing is refunded.",
        "subscription.erase_left",
      )),
    );
  }
  if (asked.shared.length) {
    statements.push(
      ...(await notice(
        db,
        now,
        asked.shared,
        "A subscription someone else is on ends because a person on it was erased",
        "A person on these subscriptions was erased, and another person (who pays, or holds what " +
          "it gives) is still on each. Each ends when its paid period ends, or at once when " +
          "nothing of its period is paid; nothing is refunded and nothing more is charged. Tell " +
          "the other person: a new subscription keeps it going for them.",
        "subscription.erase_shared",
      )),
    );
  }
  return statements;
}

async function notice(
  db: Kysely<CoreDatabase>,
  now: string,
  subscriptionIds: string[],
  title: string,
  body: string,
  key: string,
) {
  const plan = await notifyStatements(
    db,
    {
      to: [{ role: "admin" }],
      type: "system.message",
      title,
      body: `${body}\n\nSubscriptions: ${subscriptionIds.slice(0, 20).join(", ")}${
        subscriptionIds.length > 20 ? ` and ${subscriptionIds.length - 20} more` : ""
      }`,
      link: { kind: "record", object: "subscription", id: subscriptionIds[0] as string },
      dedupeKey: `${key}:${subscriptionIds[0]}:${now}`,
      source: { actor: "system" },
    },
    now,
  );
  return plan.statements;
}

/**
 * Refuses to start a subscription charging again (resume, unpause) once a Person on it is gone:
 * every subscription is made with both a payer and a holder, so an empty one was erased (or
 * purged). Starting it again would charge an erased payer's card, or a live payer for nobody.
 */
export function refuseWithoutBoth(row: {
  id: string;
  payer_person_id: string | null;
  holder_person_id: string | null;
}): void {
  if (row.payer_person_id && row.holder_person_id) return;
  throw new ConflictError(
    "A person on this subscription was erased, so it is not started again: start a new one " +
      "for whoever is still on it",
    { subscription: row.id, rule: "person_erased" },
  );
}
