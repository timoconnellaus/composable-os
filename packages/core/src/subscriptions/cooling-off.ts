// Cooling off (stage 44 step 7, decision 11, ADR 0647). A business may set a cooling-off period:
// whole days, 0 off (the default). A new member may end their membership within it for a full
// refund of what they paid in it; each refund is owed (core_sellable_refund_due) and asked of the
// payments gatekeeper by the minute cron, where it waits for a person with `orders:refund` like
// every refund (ADR 0429). Nothing here charges or refunds a card on its own (ADR 0485).
//
// Who it covers (decisions 16 and 17, and the owner's decisions of 2026-11-24):
//   - a subscription to a plan whose pack declares `sellable.recurring.coolingOff` (Memberships'
//     plans; never a pass, never a course plan), started here by `subscription.start` without a
//     continuation offer (a new member, not one moving over);
//   - within the window: from the host's processing of the provider's first event for it (its
//     record's `created_at`) to the end of the last local day in the business's time zone, the
//     start's day being day 0. A clock change moves nothing: the end is a local midnight;
//   - the days are those in force when it was started, kept on its checkout, for good;
//   - once per member, ever (held by the database, migration 0856): one refused or lapsed, which
//     got them nothing, does not count until staff finish it;
//   - something paid: in a free trial nothing is owed back, and the ordinary cancel ends it.
//
// What it does: ends the subscription at the provider now, asked after the operation's batch
// commits the cooling off's row; every ask by a person is a new request to the provider (its own
// idempotency key), and every ask again reads the provider first. A member asks again only while
// the window is open; after it, only staff with `subscriptions:manage` finish one the member asked
// in time. A lost, never-made or waiting call is resolved by the minute cron's sweep. When the
// subscription ends, `causedBy` says whether this cooling off ended it: then what was paid up to the
// window's end, and between the ask and the end, is owed back in full, and the bookings ahead the
// membership paid for (and the member's own places on waiting lists it would pay for) are cancelled
// as the business's, the rest by follow-ups, with one summary email to the member. Any other end
// owes nothing as cooled off: the cooling off is `lapsed`, admins are told, and staff may finish it.
import type { CoreSubscriptionCoolOffTable, CrmDb } from "@composable-os/db";
import { type Kysely, type Selectable, sql } from "kysely";
import type { EventSink } from "../automations/types.ts";
import { ConflictError, NotFoundError, ValidationError } from "../errors.ts";
import { getObject } from "../fields/index.ts";
import type { ObjectDefinition } from "../fields/types.ts";
import type { GateFloor } from "../gate.ts";
import { newId } from "../ids.ts";
import type { IntegrationRuntime } from "../integrations/runtime.ts";
import { invokeByName } from "../invoke.ts";
import { resolveChannelTarget } from "../notifications/channels.ts";
import { loadDeliverySettings } from "../notifications/preferences.ts";
import { notifyStatements } from "../notifications/send.ts";
import { type AfterCommit, afterCommit, type HandlerContext } from "../operation.ts";
import { updateRecordAsHost } from "../operations/record.ts";
import { callSubscriptionGatekeeper, paymentsTarget, sendHostEmail } from "../orders/gateway.ts";
import { formatMoney } from "../orders/orders.ts";
import { viewColumnOf } from "../records/columns.ts";
import { extensionSettingValues } from "../records/windows.ts";
import { loadGeneralSettings } from "../settings.ts";
import { addLocalDays, localParts, wallClockToIso } from "../time/local.ts";
import { SYSTEM_USER } from "../users.ts";
import { orgReader, visibleSource } from "../visibility/index.ts";
import { loadSubscriptionRow, type SubscriptionRow } from "./events.ts";

export type CoolOffRow = Selectable<CoreSubscriptionCoolOffTable>;

/** The longest cooling-off period the host keeps (the SDK's MAX_COOLING_OFF_DAYS). */
export const MAX_COOLING_OFF_DAYS = 90;
/** An end within this long of the latest ask is that ask's (a retry by staff after the window). */
export const END_AFTER_ASK_MS = 2 * 86_400_000;
/** A provider's end a little before the host's first ask (clocks differ) still counts. */
const END_BEFORE_ASK_MS = 5 * 60_000;
/** A payment the provider took as it ended, reported up to this long after the end, is owed too. */
const PAID_AFTER_END_MS = END_AFTER_ASK_MS;
/** The sweep looks at an ask whose answer was lost or never made after this long. */
export const COOL_OFF_SWEEP_AFTER_MS = 5 * 60_000;
/** And at one waiting at the gatekeeper (for a person) after this long. */
export const COOL_OFF_PENDING_AFTER_MS = 60 * 60_000;
/** How many asks one sweep looks at. */
export const COOL_OFF_SWEEP_BATCH = 10;
/** The bookings ahead released in the end's own batch; the rest by follow-ups. */
export const COOL_OFF_RELEASE_IN_BATCH = 20;
/** The bookings ahead one follow-up releases. */
export const COOL_OFF_RELEASE_FOLLOW_UP = 30;
/** After this many failed follow-ups admins are told and they stop. */
const RELEASE_FAILURES_MAX = 3;

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
    /** The caller may ask the provider again (or, for staff, finish a lapsed one) now. */
    askAgain: boolean;
    /** Under way: the ordinary cancel waits (asked, or refused while the window is open). */
    open: boolean;
    /** Admins were told it is stuck: only then is the member told so. */
    staffTold: boolean;
    /** What it owes back (owed, once ended), what has been refunded of that, and where it is. */
    paid: number;
    refunded: number;
    refunds: RefundState | null;
  } | null;
}

const FINAL = new Set(["ended", "expired"]);
const at = (iso: string) => Date.parse(iso);
const iso = (ms: number) => new Date(ms).toISOString();

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

/**
 * Whether the provider's end of a subscription is its cooling off's (ADR 0647): at or after the
 * first ask (less a few minutes for clocks), and inside the window (any end there follows an ask
 * made in time: a retry, staff ending it, a retryable action the gatekeeper applied late), or
 * within `END_AFTER_ASK_MS` of the latest ask (staff finishing one after the window), or while the
 * ask waits for a person at the gatekeeper and the provider says it was a cancel, whenever that
 * person approves it. Anything else (failed payments, an ordinary cancel months later) is not.
 */
export function causedBy(
  own: Pick<CoolOffRow, "asked_at" | "last_asked_at" | "window_ends_at" | "call_outcome">,
  end: string,
  endReason: string | null,
): boolean {
  const t = at(end);
  if (t < at(own.asked_at) - END_BEFORE_ASK_MS) return false;
  if (t <= at(own.window_ends_at)) return true;
  if (t <= at(own.last_asked_at) + END_AFTER_ASK_MS) return true;
  return (
    own.call_outcome === "pending" &&
    endReason !== "payment_failed" &&
    endReason !== "payment_disputed"
  );
}

/**
 * What a cooling off owes back (ADR 0647, the owner's rule): every order paid on or before the
 * window's end, by when it was paid, plus those paid between the ask that ended it and that end
 * (a payment the provider took as it ended, reported up to `PAID_AFTER_END_MS` later, included).
 */
export interface OwedBounds {
  windowEndsAt: string;
  /** The ask that ended it (or would): its moment, or null when only the window counts. */
  from: string | null;
  /** The end (now, while it has not ended). */
  to: string;
}

export function owedByCoolOff(paidAt: string, bounds: OwedBounds): boolean {
  const t = at(paidAt);
  if (t <= at(bounds.windowEndsAt)) return true;
  return bounds.from !== null && t >= at(bounds.from) && t <= at(bounds.to) + PAID_AFTER_END_MS;
}

/** The bounds for a cooling off ended at `end`: the first ask if it ended in the window, else the latest. */
function boundsFor(
  own: Pick<CoolOffRow, "asked_at" | "last_asked_at" | "window_ends_at">,
  end: string,
): OwedBounds {
  return {
    windowEndsAt: own.window_ends_at,
    from: at(end) <= at(own.window_ends_at) ? own.asked_at : own.last_asked_at,
    to: end,
  };
}

/** When an order was paid, for the rule above. */
const PAID_AT = sql<string>`coalesce(o.paid_at, o.created_at)`;

/**
 * Whether each of `rows` may be cooled off now, and any cooling off asked for, in a fixed number
 * of statements whatever the number of rows (at most 20 are asked at once).
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
      .select(["o.subscription_id", "o.paid", "o.refunded", PAID_AT.as("paid_at")])
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
    // What it owes back, by the rule the refunds are written by. Ended: as written. Otherwise as
    // if it ended now: an ask the provider took counts from it; one it has not (refused, no
    // answer) would be asked again now; a lapsed one staff finish owes the window's only.
    const taken =
      own?.state === "asked" && (own.call_outcome === "sent" || own.call_outcome === "pending");
    const bounds: OwedBounds | null = !endsAt
      ? null
      : own?.state === "ended" && own.ended_at
        ? boundsFor(own, own.ended_at)
        : own?.state === "lapsed"
          ? { windowEndsAt: endsAt, from: null, to: endsAt }
          : own && (taken || inWindow)
            ? boundsFor(own, ctx.now)
            : { windowEndsAt: endsAt, from: ctx.now, to: ctx.now };
    const owed = bounds ? theirs.filter((o) => owedByCoolOff(o.paid_at, bounds)) : [];
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
        (own.state === "asked" &&
          (own.call_outcome === null ||
            own.call_outcome === "unknown" ||
            (own.call_outcome === "pending" && staff))));
    const askAgain =
      own !== null &&
      !used &&
      ((stuck && !FINAL.has(row.state) && (staff || inWindow)) ||
        (own.state === "lapsed" && staff));
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
            askAgain,
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

/**
 * Whether a cooling off is under way on `subscriptionId` (asked, or refused while its window is
 * open): the ordinary cancel waits for it (`subscription.cancel` refuses).
 */
export async function coolOffOpen(
  db: Kysely<import("@composable-os/db").CoreDatabase>,
  subscriptionId: string,
  now: string,
): Promise<boolean> {
  const own = await db
    .selectFrom("core_subscription_cool_off")
    .select(["state", "window_ends_at"])
    .where("subscription_id", "=", subscriptionId)
    .executeTakeFirst();
  if (!own) return false;
  return own.state === "asked" || (own.state === "refused" && at(now) < at(own.window_ends_at));
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
  /** What came of asking the provider: sent, pending (waiting at the gatekeeper), unknown. */
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
 * this batch; the provider is read (for an ask again) and asked to end the subscription after it
 * commits. Asked again, by the member only while the window is open, by staff after it too; once
 * sent or ended it changes nothing. Staff finish a lapsed one: what was paid in the window is owed.
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
  if (existing?.state === "lapsed") {
    // Staff finish one the provider ended another way: what was paid in the window is owed back,
    // and it counts as the member's one (the database checks it).
    if (caller.kind !== "staff") throw refuse(row, "ended", null);
    if (!status.coolOff?.askAgain) throw refuse(row, "used", null);
    oweRefunds(ctx, row.id, {
      windowEndsAt: existing.window_ends_at,
      from: null,
      to: existing.window_ends_at,
    });
    ctx.write(
      ctx.db
        .updateTable("core_subscription_cool_off")
        .set({ state: "ended", last_asked_at: ctx.now, updated_at: ctx.now })
        .where("subscription_id", "=", row.id)
        .where("state", "=", "lapsed"),
    );
    return result("ended", existing.call_outcome);
  }
  // Taken by the provider: nothing to ask again. Waiting at the gatekeeper: the member waits;
  // staff may ask again.
  if (
    existing?.state === "asked" &&
    (existing.call_outcome === "sent" ||
      (existing.call_outcome === "pending" && caller.kind !== "staff"))
  ) {
    return result("asked", existing.call_outcome);
  }
  let askCount = 1;
  if (existing) {
    // Asked inside the window, and the provider has not taken it. A subscription that has ended
    // has nothing left to end.
    if (FINAL.has(row.state)) throw refuse(row, "ended", null);
    // After the window, only staff finish it (the member's ask was in time).
    if (caller.kind !== "staff" && at(ctx.now) >= at(existing.window_ends_at)) {
      throw refuse(row, "window_passed", status.until);
    }
    // The holder cooled off another membership meanwhile: once per member (the database holds it
    // too, migration 0856).
    if (!status.coolOff?.askAgain) throw refuse(row, "used", null);
    askCount = existing.ask_count + 1;
    ctx.write(
      ctx.db
        .updateTable("core_subscription_cool_off")
        .set({
          state: "asked",
          call_outcome: null,
          last_asked_at: ctx.now,
          ask_count: askCount,
          updated_at: ctx.now,
        })
        .where("subscription_id", "=", row.id)
        .where("state", "=", existing.state)
        .where("ask_count", "=", existing.ask_count),
    );
  } else {
    if (!status.offered) throw refuse(row, status.why ?? "not_covered", status.until);
    // Refused by the database when the holder cooled off another meanwhile (migration 0856), and
    // when two asks race: the whole batch fails and nothing is asked.
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
        ask_count: 1,
        ended_at: null,
        updated_at: ctx.now,
      }),
    );
  }
  const again = existing !== null;
  return afterCommit(async () => {
    // An ask again reads the provider first: one it ended already (an earlier answer lost) is sent.
    if (again && (await endedAtProvider(ctx, row)) === true) {
      await recordAsk(ctx.db, row, "sent", ctx.operation ?? null, ctx.now);
      return result("asked", "sent");
    }
    return result("asked", await askToEnd(ctx, row, askCount));
  });
}

type Db = Kysely<import("@composable-os/db").CoreDatabase>;
type StuckKind = "refused" | "unknown" | "stuck" | "pending" | "release";

/** Tells admins once per subscription and kind, and marks the cooling off as told. */
async function tellStuck(
  db: Db,
  row: Pick<SubscriptionRow, "id" | "plan_title">,
  kind: StuckKind,
  now: string,
): Promise<void> {
  const what: Record<StuckKind, [string, string]> = {
    refused: [
      "A cooling off was refused by the payment provider",
      "and the payment provider refused to end it, so it still runs and nothing is owed yet. Open the subscription and ask again (Cooling off).",
    ],
    unknown: [
      "A cooling off was not confirmed by the payment provider",
      "and the payment provider did not answer: it may or may not have ended. The host reads the provider again within minutes; if it still runs, open the subscription and ask again (Cooling off).",
    ],
    stuck: [
      "A cooling off asked in time has not ended the membership",
      "in time, and the payment provider has not ended it; the period has now passed, so the member cannot ask again. Open the subscription and finish it (Cooling off).",
    ],
    pending: [
      "A cooling off is waiting for approval at the payment gatekeeper",
      "and ending it waits for a person to approve it at the payments gatekeeper. Approve it there, or open the subscription and ask again (Cooling off).",
    ],
    release: [
      "Bookings ahead of a cooled-off membership were not all cancelled",
      "and the host could not cancel all of the bookings ahead it paid for. Cancel the rest from the member's bookings.",
    ],
  };
  const [title, tail] = what[kind];
  const plan = await notifyStatements(
    db,
    {
      to: [{ role: "admin" }],
      type: "system.message",
      title,
      body:
        `Subscription ${row.id} (${row.plan_title}) was asked to end in its cooling-off period, ${tail} ` +
        "What is owed is what was paid up to the end of its cooling-off period, and anything paid " +
        "between the ask and the end.",
      link: { kind: "record", object: "subscription", id: row.id },
      dedupeKey: `subscription.cool_off:${kind}:${row.id}`,
      source: { actor: "system" },
    },
    now,
  );
  for (const statement of plan.statements) await db.executeQuery(statement.compile());
  if (kind === "release") return;
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
  /** The host's clock for the call (the operation's), so the sweep's timings read one clock. */
  now: string,
): Promise<void> {
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
 * What came of a cancel, from the gatekeeper's typed outcome (`integrations/outcome.ts`). A
 * `retryable` failure left the action pending again at the gatekeeper, which may still apply it:
 * that is `pending`, never `refused`.
 */
function cancelOutcome(result: {
  pending: unknown[];
  applied: unknown[];
  failed?: { outcome: "refused" | "unknown" | "retryable"; message: string }[];
}): "sent" | "pending" | "unknown" | "refused" {
  if (result.applied.length) return "sent";
  if (result.pending.length) return "pending";
  const failed = result.failed?.[0];
  if (failed?.outcome === "retryable") return "pending";
  if (failed?.outcome === "refused") return "refused";
  return "unknown";
}

/**
 * Asks the provider to end `row` now (the cooling off's row already committed), and writes what
 * came of it. Each ask by a person has its own idempotency key (`cool-off-<ask>`): a member trying
 * again is a new request, never a replay of the first answer; the sweep's retry of one ask keeps
 * its key. Staff's ordinary "end it now" keeps the subscription's own key. A refusal is first
 * checked against the provider's read (one that shows it ended counts as sent), then marks it
 * refused and throws; an unknown answer leaves it asked for the sweep. Admins are told once.
 */
async function askToEnd(
  ctx: Pick<HandlerContext, "db" | "integrations" | "operation" | "now">,
  row: SubscriptionRow,
  askCount: number,
): Promise<"sent" | "pending" | "unknown"> {
  const by = ctx.operation ?? null;
  const target = await paymentsTarget(ctx.db);
  if (target.provider !== row.provider) {
    await recordAsk(ctx.db, row, "refused", by, ctx.now);
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
      askKey: `cool-off-${askCount}`,
    });
  } catch {
    // The call itself failed: it may have been submitted before the answer was lost.
    await recordAsk(ctx.db, row, "unknown", by, ctx.now);
    return "unknown";
  }
  let outcome = cancelOutcome(answer);
  // A refusal because it has ended already (a second ask racing the first, or an end the host has
  // not heard of yet) is not a refusal of the cooling off: the provider's own read says which.
  if (outcome === "refused" && (await endedAtProvider(ctx, row)) === true) outcome = "sent";
  await recordAsk(ctx.db, row, outcome, by, ctx.now);
  if (outcome === "refused") {
    throw new ConflictError(
      "The payment provider did not end your membership, so nothing changed. Try again; the " +
        "business has been told.",
      { subscription: row.id, rule: "provider_refused" },
    );
  }
  return outcome;
}

/** The sweep's result. */
export interface CoolOffSweep {
  resolved: number;
  asked: number;
  told: number;
  unread: number;
  mailed: number;
}

/**
 * The minute cron's sweep (`subscription.coolOffSweep`, a host step), at most
 * `COOL_OFF_SWEEP_BATCH` asks a tick:
 *   - an ask whose answer was lost (`unknown`) or never made (the Worker stopped between the
 *     commit and the call), older than `COOL_OFF_SWEEP_AFTER_MS`: the provider's read first
 *     (ended: sent); still running, asked again (the same ask, the same key) while the window is
 *     open, else admins told once; unread, left for the next tick;
 *   - an ask waiting at the gatekeeper for a person (`pending`), older than
 *     `COOL_OFF_PENDING_AFTER_MS`: the provider's read (ended: sent), else admins told once;
 *   - the member's summary email of what was cancelled with the membership, once.
 */
export async function sweepCoolOffs(
  ctx: Pick<HandlerContext, "db" | "integrations" | "operation" | "now">,
): Promise<CoolOffSweep> {
  const out: CoolOffSweep = { resolved: 0, asked: 0, told: 0, unread: 0, mailed: 0 };
  for (const own of await dueAsks(ctx.db, ctx.now)) {
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
      await recordAsk(ctx.db, row, "sent", "subscription.coolOffSweep", ctx.now);
      out.resolved += 1;
      continue;
    }
    if (own.call_outcome === "pending") {
      if (own.told_at === null) {
        await tellStuck(ctx.db, row, "pending", ctx.now);
        out.told += 1;
      }
      await ctx.db
        .updateTable("core_subscription_cool_off")
        .set({ updated_at: ctx.now })
        .where("subscription_id", "=", own.subscription_id)
        .execute();
      continue;
    }
    if (at(ctx.now) < at(own.window_ends_at)) {
      await ctx.db
        .updateTable("core_subscription_cool_off")
        .set({ last_asked_at: ctx.now, updated_at: ctx.now })
        .where("subscription_id", "=", own.subscription_id)
        .where("state", "=", "asked")
        .execute();
      await askToEnd(ctx, row, own.ask_count).catch(() => undefined);
      out.asked += 1;
      continue;
    }
    if (own.told_at === null) {
      await tellStuck(ctx.db, row, "stuck", ctx.now);
      out.told += 1;
    }
  }
  out.mailed = await sendSummaries(ctx);
  return out;
}

/** The asks the sweep looks at now (one indexed read). */
async function dueAsks(db: Db, now: string) {
  const lost = iso(at(now) - COOL_OFF_SWEEP_AFTER_MS);
  const waiting = iso(at(now) - COOL_OFF_PENDING_AFTER_MS);
  return db
    .selectFrom("core_subscription_cool_off")
    .selectAll()
    .where("state", "=", "asked")
    .where((eb) =>
      eb.or([
        eb.and([
          eb.or([eb("call_outcome", "is", null), eb("call_outcome", "=", "unknown")]),
          eb("updated_at", "<", lost),
          eb.or([eb("told_at", "is", null), eb("window_ends_at", ">", now)]),
        ]),
        eb.and([eb("call_outcome", "=", "pending"), eb("updated_at", "<", waiting)]),
      ]),
    )
    .orderBy("updated_at")
    .limit(COOL_OFF_SWEEP_BATCH)
    .execute();
}

/**
 * Whether the minute cron has anything to do for cooling offs (one cheap read), so an idle tick
 * invokes nothing and writes no audit row.
 */
async function anythingDue(db: Db, now: string): Promise<boolean> {
  const [asks, follow] = await Promise.all([
    dueAsks(db, now),
    db
      .selectFrom("core_subscription_cool_off")
      .select("subscription_id")
      .where((eb) => eb.or([eb("release_left", "=", 1), eb("mail_state", "=", "due")]))
      .limit(1)
      .execute(),
  ]);
  return asks.length > 0 || follow.length > 0;
}

/**
 * The member's one email (the owner's decision 1): their membership ended in its cooling-off
 * period, the bookings ahead it paid for were cancelled with it, and the refund is owed. Host mail,
 * through the email channel an admin chose (Settings → Notification delivery), as an order's
 * confirmation is (ADR 0429): its approval rules apply. Claimed before it is sent, so two sweeps
 * send it once; one that cannot be sent is marked so and admins are told.
 */
async function sendSummaries(
  ctx: Pick<HandlerContext, "db" | "integrations" | "now">,
): Promise<number> {
  const due = await ctx.db
    .selectFrom("core_subscription_cool_off")
    .select(["subscription_id", "released_count"])
    .where("mail_state", "=", "due")
    .where("release_left", "=", 0)
    .limit(COOL_OFF_SWEEP_BATCH)
    .execute();
  let mailed = 0;
  for (const own of due) {
    const claimed = await ctx.db
      .updateTable("core_subscription_cool_off")
      .set({ mail_state: "sending", updated_at: ctx.now })
      .where("subscription_id", "=", own.subscription_id)
      .where("mail_state", "=", "due")
      .executeTakeFirst();
    if (Number(claimed.numUpdatedRows ?? 0) !== 1) continue;
    const row = await loadSubscriptionRow(ctx.db, own.subscription_id);
    const done = async (state: "sent" | "failed") =>
      ctx.db
        .updateTable("core_subscription_cool_off")
        .set({ mail_state: state, updated_at: ctx.now })
        .where("subscription_id", "=", own.subscription_id)
        .execute();
    try {
      const settings = await loadDeliverySettings(ctx.db);
      const resolved =
        row.email && settings.email
          ? await resolveChannelTarget(ctx.db, "email", settings.email)
          : null;
      if (!row.email || !resolved || "problem" in resolved) {
        await done("failed");
        continue;
      }
      const count = Number(own.released_count);
      await sendHostEmail(ctx.integrations, resolved.target, {
        to: row.email,
        subject: "Your membership has ended in its cooling-off period",
        text: [
          `Your membership (${row.plan_title}) has ended in its cooling-off period.`,
          "",
          count
            ? `${count} ${count === 1 ? "booking" : "bookings"} for classes ahead that it paid for ${count === 1 ? "was" : "were"} cancelled with it, and the places given back.`
            : "No bookings ahead were paid for by it.",
          "",
          "A refund of what you paid in the cooling-off period is owed: the business approves it, then it goes back to how you paid.",
        ].join("\n"),
      });
      await done("sent");
      mailed += 1;
    } catch {
      await done("failed");
    }
  }
  return mailed;
}

/** Writes a refund owed for each order `bounds` owes, in one statement keyed by the order. */
function oweRefunds(ctx: HandlerContext, subscriptionId: string, bounds: OwedBounds): void {
  const reason = "A membership ended in its cooling-off period: a full refund";
  const inWindow = sql<boolean>`${PAID_AT} <= ${bounds.windowEndsAt}`;
  const between =
    bounds.from === null
      ? sql<boolean>`0`
      : sql<boolean>`(${PAID_AT} >= ${bounds.from} AND ${PAID_AT} <= ${iso(at(bounds.to) + PAID_AFTER_END_MS)})`;
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
        ctx.db
          .selectFrom("core_order as o")
          .where("o.subscription_id", "=", subscriptionId)
          .where(sql<boolean>`o.paid > o.refunded`)
          .where(sql<boolean>`(${inWindow} OR ${between})`)
          .select([
            sql<string>`'rdu_' || substr(o.id, instr(o.id, '_') + 1)`.as("id"),
            "o.id as order_id",
            sql<string>`'subscription'`.as("object_type"),
            sql<string>`${subscriptionId}`.as("record_id"),
            sql<string>`${COOLED_OFF}`.as("entered"),
            sql<string>`${reason}`.as("reason"),
            sql<string>`'due'`.as("state"),
            sql<number>`0`.as("attempt"),
            sql<string>`${ctx.now}`.as("created_at"),
            sql<string>`${ctx.now}`.as("updated_at"),
          ]),
      ),
  );
}

/**
 * In the batch of every verified event of a subscription with a cooling off asked or refused
 * (events.ts), once the provider shows it ended. An end `causedBy` the cooling off owes back what
 * was paid up to the window's end and between the ask and the end, in one statement; the first
 * `COOL_OFF_RELEASE_IN_BATCH` bookings ahead are released here, the rest by follow-ups; the
 * member's summary email is due; admins are told once. Any other end owes nothing as cooled off:
 * the cooling off lapses and admins are told once. An order paid later within the bounds is owed
 * back by its own event's batch. Nothing is asked of the provider here.
 */
export async function followCoolOff(ctx: HandlerContext, row: SubscriptionRow): Promise<void> {
  if (!FINAL.has(row.state)) return;
  const own = await ctx.db
    .selectFrom("core_subscription_cool_off")
    .selectAll()
    .where("subscription_id", "=", row.id)
    .executeTakeFirst();
  if (!own || own.state === "lapsed") return;
  if (own.state === "ended") {
    oweRefunds(ctx, row.id, boundsFor(own, own.ended_at ?? ctx.now));
    return;
  }
  const end = row.ended_at ?? ctx.now;
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
  if (!causedBy(own, end, row.end_reason)) {
    ctx.write(
      ctx.db
        .updateTable("core_subscription_cool_off")
        .set({ state: "lapsed", ended_at: end, updated_at: ctx.now })
        .where("subscription_id", "=", row.id)
        .where("state", "=", own.state),
    );
    await tell(
      "A cooling off lapsed: the membership ended another way",
      `Subscription ${row.id} (${row.plan_title}) was asked to end in its cooling-off period, ` +
        "and the payment provider did not end it then; it has now ended another way (a cancel, " +
        "failed payments). Nothing is owed as cooled off yet. If the member should have what they " +
        "paid in the cooling-off period back, open the subscription and finish the cooling off " +
        "there (Cooling off): that owes it back, each refund approved as usual, and counts as the " +
        "member's one cooling off. Do not refund it by hand from the orders.",
      `subscription.cool_off_lapsed:${row.id}`,
    );
    return;
  }
  const bounds = boundsFor(own, end);
  oweRefunds(ctx, row.id, bounds);
  const released = await releaseBookingsAhead(ctx, row, COOL_OFF_RELEASE_IN_BATCH);
  ctx.write(
    ctx.db
      .updateTable("core_subscription_cool_off")
      .set({
        state: "ended",
        ended_at: end,
        release_left: released.left ? 1 : 0,
        released_count: released.released,
        mail_state: row.email ? "due" : null,
        updated_at: ctx.now,
      })
      .where("subscription_id", "=", row.id)
      .where("state", "=", own.state),
  );
  const orders = await ctx.db
    .selectFrom("core_order as o")
    .select(["o.paid", "o.refunded", PAID_AT.as("paid_at")])
    .where("o.subscription_id", "=", row.id)
    .where("o.paid", ">", 0)
    .execute();
  const owed = orders
    .filter((o) => owedByCoolOff(o.paid_at, bounds))
    .reduce((sum, o) => sum + Math.max(0, Number(o.paid) - Number(o.refunded)), 0);
  await tell(
    "A membership ended in its cooling-off period",
    `Subscription ${row.id} (${row.plan_title}) ended in its ${own.days}-day cooling-off period. ` +
      `A full refund of what was paid in it (${formatMoney(owed, row.currency)}) is owed: each ` +
      "paid period's refund waits in Approvals for a person who may refund. The bookings ahead " +
      "it paid for are cancelled by the business, their places freed.",
    `subscription.cooled_off:${row.id}`,
  );
}

/** A spender object's fields the release reads, by their view columns. */
function spenderColumns(object: ObjectDefinition) {
  const allowance = object.allowance;
  if (allowance?.kind !== "spender") return null;
  const stateField = object.states?.field;
  const col = (name: string | undefined) => {
    const field = name ? object.fields.find((f) => f.name === name) : undefined;
    return field ? viewColumnOf(field) : null;
  };
  const state = col(stateField);
  const into = allowance.released;
  if (!stateField || !state || !into) return null;
  const moves = object.states?.moves ?? [];
  const hostMovesFrom = (s: string) =>
    moves.some(
      (m) =>
        m.to === into &&
        m.by.includes("host") &&
        (Array.isArray(m.from) ? m.from : [m.from]).includes(s),
    );
  return {
    allowance,
    stateField,
    state,
    person: col(allowance.person),
    holder: col(allowance.holder),
    into,
    hostMovesFrom,
    waiting: object.claims?.waitlist?.state ?? null,
  };
}

/**
 * The bookings ahead a cooled-off membership paid for (the owner's decision 1, ADR 0647), at most
 * `limit` in this batch: each record that spent a use of the subscription's granted holder, not
 * given back, whose time is still ahead, still in a state it spends in (booked; one attended or
 * cancelled late stands), and each of the holder's Person's own places on a waiting list ahead that
 * it would pay for (naming it, or naming nothing when they hold nothing else live), is moved by the
 * host into its object's `released` state (Bookings' `cancelled_by_us`): its use returned, its
 * place freed for the waiting list. `left`: there are more.
 */
export async function releaseBookingsAhead(
  ctx: HandlerContext,
  row: SubscriptionRow,
  limit: number,
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
    .limit(limit + 1)
    .execute();
  const targets: { type: string; id: string; from: "spend" | "waiting" }[] = uses.map((u) => ({
    type: u.spender_type,
    id: u.spender_id,
    from: "spend",
  }));
  // The holder's Person's own waiting places it would pay for.
  const holderObject = getObject(grant.object_type);
  const person = row.holder_person_id;
  if (person && holderObject?.allowance?.kind === "holder" && targets.length <= limit) {
    const others = await ctx.db
      .selectFrom("core_allowance")
      .select("record_id")
      .where("person_id", "=", person)
      .where("live", "=", 1)
      .where("trashed", "=", 0)
      .where((eb) => eb.or([eb("valid_until", "is", null), eb("valid_until", ">", ctx.now)]))
      .where((eb) =>
        eb.or([eb("object_type", "!=", grant.object_type), eb("record_id", "!=", grant.record_id)]),
      )
      .limit(1)
      .execute();
    for (const on of holderObject.allowance.spendsOn) {
      const object = getObject(on.object);
      const cols = object ? spenderColumns(object) : null;
      if (!object || !cols?.waiting || !cols.person || !cols.hostMovesFrom(cols.waiting)) continue;
      // The spender's time, one relation away (`class.startsAt`), read set-based.
      const [relName, timeName] = (cols.allowance.at ?? "").split(".");
      const rel = object.fields.find((f) => f.name === relName);
      const relCol = rel ? viewColumnOf(rel) : null;
      const target = rel?.options?.to ? getObject(rel.options.to) : undefined;
      const timeField = target?.fields.find((f) => f.name === timeName);
      const timeCol = timeField ? viewColumnOf(timeField) : null;
      if (!relCol || !target || !timeCol) continue;
      // biome-ignore lint/suspicious/noExplicitAny: extension views are not in the typed schema.
      const db = ctx.db as Kysely<any>;
      const waiting = (await db
        .selectFrom(visibleSource(orgReader(ctx.db), object))
        .select(["id", `${relCol} as rel`, ...(cols.holder ? [`${cols.holder} as holder`] : [])])
        .where(cols.person, "=", person)
        .where(cols.state, "=", cols.waiting)
        .limit(limit + 1)
        .execute()) as { id: string; rel: string | null; holder?: string | null }[];
      const payable = waiting.filter((w) =>
        w.holder ? w.holder === grant.record_id : others.length === 0,
      );
      const relIds = [...new Set(payable.map((w) => w.rel).filter((r): r is string => !!r))];
      const times = relIds.length
        ? ((await db
            .selectFrom(visibleSource(orgReader(ctx.db), target))
            .select(["id", `${timeCol} as time`])
            .where("id", "in", relIds)
            .execute()) as { id: string; time: string | null }[])
        : [];
      for (const w of payable) {
        const time = times.find((t) => t.id === w.rel)?.time;
        if (time && at(time) > at(ctx.now)) {
          targets.push({ type: object.name, id: w.id, from: "waiting" });
        }
      }
    }
  }
  const left = targets.length > limit;
  const byType = new Map<string, string[]>();
  for (const t of targets.slice(0, limit)) {
    byType.set(t.type, [...(byType.get(t.type) ?? []), t.id]);
  }
  let released = 0;
  for (const [type, ids] of byType) {
    const object = getObject(type);
    const cols = object ? spenderColumns(object) : null;
    if (!object || !cols) continue;
    // The host's read of their states, one statement for the object.
    // biome-ignore lint/suspicious/noExplicitAny: extension views are not in the typed schema.
    const rows = (await (ctx.db as Kysely<any>)
      .selectFrom(visibleSource(orgReader(ctx.db), object))
      .select(["id", `${cols.state} as state`])
      .where("id", "in", ids)
      .execute()) as { id: string; state: string | null }[];
    for (const record of rows) {
      const s = record.state;
      const spends = s !== null && cols.allowance.spendIn.includes(s);
      const waits = s !== null && s === cols.waiting;
      if (!s || !(spends || waits) || !cols.hostMovesFrom(s)) continue;
      await updateRecordAsHost(ctx, type, record.id, { [cols.stateField]: cols.into });
      released += 1;
    }
  }
  return { released, left };
}

/**
 * `subscription.coolOffRelease { id }` (a host step): the next `COOL_OFF_RELEASE_FOLLOW_UP`
 * bookings ahead of a cooled-off membership, in this batch, until none is left. Idempotent: what
 * is released is not found again.
 */
export async function releaseFollowUp(
  ctx: HandlerContext,
  id: string,
): Promise<{ released: number; left: boolean }> {
  const own = await ctx.db
    .selectFrom("core_subscription_cool_off")
    .select(["state", "release_left", "released_count"])
    .where("subscription_id", "=", id)
    .executeTakeFirst();
  if (own?.state !== "ended" || own.release_left !== 1) return { released: 0, left: false };
  const row = await loadSubscriptionRow(ctx.db, id);
  const out = await releaseBookingsAhead(ctx, row, COOL_OFF_RELEASE_FOLLOW_UP);
  ctx.write(
    ctx.db
      .updateTable("core_subscription_cool_off")
      .set({
        release_left: out.left ? 1 : 0,
        released_count: Number(own.released_count) + out.released,
        updated_at: ctx.now,
      })
      .where("subscription_id", "=", id)
      .where("release_left", "=", 1),
  );
  return out;
}

export interface CoolOffSweepOptions {
  integrations?: IntegrationRuntime | undefined;
  floor?: GateFloor | undefined;
  events?: EventSink | undefined;
  clock?: (() => Date) | undefined;
}

/**
 * The minute cron's step: nothing when nothing is due (one cheap read, no operation, no audit
 * row); else `subscription.coolOffSweep`, then `subscription.coolOffRelease` for each cooled-off
 * membership with bookings ahead left (a few a tick). A follow-up that keeps failing tells admins
 * after `RELEASE_FAILURES_MAX` tries and stops.
 */
export async function runCoolOffSweep(
  crm: CrmDb,
  { integrations, floor, events, clock }: CoolOffSweepOptions = {},
): Promise<CoolOffSweep & { releases: number }> {
  const now = (clock?.() ?? new Date()).toISOString();
  const idle = { resolved: 0, asked: 0, told: 0, unread: 0, mailed: 0, releases: 0 };
  if (!(await anythingDue(crm.query, now))) return idle;
  const host = {
    actor: "automation" as const,
    user: SYSTEM_USER,
    origin: { surface: "system" as const, automationId: "system.orders" },
    db: crm,
    ...(integrations ? { integrations } : {}),
    ...(floor ? { floor } : {}),
    ...(events ? { events } : {}),
    ...(clock ? { clock } : {}),
  };
  const left = await crm.query
    .selectFrom("core_subscription_cool_off")
    .select(["subscription_id", "release_failures"])
    .where("release_left", "=", 1)
    .limit(5)
    .execute();
  let releases = 0;
  for (const own of left) {
    try {
      await invokeByName("subscription.coolOffRelease", { id: own.subscription_id }, host);
      releases += 1;
    } catch {
      const failures = Number(own.release_failures) + 1;
      await crm.query
        .updateTable("core_subscription_cool_off")
        .set({
          release_failures: failures,
          ...(failures >= RELEASE_FAILURES_MAX ? { release_left: 0 } : {}),
          updated_at: now,
        })
        .where("subscription_id", "=", own.subscription_id)
        .execute();
      if (failures >= RELEASE_FAILURES_MAX) {
        const row = await loadSubscriptionRow(crm.query, own.subscription_id);
        await tellStuck(crm.query, row, "release", now);
      }
    }
  }
  const swept = (await invokeByName("subscription.coolOffSweep", {}, host)) as CoolOffSweep;
  return { ...swept, releases };
}
