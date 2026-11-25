// Deleting an account: the preview and its consequences (stage 48 step 6, ADR 0713, amending
// ADR 0402). Before a customer deletes their account the host says what will happen; on confirm
// it does it, and the erase request staff action is opened as before.
//
// - Each subscription they pay that still runs is set to end when its paid period does (decision
//   1): the provider is asked, as `subscription.cancel` asks it, so nothing is refunded and
//   nothing new is charged. One already set to end by then is not asked again; one under a
//   cooling off ends with it (ADR 0647). One the host cannot end at its period's end (an end date
//   set at the provider after the period, waiting for a first payment, unpaid or paused) is left
//   for staff, and the preview and the admins say it may still charge. A subscription someone
//   else pays is not theirs to end (ADR 0487).
// - Each unpaid order of theirs (pending, not a subscription's period) is cancelled, with the
//   order code a customer's own `order.cancel` runs.
// - What stays for staff's erase is counted, never changed: their open records of every object
//   that declares a customer (a booking, a ticket, a course place), a part-paid order, and a
//   dependant who would be left with no other guardian. Admins are told these with the request.
//
// Every read here is bounded: one statement per kind of thing, the customer objects' counts in
// one statement per forty objects (the seam's countOwnOpenRecords), and at most
// ACCOUNT_DELETE_MOST orders and subscriptions acted on (any beyond are left for staff, and the
// preview says so).

import { sha256Hex } from "../content/cache.ts";
import type { HandlerContext } from "../operation.ts";
import { changeOrder, loadOrderRow } from "../orders/orders.ts";
import { callerMover } from "../records/lifecycle.ts";
import { dependantsLeftAlone } from "../records/person-links.ts";
import { coolOffOpen } from "../subscriptions/cooling-off.ts";
import { loadSubscriptionRow } from "../subscriptions/events.ts";
import { cancelAtPeriodEnd, RUNNING } from "../subscriptions/subscriptions.ts";
import { countOwnOpenRecords } from "../visibility/own-records.ts";

/** The most subscriptions ended and orders cancelled in one deletion; any more stay for staff. */
export const ACCOUNT_DELETE_MOST = 20;
/** Why the provider is asked to end a subscription, as `subscription.cancel`'s reason. */
export const DELETE_REASON = "The payer deleted their account";

export interface EndingSubscription {
  id: string;
  title: string;
  amount: number;
  currency: string;
  interval: string;
  /**
   * When it stops: the end of the period paid for (or the trial), or the earlier end already set;
   * null when not yet known, and for a cooling off (it ends once the provider confirms).
   */
  endsAt: string | null;
  /**
   * `period_end`: the provider is asked to end it then. `already`: it is already set to end by
   * then; nothing more is asked. `cooling_off`: a cooling off under way ends it, with its refund
   * (ADR 0647); nothing more is asked.
   */
  ending: "period_end" | "already" | "cooling_off";
}

/** A subscription they pay that deleting does not end: staff end it at the provider. */
export interface StaffSubscription {
  id: string;
  title: string;
  state: string;
  /**
   * `end_date_later`: an end date set at the provider after the period paid for, which only staff
   * change there. `state`: waiting for a first payment, unpaid or paused. `more`: beyond the
   * ACCOUNT_DELETE_MOST one deletion ends.
   */
  why: "end_date_later" | "state" | "more";
}

export interface CancelledOrder {
  id: string;
  total: number;
  currency: string;
  createdAt: string;
  lines: string[];
}

export interface LeftForStaff {
  /** Their open records of each object that declares a customer, by object. */
  records: { object: string; label: string; count: number }[];
  /** Part-paid orders (a deposit was paid): a customer cannot cancel one. */
  partPaidOrders: number;
  /** Unpaid orders beyond the ACCOUNT_DELETE_MOST cancelled. */
  moreUnpaidOrders: number;
  /**
   * Invoices still owed (stage 35, ADR 0731): their orders are never cancelled here. Deleting an
   * account never cancels an issued invoice: it stays owed.
   */
  invoicesOwed: number;
  /** Subscriptions they pay that are not ended, and may still charge until staff end them. */
  subscriptions: StaffSubscription[];
  /** Dependants who would be left with no other live guardian (ADR 0540). */
  dependantsWithoutGuardian: number;
}

export interface DeletePreview {
  subscriptions: EndingSubscription[];
  orders: CancelledOrder[];
  leftForStaff: LeftForStaff;
  /** What confirming must echo: changes whenever any of the above does. */
  expect: string;
}

/** What deleting `personId`'s account would do now. Reads only. */
export async function deletePreview(ctx: HandlerContext, personId: string): Promise<DeletePreview> {
  const db = ctx.db;
  // Subscriptions they pay that have not ended (ADR 0487: billing follows the payer).
  const paid = await db
    .selectFrom("core_subscription")
    .select([
      "id",
      "plan_title",
      "amount",
      "currency",
      "interval",
      "state",
      "trial_end",
      "current_period_end",
      "cancel_at_period_end",
      "cancel_at",
    ])
    .where("payer_person_id", "=", personId)
    .where("state", "not in", ["ended", "expired"])
    .orderBy("created_at")
    .orderBy("id")
    .execute();
  // When a running subscription's paid time ends: its trial's end while trialing, else its period's.
  const paidUntil = (row: (typeof paid)[number]) =>
    row.state === "trialing" ? (row.trial_end ?? row.current_period_end) : row.current_period_end;
  const running = paid.filter((row) => RUNNING.has(row.state));
  const staffSubscriptions: StaffSubscription[] = [];
  const toStaff = (row: (typeof paid)[number], why: StaffSubscription["why"]) =>
    staffSubscriptions.push({ id: row.id, title: row.plan_title, state: row.state, why });
  for (const row of paid) if (!RUNNING.has(row.state)) toStaff(row, "state");
  // An end date at the provider after the paid time keeps charging until then: only staff move
  // it there (cancelAtPeriodEnd refuses it, as subscription.resume does).
  const endsLater = (row: (typeof paid)[number]) => {
    const until = paidUntil(row);
    return (
      row.cancel_at_period_end !== 1 &&
      row.cancel_at !== null &&
      (until === null || row.cancel_at > until)
    );
  };
  for (const row of running) if (endsLater(row)) toStaff(row, "end_date_later");
  const endable = running.filter((row) => !endsLater(row));
  const acted = endable.slice(0, ACCOUNT_DELETE_MOST);
  for (const row of endable.slice(ACCOUNT_DELETE_MOST)) toStaff(row, "more");
  // A cooling off under way ends its subscription itself (ADR 0647): one read for all of them,
  // then the cooling off's own rule for the few asked.
  const asked = acted.length
    ? await db
        .selectFrom("core_subscription_cool_off")
        .select("subscription_id")
        .where(
          "subscription_id",
          "in",
          acted.map((row) => row.id),
        )
        .where("state", "=", "asked")
        .execute()
    : [];
  const coolingOff = new Set<string>();
  for (const { subscription_id } of asked) {
    if (await coolOffOpen(db, subscription_id, ctx.now)) coolingOff.add(subscription_id);
  }
  const subscriptions: EndingSubscription[] = acted.map((row) => {
    const ending: EndingSubscription["ending"] = coolingOff.has(row.id)
      ? "cooling_off"
      : row.cancel_at_period_end === 1 || row.cancel_at !== null
        ? "already"
        : "period_end";
    return {
      id: row.id,
      title: row.plan_title,
      amount: row.amount,
      currency: row.currency,
      interval: row.interval,
      endsAt:
        ending === "cooling_off"
          ? null
          : row.cancel_at !== null &&
              (paidUntil(row) === null || row.cancel_at < (paidUntil(row) ?? ""))
            ? row.cancel_at
            : paidUntil(row),
      ending,
    };
  });

  // Their orders still open: unpaid ones are cancelled, part-paid ones stay for staff. A
  // subscription's period order follows its subscription, never cancelled here.
  const owing = await db
    .selectFrom("core_order")
    .select(["id", "state", "total", "currency", "created_at", "invoice_id"])
    .where("person_id", "=", personId)
    .where("state", "in", ["pending", "part_paid"])
    .where("subscription_id", "is", null)
    .orderBy("created_at")
    .orderBy("id")
    .execute();
  // An invoice's order is never cancelled by deleting the account: the invoice stays owed.
  const open = owing.filter((row) => row.invoice_id === null);
  const invoicesOwed = owing.length - open.length;
  const unpaid = open.filter((row) => row.state === "pending");
  const cancelled = unpaid.slice(0, ACCOUNT_DELETE_MOST);
  const lines = cancelled.length
    ? await db
        .selectFrom("core_order_line")
        .select(["order_id", "title"])
        .where(
          "order_id",
          "in",
          cancelled.map((row) => row.id),
        )
        .orderBy("order_id")
        .orderBy("position")
        .execute()
    : [];
  const orders = cancelled.map((row) => ({
    id: row.id,
    total: row.total,
    currency: row.currency,
    createdAt: row.created_at,
    lines: lines.filter((line) => line.order_id === row.id).map((line) => line.title),
  }));

  const leftForStaff: LeftForStaff = {
    records: await countOwnOpenRecords(ctx),
    subscriptions: staffSubscriptions,
    partPaidOrders: open.length - unpaid.length,
    moreUnpaidOrders: unpaid.length - cancelled.length,
    invoicesOwed,
    dependantsWithoutGuardian: (await dependantsLeftAlone(ctx, [personId])).length,
  };
  // Not a secret, a fingerprint: the ids acted on and what is left, so a confirm made on an older
  // preview is told. How a subscription ends is left out: the provider's event can say it is
  // already ending between the two calls, and it changes nothing the member agreed to.
  const expect = await sha256Hex(
    JSON.stringify({
      subscriptions: subscriptions.map((s) => s.id),
      orders: orders.map((o) => o.id),
      leftForStaff,
    }),
  );
  return { subscriptions, orders, leftForStaff, expect: expect.slice(0, 32) };
}

/**
 * Does what `preview` said, for the calling customer. Each unpaid order's cancel is queued into
 * the calling batch first, so an order the engine refuses stops the deletion before the provider
 * is asked anything. Then the provider is asked to end each subscription at its period's end
 * (before the batch, as `subscription.cancel` does). A refusal there throws and the batch is not
 * run; a subscription asked before it stays set to end (the member can resume it), and asking
 * again (a retry, or two confirms at once) asks the provider for the same end.
 */
export async function applyDeletePreview(
  ctx: HandlerContext,
  preview: DeletePreview,
): Promise<void> {
  for (const order of preview.orders) {
    const row = await loadOrderRow(ctx.db, order.id);
    await changeOrder(ctx, row, "cancelled", { cancelled_at: ctx.now }, callerMover(ctx));
  }
  for (const subscription of preview.subscriptions) {
    if (subscription.ending !== "period_end") continue;
    await cancelAtPeriodEnd(ctx, await loadSubscriptionRow(ctx.db, subscription.id), DELETE_REASON);
  }
}

/** The sentences admins are told of what stays for them, in the erase request's notice. */
export function leftForStaffSentences(preview: DeletePreview): string[] {
  const left = preview.leftForStaff;
  const things = left.records.map((r) => `${r.count} ${r.label.toLowerCase()}`);
  const add = (n: number, one: string, many: string) => {
    if (n) things.push(`${n} ${n === 1 ? one : many}`);
  };
  add(left.partPaidOrders, "part-paid order", "part-paid orders");
  add(left.moreUnpaidOrders, "other unpaid order", "other unpaid orders");
  add(left.invoicesOwed, "invoice still owed", "invoices still owed");
  add(
    left.dependantsWithoutGuardian,
    "child with no other guardian",
    "children with no other guardian",
  );
  const out: string[] = [];
  if (things.length) out.push(`Left for you to decide at erase: ${things.join(", ")}.`);
  const billing = left.subscriptions.length;
  if (billing) {
    out.push(
      `${billing === 1 ? "1 subscription they pay was" : `${billing} subscriptions they pay were`} ` +
        "not ended and may still charge: end it at the payment provider (an end date set there " +
        "after the period paid for, or waiting for payment, unpaid or paused).",
    );
  }
  const ending = preview.subscriptions.filter((sub) => sub.ending !== "cooling_off").length;
  if (ending) {
    out.push(
      `${ending === 1 ? "1 subscription they pay ends" : `${ending} subscriptions they pay end`} ` +
        "when the period paid for ends; nothing was refunded.",
    );
  }
  const cooling = preview.subscriptions.length - ending;
  if (cooling) {
    out.push(
      `${cooling === 1 ? "1 subscription ends" : `${cooling} subscriptions end`} with the ` +
        "cooling off under way, as it was asked.",
    );
  }
  const orders = preview.orders.length;
  if (orders) out.push(`${orders === 1 ? "1 unpaid order" : `${orders} unpaid orders`} cancelled.`);
  return out;
}
