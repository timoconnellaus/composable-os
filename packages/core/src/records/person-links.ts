// Family links when People are merged or erased (stage 31a step 6, ADR 0540).
//
// A merge re-points the merged Person's links to the survivor in the merge's own batch, so a child
// merged into their own record keeps their guardians and a parent merged keeps their children. A
// link between the two (which would become a link from a Person to themselves) is deleted, and a
// live link the survivor already has with the same Person the same way round is ended as a
// duplicate before the rest move. Ended links move too: they are the history of who could act for
// whom.
//
// An erase deletes every link of the erased People, live or ended, in the erase's batch (the
// foreign keys would too; this says so). A dependant left with no live guardian is not erased:
// staff are told on the dependant's timeline, naming no one, and in the erase's answer.
import { sql } from "kysely";
import type { HandlerContext } from "../operation.ts";
import { GUARDIAN_LINK } from "../visibility/guardians.ts";
import { jsonList } from "./common.ts";

/** How many of the merged Person's links there are, live and ended (for the merge's answer). */
export async function countMergedLinks(ctx: HandlerContext, mergedId: string): Promise<number> {
  const row = await ctx.db
    .selectFrom("core_person_link")
    .select((eb) => eb.fn.countAll<number>().as("n"))
    .where((eb) => eb.or([eb("guardian_id", "=", mergedId), eb("dependant_id", "=", mergedId)]))
    .where("ended_at", "is", null)
    .executeTakeFirst();
  return Number(row?.n ?? 0);
}

/** Queues the statements that move the merged Person's links to the survivor. */
export function queueMergeLinks(ctx: HandlerContext, survivorId: string, mergedId: string): void {
  const end = { ended_at: ctx.now, ended_by: ctx.user.id, end_reason: "merged: a duplicate" };
  ctx.write(
    // A link between the two would link the survivor to themselves: dropped.
    ctx.db
      .deleteFrom("core_person_link")
      .where((eb) =>
        eb.or([
          eb.and([eb("guardian_id", "=", mergedId), eb("dependant_id", "=", survivorId)]),
          eb.and([eb("guardian_id", "=", survivorId), eb("dependant_id", "=", mergedId)]),
        ]),
      ),
    // A live link the survivor already has the same way round: the merged one is a duplicate.
    ctx.db
      .updateTable("core_person_link")
      .set(end)
      .where("ended_at", "is", null)
      .where("guardian_id", "=", mergedId)
      .where(
        sql<boolean>`EXISTS (SELECT 1 FROM core_person_link s WHERE s.ended_at IS NULL AND s.kind = core_person_link.kind AND s.guardian_id = ${survivorId} AND s.dependant_id = core_person_link.dependant_id)`,
      ),
    ctx.db
      .updateTable("core_person_link")
      .set(end)
      .where("ended_at", "is", null)
      .where("dependant_id", "=", mergedId)
      .where(
        sql<boolean>`EXISTS (SELECT 1 FROM core_person_link s WHERE s.ended_at IS NULL AND s.kind = core_person_link.kind AND s.dependant_id = ${survivorId} AND s.guardian_id = core_person_link.guardian_id)`,
      ),
    ctx.db
      .updateTable("core_person_link")
      .set({ guardian_id: survivorId })
      .where("guardian_id", "=", mergedId),
    ctx.db
      .updateTable("core_person_link")
      .set({ dependant_id: survivorId })
      .where("dependant_id", "=", mergedId),
  );
}

/**
 * The dependants who have a live guardian among `personIds` and none outside them: after the
 * erase they have no guardian left. Read before the erase's batch.
 */
export async function dependantsLeftAlone(
  ctx: HandlerContext,
  personIds: readonly string[],
): Promise<string[]> {
  if (!personIds.length) return [];
  const erased = jsonList([...personIds]);
  const rows = await ctx.db
    .selectFrom("core_person_link as l")
    .select("l.dependant_id")
    .distinct()
    .where("l.kind", "=", GUARDIAN_LINK)
    .where("l.ended_at", "is", null)
    .where("l.guardian_id", "in", erased)
    .where("l.dependant_id", "not in", erased)
    .where(
      sql<boolean>`NOT EXISTS (SELECT 1 FROM core_person_link o WHERE o.dependant_id = l.dependant_id AND o.kind = l.kind AND o.ended_at IS NULL AND o.guardian_id NOT IN ${erased})`,
    )
    .execute();
  return rows.map((row) => row.dependant_id);
}

/**
 * Queues the erase of People's links (live and ended), and a note on each dependant left with no
 * guardian. The note names no one: the erased guardian's name must not outlive them.
 */
export function queueEraseLinks(
  ctx: HandlerContext,
  personIds: readonly string[],
  leftAlone: readonly string[] = [],
): void {
  if (!personIds.length) return;
  const erased = jsonList([...personIds]);
  ctx.write(
    ctx.db
      .deleteFrom("core_person_link")
      .where((eb) => eb.or([eb("guardian_id", "in", erased), eb("dependant_id", "in", erased)])),
  );
  for (const id of leftAlone) {
    ctx.postActivity({
      subject: "No guardian linked any more",
      body:
        "The record of this person's only linked guardian was erased. Nobody can book for them " +
        "until staff link a guardian again.",
      payload: { kind: "person_link", action: "guardian_erased" },
      links: [{ object: "person", id }],
    });
  }
}
