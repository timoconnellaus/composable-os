// The state cascade (stage 31a, ADR 0507): an object whose `states.follows` names a relation moves
// its live records when the record that relation points to moves into one of `when`'s states (a
// class cancelled moves its booked, waiting and held bookings to `cancelled_by_us`). The moves are
// the host's, made in the parent's own batch by the record code, so each child's claim is given
// back and its use returned exactly as any other move of it would (ADRs 0501 and 0493).
import type { Kysely } from "kysely";
import { getObject, listObjects } from "../fields/index.ts";
import type { ObjectDefinition } from "../fields/types.ts";
import type { HandlerContext } from "../operation.ts";
import { orgReader, visibleSource } from "../visibility/index.ts";
import { viewColumnOf } from "./columns.ts";

/** The most child records one parent's move moves: beyond it the move is refused. */
export const FOLLOWERS_MAX = 500;

export interface Follower {
  object: ObjectDefinition;
  relation: string;
  stateField: string;
  when: Readonly<Record<string, string>>;
  from: readonly string[];
}

/** Every object that follows `object`'s moves. */
export function followersOf(object: string): Follower[] {
  const out: Follower[] = [];
  for (const child of listObjects()) {
    const f = child.states?.follows;
    if (!f || !child.states) continue;
    const rel = child.fields.find((field) => field.name === f.relation);
    if (rel?.options?.to !== object) continue;
    out.push({
      object: child,
      relation: f.relation,
      stateField: child.states.field,
      when: f.when,
      from: f.from,
    });
  }
  return out;
}

/** The live records of `follower` pointing at `id` in one of its `from` states (host's read). */
export async function followerIds(
  ctx: Pick<HandlerContext, "db">,
  follower: Follower,
  id: string,
  limit = FOLLOWERS_MAX + 1,
): Promise<string[]> {
  const rel = follower.object.fields.find((f) => f.name === follower.relation);
  const state = follower.object.fields.find((f) => f.name === follower.stateField);
  const relCol = rel ? viewColumnOf(rel) : null;
  const stateCol = state ? viewColumnOf(state) : null;
  if (!relCol || !stateCol) return [];
  // biome-ignore lint/suspicious/noExplicitAny: extension views are not in the typed schema.
  const rows = (await (ctx.db as Kysely<any>)
    .selectFrom(
      visibleSource(orgReader(ctx.db), getObject(follower.object.name) ?? follower.object),
    )
    .select("id")
    .where(relCol, "=", id)
    .where(stateCol, "in", [...follower.from])
    .orderBy("id")
    .limit(limit)
    .execute()) as { id: string }[];
  return rows.map((row) => String(row.id));
}

/** How many live records follow `id` (a class's live bookings): what a confirm counts. */
export async function followersOn(
  ctx: Pick<HandlerContext, "db">,
  object: string,
  id: string,
): Promise<number> {
  let count = 0;
  for (const follower of followersOf(object)) {
    count += (await followerIds(ctx, follower, id)).length;
  }
  return count;
}
