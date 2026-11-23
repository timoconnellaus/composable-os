// Cooling off (stage 44 step 7, decision 11, ADR 0647). A business may set a cooling-off period:
// whole days, 0 off (the default). A new member may end their membership within it for a full
// refund of what they paid; each refund is owed (core_sellable_refund_due) and asked of the
// payments gatekeeper by the minute cron, where it waits for a person with `orders:refund` like
// every refund (ADR 0429). Nothing here charges or refunds a card on its own (ADR 0485).
//
// Who it covers (decisions 16 and 17, and the coordinator's reading where the spec is silent):
//   - a subscription to a plan whose pack declares `sellable.recurring.coolingOff` (Memberships'
//     plans; never a pass, never a course plan), started here by `subscription.start` without a
//     continuation offer (a new member, not one moving over);
//   - within the window: from the moment the provider confirmed it (the host's record, made by
//     the verified event) to the end of the last local day in the business's time zone, the
//     start's day being day 0. A clock change moves nothing: the end is a local midnight. A plan
//     change, a pause or an agreement accepted again never moves it (none makes a new
//     subscription);
//   - the days are the longer of the setting when the subscription was started (kept on its
//     checkout) and the setting now: shortening or turning it off never shortens a window;
//   - once per holder: a member who cooled off one membership cannot cool off another (held by
//     the database, migration 0856);
//   - something paid: in a free trial nothing is owed back, and the member's ordinary cancel ends
//     it with the trial at no charge (the button says "cancel").
//
// What it does: ends the subscription at the provider now (the gatekeeper's `cancelSubscription`,
// as staff's "end it now" does), asked after the operation's batch commits the cooling off's row,
// so a retry finds the row and asks again. In the batch of the provider's verified event that
// shows it ended, every paid order of the subscription is owed back in full (`followCoolOff`); one
// paid later is owed back the same way. What was used is kept: classes taken stay taken (decision
// 16); bookings ahead and what the membership gives follow a membership ended at once.
import type { CoreSubscriptionCoolOffTable } from "@composable-os/db";
import { type Selectable, sql } from "kysely";
import { ConflictError, NotFoundError, ValidationError } from "../errors.ts";
import { getObject } from "../fields/index.ts";
import { newId } from "../ids.ts";
import { notifyStatements } from "../notifications/send.ts";
import { type AfterCommit, afterCommit, type HandlerContext } from "../operation.ts";
import { callSubscriptionGatekeeper, paymentsTarget } from "../orders/gateway.ts";
import { formatMoney } from "../orders/orders.ts";
import { extensionSettingValues } from "../records/windows.ts";
import { loadGeneralSettings } from "../settings.ts";
import { addLocalDays, localParts, wallClockToIso } from "../time/local.ts";
import { subscriptionCallOutcome } from "./changes.ts";
import { loadSubscriptionRow, type SubscriptionRow } from "./events.ts";

export type CoolOffRow = Selectable<CoreSubscriptionCoolOffTable>;

/** The longest cooling-off period the host keeps (the SDK's MAX_COOLING_OFF_DAYS). */
export const MAX_COOLING_OFF_DAYS = 90;

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
  /** The days that apply (the longer of the setting at the start and now); 0 when none. */
  days: number;
  /** The last local day of the window (`YYYY-MM-DD`, the business's zone), or null. */
  until: string | null;
  /** The moment the window closes (the local midnight after `until`), or null. */
  endsAt: string | null;
  /** What has been paid on it and not refunded, in minor units: the refund it would owe. */
  refund: number;
  currency: string;
  /** A cooling off asked for, and how far it has got. */
  coolOff: {
    state: "asked" | "refused" | "ended";
    asked: "sent" | "pending" | "unknown" | null;
    askedBy: "payer" | "staff";
    askedAt: string;
    endedAt: string | null;
    /** Once ended: what was paid, what has been refunded so far, and where the rest is. */
    paid: number;
    refunded: number;
    refunds: RefundState | null;
  } | null;
}

const FINAL = new Set(["ended", "expired"]);

/** A number setting read as whole days within the host's bounds; anything else is 0 (off). */
function asDays(value: unknown): number {
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) return 0;
  return Math.min(MAX_COOLING_OFF_DAYS, Math.floor(n));
}

/**
 * The cooling-off days a plan object's pack sets now, or null when the plan has no cooling off
 * (its pack does not declare `recurring.coolingOff`). `cache` keeps one read per extension.
 */
export async function coolingOffDaysNow(
  ctx: HandlerContext,
  planObject: string,
  cache: Map<string, Promise<Record<string, unknown>>> = new Map(),
): Promise<number | null> {
  const object = getObject(planObject);
  const setting = object?.sellable?.recurring?.coolingOff?.setting;
  const ext = object?.extension;
  if (!setting || !ext) return null;
  let values = cache.get(ext);
  if (!values) {
    values = extensionSettingValues(ctx.db, ext);
    cache.set(ext, values);
  }
  return asDays((await values)[setting]);
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
  const [checkouts, coolOffs, paid, refundRows, general] = await Promise.all([
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
      .selectFrom("core_order")
      .select([
        "subscription_id",
        sql<number>`coalesce(sum(paid), 0)`.as("paid"),
        sql<number>`coalesce(sum(refunded), 0)`.as("refunded"),
      ])
      .where("subscription_id", "in", ids)
      .groupBy("subscription_id")
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
  const settings = new Map<string, Promise<Record<string, unknown>>>();
  const out: CoolingOffStatus[] = [];
  for (const row of rows) {
    const checkout = checkouts.find((c) => c.id === row.id);
    const own = coolOffs.find((c) => c.subscription_id === row.id) ?? null;
    const sums = paid.find((p) => p.subscription_id === row.id);
    const paidSoFar = Number(sums?.paid ?? 0);
    const refundedSoFar = Number(sums?.refunded ?? 0);
    const now = await coolingOffDaysNow(ctx, row.plan_object, settings);
    const covered = now !== null;
    const days = covered ? Math.max(asDays(checkout?.cooling_off_days ?? 0), now) : 0;
    const window = days > 0 ? coolingOffWindow(row.created_at, days, general.timezone) : null;
    const used = coolOffs.some(
      (c) =>
        c.subscription_id !== row.id &&
        row.holder_person_id !== null &&
        c.holder_person_id === row.holder_person_id &&
        (c.state === "asked" || c.state === "ended"),
    );
    const why: NotOffered | null = !covered
      ? "not_covered"
      : !checkout || checkout.offer_id !== null
        ? "continuation"
        : days === 0
          ? "off"
          : FINAL.has(row.state)
            ? "ended"
            : window && Date.parse(ctx.now) >= Date.parse(window.endsAt)
              ? "window_passed"
              : used
                ? "used"
                : paidSoFar - refundedSoFar <= 0
                  ? "nothing_paid"
                  : null;
    const refunds = refundRows.filter((r) => r.subscription_id === row.id).map((r) => r.state);
    out.push({
      subscriptionId: row.id,
      offered: own === null && why === null,
      why: own ? null : why,
      days: own ? own.days : days,
      until: own
        ? coolingOffWindow(row.created_at, own.days, general.timezone).until
        : (window?.until ?? null),
      endsAt: own ? own.window_ends_at : (window?.endsAt ?? null),
      refund: Math.max(0, paidSoFar - refundedSoFar),
      currency: row.currency,
      coolOff: own
        ? {
            state: own.state,
            asked: own.call_outcome,
            askedBy: own.asked_by,
            askedAt: own.asked_at,
            endedAt: own.ended_at,
            paid: paidSoFar,
            refunded: refundedSoFar,
            refunds:
              own.state !== "ended"
                ? null
                : paidSoFar > 0 && refundedSoFar >= paidSoFar
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
  /** What has been paid and not refunded, in minor units: owed back once it ends. */
  refund: number;
  currency: string;
}

/**
 * `subscription.coolOff`: the payer's own subscription (a member, a guardian paying for a child) or
 * staff for anyone's; a person only (the operation's actors). The cooling off's row is written in
 * this batch; the provider is asked to end the subscription after it commits. Asked again, it asks
 * the provider again until it is sent; once sent or ended it changes nothing.
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
  const refund = status?.refund ?? 0;
  const result = (state: CooledOff["state"], asked: CooledOff["asked"]): CooledOff => ({
    id: row.id,
    state,
    asked,
    refund,
    currency: row.currency,
  });
  if (existing?.state === "ended") return result("ended", existing.call_outcome);
  // Taken by the provider (or waiting at the gatekeeper for a person): nothing to ask again.
  if (
    existing?.state === "asked" &&
    (existing.call_outcome === "sent" || existing.call_outcome === "pending")
  ) {
    return result("asked", existing.call_outcome);
  }
  if (existing) {
    // Asked before (inside its window), and the provider has not taken it: ask again, whenever
    // that is. A subscription the provider shows ended another way has nothing left to end.
    if (FINAL.has(row.state)) {
      throw new ConflictError("This membership has already ended", {
        subscription: row.id,
        rule: "cooling_off",
        reason: "ended",
      });
    }
    ctx.write(
      ctx.db
        .updateTable("core_subscription_cool_off")
        .set({ state: "asked", call_outcome: null, updated_at: ctx.now })
        .where("subscription_id", "=", row.id)
        .where("state", "=", existing.state),
    );
  } else {
    if (!status?.offered) {
      const why = status?.why ?? "not_covered";
      throw new ConflictError(notOfferedWords(why, status?.until ?? null), {
        subscription: row.id,
        rule: "cooling_off",
        reason: why,
        ...(status?.until ? { until: status.until } : {}),
      });
    }
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
        ended_at: null,
        updated_at: ctx.now,
      }),
    );
  }
  return afterCommit(async () => result("asked", await askToEnd(ctx, row)));
}

/**
 * Asks the provider to end `row` now, after the cooling off's row committed, and writes what came
 * of it (with an audit row of the host's). A refusal marks it refused and throws; an unknown answer
 * leaves it asked for the provider's next event to decide. Staff are told of both.
 */
async function askToEnd(
  ctx: HandlerContext,
  row: SubscriptionRow,
): Promise<"sent" | "pending" | "unknown"> {
  const record = async (outcome: "sent" | "pending" | "unknown" | "refused") => {
    const at = new Date().toISOString();
    const updated = await ctx.db
      .updateTable("core_subscription_cool_off")
      .set(
        outcome === "refused"
          ? { state: "refused", call_outcome: null, updated_at: at }
          : { call_outcome: outcome, updated_at: at },
      )
      .where("subscription_id", "=", row.id)
      .where("state", "=", "asked")
      .executeTakeFirst();
    const written = Number(updated.numUpdatedRows ?? 0) > 0;
    await ctx.db
      .insertInto("core_audit")
      .values({
        id: newId("audit"),
        at,
        operation: "subscription.coolOff.outcome",
        risk: "write",
        // The host's own record of what the provider answered, not a caller's act.
        actor: "automation",
        user_id: null,
        origin: JSON.stringify({ surface: "system", automationId: "subscription.coolOff.outcome" }),
        input: JSON.stringify({ subscriptionId: row.id, by: ctx.operation ?? null }),
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
    if (outcome === "unknown" || outcome === "refused") {
      const plan = await notifyStatements(
        ctx.db,
        {
          to: [{ role: "admin" }],
          type: "system.message",
          title:
            outcome === "refused"
              ? "A cooling off was refused by the payment provider"
              : "A cooling off was not confirmed by the payment provider",
          body:
            `Subscription ${row.id} (${row.plan_title}) was asked to end in its cooling-off ` +
            (outcome === "refused"
              ? "period, and the payment provider refused to end it, so it still runs and nothing is owed yet. "
              : "period, and the payment provider did not answer: it may or may not have ended. ") +
            "Open the subscription and ask again (Cooling off); its refunds are owed once the " +
            "provider shows it ended.",
          link: { kind: "record", object: "subscription", id: row.id },
          dedupeKey: `subscription.cool_off:${outcome}:${row.id}:${at}`,
          source: { actor: "system" },
        },
        at,
      );
      for (const statement of plan.statements) await ctx.db.executeQuery(statement.compile());
    }
  };
  const target = await paymentsTarget(ctx.db);
  if (target.provider !== row.provider) {
    await record("refused");
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
    await record("unknown");
    return "unknown";
  }
  let { outcome } = subscriptionCallOutcome(answer);
  // A refusal because it has ended already (a second ask racing the first, or an end the host has
  // not heard of yet) is not a refusal of the cooling off: the provider's own read says which.
  if (outcome === "refused" && (await endedAtProvider(ctx, row))) outcome = "sent";
  await record(outcome);
  if (outcome === "refused") {
    throw new ConflictError(
      "The payment provider did not end your membership, so nothing changed. Try again; the " +
        "business has been told.",
      { subscription: row.id, rule: "provider_refused" },
    );
  }
  return outcome;
}

/** Whether the provider reads the subscription as ended now (an observation); false if unread. */
async function endedAtProvider(ctx: HandlerContext, row: SubscriptionRow): Promise<boolean> {
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
    return read?.ref === row.provider_ref && read.status === "canceled";
  } catch {
    return false;
  }
}

/**
 * In the batch of every verified event of a subscription with a cooling off asked (events.ts):
 * once the provider shows it ended, every paid order of it is owed back in full, the cooling off
 * is ended, and staff are told once. An order paid after that (a renewal the provider took as it
 * ended) is owed back by the next event's batch. Nothing is asked of the provider here: the minute
 * cron asks the gatekeeper for each refund owed, which waits for a person with `orders:refund`.
 */
export async function followCoolOff(ctx: HandlerContext, row: SubscriptionRow): Promise<void> {
  if (!FINAL.has(row.state)) return;
  const own = await ctx.db
    .selectFrom("core_subscription_cool_off")
    .select(["state", "days"])
    .where("subscription_id", "=", row.id)
    .executeTakeFirst();
  if (!own || own.state === "refused") return;
  const reason = "A membership ended in its cooling-off period: a full refund";
  // One statement, set-based: every order of the subscription with money on it not refunded.
  // Its id is the order's own (one refund owed per order; the unique index holds it too).
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
      .expression((eb) =>
        eb
          .selectFrom("core_order as o")
          .select([
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
          ])
          .where("o.subscription_id", "=", row.id)
          .where(sql<boolean>`o.paid > o.refunded`),
      ),
  );
  if (own.state === "ended") return;
  ctx.write(
    ctx.db
      .updateTable("core_subscription_cool_off")
      .set({ state: "ended", ended_at: ctx.now, updated_at: ctx.now })
      .where("subscription_id", "=", row.id)
      .where("state", "=", "asked"),
  );
  const paid = await ctx.db
    .selectFrom("core_order")
    .select(sql<number>`coalesce(sum(paid - refunded), 0)`.as("owed"))
    .where("subscription_id", "=", row.id)
    .executeTakeFirst();
  const plan = await notifyStatements(
    ctx.db,
    {
      to: [{ role: "admin" }],
      type: "system.message",
      title: "A membership ended in its cooling-off period",
      body:
        `Subscription ${row.id} (${row.plan_title}) ended in its ${own.days}-day cooling-off ` +
        `period. A full refund of what was paid on it (${formatMoney(Number(paid?.owed ?? 0), row.currency)}` +
        ") is owed: each paid period's refund waits in Approvals for a person who may refund.",
      link: { kind: "record", object: "subscription", id: row.id },
      dedupeKey: `subscription.cooled_off:${row.id}`,
      source: { actor: "system" },
    },
    ctx.now,
  );
  ctx.write(...plan.statements);
}
