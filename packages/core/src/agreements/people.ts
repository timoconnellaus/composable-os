// What erase, the Trash purge and merge do to a Person's agreements (stage 44 step 2, ADR 0642):
// only what the acceptance tables need to stay safe and honest. Step 8 adds the retention purge,
// the erase screen's words and the kept acceptances' search.
//
// Erase (and the Trash purge, which deletes the Person the same way), queued after the Person's
// row is deleted (the triggers allow a detach only once the Person is gone):
//   - their own acceptances are kept, detached (no Person, no account, `erased_at` set), with the
//     version, the time, how, the name typed, the address and the signature, until step 8's purge
//     (decision 15). Their health answers and their minor mark are deleted at once.
//   - acceptances they made as a guardian for a child (coordinator decision of 2026-11-23, owner
//     to confirm): the record that a guardian agreed, the version and the time stay; the
//     guardian, their account, their typed name and their drawn signature are cleared; the
//     address stays, as for their own; `erased_at` is set, so it no longer counts for the child
//     and step 8's purge covers it. The child's health answers are the child's: they stay.
// The database allows exactly these updates (migration 0851); nothing else in an acceptance
// changes.
//
// Merge: acceptances, and acceptances made as a guardian, follow the merged Person to the
// survivor (the trigger allows a move only to the Person's `merged_into_id`, which the merge set
// earlier in its batch); the minor mark is kept if either Person had it.
import { sql } from "kysely";
import type { HandlerContext } from "../operation.ts";

export function queueEraseAgreements(ctx: HandlerContext, personIds: readonly string[]): void {
  if (!personIds.length) return;
  const people = sql`(SELECT value FROM json_each(${JSON.stringify(personIds)}))`;
  ctx.write(
    // Their own: detached. A guardian's account on a child's acceptance is the guardian's: kept.
    sql`UPDATE core_agreement_acceptance SET person_id = NULL, account_id = CASE WHEN by = 'guardian' THEN account_id ELSE NULL END, erased_at = coalesce(erased_at, ${ctx.now}) WHERE person_id IN ${people}`.compile(
      ctx.db,
    ),
    // Their health answers, at once (the trigger allows it once the acceptance is detached).
    sql`DELETE FROM core_agreement_answer WHERE acceptance_id IN (SELECT id FROM core_agreement_acceptance WHERE person_id IS NULL AND erased_at IS NOT NULL AND by != 'guest')`.compile(
      ctx.db,
    ),
    // As a guardian: who agreed is no longer named, nor what they typed or drew.
    sql`UPDATE core_agreement_acceptance SET agent_person_id = NULL, account_id = NULL, typed_name = NULL, erased_at = coalesce(erased_at, ${ctx.now}) WHERE agent_person_id IN ${people}`.compile(
      ctx.db,
    ),
    sql`DELETE FROM core_agreement_signature WHERE acceptance_id IN (SELECT id FROM core_agreement_acceptance WHERE by = 'guardian' AND agent_person_id IS NULL AND erased_at IS NOT NULL)`.compile(
      ctx.db,
    ),
    sql`DELETE FROM core_agreement_minor WHERE person_id IN ${people}`.compile(ctx.db),
  );
}

export function queueMergeAgreements(
  ctx: HandlerContext,
  survivorId: string,
  mergedId: string,
): void {
  ctx.write(
    ctx.db
      .updateTable("core_agreement_acceptance")
      .set({ person_id: survivorId })
      .where("person_id", "=", mergedId),
    ctx.db
      .updateTable("core_agreement_acceptance")
      .set({ agent_person_id: survivorId })
      .where("agent_person_id", "=", mergedId),
    sql`INSERT OR IGNORE INTO core_agreement_minor (person_id, set_by, set_at) SELECT ${survivorId}, set_by, set_at FROM core_agreement_minor WHERE person_id = ${mergedId}`.compile(
      ctx.db,
    ),
    ctx.db.deleteFrom("core_agreement_minor").where("person_id", "=", mergedId),
  );
}

/** Whether a merge would move any agreement record of `mergedId` (ADR 0642: a person's act). */
export async function mergeMovesAgreements(
  ctx: HandlerContext,
  mergedId: string,
): Promise<boolean> {
  const { rows } = await sql<{ n: number }>`SELECT
      EXISTS (SELECT 1 FROM core_agreement_acceptance WHERE person_id = ${mergedId}
        OR agent_person_id = ${mergedId})
      OR EXISTS (SELECT 1 FROM core_agreement_minor WHERE person_id = ${mergedId}) AS n`.execute(
    ctx.db,
  );
  return Boolean(rows[0]?.n);
}
