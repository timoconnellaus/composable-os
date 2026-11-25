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
//
// Things sold once per Person (the intro offer, ADR 0512) move too, and the survivor ends with
// at most one held or used per object, preferring a used one (it was had) over a held one (an
// order waiting to be paid). The one released, when it was held, leaves its pending order without
// its claim: if that order is paid later, its once-per-Person line grants nothing and staff are
// told to refund it (orders/grants.ts), so a merge never yields a second intro offer.
//
// Discount uses (ADR 0693) move to the survivor, so their per-person limits count them as one.
import { queueMergeDiscountUses } from "../discounts/uses.ts";
import type { HandlerContext } from "../operation.ts";

export async function queueMergeOrders(
  ctx: HandlerContext,
  survivorId: string,
  mergedId: string,
): Promise<void> {
  ctx.write(
    ctx.db
      .updateTable("core_order")
      .set({ person_id: survivorId, updated_at: ctx.now })
      .where("person_id", "=", mergedId),
  );
  // Their discount uses too (ADR 0693): the two already counted as one for a per-person limit
  // only when they shared a folded address; from now on they are one Person.
  queueMergeDiscountUses(ctx, survivorId, mergedId);
  const rows = await ctx.db
    .selectFrom("core_sellable_once")
    .select(["id", "person_id", "object_type", "state", "created_at"])
    .where("person_id", "in", [survivorId, mergedId])
    .where("state", "in", ["held", "used"])
    .execute();
  const byObject = new Map<string, typeof rows>();
  for (const row of rows)
    byObject.set(row.object_type, [...(byObject.get(row.object_type) ?? []), row]);
  const release: string[] = [];
  for (const [, held] of byObject) {
    if (held.length < 2) continue;
    // Used beats held; between equals, the survivor's (then the earliest).
    const rank = (r: (typeof rows)[number]) =>
      (r.state === "used" ? 0 : 2) + (r.person_id === survivorId ? 0 : 1);
    const sorted = [...held].sort(
      (a, b) => rank(a) - rank(b) || a.created_at.localeCompare(b.created_at),
    );
    for (const loser of sorted.slice(1)) release.push(loser.id);
  }
  // Released first: the unique index allows one held or used row per Person and object.
  if (release.length) {
    ctx.write(
      ctx.db
        .updateTable("core_sellable_once")
        .set({ state: "released", updated_at: ctx.now })
        .where("id", "in", release),
    );
  }
  ctx.write(
    ctx.db
      .updateTable("core_sellable_once")
      .set({ person_id: survivorId, updated_at: ctx.now })
      .where("person_id", "=", mergedId),
  );
}
