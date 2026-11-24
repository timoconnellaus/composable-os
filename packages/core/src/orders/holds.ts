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
//   to `cancelled` or `expired`               release: held places from `pending`, confirmed
//                                             ones from `part_paid`
//   to `refunded`                             release confirmed places, unless a line's object
//                                             declares `releaseOnRefund: false` or `stock`
//
// Stock (stage 37, ADR 0680) holds and confirms through the same claims. When they are confirmed
// the order's stock lines write their `sold` movements in the paid batch (one statement before
// the confirm); confirmed stock is never given back by an order's move (a refund, or a cancel
// after a deposit): only a return puts goods back on the shelf.
//
// A hold has no clock of its own (ADR 0432): nothing here reads a time. A part-paid order keeps
// its places until it is paid or staff cancel it, however long that is.
import { confirmStatements, releaseStatements } from "../capacity/holds.ts";
import { queueClaim } from "../capacity/records.ts";
import { getObject } from "../fields/index.ts";
import type { HandlerContext } from "../operation.ts";
import { type MoveHook, onRecordMove } from "../records/lifecycle.ts";
import { soldStatement } from "../stock/index.ts";

export const ORDER_CLAIM_TYPE = "order";

/** A line's record keeps a counter: its object has a capacity or stock (ADR 0680). */
const counted = (object: string) => {
  const definition = getObject(object);
  return Boolean(definition?.capacity || definition?.stock);
};

/** The order's lines whose records have a capacity or stock: what it claims on. */
async function linesWithCapacity(ctx: HandlerContext, orderId: string) {
  const lines = await ctx.db
    .selectFrom("core_order_line")
    .select(["object_type", "record_id", "quantity"])
    .where("order_id", "=", orderId)
    .orderBy("position")
    .execute();
  return lines.filter((line) => counted(line.object_type));
}

/**
 * Queues the claims for an order's lines, in the batch that writes it: a line whose record has a
 * capacity or stock holds its quantity. Not enough fails the batch, and no order exists.
 */
export async function claimOrderPlaces(
  ctx: HandlerContext,
  orderId: string,
  lines: readonly { object: string; recordId: string; quantity: number }[],
): Promise<void> {
  for (const line of lines) {
    if (!counted(line.object)) continue;
    await queueClaim(ctx, {
      object: line.object,
      record: line.recordId,
      quantity: line.quantity,
      for: { type: ORDER_CLAIM_TYPE, id: orderId },
    });
  }
}

/**
 * Confirms the order's held claims, writing the `sold` movements of its stock lines first (one
 * statement, ADR 0680): what was held is sold.
 */
function confirmOrder(
  ctx: HandlerContext,
  orderId: string,
  lines: readonly { object_type: string }[],
): void {
  const sold = soldStatement(
    orderId,
    lines.map((l) => l.object_type),
    ctx.now,
  );
  if (sold) ctx.write(sold);
  ctx.write(...confirmStatements({ for: { type: ORDER_CLAIM_TYPE, id: orderId } }, ctx.now));
}

/**
 * Gives back the order's confirmed claims except those of lines that `keeps`: one by one, after a
 * read of them (at most one per line).
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
  const releasing = new Set(
    lines.filter((l) => !keeps(l)).map((l) => `${l.object_type}\u0000${l.record_id}`),
  );
  if (!releasing.size) return;
  const claims = await ctx.db
    .selectFrom("core_capacity_claim")
    .select(["id", "object_type", "record_id"])
    .where("for_type", "=", ORDER_CLAIM_TYPE)
    .where("for_id", "=", orderId)
    .where("state", "=", "confirmed")
    .execute();
  for (const claim of claims) {
    if (!releasing.has(`${claim.object_type}\u0000${claim.record_id}`)) continue;
    ctx.write(...releaseStatements({ claim: claim.id }, ctx.now, { confirmed: true }));
  }
}

/** Sold stock stays sold: only a return puts it back (ADR 0680). */
const isStock = (line: { object_type: string }) => Boolean(getObject(line.object_type)?.stock);

const orderHolds: MoveHook = async (ctx, move) => {
  const from = move.from?.id ?? null;
  const to = move.to.id;
  const target = { for: { type: ORDER_CLAIM_TYPE, id: move.id } };
  if ((to === "paid" || to === "part_paid") && from === "expired") {
    // Honoured late: the places went back at expiry. Take them again, then confirm them.
    const lines = await linesWithCapacity(ctx, move.id);
    await claimOrderPlaces(
      ctx,
      move.id,
      lines.map((l) => ({ object: l.object_type, recordId: l.record_id, quantity: l.quantity })),
    );
    confirmOrder(ctx, move.id, lines);
    return;
  }
  if ((to === "paid" || to === "part_paid") && from === "pending") {
    confirmOrder(ctx, move.id, await linesWithCapacity(ctx, move.id));
    return;
  }
  if (to === "cancelled" || to === "expired") {
    if (from !== "part_paid") {
      ctx.write(...releaseStatements(target, ctx.now));
      return;
    }
    // After a deposit the claims were confirmed: places go back, sold stock does not.
    await releaseConfirmedExcept(ctx, move.id, await linesWithCapacity(ctx, move.id), isStock);
    return;
  }
  if (to === "refunded") {
    // A refund gives places back unless a line's object says otherwise, and never stock.
    const keeps = (line: { object_type: string }) =>
      isStock(line) || getObject(line.object_type)?.capacity?.releaseOnRefund === false;
    await releaseConfirmedExcept(ctx, move.id, await linesWithCapacity(ctx, move.id), keeps);
  }
};

onRecordMove("order", orderHolds);
