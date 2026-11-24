// Deleting an account: the preview and its consequences (stage 48 step 6, ADR 0713, amending
// ADR 0402). Before a customer deletes their account the host says what will happen; on confirm
// it does it, and the erase request staff action is opened as before.
//
// - Each subscription they pay that still runs is set to end when its paid period does (decision
//   1): the provider is asked, as `subscription.cancel` asks it, so nothing is refunded and
//   nothing new is charged. A subscription someone else pays is not theirs to end (ADR 0487).
// - Each unpaid order of theirs (pending, not a subscription's period) is cancelled, with the
//   order code a customer's own `order.cancel` runs.
// - What stays for staff's erase is counted, never changed: their open records of every object
//   that declares a customer (a booking, a ticket, a course place), a part-paid order, and a
//   dependant who would be left with no other guardian. Admins are told these with the request.
//
// Every read here is bounded: one statement per kind of thing, the customer objects' counts in
// one statement per fifty objects (the seam's countOwnOpenRecords), and at most MOST orders and
// subscriptions acted on (any beyond are left for staff and said so).

import { sha256Hex } from "../content/cache.ts";
import type { HandlerContext } from "../operation.ts";
import { changeOrder, loadOrderRow } from "../orders/orders.ts";
import { callerMover } from "../records/lifecycle.ts";
import { dependantsLeftAlone } from "../records/person-links.ts";
import { loadSubscriptionRow } from "../subscriptions/events.ts";
import { cancelAtPeriodEnd, RUNNING } from "../subscriptions/subscriptions.ts";
import { countOwnOpenRecords } from "../visibility/own-records.ts";

/** The most subscriptions ended and orders cancelled in one deletion; any more stay for staff. */
export const MOST = 20;
/** Why the provider is asked to end a subscription, as `subscription.cancel`'s reason. */
export const DELETE_REASON = "The payer deleted their account";

export interface EndingSubscription {
  id: string;
  title: string;
  amount: number;
  currency: string;
  interval: string;
  /** When the paid period (or the trial) ends, which is when it stops; null if not yet known. */
  endsAt: string | null;
  /** Already set to end at its period's end (they cancelled it): nothing more is asked. */
  alreadyEnding: boolean;
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
  /** Unpaid orders beyond the MOST cancelled. */
  moreUnpaidOrders: number;
  /** Subscriptions they pay beyond the MOST ended, or in a state that cannot be ended at period end. */
  otherSubscriptions: number;
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
  const running = paid.filter((row) => RUNNING.has(row.state));
  const subscriptions = running.slice(0, MOST).map((row) => ({
    id: row.id,
    title: row.plan_title,
    amount: row.amount,
    currency: row.currency,
    interval: row.interval,
    endsAt:
      row.cancel_at ??
      (row.state === "trialing"
        ? (row.trial_end ?? row.current_period_end)
        : row.current_period_end),
    alreadyEnding: row.cancel_at_period_end === 1 || row.cancel_at !== null,
  }));

  // Their orders still open: unpaid ones are cancelled, part-paid ones stay for staff. A
  // subscription's period order follows its subscription, never cancelled here.
  const open = await db
    .selectFrom("core_order")
    .select(["id", "state", "total", "currency", "created_at"])
    .where("person_id", "=", personId)
    .where("state", "in", ["pending", "part_paid"])
    .where("subscription_id", "is", null)
    .orderBy("created_at")
    .orderBy("id")
    .execute();
  const unpaid = open.filter((row) => row.state === "pending");
  const cancelled = unpaid.slice(0, MOST);
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
    partPaidOrders: open.length - unpaid.length,
    moreUnpaidOrders: unpaid.length - cancelled.length,
    otherSubscriptions: paid.length - subscriptions.length,
    dependantsWithoutGuardian: (await dependantsLeftAlone(ctx, [personId])).length,
  };
  // Not a secret, a fingerprint: the ids acted on and the counts left, so a confirm made on an
  // older preview is told. Whether a subscription is already ending is left out: the provider's
  // event can say so between the two calls, and it changes nothing the member agreed to.
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
 * Does what `preview` said, for the calling customer: asks the provider to end each subscription
 * not already ending (before the batch, as `subscription.cancel` does: a refusal there leaves
 * the account as it was), then queues each unpaid order's cancel into the calling batch.
 */
export async function applyDeletePreview(
  ctx: HandlerContext,
  preview: DeletePreview,
): Promise<void> {
  for (const subscription of preview.subscriptions) {
    if (subscription.alreadyEnding) continue;
    await cancelAtPeriodEnd(ctx, await loadSubscriptionRow(ctx.db, subscription.id), DELETE_REASON);
  }
  for (const order of preview.orders) {
    const row = await loadOrderRow(ctx.db, order.id);
    await changeOrder(ctx, row, "cancelled", { cancelled_at: ctx.now }, callerMover(ctx));
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
  add(
    left.otherSubscriptions,
    "subscription they pay that was not ended",
    "subscriptions they pay that were not ended",
  );
  add(
    left.dependantsWithoutGuardian,
    "child with no other guardian",
    "children with no other guardian",
  );
  const out: string[] = [];
  if (things.length) out.push(`Left for you to decide at erase: ${things.join(", ")}.`);
  const ending = preview.subscriptions.length;
  if (ending) {
    out.push(
      `${ending === 1 ? "1 subscription they pay ends" : `${ending} subscriptions they pay end`} ` +
        "when the period paid for ends; nothing was refunded.",
    );
  }
  const orders = preview.orders.length;
  if (orders) out.push(`${orders === 1 ? "1 unpaid order" : `${orders} unpaid orders`} cancelled.`);
  return out;
}
