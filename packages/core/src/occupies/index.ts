// The `occupies` behaviour (stage 49 step 2, ADR 0765): a record that takes a thing (a room) for
// its time, and the host's rules over it.
//
// The claims are kept by triggers the reconciler builds (occupies/sql.ts), and the database
// refuses two live records on one thing at once for every writer (migration 1095), answered as
// `conflict`, `rule: "room_taken"`, naming no other record. What is here only reads before a
// write the host makes itself: a series' generation makes a date whose room is taken with no
// room rather than fail, and tells the rosterers.
import type { Kysely } from "kysely";
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
    const row = await (ctx.db as AnyDb)
      .selectFrom(table)
      .select(`${column} as minutes`)
      .where("id", "=", id)
      .executeTakeFirst();
    minutes = row?.minutes;
  }
  const n = typeof minutes === "number" && Number.isFinite(minutes) ? minutes : 0;
  return Math.floor(Math.max(0, n) * 60);
}

/**
 * The things a record with `values` would claim that another record holds at an overlapping time
 * now, exactly as the triggers derive its claims (occupies/sql.ts), or none. Read before the
 * host's own write (a series' generation); the trigger still decides any race.
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
  if (def.only) {
    const table = objectTableOf(def.thingObject);
    const column = columnOf(def.thingObject, def.only);
    if (!table || !column) return [];
    const rows = await (ctx.db as AnyDb)
      .selectFrom(table)
      .select("id")
      .where("id", "in", things)
      .where(column, "=", 1)
      .execute();
    const claimed = new Set(rows.map((r) => r.id as string));
    things = things.filter((id) => claimed.has(id));
    if (!things.length) return [];
  }
  const from = starts - (await marginOf(ctx, def.before, values));
  const to = ends + (await marginOf(ctx, def.after, values));
  const held = await ctx.db
    .selectFrom("core_thing_time")
    .select("thing_record")
    .distinct()
    .where("thing_object", "=", def.thingObject)
    .where("thing_record", "in", things)
    .where("ends", ">", from)
    .where("starts", "<", to)
    .execute();
  return held.map((r) => r.thing_record);
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
