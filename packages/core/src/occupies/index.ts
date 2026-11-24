// The `occupies` behaviour (stage 49 step 2, ADR 0765): a record that takes a thing (a room) for
// its time, and the host's rules over it.
//
// The claims are kept by triggers the reconciler builds (occupies/sql.ts), and the database
// refuses two live records on one thing at once for every writer (migration 1095), answered as
// `conflict`, `rule: "room_taken"`, naming no other record. What is here only reads before a
// write the host makes itself: a series' generation makes a date whose room is taken with no
// room rather than fail, and tells the rosterers.
import { type Kysely, sql } from "kysely";
import { objectTableOf } from "../extensions/schema.ts";
import { getObject } from "../fields/index.ts";
import type { ObjectDefinition, OccupiesMargin } from "../fields/types.ts";
import type { HandlerContext } from "../operation.ts";
import { queueNotice, rosterers, shiftLink } from "../staffing/rosterers.ts";

// biome-ignore lint/suspicious/noExplicitAny: x_* tables are not in CoreDatabase; names come from the registry.
type AnyDb = Kysely<any>;

const text = (value: unknown) => (typeof value === "string" && value !== "" ? value : null);
const secondsOf = (value: unknown): number | null => {
  const ms = typeof value === "string" ? Date.parse(value) : Number.NaN;
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
};

/**
 * What one batch (one run of a series) has read and planned, keyed by its `write`: whether each
 * thing is claimed and each margin's minutes (read once a run, not once a date), and the claims
 * the run's own records will make, which the database cannot show it before its batch commits.
 */
interface ThingBatch {
  claimed: Map<string, boolean>;
  minutes: Map<string, unknown>;
  planned: { thingObject: string; thing: string; starts: number; ends: number }[];
}
const batches = new WeakMap<object, ThingBatch>();
function batchOf(ctx: { write: object }): ThingBatch {
  let state = batches.get(ctx.write);
  if (!state) {
    state = { claimed: new Map(), minutes: new Map(), planned: [] };
    batches.set(ctx.write, state);
  }
  return state;
}

/** A field's column on an object, from the registry. */
const columnOf = (object: string, field: string) =>
  getObject(object)?.fields.find((f) => f.name === field)?.column;

/** The thing ids a value of the thing field names (one record, or a list). */
function thingIds(value: unknown): string[] {
  if (Array.isArray(value)) return [...new Set(value.filter((v): v is string => !!text(v)))];
  const id = text(value);
  return id ? [id] : [];
}

/** A margin in seconds, as the triggers read it (never negative; empty is none). */
async function marginOf(
  ctx: HandlerContext,
  margin: OccupiesMargin | undefined,
  values: Record<string, unknown>,
): Promise<number> {
  if (!margin) return 0;
  let minutes: unknown = values[margin.field];
  if (margin.via) {
    const id = text(values[margin.via]);
    const table = margin.viaObject ? objectTableOf(margin.viaObject) : undefined;
    const column = margin.viaObject ? columnOf(margin.viaObject, margin.field) : undefined;
    if (!id || !table || !column) return 0;
    const memo = batchOf(ctx).minutes;
    const key = `${margin.viaObject}\u0000${margin.field}\u0000${id}`;
    if (!memo.has(key)) {
      const row = await (ctx.db as AnyDb)
        .selectFrom(table)
        .select(`${column} as minutes`)
        .where("id", "=", id)
        .executeTakeFirst();
      memo.set(key, row?.minutes);
    }
    minutes = memo.get(key);
  }
  const n = typeof minutes === "number" && Number.isFinite(minutes) ? minutes : 0;
  return Math.floor(Math.max(0, n) * 60);
}

/**
 * The things a record with `values` would claim that another record holds at an overlapping time
 * now, or that an earlier record of this batch will, exactly as the triggers derive its claims
 * (occupies/sql.ts), or none. Read before the host's own write (a series' generation), which makes
 * the record next: the claims on the things left free are noted as this batch's, so a later date
 * of the same run that would overlap them (a long class across a clock change) is made without its
 * room too rather than fail the run. The trigger still decides any race. One read for the claims;
 * whether a thing is claimed is read once a batch.
 */
export async function thingsTaken(
  ctx: HandlerContext,
  object: ObjectDefinition,
  values: Record<string, unknown>,
): Promise<string[]> {
  const def = object.occupies;
  if (!def) return [];
  const stateField = object.states?.field;
  const state = stateField ? values[stateField] : null;
  if (typeof state !== "string" || !def.live.includes(state)) return [];
  let things = thingIds(values[def.thing]);
  const starts = secondsOf(values[def.starts]);
  const ends = secondsOf(values[def.ends]);
  if (!things.length || starts === null || ends === null || !(ends > starts)) return [];
  const batch = batchOf(ctx);
  if (def.only) {
    const table = objectTableOf(def.thingObject);
    const column = columnOf(def.thingObject, def.only);
    if (!table || !column) return [];
    const unknown = things.filter((id) => !batch.claimed.has(`${def.thingObject}\u0000${id}`));
    if (unknown.length) {
      const rows = await (ctx.db as AnyDb)
        .selectFrom(table)
        .select("id")
        .where("id", "in", unknown)
        .where(column, "=", 1)
        .execute();
      const claimed = new Set(rows.map((r) => r.id as string));
      for (const id of unknown) batch.claimed.set(`${def.thingObject}\u0000${id}`, claimed.has(id));
    }
    things = things.filter((id) => batch.claimed.get(`${def.thingObject}\u0000${id}`));
    if (!things.length) return [];
  }
  const from = starts - (await marginOf(ctx, def.before, values));
  const to = ends + (await marginOf(ctx, def.after, values));
  // Claims on one thing never overlap, so the one that starts last before `to` is the only one
  // that can overlap [from, to): one row per thing through the index by thing and start.
  const held = await sql<{ thing: string }>`
    SELECT t.value AS thing FROM json_each(${JSON.stringify(things)}) t
    WHERE (SELECT c.ends FROM core_thing_time c
      WHERE c.thing_object = ${def.thingObject} AND c.thing_record = t.value AND c.starts < ${to}
      ORDER BY c.starts DESC LIMIT 1) > ${from}`.execute(ctx.db);
  const taken = new Set(held.rows.map((r) => r.thing));
  for (const p of batch.planned) {
    if (p.thingObject === def.thingObject && p.starts < to && p.ends > from) taken.add(p.thing);
  }
  for (const thing of things) {
    if (!taken.has(thing)) {
      batch.planned.push({ thingObject: def.thingObject, thing, starts: from, ends: to });
    }
  }
  return things.filter((id) => taken.has(id));
}

/**
 * The values with the taken things taken off (a single thing emptied, a list without them), for
 * a date the host makes with no room rather than refuse.
 */
export function withoutThings(
  object: ObjectDefinition,
  values: Record<string, unknown>,
  taken: readonly string[],
): unknown {
  const value = object.occupies ? values[object.occupies.thing] : null;
  if (!Array.isArray(value)) return null;
  const left = value.filter((id) => !taken.includes(id as string));
  return left.length ? left : null;
}

/** Tells the rosterers a date of a series was made without its room, which was taken. */
export async function thingNotApplied(
  ctx: HandlerContext,
  object: ObjectDefinition,
  id: string,
  date: string,
  values: Record<string, unknown>,
  taken: readonly string[],
): Promise<void> {
  const def = object.occupies;
  if (!def) return;
  const thing = getObject(def.thingObject);
  const table = objectTableOf(def.thingObject);
  const column = thing?.titleField ? columnOf(def.thingObject, thing.titleField) : undefined;
  let names = taken.join(", ");
  if (table && column) {
    const rows = await (ctx.db as AnyDb)
      .selectFrom(table)
      .select(`${column} as title`)
      .where("id", "in", [...taken])
      .execute();
    const titles = rows.map((r) => text(r.title)).filter((t): t is string => t !== null);
    if (titles.length) names = titles.join(", ");
  }
  const label = (thing?.label ?? "room").toLowerCase();
  const title = (object.titleField ? text(values[object.titleField]) : null) ?? object.label;
  await queueNotice(ctx, {
    to: await rosterers(ctx.db),
    title: `Made with no ${label}: ${title} on ${date}`,
    body: `${names} is already taken at that time, so ${title} on ${date} was made with no ${label}. Give it another ${label} or move it.`,
    link: shiftLink(object.name, id),
  });
}
