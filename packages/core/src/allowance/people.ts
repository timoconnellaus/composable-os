// A Person merged or erased (stage 32b, ADR 0494), following what stage 32a does for
// subscriptions: a merge moves the merged Person's holders' terms and uses to the survivor, in the
// merge's own batch (their holder and spender records are repointed by the merge's relation
// repointing), so the survivor keeps what the merged one held and what they had spent. An erase
// deletes the erased Person's allowance rows: their holders' terms, periods and uses, and every
// use they spent. Uses are attendance, not money: unlike an order, nothing the books need. A
// Person purged from the Trash goes the same way (trash.purge), and while in the Trash their
// holders pay for nothing (migration 0533's trigger).
import { sql } from "kysely";
import type { HandlerContext } from "../operation.ts";

export function queueMergeAllowances(
  ctx: HandlerContext,
  survivorId: string,
  mergedId: string,
): void {
  ctx.write(
    ctx.db
      .updateTable("core_allowance")
      .set({ person_id: survivorId, updated_at: ctx.now })
      .where("person_id", "=", mergedId),
    ctx.db
      .updateTable("core_allowance_use")
      .set({ person_id: survivorId })
      .where("person_id", "=", mergedId),
  );
}

/**
 * Queues the statements that erase People's allowance rows: their holders (terms, periods and
 * every use of them) and every use they spent. A use they spent that is still open is given back
 * to its holder's count first, so a count never keeps a use whose row is gone.
 */
export function queueEraseAllowances(ctx: HandlerContext, personIds: readonly string[]): void {
  if (!personIds.length) return;
  const ids = JSON.stringify(personIds);
  const people = sql`(SELECT value FROM json_each(${ids}))`;
  ctx.write(
    sql`UPDATE core_allowance_period SET used = used - (SELECT count(*) FROM core_allowance_use u WHERE u.returned_at IS NULL AND u.person_id IN ${people} AND u.object_type = core_allowance_period.object_type AND u.record_id = core_allowance_period.record_id AND u.period = core_allowance_period.period AND u.zone = core_allowance_period.zone), updated_at = ${ctx.now} WHERE (object_type, record_id, period, zone) IN (SELECT object_type, record_id, period, zone FROM core_allowance_use WHERE returned_at IS NULL AND person_id IN ${people})`.compile(
      ctx.db,
    ),
    sql`DELETE FROM core_allowance_use WHERE person_id IN ${people} OR (object_type, record_id) IN (SELECT object_type, record_id FROM core_allowance WHERE person_id IN ${people})`.compile(
      ctx.db,
    ),
    sql`DELETE FROM core_allowance_period WHERE (object_type, record_id) IN (SELECT object_type, record_id FROM core_allowance WHERE person_id IN ${people})`.compile(
      ctx.db,
    ),
    sql`DELETE FROM core_allowance WHERE person_id IN ${people}`.compile(ctx.db),
  );
}
