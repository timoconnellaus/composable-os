// Located records in the write path (stage 64 step 2, ADR 0911): which location a record is at
// (`located`), the location filled while there is one open location, the location's zone as the
// default zone of what is located there, no new record at a closed location, and two paths of a
// record that must name the same location (`agree`).
//
// `agree` is the database's: the reconciler builds triggers on the declaring object's table and
// on the table its paths pass through (locations/sql.ts), so a live record whose two sides name
// different locations, or a room moved from under a live class, fails its batch whoever writes it
// and however many write at once (errors.ts answers `location_mismatch`). The reads here only give
// the common case a clear message, and the approval queue's dry run (whose writes are discarded)
// its answer.
import { type Kysely, sql } from "kysely";
import { ROOM_IN_USE_MESSAGE, ValidationError } from "../errors.ts";
import { objectTableOf } from "../extensions/schema.ts";
import { getObject, listObjects } from "../fields/index.ts";
import type { LocationPath, ObjectDefinition } from "../fields/types.ts";
import type { HandlerContext } from "../operation.ts";
import { loadGeneralSettings } from "../settings.ts";
import { type AgreeSide, sideExpr } from "./sql.ts";

// biome-ignore lint/suspicious/noExplicitAny: x_* tables are not in CoreDatabase; names come from the registry.
type AnyDb = Kysely<any>;

type Ctx = Pick<HandlerContext, "db">;

const text = (value: unknown) => (typeof value === "string" && value !== "" ? value : null);

/** A field's column on an object, from the registry. */
const columnOf = (object: string, field: string) =>
  getObject(object)?.fields.find((f) => f.name === field)?.column;

/**
 * The location a path names from a record's values: its own field, or that field of the record
 * its `via` relation names (read from that record's table, in the Trash or not, as the database's
 * triggers read it). Null when a value on the way is empty.
 */
export async function locationAt(
  ctx: Ctx,
  path: LocationPath,
  values: Record<string, unknown>,
): Promise<string | null> {
  if (!path.via) return text(values[path.field]);
  const related = text(values[path.via]);
  const table = path.viaObject ? objectTableOf(path.viaObject) : undefined;
  const column = path.viaObject ? columnOf(path.viaObject, path.field) : undefined;
  if (!related || !table || !column) return null;
  const row = await (ctx.db as AnyDb)
    .selectFrom(table)
    .select(sql<string | null>`${sql.ref(column)}`.as("location"))
    .where("id", "=", related)
    .executeTakeFirst();
  return text((row as { location?: unknown } | undefined)?.location);
}

/** The location a located record is at, from its values (null when it is not located or empty). */
export function locationOfRecord(
  ctx: Ctx,
  object: ObjectDefinition,
  values: Record<string, unknown>,
): Promise<string | null> {
  return object.located ? locationAt(ctx, object.located, values) : Promise.resolve(null);
}

interface LocationRow {
  id: string;
  name: string;
  timezone: string;
  state: string;
}

export async function loadLocation(ctx: Ctx, id: string): Promise<LocationRow | undefined> {
  return ctx.db
    .selectFrom("core_location")
    .select(["id", "name", "timezone", "state"])
    .where("id", "=", id)
    .executeTakeFirst();
}

/**
 * The zone a located record's empty zone takes (ADR 0911): its location's, else the
 * organisation's (ADR 0460). What is not located is in the organisation's zone.
 */
export async function defaultZoneOf(
  ctx: Ctx,
  object: ObjectDefinition,
  values: Record<string, unknown>,
): Promise<string> {
  const at = await locationOfRecord(ctx, object, values);
  const location = at ? await loadLocation(ctx, at) : undefined;
  return location?.timezone ?? (await loadGeneralSettings(ctx.db)).timezone;
}

/** Whether a located record's location is closed (it takes nothing new, ADR 0911). */
export async function atClosedLocation(
  ctx: Ctx,
  object: ObjectDefinition,
  values: Record<string, unknown>,
): Promise<boolean> {
  const at = await locationOfRecord(ctx, object, values);
  return at ? (await loadLocation(ctx, at))?.state === "closed" : false;
}

/**
 * A new record of an object located by a field of its own, given no location: the only open
 * location while there is one (ADR 0911), so a single-site business never chooses. With two or
 * more open, the field stays empty and the required field refuses it.
 */
export async function withLocationDefault(
  ctx: Ctx,
  object: ObjectDefinition,
  values: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const located = object.located;
  if (!located || located.via || text(values[located.field])) return values;
  const open = await ctx.db
    .selectFrom("core_location")
    .select("id")
    .where("state", "=", "open")
    .limit(2)
    .execute();
  const only = open.length === 1 ? open[0]?.id : undefined;
  return only ? { ...values, [located.field]: only } : values;
}

/**
 * The location rules of a write (ADR 0911), refused with a clear message before the batch:
 * - a new record, or one moved to another location, at a closed location (`location_closed`);
 * - a live record whose `agree` paths name different locations (`location_mismatch`);
 * - a change to a record an `agree` path passes through (a room's location) that would leave a
 *   live record of another object disagreeing (`location_mismatch`).
 * `before` is null on a create. A record in the Trash is not checked (it is checked when restored,
 * by the database).
 */
export async function assertLocationRules(
  ctx: Ctx,
  object: ObjectDefinition,
  id: string,
  before: Record<string, unknown> | null,
  after: Record<string, unknown>,
): Promise<void> {
  const located = object.located;
  if (located && !located.via) {
    const at = text(after[located.field]);
    const moved = before === null || text(before[located.field]) !== at;
    const location = at && moved ? await loadLocation(ctx, at) : undefined;
    if (location?.state === "closed") {
      throw new ValidationError(
        `${location.name} is closed: it takes no new ${(object.plural ?? object.label).toLowerCase()}`,
        { field: located.field, rule: "location_closed", location: location.id },
      );
    }
  }
  for (const rule of object.agree ?? []) {
    const [a, b] = await Promise.all([
      locationAt(ctx, rule.a, after),
      locationAt(ctx, rule.b, after),
    ]);
    if (!a || !b || a === b) continue;
    throw new ValidationError(await mismatchMessage(ctx, object, rule.b, b), {
      rule: "location_mismatch",
      fields: [rule.a.via ?? rule.a.field, rule.b.via ?? rule.b.field],
    });
  }
  if (before !== null) await assertPassedThrough(ctx, object, id, before, after);
}

async function mismatchMessage(
  ctx: Ctx,
  object: ObjectDefinition,
  side: LocationPath,
  location: string,
): Promise<string> {
  const name = (await loadLocation(ctx, location))?.name ?? "another location";
  const via = side.via ? object.fields.find((f) => f.name === side.via) : undefined;
  return via
    ? `The ${via.label.toLowerCase()} is at ${name}, not at this ${object.label.toLowerCase()}'s location`
    : `These name two different locations: this ${object.label.toLowerCase()} is at ${name} too`;
}

/** The objects whose `agree` paths pass through `object`, with those rules. */
function agreeingThrough(object: string) {
  return listObjects().flatMap((o) =>
    (o.agree ?? [])
      .filter((r) => r.a.viaObject === object || r.b.viaObject === object)
      .map((rule) => ({ object: o, rule })),
  );
}

/** A path as the triggers' SQL reads it (locations/sql.ts), from the registry; null if unknown. */
function sideOf(object: ObjectDefinition, path: LocationPath): AgreeSide | null {
  if (!path.via) {
    const column = columnOf(object.name, path.field);
    return column ? { column } : null;
  }
  const link = columnOf(object.name, path.via);
  const table = path.viaObject ? objectTableOf(path.viaObject) : undefined;
  const column = path.viaObject ? columnOf(path.viaObject, path.field) : undefined;
  return link && table && column ? { column, via: { column: link, table } } : null;
}

/**
 * A record an `agree` path passes through (a room), its location field changed: refused while a
 * live record of the declaring object (a class) names it and would then disagree, read as one
 * `EXISTS` over every such record. The triggers refuse what this cannot see (a write earlier in
 * the same batch) with the same words. A room's location changes only with what uses it
 * (`location.relocate`).
 */
async function assertPassedThrough(
  ctx: Ctx,
  object: ObjectDefinition,
  id: string,
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): Promise<void> {
  for (const { object: user, rule } of agreeingThrough(object.name)) {
    const table = objectTableOf(user.name);
    if (!table) continue;
    for (const [side, other] of [
      [rule.a, rule.b],
      [rule.b, rule.a],
    ] as const) {
      if (side.viaObject !== object.name || !side.via) continue;
      const moved = text(after[side.field]);
      if (!moved || text(before[side.field]) === moved) continue;
      const link = columnOf(user.name, side.via);
      const theirs = sideOf(user, other);
      if (!link || !theirs) continue;
      const expr = sql.raw(sideExpr(theirs, undefined, table));
      const found = await sql<{
        x: number;
      }>`SELECT 1 AS x FROM ${sql.table(table)} r WHERE r.${sql.ref(link)} = ${id} AND r.deleted_at IS NULL AND ${expr} IS NOT NULL AND ${expr} <> ${moved} LIMIT 1`.execute(
        ctx.db,
      );
      if (found.rows.length)
        throw new ValidationError(ROOM_IN_USE_MESSAGE, {
          field: side.field,
          rule: "location_mismatch",
          usedBy: user.name,
        });
    }
  }
}

/**
 * A located record moved to another location takes the new location's zone (ADR 0911, after the
 * spec's "moving a series to another location changes its future classes as any series change
 * does"): each `timezone` field the write does not set, holding the old location's zone (the
 * default it was given, or the same by choice) or nothing, becomes the new location's. A zone
 * that differs from the old location's was chosen by hand and is kept.
 */
export async function withZoneFollowingMove(
  ctx: Ctx,
  object: ObjectDefinition,
  before: Record<string, unknown>,
  asked: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const located = object.located;
  if (!located || !Object.hasOwn(asked, located.via ?? located.field)) return asked;
  const zones = object.fields.filter(
    (f) =>
      f.fieldType === "timezone" &&
      f.options?.default === undefined &&
      !f.options?.defaultSetting &&
      !Object.hasOwn(asked, f.name),
  );
  if (!zones.length) return asked;
  const [from, to] = await Promise.all([
    locationOfRecord(ctx, object, before),
    locationOfRecord(ctx, object, { ...before, ...asked }),
  ]);
  if (!to || from === to) return asked;
  const [was, now] = await Promise.all([
    from ? loadLocation(ctx, from) : undefined,
    loadLocation(ctx, to),
  ]);
  if (!now) return asked;
  const out = { ...asked };
  for (const field of zones) {
    const zone = text(before[field.name]);
    if (zone === null || zone === was?.timezone) out[field.name] = now.timezone;
  }
  return out;
}

/**
 * What `location.relocate` moves with a record (ADR 0911): every object whose `agree` passes
 * through it, by the relation naming it (`link`) and the object's own location field. An object
 * that reaches its other side through another relation is refused: move that record instead.
 */
export function usersOf(object: string): {
  user: ObjectDefinition;
  link: string;
  location: string;
}[] {
  const out: { user: ObjectDefinition; link: string; location: string }[] = [];
  for (const { object: user, rule } of agreeingThrough(object)) {
    for (const [side, other] of [
      [rule.a, rule.b],
      [rule.b, rule.a],
    ] as const) {
      if (side.viaObject !== object || !side.via) continue;
      if (other.via) {
        throw new ValidationError(
          `A ${user.label.toLowerCase()} reaches its other location through ${other.via}: move that instead`,
          { rule: "relocate_through", object: user.name },
        );
      }
      if (!out.some((u) => u.user.name === user.name && u.link === side.via)) {
        out.push({ user, link: side.via, location: other.field });
      }
    }
  }
  return out;
}
