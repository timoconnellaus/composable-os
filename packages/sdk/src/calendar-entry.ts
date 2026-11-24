// The `calendarEntry` declaration (stage 62 step 1, ADR 0891): an object whose records are events
// in its customer's calendar feed. Its manifest schema, the path walker the host's check shares,
// and the contract checks live here; the host's side (the feed's read, through the visibility seam
// as the customer) is packages/core/src/customers/calendar-feed.ts.
import { z } from "zod";
import type { ExtensionManifest, FieldManifest, ObjectManifest } from "./manifest.ts";

/**
 * Records of this object are events in their customer's private calendar feed (ADR 0891): a class
 * booking, a ticket, an appointment. The host reads them as the customer, through the visibility
 * seam, so the feed never shows a field the customer could not read.
 *
 * - `starts`, `ends`: a datetime path: a field of this object, or a relation of it and a field of
 *   what it names (`class.startsAt`), at most two relations deep.
 * - `title`: a text path, the event's name (`classType.name`): the public name of what was booked.
 * - `place` (optional): a text path, the event's place (`class.room.name`).
 * - `live`: the states of the object's `states` in which the record shows. A record in any other
 *   state (cancelled, moved), or in the Trash, drops out on the next fetch.
 *
 * The object declares a `customer` (whose feed it is in, and, where it opens to guardians, a live
 * guardian's too), and its customer's read list holds the states field and each path's first
 * field. A field one relation or more away must be one the customer reads of that object: what
 * it makes `public` or `signedIn`, or, one relation away, what its `customerVia` from this object
 * lists. A shipped pack's declaration only: a runtime extension declaring it fails the check.
 */
export interface CalendarEntrySpec {
  starts: string;
  ends: string;
  title: string;
  place?: string;
  live: readonly string[];
}

const path = z.string().min(1).max(122);

export const calendarEntryManifestSchema = z
  .object({
    starts: path,
    ends: path,
    title: path,
    place: path.optional(),
    live: z.array(z.string().min(1).max(100)).min(1).max(20),
  })
  .strict();
export type CalendarEntryManifest = z.infer<typeof calendarEntryManifestSchema>;

/** At most two relations, then the field: `class.room.name`. */
export const CALENDAR_PATH_MAX_SEGMENTS = 3;

/** What a path's last field may be, by key. */
export const CALENDAR_PATH_TYPES = {
  starts: ["datetime"],
  ends: ["datetime"],
  title: ["text", "select"],
  place: ["text", "select"],
} as const satisfies Record<"starts" | "ends" | "title" | "place", readonly string[]>;

/** One field, as the walker needs it. */
export interface CalendarPathField {
  type: string;
  many: boolean;
  /** A relation's target, as a registry name (`bookings.class`, `person`). */
  to?: string | undefined;
}

/** One object a path passes through, as the walker needs it. */
export interface CalendarPathObject {
  name: string;
  /** Whether it declares a customer of its own (a path never passes through one). */
  hasCustomer: boolean;
  field(name: string): CalendarPathField | undefined;
  /**
   * The fields a customer reads of this object's records, reached from their own record of `from`
   * through its relation `via` (`customerVia`, one relation away only), or as anyone signed in or
   * the public may.
   */
  readable(from: string | null, via: string | null): ReadonlySet<string>;
}

export type CalendarPathResult =
  | { ok: true; type: string; foreign: boolean }
  | { ok: false; message: string; foreign: boolean }
  /** The path reaches an object this checker leaves to another (the SDK: another extension's). */
  | { ok: "deferred" };

/**
 * Walks `path` from `origin`, the object declaring the entry, whose customer reads
 * `originRead`. `lookup` answers an object by registry name: undefined to defer it (not this
 * checker's), null when there is no such object. Pure.
 */
export function walkCalendarPath(
  origin: CalendarPathObject,
  originRead: ReadonlySet<string>,
  path: string,
  lookup: (name: string) => CalendarPathObject | null | undefined,
): CalendarPathResult {
  const segments = path.split(".");
  if (segments.length > CALENDAR_PATH_MAX_SEGMENTS || segments.some((s) => s === "")) {
    return {
      ok: false,
      message: `"${path}" must be a field, or at most two relations and a field`,
      foreign: false,
    };
  }
  let object = origin;
  let readable = originRead;
  let foreign = false;
  for (const [i, segment] of segments.entries()) {
    const field = object.field(segment);
    if (!field) {
      return { ok: false, message: `"${segment}" is not a field of ${object.name}`, foreign };
    }
    if (!readable.has(segment)) {
      return {
        ok: false,
        message:
          i === 0
            ? `"${segment}" must be in ${object.name}'s customer.read: the feed shows only what the customer reads`
            : `"${segment}" is not a field a customer reads of ${object.name} (its public, signedIn or customerVia read)`,
        foreign,
      };
    }
    if (i === segments.length - 1) return { ok: true, type: field.type, foreign };
    if (field.type !== "relation" || field.many || !field.to) {
      return {
        ok: false,
        message: `"${segment}" must be a relation to one record to reach "${segments[i + 1]}"`,
        foreign,
      };
    }
    const next = lookup(field.to);
    if (next === undefined) return { ok: "deferred" };
    foreign ||= !field.to.startsWith(`${origin.name.split(".")[0]}.`);
    if (next === null) return { ok: false, message: `${field.to} is not installed here`, foreign };
    if (next.hasCustomer) {
      return {
        ok: false,
        message: `${next.name} declares a customer of its own: a path cannot pass through it`,
        foreign,
      };
    }
    // Only one relation away does a customerVia from the declaring object count (the seam's
    // `via` scope reaches what the customer's own records point to, no further).
    readable = next.readable(i === 0 ? origin.name : null, i === 0 ? segment : null);
    object = next;
  }
  return { ok: false, message: `"${path}" is empty`, foreign };
}

/** A manifest object as the walker sees it. */
export function manifestPathObject(
  extensionId: string,
  local: string,
  object: ObjectManifest,
): CalendarPathObject {
  const name = `${extensionId}.${local}`;
  return {
    name,
    hasCustomer: object.customer !== undefined,
    field(fieldName) {
      const field: FieldManifest | undefined = Object.hasOwn(object.fields, fieldName)
        ? object.fields[fieldName]
        : undefined;
      return field ? { type: field.type, many: field.many === true, to: field.to } : undefined;
    },
    readable(from, via) {
      const out = new Set<string>([
        ...(object.public?.read ?? []),
        ...(object.signedIn?.read ?? []),
      ]);
      const v = object.customerVia;
      if (v && from !== null && v.from === from && v.field === via) {
        for (const f of v.read) out.add(f);
      }
      return out;
    },
  };
}

/** Reports problems with `objects.<name>.calendarEntry` through `contract`. */
export function checkObjectCalendarEntry(
  m: ExtensionManifest,
  name: string,
  object: ObjectManifest,
  contract: (path: string, message: string) => void,
): void {
  const entry = object.calendarEntry;
  if (!entry) return;
  const at = `objects.${name}.calendarEntry`;
  const customer = object.customer;
  if (!customer) {
    contract(at, `${name} must declare a customer: a calendar entry is in its customer's feed`);
    return;
  }
  const read = new Set(customer.read);

  // The states in which a record shows, which the customer reads.
  const states = object.states;
  if (!states) {
    contract(`${at}.live`, `${name} must declare states: a record shows in some of them`);
  } else {
    const field = Object.hasOwn(object.fields, states.field) ? object.fields[states.field] : null;
    const values = new Set((field?.options ?? []).map((o) => o.value));
    for (const state of entry.live) {
      if (!values.has(state)) contract(`${at}.live`, `"${state}" is not a state of ${name}`);
    }
    if (new Set(entry.live).size !== entry.live.length) {
      contract(`${at}.live`, "List each state once");
    }
    if (!read.has(states.field)) {
      contract(
        `${at}.live`,
        `"${states.field}" must be in ${name}'s customer.read: the feed reads the state as the customer`,
      );
    }
  }

  // Each path, as far as this extension's own objects go; the host checks another extension's.
  const origin = manifestPathObject(m.id, name, object);
  const lookup = (target: string) => {
    const local = target.startsWith(`${m.id}.`) ? target.slice(m.id.length + 1) : undefined;
    if (local === undefined) return undefined;
    return Object.hasOwn(m.objects, local)
      ? manifestPathObject(m.id, local, m.objects[local] as ObjectManifest)
      : null;
  };
  for (const key of ["starts", "ends", "title", "place"] as const) {
    const declared = entry[key];
    if (declared === undefined) continue;
    const result = walkCalendarPath(origin, read, declared, lookup);
    if (result.ok === "deferred") continue;
    if (!result.ok) contract(`${at}.${key}`, result.message);
    else if (!(CALENDAR_PATH_TYPES[key] as readonly string[]).includes(result.type)) {
      contract(
        `${at}.${key}`,
        `"${declared}" must end at a ${CALENDAR_PATH_TYPES[key].join(" or ")} field`,
      );
    }
  }
  if (entry.starts === entry.ends)
    contract(`${at}.ends`, "An event's start and end are two fields");
}
