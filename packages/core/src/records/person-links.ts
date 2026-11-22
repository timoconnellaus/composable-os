// Family links when People are merged or erased (stage 31a step 6, ADR 0540).
//
// A merge re-points the merged Person's links to the survivor in the merge's own batch, so a child
// merged into their own record keeps their guardians and a parent merged keeps their children. A
// link between the two (which would become a link from a Person to themselves) is deleted; a live
// link the survivor already has with the same Person the same way round is a duplicate, and one the
// other way round would make a two-way link: the merged one ends in either case. The rest move;
// ended links too, as the history of who could act for whom. A merge touching a live link is a
// person's act (person-approves.ts).
//
// An erase deletes every link of the erased People, live or ended, in the erase's batch (the
// foreign keys would too; this says so). A dependant left with no live guardian is not erased:
// staff are told on the dependant's timeline, naming no one, and in the erase's answer.
import { sql } from "kysely";
import type { HandlerContext } from "../operation.ts";
import { GUARDIAN_LINK } from "../visibility/guardians.ts";
import { jsonList } from "./common.ts";

/** What a merge does to the merged Person's links (ADR 0540), read before its batch. */
export interface MergeLinkPlan {
  /** Live links that move to the survivor and keep giving what they gave. */
  readonly moved: number;
  /** Live links ended instead: a duplicate of one the survivor has, or one whose reverse is live. */
  readonly ended: number;
  /** Links between the two People (live or ended): they would link a Person to themselves. */
  readonly deleted: number;
  /** Links that had already ended: they move as history. */
  readonly history: number;
  /** The ids ended, and why. */
  readonly ends: readonly { readonly id: string; readonly reason: string }[];
}

/** Any Person with a live link: whether a merge of them is a person's act (ADR 0540). */
export async function hasLiveLink(
  db: HandlerContext["db"],
  personIds: readonly string[],
): Promise<boolean> {
  if (!personIds.length) return false;
  const ids = jsonList([...personIds]);
  const row = await db
    .selectFrom("core_person_link")
    .select("id")
    .where("ended_at", "is", null)
    .where((eb) => eb.or([eb("guardian_id", "in", ids), eb("dependant_id", "in", ids)]))
    .executeTakeFirst();
  return row !== undefined;
}

/**
 * Plans the merge of `mergedId` into `survivorId` for the links: which are deleted (between the
 * two), which live ones end (a duplicate of the survivor's same-direction link, or one whose
 * reverse the survivor has live: never a two-way link, which would let a child act for a parent),
 * and which move.
 */
export async function planMergeLinks(
  db: HandlerContext["db"],
  survivorId: string,
  mergedId: string,
): Promise<MergeLinkPlan> {
  const rows = await db
    .selectFrom("core_person_link")
    .select(["id", "guardian_id", "dependant_id", "ended_at"])
    .where((eb) =>
      eb.or([
        eb("guardian_id", "in", [survivorId, mergedId]),
        eb("dependant_id", "in", [survivorId, mergedId]),
      ]),
    )
    .execute();
  const live = (g: string, d: string) =>
    rows.some((r) => r.ended_at === null && r.guardian_id === g && r.dependant_id === d);
  let moved = 0;
  let deleted = 0;
  let history = 0;
  const ends: { id: string; reason: string }[] = [];
  for (const row of rows) {
    if (row.guardian_id !== mergedId && row.dependant_id !== mergedId) continue;
    const g = row.guardian_id === mergedId ? survivorId : row.guardian_id;
    const d = row.dependant_id === mergedId ? survivorId : row.dependant_id;
    if (g === d) {
      deleted += 1;
      continue;
    }
    if (row.ended_at !== null) {
      history += 1;
      continue;
    }
    if (live(g, d)) ends.push({ id: row.id, reason: "merged: a duplicate" });
    else if (live(d, g)) ends.push({ id: row.id, reason: "merged: the other way round is linked" });
    else moved += 1;
  }
  return { moved, ended: ends.length, deleted, history, ends };
}

/** Queues the statements that carry out `plan`: delete, end, then move the rest. */
export function queueMergeLinks(
  ctx: HandlerContext,
  survivorId: string,
  mergedId: string,
  plan: MergeLinkPlan,
): void {
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
  );
  for (const end of plan.ends) {
    ctx.write(
      ctx.db
        .updateTable("core_person_link")
        .set({ ended_at: ctx.now, ended_by: ctx.user.id, end_reason: end.reason })
        .where("id", "=", end.id)
        .where("ended_at", "is", null),
    );
  }
  // The rest move. A link made meanwhile that would now be a duplicate or a two-way link fails
  // the batch (the unique index and migration 0650's reverse trigger): nothing is merged.
  ctx.write(
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
