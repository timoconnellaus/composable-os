// Cooling off (stage 44 step 7, decision 11, ADR 0647). A business may set a cooling-off period:
// whole days, 0 off (the default). A new member may end their membership within it for a full
// refund of what they paid; each refund is owed (core_sellable_refund_due) and asked of the
// payments gatekeeper by the minute cron, where it waits for a person with `orders:refund` like
// every refund (ADR 0429). Nothing here charges or refunds a card on its own (ADR 0485).
//
// Who it covers (decisions 16 and 17, and the owner's decisions of 2026-11-24): a subscription to a
// plan whose pack declares `sellable.recurring.coolingOff`, started here without a continuation
// offer; inside the window (from the host's processing of the provider's first event for it to the
// end of the last local day in the business's zone); the days kept on its checkout at the start;
// once per member, ever; with something paid.
//
// The rule (ADR 0647, the coordinator's decision of 2026-11-24, replacing the earlier cases):
//   A. An ask is valid only inside the window (the member, or staff for them). It opens the
//      cooling off (`asked`) and fixes a deadline: `asked_at` + `COOL_OFF_OPEN_DAYS` (the approval
//      expiry, so a waiting approval never outlives it). Asking again (the member inside the
//      window, staff before the deadline) retries the provider; neither moves.
//   B. While open and before the deadline, any end of the subscription is the cooling off's end,
//      whatever its reason; one timestamped before the ask (less `CLOCK_TOLERANCE_MS`) or after
//      the deadline is not.
//   C. What is owed is always: every order paid on or before the window's end, plus every order
//      paid after the ask and on or before the end. The figures shown are the same function.
//   D. At the deadline an open one that has not ended lapses (the minute cron): admins are told,
//      the ordinary cancel works again, and every cancel of it still waiting at the gatekeeper is
//      rejected. While one waits nobody may ask again; once none waits and the latest was turned
//      down or expired, it lapses at once. One the provider shows ended waits for its event a day
//      after the deadline at most. One whose holder has since used theirs lapses as used. A
//      lapsed one never becomes the cooling off's by a later end.
//   E. Staff may finish a lapsed one: the membership is ended at the provider (retried with the
//      same key, a waiting approval waited for, admins told once if it cannot be done), and only
//      when the provider's event shows it ended is it `ended`: the window's payments owed, the
//      bookings ahead released and the summary sent, as an end does.
//   F. Once per member: an ended (or finished) one counts; an open or lapsed one does not. The
//      end is checked for it before anything is written, so nothing here ever fails the recording
//      of a subscription's end; the bookings are released by a step of their own after it.
//   G. Every state has an exit for the member (ADR 0647 lists them).
import type { CoreDatabase, CoreSubscriptionCoolOffTable, CrmDb } from "@composable-os/db";
import { type Kysely, type RawBuilder, type Selectable, sql } from "kysely";
import { DEFAULT_APPROVAL_EXPIRY_DAYS } from "../approvals/queue.ts";
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
import { rejectOnFacets } from "../operations/approval.ts";
import { updateRecordAsHost } from "../operations/record.ts";
import { callSubscriptionGatekeeper, paymentsTarget, sendHostEmail } from "../orders/gateway.ts";
import { formatMoney } from "../orders/orders.ts";
import { viewColumnOf } from "../records/columns.ts";
import { chunk } from "../records/common.ts";
import { extensionSettingValues } from "../records/windows.ts";
import { loadGeneralSettings } from "../settings.ts";
import { addLocalDays, localParts, wallClockToIso } from "../time/local.ts";
import { SYSTEM_USER } from "../users.ts";
import { orgReader, visibleSource } from "../visibility/index.ts";
import { loadSubscriptionRow, type SubscriptionRow } from "./events.ts";

export type CoolOffRow = Selectable<CoreSubscriptionCoolOffTable>;
type Db = Kysely<CoreDatabase>;

/** The longest cooling-off period the host keeps (the SDK's MAX_COOLING_OFF_DAYS). */
export const MAX_COOLING_OFF_DAYS = 90;
const DAY = 86_400_000;
/** How long a cooling off stays open after its ask: the gatekeeper's approval expiry. */
export const COOL_OFF_OPEN_DAYS = DEFAULT_APPROVAL_EXPIRY_DAYS;
/** An end timestamped this little before the ask (clocks differ) is still after it. */
export const CLOCK_TOLERANCE_MS = 5 * 60_000;
/** The sweep looks at an ask whose answer was lost or never made after this long… */
export const COOL_OFF_SWEEP_AFTER_MS = 5 * 60_000;
/** …and asks again (the same ask) at most this often, until the deadline. */
const RETRY_EVERY_MS = 60 * 60_000;
/** Admins are told of a cancel waiting at the gatekeeper after this long. */
export const COOL_OFF_PENDING_AFTER_MS = 60 * 60_000;
/** How many open cooling offs one sweep looks at. */
export const COOL_OFF_SWEEP_BATCH = 10;
/** The bookings ahead one release step moves (its own batch, never the end's). */
export const COOL_OFF_RELEASE_STEP = 15;
/** Release steps one minute tick runs: one, so the tick's statements stay bounded. */
const COOL_OFF_RELEASES_A_TICK = 1;
/** Uses read per page by a release step; it reads pages until it has a step's worth to release. */
const RELEASE_PAGE = 200;
/** The most pages one step reads (its statements stay far under D1's 1,000). */
const RELEASE_PAGES = 10;
/** After this many failed release steps admins are told and they stop. */
const RELEASE_FAILURES_MAX = 3;
/** A summary email claimed this long ago and not settled is tried again (with its key), once. */
const MAIL_STUCK_MS = 10 * 60_000;
/** D1 binds at most 100 values a statement. */
const CHUNK = 90;

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
  /** What it owes back (or would), not refunded yet, in minor units: the rule's own figure. */
  refund: number;
  currency: string;
  /** A cooling off asked for, and how far it has got. */
  coolOff: {
    state: "asked" | "ended" | "lapsed";
    asked: "sent" | "pending" | "unknown" | "refused" | null;
    askedBy: "payer" | "staff";
    askedAt: string;
    /** It stays open until then; after it, if nothing ended, it lapses. */
    deadline: string;
    endedAt: string | null;
    /** Staff finished a lapsed one. */
    finished: boolean;
    /** Staff asked to finish a lapsed one, and how far ending it at the provider has got. */
    finishing: "asked" | "sent" | "pending" | "unknown" | "stuck" | null;
    /** A cancel of it waits for a person at the gatekeeper: nobody may ask again until then. */
    waiting: boolean;
    /** Why it lapsed. */
    lapsedBecause: "deadline" | "action" | "end_time" | "used" | null;
    /** The caller may ask the provider again (or, staff, finish a lapsed one) now. */
    askAgain: boolean;
    /** Open: the ordinary cancel waits for it (until the deadline). */
    open: boolean;
    /** Admins were told it is stuck or lapsed: only then is the member told so. */
    staffTold: boolean;
    /** What it owes (or owed), what has been refunded of that, and where the refunds are. */
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

/** The deadline of a cooling off asked at `askedAt` (rule A). */
const coolOffDeadline = (askedAt: string) => iso(at(askedAt) + COOL_OFF_OPEN_DAYS * DAY);

/**
 * Whether an end at `end` is an open cooling off's (rule B): not before its ask (less the clock
 * tolerance) and not after its deadline. Nothing else is read.
 */
function endIsCoolOffs(own: Pick<CoolOffRow, "asked_at" | "deadline_at">, end: string) {
  const t = at(end);
  return t >= at(own.asked_at) - CLOCK_TOLERANCE_MS && t <= at(own.deadline_at);
}

/**
 * The bounds of what a cooling off owes (rule C): every order paid on or before `windowEndsAt`,
 * plus every order paid after `from` (the ask) and on or before `to` (the end). `from` null: the
 * window's payments only (a finished one).
 */
export interface OwedBounds {
  windowEndsAt: string;
  from: string | null;
  to: string | null;
}

export function owedByCoolOff(paidAt: string, bounds: OwedBounds): boolean {
  const t = at(paidAt);
  if (t <= at(bounds.windowEndsAt)) return true;
  return bounds.from !== null && bounds.to !== null && t > at(bounds.from) && t <= at(bounds.to);
}

/** The bounds a row's figure is read by: kept once it ended; else as if it ended now. */
function boundsOf(
  own: Pick<
    CoolOffRow,
    "state" | "asked_at" | "deadline_at" | "window_ends_at" | "owed_from" | "owed_to"
  > | null,
  windowEndsAt: string,
  now: string,
): OwedBounds {
  if (!own) return { windowEndsAt, from: null, to: null };
  if (own.state === "ended") {
    return { windowEndsAt: own.window_ends_at, from: own.owed_from, to: own.owed_to };
  }
  if (own.state === "lapsed") return { windowEndsAt: own.window_ends_at, from: null, to: null };
  return {
    windowEndsAt: own.window_ends_at,
    from: own.asked_at,
    to: at(now) < at(own.deadline_at) ? now : own.deadline_at,
  };
}

/**
 * When an order was paid, for the rule: the provider's own time for a period's payment (its
 * verified event's), else when the host recorded it paid. A payment whose event came late is
 * judged by when the money was taken, not when the host heard of it.
 */
const PAID_AT = sql<string>`coalesce(o.provider_paid_at, o.paid_at, o.created_at)`;

/** A cancel of a cooling off that waited at the gatekeeper, and where its approval is now. */
interface CoolOffAction {
  subscription_id: string;
  action_id: string;
  ask: number;
  status: string | null;
  expires_at: string | null;
  decided_at: string | null;
  connection_id: string | null;
  facet_key: string | null;
  gk_action: number | null;
}

/** Every cancel the cooling offs of `ids` ever waited on, with its approval (chunked). */
async function actionsOf(db: Db, ids: readonly string[]): Promise<CoolOffAction[]> {
  const out: CoolOffAction[] = [];
  for (const part of chunk(ids, CHUNK)) {
    out.push(
      ...(await db
        .selectFrom("core_subscription_cool_off_action as a")
        .leftJoin("core_pending_action as p", "p.id", "a.action_id")
        .select([
          "a.subscription_id",
          "a.action_id",
          "a.ask",
          "p.status",
          "p.expires_at",
          "p.decided_at",
          "p.connection_id",
          "p.facet_key",
          "p.gk_action",
        ])
        .where("a.subscription_id", "in", part)
        .execute()),
    );
  }
  return out;
}

/** Still waiting for a person at the gatekeeper. */
const waitingNow = (a: CoolOffAction, now: string) =>
  a.status === "pending" && (a.expires_at === null || at(a.expires_at) > at(now));
/** Approved and applied: the provider was asked. */
const appliedAction = (a: CoolOffAction) => a.status === "applied";

/** Whether a holder has a cooling off that counts (ended), on another subscription than `id`. */
async function holderUsed(db: Db, holder: string | null, id: string): Promise<boolean> {
  if (!holder) return false;
  const row = await db
    .selectFrom("core_subscription_cool_off")
    .select("subscription_id")
    .where("holder_person_id", "=", holder)
    .where("state", "=", "ended")
    .where("subscription_id", "!=", id)
    .executeTakeFirst();
  return row !== undefined;
}

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
  const [checkouts, coolOffs, orders, refundRows, general, actions] = await Promise.all([
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
    actionsOf(ctx.db, ids),
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
        c.state === "ended",
    );
    const bounds = endsAt ? boundsOf(own, endsAt, ctx.now) : null;
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
    // Open: asked, before its deadline, and the holder has not used theirs since (rule F).
    const open = own?.state === "asked" && at(ctx.now) < at(own.deadline_at) && !used;
    const waiting = actions.some((a) => a.subscription_id === row.id && waitingNow(a, ctx.now));
    const retryable =
      own?.state === "asked" &&
      open &&
      !FINAL.has(row.state) &&
      own.call_outcome !== "sent" &&
      !waiting;
    const finishable =
      own?.state === "lapsed" &&
      staff &&
      own.lapsed_because !== "used" &&
      own.finish_state !== "sent" &&
      !waiting;
    const askAgain = own !== null && !used && ((retryable && (staff || inWindow)) || finishable);
    const refunds = refundRows.filter((r) => r.subscription_id === row.id).map((r) => r.state);
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
            deadline: own.deadline_at,
            endedAt: own.ended_at,
            finished: own.finished === 1,
            finishing: own.state === "lapsed" ? own.finish_state : null,
            waiting,
            lapsedBecause: own.lapsed_because,
            askAgain,
            open,
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
 * Whether a cooling off is open on `subscriptionId` (asked, before its deadline, and its holder
 * has not used theirs on another since): the ordinary cancel waits for it (`subscription.cancel`
 * refuses), for the member and for staff.
 */
export async function coolOffOpen(db: Db, subscriptionId: string, now: string): Promise<boolean> {
  const own = await db
    .selectFrom("core_subscription_cool_off")
    .select(["state", "deadline_at", "holder_person_id"])
    .where("subscription_id", "=", subscriptionId)
    .executeTakeFirst();
  if (own?.state !== "asked" || at(now) >= at(own.deadline_at)) return false;
  return !(await holderUsed(db, own.holder_person_id, subscriptionId));
}

/** The words a member or staff are told when cooling off is refused (no other person named). */
function notOfferedWords(why: NotOffered, until: string | null): string {
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

/** A new ask (or a finish) is refused while a cancel of the cooling off waits for a person. */
const waitingRefusal = (row: SubscriptionRow) =>
  new ConflictError(
    "Ending this membership is waiting for approval at the payments gatekeeper. It is approved " +
      "or turned down there; nothing can be asked again until then.",
    { subscription: row.id, rule: "cooling_off", reason: "waiting" },
  );

/** The refund-owed rows a cooling off writes are marked so (core_sellable_refund_due.entered). */
export const COOLED_OFF = "cooled_off";

export interface CooledOff {
  id: string;
  /** asked: open; ended: it ended; lapsed: staff's finish is asked, not yet confirmed. */
  state: "asked" | "ended" | "lapsed";
  /** What came of asking the provider: sent, pending (waiting at the gatekeeper), unknown. */
  asked: "sent" | "pending" | "unknown" | null;
  /** What it owes back, not refunded yet, in minor units (the member's "a full refund of"). */
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
 * staff for anyone's; a person only (the operation's actors).
 *   - No cooling off yet: valid only inside the window (rule A); the row is written in this batch
 *     and the provider asked after it commits.
 *   - Open: asked again by the member inside the window, by staff before the deadline; the
 *     provider is read first (one it already ended is recorded as sent), then asked anew (its own
 *     key). Neither the ask nor the deadline moves.
 *   - Lapsed: staff finish it (rule E).
 *   - Ended: nothing to do.
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
  if (existing?.state === "ended") {
    return result("ended", existing.call_outcome === "refused" ? null : existing.call_outcome);
  }
  if (existing?.state === "lapsed") return finishLapsed(ctx, row, existing);
  if (existing) {
    if (FINAL.has(row.state)) throw refuse(row, "ended", null);
    // Taken by the provider: nothing to ask again.
    if (existing.call_outcome === "sent") return result("asked", "sent");
    // A cancel waiting for a person at the gatekeeper: one at a time, for everyone.
    if (await anyWaiting(ctx.db, row.id, ctx.now)) throw waitingRefusal(row);
    if (at(ctx.now) >= at(existing.deadline_at)) {
      throw new ConflictError(
        "This cooling off's time has passed: it lapses, and the membership can be cancelled as usual.",
        { subscription: row.id, rule: "cooling_off", reason: "deadline_passed" },
      );
    }
    // The member asks again only inside the window; staff until the deadline.
    if (caller.kind !== "staff" && at(ctx.now) >= at(existing.window_ends_at)) {
      throw refuse(row, "window_passed", status.until);
    }
    if (await holderUsed(ctx.db, row.holder_person_id, row.id)) throw refuse(row, "used", null);
    const askCount = existing.ask_count + 1;
    ctx.write(
      ctx.db
        .updateTable("core_subscription_cool_off")
        .set({
          call_outcome: null,
          last_asked_at: ctx.now,
          ask_count: askCount,
          updated_at: ctx.now,
        })
        .where("subscription_id", "=", row.id)
        .where("state", "=", "asked")
        .where("ask_count", "=", existing.ask_count),
    );
    return afterCommit(async () => {
      // An ask again reads the provider first: one it already ended (an answer lost) is sent.
      if ((await endedAtProvider(ctx, row)) === true) {
        await recordAsk(ctx, row, { outcome: "sent" }, askCount, false);
        return result("asked", "sent");
      }
      return result("asked", await askToEnd(ctx, row, askCount, false));
    });
  }
  if (!status.offered) throw refuse(row, status.why ?? "not_covered", status.until);
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
      deadline_at: coolOffDeadline(ctx.now),
      last_asked_at: ctx.now,
      ask_count: 1,
      ended_at: null,
      updated_at: ctx.now,
    }),
  );
  return afterCommit(async () => result("asked", await askToEnd(ctx, row, 1, false)));
}

/** Whether a cancel of the cooling off on `id` waits for a person at the gatekeeper now. */
async function anyWaiting(db: Db, id: string, now: string): Promise<boolean> {
  return (await actionsOf(db, [id])).some((a) => waitingNow(a, now));
}

/**
 * Rule E: staff finish a lapsed cooling off. It counts as the member's one (refused when they have
 * used theirs) and owes what was paid on or before the window's end, never anything later; the
 * bookings ahead are released and the summary sent, as an end does. None of that is written until
 * the provider's verified event shows the membership ended (`followCoolOff`, in that event's
 * batch): a membership that has ended already is finished at once; one still running is asked to
 * end now (its own key, `cool-off-finish-<n>`), the request kept on the row (`finish_state`), and
 * the sweep retries it with the same key, waits while its approval waits, and tells admins once if
 * it cannot be done. Staff's ordinary "end it now" works too: its end finishes it the same way.
 */
async function finishLapsed(
  ctx: HandlerContext,
  row: SubscriptionRow,
  own: CoolOffRow,
): Promise<AfterCommit<CooledOff> | CooledOff> {
  if (ctx.principal.kind !== "staff") throw refuse(row, "ended", null);
  if (own.lapsed_because === "used" || (await holderUsed(ctx.db, row.holder_person_id, row.id))) {
    throw refuse(row, "used", null);
  }
  const bounds: OwedBounds = { windowEndsAt: own.window_ends_at, from: null, to: null };
  const owed = await sumOwed(ctx.db, row.id, bounds);
  const out = (state: CooledOff["state"], asked: CooledOff["asked"]): CooledOff => ({
    id: row.id,
    state,
    asked,
    refund: owed,
    currency: row.currency,
  });
  if (FINAL.has(row.state)) {
    // The provider's event has already shown it ended: finished now, in this batch.
    ctx.write(...finishStatements(ctx.db, row, own, row.ended_at ?? ctx.now, ctx.now));
    return out("ended", null);
  }
  if (await anyWaiting(ctx.db, row.id, ctx.now)) throw waitingRefusal(row);
  // Asked and taken by the provider: its event finishes it.
  if (own.finish_state === "sent") return out("lapsed", "sent");
  const askCount = own.ask_count + 1;
  ctx.write(
    ctx.db
      .updateTable("core_subscription_cool_off")
      .set({
        finish_state: "asked",
        finish_asked_at: ctx.now,
        last_asked_at: ctx.now,
        ask_count: askCount,
        updated_at: ctx.now,
      })
      .where("subscription_id", "=", row.id)
      .where("state", "=", "lapsed")
      .where("ask_count", "=", own.ask_count),
  );
  return afterCommit(async () => {
    if ((await endedAtProvider(ctx, row)) === true) {
      await recordAsk(ctx, row, { outcome: "sent" }, askCount, true);
      return out("lapsed", "sent");
    }
    return out("lapsed", await askToEnd(ctx, row, askCount, true));
  });
}

/**
 * What finishing a lapsed one writes once the membership has ended (rule E): the refunds owed for
 * the window's payments (one statement), and the row `ended`, finished, its bookings ahead and its
 * summary due. Each is safe to run again: the refunds are keyed by the order, the row moves from
 * `lapsed` only.
 */
function finishStatements(
  db: Db,
  row: SubscriptionRow,
  own: Pick<CoolOffRow, "window_ends_at">,
  end: string,
  now: string,
) {
  return [
    oweRefundsQuery(db, row.id, { windowEndsAt: own.window_ends_at, from: null, to: null }, now),
    db
      .updateTable("core_subscription_cool_off")
      .set({
        state: "ended",
        finished: 1,
        finish_state: null,
        ended_at: end,
        owed_from: null,
        owed_to: null,
        release_left: 1,
        mail_state: row.email ? "due" : null,
        updated_at: now,
      })
      .where("subscription_id", "=", row.id)
      .where("state", "=", "lapsed"),
  ];
}

/** What a set of bounds owes on a subscription, not refunded yet (one statement). */
async function sumOwed(db: Db, subscriptionId: string, bounds: OwedBounds): Promise<number> {
  const orders = await db
    .selectFrom("core_order as o")
    .select(["o.paid", "o.refunded", PAID_AT.as("paid_at")])
    .where("o.subscription_id", "=", subscriptionId)
    .where("o.paid", ">", 0)
    .execute();
  return orders
    .filter((o) => owedByCoolOff(o.paid_at, bounds))
    .reduce((sum, o) => sum + Math.max(0, Number(o.paid) - Number(o.refunded)), 0);
}

type StuckKind =
  | "refused"
  | "unknown"
  | "pending"
  | "lapsed"
  | "used"
  | "finish"
  | "release"
  | "mail";

/** Tells admins once per subscription and kind, and marks the cooling off as told. */
async function tellAdmins(
  db: Db,
  row: Pick<SubscriptionRow, "id" | "plan_title">,
  kind: StuckKind,
  now: string,
): Promise<void> {
  const what: Record<StuckKind, [string, string]> = {
    refused: [
      "A cooling off was refused by the payment provider",
      "and the payment provider refused to end it. The member may ask again inside the period; staff may ask again (Cooling off) until it lapses.",
    ],
    unknown: [
      "A cooling off was not confirmed by the payment provider",
      "and the payment provider did not answer: it may or may not have ended. The host reads the provider again and asks again until the cooling off's deadline.",
    ],
    pending: [
      "A cooling off is waiting for approval at the payment gatekeeper",
      "and ending it waits for a person to approve it at the payments gatekeeper. Approve it there before the cooling off's deadline, or it lapses.",
    ],
    lapsed: [
      "A cooling off lapsed",
      "and the membership did not end before its deadline (or the waiting cancel was turned down, or it ended before the ask, or the payment provider shows it ended but its event did not arrive within a day of the deadline). Nothing is owed as cooled off. To refund what was paid in the period, finish it on the subscription's page (Cooling off): it then counts as the member's one. Do not refund it by hand from the orders. The membership can now be cancelled as usual.",
    ],
    used: [
      "A cooling off did not count: the member had used theirs",
      "but the member has since cooled off another membership (once per member), so this one does not count. Nothing is owed as cooled off, any cancel of it waiting for approval was turned down, and the membership can be cancelled as usual.",
    ],
    finish: [
      "Finishing a cooling off could not be done",
      "lapsed, and staff asked to finish it, but the payment provider has not ended the membership (it refused, the cancel was turned down at the gatekeeper, or no end was confirmed within a day). Nothing is owed as cooled off yet and it may still be billing. Finish it again from the subscription's page (Cooling off): once the provider confirms the end, the cooling off is finished and the period's payments are owed. A later end of the membership on its own does not finish it.",
    ],
    release: [
      "Bookings ahead of a cooled-off membership were not all cancelled",
      "and the host could not cancel all of the bookings ahead it paid for. Cancel the rest from the member's bookings.",
    ],
    mail: [
      "A cooling off's summary email could not be sent",
      "and the member's email saying their membership ended and its bookings ahead were cancelled could not be sent. Tell the member.",
    ],
  };
  const [title, tail] = what[kind];
  const plan = await notifyStatements(
    db,
    {
      to: [{ role: "admin" }],
      type: "system.message",
      title,
      body: `Subscription ${row.id} (${row.plan_title}) was asked to end in its cooling-off period, ${tail}`,
      link: { kind: "record", object: "subscription", id: row.id },
      dedupeKey: `subscription.cool_off:${kind}:${row.id}`,
      source: { actor: "system" },
    },
    now,
  );
  for (const statement of plan.statements) await db.executeQuery(statement.compile());
  if (kind === "release" || kind === "mail") return;
  await db
    .updateTable("core_subscription_cool_off")
    .set({ told_at: now })
    .where("subscription_id", "=", row.id)
    .where("told_at", "is", null)
    .execute();
}

/**
 * Writes what came of a call, with an audit row of the host's: on an open row (`call_outcome`) or,
 * `finish`, on a lapsed one staff are finishing (`finish_state`). A cancel waiting for a person is
 * kept (`core_subscription_cool_off_action`, by its ask) and never overwritten or forgotten. An
 * open ask unknown or refused tells admins once; a finish refused is stuck, admins told once.
 */
async function recordAsk(
  ctx: Pick<HandlerContext, "db" | "operation" | "now">,
  row: SubscriptionRow,
  answer: { outcome: "sent" | "pending" | "unknown" | "refused"; actionId?: string | null },
  ask: number,
  finish: boolean,
): Promise<void> {
  const { db, now } = ctx;
  if (answer.actionId) {
    await db
      .insertInto("core_subscription_cool_off_action")
      .orIgnore()
      .values({ subscription_id: row.id, action_id: answer.actionId, ask, created_at: now })
      .execute();
  }
  const state = finish
    ? answer.outcome === "refused"
      ? ("stuck" as const)
      : answer.outcome
    : answer.outcome;
  const updated = finish
    ? await db
        .updateTable("core_subscription_cool_off")
        .set({ finish_state: state as Exclude<typeof state, "refused">, updated_at: now })
        .where("subscription_id", "=", row.id)
        .where("state", "=", "lapsed")
        .where("finish_state", "is not", null)
        .executeTakeFirst()
    : await db
        .updateTable("core_subscription_cool_off")
        .set({ call_outcome: answer.outcome, updated_at: now })
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
      input: JSON.stringify({ subscriptionId: row.id, by: ctx.operation ?? null, ask, finish }),
      result: JSON.stringify(
        written
          ? { written: true, outcome: answer.outcome }
          : { written: false, outcome: answer.outcome, why: "the cooling off had moved on" },
      ),
      gate_decision: "auto",
      outcome: "ok",
      error: null,
    })
    .execute();
  if (!written) return;
  if (finish && answer.outcome === "refused") await tellAdmins(db, row, "finish", now);
  if (!finish && (answer.outcome === "unknown" || answer.outcome === "refused")) {
    await tellAdmins(db, row, answer.outcome, now);
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
 * What came of a cancel, from the gatekeeper's typed outcome. A `retryable` failure sent nothing
 * and leaves no approval for anyone to give: `unknown`, so the host reads the provider and asks
 * again with the same key (never `refused`, never `pending`, which means a person must approve).
 */
function cancelOutcome(result: {
  pending: { actionId?: string }[];
  applied: unknown[];
  failed?: { outcome: "refused" | "unknown" | "retryable"; message: string }[];
}): { outcome: "sent" | "pending" | "unknown" | "refused"; actionId: string | null } {
  if (result.applied.length) return { outcome: "sent", actionId: null };
  if (result.pending.length) {
    return { outcome: "pending", actionId: result.pending[0]?.actionId ?? null };
  }
  const failed = result.failed?.[0];
  if (failed?.outcome === "refused") return { outcome: "refused", actionId: null };
  return { outcome: "unknown", actionId: null };
}

/**
 * Asks the provider to end `row` now and writes what came of it. Each ask by a person is a new
 * request with its own idempotency key (`cool-off-<n>`, or `cool-off-finish-<n>` for staff
 * finishing a lapsed one, `n` the row's ask count); the sweep's retry of an ask keeps its key.
 * Staff's ordinary "end it now" keeps the subscription's own key. A refusal is checked against the
 * provider's read first (ended: sent), then stays refused and is told to the caller: an open one
 * stays open (ask again, or it lapses at its deadline); a finish is stuck, admins told.
 */
async function askToEnd(
  ctx: Pick<HandlerContext, "db" | "integrations" | "operation" | "now">,
  row: SubscriptionRow,
  ask: number,
  finish: boolean,
): Promise<"sent" | "pending" | "unknown"> {
  const target = await paymentsTarget(ctx.db);
  if (target.provider !== row.provider) {
    await recordAsk(ctx, row, { outcome: "refused" }, ask, finish);
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
      reason: finish ? "Cooling off, finished by staff" : "Cooling off",
      askKey: finish ? `cool-off-finish-${ask}` : `cool-off-${ask}`,
    });
  } catch {
    // The call itself failed: it may have been submitted before the answer was lost.
    await recordAsk(ctx, row, { outcome: "unknown" }, ask, finish);
    return "unknown";
  }
  let got = cancelOutcome(answer as Parameters<typeof cancelOutcome>[0]);
  if (got.outcome === "refused" && (await endedAtProvider(ctx, row)) === true) {
    got = { outcome: "sent", actionId: null };
  }
  await recordAsk(ctx, row, got, ask, finish);
  if (got.outcome === "refused") {
    throw new ConflictError(
      finish
        ? "The payment provider did not end this membership, so it is not finished. End it " +
            "from the subscription's page; the cooling off is finished once the provider confirms."
        : "The payment provider did not end your membership, so nothing changed. Try again; the " +
            "business has been told.",
      { subscription: row.id, rule: "provider_refused" },
    );
  }
  return got.outcome;
}

/** Writes a refund owed for each order `bounds` owes, in one statement keyed by the order. */
function oweRefunds(ctx: HandlerContext, subscriptionId: string, bounds: OwedBounds): void {
  ctx.write(oweRefundsQuery(ctx.db, subscriptionId, bounds, ctx.now));
}

/** The one statement that owes the refunds `bounds` owe (insert or ignore, keyed by the order). */
function oweRefundsQuery(db: Db, subscriptionId: string, bounds: OwedBounds, now: string) {
  const reason = "A membership ended in its cooling-off period: a full refund";
  const inWindow = sql<boolean>`${PAID_AT} <= ${bounds.windowEndsAt}`;
  const after =
    bounds.from === null || bounds.to === null
      ? sql<boolean>`0`
      : sql<boolean>`(${PAID_AT} > ${bounds.from} AND ${PAID_AT} <= ${bounds.to})`;
  return db
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
      db
        .selectFrom("core_order as o")
        .where("o.subscription_id", "=", subscriptionId)
        .where(sql<boolean>`o.paid > o.refunded`)
        .where(sql<boolean>`(${inWindow} OR ${after})`)
        .select([
          sql<string>`'rdu_' || substr(o.id, instr(o.id, '_') + 1)`.as("id"),
          "o.id as order_id",
          sql<string>`'subscription'`.as("object_type"),
          sql<string>`${subscriptionId}`.as("record_id"),
          sql<string>`${COOLED_OFF}`.as("entered"),
          sql<string>`${reason}`.as("reason"),
          sql<string>`'due'`.as("state"),
          sql<number>`0`.as("attempt"),
          sql<string>`${now}`.as("created_at"),
          sql<string>`${now}`.as("updated_at"),
        ]),
    );
}

/**
 * In the batch of every verified event of a subscription with a cooling off (events.ts), once the
 * provider shows it ended. Only an open one is judged (rule B): an end inside its bounds is its
 * end, the refunds are owed by rule C in one statement, the bookings ahead are left to the release
 * step (never this batch), the summary is due and admins are told once; one outside them lapses.
 * The member's cooling off is checked before anything is written (rule F): one already used, and
 * this one lapses as not counted. Nothing written here can fail the end's batch. An ended one,
 * or a lapsed one staff have not asked to finish, is never changed by a later event; a lapsed one
 * staff asked to finish (rule E) is finished by it.
 */
export async function followCoolOff(ctx: HandlerContext, row: SubscriptionRow): Promise<void> {
  if (!FINAL.has(row.state)) return;
  const own = await ctx.db
    .selectFrom("core_subscription_cool_off")
    .selectAll()
    .where("subscription_id", "=", row.id)
    .executeTakeFirst();
  if (!own) return;
  const tell = async (kind: StuckKind | "cooled_off" | "finished", title: string, body: string) => {
    const plan = await notifyStatements(
      ctx.db,
      {
        to: [{ role: "admin" }],
        type: "system.message",
        title,
        body,
        link: { kind: "record", object: "subscription", id: row.id },
        dedupeKey: `subscription.cool_off:${kind}:${row.id}`,
        source: { actor: "system" },
      },
      ctx.now,
    );
    ctx.write(...plan.statements);
  };
  if (own.state === "lapsed") {
    // Only a finish still under way: a stuck one (admins told) is not finished by a later end,
    // months on, until staff finish it again.
    if (own.finish_state === null || own.finish_state === "stuck") return;
    const end = row.ended_at ?? ctx.now;
    if (await holderUsed(ctx.db, row.holder_person_id, row.id)) {
      ctx.write(
        ctx.db
          .updateTable("core_subscription_cool_off")
          .set({ finish_state: "stuck", lapsed_because: "used", updated_at: ctx.now })
          .where("subscription_id", "=", row.id)
          .where("state", "=", "lapsed"),
      );
      await tell(
        "used",
        "A cooling off did not count: the member had used theirs",
        `Subscription ${row.id} (${row.plan_title}) has ended, but its lapsed cooling off ` +
          "cannot be finished: the member has already cooled off another membership (once " +
          "per member). Nothing is owed as cooled off; the end is recorded as any end.",
      );
      return;
    }
    ctx.write(...finishStatements(ctx.db, row, own, end, ctx.now));
    const owed = await sumOwed(ctx.db, row.id, {
      windowEndsAt: own.window_ends_at,
      from: null,
      to: null,
    });
    await tell(
      "finished",
      "A cooling off was finished",
      `Subscription ${row.id} (${row.plan_title}) has ended, and its lapsed cooling off is ` +
        `finished as staff asked: what was paid in the period (${formatMoney(owed, row.currency)}) ` +
        "is owed back, each refund waiting in Approvals for a person who may refund. The " +
        "bookings ahead it paid for are being cancelled by the business.",
    );
    return;
  }
  if (own.state === "ended") {
    // The same formula by the bounds kept when it ended (rule C): a payment recorded later is owed
    // only if it was paid within them, so a later event adds nothing the rule did not owe.
    oweRefunds(ctx, row.id, {
      windowEndsAt: own.window_ends_at,
      from: own.owed_from,
      to: own.owed_to,
    });
    return;
  }
  const end = row.ended_at ?? ctx.now;
  const lapse = (because: "end_time" | "used") =>
    ctx.write(
      ctx.db
        .updateTable("core_subscription_cool_off")
        .set({ state: "lapsed", lapsed_because: because, ended_at: end, updated_at: ctx.now })
        .where("subscription_id", "=", row.id)
        .where("state", "=", "asked"),
    );
  if (!endIsCoolOffs(own, end)) {
    lapse("end_time");
    await tell(
      "lapsed",
      "A cooling off lapsed: the membership ended outside it",
      `Subscription ${row.id} (${row.plan_title}) ended outside its cooling off (before the ask or ` +
        "after its deadline). Nothing is owed as cooled off. To refund what was paid in the " +
        "period, finish it on the subscription's page (Cooling off): it then counts as the " +
        "member's one. Do not refund it by hand from the orders.",
    );
    return;
  }
  if (await holderUsed(ctx.db, row.holder_person_id, row.id)) {
    lapse("used");
    await tell(
      "used",
      "A cooling off did not count: the member had used theirs",
      `Subscription ${row.id} (${row.plan_title}) ended while a cooling off was open on it, and the ` +
        "member has already cooled off another membership (once per member). Nothing is owed as " +
        "cooled off; the end is recorded as any end.",
    );
    return;
  }
  const bounds: OwedBounds = { windowEndsAt: own.window_ends_at, from: own.asked_at, to: end };
  oweRefunds(ctx, row.id, bounds);
  ctx.write(
    ctx.db
      .updateTable("core_subscription_cool_off")
      .set({
        state: "ended",
        ended_at: end,
        owed_from: own.asked_at,
        owed_to: end,
        release_left: 1,
        mail_state: row.email ? "due" : null,
        updated_at: ctx.now,
      })
      .where("subscription_id", "=", row.id)
      .where("state", "=", "asked"),
  );
  const owed = await sumOwed(ctx.db, row.id, bounds);
  await tell(
    "cooled_off",
    "A membership ended in its cooling-off period",
    `Subscription ${row.id} (${row.plan_title}) ended in its ${own.days}-day cooling-off period. ` +
      `A full refund of what was paid (${formatMoney(owed, row.currency)}) is owed: each paid ` +
      "period's refund waits in Approvals for a person who may refund. The bookings ahead it paid " +
      "for are being cancelled by the business, their places freed.",
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
 * The bookings ahead a cooled-off membership paid for (the owner's decision 1), at most `limit`
 * in this batch, ordered by when they are: each record that spent a use of the subscription's
 * granted holder, not given back, whose time is ahead, still in a state it spends in (booked); and
 * each of the holder's Person's own places on a waiting list for a class ahead that it would pay
 * for (naming it, or naming nothing when they hold nothing else live). Each is moved by the host
 * into its object's `released` state (Bookings' `cancelled_by_us`). `left` counts only what could
 * be released, so a step always ends.
 */
async function releaseBookingsAhead(
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
  // biome-ignore lint/suspicious/noExplicitAny: extension views are not in the typed schema.
  const db = ctx.db as Kysely<any>;
  // Which candidates could be released: each still in a state the host moves out of into
  // `released`, and one it spends in (booked) or its waiting state.
  const releasableOf = async (
    candidates: { type: string; id: string; time: string }[],
  ): Promise<{ type: string; id: string; time: string }[]> => {
    const byType = new Map<string, string[]>();
    for (const c of candidates) byType.set(c.type, [...(byType.get(c.type) ?? []), c.id]);
    const states = new Map<string, string | null>();
    for (const [type, ids] of byType) {
      const object = getObject(type);
      const cols = object ? spenderColumns(object) : null;
      if (!object || !cols) continue;
      for (const part of chunk(ids, CHUNK)) {
        const got = (await db
          .selectFrom(visibleSource(orgReader(ctx.db), object))
          .select(["id", `${cols.state} as state`])
          .where("id", "in", part)
          .execute()) as { id: string; state: string | null }[];
        for (const g of got) states.set(`${type}:${g.id}`, g.state);
      }
    }
    return candidates.filter((c) => {
      const object = getObject(c.type);
      const cols = object ? spenderColumns(object) : null;
      const s = states.get(`${c.type}:${c.id}`) ?? null;
      if (!cols || !s || !cols.hostMovesFrom(s)) return false;
      return cols.allowance.spendIn.includes(s) || s === cols.waiting;
    });
  };
  const releasable: { type: string; id: string; time: string }[] = [];
  // The uses it paid for, ahead, by time: page by page until more than a step's worth is found,
  // so what cannot be released never stops it reaching those after.
  let cursor: { at: string; id: string } | null = null;
  let morePages = false;
  for (let page = 0; page < RELEASE_PAGES && releasable.length <= limit; page += 1) {
    const after: { at: string; id: string } | null = cursor;
    let query = ctx.db
      .selectFrom("core_allowance_use")
      .select(["spender_type", "spender_id", "at"])
      .where("object_type", "=", grant.object_type)
      .where("record_id", "=", grant.record_id)
      .where("returned_at", "is", null)
      .where("at", ">", ctx.now);
    if (after) {
      query = query.where((eb) =>
        eb.or([
          eb("at", ">", after.at),
          eb.and([eb("at", "=", after.at), eb("spender_id", ">", after.id)]),
        ]),
      );
    }
    const uses = await query.orderBy("at").orderBy("spender_id").limit(RELEASE_PAGE).execute();
    releasable.push(
      ...(await releasableOf(
        uses.map((u) => ({ type: u.spender_type, id: u.spender_id, time: u.at })),
      )),
    );
    const last = uses.at(-1);
    morePages = !!last && uses.length === RELEASE_PAGE;
    if (!last || !morePages) break;
    cursor = { at: last.at, id: last.spender_id };
  }
  // The holder's Person's own waiting places it would pay for, for classes ahead: one naming this
  // membership, or one naming nothing when they hold nothing else live. All of them are read (a
  // person's waiting places are few); those for classes started or past are left alone.
  const holderObject = getObject(grant.object_type);
  const person = row.holder_person_id;
  if (person && holderObject?.allowance?.kind === "holder") {
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
      // The spender's time, one relation away (`class.startsAt`).
      const [relName, timeName] = (cols.allowance.at ?? "").split(".");
      const rel = object.fields.find((f) => f.name === relName);
      const relCol = rel ? viewColumnOf(rel) : null;
      const target = rel?.options?.to ? getObject(rel.options.to) : undefined;
      const timeField = target?.fields.find((f) => f.name === timeName);
      const timeCol = timeField ? viewColumnOf(timeField) : null;
      if (!relCol || !target || !timeCol) continue;
      const waiting = (await db
        .selectFrom(visibleSource(orgReader(ctx.db), object))
        .select(["id", `${relCol} as rel`, ...(cols.holder ? [`${cols.holder} as holder`] : [])])
        .where(cols.person, "=", person)
        .where(cols.state, "=", cols.waiting)
        .execute()) as { id: string; rel: string | null; holder?: string | null }[];
      const payable = waiting.filter((w) =>
        w.holder ? w.holder === grant.record_id : others.length === 0,
      );
      const relIds = [...new Set(payable.map((w) => w.rel).filter((r): r is string => !!r))];
      const times = new Map<string, string | null>();
      for (const part of chunk(relIds, CHUNK)) {
        const got = (await db
          .selectFrom(visibleSource(orgReader(ctx.db), target))
          .select(["id", `${timeCol} as time`])
          .where("id", "in", part)
          .execute()) as { id: string; time: string | null }[];
        for (const g of got) times.set(g.id, g.time);
      }
      const ahead: { type: string; id: string; time: string }[] = [];
      for (const w of payable) {
        const time = w.rel ? times.get(w.rel) : null;
        if (time && at(time) > at(ctx.now)) ahead.push({ type: object.name, id: w.id, time });
      }
      releasable.push(...(await releasableOf(ahead)));
    }
  }
  // By class start, the earliest first.
  releasable.sort((a, b) => at(a.time) - at(b.time));
  let released = 0;
  for (const r of releasable.slice(0, limit)) {
    const object = getObject(r.type);
    const cols = object ? spenderColumns(object) : null;
    if (!cols) continue;
    await updateRecordAsHost(ctx, r.type, r.id, { [cols.stateField]: cols.into });
    released += 1;
  }
  // Left: more found than this step moves, or pages unread after a step that moved some (each
  // step releases at least one or ends, so the follow-ups always end).
  return { released, left: releasable.length > limit || (morePages && released > 0) };
}

/**
 * `subscription.coolOffRelease { id }` (a host step, its own batch): the next
 * `COOL_OFF_RELEASE_STEP` bookings ahead of a cooled-off membership, until none is left.
 * Idempotent: what is released is not found again.
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
  const out = await releaseBookingsAhead(ctx, row, COOL_OFF_RELEASE_STEP);
  ctx.write(
    ctx.db
      .updateTable("core_subscription_cool_off")
      .set({
        release_left: out.left ? 1 : 0,
        released_count: Number(own.released_count) + out.released,
        // A step that succeeds clears the failures before it: only three in a row stop it.
        release_failures: 0,
        updated_at: ctx.now,
      })
      .where("subscription_id", "=", id)
      .where("release_left", "=", 1),
  );
  return out;
}

/** The sweep's result. */
export interface CoolOffSweep {
  resolved: number;
  asked: number;
  told: number;
  unread: number;
  lapsed: number;
  mailed: number;
}

/**
 * The minute cron's sweep (`subscription.coolOffSweep`, a host step) over open cooling offs and
 * lapsed ones staff are finishing, at most `COOL_OFF_SWEEP_BATCH` of each a tick:
 *   - its holder has since used theirs on another membership (rule F): it lapses as used;
 *   - past its deadline, or its latest cancel turned down or expired at the gatekeeper with none
 *     still waiting (rule D): the provider's read first; one it shows ended (or unread) is left
 *     for its event until a day after the deadline; otherwise it lapses, every cancel still
 *     waiting is rejected, and admins are told once;
 *   - waiting over `COOL_OFF_PENDING_AFTER_MS`: admins are told once;
 *   - its answer lost (`unknown`) or never made (null): the provider's read (ended: sent); else
 *     asked again (the same ask, the same key) at most every `RETRY_EVERY_MS` until the deadline;
 *   - refused: left for the member or staff to ask again, or the deadline;
 *   - a finish (rule E): see `sweepFinish`.
 * Then the member's summary emails.
 */
export async function sweepCoolOffs(
  ctx: Pick<HandlerContext, "db" | "integrations" | "operation" | "now" | "user">,
): Promise<CoolOffSweep> {
  const out: CoolOffSweep = { resolved: 0, asked: 0, told: 0, unread: 0, lapsed: 0, mailed: 0 };
  const due = await dueOpen(ctx.db, ctx.now);
  const finishing = await dueFinish(ctx.db, ctx.now);
  const actions = await actionsOf(ctx.db, [
    ...due.map((d) => d.subscription_id),
    ...finishing.map((f) => f.subscription_id),
  ]);
  for (const own of due) {
    const row = await loadSubscriptionRow(ctx.db, own.subscription_id);
    const touch = () =>
      ctx.db
        .updateTable("core_subscription_cool_off")
        .set({ updated_at: ctx.now })
        .where("subscription_id", "=", own.subscription_id)
        .where("state", "=", "asked")
        .execute();
    const mine = actions.filter((a) => a.subscription_id === own.subscription_id);
    const waiting = mine.filter((a) => waitingNow(a, ctx.now));
    if (await holderUsed(ctx.db, row.holder_person_id, row.id)) {
      await lapseOpen(ctx, row, own, "used", mine);
      out.lapsed += 1;
      continue;
    }
    const latest = mine.filter((a) => a.ask === own.ask_count);
    const turnedDown =
      own.call_outcome === "pending" &&
      waiting.length === 0 &&
      latest.length > 0 &&
      !latest.some(appliedAction);
    const pastDeadline = at(ctx.now) >= at(own.deadline_at);
    if (pastDeadline || turnedDown) {
      const ended = FINAL.has(row.state) ? true : await endedAtProvider(ctx, row);
      if (ended !== false && at(ctx.now) < at(own.deadline_at) + DAY) {
        // Ended at the provider: its verified event says whether before the deadline. Unread: a
        // tick later. Either way a day after the deadline at most.
        await touch();
        out.unread += ended === null ? 1 : 0;
        continue;
      }
      await lapseOpen(ctx, row, own, pastDeadline ? "deadline" : "action", mine);
      out.lapsed += 1;
      continue;
    }
    if (own.call_outcome === "pending") {
      if (
        own.told_at === null &&
        at(ctx.now) - at(own.last_asked_at) >= COOL_OFF_PENDING_AFTER_MS
      ) {
        await tellAdmins(ctx.db, row, "pending", ctx.now);
        out.told += 1;
      }
      await touch();
      continue;
    }
    if (own.call_outcome === null || own.call_outcome === "unknown") {
      const ended = FINAL.has(row.state) ? true : await endedAtProvider(ctx, row);
      if (ended === null) {
        await touch();
        out.unread += 1;
        continue;
      }
      if (ended) {
        await recordAsk(ctx, row, { outcome: "sent" }, own.ask_count, false);
        out.resolved += 1;
        continue;
      }
      if (own.call_outcome === null || at(ctx.now) - at(own.last_asked_at) >= RETRY_EVERY_MS) {
        await retried(ctx, own.subscription_id, "asked");
        await askToEnd(ctx, row, own.ask_count, false).catch(() => undefined);
        out.asked += 1;
        continue;
      }
    }
    await touch();
  }
  for (const own of finishing) {
    const mine = actions.filter((a) => a.subscription_id === own.subscription_id);
    const did = await sweepFinish(ctx, own, mine);
    if (did === "asked") out.asked += 1;
    if (did === "told") out.told += 1;
    if (did === "unread") out.unread += 1;
  }
  out.mailed = await sendSummaries(ctx);
  return out;
}

/** Marks a retry of an ask (or a finish): its time is the latest ask's, so it waits an hour. */
async function retried(
  ctx: Pick<HandlerContext, "db" | "now">,
  id: string,
  state: "asked" | "lapsed",
): Promise<void> {
  await ctx.db
    .updateTable("core_subscription_cool_off")
    .set({ last_asked_at: ctx.now, updated_at: ctx.now })
    .where("subscription_id", "=", id)
    .where("state", "=", state)
    .execute();
}

/**
 * The sweep's step for a lapsed cooling off staff are finishing (rule E), not yet ended by the
 * provider's event (that event's batch finishes it, `followCoolOff`):
 *   - the membership has ended here (the event came before the request committed): finished now;
 *   - a cancel of it waiting for a person: left to wait;
 *   - its latest cancel turned down or expired at the gatekeeper: stuck, admins told once;
 *   - the provider shows it ended: sent, left for its event;
 *   - not ended: asked again with the same key at most every `RETRY_EVERY_MS`;
 *   - not confirmed a day after it was asked (or its cancel approved): stuck, admins told once.
 * A stuck one is not visited again, and a later end does not finish it: staff finish it again
 * (a membership that has ended by then is finished at once).
 */
async function sweepFinish(
  ctx: Pick<HandlerContext, "db" | "integrations" | "operation" | "now">,
  own: CoolOffRow,
  mine: CoolOffAction[],
): Promise<"asked" | "told" | "unread" | "waited"> {
  const row = await loadSubscriptionRow(ctx.db, own.subscription_id);
  const touch = (finish_state?: "sent") =>
    ctx.db
      .updateTable("core_subscription_cool_off")
      .set({ ...(finish_state ? { finish_state } : {}), updated_at: ctx.now })
      .where("subscription_id", "=", own.subscription_id)
      .where("state", "=", "lapsed")
      .execute();
  const stuck = async () => {
    const updated = await ctx.db
      .updateTable("core_subscription_cool_off")
      .set({ finish_state: "stuck", updated_at: ctx.now })
      .where("subscription_id", "=", own.subscription_id)
      .where("state", "=", "lapsed")
      .where("finish_state", "in", ["asked", "sent", "pending", "unknown"])
      .executeTakeFirst();
    if (Number(updated.numUpdatedRows ?? 0) === 1) {
      await tellAdmins(ctx.db, row, "finish", ctx.now);
    }
    return "told" as const;
  };
  if (FINAL.has(row.state)) {
    if (await holderUsed(ctx.db, row.holder_person_id, row.id)) return stuck();
    for (const q of finishStatements(ctx.db, row, own, row.ended_at ?? ctx.now, ctx.now)) {
      await q.execute();
    }
    return "waited";
  }
  if (mine.some((a) => waitingNow(a, ctx.now))) {
    await touch();
    return "waited";
  }
  const latest = mine.filter((a) => a.ask === own.ask_count);
  if (own.finish_state === "pending" && latest.length > 0 && !latest.some(appliedAction)) {
    return stuck();
  }
  // A day from the request, or from its approval.
  const since = Math.max(
    at(own.finish_asked_at ?? own.updated_at),
    ...latest.filter(appliedAction).map((a) => (a.decided_at ? at(a.decided_at) : 0)),
  );
  const overdue = at(ctx.now) >= since + DAY;
  const ended = await endedAtProvider(ctx, row);
  if (ended !== false) {
    if (overdue) return stuck();
    await touch(ended === true ? "sent" : undefined);
    return ended === null ? "unread" : "waited";
  }
  if (overdue) return stuck();
  if (own.finish_state === "asked" || at(ctx.now) - at(own.last_asked_at) >= RETRY_EVERY_MS) {
    await retried(ctx, own.subscription_id, "lapsed");
    await askToEnd(ctx, row, own.ask_count, true).catch(() => undefined);
    return "asked";
  }
  await touch();
  return "waited";
}

/**
 * Rule D (and F): an open cooling off lapses, every cancel of it still waiting at the gatekeeper is
 * rejected, and admins are told once.
 */
async function lapseOpen(
  ctx: Pick<HandlerContext, "db" | "integrations" | "now" | "user">,
  row: SubscriptionRow,
  own: CoolOffRow,
  because: "deadline" | "action" | "used",
  actions: CoolOffAction[],
): Promise<void> {
  const updated = await ctx.db
    .updateTable("core_subscription_cool_off")
    .set({ state: "lapsed", lapsed_because: because, updated_at: ctx.now })
    .where("subscription_id", "=", own.subscription_id)
    .where("state", "=", "asked")
    .executeTakeFirst();
  if (Number(updated.numUpdatedRows ?? 0) !== 1) return;
  const waiting = actions.filter((a) => a.status === "pending");
  for (const action of waiting) {
    await ctx.db
      .updateTable("core_pending_action")
      .set({
        status: "rejected",
        status_reason:
          because === "used"
            ? "Rejected: the member has used their cooling off on another membership"
            : "Rejected: its cooling off lapsed",
        decided_at: ctx.now,
        decided_by: ctx.user.id,
      })
      .where("id", "=", action.action_id)
      .where("status", "=", "pending")
      .execute();
  }
  if (waiting.length) {
    await rejectOnFacets(
      ctx.integrations,
      waiting.map((a) => ({
        id: a.action_id,
        connection_id: a.connection_id,
        facet_key: a.facet_key,
        gk_action: a.gk_action,
      })),
    );
  }
  await tellAdmins(ctx.db, row, because === "used" ? "used" : "lapsed", ctx.now);
}

/**
 * The open cooling offs the sweep looks at now (one indexed read): past the deadline, waiting at
 * the gatekeeper, an answer lost or never made, or a holder who has since used theirs. Each is
 * looked at once in `COOL_OFF_SWEEP_AFTER_MS` (touched when looked at), except one waiting at the
 * gatekeeper, so a turned-down cancel lapses it on the next tick.
 */
async function dueOpen(db: Db, now: string) {
  const lost = iso(at(now) - COOL_OFF_SWEEP_AFTER_MS);
  return db
    .selectFrom("core_subscription_cool_off as c")
    .selectAll("c")
    .where("c.state", "=", "asked")
    .where((eb) =>
      eb.or([
        eb("c.call_outcome", "=", "pending"),
        eb.and([
          eb("c.updated_at", "<", lost),
          eb.or([
            eb("c.deadline_at", "<=", now),
            eb("c.call_outcome", "is", null),
            eb("c.call_outcome", "=", "unknown"),
            eb.exists(
              eb
                .selectFrom("core_subscription_cool_off as u")
                .select("u.subscription_id")
                .whereRef("u.holder_person_id", "=", "c.holder_person_id")
                .where("u.state", "=", "ended")
                .whereRef("u.subscription_id", "!=", "c.subscription_id"),
            ),
          ]),
        ]),
      ]),
    )
    .orderBy("c.updated_at")
    .limit(COOL_OFF_SWEEP_BATCH)
    .execute();
}

/** The lapsed cooling offs staff are finishing that the sweep looks at now (one indexed read). */
async function dueFinish(db: Db, now: string) {
  const lost = iso(at(now) - COOL_OFF_SWEEP_AFTER_MS);
  return (
    db
      .selectFrom("core_subscription_cool_off")
      .selectAll()
      // Written out, not bound: SQLite uses a partial index only for its own predicate, literally
      // (core_subscription_cool_off_finish_idx); bound values scan the table every minute.
      .where(
        sql<boolean>`state = 'lapsed' AND finish_state IN ('asked', 'sent', 'pending', 'unknown')`,
      )
      .where((eb) => eb.or([eb("finish_state", "=", "pending"), eb("updated_at", "<", lost)]))
      .orderBy("updated_at")
      .limit(COOL_OFF_SWEEP_BATCH)
      .execute()
  );
}

/** Whether the minute cron has anything to do (cheap reads), so an idle tick invokes nothing. */
async function anythingDue(db: Db, now: string): Promise<boolean> {
  // The follow-ups as two reads, each of its own partial index: one read with an OR, or with
  // bound values, scans the whole table.
  const followUp = (where: RawBuilder<boolean>) =>
    db
      .selectFrom("core_subscription_cool_off")
      .select("subscription_id")
      .where(where)
      .limit(1)
      .execute();
  const [open, finishing, release, mail] = await Promise.all([
    dueOpen(db, now),
    dueFinish(db, now),
    followUp(sql<boolean>`release_left = 1`),
    followUp(sql<boolean>`mail_state IN ('due', 'sending')`),
  ]);
  return open.length > 0 || finishing.length > 0 || release.length > 0 || mail.length > 0;
}

/**
 * The member's one email (the owner's decision 1): their membership ended in its cooling-off
 * period, how many bookings ahead it paid for were cancelled with it, and that the refund is owed.
 * Host mail through the email channel an admin chose, as an order's confirmation goes; its
 * approval rules apply (a `pending` answer is recorded so, not as sent). It is claimed before it
 * is sent, with an idempotency key, so a crash after the claim is tried again once with the same
 * key and sends nothing twice; one that cannot be sent is `failed` and admins are told once.
 */
async function sendSummaries(
  ctx: Pick<HandlerContext, "db" | "integrations" | "now">,
): Promise<number> {
  const stuck = iso(at(ctx.now) - MAIL_STUCK_MS);
  const due = await ctx.db
    .selectFrom("core_subscription_cool_off")
    .select([
      "subscription_id",
      "released_count",
      "release_stopped",
      "mail_state",
      "mail_tries",
      "mail_claimed_at",
    ])
    .where((eb) =>
      eb.or([
        eb.and([eb("mail_state", "=", "due"), eb("release_left", "=", 0)]),
        eb.and([eb("mail_state", "=", "sending"), eb("mail_claimed_at", "<", stuck)]),
      ]),
    )
    .limit(COOL_OFF_SWEEP_BATCH)
    .execute();
  let mailed = 0;
  for (const own of due) {
    const row = await loadSubscriptionRow(ctx.db, own.subscription_id);
    const settle = (state: "sent" | "pending" | "failed") =>
      ctx.db
        .updateTable("core_subscription_cool_off")
        .set({ mail_state: state, updated_at: ctx.now })
        .where("subscription_id", "=", own.subscription_id)
        .where("mail_state", "=", "sending")
        .execute();
    if (own.mail_state === "sending" && Number(own.mail_tries) >= 2) {
      await ctx.db
        .updateTable("core_subscription_cool_off")
        .set({ mail_state: "failed", updated_at: ctx.now })
        .where("subscription_id", "=", own.subscription_id)
        .execute();
      await tellAdmins(ctx.db, row, "mail", ctx.now);
      continue;
    }
    const claimed = await ctx.db
      .updateTable("core_subscription_cool_off")
      .set({
        mail_state: "sending",
        mail_claimed_at: ctx.now,
        mail_tries: Number(own.mail_tries) + 1,
        updated_at: ctx.now,
      })
      .where("subscription_id", "=", own.subscription_id)
      .where("mail_state", "=", own.mail_state)
      .where("mail_tries", "=", Number(own.mail_tries))
      .executeTakeFirst();
    if (Number(claimed.numUpdatedRows ?? 0) !== 1) continue;
    try {
      const settings = await loadDeliverySettings(ctx.db);
      const resolved =
        row.email && settings.email
          ? await resolveChannelTarget(ctx.db, "email", settings.email)
          : null;
      if (!row.email || !resolved || "problem" in resolved) {
        await settle("failed");
        await tellAdmins(ctx.db, row, "mail", ctx.now);
        continue;
      }
      const count = Number(own.released_count);
      const stopped = Number(own.release_stopped) === 1;
      const result = await sendHostEmail(ctx.integrations, resolved.target, {
        to: row.email,
        subject: "Your membership has ended in its cooling-off period",
        text: [
          `Your membership (${row.plan_title}) has ended in its cooling-off period.`,
          "",
          count
            ? `${count} ${count === 1 ? "booking" : "bookings"} for classes ahead that it paid for ${count === 1 ? "was" : "were"} cancelled with it, and the places given back.${stopped ? " The business will cancel any others." : ""}`
            : stopped
              ? "The business will cancel the bookings ahead that it paid for."
              : "No bookings ahead were paid for by it.",
          "",
          "A refund of what you paid in the cooling-off period is owed: the business approves it, then it goes back to how you paid.",
        ].join("\n"),
        idempotencyKey: `cool-off-summary:${row.id}`,
      });
      await settle(result.pending.length ? "pending" : "sent");
      mailed += 1;
    } catch {
      // Left `sending`: tried again once after MAIL_STUCK_MS with the same key, then failed.
    }
  }
  return mailed;
}

export interface CoolOffSweepOptions {
  integrations?: IntegrationRuntime | undefined;
  floor?: GateFloor | undefined;
  events?: EventSink | undefined;
  clock?: (() => Date) | undefined;
}

/**
 * The minute cron's step: nothing when nothing is due (cheap reads, no operation, no audit row);
 * else at most one `subscription.coolOffRelease` (the cooled-off membership whose bookings ahead
 * have waited longest), then `subscription.coolOffSweep`. One release step a tick keeps the whole
 * scheduled invocation, beside the minute's other work, far under D1's 1,000 statements: a step
 * is bounded (`COOL_OFF_RELEASE_STEP` bookings), and the sweep is bounded (`COOL_OFF_SWEEP_BATCH`
 * of each kind). A release step that fails `RELEASE_FAILURES_MAX` times in a row tells admins and
 * stops (the summary then says the business will cancel the rest).
 */
export async function runCoolOffSweep(
  crm: CrmDb,
  { integrations, floor, events, clock }: CoolOffSweepOptions = {},
): Promise<CoolOffSweep & { releases: number }> {
  const now = (clock?.() ?? new Date()).toISOString();
  const idle = { resolved: 0, asked: 0, told: 0, unread: 0, lapsed: 0, mailed: 0, releases: 0 };
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
    .orderBy("updated_at")
    .limit(COOL_OFF_RELEASES_A_TICK)
    .execute();
  let releases = 0;
  for (const own of left) {
    try {
      await invokeByName("subscription.coolOffRelease", { id: own.subscription_id }, host);
      releases += 1;
    } catch {
      const failures = Number(own.release_failures) + 1;
      const stop = failures >= RELEASE_FAILURES_MAX;
      await crm.query
        .updateTable("core_subscription_cool_off")
        .set({
          release_failures: failures,
          ...(stop ? { release_left: 0, release_stopped: 1 } : {}),
          updated_at: now,
        })
        .where("subscription_id", "=", own.subscription_id)
        .execute();
      if (stop) {
        const row = await loadSubscriptionRow(crm.query, own.subscription_id);
        await tellAdmins(crm.query, row, "release", now);
      }
    }
  }
  const swept = (await invokeByName("subscription.coolOffSweep", {}, host)) as CoolOffSweep;
  return { ...swept, releases };
}
