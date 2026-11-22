// What a subscription grants (stage 32b, build step 6, ADR 0510): a plan's
// `sellable.recurring.grants`. Not the `recurring` behaviour (a timetable's weekly rule, ADR 0500):
// this is the plan's own recurring sale, and what its subscription gives while it runs.
//
// Called by the subscription events (events.ts) in the batch of every verified event that makes or
// moves a subscription, after the host's record has its new columns:
//
//   no grant yet, the subscription running    one record of the granted object for the holder,
//   (trialing, active, past due, unpaid or    created by the host in the state the declaration
//   paused) and a holder                      maps the subscription's to, with its fields set
//                                             once from the plan and the subscription, and a
//                                             core_subscription_grant row (one per subscription,
//                                             so two events at once cannot grant twice)
//   a grant                                    its state follows the subscription's, its `until`
//                                             is when the subscription stops giving: the moment
//                                             it ended, the end of its period when set to end
//                                             (or a `cancel_at`), 30 days of failing while past
//                                             due (32a's access rule, ADR 0488) - whichever is
//                                             first; a running one clears it
//
// Nothing else changes what was granted: a plan's terms are copied at the start (a plan change is
// the next build step's), the state field is the host's to move. No extension code runs.
import { getObject } from "../fields/index.ts";
import type { ObjectDefinition, RecurringGrantDefinition } from "../fields/types.ts";
import { notifyStatements } from "../notifications/send.ts";
import type { HandlerContext } from "../operation.ts";
import { createRecord, updateRecord } from "../operations/record.ts";
import { grantFieldValue, readGrantItem } from "../orders/grants.ts";
import { loadOrderRow } from "../orders/orders.ts";
import { viewColumnOf } from "../records/columns.ts";
import { type MoveHook, onRecordMove } from "../records/lifecycle.ts";
import { type AnyRow, orgReader, visibleSource } from "../visibility/index.ts";
import { loadSubscriptionRow, type SubscriptionRow } from "./events.ts";
import { PAST_DUE_GRACE_DAYS } from "./sweep.ts";

const GRANTING: ReadonlySet<string> = new Set([
  "trialing",
  "active",
  "past_due",
  "unpaid",
  "paused",
]);

type Mapped = keyof RecurringGrantDefinition["states"];

/** The granted record's state for the subscription's, or null when it grants nothing yet. */
function grantedState(grants: RecurringGrantDefinition, state: string): string | null {
  if (state === "expired") return grants.states.ended;
  return Object.hasOwn(grants.states, state) ? grants.states[state as Mapped] : null;
}

/**
 * When the subscription stops giving, or null while it runs with no end set: the earliest of the
 * moment it ended, its period's end when it is set to end there, a `cancel_at` date set at the
 * provider, and 30 days of failing while past due (ADR 0488's access rule, not a minute after).
 */
export function grantUntil(row: SubscriptionRow, now: string): string | null {
  const ends: string[] = [];
  if (row.state === "ended" || row.state === "expired") ends.push(row.ended_at ?? now);
  if (row.cancel_at_period_end === 1 && row.current_period_end) ends.push(row.current_period_end);
  if (row.cancel_at) ends.push(row.cancel_at);
  if (row.state === "past_due" && row.failing_since) {
    ends.push(
      new Date(Date.parse(row.failing_since) + PAST_DUE_GRACE_DAYS * 86_400_000).toISOString(),
    );
  }
  return ends.length ? ([...ends].sort()[0] as string) : null;
}

/** The plan object's grant declaration, or undefined when its subscriptions grant nothing. */
function grantsOf(planObject: string): {
  plan: ObjectDefinition;
  grants: RecurringGrantDefinition;
  granted: ObjectDefinition;
} | null {
  const plan = getObject(planObject);
  const grants = plan?.sellable?.recurring?.grants;
  const granted = grants ? getObject(grants.object) : undefined;
  if (!plan || !grants || !granted?.states) return null;
  return { plan, grants, granted };
}

async function tellStaff(ctx: HandlerContext, row: SubscriptionRow, title: string, body: string) {
  const plan = await notifyStatements(
    ctx.db,
    {
      to: [{ role: "admin" }],
      type: "system.message",
      title,
      body,
      link: { kind: "record", object: "subscription", id: row.id },
      dedupeKey: `subscription.grant:${row.id}:${title}`,
      source: { actor: "system" },
    },
    ctx.now,
  );
  ctx.write(...plan.statements);
}

/**
 * Keeps what `row`'s subscription grants in step with it, as the host, in the calling batch.
 * `row` is the subscription as this event leaves it.
 */
export async function followSubscriptionGrant(
  ctx: HandlerContext,
  row: SubscriptionRow,
): Promise<void> {
  const declared = grantsOf(row.plan_object);
  if (!declared) return;
  const { plan, grants, granted } = declared;
  const states = granted.states;
  if (!states) return;
  const existing = await ctx.db
    .selectFrom("core_subscription_grant")
    .select(["object_type", "record_id"])
    .where("subscription_id", "=", row.id)
    .executeTakeFirst();
  const state = grantedState(grants, row.state);
  const until = grantUntil(row, ctx.now);

  if (!existing) {
    // Granted when the provider first reports it running; a subscription that never ran (or ended
    // before any event of ours saw it run) grants nothing.
    if (!GRANTING.has(row.state) || !state) return;
    if (!row.holder_person_id) {
      await tellStaff(
        ctx,
        row,
        "A subscription has no one to hold what it gives",
        `Subscription ${row.id} (${row.plan_title}) is running, and its holder is not known, so ` +
          "nothing was granted. Set its person, then it is granted with the next event.",
      );
      return;
    }
    const sources = Object.values(grants.set);
    const planRow = sources.some((s) => s.startsWith("item."))
      ? await readGrantItem(ctx, plan, row.plan_id)
      : undefined;
    const from = (source: string): unknown => {
      if (source === "item") return row.plan_id;
      if (source.startsWith("item.")) return grantFieldValue(plan, planRow, source.slice(5));
      if (source === "subscription") return row.id;
      if (source === "subscription.holder") return row.holder_person_id;
      if (source === "subscription.payer") return row.payer_person_id;
      return null;
    };
    const values: Record<string, unknown> = {
      ...Object.fromEntries(Object.entries(grants.set).map(([field, s]) => [field, from(s)])),
      [states.field]: state,
    };
    if (grants.from) values[grants.from] = row.current_period_start ?? ctx.now;
    if (grants.until && until) values[grants.until] = until;
    // As the host: the values are the host's own (the plan's and the subscription's), and its
    // read-only fields are the host's to write.
    const id = await createRecord(ctx, granted, values, { by: "host", checkReferences: false });
    ctx.write(
      ctx.db.insertInto("core_subscription_grant").values({
        subscription_id: row.id,
        object_type: granted.name,
        record_id: id,
        created_at: ctx.now,
      }),
    );
    return;
  }

  const object = getObject(existing.object_type);
  const stateField = object?.states
    ? object.fields.find((f) => f.name === object.states?.field)
    : undefined;
  const stateColumn = stateField ? viewColumnOf(stateField) : null;
  if (!object?.states || !stateColumn) return;
  const untilField = grants.until ? object.fields.find((f) => f.name === grants.until) : undefined;
  const untilColumn = untilField ? viewColumnOf(untilField) : null;
  // The record as it is now; one in the Trash is left alone.
  // biome-ignore lint/suspicious/noExplicitAny: the source is a registry-driven view, not a key of the typed schema.
  const current = (await (ctx.db as any)
    .selectFrom(visibleSource(orgReader(ctx.db), object))
    .selectAll()
    .where("id", "=", existing.record_id)
    .executeTakeFirst()) as AnyRow | undefined;
  if (!current) return;
  const finals = new Set(object.states.moves.filter((m) => m.final).map((m) => m.to));
  const now = current[stateColumn];
  if (typeof now === "string" && finals.has(now)) return;
  const change: Record<string, unknown> = {};
  if (state && now !== state) change[object.states.field] = state;
  if (grants.until && untilColumn) {
    const stored = current[untilColumn];
    // Compared as moments: the stored text and the read's may differ in their milliseconds.
    const storedAt = typeof stored === "string" && stored ? Date.parse(stored) : null;
    const untilAt = until ? Date.parse(until) : null;
    if (storedAt !== untilAt) change[grants.until] = until;
  }
  if (!Object.keys(change).length) return;
  await updateRecord(ctx, object, existing.record_id, change, { by: "host" });
}

/**
 * A paid period of a subscription that grants something refunded in full (stage 32b review): the
 * refund does not end the subscription (ADR 0486), so what it granted keeps running. Staff are
 * told, in the refund's batch, so ending the subscription is a decision someone makes.
 */
const periodRefunded: MoveHook = async (ctx, move) => {
  if (move.to.id !== "refunded") return;
  const order = await loadOrderRow(ctx.db, move.id);
  if (!order.subscription_id) return;
  const sub = await loadSubscriptionRow(ctx.db, order.subscription_id).catch(() => null);
  if (!sub || !grantsOf(sub.plan_object) || sub.state === "ended" || sub.state === "expired") {
    return;
  }
  await tellStaff(
    ctx,
    sub,
    "A refunded period's membership keeps running",
    `Order ${move.id}, a paid period of subscription ${sub.id} (${sub.plan_title}), was refunded ` +
      "in full. The subscription, and what it grants, keep running: end the subscription if they " +
      "should not.",
  );
};

onRecordMove("order", periodRefunded);
