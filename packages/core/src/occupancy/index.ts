// The room calendar (stage 57 step 1, ADR 0844): every claim on a thing (a room) in a range, read
// from core_thing_time, whatever object holds it (a class, an appointment, a hire's room use, an
// event's, a block), with only what a calendar shows: the thing, the object's label, the record,
// its title as `occupies.title` declares it (never a client's name), its own times and the times it
// takes with its margins, and whether it is provisional (`occupies.provisional`). A reader who
// holds a pack's fixed role (a coach, the door) reads only that the room is taken, and when.
//
// Read as the host, set-based: one read of the claims, then per occupying object one read of its
// records (and one of its titles when they are another record's), and one of the things' names per
// kind of thing. However many claims, the statements are bounded by the objects that declare
// `occupies`, and every list of ids is bound as one JSON value (D1's 100 bound variables).
import { sql } from "kysely";
import { objectTableOf } from "../extensions/schema.ts";
import { getObject, listObjects } from "../fields/index.ts";
import type { ObjectDefinition } from "../fields/types.ts";
import type { HandlerContext } from "../operation.ts";
import { jsonList } from "../records/common.ts";
import { titles } from "../staffing/week.ts";

/** One claim on the calendar. Everything but the thing and the times is null to a fixed role. */
export interface RoomClaim {
  thing: { object: string; id: string; name: string | null };
  /** The occupying object's registry name, and its label ("Class", "Hire"). */
  object: string | null;
  label: string | null;
  id: string | null;
  /** Its `occupies.title`, else the object's label. Never a client's name. */
  title: string | null;
  /** The record's own times. */
  startsAt: string | null;
  endsAt: string | null;
  /** What it takes of the thing, its margins (set-up, pack-down, a buffer) included. */
  takenFrom: string;
  takenTo: string;
  /** In one of its `occupies.provisional` states (a hold), or null to a fixed role. */
  provisional: boolean | null;
}

/** The most claims one read gives; more, and the answer says it was cut short. */
export const MAX_CLAIMS = 2000;

const iso = (seconds: number) => new Date(seconds * 1000).toISOString();
const text = (value: unknown) =>
  typeof value === "string" && value !== ""
    ? value
    : typeof value === "number"
      ? String(value)
      : null;
const column = (object: ObjectDefinition, field: string | undefined) =>
  (field && object.fields.find((f) => f.name === field)?.column) || null;

/** A select field's stored value as its label (the calendar shows "Studio hire", not `studio`). */
function choiceLabel(objectName: string | undefined, field: string): (value: string) => string {
  const choices = objectName
    ? getObject(objectName)?.fields.find((f) => f.name === field)?.options?.choices
    : undefined;
  return (value) => choices?.find((c) => c.value === value)?.label ?? value;
}

/** The objects whose records occupy things, and the kinds of thing they claim. */
function occupants(): { objects: ObjectDefinition[]; things: string[] } {
  const objects = listObjects().filter((o) => o.occupies?.thingObject);
  const things = [...new Set(objects.map((o) => o.occupies?.thingObject as string))].sort();
  return { objects, things };
}

/**
 * The claims overlapping `[from, to)` (unix seconds), in order of what they take, on `things`
 * when given (thing record ids) or on every claimed thing. `full` is false for a fixed role's
 * reader: the thing and the times only.
 */
export async function roomClaims(
  ctx: Pick<HandlerContext, "db">,
  range: { from: number; to: number; things?: readonly string[] | undefined },
  options: { full: boolean },
): Promise<{ claims: RoomClaim[]; truncated: boolean }> {
  const { objects, things } = occupants();
  if (!things.length || (range.things && !range.things.length)) {
    return { claims: [], truncated: false };
  }
  // Claims on one thing never overlap, and the index is by thing and start: with the things
  // named, each is a range read of the index.
  const rows = await sql<{
    object_type: string;
    record_id: string;
    thing_object: string;
    thing_record: string;
    starts: number;
    ends: number;
  }>`SELECT object_type, record_id, thing_object, thing_record, starts, ends FROM core_thing_time
    WHERE thing_object IN ${jsonList(things)}
      ${range.things ? sql`AND thing_record IN ${jsonList([...new Set(range.things)])}` : sql``}
      AND starts < ${range.to} AND ends > ${range.from}
    ORDER BY starts, thing_object, thing_record, object_type, record_id
    LIMIT ${MAX_CLAIMS + 1}`.execute(ctx.db);
  const truncated = rows.rows.length > MAX_CLAIMS;
  if (truncated) rows.rows.length = MAX_CLAIMS;

  // The things' names (a room's name is no secret: the public reads it).
  const thingNames = new Map<string, Map<string, string>>();
  for (const thingObject of new Set(rows.rows.map((r) => r.thing_object))) {
    const ids = rows.rows.filter((r) => r.thing_object === thingObject).map((r) => r.thing_record);
    thingNames.set(thingObject, await titles(ctx, thingObject, ids));
  }

  // Each occupant's own times, state and title, a read per object (and one for titles read
  // through a relation). A fixed role reads none of it.
  const details = new Map<
    string,
    { starts: string | null; ends: string | null; title: string | null; provisional: boolean }
  >();
  if (options.full) {
    for (const object of objects) {
      const def = object.occupies;
      const table = objectTableOf(object.name);
      const ids = [
        ...new Set(rows.rows.filter((r) => r.object_type === object.name).map((r) => r.record_id)),
      ];
      if (!def || !table || !ids.length) continue;
      const starts = column(object, def.starts);
      const ends = column(object, def.ends);
      const state = column(object, object.states?.field);
      const titleCol = def.title ? column(object, def.title.via ?? def.title.field) : null;
      const read = await sql<{
        id: string;
        starts: string | null;
        ends: string | null;
        state: string | null;
        title: unknown;
      }>`SELECT id, ${starts ? sql.ref(starts) : sql`NULL`} AS starts,
        ${ends ? sql.ref(ends) : sql`NULL`} AS ends, ${state ? sql.ref(state) : sql`NULL`} AS state,
        ${titleCol ? sql.ref(titleCol) : sql`NULL`} AS title
        FROM ${sql.table(table)} WHERE id IN ${jsonList(ids)}`.execute(ctx.db);
      // A title read through a relation: the related records' field, read once for all.
      const via =
        def.title?.via && def.title.viaObject
          ? await titles(
              ctx,
              def.title.viaObject,
              read.rows.map((r) => text(r.title)).filter((t): t is string => t !== null),
              def.title.field,
            )
          : null;
      const shown = def.title
        ? choiceLabel(def.title.via ? def.title.viaObject : object.name, def.title.field)
        : (value: string) => value;
      for (const r of read.rows) {
        const raw = text(r.title);
        const value = via ? (raw ? (via.get(raw) ?? null) : null) : raw;
        details.set(`${object.name}\u0000${r.id}`, {
          starts: text(r.starts),
          ends: text(r.ends),
          title: value ? shown(value) : null,
          provisional: !!r.state && (def.provisional ?? []).includes(r.state),
        });
      }
    }
  }

  const claims = rows.rows.map((r): RoomClaim => {
    const thing = {
      object: r.thing_object,
      id: r.thing_record,
      name: thingNames.get(r.thing_object)?.get(r.thing_record) ?? null,
    };
    const taken = { takenFrom: iso(r.starts), takenTo: iso(r.ends) };
    if (!options.full) {
      return {
        thing,
        object: null,
        label: null,
        id: null,
        title: null,
        startsAt: null,
        endsAt: null,
        ...taken,
        provisional: null,
      };
    }
    const object = getObject(r.object_type);
    const detail = details.get(`${r.object_type}\u0000${r.record_id}`);
    const label = object?.label ?? null;
    return {
      thing,
      object: r.object_type,
      label,
      id: r.record_id,
      title: detail?.title ?? label,
      startsAt: detail?.starts ?? null,
      endsAt: detail?.ends ?? null,
      ...taken,
      provisional: detail?.provisional ?? false,
    };
  });
  return { claims, truncated };
}
