// Input guards for every session input (ADR 0114: no capnweb-validate decorators, every RPC input
// checked by hand), and the shape of every answer. Each parser copies the known keys into a fresh
// object and refuses anything else as `invalid`. Each answer is copied key by key into the
// contract's shape (`shape*`), so whatever a system's API returns about a person, nothing outside
// the contract leaves the gatekeeper. Limits are the contract's, the same for every system.

import { refuse } from "./refusal.js";
import type {
  BookingSystemBooking,
  BookingSystemClass,
  BookingSystemClassesQuery,
  BookingSystemClassType,
  BookingSystemHint,
  BookingSystemMembership,
  BookingSystemMembershipType,
  BookingSystemPage,
  BookingSystemPeopleQuery,
  BookingSystemPerson,
  BookingSystemSite,
  BookingSystemStaff,
  BookingSystemVisitsQuery,
} from "./types.js";

/** A system's ref: whatever its ids are, printable and without spaces. */
const REF = /^[\x21-\x7e]{1,255}$/;
/** An ISO 8601 time with an offset (`Z` or `±hh:mm`). */
const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;
const CURSOR = /^[\x21-\x7e]{1,1000}$/;
const DAY_MS = 86_400_000;

/** `listMemberships` and `listPeople({ refs })` take at most this many people. */
export const MAX_PEOPLE = 200;
/** `listBookings` takes at most this many classes. */
export const MAX_CLASSES = 50;
/** `listClasses` covers at most this many days. */
export const MAX_CLASS_DAYS = 35;
/** `listVisits` covers at most this many days. */
export const MAX_VISIT_DAYS = 366;
export const MAX_HINTS = 100;
/** No text copied from a system is longer; a longer title or description is cut. */
export const MAX_TEXT = 500;

function invalid(message: string): never {
  throw refuse("invalid", message);
}

function record(value: unknown, what: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    invalid(`${what} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function onlyKeys(value: Record<string, unknown>, keys: readonly string[], what: string): void {
  const extra = Object.keys(value).filter((key) => !keys.includes(key));
  if (extra.length) invalid(`${what} has unknown key(s): ${extra.slice(0, 5).join(", ")}.`);
}

export function parseRef(value: unknown, what: string): string {
  if (typeof value !== "string" || !REF.test(value)) invalid(`${what} must be a system's ref.`);
  return value;
}

/** An ISO 8601 time with an offset, as milliseconds since the epoch and as given. */
export function parseTime(value: unknown, what: string): { text: string; ms: number } {
  const ms = typeof value === "string" && TIME.test(value) ? Date.parse(value) : Number.NaN;
  if (Number.isNaN(ms)) invalid(`${what} must be an ISO 8601 time with an offset.`);
  return { text: value as string, ms };
}

function refs(value: unknown, what: string, max: number): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > max) {
    invalid(`${what} must be a list of 1 to ${max} refs.`);
  }
  const out = value.map((ref, i) => parseRef(ref, `${what}[${i}]`));
  if (new Set(out).size !== out.length) invalid(`${what} names a ref twice.`);
  return out;
}

function cursor(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !CURSOR.test(value)) invalid("cursor must be a page's cursor.");
  return value;
}

function span(from: unknown, until: unknown, days: number): { from: string; until: string } {
  const start = parseTime(from, "from");
  const end = parseTime(until, "until");
  if (end.ms <= start.ms) invalid("until must be after from.");
  if (end.ms - start.ms > days * DAY_MS) invalid(`from to until is at most ${days} days.`);
  return { from: start.text, until: end.text };
}

export function parsePeopleQuery(value: unknown): BookingSystemPeopleQuery {
  const input = record(value ?? {}, "the query");
  onlyKeys(input, ["modifiedSince", "refs", "cursor"], "the query");
  const out: BookingSystemPeopleQuery = {};
  if (input.modifiedSince !== undefined) {
    out.modifiedSince = parseTime(input.modifiedSince, "modifiedSince").text;
  }
  if (input.refs !== undefined) out.refs = refs(input.refs, "refs", MAX_PEOPLE);
  const next = cursor(input.cursor);
  if (next !== undefined) out.cursor = next;
  return out;
}

export function parseMembershipsInput(value: unknown): { people: string[] } {
  const input = record(value, "the input");
  onlyKeys(input, ["people"], "the input");
  return { people: refs(input.people, "people", MAX_PEOPLE) };
}

export function parseClassesQuery(value: unknown): BookingSystemClassesQuery {
  const input = record(value, "the query");
  onlyKeys(input, ["from", "until", "modifiedSince", "cursor"], "the query");
  const out: BookingSystemClassesQuery = span(input.from, input.until, MAX_CLASS_DAYS);
  if (input.modifiedSince !== undefined) {
    out.modifiedSince = parseTime(input.modifiedSince, "modifiedSince").text;
  }
  const next = cursor(input.cursor);
  if (next !== undefined) out.cursor = next;
  return out;
}

export function parseBookingsInput(value: unknown): { classes: string[] } {
  const input = record(value, "the input");
  onlyKeys(input, ["classes"], "the input");
  return { classes: refs(input.classes, "classes", MAX_CLASSES) };
}

export function parseVisitsQuery(value: unknown): BookingSystemVisitsQuery {
  const input = record(value, "the query");
  onlyKeys(input, ["person", "from", "until", "cursor"], "the query");
  const out: BookingSystemVisitsQuery = {
    person: parseRef(input.person, "person"),
    ...span(input.from, input.until, MAX_VISIT_DAYS),
  };
  const next = cursor(input.cursor);
  if (next !== undefined) out.cursor = next;
  return out;
}

export function parseHintsInput(value: unknown): { max: number } {
  const input = record(value, "the input");
  onlyKeys(input, ["max"], "the input");
  const { max } = input;
  if (typeof max !== "number" || !Number.isInteger(max) || max < 1 || max > MAX_HINTS) {
    invalid(`max must be a whole number from 1 to ${MAX_HINTS}.`);
  }
  return { max };
}

// --- The shape of every answer. ------------------------------------------------------------------

/** Every key each item of the contract has: the conformance suite checks answers against these. */
export const CONTRACT_KEYS = {
  site: ["calls", "locations", "name", "offers", "timeZone"],
  person: ["active", "email", "familyName", "givenName", "memberStatus", "modifiedAt", "ref"],
  membershipType: ["active", "kind", "name", "ref"],
  membership: [
    "from",
    "kind",
    "name",
    "person",
    "ref",
    "renews",
    "status",
    "type",
    "until",
    "usesLeft",
    "usesTotal",
  ],
  classType: ["active", "description", "name", "ref"],
  class: [
    "booked",
    "cancelled",
    "classType",
    "endsAt",
    "location",
    "modifiedAt",
    "places",
    "ref",
    "staff",
    "startsAt",
    "title",
    "waiting",
  ],
  booking: ["class", "modifiedAt", "person", "ref", "state"],
  staff: ["active", "displayName", "email", "ref"],
  hint: ["kind", "refs"],
} as const satisfies Record<string, readonly string[]>;

function cut(value: string): string;
function cut(value: string | null): string | null;
function cut(value: string | null): string | null {
  return value === null ? null : value.slice(0, MAX_TEXT);
}

function pick<T>(value: T, keys: readonly string[]): T {
  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of keys) out[key] = source[key] ?? null;
  return out as T;
}

export function shapeSite(site: BookingSystemSite): BookingSystemSite {
  return {
    name: cut(site.name),
    timeZone: site.timeZone,
    locations: site.locations.map((l) => ({ ref: l.ref, name: cut(l.name) })),
    offers: {
      source: site.offers.source === "file" ? "file" : "api",
      modifiedSince: {
        people: site.offers.modifiedSince.people === true,
        classes: site.offers.modifiedSince.classes === true,
      },
      hints: site.offers.hints === "webhooks" ? "webhooks" : "none",
      largestPage: site.offers.largestPage,
    },
    calls: {
      month: site.calls.month,
      used: site.calls.used,
      budget: site.calls.budget ?? null,
      byMethod: { ...site.calls.byMethod },
    },
  };
}

export function shapePerson(p: BookingSystemPerson): BookingSystemPerson {
  const out = pick(p, CONTRACT_KEYS.person);
  out.givenName = cut(out.givenName);
  out.familyName = cut(out.familyName);
  return out;
}

export function shapeMembershipType(t: BookingSystemMembershipType): BookingSystemMembershipType {
  const out = pick(t, CONTRACT_KEYS.membershipType);
  out.name = cut(out.name);
  return out;
}

export function shapeMembership(m: BookingSystemMembership): BookingSystemMembership {
  const out = pick(m, CONTRACT_KEYS.membership);
  out.name = cut(out.name);
  return out;
}

export function shapeClassType(t: BookingSystemClassType): BookingSystemClassType {
  const out = pick(t, CONTRACT_KEYS.classType);
  out.name = cut(out.name);
  out.description = cut(out.description);
  return out;
}

export function shapeClass(c: BookingSystemClass): BookingSystemClass {
  const out = pick(c, CONTRACT_KEYS.class);
  out.title = cut(out.title);
  return out;
}

export function shapeBooking(b: BookingSystemBooking): BookingSystemBooking {
  return pick(b, CONTRACT_KEYS.booking);
}

export function shapeStaff(s: BookingSystemStaff): BookingSystemStaff {
  const out = pick(s, CONTRACT_KEYS.staff);
  out.displayName = cut(out.displayName);
  return out;
}

export function shapeHint(h: BookingSystemHint): BookingSystemHint {
  return { kind: h.kind, refs: [...h.refs] };
}

export function shapePage<T>(page: BookingSystemPage<T>, item: (v: T) => T): BookingSystemPage<T> {
  return { items: page.items.map(item), cursor: page.cursor ?? null };
}
