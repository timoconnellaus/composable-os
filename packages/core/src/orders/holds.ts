// Where an order's places are confirmed and released (stages 25 and 26, ADRs 0429 and 0432).
//
// The claim is taken in `createOrder` (orders/orders.ts calls `claimOrderPlaces`): one claim per
// line whose record has a capacity, all `for: { type: "order", id }`. The rest is a hook on the
// order's moves, in the batch of the write that makes the move.
//
//   to `part_paid` or `paid` from `pending`   confirm the order's holds
//   to `paid` or `part_paid` from `expired`   claim again (the holds were released at expiry) and
//   (a late payment staff honour)             confirm; a refusal fails the batch, so the order
//                                             stays expired and staff refund instead
//   to `paid` from `part_paid`                confirm what is still held (stock lines, below)
//   to `cancelled` or `expired`               release: held places and stock, and from
//                                             `part_paid` confirmed places too
//   to `refunded`                             release confirmed places, unless a line's object
//                                             declares `releaseOnRefund: false`
//
// A line whose object declares `stock` (stage 37, ADR 0682) holds and confirms through the same
// claims: its record's counter is on capacity's engine. It is sold only when the order is paid in
// full: a deposit (`part_paid`) confirms the order's places but leaves its goods held, and
// cancelling a part-paid order gives them back. When it is paid the host writes its `sold`
// movement in the same batch, and a sold unit never goes back on its own: a refund keeps its sale
// (stock comes back by a return, which writes its movement).
//
// A hold has no clock of its own (ADR 0432): nothing here reads a time. A part-paid order keeps
// its places until it is paid or staff cancel it, however long that is.
import { confirmStatements, releaseStatements } from "../capacity/holds.ts";
import { queueClaim } from "../capacity/records.ts";
import { ValidationError } from "../errors.ts";
import { getObject } from "../fields/index.ts";
import type { HandlerContext } from "../operation.ts";
import { type MoveHook, onRecordMove } from "../records/lifecycle.ts";
import { orderSoldStatement } from "../stock/index.ts";

export const ORDER_CLAIM_TYPE = "order";

/**
 * The most objects with stock one order may have lines of. A deposit confirms all but them by
 * name, and a confirm binds the names three times: this keeps it under D1's 100 bound variables.
 */
export const STOCK_OBJECTS_PER_ORDER = 20;

/** Whether an order line's object takes places or stock: what an order claims on. */
function claims(object: string): boolean {
  const definition = getObject(object);
  return Boolean(definition?.capacity || definition?.stock);
}

/** A line's object declares stock: its confirmed claim is a sale, never released (ADR 0682). */
function isStock(object: string): boolean {
  return Boolean(getObject(object)?.stock);
}

/** The order's lines whose records have a capacity or stock: what it claims on. */
async function linesWithCapacity(ctx: HandlerContext, orderId: string) {
  const lines = await ctx.db
    .selectFrom("core_order_line")
    .select(["object_type", "record_id", "quantity"])
    .where("order_id", "=", orderId)
    .orderBy("position")
    .execute();
  return lines.filter((line) => claims(line.object_type));
}

/** The stock objects among the lines, once each. */
function stockObjects(lines: readonly { object_type: string }[]): string[] {
  return [...new Set(lines.map((l) => l.object_type).filter(isStock))];
}

/**
 * Confirms the order's held claims, writing first the `sold` movement of each one on stock (one
 * statement, read while they are still held).
 */
function confirmWithSales(
  ctx: HandlerContext,
  orderId: string,
  lines: readonly { object_type: string }[],
): void {
  const sold = orderSoldStatement(orderId, ORDER_CLAIM_TYPE, stockObjects(lines), ctx.now);
  if (sold) ctx.write(sold);
  ctx.write(...confirmStatements({ for: { type: ORDER_CLAIM_TYPE, id: orderId } }, ctx.now));
}

/**
 * Gives back the order's confirmed claims, except those `keeps` says stay (a stock line always;
 * a line whose object declares `releaseOnRefund: false`, on a refund).
 */
async function releaseConfirmedExcept(
  ctx: HandlerContext,
  orderId: string,
  lines: readonly { object_type: string; record_id: string }[],
  keeps: (line: { object_type: string }) => boolean,
): Promise<void> {
  const target = { for: { type: ORDER_CLAIM_TYPE, id: orderId } };
  if (!lines.some(keeps)) {
    ctx.write(...releaseStatements(target, ctx.now, { confirmed: true }));
    return;
  }
  // Some lines keep what they took: release the others, claim by claim.
  const releasing = new Set(
    lines.filter((l) => !keeps(l)).map((l) => `${l.object_type}\u0000${l.record_id}`),
  );
  if (!releasing.size) return;
  const confirmed = await ctx.db
    .selectFrom("core_capacity_claim")
    .select(["id", "object_type", "record_id"])
    .where("for_type", "=", ORDER_CLAIM_TYPE)
    .where("for_id", "=", orderId)
    .where("state", "=", "confirmed")
    .execute();
  for (const claim of confirmed) {
    if (!releasing.has(`${claim.object_type}\u0000${claim.record_id}`)) continue;
    ctx.write(...releaseStatements({ claim: claim.id }, ctx.now, { confirmed: true }));
  }
}

/**
 * Queues the claims for an order's lines, in the batch that writes it: a line whose record has a
 * capacity holds its quantity. Not enough places fails the batch, and no order exists.
 */
export async function claimOrderPlaces(
  ctx: HandlerContext,
  orderId: string,
  lines: readonly { object: string; recordId: string; quantity: number }[],
): Promise<void> {
  const stocked = new Set(lines.map((l) => l.object).filter(isStock));
  if (stocked.size > STOCK_OBJECTS_PER_ORDER) {
    throw new ValidationError(
      `An order can have goods of at most ${STOCK_OBJECTS_PER_ORDER} kinds of record`,
      { rule: "stock", reason: "too_many_objects", max: STOCK_OBJECTS_PER_ORDER },
    );
  }
  for (const line of lines) {
    if (!claims(line.object)) continue;
    await queueClaim(ctx, {
      object: line.object,
      record: line.recordId,
      quantity: line.quantity,
      for: { type: ORDER_CLAIM_TYPE, id: orderId },
    });
  }
}

const orderHolds: MoveHook = async (ctx, move) => {
  const from = move.from?.id ?? null;
  const to = move.to.id;
  const target = { for: { type: ORDER_CLAIM_TYPE, id: move.id } };
  if ((to === "paid" || to === "part_paid") && from !== null && from !== to) {
    if (from !== "pending" && from !== "expired" && from !== "part_paid") return;
    const lines = await linesWithCapacity(ctx, move.id);
    if (from === "expired") {
      // Honoured late: the places went back at expiry. Take them again, then confirm them.
      await claimOrderPlaces(
        ctx,
        move.id,
        lines.map((l) => ({ object: l.object_type, recordId: l.record_id, quantity: l.quantity })),
      );
    }
    if (to === "paid") {
      // Paid in full: every claim still held is confirmed, goods sold (ADR 0682).
      confirmWithSales(ctx, move.id, lines);
      return;
    }
    // A deposit: places are confirmed, goods stay held until the balance is paid.
    ctx.write(
      ...confirmStatements({ ...target, objects: { notIn: stockObjects(lines) } }, ctx.now),
    );
    return;
  }
  if (to === "cancelled" || to === "expired") {
    // Held places and goods go back; from part paid, the confirmed places too.
    ctx.write(...releaseStatements(target, ctx.now));
    if (from === "part_paid") {
      ctx.write(...releaseStatements(target, ctx.now, { confirmed: true }));
    }
    return;
  }
  if (to === "refunded") {
    const lines = await linesWithCapacity(ctx, move.id);
    const keeps = (line: { object_type: string }) =>
      isStock(line.object_type) || getObject(line.object_type)?.capacity?.releaseOnRefund === false;
    await releaseConfirmedExcept(ctx, move.id, lines, keeps);
  }
};

onRecordMove("order", orderHolds);
