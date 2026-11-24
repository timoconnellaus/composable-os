// What the host notices about subscriptions with no event (stage 32a review, ADR 0488), on the
// minute cron's orders step. Both reads are bounded to a one-day window after the moment they
// look for, so a subscription is looked at on one day only, and each notice is sent once (its
// dedupe key).
//
// - **Past due too long.** A subscription past due gives access only until `failing_since` plus
//   PAST_DUE_GRACE_DAYS (access.ts). The provider's default retries end within about two weeks;
//   this bites only when the company's provider setting leaves a subscription past due forever.
//   Staff are told once when it lapses.
// - **Events not arriving.** An active or trialing subscription whose period ended more than
//   MISSING_EVENTS_AFTER_DAYS ago with no event keeps its access (a webhook outage must not lock
//   out paying members), and staff are told once per subscription that the provider's events are
//   not arriving.
import type { CrmDb } from "@composable-os/db";
import { type Compilable, sql } from "kysely";
import { notifyStatements } from "../notifications/send.ts";
import { sweepOffers } from "./offers.ts";

export const PAST_DUE_GRACE_DAYS = 30;
export const MISSING_EVENTS_AFTER_DAYS = 3;
const DAY = 86_400_000;
const LIMIT = 50;

const ago = (now: string, days: number) => new Date(Date.parse(now) - days * DAY).toISOString();

/** The most pages of LIMIT subscriptions one sweep tells staff about events not arriving. */
export const SILENT_PAGES = 20;

/**
 * `unindexed: false` leaves out the two reads no index holds (events not arriving, offers whose
 * plan has gone): the minute cron runs them once an hour and the past due read every minute
 * (docs/cloudflare-costs.md).
 */
export async function sweepSubscriptions(
  crm: CrmDb,
  now: string,
  { unindexed = true }: { unindexed?: boolean } = {},
): Promise<{ pastDueLapsed: number; eventsMissing: number; offerPlansGone: number }> {
  const db = crm.query;
  const lapsed = await db
    .selectFrom("core_subscription")
    .select(["id", "plan_title", "failing_since"])
    .where("state", "=", "past_due")
    // core_subscription_failing_idx's own predicate, written out: without it, a scan of every row.
    .where(sql<boolean>`state IN ('past_due', 'unpaid')`)
    .where("failing_since", "<=", ago(now, PAST_DUE_GRACE_DAYS))
    .where("failing_since", ">", ago(now, PAST_DUE_GRACE_DAYS + 1))
    .limit(LIMIT)
    .execute();
  // The whole window, a page at a time in its order: run hourly, a read of its first LIMIT
  // alone would return the same rows each hour and never reach the rest. A repeat notice is
  // ignored (its dedupe key).
  const silent: {
    id: string;
    plan_title: string;
    current_period_end: string | null;
    provider: string;
  }[] = [];
  for (let page = 0; unindexed && page < SILENT_PAGES; page++) {
    const last = silent.at(-1);
    let read = db
      .selectFrom("core_subscription")
      .select(["id", "plan_title", "current_period_end", "provider"])
      .where("state", "in", ["active", "trialing"])
      .where("current_period_end", "<=", ago(now, MISSING_EVENTS_AFTER_DAYS))
      .where("current_period_end", ">", ago(now, MISSING_EVENTS_AFTER_DAYS + 1));
    if (last) {
      const end = last.current_period_end ?? "";
      read = read.where((eb) =>
        eb.or([
          eb("current_period_end", ">", end),
          eb.and([eb("current_period_end", "=", end), eb("id", ">", last.id)]),
        ]),
      );
    }
    const rows = await read.orderBy("current_period_end").orderBy("id").limit(LIMIT).execute();
    silent.push(...rows);
    if (rows.length < LIMIT) break;
  }
  const statements: Compilable[] = [];
  const tell = async (id: string, kind: string, title: string, body: string) => {
    const plan = await notifyStatements(
      db,
      {
        to: [{ role: "admin" }],
        type: "system.message",
        title,
        body,
        link: { kind: "record", object: "subscription", id },
        dedupeKey: `subscription.${kind}:${id}`,
        source: { actor: "system" },
      },
      now,
    );
    statements.push(...plan.statements);
  };
  for (const row of lapsed) {
    await tell(
      row.id,
      "past_due_lapsed",
      "A past due subscription no longer gives access",
      `Subscription ${row.id} (${row.plan_title}) has been past due since ` +
        `${row.failing_since?.slice(0, 10)}, more than ${PAST_DUE_GRACE_DAYS} days, so it no ` +
        "longer gives access. The provider is still not ending it: check its setting for " +
        "exhausted retries, and end or settle it in the provider's dashboard.",
    );
  }
  for (const row of silent) {
    await tell(
      row.id,
      "events_missing",
      "The payment provider's events are not arriving",
      `Subscription ${row.id} (${row.plan_title}) is still shown as running, but its period ` +
        `ended on ${row.current_period_end?.slice(0, 10)} and nothing has arrived from ` +
        `${row.provider} since. Its member keeps access. Check the provider's webhook ` +
        "endpoint and its failed deliveries.",
    );
  }
  if (statements.length) await crm.batch(statements);
  // Continuation offers with no plan left to take them on (ADR 0491).
  const offers = unindexed ? await sweepOffers(crm, now) : { plansGone: 0 };
  return {
    pastDueLapsed: lapsed.length,
    eventsMissing: silent.length,
    offerPlansGone: offers.plansGone,
  };
}
