// A person merge moves their orders (issue #221, stage 32a review): the merged Person's orders
// become the survivor's, in the merge's own batch, so the survivor reads them as a customer
// (orders and their lines follow `core_order.person_id`; lines, payments, refunds and grants
// belong to the order, not to a Person), and their paid periods of a moved subscription with them.
//
// What a paid line granted (a ticket, an enrolment) is an extension record whose holder is a
// relation to the Person: `queueRepointRelations` moves those in the same merge. An order keeps
// the address it was placed with (`email`): that is what the buyer typed, and the receipt it was
// sent to. "Has this person bought" (`hasBought`) reads the Person's orders as well as the
// address's, so the survivor still counts as a buyer under any of their addresses.
import type { HandlerContext } from "../operation.ts";

export function queueMergeOrders(ctx: HandlerContext, survivorId: string, mergedId: string): void {
  ctx.write(
    ctx.db
      .updateTable("core_order")
      .set({ person_id: survivorId, updated_at: ctx.now })
      .where("person_id", "=", mergedId),
    // Things sold once per Person (ADR 0512) move too, so the survivor does not get a second
    // intro offer. Where both had one on an object, the survivor's is kept and the merged one's
    // is released first (the unique index allows one held or used row per Person and object).
    ctx.db
      .updateTable("core_sellable_once")
      .set({ state: "released", updated_at: ctx.now })
      .where("person_id", "=", mergedId)
      .where("state", "in", ["held", "used"])
      .where((eb) =>
        eb.exists(
          eb
            .selectFrom("core_sellable_once as s")
            .select("s.id")
            .whereRef("s.object_type", "=", "core_sellable_once.object_type")
            .where("s.person_id", "=", survivorId)
            .where("s.state", "in", ["held", "used"]),
        ),
      ),
    ctx.db
      .updateTable("core_sellable_once")
      .set({ person_id: survivorId, updated_at: ctx.now })
      .where("person_id", "=", mergedId),
  );
}
