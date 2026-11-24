// A person's codes when People are erased or merged (stage 51 step 3, ADR 0783).
//
// Erase (ADR 0320): the erased People's app codes, cards and PIN go in the erase's batch, and the
// dependants' codes shown on their app (the foreign keys would delete them too; this says so).
// The door log's rows and the device's handles are stage 51's later steps'.
//
// Merge: the merged Person's cards move to the survivor. App codes are not moved: those of the
// merged Person and those shown on their app are deleted, and the next `me.code` makes them again
// for whoever the sign-in now belongs to. The survivor's PIN is kept and the merged one's deleted.
import type { HandlerContext } from "../operation.ts";
import { jsonList } from "../records/common.ts";

/** Queues the deletes of the erased People's codes, cards and PIN. */
export function queueErasePersonCodes(ctx: HandlerContext, personIds: readonly string[]): void {
  if (!personIds.length) return;
  // One bound parameter per list, however many People (a merged chain).
  const ids = jsonList([...personIds]);
  ctx.write(
    ctx.db
      .deleteFrom("core_person_code")
      .where((eb) => eb.or([eb("person_id", "in", ids), eb("guardian_id", "in", ids)])),
    ctx.db.deleteFrom("core_person_pin").where("person_id", "in", ids),
  );
}

/** Queues what a merge of `mergedId` into `survivorId` does to their codes and PINs. */
export function queueMergePersonCodes(
  ctx: HandlerContext,
  survivorId: string,
  mergedId: string,
): void {
  ctx.write(
    ctx.db
      .deleteFrom("core_person_code")
      .where("kind", "=", "app")
      .where((eb) => eb.or([eb("person_id", "=", mergedId), eb("guardian_id", "=", mergedId)])),
    ctx.db
      .updateTable("core_person_code")
      .set({ person_id: survivorId })
      .where("kind", "=", "card")
      .where("person_id", "=", mergedId),
    ctx.db.deleteFrom("core_person_pin").where("person_id", "=", mergedId),
  );
}
