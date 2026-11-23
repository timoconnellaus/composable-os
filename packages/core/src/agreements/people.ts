// What erase, the Trash purge and merge do to a Person's agreements (stage 44 step 2, ADR 0642):
// only what the acceptance tables need to stay safe and honest. Step 8 adds the retention purge,
// the erase screen's words and the kept acceptances' search; this keeps decision 15's core now.
//
// Erase (and the Trash purge, which deletes the Person the same way): their health answers are
// deleted at once, their minor mark too, and each of their acceptances is kept detached (no
// Person, `erased_at` set) for step 8's retention purge. An acceptance they made as a guardian
// stays the child's, with the guardian cleared. The database allows exactly these updates
// (migration 0851); nothing else in an acceptance changes.
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
    // Detached first: the answers' and signatures' delete triggers allow it only then.
    sql`UPDATE core_agreement_acceptance SET person_id = NULL, agent_person_id = NULL, account_id = NULL, erased_at = ${ctx.now} WHERE person_id IN ${people}`.compile(
      ctx.db,
    ),
    sql`DELETE FROM core_agreement_answer WHERE acceptance_id IN (SELECT id FROM core_agreement_acceptance WHERE erased_at IS NOT NULL AND person_id IS NULL)`.compile(
      ctx.db,
    ),
    // As a guardian: the child's acceptance stays the child's; who agreed is no longer named.
    sql`UPDATE core_agreement_acceptance SET agent_person_id = NULL, account_id = NULL WHERE agent_person_id IN ${people}`.compile(
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
