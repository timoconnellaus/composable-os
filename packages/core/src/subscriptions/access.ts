// The `subscription` access source (stage 32a, build step 3, ADR 0488): a customer holds access
// to a record while they hold a running subscription to a plan that covers it. Registered with
// `registerAccessSource`, so the seam's one question (`holdsAccess`), the `holders` flag and
// `media.play` read it with no change (ADR 0477).
//
// Declared on the object it gives access to:
//   access: { sources: [{ kind: "subscription", options: { plans: "courses.plan", covers: "all" } }] }
//
// - `plans`: the plan object, one of the same extension that declares `sellable.recurring`. Every
//   record of it gives the access (a second course plan later covers the same).
// - `covers: "all"`: every live record of the object, including ones added later. The only cover
//   in 32a; a list of records is left for later.
//
// Access follows the subscription's HOLDER (ADR 0487), never its payer. It is read from the host's
// own record, which only the provider's verified events move:
// - on trial, active, or past due (the provider is retrying a failed renewal: decision 4, the
//   member keeps everything while it retries);
// - set to end at its period's end (or on a date set at the provider): until that moment and not
//   a minute after, even before the provider's event saying it ended arrives;
// - nothing while it is incomplete, unpaid or paused, and nothing once it has ended or expired.
import { type RawBuilder, sql } from "kysely";
import { getObject } from "../fields/index.ts";
import type { AccessSource, ObjectDefinition } from "../fields/types.ts";
import { type AccessQuery, registerAccessSource } from "../visibility/access.ts";

export const SUBSCRIPTION_ACCESS_KIND = "subscription";

/** The states in which a subscription gives what it covers (decision 4). */
export const GIVING_STATES = ["trialing", "active", "past_due"] as const;

const optionsOf = (source: AccessSource): Record<string, unknown> =>
  ("options" in source ? (source.options ?? {}) : {}) as Record<string, unknown>;

function problems(object: ObjectDefinition, source: AccessSource): string[] {
  const options = optionsOf(source);
  const out: string[] = [];
  for (const key of Object.keys(options)) {
    if (key !== "plans" && key !== "covers")
      out.push(`a subscription source has no option "${key}"`);
  }
  if (options.covers !== "all") out.push('covers must be "all" (every live record)');
  const plans = options.plans;
  if (typeof plans !== "string" || !plans) {
    out.push("plans must name the plan object");
    return out;
  }
  const plan = getObject(plans);
  if (
    !plan ||
    !object.extension ||
    plan.extension !== object.extension ||
    plan.name === object.name
  ) {
    out.push(`plans "${plans}" must be another object of the same extension`);
  } else if (!plan.sellable?.recurring) {
    out.push(`plans "${plans}" must be a plan: an object whose sellable declares recurring`);
  }
  return out;
}

/** Whether `personId` holds a subscription to `planObject` that gives access at `now`. */
export function givingSubscriptionSql(
  personId: string,
  planObject: string,
  now: string,
): RawBuilder<{ id: string }> {
  return sql<{ id: string }>`SELECT id FROM core_subscription
    WHERE holder_person_id = ${personId}
      AND plan_object = ${planObject}
      AND state IN (${sql.join(GIVING_STATES.map((s) => sql`${s}`))})
      AND NOT (cancel_at_period_end = 1 AND current_period_end IS NOT NULL AND current_period_end <= ${now})
      AND NOT (cancel_at IS NOT NULL AND cancel_at <= ${now})
    LIMIT 1`;
}

async function holders(query: AccessQuery, source: AccessSource): Promise<ReadonlySet<string>> {
  if (problems(query.object, source).length) return new Set();
  const plans = String(optionsOf(source).plans);
  const rows = await givingSubscriptionSql(query.personId, plans, query.now).execute(query.db);
  // covers "all": every record asked about (the seam asks only about live records of the object).
  return rows.rows.length ? new Set(query.ids) : new Set();
}

registerAccessSource(SUBSCRIPTION_ACCESS_KIND, { holders, problems });
