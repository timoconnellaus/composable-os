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
//                                             declares `releaseOnRefund: false`
//
// A hold has no clock of its own (ADR 0432): nothing here reads a time. A part-paid order keeps
// its places until it is paid or staff cancel it, however long that is.
import { confirmStatements, releaseStatements } from "../capacity/holds.ts";
import { queueClaim } from "../capacity/records.ts";
import { getObject } from "../fields/index.ts";
import type { HandlerContext } from "../operation.ts";
import { type MoveHook, onRecordMove } from "../records/lifecycle.ts";

export const ORDER_CLAIM_TYPE = "order";

/** The order's lines whose records have a capacity: what it claims places on. */
async function linesWithCapacity(ctx: HandlerContext, orderId: string) {
  const lines = await ctx.db
    .selectFrom("core_order_line")
    .select(["object_type", "record_id", "quantity"])
    .where("order_id", "=", orderId)
    .orderBy("position")
    .execute();
  return lines.filter((line) => getObject(line.object_type)?.capacity);
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
  for (const line of lines) {
    if (!getObject(line.object)?.capacity) continue;
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
  if ((to === "paid" || to === "part_paid") && from === "expired") {
    // Honoured late: the places went back at expiry. Take them again, then confirm them.
    const lines = await linesWithCapacity(ctx, move.id);
    await claimOrderPlaces(
      ctx,
      move.id,
      lines.map((l) => ({ object: l.object_type, recordId: l.record_id, quantity: l.quantity })),
    );
    ctx.write(...confirmStatements(target, ctx.now));
    return;
  }
  if ((to === "paid" || to === "part_paid") && from === "pending") {
    ctx.write(...confirmStatements(target, ctx.now));
    return;
  }
  if (to === "cancelled" || to === "expired") {
    ctx.write(...releaseStatements(target, ctx.now, { confirmed: from === "part_paid" }));
    return;
  }
  if (to === "refunded") {
    const lines = await linesWithCapacity(ctx, move.id);
    const keeps = (line: { object_type: string }) =>
      getObject(line.object_type)?.capacity?.releaseOnRefund === false;
    if (!lines.some(keeps)) {
      ctx.write(...releaseStatements(target, ctx.now, { confirmed: true }));
      return;
    }
    // Some lines keep their places after a refund (their object says so): release the others.
    const releasing = new Set(
      lines.filter((l) => !keeps(l)).map((l) => `${l.object_type}\u0000${l.record_id}`),
    );
    if (!releasing.size) return;
    const claims = await ctx.db
      .selectFrom("core_capacity_claim")
      .select(["id", "object_type", "record_id"])
      .where("for_type", "=", ORDER_CLAIM_TYPE)
      .where("for_id", "=", move.id)
      .where("state", "=", "confirmed")
      .execute();
    for (const claim of claims) {
      if (!releasing.has(`${claim.object_type}\u0000${claim.record_id}`)) continue;
      ctx.write(...releaseStatements({ claim: claim.id }, ctx.now, { confirmed: true }));
    }
  }
};

onRecordMove("order", orderHolds);
