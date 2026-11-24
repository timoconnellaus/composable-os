// Things a Person may buy once (stage 32b, build step 6, ADR 0512): `sellable.onePerPerson`, a
// boolean field of the object; while it is true on a record, a Person buys it once across every
// record of the object with it true (an intro offer). Migration 0581.
//
// Its shape is the one-trial rule's (ADR 0489), on an order instead of a subscription page:
//
//   - only for a buyer who proved who they are: a signed-in customer, or staff buying for a
//     Person. A guest who typed an address is refused, the same answer for every address, so
//     nobody spends someone else's intro offer or learns whether they had one;
//   - held from the order's start, in the batch that writes the order (`held`); the database's
//     unique index refuses a second held or used row for the Person and object, so of two orders
//     started at once one exists;
//   - used in the batch that first marks the order paid (`used`); given back only when the order
//     expires or is cancelled unpaid (`released`). A refund keeps it used. A late payment staff
//     honour on an expired order takes it again, and is refused (the batch fails, the order stays
//     expired, staff refund) when the Person has had one since.
//
// "A Person" is every live Person sharing a folded address with them (ADR 0692, #225): `a+1@x` and
// `a+2@x` buy one between them. Migration 0955's trigger refuses the second of two orders started
// at once by such People, as the unique index does for one Person.
import { samePeople } from "../customers/accounts.ts";
import { ConflictError, ValidationError } from "../errors.ts";
import { getObject } from "../fields/index.ts";
import { newId } from "../ids.ts";
import type { HandlerContext } from "../operation.ts";
import { type MoveHook, onRecordMove } from "../records/lifecycle.ts";

export interface OnceLine {
  object: string;
  recordId: string;
  quantity: number;
  position: number;
}

/**
 * Refuses what the one-per-Person rule refuses and queues the holds, in the batch that starts the
 * order. `buyer` is who the order is for and how they came.
 */
export async function holdOncePerPerson(
  ctx: HandlerContext,
  orderId: string,
  lines: readonly OnceLine[],
  buyer: { personId: string | null; placedAs: "customer" | "public" | "staff" },
): Promise<void> {
  if (!lines.length) return;
  const refuse = (reason: string, message: string, line: number): never => {
    throw new ValidationError(message, { rule: "once_per_person", reason, line });
  };
  const objects = new Set<string>();
  for (const line of lines) {
    // A guest only typed an address: the same answer whoever's it is.
    if (buyer.placedAs === "public") {
      refuse("sign_in", "Sign in to buy this: it is one per person", line.position);
    }
    if (!buyer.personId) {
      refuse(
        "no_person",
        "This is one per person, and the order is not for one person yet: its address belongs to several people here. Merge them, or start it for one of them",
        line.position,
      );
    }
    if (line.quantity !== 1 || objects.has(line.object)) {
      refuse("one", "This is one per person: one on one order", line.position);
    }
    objects.add(line.object);
  }
  const personId = buyer.personId as string;
  const had = await ctx.db
    .selectFrom("core_sellable_once")
    .select(["object_type", "state", "person_id"])
    .where("person_id", "in", samePeople(ctx.db, personId))
    .where("object_type", "in", [...objects])
    .where("state", "in", ["held", "used"])
    .execute();
  for (const line of lines) {
    const row = had.find((h) => h.object_type === line.object);
    if (!row) continue;
    // A customer is told only about themselves; staff see the same words. Another Person sharing
    // the folded address is named as "the same address" (ADR 0692), never by who they are.
    const whose =
      row.person_id === personId
        ? "for this person"
        : "for someone with this address (a +tag aside)";
    refuse(
      row.state === "used" ? "used" : "held",
      row.state === "used"
        ? `This is one per person, and it has been bought ${whose} already`
        : `This is one per person, and an order for it ${whose} is waiting to be paid`,
      line.position,
    );
  }
  for (const line of lines) {
    ctx.write(
      ctx.db.insertInto("core_sellable_once").values({
        id: newId("sellableOnce"),
        person_id: personId,
        object_type: line.object,
        record_id: line.recordId,
        order_id: orderId,
        state: "held",
        created_at: ctx.now,
        updated_at: ctx.now,
      }),
    );
  }
}

// The database's refusal of a second hold (two orders started at once) is a conflict
// (`rule: "once_per_person"`, `reason: "held"`): errors.ts, toOperationError.

const orderOnce: MoveHook = async (ctx, move) => {
  const from = move.from?.id ?? null;
  const to = move.to.id;
  if ((to === "paid" || to === "part_paid") && from === "pending") {
    ctx.write(
      ctx.db
        .updateTable("core_sellable_once")
        .set({ state: "used", updated_at: ctx.now })
        .where("order_id", "=", move.id)
        .where("state", "=", "held"),
    );
    return;
  }
  if ((to === "paid" || to === "part_paid") && from === "expired") {
    // Honoured late: the hold went back at expiry. Take it again, used; refused by the unique
    // index (or migration 0955's trigger) when the Person has had one since, which fails the
    // batch (staff refund instead).
    const released = await ctx.db
      .selectFrom("core_sellable_once")
      .select(["person_id", "object_type", "record_id"])
      .where("order_id", "=", move.id)
      .where("state", "=", "released")
      .execute();
    for (const row of released) {
      if (!getObject(row.object_type)?.sellable?.onePerPerson) continue;
      const since = await ctx.db
        .selectFrom("core_sellable_once")
        .select("id")
        .where("person_id", "in", samePeople(ctx.db, row.person_id))
        .where("object_type", "=", row.object_type)
        .where("state", "in", ["held", "used"])
        .executeTakeFirst();
      if (since) {
        throw new ConflictError(
          "This late payment cannot be honoured: it is for something one per person, and the " +
            "person has had theirs since the order expired. Refund the payment instead",
          { rule: "once_per_person", reason: "had_since", order: move.id },
        );
      }
      ctx.write(
        ctx.db.insertInto("core_sellable_once").values({
          id: newId("sellableOnce"),
          person_id: row.person_id,
          object_type: row.object_type,
          record_id: row.record_id,
          order_id: move.id,
          state: "used",
          created_at: ctx.now,
          updated_at: ctx.now,
        }),
      );
    }
    return;
  }
  if ((to === "expired" || to === "cancelled") && from === "pending") {
    ctx.write(
      ctx.db
        .updateTable("core_sellable_once")
        .set({ state: "released", updated_at: ctx.now })
        .where("order_id", "=", move.id)
        .where("state", "=", "held"),
    );
  }
};

onRecordMove("order", orderOnce);
