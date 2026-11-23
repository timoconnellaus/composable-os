// Cooling off (stage 44 step 7, decision 11, ADR 0647). A business may set a cooling-off period:
// whole days, 0 off (the default). A new member may end their membership within it for a full
// refund of what they paid; each refund is owed (core_sellable_refund_due) and asked of the
// payments gatekeeper by the minute cron, where it waits for a person with `orders:refund` like
// every refund (ADR 0429). Nothing here charges or refunds a card on its own (ADR 0485).
//
// Who it covers (decisions 16 and 17, and the coordinator's readings where the spec is silent):
//   - a subscription to a plan whose pack declares `sellable.recurring.coolingOff` (Memberships'
//     plans; never a pass, never a course plan), started here by `subscription.start` without a
//     continuation offer (a new member, not one moving over);
//   - within the window: from the host's processing of the provider's first event for it (its
//     record's `created_at`) to the end of the last local day in the business's time zone, the
//     start's day being day 0. A clock change moves nothing: the end is a local midnight. A plan
//     change, a pause or an agreement accepted again never moves it;
//   - the days are those in force when it was started, kept on its checkout, for good: a setting
//     changed later (shorter or longer) applies only to subscriptions started after it;
//   - once per holder (held by the database, migration 0856);
//   - something paid: in a free trial nothing is owed back, and the ordinary cancel ends it.
//
// What it does: ends the subscription at the provider now, asked after the operation's batch
// commits the cooling off's row. A member asks again only while the window is open; after it, only
// staff with `subscriptions:manage` finish one the member asked for in time. A lost or never-made
// call is resolved by the minute cron's sweep (`sweepCoolOffs`). Only an end within
// `END_AFTER_ASK_MS` of the last ask is this cooling off's (`followCoolOff`): then what was paid up
// to the window's end, and between that ask and the end, is owed back in full, and the bookings
// ahead the membership paid for are released (the spender's `released` state). Any other end
// (an ordinary cancel, failed payments, months later) owes nothing as cooled off: the cooling off
// is `lapsed` and admins are told.
import type { CoreSubscriptionCoolOffTable, CrmDb } from "@composable-os/db";
import { type Kysely, type Selectable, sql } from "kysely";
import type { EventSink } from "../automations/types.ts";
import { ConflictError, NotFoundError, ValidationError } from "../errors.ts";
import { getObject } from "../fields/index.ts";
import type { GateFloor } from "../gate.ts";
import { newId } from "../ids.ts";
import type { IntegrationRuntime } from "../integrations/runtime.ts";
import { invokeByName } from "../invoke.ts";
import { notifyStatements } from "../notifications/send.ts";
import { type AfterCommit, afterCommit, type HandlerContext } from "../operation.ts";
import { updateRecordAsHost } from "../operations/record.ts";
import { callSubscriptionGatekeeper, paymentsTarget } from "../orders/gateway.ts";
import { formatMoney } from "../orders/orders.ts";
import { viewColumnOf } from "../records/columns.ts";
import { extensionSettingValues } from "../records/windows.ts";
import { loadGeneralSettings } from "../settings.ts";
import { addLocalDays, localParts, wallClockToIso } from "../time/local.ts";
import { SYSTEM_USER } from "../users.ts";
import { orgReader, visibleSource } from "../visibility/index.ts";
import { subscriptionCallOutcome } from "./changes.ts";
import { loadSubscriptionRow, type SubscriptionRow } from "./events.ts";

export type CoolOffRow = Selectable<CoreSubscriptionCoolOffTable>;

/** The longest cooling-off period the host keeps (the SDK's MAX_COOLING_OFF_DAYS). */
export const MAX_COOLING_OFF_DAYS = 90;
/** An end is this cooling off's when the provider ended it within this long of the last ask. */
export const END_AFTER_ASK_MS = 2 * 86_400_000;
/** A provider's end a little before the host's ask (clocks differ) still counts. */
const END_BEFORE_ASK_MS = 5 * 60_000;
/** The sweep looks at an ask whose answer was lost or never made after this long. */
export const COOL_OFF_SWEEP_AFTER_MS = 5 * 60_000;
/** How many asks one sweep looks at. */
export const COOL_OFF_SWEEP_BATCH = 10;
/** The most bookings ahead one cooling off releases in its batch; staff are told of the rest. */
export const COOL_OFF_RELEASE_MAX = 60;

/** Why cooling off is not offered for a subscription. */
export const NOT_OFFERED = [
  "not_covered",
  "off",
  "continuation",
  "ended",
  "window_passed",
  "used",
  "nothing_paid",
] as const;
export type NotOffered = (typeof NOT_OFFERED)[number];

/** What came of the cooling off's own refunds, once it has ended. */
export type RefundState = "waiting" | "refunded" | "held";

export interface CoolingOffStatus {
  subscriptionId: string;
  /** The member's button shows: they may cool off now. */
  offered: boolean;
  /** Why not, when not offered and no cooling off was asked. */
  why: NotOffered | null;
  /** The days that apply (those in force when it was started); 0 when none. */
  days: number;
  /** The last local day of the window (`YYYY-MM-DD`, the business's zone), or null. */
  until: string | null;
  /** The moment the window closes (the local midnight after `until`), or null. */
  endsAt: string | null;
  /** What it would owe back, in minor units: exactly what a cooling off asked now owes. */
  refund: number;
  currency: string;
  /** A cooling off asked for, and how far it has got. */
  coolOff: {
    state: "asked" | "refused" | "ended" | "lapsed";
    asked: "sent" | "pending" | "unknown" | null;
    askedBy: "payer" | "staff";
    askedAt: string;
    endedAt: string | null;
    /** The caller may ask the provider again now (the member only while the window is open). */
    askAgain: boolean;
    /** Under way: the ordinary cancel waits (asked, or refused while the window is open). */
    open: boolean;
    /** Admins were told it is stuck (refused, or no answer): only then is the member told so. */
    staffTold: boolean;
    /** What it owes back (or owed, once ended), what has been refunded of that, and where it is. */
    paid: number;
    refunded: number;
    refunds: RefundState | null;
  } | null;
}

const FINAL = new Set(["ended", "expired"]);
const at = (iso: string) => Date.parse(iso);

/** A number setting read as whole days within the host's bounds; anything else is 0 (off). */
function asDays(value: unknown): number {
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) return 0;
  return Math.min(MAX_COOLING_OFF_DAYS, Math.floor(n));
}

/**
 * The cooling-off days a plan object's pack sets now, or null when the plan has no cooling off
 * (its pack does not declare `recurring.coolingOff`). Read when a subscription starts, and kept.
 */
export async function coolingOffDaysNow(
  ctx: HandlerContext,
  planObject: string,
): Promise<number | null> {
  const object = getObject(planObject);
  const setting = object?.sellable?.recurring?.coolingOff?.setting;
  const ext = object?.extension;
  if (!setting || !ext) return null;
  return asDays((await extensionSettingValues(ctx.db, ext))[setting]);
}

/**
 * The window of a subscription confirmed at `start` with `days` of cooling off, in `timeZone`:
 * the start's local day is day 0; the window closes at the local midnight that ends day `days`.
 */
export function coolingOffWindow(
  start: string,
  days: number,
  timeZone: string,
): { until: string; endsAt: string } {
  const local = localParts(start, timeZone);
  const last = addLocalDays(local, days);
  const after = addLocalDays(local, days + 1);
  const pad = (n: number) => String(n).padStart(2, "0");
  return {
    until: `${last.year}-${pad(last.month)}-${pad(last.day)}`,
    endsAt: wallClockToIso({ ...after, hour: 0, minute: 0, second: 0 }, timeZone),
  };
}

/** An order of a subscription: what was paid and refunded, and the moment it is for. */
interface PaidOrder {
  paid: number;
  refunded: number;
  /** The period it pays for (its start), else when it was paid. */
  moment: string;
}

/**
 * Whether a paid order is owed back by a cooling off (ADR 0647): paid for up to the window's end,
 * or between the last ask and the provider's end (`end`; now, while it has not ended).
 */
export function owedByCoolOff(
  order: Pick<PaidOrder, "moment">,
  bounds: { windowEndsAt: string; lastAskedAt: string | null; end: string },
): boolean {
  const t = at(order.moment);
  if (t <= at(bounds.windowEndsAt)) return true;
  return bounds.lastAskedAt !== null && t >= at(bounds.lastAskedAt) && t <= at(bounds.end);
}

/** The same rule in SQL, over `core_order as o`, for the one statement that owes the refunds. */
const MOMENT = sql<string>`coalesce(o.period_start, o.paid_at, o.created_at)`;

/**
 * Whether each of `rows` may be cooled off now, and any cooling off asked for, in a fixed number
 * of reads whatever the number of rows (at most 20 are asked at once).
 */
export async function coolingOffStatuses(
  ctx: HandlerContext,
  rows: readonly SubscriptionRow[],
): Promise<CoolingOffStatus[]> {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const holders = [
    ...new Set(rows.map((r) => r.holder_person_id).filter((h): h is string => h !== null)),
  ];
  const [checkouts, coolOffs, orders, refundRows, general] = await Promise.all([
    ctx.db
      .selectFrom("core_subscription_checkout")
      .select(["id", "offer_id", "cooling_off_days"])
      .where("id", "in", ids)
      .execute(),
    ctx.db
      .selectFrom("core_subscription_cool_off")
      .selectAll()
      .where((eb) =>
        holders.length
          ? eb.or([eb("subscription_id", "in", ids), eb("holder_person_id", "in", holders)])
          : eb("subscription_id", "in", ids),
      )
      .execute(),
    ctx.db
      .selectFrom("core_order as o")
      .select(["o.subscription_id", "o.paid", "o.refunded", MOMENT.as("moment")])
      .where("o.subscription_id", "in", ids)
      .where("o.paid", ">", 0)
      .execute(),
    ctx.db
      .selectFrom("core_sellable_refund_due as d")
      .innerJoin("core_order as o", "o.id", "d.order_id")
      .select(["o.subscription_id", "d.state"])
      .where("o.subscription_id", "in", ids)
      .where("d.entered", "=", COOLED_OFF)
      .execute(),
    loadGeneralSettings(ctx.db),
  ]);
  const staff = ctx.principal.kind === "staff";
  const out: CoolingOffStatus[] = [];
  for (const row of rows) {
    const checkout = checkouts.find((c) => c.id === row.id);
    const own = coolOffs.find((c) => c.subscription_id === row.id) ?? null;
    const theirs = orders.filter((o) => o.subscription_id === row.id);
    const covered = getObject(row.plan_object)?.sellable?.recurring?.coolingOff !== undefined;
    const days = own ? own.days : covered ? asDays(checkout?.cooling_off_days ?? 0) : 0;
    const window = days > 0 ? coolingOffWindow(row.created_at, days, general.timezone) : null;
    const endsAt = own ? own.window_ends_at : (window?.endsAt ?? null);
    const inWindow = endsAt !== null && at(ctx.now) < at(endsAt);
    const used = coolOffs.some(
      (c) =>
        c.subscription_id !== row.id &&
        row.holder_person_id !== null &&
        c.holder_person_id === row.holder_person_id &&
        (c.state === "asked" || c.state === "ended"),
    );
    // What it owes back: the rule the refunds are written by, with the end now while it runs. An
    // ask the provider has not taken (refused, no answer) is asked again now, so only an ask it
    // took (or the one that ended it) widens what is owed past the window.
    const taken =
      own !== null &&
      (own.state === "ended" ||
        (own.state === "asked" && (own.call_outcome === "sent" || own.call_outcome === "pending")));
    const bounds = endsAt
      ? {
          windowEndsAt: endsAt,
          lastAskedAt: taken ? own.last_asked_at : ctx.now,
          end: own?.ended_at ?? ctx.now,
        }
      : null;
    const owed = bounds ? theirs.filter((o) => owedByCoolOff(o, bounds)) : [];
    const paid = owed.reduce((sum, o) => sum + Number(o.paid), 0);
    const refunded = owed.reduce((sum, o) => sum + Math.min(Number(o.refunded), Number(o.paid)), 0);
    const why: NotOffered | null = !covered
      ? "not_covered"
      : !checkout || checkout.offer_id !== null
        ? "continuation"
        : days === 0
          ? "off"
          : FINAL.has(row.state)
            ? "ended"
            : !inWindow
              ? "window_passed"
              : used
                ? "used"
                : paid - refunded <= 0
                  ? "nothing_paid"
                  : null;
    const refunds = refundRows.filter((r) => r.subscription_id === row.id).map((r) => r.state);
    const stuck =
      own !== null &&
      (own.state === "refused" ||
        (own.state === "asked" && (own.call_outcome === null || own.call_outcome === "unknown")));
    out.push({
      subscriptionId: row.id,
      offered: own === null && why === null,
      why: own ? null : why,
      days,
      until: window?.until ?? null,
      endsAt,
      refund: Math.max(0, paid - refunded),
      currency: row.currency,
      coolOff: own
        ? {
            state: own.state,
            asked: own.call_outcome,
            askedBy: own.asked_by,
            askedAt: own.asked_at,
            endedAt: own.ended_at,
            askAgain: stuck && !FINAL.has(row.state) && !used && (staff || inWindow),
            open: own.state === "asked" || (own.state === "refused" && inWindow),
            staffTold: own.told_at !== null,
            paid,
            refunded,
            refunds:
              own.state !== "ended"
                ? null
                : paid > 0 && refunded >= paid
                  ? "refunded"
                  : refunds.some((s) => s === "lapsed" || s === "skipped")
                    ? "held"
                    : "waiting",
          }
        : null,
    });
  }
  return out;
}

/**
 * `subscription.coolingOff`: the statuses of `ids` (up to 20) for their caller. A customer's own
 * are the subscriptions they pay for (ADR 0487); another's, or none, is not found, whichever it is,
 * so the answer names nobody.
 */
export async function coolingOffFor(
  ctx: HandlerContext,
  ids: readonly string[],
): Promise<CoolingOffStatus[]> {
  const wanted = [...new Set(ids)];
  const rows = await ctx.db
    .selectFrom("core_subscription")
    .selectAll()
    .where("id", "in", wanted)
    .execute();
  const caller = ctx.principal;
  const own = rows.filter((r) =>
    caller.kind === "staff"
      ? true
      : caller.kind === "customer" && r.payer_person_id === caller.personId,
  );
  const missing = wanted.find((id) => !own.some((r) => r.id === id));
  if (missing) throw new NotFoundError("subscription", missing);
  return coolingOffStatuses(
    ctx,
    wanted.map((id) => own.find((r) => r.id === id) as SubscriptionRow),
  );
}

/** The words a member or staff are told when cooling off is refused (no other person named). */
export function notOfferedWords(why: NotOffered, until: string | null): string {
  switch (why) {
    case "not_covered":
      return "Cooling off does not apply to this plan.";
    case "off":
      return "This business has no cooling-off period.";
    case "continuation":
      return "Cooling off is for new members: this membership was not started as a new one here.";
    case "ended":
      return "This membership has ended.";
    case "window_passed":
      return `The cooling-off period ended${until ? ` at the end of ${until}` : ""}.`;
    case "used":
      return "Cooling off has been used for this member before: it is once per member.";
    case "nothing_paid":
      return "Nothing has been paid on this membership yet: cancel it, and it ends with its free time at no charge.";
  }
}

/** The refund-owed rows a cooling off writes are marked so (core_sellable_refund_due.entered). */
export const COOLED_OFF = "cooled_off";

export interface CooledOff {
  id: string;
  state: "asked" | "ended";
  /** What came of asking the provider: sent, pending (an approval), unknown (its next event decides). */
  asked: "sent" | "pending" | "unknown" | null;
  /** What it owes back once it ends, in minor units (the member's "a full refund of"). */
  refund: number;
  currency: string;
}

const refuse = (row: SubscriptionRow, why: NotOffered, until: string | null) =>
  new ConflictError(notOfferedWords(why, until), {
    subscription: row.id,
    rule: "cooling_off",
    reason: why,
    ...(until ? { until } : {}),
  });

/**
 * `subscription.coolOff`: the payer's own subscription (a member, a guardian paying for a child) or
 * staff for anyone's; a person only (the operation's actors). The cooling off's row is written in
 * this batch; the provider is asked to end the subscription after it commits. Asked again, it asks
 * the provider again until it is sent: by the member only while the window is open, by staff
 * after it; once sent or ended it changes nothing.
 */
export async function coolOff(
  ctx: HandlerContext,
  id: string,
): Promise<AfterCommit<CooledOff> | CooledOff> {
  const caller = ctx.principal;
  if (caller.kind === "public") {
    throw new ValidationError("Sign in to end your membership", { rule: "sign_in" });
  }
  const row = await loadSubscriptionRow(ctx.db, id);
  // A customer's own is the subscription they pay for (ADR 0487): another's is not found, and the
  // answer names nobody.
  if (caller.kind === "customer" && row.payer_person_id !== caller.personId) {
    throw new NotFoundError("subscription", id);
  }
  const existing =
    (await ctx.db
      .selectFrom("core_subscription_cool_off")
      .selectAll()
      .where("subscription_id", "=", row.id)
      .executeTakeFirst()) ?? null;
  const [status] = await coolingOffStatuses(ctx, [row]);
  if (!status) throw new NotFoundError("subscription", id);
  const result = (state: CooledOff["state"], asked: CooledOff["asked"]): CooledOff => ({
    id: row.id,
    state,
    asked,
    refund: status.refund,
    currency: row.currency,
  });
  if (existing?.state === "ended") return result("ended", existing.call_outcome);
  if (existing?.state === "lapsed") throw refuse(row, "ended", null);
  // Taken by the provider (or waiting at the gatekeeper for a person): nothing to ask again.
  if (
    existing?.state === "asked" &&
    (existing.call_outcome === "sent" || existing.call_outcome === "pending")
  ) {
    return result("asked", existing.call_outcome);
  }
  if (existing) {
    // Asked inside the window, and the provider has not taken it (refused, no answer, or never
    // asked). A subscription that has ended has nothing left to end.
    if (FINAL.has(row.state)) throw refuse(row, "ended", null);
    // After the window, only staff finish it (the member's ask was in time); what is owed stays
    // what was paid up to the window's end and between this ask and the end.
    if (caller.kind !== "staff" && at(ctx.now) >= at(existing.window_ends_at)) {
      throw refuse(row, "window_passed", status.until);
    }
    // The holder cooled off another membership meanwhile: once per member (the database holds it
    // too, migration 0856).
    if (!status.coolOff?.askAgain) throw refuse(row, "used", null);
    ctx.write(
      ctx.db
        .updateTable("core_subscription_cool_off")
        .set({ state: "asked", call_outcome: null, last_asked_at: ctx.now, updated_at: ctx.now })
        .where("subscription_id", "=", row.id)
        .where("state", "=", existing.state),
    );
  } else {
    if (!status.offered) throw refuse(row, status.why ?? "not_covered", status.until);
    // Refused by the database when the holder cooled off another meanwhile (migration 0856), and
    // by the primary key when two asks race: the whole batch fails and nothing is asked.
    ctx.write(
      ctx.db.insertInto("core_subscription_cool_off").values({
        subscription_id: row.id,
        holder_person_id: row.holder_person_id,
        asked_by: caller.kind === "staff" ? "staff" : "payer",
        asked_by_user: caller.kind === "staff" ? caller.userId : null,
        days: status.days,
        window_ends_at: status.endsAt as string,
        state: "asked",
        call_outcome: null,
        asked_at: ctx.now,
        last_asked_at: ctx.now,
        ended_at: null,
        updated_at: ctx.now,
      }),
    );
  }
  return afterCommit(async () => result("asked", await askToEnd(ctx, row)));
}

type Db = Kysely<import("@composable-os/db").CoreDatabase>;

/** Tells admins once per subscription and kind, and marks the cooling off as told. */
async function tellStuck(
  db: Db,
  row: Pick<SubscriptionRow, "id" | "plan_title">,
  kind: "refused" | "unknown" | "stuck",
  now: string,
): Promise<void> {
  const body =
    kind === "refused"
      ? "period, and the payment provider refused to end it, so it still runs and nothing is owed yet. "
      : kind === "unknown"
        ? "period, and the payment provider did not answer: it may or may not have ended. "
        : "period in time, and the payment provider has not ended it; the period has now passed, " +
          "so the member cannot ask again. ";
  const plan = await notifyStatements(
    db,
    {
      to: [{ role: "admin" }],
      type: "system.message",
      title:
        kind === "refused"
          ? "A cooling off was refused by the payment provider"
          : kind === "unknown"
            ? "A cooling off was not confirmed by the payment provider"
            : "A cooling off asked in time has not ended the membership",
      body:
        `Subscription ${row.id} (${row.plan_title}) was asked to end in its cooling-off ${body}` +
        "Open the subscription and ask again (Cooling off). What is owed is what was paid up to " +
        "the end of its cooling-off period, and anything paid between the ask and the end.",
      link: { kind: "record", object: "subscription", id: row.id },
      dedupeKey: `subscription.cool_off:${kind}:${row.id}`,
      source: { actor: "system" },
    },
    now,
  );
  for (const statement of plan.statements) await db.executeQuery(statement.compile());
  await db
    .updateTable("core_subscription_cool_off")
    .set({ told_at: now })
    .where("subscription_id", "=", row.id)
    .where("told_at", "is", null)
    .execute();
}

/** Writes what came of a call, with an audit row of the host's; refused marks it refused. */
async function recordAsk(
  db: Db,
  row: SubscriptionRow,
  outcome: "sent" | "pending" | "unknown" | "refused",
  by: string | null,
): Promise<void> {
  const now = new Date().toISOString();
  const updated = await db
    .updateTable("core_subscription_cool_off")
    .set(
      outcome === "refused"
        ? { state: "refused", call_outcome: null, updated_at: now }
        : { call_outcome: outcome, updated_at: now },
    )
    .where("subscription_id", "=", row.id)
    .where("state", "=", "asked")
    .executeTakeFirst();
  const written = Number(updated.numUpdatedRows ?? 0) > 0;
  await db
    .insertInto("core_audit")
    .values({
      id: newId("audit"),
      at: now,
      operation: "subscription.coolOff.outcome",
      risk: "write",
      // The host's own record of what the provider answered, not a caller's act.
      actor: "automation",
      user_id: null,
      origin: JSON.stringify({ surface: "system", automationId: "subscription.coolOff.outcome" }),
      input: JSON.stringify({ subscriptionId: row.id, by }),
      result: JSON.stringify(
        written
          ? { written: true, outcome }
          : { written: false, outcome, why: "the cooling off had moved on: nothing was written" },
      ),
      gate_decision: "auto",
      outcome: "ok",
      error: null,
    })
    .execute();
  if (written && (outcome === "unknown" || outcome === "refused")) {
    await tellStuck(db, row, outcome, now);
  }
}

/** Whether the provider reads the subscription as ended now (an observation); null if unread. */
async function endedAtProvider(
  ctx: Pick<HandlerContext, "db" | "integrations">,
  row: SubscriptionRow,
): Promise<boolean | null> {
  try {
    const target = await paymentsTarget(ctx.db);
    const read = (
      await callSubscriptionGatekeeper(
        ctx.integrations,
        target,
        "getSubscription",
        row.provider_ref,
      )
    ).value as { ref?: unknown; status?: unknown } | null;
    if (read?.ref !== row.provider_ref) return null;
    return read.status === "canceled";
  } catch {
    return null;
  }
}

/**
 * Asks the provider to end `row` now (the cooling off's row already committed), and writes what
 * came of it. A refusal is first checked against the provider's read (one that shows it ended
 * counts as sent), then marks it refused and throws; an unknown answer leaves it asked for the
 * sweep. Admins are told of both, once. The gatekeeper's idempotency key for a cancel now is fixed
 * per subscription (`cos-cancel-<id>-now`), so asking again is the same request to the provider.
 */
async function askToEnd(
  ctx: Pick<HandlerContext, "db" | "integrations" | "operation">,
  row: SubscriptionRow,
): Promise<"sent" | "pending" | "unknown"> {
  const by = ctx.operation ?? null;
  const target = await paymentsTarget(ctx.db);
  if (target.provider !== row.provider) {
    await recordAsk(ctx.db, row, "refused", by);
    throw new ConflictError(
      `This subscription is with ${row.provider}, and payments now use ${target.provider}`,
      { subscription: row.id, rule: "provider" },
    );
  }
  let answer: Awaited<ReturnType<typeof callSubscriptionGatekeeper>>;
  try {
    answer = await callSubscriptionGatekeeper(ctx.integrations, target, "cancelSubscription", {
      subscriptionId: row.id,
      subscriptionRef: row.provider_ref,
      when: "now",
      reason: "Cooling off",
    });
  } catch {
    // The call itself failed: it may have been submitted before the answer was lost.
    await recordAsk(ctx.db, row, "unknown", by);
    return "unknown";
  }
  let { outcome } = subscriptionCallOutcome(answer);
  // A refusal because it has ended already (a second ask racing the first, or an end the host has
  // not heard of yet) is not a refusal of the cooling off: the provider's own read says which.
  if (outcome === "refused" && (await endedAtProvider(ctx, row)) === true) outcome = "sent";
  await recordAsk(ctx.db, row, outcome, by);
  if (outcome === "refused") {
    throw new ConflictError(
      "The payment provider did not end your membership, so nothing changed. Try again; the " +
        "business has been told.",
      { subscription: row.id, rule: "provider_refused" },
    );
  }
  return outcome;
}

/**
 * The minute cron's sweep (`subscription.coolOffSweep`, a host step): asks whose answer was lost
 * (`unknown`) or never made (the Worker stopped between the commit and the call), older than
 * `COOL_OFF_SWEEP_AFTER_MS`, at most `COOL_OFF_SWEEP_BATCH` a tick. Each is resolved from the
 * provider's own read first: ended, it was sent; still running, it is asked again while the window
 * is open, else admins are told once. Unread, it is left for the next tick. Nothing is asked twice
 * at once: the provider is read before any ask, and an ask moves the row's time on.
 */
export async function sweepCoolOffs(
  ctx: Pick<HandlerContext, "db" | "integrations" | "operation" | "now">,
): Promise<{ resolved: number; asked: number; told: number; unread: number }> {
  const out = { resolved: 0, asked: 0, told: 0, unread: 0 };
  const cutoff = new Date(at(ctx.now) - COOL_OFF_SWEEP_AFTER_MS).toISOString();
  const due = await ctx.db
    .selectFrom("core_subscription_cool_off")
    .selectAll()
    .where("state", "=", "asked")
    .where("updated_at", "<", cutoff)
    .where((eb) => eb.or([eb("call_outcome", "is", null), eb("call_outcome", "=", "unknown")]))
    .where((eb) => eb.or([eb("told_at", "is", null), eb("window_ends_at", ">", ctx.now)]))
    .orderBy("updated_at")
    .limit(COOL_OFF_SWEEP_BATCH)
    .execute();
  for (const own of due) {
    const row = await loadSubscriptionRow(ctx.db, own.subscription_id);
    const ended = FINAL.has(row.state) ? true : await endedAtProvider(ctx, row);
    if (ended === null) {
      await ctx.db
        .updateTable("core_subscription_cool_off")
        .set({ updated_at: ctx.now })
        .where("subscription_id", "=", own.subscription_id)
        .where("state", "=", "asked")
        .execute();
      out.unread += 1;
      continue;
    }
    if (ended) {
      await recordAsk(ctx.db, row, "sent", "subscription.coolOffSweep");
      out.resolved += 1;
      continue;
    }
    if (at(ctx.now) < at(own.window_ends_at)) {
      await ctx.db
        .updateTable("core_subscription_cool_off")
        .set({ last_asked_at: ctx.now, updated_at: ctx.now })
        .where("subscription_id", "=", own.subscription_id)
        .where("state", "=", "asked")
        .execute();
      await askToEnd(ctx, row).catch(() => undefined);
      out.asked += 1;
      continue;
    }
    if (own.told_at === null) {
      await tellStuck(ctx.db, row, "stuck", ctx.now);
      out.told += 1;
    }
  }
  return out;
}

/** The orders a cooling off owes back, as `core_order as o` filters, for the one statement. */
function owedOrders(
  ctx: HandlerContext,
  subscriptionId: string,
  bounds: { windowEndsAt: string; lastAskedAt: string; end: string },
) {
  return ctx.db
    .selectFrom("core_order as o")
    .where("o.subscription_id", "=", subscriptionId)
    .where(sql<boolean>`o.paid > o.refunded`)
    .where(
      sql<boolean>`(${MOMENT} <= ${bounds.windowEndsAt} OR (${MOMENT} >= ${bounds.lastAskedAt} AND ${MOMENT} <= ${bounds.end}))`,
    );
}

/**
 * In the batch of every verified event of a subscription with a cooling off asked (events.ts),
 * once the provider shows it ended. An end within `END_AFTER_ASK_MS` of the last ask is this
 * cooling off's: what was paid up to the window's end and between the ask and the end is owed back
 * in full, one row per order in one statement; the bookings ahead the membership paid for are
 * released; admins are told once. Any other end (an ordinary cancel, failed payments, months
 * later) owes nothing as cooled off: the cooling off lapses and admins are told once. An order
 * paid later, for a period within those bounds, is owed back by its own event's batch. Nothing is
 * asked of the provider here: the minute cron asks for each refund owed, which waits for a person
 * with `orders:refund`.
 */
export async function followCoolOff(ctx: HandlerContext, row: SubscriptionRow): Promise<void> {
  if (!FINAL.has(row.state)) return;
  const own = await ctx.db
    .selectFrom("core_subscription_cool_off")
    .selectAll()
    .where("subscription_id", "=", row.id)
    .executeTakeFirst();
  if (!own || own.state === "refused" || own.state === "lapsed") return;
  const end = own.ended_at ?? row.ended_at ?? ctx.now;
  const since = at(end) - at(own.last_asked_at);
  const ours = own.state === "ended" || (since >= -END_BEFORE_ASK_MS && since <= END_AFTER_ASK_MS);
  const tell = async (title: string, body: string, key: string) => {
    const plan = await notifyStatements(
      ctx.db,
      {
        to: [{ role: "admin" }],
        type: "system.message",
        title,
        body,
        link: { kind: "record", object: "subscription", id: row.id },
        dedupeKey: key,
        source: { actor: "system" },
      },
      ctx.now,
    );
    ctx.write(...plan.statements);
  };
  if (!ours) {
    ctx.write(
      ctx.db
        .updateTable("core_subscription_cool_off")
        .set({ state: "lapsed", ended_at: end, updated_at: ctx.now })
        .where("subscription_id", "=", row.id)
        .where("state", "=", "asked"),
    );
    await tell(
      "A cooling off lapsed: the membership ended another way",
      `Subscription ${row.id} (${row.plan_title}) was asked to end in its cooling-off period, ` +
        "and the payment provider did not end it then; it has now ended another way (a cancel, " +
        "failed payments). Nothing is owed as cooled off. Check whether the member is owed a " +
        "refund of what was paid in the cooling-off period, and refund it from its orders.",
      `subscription.cool_off_lapsed:${row.id}`,
    );
    return;
  }
  const bounds = { windowEndsAt: own.window_ends_at, lastAskedAt: own.last_asked_at, end };
  const reason = "A membership ended in its cooling-off period: a full refund";
  // One statement, set-based: every order of it the rule owes, not refunded. Its id is the
  // order's own (one refund owed per order; the unique index holds it too).
  ctx.write(
    ctx.db
      .insertInto("core_sellable_refund_due")
      .orIgnore()
      .columns([
        "id",
        "order_id",
        "object_type",
        "record_id",
        "entered",
        "reason",
        "state",
        "attempt",
        "created_at",
        "updated_at",
      ])
      .expression(
        owedOrders(ctx, row.id, bounds).select([
          sql<string>`'rdu_' || substr(o.id, instr(o.id, '_') + 1)`.as("id"),
          "o.id as order_id",
          sql<string>`'subscription'`.as("object_type"),
          sql<string>`${row.id}`.as("record_id"),
          sql<string>`${COOLED_OFF}`.as("entered"),
          sql<string>`${reason}`.as("reason"),
          sql<string>`'due'`.as("state"),
          sql<number>`0`.as("attempt"),
          sql<string>`${ctx.now}`.as("created_at"),
          sql<string>`${ctx.now}`.as("updated_at"),
        ]),
      ),
  );
  if (own.state === "ended") return;
  ctx.write(
    ctx.db
      .updateTable("core_subscription_cool_off")
      .set({ state: "ended", ended_at: end, updated_at: ctx.now })
      .where("subscription_id", "=", row.id)
      .where("state", "=", "asked"),
  );
  const owed = await owedOrders(ctx, row.id, bounds)
    .select(sql<number>`coalesce(sum(o.paid - o.refunded), 0)`.as("owed"))
    .executeTakeFirst();
  const released = await releaseBookingsAhead(ctx, row);
  await tell(
    "A membership ended in its cooling-off period",
    `Subscription ${row.id} (${row.plan_title}) ended in its ${own.days}-day cooling-off period. ` +
      `A full refund of what was paid on it (${formatMoney(Number(owed?.owed ?? 0), row.currency)}) ` +
      "is owed: each paid period's refund waits in Approvals for a person who may refund." +
      (released.released
        ? ` ${released.released} booking(s) ahead it paid for were cancelled by the business, their places freed.`
        : "") +
      (released.left
        ? ` More bookings ahead than the host releases at once (${COOL_OFF_RELEASE_MAX}) were left: cancel the rest from the member's bookings.`
        : ""),
    `subscription.cooled_off:${row.id}`,
  );
}

/**
 * The bookings ahead a cooled-off membership paid for (stage 44 step 7, ADR 0647): each record that
 * spent a use of the subscription's granted holder, not given back, whose time is still ahead, is
 * moved by the host into its object's `released` state (the spender declares it: Bookings'
 * `cancelled_by_us`), in this batch, as any host move: its use returned and its place freed, so
 * the waiting list moves people in as usual. A record in a state with no host move into it is
 * left. At most `COOL_OFF_RELEASE_MAX`; `left` says there were more.
 */
async function releaseBookingsAhead(
  ctx: HandlerContext,
  row: SubscriptionRow,
): Promise<{ released: number; left: boolean }> {
  const grant = await ctx.db
    .selectFrom("core_subscription_grant")
    .select(["object_type", "record_id"])
    .where("subscription_id", "=", row.id)
    .executeTakeFirst();
  if (!grant) return { released: 0, left: false };
  const uses = await ctx.db
    .selectFrom("core_allowance_use")
    .select(["spender_type", "spender_id"])
    .where("object_type", "=", grant.object_type)
    .where("record_id", "=", grant.record_id)
    .where("returned_at", "is", null)
    .where("at", ">", ctx.now)
    .orderBy("at")
    .limit(COOL_OFF_RELEASE_MAX + 1)
    .execute();
  const left = uses.length > COOL_OFF_RELEASE_MAX;
  const byType = new Map<string, string[]>();
  for (const use of uses.slice(0, COOL_OFF_RELEASE_MAX)) {
    byType.set(use.spender_type, [...(byType.get(use.spender_type) ?? []), use.spender_id]);
  }
  let released = 0;
  for (const [type, ids] of byType) {
    const object = getObject(type);
    const allowance = object?.allowance;
    const into = allowance?.kind === "spender" ? allowance.released : undefined;
    const stateField = object?.states?.field;
    const field = object?.fields.find((f) => f.name === stateField);
    const column = field ? viewColumnOf(field) : null;
    if (!object || !into || !stateField || !column) continue;
    // The host's read of their states, one statement for the object.
    // biome-ignore lint/suspicious/noExplicitAny: extension views are not in the typed schema.
    const rows = (await (ctx.db as Kysely<any>)
      .selectFrom(visibleSource(orgReader(ctx.db), object))
      .select(["id", `${column} as state`])
      .where("id", "in", ids)
      .execute()) as { id: string; state: string | null }[];
    // Only a record still in a state it spends in (booked): one attended, or cancelled late, stands.
    const spendIn = allowance?.kind === "spender" ? allowance.spendIn : [];
    const movable = new Set(
      (object.states?.moves ?? [])
        .filter((m) => m.to === into && m.by.includes("host"))
        .flatMap((m) => (Array.isArray(m.from) ? m.from : [m.from]))
        .filter((s) => spendIn.includes(s)),
    );
    for (const record of rows) {
      if (!record.state || !movable.has(record.state)) continue;
      await updateRecordAsHost(ctx, type, record.id, { [stateField]: into });
      released += 1;
    }
  }
  return { released, left };
}

export interface CoolOffSweepOptions {
  integrations?: IntegrationRuntime | undefined;
  floor?: GateFloor | undefined;
  events?: EventSink | undefined;
  clock?: (() => Date) | undefined;
}

/**
 * The minute cron's step: `subscription.coolOffSweep` as the host's automation, from the system
 * origin. With nothing due it is one indexed read.
 */
export async function runCoolOffSweep(
  crm: CrmDb,
  { integrations, floor, events, clock }: CoolOffSweepOptions = {},
): Promise<{ resolved: number; asked: number; told: number; unread: number }> {
  return (await invokeByName(
    "subscription.coolOffSweep",
    {},
    {
      actor: "automation",
      user: SYSTEM_USER,
      origin: { surface: "system", automationId: "system.orders" },
      db: crm,
      ...(integrations ? { integrations } : {}),
      ...(floor ? { floor } : {}),
      ...(events ? { events } : {}),
      ...(clock ? { clock } : {}),
    },
  )) as { resolved: number; asked: number; told: number; unread: number };
}
