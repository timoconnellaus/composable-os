// A discount's uses (stage 34 step 4, ADR 0693, migration 0953), on the shape of things sold once
// per Person (orders/once.ts, ADR 0512):
//
//   - held from the order's start, in the batch that writes the order (or that puts a code on a
//     pending order); the database's trigger refuses the use past a limit (total, per code, per
//     Person with folded addresses as one), so of two orders started at once at the last use, one
//     exists;
//   - used in the batch that first marks the order paid or part paid;
//   - released when the unpaid order expires or is cancelled, and when its deal changes before it
//     is paid (order.applyCode, order.removeCode). A refund keeps it used;
//   - a late payment honoured on an expired order takes it again, judged by the limits again: the
//     batch fails when it is past one (staff refund instead).
import type { CoreDatabase } from "@composable-os/db";
import type { Selectable } from "kysely";
import { samePeople } from "../customers/accounts.ts";
import { ConflictError } from "../errors.ts";
import { newId } from "../ids.ts";
import type { HandlerContext } from "../operation.ts";
import { type MoveHook, onRecordMove } from "../records/lifecycle.ts";
import type { Deal, DealBuyer } from "./deal.ts";

/** Queues the deal's use, held, in the calling batch, after the order it names. */
export function holdDealUse(
  ctx: HandlerContext,
  orderId: string,
  deal: Deal,
  buyer: DealBuyer,
): void {
  ctx.write(
    ctx.db.insertInto("core_discount_use").values({
      id: newId("discountUse"),
      discount_object: deal.discountObject,
      discount_id: deal.discountId,
      code_object: deal.codeObject,
      code_id: deal.codeId,
      kind: deal.kind,
      person_id: buyer.personId,
      order_id: orderId,
      state: "held",
      amount: deal.amount,
      max_uses: deal.limits.maxUses,
      max_per_person: deal.limits.maxPerPerson,
      code_max_uses: deal.limits.codeMaxUses,
      created_at: ctx.now,
      updated_at: ctx.now,
    }),
  );
}

/** Queues giving back an order's held use (its deal is changing, or it ended unpaid). */
export function releaseDealUses(ctx: HandlerContext, orderId: string): void {
  ctx.write(
    ctx.db
      .updateTable("core_discount_use")
      .set({ state: "released", updated_at: ctx.now })
      .where("order_id", "=", orderId)
      .where("state", "=", "held"),
  );
}

/** A person merge: the merged Person's uses become the survivor's (they count as one already). */
export function queueMergeDiscountUses(
  ctx: HandlerContext,
  survivorId: string,
  mergedId: string,
): void {
  ctx.write(
    ctx.db
      .updateTable("core_discount_use")
      .set({ person_id: survivorId, updated_at: ctx.now })
      .where("person_id", "=", mergedId),
  );
}

type UseRow = Selectable<CoreDatabase["core_discount_use"]>;

/** Whether taking `use` again would pass one of the limits copied onto it (the trigger's rules). */
async function pastLimit(ctx: HandlerContext, use: UseRow): Promise<boolean> {
  const taken = (filter: "discount" | "code" | "person") => {
    let query = ctx.db
      .selectFrom("core_discount_use")
      .select((eb) => eb.fn.countAll<number>().as("n"))
      .where("state", "in", ["held", "used"]);
    if (filter === "code") {
      query = query.where("code_id", "=", use.code_id as string);
    } else {
      query = query
        .where("discount_object", "=", use.discount_object)
        .where("discount_id", "=", use.discount_id);
    }
    if (filter === "person") {
      query = query.where("person_id", "in", samePeople(ctx.db, use.person_id as string));
    }
    return query.executeTakeFirst().then((row) => Number(row?.n ?? 0));
  };
  if (use.max_uses !== null && (await taken("discount")) >= use.max_uses) return true;
  if (use.code_max_uses !== null && use.code_id && (await taken("code")) >= use.code_max_uses) {
    return true;
  }
  return (
    use.max_per_person !== null &&
    use.person_id !== null &&
    (await taken("person")) >= use.max_per_person
  );
}

const orderUses: MoveHook = async (ctx, move) => {
  const from = move.from?.id ?? null;
  const to = move.to.id;
  if ((to === "paid" || to === "part_paid") && from === "pending") {
    ctx.write(
      ctx.db
        .updateTable("core_discount_use")
        .set({ state: "used", updated_at: ctx.now })
        .where("order_id", "=", move.id)
        .where("state", "=", "held"),
    );
    return;
  }
  if ((to === "paid" || to === "part_paid") && from === "expired") {
    // Honoured late: the use of the deal still on the order went back at expiry. Taken again,
    // used; the trigger refuses it past a limit, which fails the batch (staff refund instead).
    const deal = await ctx.db
      .selectFrom("core_order_adjustment")
      .select("source_id")
      .where("order_id", "=", move.id)
      .where("kind", "in", ["code", "automatic"])
      .where("removed_at", "is", null)
      .executeTakeFirst();
    if (!deal?.source_id) return;
    const released = await ctx.db
      .selectFrom("core_discount_use")
      .selectAll()
      .where("order_id", "=", move.id)
      .where("discount_id", "=", deal.source_id)
      .where("state", "=", "released")
      .orderBy("updated_at", "desc")
      .orderBy("id", "desc")
      .limit(1)
      .executeTakeFirst();
    if (!released) return;
    // Past a limit since the order expired (another order took the last use): refused with words
    // for the person honouring it, before anything is written, as once.ts does. The trigger stays
    // the backstop for one taken at the same moment.
    if (await pastLimit(ctx, released)) {
      throw new ConflictError(
        "This late payment cannot be honoured: its discount has been used up since the order " +
          "expired (another order took the last use). Refund the payment instead",
        { rule: "discount_used_up", reason: "had_since", order: move.id },
      );
    }
    ctx.write(
      ctx.db.insertInto("core_discount_use").values({
        ...released,
        id: newId("discountUse"),
        state: "used",
        created_at: ctx.now,
        updated_at: ctx.now,
      }),
    );
    return;
  }
  if ((to === "expired" || to === "cancelled") && from === "pending") {
    releaseDealUses(ctx, move.id);
  }
};

onRecordMove("order", orderUses);
