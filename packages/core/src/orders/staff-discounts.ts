// Staff discounts (stage 34, ADR 0691): money off a pending order, given by a person with
// `orders:discount`, with a reason. `order.adjust` and `order.unadjust` call these functions.
//
//   - Within the limit a human admin set (`order.settings.update`, `discountLimit`): applied at
//     once. Above it the call waits in the Approvals inbox for a human admin (the operation's
//     `reviewWhen`, operations/approval.ts); an AI's call always waits, whatever the amount.
//     While one waits, the order's checkout cannot open.
//   - Only a pending order whose checkout has not opened is adjusted: a provider page already
//     open was made for the old amount.
//   - The order is repriced through the seam (`applyAdjustments`) from its lines' prices and every
//     adjustment still on it, so its lines and total never drift from what the adjustments say.
import type { CoreDatabase } from "@composable-os/db";
import type { Kysely, Selectable } from "kysely";
import { ConflictError, NotFoundError, ValidationError } from "../errors.ts";
import { getObject } from "../fields/index.ts";
import { orderLineObject } from "../fields/order.ts";
import { newId } from "../ids.ts";
import type { HandlerContext } from "../operation.ts";
import { callerMover } from "../records/lifecycle.ts";
import { orgReader, visibleSource } from "../visibility/index.ts";
import {
  type AdjustmentShare,
  applyAdjustments,
  percentOff,
  type SeamLine,
} from "./adjustments.ts";
import {
  changeOrderPrice,
  loadOrderRow,
  type OrderRow,
  refuseInvoiceOrder,
  requireState,
} from "./orders.ts";
import { type DiscountLimit, loadDiscountLimit } from "./settings.ts";

export type AdjustmentRow = Selectable<CoreDatabase["core_order_adjustment"]>;

/** What a person asks to take off: a percentage or an amount, of one line or the whole order. */
export interface StaffDiscountRequest {
  /** The line it is on; left out, the whole order. */
  lineId?: string | undefined;
  /** A percentage of what the line (or each line) still costs, rounded down per line. */
  percent?: number | undefined;
  /** An amount in minor units. */
  amount?: number | undefined;
  reason: string;
}

interface OrderLineCost extends SeamLine {
  position: number;
}

/** The order's lines and their prices: the host's own read, org-wide, through the seam. */
async function linesOf(db: Kysely<CoreDatabase>, orderId: string): Promise<OrderLineCost[]> {
  const lineObject = getObject("orderLine") ?? orderLineObject;
  // biome-ignore lint/suspicious/noExplicitAny: the source is a registry-driven view, not a key of the typed schema.
  const rows = (await (db as any)
    .selectFrom(visibleSource(orgReader(db), lineObject))
    .select(["id", "position", "line_total"])
    .where("order_id", "=", orderId)
    .orderBy("position")
    .execute()) as { id: string; position: number; line_total: number }[];
  return rows.map((row) => ({ id: row.id, position: row.position, total: row.line_total }));
}

/**
 * The adjustments still on an order, as the seam takes them off: the deal first (a code or a
 * member's price, ADR 0693), then staff discounts, each in the order they were made. A staff
 * discount is always added after the deal (the spec's rule 1), even when the code came later.
 */
export async function liveAdjustments(
  db: Kysely<CoreDatabase>,
  orderId: string,
): Promise<AdjustmentRow[]> {
  const rows = await db
    .selectFrom("core_order_adjustment")
    .selectAll()
    .where("order_id", "=", orderId)
    .where("removed_at", "is", null)
    .orderBy("created_at")
    .orderBy("id")
    .execute();
  const staffLast = (row: AdjustmentRow) => (row.kind === "staff" ? 1 : 0);
  return rows.sort((a, b) => staffLast(a) - staffLast(b));
}

/** An adjustment row as the seam takes it off. */
const share = (a: AdjustmentRow): AdjustmentShare => ({
  lineId: a.line_id,
  amount: a.amount,
  percent: a.percent,
});

/**
 * Staff discounts a person asked for that wait for approval on `orderId` (over the limit): its
 * checkout cannot open while one does, since the person at the desk is with the buyer. An AI's
 * request waits too, but does not stop the buyer paying: an assistant cannot hold an order's
 * payment by asking (review of PR #380). Approved after the page opened, it is refused.
 */
export async function discountsWaiting(
  db: Kysely<CoreDatabase>,
  orderId: string,
  now: string,
): Promise<number> {
  const row = await db
    .selectFrom("core_pending_action")
    .select((eb) => eb.fn.countAll<number>().as("n"))
    .where("operation", "=", "order.adjust")
    .where("actor", "=", "human")
    .where("status", "=", "pending")
    .where("expires_at", ">", now)
    .where((eb) => eb(eb.fn("json_extract", ["input", eb.val("$.id")]), "=", orderId))
    .executeTakeFirst();
  return Number(row?.n ?? 0);
}

interface Planned {
  lineId: string | null;
  percent: number | null;
  amount: number;
}

/** What `request` takes off the order as it stands. Refuses one that takes nothing or too much. */
function plan(
  lines: readonly OrderLineCost[],
  live: readonly AdjustmentRow[],
  request: StaffDiscountRequest,
): Planned {
  const now = applyAdjustments(lines, live.map(share));
  const nets = lines.map((line, i) => line.total - (now.discounts[i] ?? 0));
  let targets = nets;
  if (request.lineId !== undefined) {
    const index = lines.findIndex((line) => line.id === request.lineId);
    if (index < 0) {
      throw new ValidationError("That line is not on this order", { field: "lineId" });
    }
    targets = [nets[index] ?? 0];
  }
  const room = targets.reduce((sum, net) => sum + net, 0);
  const amount =
    request.percent !== undefined ? percentOff(targets, request.percent) : (request.amount ?? 0);
  if (amount <= 0) {
    throw new ValidationError("This takes nothing off", { rule: "adjust_nothing" });
  }
  if (amount > room) {
    throw new ValidationError("A discount cannot take more off than is left to pay", {
      rule: "adjust_too_much",
      left: room,
    });
  }
  // Nothing to pay has no way to be paid yet (an order paid another way is a later step).
  if (amount >= now.total) {
    throw new ValidationError("A discount cannot take an order to nothing to pay", {
      rule: "total",
    });
  }
  return { lineId: request.lineId ?? null, percent: request.percent ?? null, amount };
}

/**
 * Whether a person's `order.adjust` call is within the limit a human admin set: every staff
 * discount on the order with this one is at most the limit's amount and at most its percentage
 * of what the order costs before adjustments. A call the handler will refuse anyway (the order
 * is not pending, the request takes nothing off) is "within": it runs and is refused.
 */
export async function staffDiscountWithinLimit(
  db: Kysely<CoreDatabase>,
  input: StaffDiscountRequest & { id: string },
): Promise<boolean> {
  let row: OrderRow;
  try {
    row = await loadOrderRow(db, input.id);
  } catch (error) {
    if (error instanceof NotFoundError) return true;
    throw error;
  }
  // Not pending, or an invoice's (refused by the handler, ADR 0731): it runs and is refused.
  if (row.state !== "pending" || row.invoice_id) return true;
  const [lines, live, limit] = await Promise.all([
    linesOf(db, row.id),
    liveAdjustments(db, row.id),
    loadDiscountLimit(db),
  ]);
  let planned: Planned;
  try {
    planned = plan(lines, live, input);
  } catch (error) {
    if (error instanceof ValidationError) return true;
    throw error;
  }
  return withinLimit(lines, live, planned, limit);
}

/** Every staff discount on the order with `planned` is within `limit`. */
function withinLimit(
  lines: readonly OrderLineCost[],
  live: readonly AdjustmentRow[],
  planned: Planned,
  limit: DiscountLimit,
): boolean {
  const staff =
    live.filter((a) => a.kind === "staff").reduce((sum, a) => sum + a.amount, 0) + planned.amount;
  const subtotal = lines.reduce((sum, line) => sum + line.total, 0);
  // In hundredths of a percent: whole-number arithmetic.
  return staff <= limit.amount && staff * 10_000 <= Math.round(limit.percent * 100) * subtotal;
}

/** Refuses a change to an order's price once its payment page is open (ADR 0690). */
export async function refuseOpenCheckout(ctx: HandlerContext, row: OrderRow): Promise<void> {
  const opened = await ctx.db
    .selectFrom("core_order_checkout")
    .select("ref")
    .where("order_id", "=", row.id)
    .limit(1)
    .executeTakeFirst();
  if (opened) {
    throw new ConflictError(
      "The payment page for this order is already open, so its price cannot change: cancel it and start a new one",
      { rule: "checkout_open", order: row.id },
    );
  }
}

/** A pending order as a change to its adjustments leaves it, once the batch commits. */
export interface Repriced {
  order: OrderRow;
  /** Each line's share of the adjustments, by line id. */
  discounts: ReadonlyMap<string, number>;
}

/** Queues the order's lines and total as `adjustments` leave them, in the calling batch. */
async function reprice(
  ctx: HandlerContext,
  row: OrderRow,
  lines: readonly OrderLineCost[],
  adjustments: readonly { lineId: string | null; amount: number }[],
): Promise<Repriced> {
  const adjusted = applyAdjustments(lines, adjustments);
  if (adjusted.total <= 0) {
    throw new ValidationError("A discount cannot take an order to nothing to pay", {
      rule: "total",
    });
  }
  ctx.write(
    ...lines.map((line, i) =>
      ctx.db
        .updateTable("core_order_line")
        .set({ line_discount: adjusted.discounts[i] ?? 0 })
        .where("id", "=", line.id)
        .where("order_id", "=", row.id),
    ),
  );
  const order = await changeOrderPrice(
    ctx,
    row,
    { total: adjusted.total, discount: adjusted.discount },
    callerMover(ctx),
  );
  return {
    order,
    discounts: new Map(lines.map((line, i) => [line.id, adjusted.discounts[i] ?? 0])),
  };
}

/**
 * Gives a staff discount on a pending order, in the calling batch: the adjustment, the lines'
 * shares and the order's new total, or nothing. The pipeline queued a call over the limit
 * (`staffDiscountWithinLimit`); a call that reaches here unapproved is judged again on this read.
 */
export async function giveStaffDiscount(
  ctx: HandlerContext,
  orderId: string,
  request: StaffDiscountRequest,
): Promise<Repriced & { adjustmentId: string }> {
  const row = await loadOrderRow(ctx.db, orderId);
  refuseInvoiceOrder(row, "a discount is given on the invoice's line before it is issued");
  requireState(row, ["pending"], "given a discount");
  await refuseOpenCheckout(ctx, row);
  const [lines, live, limit] = await Promise.all([
    linesOf(ctx.db, row.id),
    liveAdjustments(ctx.db, row.id),
    loadDiscountLimit(ctx.db),
  ]);
  const planned = plan(lines, live, request);
  // The pipeline judged the limit on an earlier read (`reviewWhen`): another discount may have
  // landed since. Judged again on what this write is made from, which the order's version check
  // holds to commit (review of PR #380). An approved call is an admin's decision, and the dry run
  // of a call being queued is the approver's to judge.
  if (!ctx.approval && !ctx.simulation && !withinLimit(lines, live, planned, limit)) {
    throw new ConflictError(
      "Another discount was given on this order meanwhile, and with it this one is over the limit. Ask again: it will wait for an admin's approval.",
      { rule: "discount_limit", order: row.id },
    );
  }
  const id = newId("orderAdjustment");
  ctx.write(
    ctx.db.insertInto("core_order_adjustment").values({
      id,
      order_id: row.id,
      line_id: planned.lineId,
      kind: "staff",
      given_by: ctx.user.id,
      reason: request.reason,
      percent: planned.percent,
      amount: planned.amount,
      approval: ctx.approval?.actionId ?? null,
      created_at: ctx.now,
    }),
  );
  const repriced = await reprice(ctx, row, lines, [
    ...live.map(share),
    { lineId: planned.lineId, amount: planned.amount, percent: planned.percent },
  ]);
  return { ...repriced, adjustmentId: id };
}

/** Takes an adjustment off a pending order, in the calling batch: marked removed, then repriced. */
export async function removeAdjustment(
  ctx: HandlerContext,
  orderId: string,
  adjustmentId: string,
): Promise<Repriced> {
  const row = await loadOrderRow(ctx.db, orderId);
  refuseInvoiceOrder(row, "an issued invoice's price is never changed: credit it instead");
  requireState(row, ["pending"], "changed");
  await refuseOpenCheckout(ctx, row);
  const [lines, live] = await Promise.all([
    linesOf(ctx.db, row.id),
    liveAdjustments(ctx.db, row.id),
  ]);
  if (!live.some((a) => a.id === adjustmentId)) throw new NotFoundError("adjustment", adjustmentId);
  ctx.write(
    ctx.db
      .updateTable("core_order_adjustment")
      .set({ removed_at: ctx.now, removed_by: ctx.user.id })
      .where("id", "=", adjustmentId)
      .where("order_id", "=", row.id)
      .where("removed_at", "is", null),
  );
  return reprice(ctx, row, lines, live.filter((a) => a.id !== adjustmentId).map(share));
}
