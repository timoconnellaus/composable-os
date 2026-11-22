// Waitlists on capacity claimants (stage 31a step 5, ADR 0520). A claimant that declares
// `claims.waitlist` (a booking) may wait for a full class: a record in the waitlist's state holds
// no place and spends nothing. The transition engine calls `waitlistMove` on every move of one,
// in the write's own batch, for every actor:
//
//   into the waiting state (a join)        refused unless the class is full when the batch commits
//                                         (a guard, migration 0610) and before the cut-off
//   a place given back (out of held or     before the cut-off, the same batch hands it to the
//   confirmed), while anyone waits          waitlist: a held claim `for_type 'waitlist'`, made
//                                         by conditional statements (no read), so nobody booking
//                                         directly can take it
//   waiting into the promote state (host)  one waitlist hold given back first, then the waiter's
//                                         own claim made as any other (claimants.ts): net nothing,
//                                         and with no hold left the claim fails on a full class
//   waiting into anything else (leaving)   when nobody else waits, the waitlist's holds go back
//
// Promotion itself is a host step from a current read (ADR 0437): operations/waitlist.ts and the
// minute cron. A hold nobody can take, and every hold from the cut-off on, is given back there.
import { CompiledQuery, type Kysely } from "kysely";
import { ConflictError, ValidationError } from "../errors.ts";
import { getObject } from "../fields/index.ts";
import type { ClaimsDefinition, ObjectDefinition, WaitlistDefinition } from "../fields/types.ts";
import { newId } from "../ids.ts";
import type { HandlerContext } from "../operation.ts";
import { boundMoment, pathReader } from "../records/windows.ts";
import { guardStatement } from "../recurring/bookkeeping.ts";
import { creditSimulatedClaim, readCounter } from "./records.ts";

/** How many live (held or confirmed) claims a claimant record has now. */
async function liveClaims(db: HandlerContext["db"], object: string, id: string): Promise<number> {
  const row = await db
    .selectFrom("core_capacity_claim")
    .select((eb) => eb.fn.countAll<number>().as("n"))
    .where("for_type", "=", object)
    .where("for_id", "=", id)
    .where("state", "in", ["held", "confirmed"])
    .executeTakeFirst();
  return Number(row?.n ?? 0);
}

/** How many waitlist holds `t`'s waitlist has on `on` now. */
export async function holdsOn(
  db: HandlerContext["db"],
  t: { object: ObjectDefinition; claims: ClaimsDefinition },
  on: string,
): Promise<number> {
  const row = await db
    .selectFrom("core_capacity_claim")
    .select((eb) => eb.fn.countAll<number>().as("n"))
    .where("object_type", "=", t.claims.object)
    .where("record_id", "=", on)
    .where("for_type", "=", WAITLIST_FOR)
    .where("for_id", "=", t.object.name)
    .where("state", "=", "held")
    .executeTakeFirst();
  return Number(row?.n ?? 0);
}

/** The `for_type` of a waitlist's holds; their `for_id` is the claimant object. */
export const WAITLIST_FOR = "waitlist";

/** A claimant object with a waitlist, and the columns its statements read. */
export interface WaitlistTarget {
  object: ObjectDefinition;
  claims: ClaimsDefinition;
  waitlist: WaitlistDefinition;
  /** The claimant's live-records view and its relation and state columns. */
  source: string;
  onColumn: string;
  stateColumn: string;
  /** The column of `passedOverAt`, when declared: which waiters a hold has already tried. */
  passedOverColumn?: string | undefined;
}

/** The waitlist of a claimant object, or null when it declares none. */
export function waitlistOf(object: ObjectDefinition): WaitlistTarget | null {
  const claims = object.claims;
  const waitlist = claims?.waitlist;
  const stateField = object.states?.field;
  if (!claims || !waitlist || !stateField) return null;
  const onColumn = object.fields.find((f) => f.name === claims.on)?.column;
  const stateColumn = object.fields.find((f) => f.name === stateField)?.column;
  if (!onColumn || !stateColumn) return null;
  const passedOverColumn = waitlist.passedOverAt
    ? object.fields.find((f) => f.name === waitlist.passedOverAt)?.column
    : undefined;
  return {
    object,
    claims,
    waitlist,
    source: object.source,
    onColumn,
    stateColumn,
    ...(passedOverColumn ? { passedOverColumn } : {}),
  };
}

/** The claimant object (with a waitlist) a waitlist hold was made for, by its `for_id`. */
export function requireWaitlist(objectName: string): WaitlistTarget {
  const object = getObject(objectName);
  const target = object ? waitlistOf(object) : null;
  if (!target) {
    throw new ValidationError(`${objectName} has no waitlist`, { field: "object" });
  }
  return target;
}

const ident = (name: string) => `"${name.replaceAll('"', '""')}"`;

/** SQL: someone other than `except` waits on `on` (bound: on, waiting state, except). */
function waitersSql(t: WaitlistTarget): string {
  return `EXISTS (SELECT 1 FROM ${ident(t.source)} w WHERE w.${ident(t.onColumn)} = ? AND w.${ident(t.stateColumn)} = ? AND w.id != ?)`;
}

/**
 * When promotion stops for a claimant record as `values` leave it (its cut-off, ms), or null
 * when it cannot be worked out (then nobody is promoted and nothing is handed on).
 */
export async function cutoffOf(
  ctx: HandlerContext,
  t: WaitlistTarget,
  values: Record<string, unknown>,
): Promise<number | null> {
  return boundMoment(ctx, pathReader(ctx, t.object, values), t.waitlist.until);
}

/** Whether `now` is before the cut-off for a claimant record as `values` leave it. */
export async function beforeCutoff(
  ctx: HandlerContext,
  t: WaitlistTarget,
  values: Record<string, unknown>,
): Promise<boolean> {
  const cutoff = await cutoffOf(ctx, t, values);
  return cutoff !== null && Date.parse(ctx.now) < cutoff;
}

/**
 * The statements that hand one place on `on` to the waitlist when the claimant record `claimant`
 * gave a place back on it in this batch (its claim released at `now`, by the statements queued
 * before these) and anyone other than it is waiting there: the counter's held up by one and a
 * waitlist hold, both on the same two conditions, so both happen or neither does. Keyed to the
 * claim really released, not to the state change: a record that holds nothing (an erased
 * Person's booking, kept anonymous) hands nothing on when it moves (ADR 0520).
 */
export function handOnStatements(
  t: WaitlistTarget,
  on: string,
  claimant: string,
  id: string,
  now: string,
): CompiledQuery[] {
  const released = `EXISTS (SELECT 1 FROM core_capacity_claim r WHERE r.for_type = ? AND r.for_id = ? AND r.object_type = ? AND r.record_id = ? AND r.state = 'released' AND r.released_at = ?)`;
  const conditions = `${released} AND ${waitersSql(t)}`;
  const params = [
    t.object.name,
    claimant,
    t.claims.object,
    on,
    now,
    on,
    t.waitlist.state,
    claimant,
  ];
  return [
    CompiledQuery.raw(
      `UPDATE core_capacity SET held = held + 1, updated_at = ? WHERE object_type = ? AND record_id = ? AND ${conditions}`,
      [now, t.claims.object, on, ...params],
    ),
    CompiledQuery.raw(
      `INSERT INTO core_capacity_claim (id, object_type, record_id, pool_object_type, pool_record_id, quantity, state, for_type, for_id, created_at, updated_at) SELECT ?, ?, ?, NULL, NULL, 1, 'held', ?, ?, ?, ? WHERE ${conditions}`,
      [id, t.claims.object, on, WAITLIST_FOR, t.object.name, now, now, ...params],
    ),
  ];
}

/**
 * After an erase gave back every place a claimant record held (records/erase-stores.ts): hand
 * one on to the waitlist as a move out of a claiming state would, before the cut-off (ADR 0520).
 */
export async function handOnAfterRelease(
  ctx: HandlerContext,
  object: ObjectDefinition,
  id: string,
): Promise<void> {
  const t = waitlistOf(object);
  if (!t) return;
  // biome-ignore lint/suspicious/noExplicitAny: extension views are not in the typed schema.
  const row = (await (ctx.db as Kysely<any>)
    .selectFrom(t.source)
    .select(t.onColumn)
    .where("id", "=", id)
    .executeTakeFirst()) as Record<string, unknown> | undefined;
  const on = row?.[t.onColumn];
  if (typeof on !== "string" || !on) return;
  if (!(await beforeCutoff(ctx, t, { [t.claims.on]: on }))) return;
  ctx.write(...handOnStatements(t, on, id, newId("capacityClaim"), ctx.now));
}

/**
 * The statements that give back one waitlist hold on `on` (the oldest), if there is one: what a
 * promotion takes before it claims the waiter's place.
 */
export function takeHoldStatements(t: WaitlistTarget, on: string, now: string): CompiledQuery[] {
  const holds = `SELECT id FROM core_capacity_claim WHERE object_type = ? AND record_id = ? AND for_type = ? AND for_id = ? AND state = 'held'`;
  const params = [t.claims.object, on, WAITLIST_FOR, t.object.name];
  return [
    CompiledQuery.raw(
      `UPDATE core_capacity SET held = held - 1, updated_at = ? WHERE object_type = ? AND record_id = ? AND EXISTS (${holds})`,
      [now, t.claims.object, on, ...params],
    ),
    CompiledQuery.raw(
      `UPDATE core_capacity_claim SET state = 'released', released_at = ?, updated_at = ? WHERE id = (${holds} ORDER BY created_at, id LIMIT 1)`,
      [now, now, ...params],
    ),
  ];
}

/**
 * The statements that give back the waitlist's holds on `on`: those made at or before `before`
 * (the sweep's read), or all of them; only while nobody other than `except` waits, when given.
 */
export function releaseHoldsStatements(
  t: WaitlistTarget,
  on: string,
  now: string,
  options: { before?: string; unlessWaiting?: { except: string } } = {},
): CompiledQuery[] {
  const where = [
    "c.object_type = ?",
    "c.record_id = ?",
    "c.for_type = ?",
    "c.for_id = ?",
    "c.state = 'held'",
    ...(options.before !== undefined ? ["c.created_at <= ?"] : []),
  ].join(" AND ");
  const params = [
    t.claims.object,
    on,
    WAITLIST_FOR,
    t.object.name,
    ...(options.before !== undefined ? [options.before] : []),
  ];
  const unless = options.unlessWaiting
    ? {
        sql: ` AND NOT ${waitersSql(t)}`,
        params: [on, t.waitlist.state, options.unlessWaiting.except],
      }
    : { sql: "", params: [] as string[] };
  return [
    CompiledQuery.raw(
      `UPDATE core_capacity SET held = held - (SELECT coalesce(sum(c.quantity), 0) FROM core_capacity_claim c WHERE ${where}), updated_at = ? WHERE object_type = ? AND record_id = ?${unless.sql}`,
      [...params, now, t.claims.object, on, ...unless.params],
    ),
    CompiledQuery.raw(
      `UPDATE core_capacity_claim SET state = 'released', released_at = ?, updated_at = ? WHERE id IN (SELECT c.id FROM core_capacity_claim c WHERE ${where})${unless.sql}`,
      [now, now, ...params, ...unless.params],
    ),
  ];
}

/**
 * The statements that give back a waitlist's holds on one record by names alone: for holds whose
 * claimant object no longer declares a waitlist (the sweep finds them; ADR 0520).
 */
export function releaseGroupStatements(
  claimed: string,
  on: string,
  claimant: string,
  now: string,
): CompiledQuery[] {
  const where =
    "c.object_type = ? AND c.record_id = ? AND c.for_type = ? AND c.for_id = ? AND c.state = 'held'";
  const params = [claimed, on, WAITLIST_FOR, claimant];
  return [
    CompiledQuery.raw(
      `UPDATE core_capacity SET held = held - (SELECT coalesce(sum(c.quantity), 0) FROM core_capacity_claim c WHERE ${where}), updated_at = ? WHERE object_type = ? AND record_id = ?`,
      [...params, now, claimed, on],
    ),
    CompiledQuery.raw(
      `UPDATE core_capacity_claim SET state = 'released', released_at = ?, updated_at = ? WHERE id IN (SELECT c.id FROM core_capacity_claim c WHERE ${where})`,
      [now, now, ...params],
    ),
  ];
}

/** The statements that give back every waitlist hold made for a claimant object (it is dropped). */
export function releaseAllWaitlistHoldsStatements(object: string, now: string): CompiledQuery[] {
  return [
    CompiledQuery.raw(
      "UPDATE core_capacity SET held = held - (SELECT coalesce(sum(c.quantity), 0) FROM core_capacity_claim c WHERE c.for_type = ? AND c.for_id = ? AND c.state = 'held' AND c.object_type = core_capacity.object_type AND c.record_id = core_capacity.record_id), updated_at = ? WHERE (object_type, record_id) IN (SELECT c.object_type, c.record_id FROM core_capacity_claim c WHERE c.for_type = ? AND c.for_id = ? AND c.state = 'held')",
      [WAITLIST_FOR, object, now, WAITLIST_FOR, object],
    ),
    CompiledQuery.raw(
      "UPDATE core_capacity_claim SET state = 'released', released_at = ?, updated_at = ? WHERE for_type = ? AND for_id = ? AND state = 'held'",
      [now, now, WAITLIST_FOR, object],
    ),
  ];
}

/**
 * A join (a record made, or moved, into the waiting state, or a waiter pointed at another
 * record): refused before the cut-off has passed, and unless every place is held or taken. The
 * guard queued here fails the batch if a place came free before it commits (migration 0610).
 */
async function assertJoin(
  ctx: HandlerContext,
  t: WaitlistTarget,
  on: string,
  after: Record<string, unknown>,
): Promise<void> {
  if (!(await beforeCutoff(ctx, t, after))) {
    throw new ValidationError(
      `The waitlist has closed: nobody is moved in from it this close to the start`,
      { rule: "waitlist", reason: "closed", field: t.object.states?.field },
    );
  }
  const counter = await readCounter(ctx.db, t.claims.object, on);
  if (!counter) throw new ValidationError("A referenced record does not exist");
  if (counter.places === null || counter.held + counter.taken < counter.places) {
    throw new ConflictError("A place is free: claim it instead of waiting.", {
      rule: "waitlist",
      reason: "not_full",
    });
  }
  if (!ctx.simulation) ctx.write(guardStatement("full", t.claims.object, on, 0));
}

/** The kind of place a state holds: held, confirmed, or none. */
function placeKind(claims: ClaimsDefinition, state: unknown): "held" | "confirmed" | null {
  if (typeof state !== "string") return null;
  if (claims.held.includes(state)) return "held";
  if (claims.confirmed.includes(state)) return "confirmed";
  return null;
}

/**
 * What a claimant's move from `before` (null on create) to `after` does to its waitlist, before
 * its own claim statements are queued (`phase: "before"`: a promotion's hold given back first) or
 * after them (`phase: "after"`: a place handed on, the last waiter's holds given back).
 */
export async function waitlistMove(
  ctx: HandlerContext,
  object: ObjectDefinition,
  id: string,
  before: Record<string, unknown> | null,
  after: Record<string, unknown>,
  by: string,
  phase: "before" | "after",
): Promise<void> {
  const t = waitlistOf(object);
  const field = object.states?.field;
  if (!t || !field) return;
  const waiting = t.waitlist.state;
  const was = before === null ? null : before[field];
  const is = after[field];
  const onBefore = before === null ? null : before[t.claims.on];
  const onAfter = after[t.claims.on];
  if (phase === "before") {
    // A promotion: the waiter's place is the waitlist's hold, given back here and claimed next.
    // Only the host's promotion takes the waitlist's hold; a waiter moving themselves in (a free
    // place after the cut-off, say) claims a free place like anyone, never one owed to the queue.
    if (was === waiting && is === t.waitlist.promote && by === "host") {
      if (typeof onAfter === "string" && onAfter) {
        ctx.write(...takeHoldStatements(t, onAfter, ctx.now));
        // The approval queue's dry run discards those statements: count the hold's return, so
        // the claim that follows is judged as the real batch would judge it (finding 1, ADR 0520).
        if (ctx.simulation && (await holdsOn(ctx.db, t, onAfter)) > 0) {
          creditSimulatedClaim(ctx, t.claims.object, onAfter, 1);
        }
      }
    }
    return;
  }
  // A join: the class must be full, before the cut-off. (A waiter cannot be pointed at another
  // record at all: assertClaimRelationKept refuses it.)
  if (is === waiting && by !== "host" && was !== waiting) {
    if (typeof onAfter !== "string" || !onAfter) {
      const label = object.fields.find((f) => f.name === t.claims.on)?.label ?? t.claims.on;
      throw new ValidationError(`${object.label} needs ${label} to wait for a place`, {
        field: t.claims.on,
        rule: "waitlist",
      });
    }
    await assertJoin(ctx, t, onAfter, after);
  }
  // A waiter leaving (anything but promotion): with nobody else waiting, the holds go back.
  if (was === waiting && is !== waiting && is !== t.waitlist.promote) {
    if (typeof onBefore === "string" && onBefore) {
      ctx.write(...releaseHoldsStatements(t, onBefore, ctx.now, { unlessWaiting: { except: id } }));
    }
  }
  // A place given back before the cut-off goes to the waitlist when anyone waits.
  const from = before === null ? null : placeKind(t.claims, was);
  const to = placeKind(t.claims, is);
  if (from !== null && to === null && typeof onBefore === "string" && onBefore) {
    // Only a record that holds a place gives one back: an erased Person's booking, kept in its
    // state holding nothing, hands nothing on (the SQL also checks the claim it releases).
    if (
      (await liveClaims(ctx.db, object.name, id)) > 0 &&
      (await beforeCutoff(ctx, t, before ?? after))
    ) {
      ctx.write(...handOnStatements(t, onBefore, id, newId("capacityClaim"), ctx.now));
    }
  }
}

/** A waiter's place in the queue (1 is next) and how many wait, or null if it is not waiting. */
export async function waitlistPosition(
  db: HandlerContext["db"],
  t: WaitlistTarget,
  id: string,
): Promise<{ position: number; waiting: number } | null> {
  // biome-ignore lint/suspicious/noExplicitAny: extension views are not in the typed schema.
  const k = db as Kysely<any>;
  const mine = (await k
    .selectFrom(t.source)
    .select(["id", "created_at", t.onColumn, t.stateColumn])
    .where("id", "=", id)
    .executeTakeFirst()) as Record<string, unknown> | undefined;
  if (!mine || mine[t.stateColumn] !== t.waitlist.state) return null;
  const on = mine[t.onColumn];
  const rows = (await k
    .selectFrom(t.source)
    .select(["id", "created_at"])
    .where(t.onColumn, "=", on)
    .where(t.stateColumn, "=", t.waitlist.state)
    .execute()) as { id: string; created_at: string }[];
  const key = (r: { id: string; created_at: string }) => `${r.created_at}|${r.id}`;
  const own = key({ id, created_at: String(mine.created_at) });
  return {
    position: rows.filter((r) => key(r) < own).length + 1,
    waiting: rows.length,
  };
}

/**
 * The waiters on `on`, first first (by when each was made). With `untriedSince` (the oldest
 * hold's time) and a declared `passedOverAt`, only those not passed over since then: a waiter
 * already tried for these holds is not tried again, so the sweep moves down a long queue across
 * ticks instead of giving the place away after the first page (ADR 0520).
 */
export async function waitersOn(
  db: HandlerContext["db"],
  t: WaitlistTarget,
  on: string,
  limit: number,
  untriedSince?: string,
): Promise<string[]> {
  // biome-ignore lint/suspicious/noExplicitAny: extension views are not in the typed schema.
  let query = (db as Kysely<any>)
    .selectFrom(t.source)
    .select("id")
    .where(t.onColumn, "=", on)
    .where(t.stateColumn, "=", t.waitlist.state);
  const column = t.passedOverColumn;
  if (untriedSince !== undefined && column) {
    // biome-ignore lint/suspicious/noExplicitAny: the column is the registry's, typed loosely.
    query = query.where((eb: any) =>
      eb.or([eb(column, "is", null), eb(column, "<", untriedSince)]),
    );
  }
  const rows = (await query.orderBy("created_at").orderBy("id").limit(limit).execute()) as {
    id: string;
  }[];
  return rows.map((r) => String(r.id));
}
