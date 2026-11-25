// Practitioner accounts when two people merge (stage 43 step 3, ADR 0581), queued in person.merge's
// batch. A practitioner account belongs to one Person (its own: their name and contact).
//
// - The duplicate's account moves to the survivor, so it never points at a merged-away Person.
// - When both people have one, the merge is refused: one Person has one practitioner account, and
//   which one to keep is a person's choice (end the other first, practitioner.end).
//
// The care-link rules of a merge (stage 43 step 4: a merge that would make a practitioner their
// own client is refused) are not here yet: no care link exists in this step. Accounts are not
// records: this reads `core_practitioner` only.
import { ConflictError } from "../errors.ts";
import type { HandlerContext } from "../operation.ts";

/**
 * Queues what merging `mergedId` into `survivorId` does to their practitioner accounts. Throws a
 * ConflictError, before anything is queued, when both have one.
 */
export async function queueMergePractitioners(
  ctx: HandlerContext,
  survivorId: string,
  mergedId: string,
): Promise<void> {
  const accounts = await ctx.db
    .selectFrom("core_practitioner")
    .select(["id", "person_id", "status"])
    .where("person_id", "in", [survivorId, mergedId])
    .execute();
  const merged = accounts.find((a) => a.person_id === mergedId);
  if (!merged) return;
  const survivor = accounts.find((a) => a.person_id === survivorId);
  if (survivor) {
    throw new ConflictError(
      "Both people have a practitioner account. End one of them first, then merge.",
      { rule: "practitioner_accounts", practitionerIds: [survivor.id, merged.id] },
    );
  }
  ctx.write(
    ctx.db
      .updateTable("core_practitioner")
      .set({ person_id: survivorId, updated_at: ctx.now })
      .where("id", "=", merged.id)
      .where("person_id", "=", mergedId),
  );
  ctx.recordChange({
    object: "practitioner",
    id: merged.id,
    action: "update",
    before: { personId: mergedId },
    after: { personId: survivorId },
  });
}
