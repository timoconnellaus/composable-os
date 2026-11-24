// The file source (stage 65, owner's decision of 2026-11-24; ADR 0920): the same read-only
// contract, read from files a business exports from its booking system and a member of staff
// loads, instead of from a system's API. A people file (each person with their membership or pass,
// its status and dates, one row per membership) is required; a class timetable is optional. Each
// file's columns are mapped by name, its values mapped onto the contract's words (with the common
// words understood without a mapping), and a dry run says what would be loaded, which rows are
// refused and why, and, given the host's matching context, who would be linked. Nothing is ever
// written anywhere but the copy, and a file makes no calls.

import { type MatchContext, type MatchOutcome, matchPeople } from "./match.js";
import { refuse } from "./refusal.js";
import type { BookingSystem } from "./system.js";
import type {
  BookingSystemBooking,
  BookingSystemClass,
  BookingSystemClassType,
  BookingSystemHint,
  BookingSystemLocation,
  BookingSystemMemberStatus,
  BookingSystemMembership,
  BookingSystemMembershipKind,
  BookingSystemMembershipStatus,
  BookingSystemMembershipType,
  BookingSystemPage,
  BookingSystemPeopleQuery,
  BookingSystemPerson,
  BookingSystemSite,
  BookingSystemStaff,
} from "./types.js";
import { MAX_TEXT, parseTime } from "./validate.js";

/** A file is at most this many characters. */
export const MAX_FILE_CHARS = 5_000_000;
export const MAX_PEOPLE_ROWS = 20_000;
export const MAX_TIMETABLE_ROWS = 5_000;
/** A page of a file source's lists. */
export const FILE_PAGE = 200;
/** A dry run lists at most this many refused rows. */
export const MAX_ISSUES_SHOWN = 100;

export type FileDateFormat = "YYYY-MM-DD" | "DD/MM/YYYY" | "MM/DD/YYYY";

/** Which column holds each field, by its header. Only `email` is required. */
export interface PeopleFileMapping {
  columns: {
    email: string;
    /** The booking system's own id for the person; without it the address is the ref. */
    ref?: string;
    givenName?: string;
    familyName?: string;
    memberStatus?: string;
    active?: string;
    membershipType?: string;
    membershipKind?: string;
    membershipStatus?: string;
    from?: string;
    until?: string;
    usesTotal?: string;
    usesLeft?: string;
    renews?: string;
  };
  /** The file's own words for each value, beside the common ones understood without a mapping. */
  values?: {
    memberStatus?: Record<string, BookingSystemMemberStatus>;
    membershipStatus?: Record<string, BookingSystemMembershipStatus>;
    membershipKind?: Record<string, BookingSystemMembershipKind>;
  };
  dateFormat?: FileDateFormat;
}

/** Which column holds each field of a class. `title` and `startsAt` are required. */
export interface TimetableFileMapping {
  columns: {
    title: string;
    /** An ISO 8601 time with an offset, or a day and time in the site's time zone. */
    startsAt: string;
    endsAt?: string;
    /** When there is no end: the length in minutes (60 without either). */
    durationMinutes?: string;
    ref?: string;
    classType?: string;
    location?: string;
    staff?: string;
    places?: string;
    booked?: string;
    waiting?: string;
    cancelled?: string;
  };
  dateFormat?: FileDateFormat;
}

export interface FileSourceInput {
  site: { name: string; timeZone: string };
  people: { text: string; mapping: PeopleFileMapping };
  timetable?: { text: string; mapping: TimetableFileMapping };
  /** Today, for a membership with no status (live until its end date). Defaults to now. */
  now?: string;
}

/** A row refused, or a value not understood. Rows are counted from 1 after the header. */
export interface FileIssue {
  file: "people" | "timetable";
  row: number;
  column?: string;
  problem: string;
}

export interface FileLoad {
  site: { name: string; timeZone: string; locations: BookingSystemLocation[] };
  people: BookingSystemPerson[];
  membershipTypes: BookingSystemMembershipType[];
  memberships: BookingSystemMembership[];
  classTypes: BookingSystemClassType[];
  classes: BookingSystemClass[];
  staff: BookingSystemStaff[];
  issues: FileIssue[];
  rows: { people: number; timetable: number };
}

export interface FileDryRun {
  rows: { people: number; timetable: number };
  /** What would be loaded. */
  counts: {
    people: number;
    members: number;
    memberships: number;
    passes: number;
    membershipTypes: number;
    classes: number;
    staff: number;
  };
  /** How many rows were refused or had a value not understood, and the first of them. */
  issueCount: number;
  issues: FileIssue[];
  /** The first five people as they would be read, with their memberships. */
  sample: { person: BookingSystemPerson; memberships: BookingSystemMembership[] }[];
  /** With the host's matching context: how many would be linked, wait for staff, or stay unlinked. */
  matching?: {
    linked: number;
    kept: number;
    waiting: Record<"several_people" | "shared_address" | "no_address", number>;
    unlinked: number;
    dropped: number;
    outcomes: MatchOutcome[];
  };
}

// --- CSV. ------------------------------------------------------------------------------------------

/**
 * Rows of a CSV file (RFC 4180: commas, quotes doubled inside quoted fields, CRLF or LF), with a
 * byte-order mark dropped and blank lines skipped. A semicolon or tab file is read when its first
 * line has more of those than commas.
 */
export function parseCsv(text: string): string[][] {
  if (text.length > MAX_FILE_CHARS) throw refuse("invalid", "The file is over 5 MB.");
  const body = text.startsWith("﻿") ? text.slice(1) : text;
  const firstLine = body.slice(0, body.search(/\r?\n|$/));
  const counts = { ",": 0, ";": 0, "\t": 0 };
  for (const ch of firstLine) if (ch in counts) counts[ch as keyof typeof counts] += 1;
  const sep = (Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? ",") as string;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i] as string;
    if (quoted) {
      if (ch === '"' && body[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') {
        quoted = false;
      } else {
        field += ch;
      }
    } else if (ch === '"' && field === "") {
      quoted = true;
    } else if (ch === sep) {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && body[i + 1] === "\n") i++;
      row.push(field);
      if (row.some((f) => f.trim() !== "")) rows.push(row);
      row = [];
      field = "";
    } else {
      field += ch;
    }
  }
  if (quoted) throw refuse("invalid", "The file ends inside a quoted field.");
  row.push(field);
  if (row.some((f) => f.trim() !== "")) rows.push(row);
  return rows;
}

// --- Values. ---------------------------------------------------------------------------------------

function key(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, " ");
}

function slug(value: string): string {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 80) || "x"
  );
}

function cut(value: string): string {
  return value.trim().slice(0, MAX_TEXT);
}

const MEMBER_STATUS_WORDS: Record<string, BookingSystemMemberStatus> = {
  member: "member",
  active: "member",
  current: "member",
  "not member": "not_member",
  "non member": "not_member",
  nonmember: "not_member",
  lead: "not_member",
  prospect: "not_member",
  suspended: "suspended",
  expired: "expired",
  ended: "ended",
  terminated: "ended",
  cancelled: "ended",
  canceled: "ended",
  former: "ended",
  declined: "declined",
};

const MEMBERSHIP_STATUS_WORDS: Record<string, BookingSystemMembershipStatus> = {
  live: "live",
  active: "live",
  current: "live",
  paused: "paused",
  frozen: "paused",
  "on hold": "paused",
  suspended: "paused",
  ended: "ended",
  expired: "ended",
  finished: "ended",
  cancelled: "cancelled",
  canceled: "cancelled",
  terminated: "cancelled",
};

const KIND_WORDS: Record<string, BookingSystemMembershipKind> = {
  membership: "membership",
  contract: "membership",
  subscription: "membership",
  autopay: "membership",
  pass: "pass",
  pack: "pass",
  "class pack": "pass",
  "drop in": "pass",
  dropin: "pass",
  credits: "pass",
  "punch card": "pass",
};

const YES = new Set(["yes", "y", "true", "1", "active", "on"]);
const NO = new Set(["no", "n", "false", "0", "inactive", "off"]);

function word<T>(
  raw: string,
  own: Record<string, T> | undefined,
  common: Record<string, T>,
): T | null {
  const k = key(raw);
  for (const [from, to] of Object.entries(own ?? {})) if (key(from) === k) return to;
  return common[k] ?? null;
}

function flag(raw: string): boolean | null {
  const k = key(raw);
  return YES.has(k) ? true : NO.has(k) ? false : null;
}

function whole(raw: string): number | null {
  const t = raw.trim();
  return /^\d{1,9}$/.test(t) ? Number(t) : null;
}

/** A day of the calendar from a file's date, or `null`. A time after the day is ignored. */
function day(raw: string, format: FileDateFormat): string | null {
  const t = raw.trim().split(/[T ]/)[0] ?? "";
  let y: number;
  let m: number;
  let d: number;
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(t);
  const slash = /^(\d{1,2})[/.](\d{1,2})[/.](\d{4})$/.exec(t);
  if (iso) [y, m, d] = [Number(iso[1]), Number(iso[2]), Number(iso[3])];
  else if (slash && format === "DD/MM/YYYY")
    [d, m, y] = [Number(slash[1]), Number(slash[2]), Number(slash[3])];
  else if (slash && format === "MM/DD/YYYY")
    [m, d, y] = [Number(slash[1]), Number(slash[2]), Number(slash[3])];
  else return null;
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d)
    return null;
  return date.toISOString().slice(0, 10);
}

/** The offset of `timeZone` from UTC, in milliseconds, at the instant `ms`. */
function offsetAt(ms: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(ms));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const asUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour"),
    get("minute"),
    get("second"),
  );
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/** A time from a file: ISO 8601 with an offset as given; a day and `HH:mm` in the site's zone. */
function instant(raw: string, format: FileDateFormat, timeZone: string): string | null {
  const t = raw.trim();
  try {
    return new Date(parseTime(t, "time").ms).toISOString();
  } catch {
    // Not an ISO time with an offset: a local day and time.
  }
  const match = /^(.+?)[T ](\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(t);
  const date = match ? day(match[1] as string, format) : null;
  if (!match || !date) return null;
  const [h, mi, s] = [Number(match[2]), Number(match[3]), Number(match[4] ?? 0)];
  if (h > 23 || mi > 59 || s > 59) return null;
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const local = Date.UTC(y, m - 1, d, h, mi, s);
  // Twice, so a time near a daylight-saving change takes the offset in force at that time.
  let utc = local - offsetAt(local, timeZone);
  utc = local - offsetAt(utc, timeZone);
  return new Date(utc).toISOString();
}

/** The header's index for each mapped column; a mapped column missing from the file is refused. */
function columnsOf(header: string[], columns: Record<string, string | undefined>, file: string) {
  const at = new Map(header.map((h, i) => [key(h), i]));
  const index: Record<string, number> = {};
  for (const [field, name] of Object.entries(columns)) {
    if (name === undefined) continue;
    const i = at.get(key(name));
    if (i === undefined)
      throw refuse("invalid", `The ${file} file has no column "${name}" (${field}).`);
    index[field] = i;
  }
  return index;
}

function checkZone(timeZone: string): void {
  try {
    new Intl.DateTimeFormat("en", { timeZone });
  } catch {
    throw refuse("invalid", `${timeZone} is not an IANA time zone.`);
  }
}

// --- Loading. --------------------------------------------------------------------------------------

/**
 * Reads the files into the contract's records. A file that cannot be read at all (no header, a
 * mapped column missing, too many rows) is refused `invalid`; a row that cannot be used is left out
 * and named in `issues`, and a value not understood is named and left empty.
 */
export function loadFiles(input: FileSourceInput): FileLoad {
  checkZone(input.site.timeZone);
  const today = (input.now ? new Date(Date.parse(input.now)) : new Date())
    .toISOString()
    .slice(0, 10);
  const issues: FileIssue[] = [];
  const people = new Map<string, BookingSystemPerson>();
  const types = new Map<string, BookingSystemMembershipType>();
  const memberships = new Map<string, BookingSystemMembership>();
  const explicitStatus = new Set<string>();

  const { mapping } = input.people;
  const format = mapping.dateFormat ?? "YYYY-MM-DD";
  const [header, ...rows] = parseCsv(input.people.text);
  if (!header) throw refuse("invalid", "The people file is empty.");
  if (rows.length > MAX_PEOPLE_ROWS)
    throw refuse("invalid", `The people file is over ${MAX_PEOPLE_ROWS} rows.`);
  const col = columnsOf(header, { ...mapping.columns }, "people");
  rows.forEach((cells, i) => {
    const row = i + 1;
    const cell = (field: keyof PeopleFileMapping["columns"]) => {
      const at = col[field];
      return at === undefined ? "" : (cells[at] ?? "").trim();
    };
    const note = (column: string, problem: string) =>
      issues.push({ file: "people", row, column, problem });
    let email: string | null = cell("email") || null;
    if (email !== null && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      note(mapping.columns.email, `"${email.slice(0, 100)}" is not an address; read without one`);
      email = null;
    }
    const own = cell("ref");
    if (!own && email === null) {
      issues.push({ file: "people", row, problem: "no address and no id: the row is left out" });
      return;
    }
    const ref = own
      ? own.slice(0, 255).replace(/\s+/g, "-")
      : `email:${(email as string).toLowerCase()}`;
    let person = people.get(ref);
    if (!person) {
      let active = true;
      if (cell("active")) {
        const f = flag(cell("active"));
        if (f === null)
          note(mapping.columns.active as string, `"${cell("active")}" is not yes or no`);
        else active = f;
      }
      let memberStatus: BookingSystemMemberStatus = "not_member";
      if (cell("memberStatus")) {
        const w = word(cell("memberStatus"), mapping.values?.memberStatus, MEMBER_STATUS_WORDS);
        if (w === null)
          note(
            mapping.columns.memberStatus as string,
            `"${cell("memberStatus")}" is not a member status this file maps`,
          );
        else {
          memberStatus = w;
          explicitStatus.add(ref);
        }
      }
      person = {
        ref,
        email,
        givenName: cut(cell("givenName")) || null,
        familyName: cut(cell("familyName")) || null,
        memberStatus,
        active,
        modifiedAt: null,
      };
      people.set(ref, person);
    } else if (
      email !== null &&
      person.email !== null &&
      email.toLowerCase() !== person.email.toLowerCase()
    ) {
      note(
        mapping.columns.email,
        `another address for ${ref} than an earlier row; the first is kept`,
      );
    }

    const typeName = cut(cell("membershipType"));
    if (!typeName) return;
    const usesTotal = cell("usesTotal") ? whole(cell("usesTotal")) : null;
    const usesLeft = cell("usesLeft") ? whole(cell("usesLeft")) : null;
    if (cell("usesTotal") && usesTotal === null)
      note(mapping.columns.usesTotal as string, "not a whole number");
    if (cell("usesLeft") && usesLeft === null)
      note(mapping.columns.usesLeft as string, "not a whole number");
    let kind: BookingSystemMembershipKind =
      usesTotal !== null || usesLeft !== null ? "pass" : "membership";
    if (cell("membershipKind")) {
      const w = word(cell("membershipKind"), mapping.values?.membershipKind, KIND_WORDS);
      if (w === null)
        note(
          mapping.columns.membershipKind as string,
          `"${cell("membershipKind")}" is not a membership or a pass`,
        );
      else kind = w;
    }
    const date = (field: "from" | "until") => {
      if (!cell(field)) return null;
      const d = day(cell(field), format);
      if (d === null)
        note(mapping.columns[field] as string, `"${cell(field)}" is not a date (${format})`);
      return d;
    };
    const from = date("from");
    const until = date("until");
    let status: BookingSystemMembershipStatus = until !== null && until < today ? "ended" : "live";
    if (cell("membershipStatus")) {
      const w = word(
        cell("membershipStatus"),
        mapping.values?.membershipStatus,
        MEMBERSHIP_STATUS_WORDS,
      );
      if (w === null)
        note(
          mapping.columns.membershipStatus as string,
          `"${cell("membershipStatus")}" is not a membership status this file maps`,
        );
      else status = w;
    }
    const typeRef = `type:${kind}:${slug(typeName)}`;
    if (!types.has(typeRef))
      types.set(typeRef, { ref: typeRef, name: typeName, kind, active: true });
    const membershipRef = `${ref}|${typeRef}|${from ?? ""}`;
    if (memberships.has(membershipRef)) {
      issues.push({
        file: "people",
        row,
        problem: `the same ${kind} for ${ref} twice; the first is kept`,
      });
      return;
    }
    memberships.set(membershipRef, {
      ref: membershipRef,
      person: ref,
      type: typeRef,
      name: (types.get(typeRef) as BookingSystemMembershipType).name,
      kind,
      status,
      from,
      until,
      usesTotal,
      usesLeft: usesLeft !== null && usesTotal !== null ? Math.min(usesLeft, usesTotal) : usesLeft,
      renews: cell("renews") ? flag(cell("renews")) === true : false,
    });
  });
  // With no status column, a person with a live membership (not a pass) is a member.
  for (const m of memberships.values()) {
    const person = people.get(m.person);
    if (
      person &&
      !explicitStatus.has(person.ref) &&
      m.kind === "membership" &&
      m.status === "live"
    ) {
      person.memberStatus = "member";
    }
  }

  const classes: BookingSystemClass[] = [];
  const classTypes = new Map<string, BookingSystemClassType>();
  const staff = new Map<string, BookingSystemStaff>();
  const locations = new Map<string, BookingSystemLocation>();
  let timetableRows = 0;
  if (input.timetable) {
    const t = input.timetable.mapping;
    const tFormat = t.dateFormat ?? "YYYY-MM-DD";
    const [tHeader, ...tRows] = parseCsv(input.timetable.text);
    if (!tHeader) throw refuse("invalid", "The timetable file is empty.");
    if (tRows.length > MAX_TIMETABLE_ROWS) {
      throw refuse("invalid", `The timetable file is over ${MAX_TIMETABLE_ROWS} rows.`);
    }
    timetableRows = tRows.length;
    const tCol = columnsOf(tHeader, { ...t.columns }, "timetable");
    const seen = new Set<string>();
    tRows.forEach((cells, i) => {
      const row = i + 1;
      const cell = (field: keyof TimetableFileMapping["columns"]) => {
        const at = tCol[field];
        return at === undefined ? "" : (cells[at] ?? "").trim();
      };
      const note = (column: string, problem: string) =>
        issues.push({ file: "timetable", row, column, problem });
      const title = cut(cell("title"));
      const startsAt = instant(cell("startsAt"), tFormat, input.site.timeZone);
      if (!title || startsAt === null) {
        issues.push({
          file: "timetable",
          row,
          problem: !title
            ? "no title: the row is left out"
            : `"${cell("startsAt")}" is not a time: the row is left out`,
        });
        return;
      }
      let endsAt: string | null = null;
      if (cell("endsAt")) {
        endsAt = instant(cell("endsAt"), tFormat, input.site.timeZone);
        // An end given as a time of day alone is on the start's day.
        if (endsAt === null && /^\d{1,2}:\d{2}$/.test(cell("endsAt"))) {
          const local = new Date(
            Date.parse(startsAt) + offsetAt(Date.parse(startsAt), input.site.timeZone),
          );
          endsAt = instant(
            `${local.toISOString().slice(0, 10)} ${cell("endsAt")}`,
            "YYYY-MM-DD",
            input.site.timeZone,
          );
        }
        if (endsAt === null) note(t.columns.endsAt as string, `"${cell("endsAt")}" is not a time`);
      }
      if (endsAt === null) {
        const minutes = cell("durationMinutes") ? whole(cell("durationMinutes")) : null;
        if (cell("durationMinutes") && minutes === null)
          note(t.columns.durationMinutes as string, "not a whole number of minutes");
        endsAt = new Date(Date.parse(startsAt) + (minutes ?? 60) * 60_000).toISOString();
      }
      if (Date.parse(endsAt) <= Date.parse(startsAt)) {
        issues.push({
          file: "timetable",
          row,
          problem: "it ends before it starts: the row is left out",
        });
        return;
      }
      const typeName = cut(cell("classType")) || title;
      const classType = `class-type:${slug(typeName)}`;
      if (!classTypes.has(classType)) {
        classTypes.set(classType, {
          ref: classType,
          name: typeName,
          description: null,
          active: true,
        });
      }
      let location: string | null = null;
      if (cell("location")) {
        location = `location:${slug(cell("location"))}`;
        if (!locations.has(location))
          locations.set(location, { ref: location, name: cut(cell("location")) });
      }
      let staffRef: string | null = null;
      if (cell("staff")) {
        staffRef = `staff:${slug(cell("staff"))}`;
        if (!staff.has(staffRef)) {
          staff.set(staffRef, {
            ref: staffRef,
            displayName: cut(cell("staff")),
            email: null,
            active: true,
          });
        }
      }
      const count = (field: "places" | "booked" | "waiting") => {
        if (!cell(field)) return null;
        const n = whole(cell(field));
        if (n === null) note(t.columns[field] as string, "not a whole number");
        return n;
      };
      const ref = cell("ref")
        ? cell("ref").slice(0, 255).replace(/\s+/g, "-")
        : `class:${startsAt}:${slug(title)}`;
      if (seen.has(ref)) {
        issues.push({ file: "timetable", row, problem: `${ref} twice; the first is kept` });
        return;
      }
      seen.add(ref);
      classes.push({
        ref,
        classType,
        title,
        startsAt,
        endsAt,
        location,
        staff: staffRef,
        places: count("places"),
        booked: count("booked") ?? 0,
        waiting: count("waiting") ?? 0,
        cancelled: cell("cancelled") ? flag(cell("cancelled")) === true : false,
        modifiedAt: null,
      });
    });
  }
  return {
    site: {
      name: cut(input.site.name) || "Loaded files",
      timeZone: input.site.timeZone,
      locations: [...locations.values()],
    },
    people: [...people.values()],
    membershipTypes: [...types.values()],
    memberships: [...memberships.values()],
    classTypes: [...classTypes.values()],
    classes,
    staff: [...staff.values()],
    issues,
    rows: { people: rows.length, timetable: timetableRows },
  };
}

/** What loading the files would do, without keeping anything; with `match`, who would be linked. */
export function dryRunFiles(input: FileSourceInput, match?: MatchContext): FileDryRun {
  const load = loadFiles(input);
  const byPerson = new Map<string, BookingSystemMembership[]>();
  for (const m of load.memberships) byPerson.set(m.person, [...(byPerson.get(m.person) ?? []), m]);
  const result: FileDryRun = {
    rows: load.rows,
    counts: {
      people: load.people.length,
      members: load.people.filter((p) => p.memberStatus === "member").length,
      memberships: load.memberships.filter((m) => m.kind === "membership").length,
      passes: load.memberships.filter((m) => m.kind === "pass").length,
      membershipTypes: load.membershipTypes.length,
      classes: load.classes.length,
      staff: load.staff.length,
    },
    issueCount: load.issues.length,
    issues: load.issues.slice(0, MAX_ISSUES_SHOWN),
    sample: load.people
      .slice(0, 5)
      .map((person) => ({ person, memberships: byPerson.get(person.ref) ?? [] })),
  };
  if (match) {
    const outcomes = matchPeople(load.people, match);
    const waiting = { several_people: 0, shared_address: 0, no_address: 0 };
    for (const o of outcomes) if (o.outcome === "waiting") waiting[o.why] += 1;
    const n = (outcome: MatchOutcome["outcome"]) =>
      outcomes.filter((o) => o.outcome === outcome).length;
    result.matching = {
      linked: n("linked"),
      kept: n("kept"),
      waiting,
      unlinked: n("unlinked"),
      dropped: n("dropped"),
      outcomes,
    };
  }
  return result;
}

function pageOf<T>(items: T[], cursor: string | undefined): BookingSystemPage<T> {
  let offset = 0;
  if (cursor !== undefined) {
    const match = /^file-page-(\d{1,9})$/.exec(cursor);
    if (!match) throw refuse("invalid", "Not a cursor of this file source.");
    offset = Number(match[1]);
  }
  const next = offset + FILE_PAGE;
  return {
    items: structuredClone(items.slice(offset, next)),
    cursor: next < items.length ? `file-page-${next}` : null,
  };
}

/**
 * The contract over loaded files. Nothing changes between loads, so there is no `modifiedSince`
 * (refused), no hint, no booking or visit, and no call to count.
 */
export class FileBookingSystem implements BookingSystem {
  readonly title: string;
  readonly #load: FileLoad;

  constructor(load: FileLoad, title = "Loaded files") {
    this.#load = load;
    this.title = title;
  }

  async describeSite(): Promise<BookingSystemSite> {
    return {
      name: this.#load.site.name,
      timeZone: this.#load.site.timeZone,
      locations: structuredClone(this.#load.site.locations),
      offers: {
        source: "file",
        modifiedSince: { people: false, classes: false },
        hints: "none",
        largestPage: FILE_PAGE,
      },
      calls: { month: new Date().toISOString().slice(0, 7), used: 0, budget: null, byMethod: {} },
    };
  }

  async listPeople(
    query: BookingSystemPeopleQuery,
  ): Promise<BookingSystemPage<BookingSystemPerson>> {
    if (query.modifiedSince !== undefined) {
      throw refuse("invalid", "A file has no change times: read it whole, or by refs.");
    }
    const refs = query.refs ? new Set(query.refs) : null;
    const people = this.#load.people
      .filter((p) => refs === null || refs.has(p.ref))
      .sort((a, b) => (a.ref < b.ref ? -1 : 1));
    return pageOf(people, query.cursor);
  }

  async listMembershipTypes(): Promise<BookingSystemMembershipType[]> {
    return structuredClone(this.#load.membershipTypes);
  }

  async listMemberships(people: string[]): Promise<BookingSystemMembership[]> {
    const asked = new Set(people);
    return structuredClone(this.#load.memberships.filter((m) => asked.has(m.person)));
  }

  async listClassTypes(): Promise<BookingSystemClassType[]> {
    return structuredClone(this.#load.classTypes);
  }

  async listClasses(query: {
    from: string;
    until: string;
    modifiedSince?: string;
    cursor?: string;
  }): Promise<BookingSystemPage<BookingSystemClass>> {
    if (query.modifiedSince !== undefined) {
      throw refuse("invalid", "A file has no change times: read the window whole.");
    }
    const from = Date.parse(query.from);
    const until = Date.parse(query.until);
    const classes = this.#load.classes
      .filter((c) => Date.parse(c.startsAt) >= from && Date.parse(c.startsAt) < until)
      .sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt) || (a.ref < b.ref ? -1 : 1));
    return pageOf(classes, query.cursor);
  }

  /** A timetable file says how many are booked, never who. */
  async listBookings(_classes: string[]): Promise<BookingSystemBooking[]> {
    return [];
  }

  async listStaff(): Promise<BookingSystemStaff[]> {
    return structuredClone(this.#load.staff);
  }

  async listVisits(): Promise<BookingSystemPage<BookingSystemBooking>> {
    return { items: [], cursor: null };
  }

  async takeHints(_max: number): Promise<BookingSystemHint[]> {
    return [];
  }
}
