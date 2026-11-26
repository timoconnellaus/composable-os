// The file source (stage 65, owner's decision of 2026-11-24; ADR 0920, ADR 0923): the same
// read-only contract, read from files a business exports from its booking system and a member of
// staff loads, instead of from a system's API. A people file (each person with their membership or
// pass, its status and dates, one row per membership) and a class timetable (one row per booking,
// or one per class with none) are loaded separately, each as its own list. Each file's columns are
// mapped by name, its values mapped onto the contract's words (with the common words understood
// without a mapping), and a dry run says what would be loaded, which rows are refused and why,
// and, given the host's matching context, who would be linked. Nothing is ever written anywhere
// but the copy, and a file makes no calls.
//
// A file is hostile input (stage 65 step 4): its size, rows, columns and cells are bounded while
// it is read, not after; a value is only ever text (a cell starting `=`, `+`, `-` or `@` is kept as
// the text it is, never evaluated); control and direction-changing characters are dropped from
// every text kept, addresses included (`cleanAddress`, then the host's own check: an address it
// does not take leaves the row out, never kept without it); every address a row carries is
// handed to the host, a booking's beside its id too; refs are kept printable whatever the file's
// ids are; a refused row's issue quotes at most 40 characters of a value, never an address.
// Decoding the file's bytes (its encoding, and refusing what is not delimited text) is the
// host's, before this.

import { type MatchContext, type MatchOutcome, matchPeople } from "./match.js";
import { refuse } from "./refusal.js";
import type { BookingSystem } from "./system.js";
import type {
  BookingSystemBooking,
  BookingSystemBookingState,
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

/** A file is at most this many characters (10 MB, as the admin's CSV import, ADR 0020). */
export const MAX_FILE_CHARS = 10_000_000;
export const MAX_PEOPLE_ROWS = 20_000;
/** A timetable file is one row per booking (or per class with none). */
export const MAX_TIMETABLE_ROWS = 20_000;
/** A file has at most this many columns, and a cell at most this many characters. */
export const MAX_COLUMNS = 100;
export const MAX_CELL = 10_000;
/**
 * A file names at most this many membership types, class types, coaches or locations: more is a
 * column mapped wrongly (a person's name taken for a plan), refused before anything is planned.
 */
export const MAX_NAMED = 500;
/** A timetable file holds at most this many classes. */
export const MAX_FILE_CLASSES = 5_000;
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
    /** A membership type's name (as the file writes it) to its kind, over any kind column. */
    membershipType?: Record<string, BookingSystemMembershipKind>;
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
    /** The coach's address, where the export gives it (to match them to a staff account). */
    staffEmail?: string;
    places?: string;
    booked?: string;
    waiting?: string;
    cancelled?: string;
    /** Who is booked: the members list's id for them, or their address. */
    person?: string;
    personEmail?: string;
    bookingRef?: string;
    bookingState?: string;
  };
  values?: {
    bookingState?: Record<string, BookingSystemBookingState>;
  };
  dateFormat?: FileDateFormat;
}

export interface FileSourceInput {
  site: { name: string; timeZone: string };
  /** A people (members) file. At least one of `people` and `timetable`. */
  people?: { text: string; mapping: PeopleFileMapping };
  timetable?: { text: string; mapping: TimetableFileMapping };
  /** Today, for a membership with no status (live until its end date). Defaults to now. */
  now?: string;
  /**
   * The host's own check of an address, after `cleanAddress`: the form its suppressions and
   * erased addresses are keyed by, or null when it takes none. One check, so the file and the host
   * cannot disagree about what an address is. Without one, the plain shape, lower-cased.
   */
  normaliseAddress?: (address: string) => string | null;
  /**
   * Columns, by header, whose values the host checks a mapping against though it reads no field
   * from them (a names column left unmapped): their distinct values come back in `seen`, for the
   * host's checks only, never kept.
   */
  watch?: readonly string[];
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
  bookings: BookingSystemBooking[];
  /**
   * The address the file gave for a booking's person, by booking ref, when it also gave their id:
   * the host checks it against erased addresses too (stage 65 step 4's review, S2).
   */
  bookingAddresses: Record<string, string>;
  staff: BookingSystemStaff[];
  issues: FileIssue[];
  rows: { people: number; timetable: number };
  /** Cells kept that start as a spreadsheet formula would (`=`, `+`, `-`, `@`): kept as text. */
  formulaLike: number;
  /** The distinct values of the `watch` columns (trimmed), for the host's checks only. */
  seen: string[];
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

export interface CsvLimits {
  /** Data rows after the header. */
  maxRows?: number;
  maxColumns?: number;
  maxCell?: number;
}

/** The delimiter a file is read with: the one its first line has most of, of `,`, `;` and tab. */
function delimiterOf(body: string): string {
  const end = body.search(/\r?\n|$/);
  const counts = { ",": 0, ";": 0, "\t": 0 };
  for (let i = 0; i < end; i++) {
    const ch = body[i] as string;
    if (ch in counts) counts[ch as keyof typeof counts] += 1;
  }
  return (Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? ",") as string;
}

const QUOTE = 34;
const CR = 13;
const LF = 10;

/**
 * Rows of a CSV file (RFC 4180: commas, quotes doubled inside quoted fields, CRLF or LF, newlines
 * inside quotes), with a byte-order mark dropped and blank lines skipped. A semicolon or tab file
 * is read when its first line has more of those than commas. The limits are enforced while
 * reading: too many characters, rows or columns, a cell too long, or a NUL character (not a text
 * file). A refusal names a row and a column number, never a value.
 *
 * Fields are sliced from the text, never built a character at a time, so a 10 MB file is held
 * about once more as its cells, not many times over (stage 65 step 4's review, M1). With
 * `headerOnly`, only the first row is read.
 */
export function parseCsv(
  text: string,
  limits: CsvLimits & { headerOnly?: boolean } = {},
): string[][] {
  const maxRows = limits.maxRows ?? MAX_PEOPLE_ROWS;
  const maxColumns = limits.maxColumns ?? MAX_COLUMNS;
  const maxCell = limits.maxCell ?? MAX_CELL;
  if (text.length > MAX_FILE_CHARS) throw refuse("invalid", "The file is over 10 MB.");
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  if (body.indexOf(String.fromCharCode(0)) >= 0) {
    throw refuse("invalid", "The file holds a NUL character: it is not text.");
  }
  const sep = delimiterOf(body).charCodeAt(0);
  const n = body.length;
  const rows: string[][] = [];
  let row: string[] = [];
  const where = () => `Row ${rows.length === 0 ? "1 (the header)" : rows.length}`;
  const tooLong = () =>
    refuse("invalid", `${where()}, column ${row.length + 1} is longer than ${maxCell} characters.`);
  /** The end of an unquoted run: the next delimiter, CR, LF or the end. */
  const runEnd = (from: number) => {
    let j = from;
    while (j < n) {
      const c = body.charCodeAt(j);
      if (c === sep || c === CR || c === LF) break;
      j++;
    }
    return j;
  };
  let i = 0;
  for (;;) {
    let value: string;
    if (body.charCodeAt(i) === QUOTE) {
      // A quoted field: up to the closing quote, a doubled quote one quote.
      let start = i + 1;
      let parts: string[] | null = null;
      let length = 0;
      for (;;) {
        const q = body.indexOf('"', start);
        if (q < 0) throw refuse("invalid", "The file ends inside a quoted field.");
        length += q - start;
        if (length > maxCell) throw tooLong();
        if (body.charCodeAt(q + 1) === QUOTE) {
          length += 1;
          if (!parts) parts = [];
          parts.push(body.slice(start, q + 1));
          start = q + 2;
          continue;
        }
        value = parts ? parts.join("") + body.slice(start, q) : body.slice(start, q);
        i = q + 1;
        break;
      }
      // Anything after the closing quote, up to the delimiter, is the field's too.
      const end = runEnd(i);
      if (end > i) value += body.slice(i, end);
      i = end;
    } else {
      const end = runEnd(i);
      value = body.slice(i, end);
      i = end;
    }
    if (value.length > maxCell) throw tooLong();
    row.push(value);
    if (row.length > maxColumns) {
      throw refuse("invalid", `${where()} has more than ${maxColumns} columns.`);
    }
    const c = i < n ? body.charCodeAt(i) : -1;
    if (c === sep) {
      i++;
      continue;
    }
    // The end of a row (CR, LF, CRLF, or the end of the text).
    if (c === CR) i += body.charCodeAt(i + 1) === LF ? 2 : 1;
    else if (c === LF) i++;
    if (row.some((f) => f.trim() !== "")) {
      rows.push(row);
      if (limits.headerOnly) return rows;
      if (rows.length > maxRows + 1) throw refuse("invalid", `The file is over ${maxRows} rows.`);
    }
    row = [];
    if (i >= n) break;
  }
  return rows;
}

/** The file's first row (its column names), read without the rest. */
export function readHeader(text: string): string[] {
  return parseCsv(text, { headerOnly: true })[0] ?? [];
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

/** Control characters, and the invisible marks that reorder or hide text. */
const HIDDEN = new RegExp(
  `[${(
    [
      [0x00, 0x08],
      [0x0b, 0x0c],
      [0x0e, 0x1f],
      [0x7f, 0x9f],
      [0xad, 0xad],
      [0x034f, 0x034f],
      [0x061c, 0x061c],
      [0x180e, 0x180e],
      [0x200b, 0x200b],
      [0x200e, 0x200f],
      [0x202a, 0x202e],
      [0x2060, 0x2064],
      [0x2066, 0x2069],
      [0xfeff, 0xfeff],
    ] as const
  )
    .map(([a, b]) => `${String.fromCharCode(a)}-${String.fromCharCode(b)}`)
    .join("")}]`,
  "g",
);

/** A text as kept: hidden characters dropped, runs of white space (newlines too) one space, cut. */
function cut(value: string): string {
  return value.replace(HIDDEN, "").replace(/\s+/g, " ").trim().slice(0, MAX_TEXT);
}

/** Starts as a spreadsheet formula would. Kept as text either way; counted for the dry run. */
export function formulaLike(value: string): boolean {
  return /^[=+\-@]/.test(value.trim());
}

/** FNV-1a, 64 bits, in hex: a ref for a value that is not one, the same in every export. */
function fnv(value: string): string {
  let h = 0xcbf29ce484222325n;
  for (let i = 0; i < value.length; i++) {
    h ^= BigInt(value.charCodeAt(i));
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return h.toString(16).padStart(16, "0");
}

const REF_OK = /^[\x21-\x7e]{1,255}$/;

/**
 * A ref the contract takes (printable, no spaces, at most 255 characters) from a file's id: as it
 * is when it already is one, otherwise its printable part and a hash of the whole.
 */
export function fitRef(raw: string): string {
  const s = raw.trim().replace(/\s+/g, "-");
  if (REF_OK.test(s)) return s;
  return `${s.replace(/[^\x21-\x7e]/g, "").slice(0, 200)}~${fnv(s)}`;
}

const ADDRESS = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Without a host's own check: the plain shape of an address, lower-cased. */
function plainAddress(cleaned: string): string | null {
  return ADDRESS.test(cleaned) ? cleaned.toLowerCase() : null;
}

/**
 * An address cell as it is compared (stage 65 step 4's review, S1): its hidden and
 * direction-changing characters dropped, in Unicode's compatibility form (a fullwidth `ａ` is `a`),
 * trimmed, out of the quotes or angle brackets an export may put round it (`"Name" <a@x>` is
 * `a@x`). Then the host's own check (`normalise`, the one its suppressions and erased addresses
 * are keyed by) decides: an address it does not take is no address, and the row is left out,
 * never kept without it.
 */
export function cleanAddress(raw: string): string {
  let s = raw.replace(HIDDEN, "").normalize("NFKC").trim();
  const angled = /<([^<>]*)>\s*$/.exec(s);
  if (angled) s = (angled[1] as string).trim();
  for (;;) {
    const unwrapped = s.replace(/^["'`]+|["'`]+$/g, "").trim();
    if (unwrapped === s) break;
    s = unwrapped;
  }
  return s;
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

const BOOKING_STATE_WORDS: Record<string, BookingSystemBookingState> = {
  booked: "booked",
  reserved: "booked",
  confirmed: "booked",
  enrolled: "booked",
  waiting: "waiting",
  waitlist: "waiting",
  waitlisted: "waiting",
  "wait list": "waiting",
  attended: "attended",
  "checked in": "attended",
  "signed in": "attended",
  present: "attended",
  visited: "attended",
  "late cancel": "late_cancelled",
  "late cancelled": "late_cancelled",
  "late canceled": "late_cancelled",
  "no show": "no_show",
  noshow: "no_show",
  absent: "no_show",
  cancelled: "cancelled",
  canceled: "cancelled",
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

/**
 * The header's index for each mapped column. A mapped column missing from the file is refused, and
 * so is a file with two columns of the same name (which one a field means would be a guess).
 */
function columnsOf(header: string[], columns: Record<string, string | undefined>, file: string) {
  const at = new Map<string, number>();
  header.forEach((h, i) => {
    const k = key(h);
    if (k === "") return;
    if (at.has(k)) throw refuse("invalid", `The ${file} file has two columns named "${cut(h)}".`);
    at.set(k, i);
  });
  const index: Record<string, number> = {};
  for (const [field, name] of Object.entries(columns)) {
    if (name === undefined) continue;
    const i = at.get(key(name));
    if (i === undefined)
      throw refuse("invalid", `The ${file} file has no column "${cut(name)}" (${field}).`);
    index[field] = i;
  }
  return index;
}

/** The indexes of the watched columns this file has. */
function watchedOf(header: string[], watch: readonly string[] | undefined): number[] {
  if (!watch?.length) return [];
  const wanted = new Set(watch.map(key));
  return header.flatMap((h, i) => (wanted.has(key(h)) ? [i] : []));
}

function checkZone(timeZone: string): void {
  try {
    new Intl.DateTimeFormat("en", { timeZone });
  } catch {
    throw refuse("invalid", `${timeZone} is not an IANA time zone.`);
  }
}

function bounded<K, V>(map: Map<K, V>, what: string): void {
  if (map.size > MAX_NAMED) {
    throw refuse(
      "invalid",
      `The file names more than ${MAX_NAMED} ${what}: is the right column mapped?`,
    );
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
  if (!input.people && !input.timetable) throw refuse("invalid", "There is no file to read.");
  const today = (input.now ? new Date(Date.parse(input.now)) : new Date())
    .toISOString()
    .slice(0, 10);
  const issues: FileIssue[] = [];
  const normalise = input.normaliseAddress ?? plainAddress;
  /** A cell's address as the host keys it; `undefined` for an empty cell, null for no address. */
  const addressOf = (raw: string): string | null | undefined => {
    const cleaned = cleanAddress(raw);
    return cleaned === "" ? undefined : normalise(cleaned);
  };
  const people = new Map<string, BookingSystemPerson>();
  const types = new Map<string, BookingSystemMembershipType>();
  const memberships = new Map<string, BookingSystemMembership>();
  const explicitStatus = new Set<string>();
  let formulas = 0;
  const seen = new Set<string>();
  const see = (v: string | undefined) => {
    const t = v?.trim();
    if (t) seen.add(t);
  };
  /** A text cell as kept, counting one that looks like a formula. */
  const text = (raw: string): string => {
    const kept = cut(raw);
    if (kept && formulaLike(kept)) formulas += 1;
    return kept;
  };

  let peopleRows = 0;
  if (input.people) {
    const { mapping } = input.people;
    const format = mapping.dateFormat ?? "YYYY-MM-DD";
    const [header, ...rows] = parseCsv(input.people.text, { maxRows: MAX_PEOPLE_ROWS });
    if (!header) throw refuse("invalid", "The people file is empty.");
    peopleRows = rows.length;
    const col = columnsOf(header, { ...mapping.columns }, "people");
    const watched = watchedOf(header, input.watch);
    rows.forEach((cells, i) => {
      const row = i + 1;
      for (const at of watched) see(cells[at]);
      const cell = (field: keyof PeopleFileMapping["columns"]) => {
        const at = col[field];
        return at === undefined ? "" : (cells[at] ?? "").trim();
      };
      const note = (column: string, problem: string) =>
        issues.push({ file: "people", row, column, problem });
      // An address the host does not take leaves the row out, never kept without it: it may be
      // an erased person's, written so that it no longer matches (stage 65 step 4's review, S1).
      const address = addressOf(cell("email"));
      if (address === null) {
        note(mapping.columns.email, "not an address: the row is left out");
        return;
      }
      const email: string | null = address ?? null;
      const own = cell("ref");
      if (!own && email === null) {
        issues.push({ file: "people", row, problem: "no address and no id: the row is left out" });
        return;
      }
      const ref = own ? fitRef(own) : fitRef(`email:${email as string}`);
      let person = people.get(ref);
      if (!person) {
        let active = true;
        if (cell("active")) {
          const f = flag(cell("active"));
          if (f === null)
            note(
              mapping.columns.active as string,
              `"${cut(cell("active")).slice(0, 40)}" is not yes or no`,
            );
          else active = f;
        }
        let memberStatus: BookingSystemMemberStatus = "not_member";
        if (cell("memberStatus")) {
          const w = word(cell("memberStatus"), mapping.values?.memberStatus, MEMBER_STATUS_WORDS);
          if (w === null)
            note(
              mapping.columns.memberStatus as string,
              `"${cut(cell("memberStatus")).slice(0, 40)}" is not a member status this file maps`,
            );
          else {
            memberStatus = w;
            explicitStatus.add(ref);
          }
        }
        person = {
          ref,
          email,
          givenName: text(cell("givenName")) || null,
          familyName: text(cell("familyName")) || null,
          memberStatus,
          active,
          modifiedAt: null,
        };
        people.set(ref, person);
      } else if (email !== null && person.email !== null && email !== person.email) {
        note(
          mapping.columns.email,
          "another address than an earlier row with the same id; the first is kept",
        );
      }

      const typeName = text(cell("membershipType"));
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
            `"${cut(cell("membershipKind")).slice(0, 40)}" is not a membership or a pass`,
          );
        else kind = w;
      }
      // The business's own word for what a type is ("Gold Monthly" is a membership) wins.
      const typeKind = word(typeName, mapping.values?.membershipType, {});
      if (typeKind !== null) kind = typeKind;
      const date = (field: "from" | "until") => {
        if (!cell(field)) return null;
        const d = day(cell(field), format);
        if (d === null)
          note(
            mapping.columns[field] as string,
            `"${cut(cell(field)).slice(0, 40)}" is not a date (${format})`,
          );
        return d;
      };
      const from = date("from");
      const until = date("until");
      let status: BookingSystemMembershipStatus =
        until !== null && until < today ? "ended" : "live";
      if (cell("membershipStatus")) {
        const w = word(
          cell("membershipStatus"),
          mapping.values?.membershipStatus,
          MEMBERSHIP_STATUS_WORDS,
        );
        if (w === null)
          note(
            mapping.columns.membershipStatus as string,
            `"${cut(cell("membershipStatus")).slice(0, 40)}" is not a membership status this file maps`,
          );
        else status = w;
      }
      const typeRef = fitRef(`type:${kind}:${slug(typeName)}`);
      if (!types.has(typeRef)) {
        types.set(typeRef, { ref: typeRef, name: typeName, kind, active: true });
        bounded(types, "membership types");
      }
      const membershipRef = fitRef(`${ref}|${typeRef}|${from ?? ""}`);
      if (memberships.has(membershipRef)) {
        issues.push({
          file: "people",
          row,
          problem: `the same ${kind} for the same person twice; the first is kept`,
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
        usesLeft:
          usesLeft !== null && usesTotal !== null ? Math.min(usesLeft, usesTotal) : usesLeft,
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
  }

  const classes = new Map<string, BookingSystemClass>();
  const classTypes = new Map<string, BookingSystemClassType>();
  const staff = new Map<string, BookingSystemStaff>();
  const locations = new Map<string, BookingSystemLocation>();
  const bookings = new Map<string, BookingSystemBooking>();
  const bookingAddresses: Record<string, string> = {};
  let timetableRows = 0;
  if (input.timetable) {
    const t = input.timetable.mapping;
    const tFormat = t.dateFormat ?? "YYYY-MM-DD";
    const [tHeader, ...tRows] = parseCsv(input.timetable.text, { maxRows: MAX_TIMETABLE_ROWS });
    if (!tHeader) throw refuse("invalid", "The timetable file is empty.");
    timetableRows = tRows.length;
    const tCol = columnsOf(tHeader, { ...t.columns }, "timetable");
    const tWatched = watchedOf(tHeader, input.watch);
    // A file with a booking column is one row per booking: a class's rows repeat it.
    const perBooking = tCol.person !== undefined || tCol.personEmail !== undefined;
    tRows.forEach((cells, i) => {
      const row = i + 1;
      for (const at of tWatched) see(cells[at]);
      const cell = (field: keyof TimetableFileMapping["columns"]) => {
        const at = tCol[field];
        return at === undefined ? "" : (cells[at] ?? "").trim();
      };
      const note = (column: string, problem: string) =>
        issues.push({ file: "timetable", row, column, problem });
      // Every address the row carries, checked before anything of it is read: one the host does
      // not take leaves the row out (stage 65 step 4's review, S1 and S2).
      const staffAddress = addressOf(cell("staffEmail"));
      if (staffAddress === null) {
        note(t.columns.staffEmail as string, "not an address: the row is left out");
        return;
      }
      const personAddress = perBooking ? addressOf(cell("personEmail")) : undefined;
      if (personAddress === null) {
        note(t.columns.personEmail as string, "not an address: the row is left out");
        return;
      }
      const title = text(cell("title"));
      const startsAt = instant(cell("startsAt"), tFormat, input.site.timeZone);
      if (!title || startsAt === null) {
        issues.push({
          file: "timetable",
          row,
          problem: !title
            ? "no title: the row is left out"
            : `"${cut(cell("startsAt")).slice(0, 40)}" is not a time: the row is left out`,
        });
        return;
      }
      const ref = cell("ref") ? fitRef(cell("ref")) : fitRef(`class:${startsAt}:${slug(title)}`);
      let klass = classes.get(ref);
      if (klass && !perBooking) {
        issues.push({ file: "timetable", row, problem: `${ref} twice; the first is kept` });
        return;
      }
      if (!klass) {
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
          if (endsAt === null)
            note(t.columns.endsAt as string, `"${cut(cell("endsAt")).slice(0, 40)}" is not a time`);
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
        const typeName = text(cell("classType")) || title;
        const classType = fitRef(`class-type:${slug(typeName)}`);
        if (!classTypes.has(classType)) {
          classTypes.set(classType, {
            ref: classType,
            name: typeName,
            description: null,
            active: true,
          });
          bounded(classTypes, "class types");
        }
        let location: string | null = null;
        if (cell("location")) {
          location = fitRef(`location:${slug(cell("location"))}`);
          if (!locations.has(location)) {
            locations.set(location, { ref: location, name: text(cell("location")) });
            bounded(locations, "locations");
          }
        }
        let staffRef: string | null = null;
        if (cell("staff")) {
          staffRef = fitRef(`staff:${slug(cell("staff"))}`);
          const address = staffAddress ?? null;
          const known = staff.get(staffRef);
          if (!known) {
            staff.set(staffRef, {
              ref: staffRef,
              displayName: text(cell("staff")),
              email: address,
              active: true,
            });
            bounded(staff, "coaches");
          } else if (known.email === null && address !== null) {
            known.email = address;
          }
        }
        const count = (field: "places" | "booked" | "waiting") => {
          if (!cell(field)) return null;
          const n = whole(cell(field));
          if (n === null) note(t.columns[field] as string, "not a whole number");
          return n;
        };
        klass = {
          ref,
          classType,
          title,
          startsAt,
          endsAt,
          location,
          staff: staffRef,
          places: count("places"),
          booked: count("booked") ?? -1,
          waiting: count("waiting") ?? -1,
          cancelled: cell("cancelled") ? flag(cell("cancelled")) === true : false,
          modifiedAt: null,
        };
        classes.set(ref, klass);
        if (classes.size > MAX_FILE_CLASSES) {
          throw refuse(
            "invalid",
            `The timetable file holds more than ${MAX_FILE_CLASSES} classes.`,
          );
        }
      }
      if (!perBooking) return;
      const own = cell("person");
      const address = personAddress ?? null;
      if (!own && address === null) return; // A class with no booking.
      const person = own ? fitRef(own) : fitRef(`email:${address as string}`);
      let state: BookingSystemBookingState = "booked";
      if (cell("bookingState")) {
        const w = word(cell("bookingState"), t.values?.bookingState, BOOKING_STATE_WORDS);
        if (w === null) {
          note(
            t.columns.bookingState as string,
            `"${cut(cell("bookingState")).slice(0, 40)}" is not a booking state this file maps; the booking is left out`,
          );
          return;
        }
        state = w;
      }
      const bookingRef = cell("bookingRef")
        ? fitRef(cell("bookingRef"))
        : fitRef(`${ref}|${person}`);
      if (bookings.has(bookingRef)) {
        issues.push({
          file: "timetable",
          row,
          problem: "the same booking twice; the first is kept",
        });
        return;
      }
      if (own && address !== null) bookingAddresses[bookingRef] = address;
      bookings.set(bookingRef, {
        ref: bookingRef,
        class: ref,
        person,
        state,
        modifiedAt: null,
      });
    });
    // With no count columns, a class's counts are its bookings'.
    for (const c of classes.values()) {
      if (c.booked < 0 || c.waiting < 0) {
        const of = [...bookings.values()].filter((b) => b.class === c.ref);
        if (c.booked < 0)
          c.booked = of.filter((b) => b.state === "booked" || b.state === "attended").length;
        if (c.waiting < 0) c.waiting = of.filter((b) => b.state === "waiting").length;
      }
    }
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
    classes: [...classes.values()],
    bookings: [...bookings.values()],
    bookingAddresses,
    staff: [...staff.values()],
    issues,
    rows: { people: peopleRows, timetable: timetableRows },
    formulaLike: formulas,
    seen: [...seen],
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
 * The contract over loaded files (the file session). Nothing changes between loads, so there is no
 * `modifiedSince` (refused), no hint, no visit, and no call to count. Bookings are the timetable
 * file's own, when it names who is booked.
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

  /** Who is booked, as the timetable file says (none when it gives only counts). */
  async listBookings(classes: string[]): Promise<BookingSystemBooking[]> {
    const asked = new Set(classes);
    return structuredClone(this.#load.bookings.filter((b) => asked.has(b.class)));
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
