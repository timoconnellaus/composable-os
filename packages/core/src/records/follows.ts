// The state cascade (stage 31a, ADR 0507): an object whose `states.follows` names a relation moves
// its live records when the record that relation points to moves into one of `when`'s states (a
// class cancelled moves its booked, waiting and held bookings to `cancelled_by_us`). The moves are
// the host's, made in the parent's own batch by the record code, so each child's claim is given
// back and its use returned exactly as any other move of it would (ADRs 0501 and 0493). The child
// may be in another extension that requires the parent's (ADR 0841).
import type { ExtensionManifest } from "@composable-os/sdk";
import { type CompiledQuery, type Kysely, sql } from "kysely";
import { getObject, listObjects } from "../fields/index.ts";
import type { ObjectDefinition } from "../fields/types.ts";
import type { HandlerContext } from "../operation.ts";
import { orgReader, visibleSource } from "../visibility/index.ts";
import { viewColumnOf } from "./columns.ts";

/**
 * The most child records one parent's move moves, across every object that follows it: beyond it
 * the move is refused. Each costs the parent's batch up to 8 statements (a booking paid from a
 * pass: its row, history, search document, its place and its use given back; measured in
 * test/bookings-platform.test.ts and test/cascades-widened.test.ts), so 100 is about 810 of the
 * 1,000 queries a Worker invocation may make on D1. It was 500, which D1 would have refused past
 * about 120 (ADR 0841).
 */
export const FOLLOWERS_MAX = 100;

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

/**
 * The statement that fails the parent's batch at commit when a live record of `follower` still
 * points at `id` in one of its `from` states other than `target` (ADR 0841): one made after the
 * cascade read its followers. It runs after the cascade's own moves in the batch, so the records
 * the cascade read are no longer there. It inserts a `claimed` guard that can never hold (a
 * counter is never -1), so the batch fails as migration 0560's guards do (`recurring_stale`, the
 * answer the counter guard gives the same race): no migration, and no new kind of failure.
 */
export function followerLeftGuard(
  ctx: Pick<HandlerContext, "db">,
  follower: Follower,
  id: string,
  target: string,
): CompiledQuery | null {
  const rel = follower.object.fields.find((f) => f.name === follower.relation);
  const state = follower.object.fields.find((f) => f.name === follower.stateField);
  const relCol = rel ? viewColumnOf(rel) : null;
  const stateCol = state ? viewColumnOf(state) : null;
  const left = follower.from.filter((s) => s !== target);
  // biome-ignore lint/suspicious/noExplicitAny: extension views are not in the typed schema.
  const db = ctx.db as Kysely<any>;
  if (!relCol || !stateCol || !left.length) return null;
  const still = db
    .selectFrom(
      visibleSource(orgReader(ctx.db), getObject(follower.object.name) ?? follower.object),
    )
    .select(sql`1`.as("x"))
    .where(relCol, "=", id)
    .where(stateCol, "in", left);
  return sql`INSERT INTO core_write_guard (kind, object_type, record_id, expected) SELECT 'claimed', ${follower.object.name}, ${id}, -1 WHERE EXISTS ${still}`.compile(
    db,
  );
}

/**
 * A cascade across extensions against what is installed (ADR 0841): the SDK checks a follower's
 * own side, and only the host knows the parent's states. Checked at install and on every upgrade
 * of either extension: this extension's followers of an installed parent (the parent declares
 * states, and every state `when` names), and the installed followers in other extensions of this
 * extension's objects (an upgrade keeps each state they follow).
 */
export function followsHostIssues(m: ExtensionManifest): { path: string; message: string }[] {
  const issues: { path: string; message: string }[] = [];
  for (const [name, object] of Object.entries(m.objects)) {
    const f = object.states?.follows;
    const to = f ? object.fields[f.relation]?.to : undefined;
    if (!f || !to?.includes(".") || to.startsWith(`${m.id}.`)) continue;
    const path = `objects.${name}.states.follows`;
    const parent = getObject(to);
    const field = parent?.states
      ? parent.fields.find((x) => x.name === parent.states?.field)
      : undefined;
    if (!field) {
      issues.push({
        path: `${path}.relation`,
        message: `${to} is not installed or declares no states, so nothing can follow it`,
      });
      continue;
    }
    const states = new Set((field.options?.choices ?? []).map((c) => c.value));
    for (const when of Object.keys(f.when)) {
      if (!states.has(when)) {
        issues.push({ path: `${path}.when`, message: `"${when}" is not a state of ${to}` });
      }
    }
  }
  for (const child of listObjects()) {
    const f = child.states?.follows;
    if (!f || child.name.startsWith(`${m.id}.`)) continue;
    const to = child.fields.find((x) => x.name === f.relation)?.options?.to;
    if (!to?.startsWith(`${m.id}.`)) continue;
    const local = to.slice(m.id.length + 1);
    const parent = Object.hasOwn(m.objects, local) ? m.objects[local] : undefined;
    const states = new Set(
      (parent?.states ? (parent.fields[parent.states.field]?.options ?? []) : []).map(
        (o) => o.value,
      ),
    );
    for (const when of Object.keys(f.when)) {
      if (!states.has(when)) {
        issues.push({
          path: parent?.states ? `objects.${local}.states` : `objects.${local}`,
          message: `${child.name} follows ${to} into "${when}" (states.follows), so ${to} must keep it as a state`,
        });
      }
    }
  }
  return issues;
}
