// The file source in the host (stage 65 step 4, ADR 0923): a list a business exported from its
// booking system, uploaded by a member of staff, read through the contract's file session and
// planned by the one ingest (`outside/ingest.ts`) that every source goes through. There is no
// other way for a row to enter the copy: the file is decoded and parsed here, read by the
// contract package's `loadFiles` and `FileBookingSystem` (the file session), read back through
// `directSession` by `readMembers` or `readTimetable`, and planned by `planMembers` or
// `planTimetable`, whose matching is `decideMatches` with step 10's rules (a suppressed ref or
// address keeps nothing, `keptByLink`, the salt's fingerprint checked by `droppedOf`).
//
// The file is hostile input. Its bytes are decoded by their content, never by a name or a declared
// type (there is none: the operation takes the bytes only): UTF-8 (with or without a byte-order
// mark), UTF-16 (either order, with a mark or by its NUL pattern) and, for what is not valid UTF-8,
// Windows-1252 (the Latin-1 of old systems' exports). A workbook, an old Excel file, a PDF, a zip,
// a web page, XML or JSON is refused with what to do instead; so is anything with a NUL or many
// control characters. Size is checked before decoding, rows, columns and cells while parsing.
//
// Where the file lives: nowhere but the request. The bytes arrive in the call's input, are held in
// the Worker's memory while the call runs, and are dropped when it returns; nothing of the file is
// written to D1, R2, KV, a log or the audit (the input's `file` is redacted). Between the dry run
// and the load the server holds nothing: the person's browser keeps the file and sends it again
// with the load (ADR 0020's stateless rule), and the load plans again and refuses unless its plan
// is the one the dry run showed (the fingerprint). So an erase between the two cannot be defeated
// by a kept upload: there is none, and the erase changes the plan, so the stale load is refused.
// Nor is the file kept by an approval: both operations are `neverQueued`, refused where a preset
// or the deploy floor would make them wait (a pending action would keep the input whole). And an
// erase landing between a load's plan and its write fails the write (`guardStatement`).
import type { CoreDatabase } from "@composable-os/db";
import {
  type BookingSystemBookingState,
  type BookingSystemMemberStatus,
  type BookingSystemMembershipKind,
  type BookingSystemMembershipStatus,
  directSession,
  FileBookingSystem,
  type FileDateFormat,
  type FileIssue,
  type FileLoad,
  loadFiles,
  MAX_FILE_CHARS,
  MAX_ISSUES_SHOWN,
  type PeopleFileMapping,
  readHeader,
  refusalCode,
  type TimetableFileMapping,
} from "@composable-os/gatekeeper-booking-system";
import { CompiledQuery, type Kysely } from "kysely";
import { saltedHash } from "../contact/suppression.ts";
import { normaliseCustomerEmail } from "../customers/accounts.ts";
import { sha256Hex } from "../digest.ts";
import { ValidationError } from "../errors.ts";
import { loadGeneralSettings } from "../settings.ts";
import {
  type IngestPlan,
  MAX_TIMETABLE_DAYS,
  planMembers,
  planTimetable,
  readMembers,
  readTimetable,
} from "./ingest.ts";
import { businessToday, currentLists, type ListKind } from "./settings.ts";

type Db = Kysely<CoreDatabase>;

/** The largest file, in bytes (CSV_LIMITS.maxBytes, ADR 0020). */
export const MAX_FILE_BYTES = MAX_FILE_CHARS;
/** The base64 text of the largest file. */
export const MAX_FILE_BASE64 = Math.ceil(MAX_FILE_BYTES / 3) * 4;
/** A value map holds at most this many words, each at most this long. */
export const MAX_VALUE_WORDS = 50;
export const MAX_VALUE_WORD = 100;
/** The dry run names at most this many people (or coaches) who would link, and who would wait. */
export const MAX_NAMED_SHOWN = 50;

export type FileEncoding = "utf-8" | "utf-16le" | "utf-16be" | "windows-1252";

function refused(message: string, rule = "outside_file"): ValidationError {
  return new ValidationError(message, { field: "file", rule });
}

// --- Decoding by content. --------------------------------------------------------------------------

/** Windows-1252's characters for 0x80 to 0x9F (the rest of the byte range is Latin-1's). */
const CP1252 = [
  0x20ac, 0x81, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039,
  0x0152, 0x8d, 0x017d, 0x8f, 0x90, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x02dc,
  0x2122, 0x0161, 0x203a, 0x0153, 0x9d, 0x017e, 0x0178,
];

function decodeCp1252(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 8192) {
    const part = bytes.subarray(i, i + 8192);
    out += String.fromCharCode(
      ...Array.from(part, (b) => (b >= 0x80 && b <= 0x9f ? (CP1252[b - 0x80] as number) : b)),
    );
  }
  return out;
}

function decodeUtf16(bytes: Uint8Array, littleEndian: boolean): string {
  if (bytes.length % 2)
    throw refused("The file is UTF-16 with an odd number of bytes: it is cut short.");
  let out = "";
  const units: number[] = [];
  for (let i = 0; i < bytes.length; i += 2) {
    const a = bytes[i] as number;
    const b = bytes[i + 1] as number;
    units.push(littleEndian ? a | (b << 8) : (a << 8) | b);
    if (units.length === 8192) {
      out += String.fromCharCode(...units);
      units.length = 0;
    }
  }
  return out + String.fromCharCode(...units);
}

/** UTF-16 without a mark: most of the first bytes' high halves are NUL (Latin text). */
function utf16Without(bytes: Uint8Array): "utf-16le" | "utf-16be" | null {
  const n = Math.min(bytes.length - (bytes.length % 2), 2000);
  if (n < 4) return null;
  let even = 0;
  let odd = 0;
  for (let i = 0; i < n; i += 2) {
    if (bytes[i] === 0) even += 1;
    if (bytes[i + 1] === 0) odd += 1;
  }
  const pairs = n / 2;
  if (odd > pairs * 0.4 && even < pairs * 0.05) return "utf-16le";
  if (even > pairs * 0.4 && odd < pairs * 0.05) return "utf-16be";
  return null;
}

function startsWith(bytes: Uint8Array, ...sig: number[]): boolean {
  return sig.every((b, i) => bytes[i] === b);
}

/**
 * The file's text, by its content: refuses what is not a delimited text export (CSV, semicolon or
 * tab separated), saying what it looks like and what to do instead.
 */
export function decodeFile(bytes: Uint8Array): { text: string; encoding: FileEncoding } {
  if (bytes.length === 0) throw refused("The file is empty.");
  if (bytes.length > MAX_FILE_BYTES) throw refused("The file is over 10 MB.");
  const save = "Export the list as CSV (comma, semicolon or tab separated) and load that.";
  if (startsWith(bytes, 0x50, 0x4b, 0x03, 0x04) || startsWith(bytes, 0x50, 0x4b, 0x05, 0x06)) {
    throw refused(
      `The file is a workbook or a zip (.xlsx, .numbers, .zip), not a CSV. ${save}`,
      "outside_file_format",
    );
  }
  if (startsWith(bytes, 0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1)) {
    throw refused(
      `The file is an old Excel workbook (.xls), not a CSV. ${save}`,
      "outside_file_format",
    );
  }
  if (startsWith(bytes, 0x25, 0x50, 0x44, 0x46)) {
    throw refused(`The file is a PDF, not a CSV. ${save}`, "outside_file_format");
  }
  if (startsWith(bytes, 0x1f, 0x8b)) {
    throw refused(`The file is compressed (gzip), not a CSV. ${save}`, "outside_file_format");
  }
  let text: string;
  let encoding: FileEncoding;
  if (startsWith(bytes, 0xef, 0xbb, 0xbf)) {
    encoding = "utf-8";
    try {
      text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes.subarray(3));
    } catch {
      throw refused(
        "The file says it is UTF-8 but is not: export it again as CSV (UTF-8).",
        "outside_file_encoding",
      );
    }
  } else if (startsWith(bytes, 0xff, 0xfe)) {
    encoding = "utf-16le";
    text = decodeUtf16(bytes.subarray(2), true);
  } else if (startsWith(bytes, 0xfe, 0xff)) {
    encoding = "utf-16be";
    text = decodeUtf16(bytes.subarray(2), false);
  } else {
    const sixteen = utf16Without(bytes);
    if (sixteen) {
      encoding = sixteen;
      text = decodeUtf16(bytes, sixteen === "utf-16le");
    } else {
      try {
        text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
        encoding = "utf-8";
      } catch {
        text = decodeCp1252(bytes);
        encoding = "windows-1252";
      }
    }
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  // Some old exports end with a DOS end-of-file mark.
  while (text.endsWith(String.fromCharCode(0x1a))) text = text.slice(0, -1);
  if (text.includes("\u0000")) {
    throw refused(
      `The file holds NUL characters: it is not a text export. ${save}`,
      "outside_file_format",
    );
  }
  let controls = 0;
  for (let i = 0; i < Math.min(text.length, 100_000); i++) {
    const c = text.charCodeAt(i);
    if (c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) controls += 1;
  }
  if (controls > Math.max(10, Math.min(text.length, 100_000) / 100)) {
    throw refused(
      `The file is not a text export (it holds control characters). ${save}`,
      "outside_file_format",
    );
  }
  const start = text.trimStart().slice(0, 64).toLowerCase();
  if (start.startsWith("<")) {
    throw refused(
      `The file is a web page or XML (some systems save one as .xls), not a CSV. ${save}`,
      "outside_file_format",
    );
  }
  if (start.startsWith("{") || start.startsWith("[")) {
    throw refused(`The file is JSON, not a CSV. ${save}`, "outside_file_format");
  }
  return { text, encoding };
}

/** The bytes of a base64 text, refusing one that is not base64 or is too big. */
export function fileBytes(base64: string): Uint8Array {
  if (base64.length > MAX_FILE_BASE64 + 4) throw refused("The file is over 10 MB.");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) throw refused("The file is not base64 text.");
  let binary: string;
  try {
    binary = atob(base64);
  } catch {
    throw refused("The file is not base64 text.");
  }
  // A plain loop: `Uint8Array.from(binary, fn)` holds a value per character and runs a 10 MB file
  // past a Worker's 128 MB (measured, the review M1).
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// --- Fields, suggestions and saved mappings. -------------------------------------------------------

interface Field {
  label: string;
  required?: boolean;
  /** Header spellings, as letters and digits in lower case. */
  synonyms: string[];
  /** Holds a person's name, address or id: a value map may never use one of its values. */
  personal?: boolean;
}

export const FILE_FIELDS = {
  members: {
    email: {
      label: "Email",
      required: true,
      personal: true,
      synonyms: ["email", "emailaddress", "mail", "clientemail", "memberemail", "customeremail"],
    },
    ref: {
      label: "The booking system's id",
      personal: true,
      synonyms: [
        "id",
        "clientid",
        "memberid",
        "customerid",
        "personid",
        "ref",
        "clientnumber",
        "membernumber",
        "customernumber",
      ],
    },
    givenName: {
      label: "First name",
      personal: true,
      synonyms: ["firstname", "givenname", "first", "forename"],
    },
    familyName: {
      label: "Last name",
      personal: true,
      synonyms: ["lastname", "surname", "familyname", "last"],
    },
    memberStatus: {
      label: "Member status",
      synonyms: ["status", "memberstatus", "clientstatus", "customerstatus"],
    },
    active: { label: "Active", synonyms: ["active", "isactive"] },
    membershipType: {
      label: "Membership or pass",
      synonyms: [
        "membership",
        "plan",
        "product",
        "membershiptype",
        "pricingoption",
        "contract",
        "membershipname",
        "planname",
        "pass",
      ],
    },
    membershipKind: {
      label: "Kind (membership or pass)",
      synonyms: ["type", "kind", "membershipkind", "producttype"],
    },
    membershipStatus: {
      label: "Membership status",
      synonyms: ["membershipstatus", "planstatus", "contractstatus", "passstatus"],
    },
    from: {
      label: "Starts",
      synonyms: ["start", "startdate", "from", "activationdate", "begins", "starts"],
    },
    until: {
      label: "Ends",
      synonyms: [
        "end",
        "enddate",
        "until",
        "expiry",
        "expirydate",
        "expires",
        "expirationdate",
        "ends",
      ],
    },
    usesTotal: {
      label: "Uses in total",
      synonyms: ["visits", "sessions", "total", "usestotal", "totalvisits", "totalsessions"],
    },
    usesLeft: {
      label: "Uses left",
      synonyms: [
        "remaining",
        "left",
        "usesleft",
        "visitsremaining",
        "sessionsleft",
        "remainingvisits",
      ],
    },
    renews: { label: "Renews", synonyms: ["autorenew", "renews", "autopay", "recurring"] },
  },
  timetable: {
    title: {
      label: "Class",
      required: true,
      synonyms: ["class", "classname", "title", "session", "sessionname"],
    },
    startsAt: {
      label: "Starts",
      required: true,
      synonyms: ["start", "starts", "startsat", "datetime", "starttime", "startdatetime"],
    },
    endsAt: { label: "Ends", synonyms: ["end", "ends", "endsat", "endtime", "enddatetime"] },
    durationMinutes: {
      label: "Length in minutes",
      synonyms: ["duration", "length", "minutes", "durationminutes"],
    },
    ref: { label: "The class's id", synonyms: ["classid", "sessionid", "classref"] },
    classType: { label: "Class type", synonyms: ["classtype", "category", "program", "programme"] },
    location: { label: "Location", synonyms: ["location", "room", "studio", "venue"] },
    staff: {
      label: "Coach",
      personal: true,
      synonyms: ["coach", "instructor", "teacher", "trainer", "staff"],
    },
    staffEmail: {
      label: "Coach's email",
      personal: true,
      synonyms: ["coachemail", "instructoremail", "staffemail", "teacheremail", "traineremail"],
    },
    places: { label: "Places", synonyms: ["capacity", "places", "spots", "maxcapacity"] },
    booked: { label: "Booked", synonyms: ["booked", "bookings", "signedup"] },
    waiting: { label: "Waiting", synonyms: ["waiting", "waitlist", "waitlisted"] },
    cancelled: { label: "Cancelled", synonyms: ["cancelled", "canceled"] },
    person: {
      label: "Who is booked: their id",
      personal: true,
      synonyms: ["clientid", "memberid", "personid", "customerid"],
    },
    personEmail: {
      label: "Who is booked: their email",
      personal: true,
      synonyms: ["email", "clientemail", "memberemail", "emailaddress", "customeremail"],
    },
    bookingRef: {
      label: "The booking's id",
      synonyms: ["bookingid", "reservationid", "visitid", "bookingref"],
    },
    bookingState: {
      label: "Booking state",
      synonyms: ["bookingstatus", "status", "state", "attendance", "visitstatus", "bookingstate"],
    },
  },
} as const satisfies Record<ListKind, Record<string, Field>>;

/** The value maps each kind takes, and the contract's words each maps onto. */
export const VALUE_MAPS = {
  members: {
    memberStatus: ["member", "not_member", "suspended", "expired", "ended", "declined"],
    membershipStatus: ["live", "paused", "ended", "cancelled"],
    membershipKind: ["membership", "pass"],
    membershipType: ["membership", "pass"],
  },
  timetable: {
    bookingState: ["booked", "waiting", "attended", "late_cancelled", "no_show", "cancelled"],
  },
} as const;

export const DATE_FORMATS = ["YYYY-MM-DD", "DD/MM/YYYY", "MM/DD/YYYY"] as const;

/** Which column holds each field, by header; the export's own words; how its dates are written. */
export interface FileMapping {
  columns: Record<string, string>;
  values?: Record<string, Record<string, string>>;
  dateFormat?: FileDateFormat;
}

const norm = (header: string) => header.toLowerCase().replace(/[^a-z0-9]/g, "");
const wordKey = (value: string) =>
  value
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, " ");

/** A field for each header that names one (each header and each field used once). */
export function suggestMapping(kind: ListKind, headers: readonly string[]): FileMapping {
  const fields: Record<string, Field> = FILE_FIELDS[kind];
  const used = new Set<string>();
  const columns: Record<string, string> = {};
  for (const [field, f] of Object.entries(fields)) {
    const header = headers.find((h) => !used.has(h) && f.synonyms.includes(norm(h)));
    if (header !== undefined) {
      columns[field] = header;
      used.add(header);
    }
  }
  return { columns };
}

const ADDRESS_LIKE = /\S@\S/;
/** Six digits or more: a phone number, a card or an id, never an export's own word for a value. */
const DIGITS_LIKE = /(\d[\s().+-]*){6,}/;

/**
 * Refuses a mapping that does not fit the kind or the file, and one that could hold a person's
 * data: a header or a value-map word that is an address or a long number, or a value-map word that
 * is a value of this file's name, address or id columns. A mapping is saved (in the settings and on
 * the list's log), so it must hold the export's own words only, never a person.
 */
export function checkMapping(
  kind: ListKind,
  mapping: FileMapping,
  headers: readonly string[],
  personalValues: ReadonlySet<string> = new Set(),
): void {
  const fields: Record<string, Field> = FILE_FIELDS[kind];
  for (const [field, header] of Object.entries(mapping.columns)) {
    if (!(field in fields))
      throw new ValidationError(`A ${kind} list has no field "${field}".`, { field: "mapping" });
    if (!headers.includes(header)) {
      throw new ValidationError(`The mapping names a column the file does not have (${field}).`, {
        field: "mapping",
        rule: "outside_mapping",
      });
    }
  }
  checkHeaders(headers, personalValues);
  const maps: Record<string, readonly string[]> = VALUE_MAPS[kind];
  for (const [name, map] of Object.entries(mapping.values ?? {})) {
    const allowed = maps[name];
    if (!allowed)
      throw new ValidationError(`A ${kind} list has no value map "${name}".`, { field: "mapping" });
    const words = Object.entries(map);
    if (words.length > MAX_VALUE_WORDS) {
      throw new ValidationError(`A value map holds at most ${MAX_VALUE_WORDS} words.`, {
        field: "mapping",
      });
    }
    words.forEach(([word, to], i) => {
      if (!allowed.includes(to)) {
        throw new ValidationError(
          `Value map ${name}, word ${i + 1}: "${to}" is not one of ${allowed.join(", ")}.`,
          { field: "mapping" },
        );
      }
      if (!word.trim() || word.length > MAX_VALUE_WORD) {
        throw new ValidationError(
          `Value map ${name}, word ${i + 1} is empty or over ${MAX_VALUE_WORD} characters.`,
          { field: "mapping" },
        );
      }
      // Never echoed: it may be a person's.
      if (ADDRESS_LIKE.test(word) || DIGITS_LIKE.test(word) || personalValues.has(wordKey(word))) {
        throw new ValidationError(
          `Value map ${name}, word ${i + 1} is a person's name, address or id in this file, or looks like one: a value map holds the export's own words for a status, a kind or a plan only.`,
          { field: "mapping", rule: "outside_value_map_personal" },
        );
      }
    });
  }
}

/** A date, a time or a number: what a data row holds and a column name never is. */
const VALUE_LIKE = [
  /^\s*[\d\s.,:+-]+\s*$/,
  /\d{1,4}[-/.]\d{1,2}[-/.]\d{1,4}/,
  /\b\d{1,2}:\d{2}\b/,
  /\b\d{1,2}(st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{2,4}\b/i,
  /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2}(st|nd|rd|th)?,?\s+\d{2,4}\b/i,
];

/**
 * The first row must be the column names (the review, M3): a mapping saves them, so a file whose
 * first row is a person's (an address, a long number, a date or time, or a name, address or id
 * that the file's own rows hold) is refused, saying why and echoing nothing.
 */
function checkHeaders(headers: readonly string[], personalValues: ReadonlySet<string>): void {
  for (const header of headers) {
    if (!header.trim()) continue;
    if (
      ADDRESS_LIKE.test(header) ||
      DIGITS_LIKE.test(header) ||
      VALUE_LIKE.some((re) => re.test(header)) ||
      personalValues.has(wordKey(header))
    ) {
      throw new ValidationError(
        "The first row must be the column names, and it holds what looks like a row of data (an address, a number, a date, or a name the file's rows hold): is the header row missing? Export the list with its column names.",
        { field: "file", rule: "outside_no_header" },
      );
    }
  }
}

/** The free-text fields a mapping copies into the copy's own text (a plan's or a class's name). */
const FREE_TEXT: Record<ListKind, readonly string[]> = {
  members: ["membershipType"],
  timetable: ["title", "classType", "location"],
};

/** A value with its dates and times taken out, for the long-number check (a class on 2026-12-01). */
const withoutDates = (value: string) =>
  value.replace(/\d{1,4}[-/.]\d{1,2}[-/.]\d{1,4}/g, " ").replace(/\d{1,2}:\d{2}/g, " ");

/**
 * Refuses a mapping that copies a person's data into the copy's own text (the review, M4): a
 * column mapped to a plan's name, a class's title, its type or its location whose values hold an
 * address or a phone-like number, or several of which are people's names, addresses or ids in
 * the file. Class titles are public (`outside.timetable`). Nothing is echoed.
 */
export function checkFreeText(
  kind: ListKind,
  mapping: FileMapping,
  load: FileLoad,
  personalValues: ReadonlySet<string>,
): void {
  const values: Record<string, string[]> =
    kind === "members"
      ? { membershipType: load.membershipTypes.map((t) => t.name) }
      : {
          title: load.classes.map((c) => c.title),
          classType: mapping.columns.classType ? load.classTypes.map((t) => t.name) : [],
          location: load.site.locations.map((l) => l.name),
        };
  for (const field of FREE_TEXT[kind]) {
    if (mapping.columns[field] === undefined) continue;
    const distinct = [...new Set(values[field] ?? [])];
    const personal = distinct.filter((v) => personalValues.has(wordKey(v))).length;
    if (
      distinct.some((v) => ADDRESS_LIKE.test(v) || DIGITS_LIKE.test(withoutDates(v))) ||
      personal >= Math.max(2, Math.ceil(distinct.length / 10))
    ) {
      throw new ValidationError(
        `The column mapped to ${field} holds what look like people's names, addresses or phone numbers: map it to the column that holds the ${field === "membershipType" ? "plan" : "class"}'s own name.`,
        { field: "mapping", rule: "outside_mapping_personal", target: field },
      );
    }
  }
}

/** The headers the suggestion takes for a person's name, address or id. */
function personalHeaders(kind: ListKind, suggested: FileMapping): string[] {
  const fields: Record<string, Field> = FILE_FIELDS[kind];
  return Object.entries(suggested.columns).flatMap(([field, header]) =>
    fields[field]?.personal ? [header] : [],
  );
}

/** The values of a loaded file's name, address and id columns, as value-map words compare. */
function personalValuesOf(load: FileLoad): Set<string> {
  const out = new Set<string>();
  const add = (v: string | null | undefined) => {
    if (v) out.add(wordKey(v));
  };
  for (const p of load.people) {
    add(p.givenName);
    add(p.familyName);
    add([p.givenName, p.familyName].filter(Boolean).join(" "));
    add(p.email);
    add(p.ref);
  }
  for (const s of load.staff) {
    add(s.displayName);
    add(s.email);
  }
  for (const b of load.bookings) add(b.person);
  for (const v of load.seen) add(v);
  return out;
}

/** A saved mapping, with the headers of the file it was saved from. */
export interface SavedMapping extends FileMapping {
  /** A keyed hash of the column names of the file it was saved from (`shapeOf`). */
  shape?: string;
}

/** The saved mapping of each kind, as `core_outside_settings.mappings` holds them. */
export async function savedMappings(db: Db): Promise<Partial<Record<ListKind, SavedMapping>>> {
  const row = await db
    .selectFrom("core_outside_settings")
    .select("mappings")
    .where("id", "=", 1)
    .executeTakeFirst();
  try {
    const parsed = JSON.parse(row?.mappings ?? "{}") as unknown;
    return parsed && typeof parsed === "object"
      ? (parsed as Partial<Record<ListKind, SavedMapping>>)
      : {};
  } catch {
    return {};
  }
}

// --- Planning a file. ------------------------------------------------------------------------------

export interface FileInput {
  kind: ListKind;
  /** The file's bytes. */
  bytes: Uint8Array;
  mapping?: FileMapping;
  /** The date the file was exported; by default the business's today (the upload). */
  exportedOn?: string;
}

/** What one kind of row would do against the current list. */
export interface Changes {
  new: number;
  changed: number;
  unchanged: number;
  /** In the current list and not in this file: they go. */
  removed: number;
}

export interface FilePreview {
  kind: ListKind;
  ready: boolean;
  /** Required fields no column is mapped to (the dry run stops there). */
  missing: string[];
  headers: string[];
  mapping: FileMapping;
  mappingFrom: "given" | "saved" | "suggested";
  suggested: FileMapping;
  encoding: FileEncoding;
  exportedOn: string;
  rows: { read: number; refused: number };
  issueCount: number;
  issues: FileIssue[];
  /** Cells kept as text that start as a spreadsheet formula would. */
  formulaLike: number;
  outcome: {
    /** People (members) or classes (timetable), against the current list. */
    changes: Changes;
    kept: number;
    /** In the file, and not kept: not a member, no live pass, not booked, not staff-linked. */
    notKept: number;
    /** Of an erased person: nothing of them is kept. */
    dropped: number;
    /** Of those, dropped by a ref an erase suppressed. */
    previouslyErased: number;
    linked: number;
    links: number;
    toMatch: number;
    unlinked: number;
    items: Record<string, number>;
  };
  /** Who would link now (with the Person or staff account), and who would wait in To match. */
  linking: { ref: string; name: string; to: string }[];
  waiting: { ref: string; name: string; why: string }[];
  /** The writes the load would make (at most 900, ADR 0500). */
  statements: number;
  /** Pass it to the load: it loads only while the file and the copy are as they are now. */
  fingerprint: string;
}

export interface FilePlan {
  preview: FilePreview;
  plan: IngestPlan | null;
}

function fieldsOf<T extends ListKind>(kind: T, mapping: FileMapping) {
  const columns = Object.fromEntries(
    Object.entries(mapping.columns).filter(([field]) => field in FILE_FIELDS[kind]),
  );
  return columns;
}

function asLoadInput(kind: ListKind, text: string, mapping: FileMapping) {
  const values = mapping.values ?? {};
  if (kind === "members") {
    const m: PeopleFileMapping = {
      columns: fieldsOf(kind, mapping) as PeopleFileMapping["columns"],
      values: {
        memberStatus: values.memberStatus as Record<string, BookingSystemMemberStatus> | undefined,
        membershipStatus: values.membershipStatus as
          | Record<string, BookingSystemMembershipStatus>
          | undefined,
        membershipKind: values.membershipKind as
          | Record<string, BookingSystemMembershipKind>
          | undefined,
        membershipType: values.membershipType as
          | Record<string, BookingSystemMembershipKind>
          | undefined,
      },
      ...(mapping.dateFormat ? { dateFormat: mapping.dateFormat } : {}),
    };
    return { people: { text, mapping: m } };
  }
  const t: TimetableFileMapping = {
    columns: fieldsOf(kind, mapping) as TimetableFileMapping["columns"],
    values: {
      bookingState: values.bookingState as Record<string, BookingSystemBookingState> | undefined,
    },
    ...(mapping.dateFormat ? { dateFormat: mapping.dateFormat } : {}),
  };
  return { timetable: { text, mapping: t } };
}

/** A contract refusal from the file session as the operation's own error. */
function asValidation(error: unknown): never {
  if (refusalCode(error) === "invalid") {
    throw refused((error as Error).message.replace(/^.*?\[booking-system:invalid\] /, ""));
  }
  throw error;
}

/** Rows a file left out whole (not a value it read without). */
function leftOut(issues: readonly FileIssue[]): number {
  return new Set(
    issues
      .filter((i) => /left out|twice; the first is kept/.test(i.problem))
      .map((i) => `${i.file}:${i.row}`),
  ).size;
}

const sig = (row: Record<string, unknown>, keys: readonly string[]) =>
  JSON.stringify(keys.map((k) => row[k] ?? null));

function compare(
  current: ReadonlyMap<string, string>,
  planned: ReadonlyMap<string, string>,
): Changes {
  const out: Changes = { new: 0, changed: 0, unchanged: 0, removed: 0 };
  for (const [ref, s] of planned) {
    const before = current.get(ref);
    if (before === undefined) out.new += 1;
    else if (before === s) out.unchanged += 1;
    else out.changed += 1;
  }
  for (const ref of current.keys()) if (!planned.has(ref)) out.removed += 1;
  return out;
}

const PERSON_KEYS = [
  "address",
  "given_name",
  "family_name",
  "member_status",
  "active",
  "why_kept",
  "person_id",
  "link_how",
] as const;
const MEMBERSHIP_KEYS = [
  "ref",
  "type_ref",
  "name",
  "kind",
  "status",
  "from_date",
  "until_date",
  "uses_total",
  "uses_left",
  "renews",
] as const;
const CLASS_KEYS = [
  "class_type_ref",
  "title",
  "starts_at",
  "ends_at",
  "location_name",
  "staff_ref",
  "places",
  "booked",
  "waiting",
  "cancelled",
] as const;
const BOOKING_KEYS = ["ref", "person_ref", "state"] as const;

/** Each ref's signature: its own fields and its children's (memberships, or bookings), sorted. */
function signatures(
  rows: readonly Record<string, unknown>[],
  keys: readonly string[],
  children: readonly Record<string, unknown>[],
  parent: string,
  childKeys: readonly string[],
): Map<string, string> {
  const kids = new Map<string, string[]>();
  for (const c of children) {
    const ref = c[parent] as string;
    const list = kids.get(ref) ?? [];
    list.push(sig(c, childKeys));
    kids.set(ref, list);
  }
  return new Map(
    rows.map((r) => [
      r.ref as string,
      `${sig(r, keys)}${JSON.stringify((kids.get(r.ref as string) ?? []).sort())}`,
    ]),
  );
}

/** What the current list of `kind` holds, as signatures (two reads, whatever it holds). */
async function currentSignatures(
  db: Db,
  kind: ListKind,
  listId: string | undefined,
): Promise<Map<string, string>> {
  if (listId === undefined) return new Map();
  if (kind === "members") {
    const [people, memberships] = await Promise.all([
      db
        .selectFrom("core_outside_person")
        .select(["ref", ...PERSON_KEYS])
        .where("list_id", "=", listId)
        .execute(),
      db
        .selectFrom("core_outside_membership")
        .select(["person_ref", ...MEMBERSHIP_KEYS])
        .where("list_id", "=", listId)
        .execute(),
    ]);
    return signatures(people, PERSON_KEYS, memberships, "person_ref", MEMBERSHIP_KEYS);
  }
  const [classes, bookings] = await Promise.all([
    db
      .selectFrom("core_outside_class")
      .select(["ref", ...CLASS_KEYS])
      .where("list_id", "=", listId)
      .execute(),
    db
      .selectFrom("core_outside_booking")
      .select(["class_ref", ...BOOKING_KEYS])
      .where("list_id", "=", listId)
      .execute(),
  ]);
  return signatures(classes, CLASS_KEYS, bookings, "class_ref", BOOKING_KEYS);
}

/**
 * The fingerprint of a plan: a keyed hash (the deployment's salt) over the file's text, the mapping
 * and export date, the current lists it replaces or reads, and every row the plan would write with
 * its links and matches (the call's own time named as such). Two plans with one fingerprint write
 * the same copy. It reveals nothing of a row: it is a keyed hash.
 */
async function fingerprintOf(
  db: Db,
  parts: {
    kind: ListKind;
    text: string;
    mapping: FileMapping;
    exportedOn: string;
    lists: (string | null)[];
    plan: IngestPlan;
    now: string;
  },
): Promise<string> {
  const rows = JSON.stringify(parts.plan.rows, (_k, v) => (v === parts.now ? "@now" : v));
  const digest = await sha256Hex(
    JSON.stringify({
      v: 1,
      kind: parts.kind,
      file: await sha256Hex(parts.text),
      mapping: parts.mapping,
      exportedOn: parts.exportedOn,
      lists: parts.lists,
      rows: await sha256Hex(rows),
    }),
  );
  return saltedHash(db, `outside:file:${digest}`);
}

/**
 * The dry run and the plan of a file: decoded, parsed, mapped (the given mapping, else the saved
 * one when the file has its columns, else the suggestion), read through the file session and
 * planned by the ingest, compared with the current list. Reads only; the plan's statements are
 * the load's to write.
 */
export async function planFile(
  db: Db,
  input: FileInput,
  who: { userId: string; now: string },
): Promise<FilePlan> {
  const { text, encoding } = decodeFile(input.bytes);
  // The copy's version before anything is read: the load's batch is guarded by it, so whatever
  // changes after this (an erase, a link, another load) fails the batch (the review, S3).
  const version = await copyVersion(db);
  // The first row only: the file is parsed whole once, by the file session (the review, M1).
  let headerRow: string[];
  try {
    headerRow = readHeader(text);
  } catch (error) {
    asValidation(error);
  }
  const headers = headerRow.map((h) => h.trim());
  if (!headers.length) throw refused("The file is empty.");
  const suggested = suggestMapping(input.kind, headers);
  const saved = (await savedMappings(db))[input.kind];
  let mapping: FileMapping;
  let mappingFrom: FilePreview["mappingFrom"];
  if (input.mapping) {
    mapping = input.mapping;
    mappingFrom = "given";
  } else if (saved && (await sameShape(db, saved, headers))) {
    mapping = {
      columns: saved.columns,
      ...(saved.values ? { values: saved.values } : {}),
      ...(saved.dateFormat ? { dateFormat: saved.dateFormat } : {}),
    };
    mappingFrom = "saved";
  } else {
    mapping = suggested;
    mappingFrom = "suggested";
  }
  checkMapping(input.kind, mapping, headers);
  const [general, today] = await Promise.all([loadGeneralSettings(db), businessToday(db, who.now)]);
  const exportedOn = input.exportedOn ?? today;
  const fields: Record<string, Field> = FILE_FIELDS[input.kind];
  const missing = Object.entries(fields)
    .filter(([field, f]) => f.required && mapping.columns[field] === undefined)
    .map(([field]) => field);
  const base: Omit<
    FilePreview,
    | "rows"
    | "issueCount"
    | "issues"
    | "formulaLike"
    | "outcome"
    | "linking"
    | "waiting"
    | "statements"
    | "fingerprint"
  > = {
    kind: input.kind,
    ready: missing.length === 0,
    missing,
    headers,
    mapping,
    mappingFrom,
    suggested,
    encoding,
    exportedOn,
  };
  if (missing.length) {
    return {
      plan: null,
      preview: {
        ...base,
        rows: { read: 0, refused: 0 },
        issueCount: 0,
        issues: [],
        formulaLike: 0,
        outcome: {
          changes: { new: 0, changed: 0, unchanged: 0, removed: 0 },
          kept: 0,
          notKept: 0,
          dropped: 0,
          previouslyErased: 0,
          linked: 0,
          links: 0,
          toMatch: 0,
          unlinked: 0,
          items: {},
        },
        linking: [],
        waiting: [],
        statements: 0,
        fingerprint: "",
      },
    };
  }

  let load: FileLoad;
  try {
    load = loadFiles({
      site: { name: general.orgName ?? "Booking system", timeZone: general.timezone },
      now: who.now,
      // The one address check: the form erased addresses and suppressions are keyed by.
      normaliseAddress: normaliseCustomerEmail,
      // The columns that look like names, addresses or ids by their headers, mapped or not: a
      // mapping is checked against their values too (the review, M4).
      watch: personalHeaders(input.kind, suggested),
      ...asLoadInput(input.kind, text, mapping),
    });
  } catch (error) {
    asValidation(error);
  }
  const personal = personalValuesOf(load);
  checkMapping(input.kind, mapping, headers, personal);
  checkFreeText(input.kind, mapping, load, personal);

  const meta = {
    exportedOn,
    by: who.userId,
    now: who.now,
    rows: input.kind === "members" ? load.rows.people : load.rows.timetable,
    refused: leftOut(load.issues),
    mapping: {
      columns: mapping.columns,
      ...(mapping.dateFormat ? { dateFormat: mapping.dateFormat } : {}),
    },
  };
  // The one path every source takes: the file session, read through the contract, planned by
  // the ingest (and so by step 10's rules).
  const session = directSession(new FileBookingSystem(load, "A loaded file"));
  let plan: IngestPlan;
  try {
    if (input.kind === "members") {
      plan = await planMembers(db, await readMembers(session), meta);
    } else {
      const starts = load.classes.map((c) => Date.parse(c.startsAt));
      const from = starts.length ? Math.min(...starts) : Date.parse(who.now);
      const until = starts.length ? Math.max(...starts) + 1 : from + 86_400_000;
      if (until - from > MAX_TIMETABLE_DAYS * 86_400_000) {
        throw refused(
          `A timetable list covers at most ${MAX_TIMETABLE_DAYS} days: export a shorter window.`,
          "outside_window",
        );
      }
      plan = await planTimetable(
        db,
        {
          ...(await readTimetable(session, {
            from: new Date(from).toISOString(),
            until: new Date(until).toISOString(),
          })),
          // Every address a row carried, beside an id too, is checked (the review, S2).
          bookingAddresses: load.bookingAddresses,
        },
        meta,
      );
    }
  } catch (error) {
    asValidation(error);
  }

  const lists = await currentLists(db);
  const current = lists.get(input.kind);
  const before = await currentSignatures(db, input.kind, current?.id);
  const planned =
    input.kind === "members"
      ? signatures(
          plan.rows.person ?? [],
          PERSON_KEYS,
          plan.rows.membership ?? [],
          "person_ref",
          MEMBERSHIP_KEYS,
        )
      : signatures(
          plan.rows.class ?? [],
          CLASS_KEYS,
          plan.rows.booking ?? [],
          "class_ref",
          BOOKING_KEYS,
        );
  const named = input.kind === "members" ? (plan.rows.person ?? []) : (plan.rows.staff ?? []);
  const nameOf = (r: Record<string, unknown>) =>
    input.kind === "members"
      ? [r.given_name, r.family_name].filter(Boolean).join(" ") || (r.ref as string)
      : ((r.display_name as string | null) ?? (r.ref as string));
  const byRef = new Map(named.map((r) => [r.ref as string, r]));
  const linking = named
    .filter((r) => r.link_how === "address" && r.linked_at === who.now)
    .slice(0, MAX_NAMED_SHOWN)
    .map((r) => ({
      ref: r.ref as string,
      name: nameOf(r),
      to: (r.person_id ?? r.user_id) as string,
    }));
  const waiting = (plan.rows.match ?? []).slice(0, MAX_NAMED_SHOWN).map((m) => {
    const r = byRef.get(m.ref as string);
    return { ref: m.ref as string, name: r ? nameOf(r) : (m.ref as string), why: m.why as string };
  });
  const fingerprint = await fingerprintOf(db, {
    kind: input.kind,
    text,
    mapping,
    exportedOn,
    // A members list's keeping reads the current timetable (who is booked): both are named.
    lists: [lists.get("members")?.id ?? null, lists.get("timetable")?.id ?? null],
    plan,
    now: who.now,
  });
  // The guard first: the batch commits only while the copy is the version this plan read.
  plan.statements.unshift(guardStatement(version));
  const c = plan.counts;
  return {
    plan,
    preview: {
      ...base,
      rows: { read: meta.rows, refused: meta.refused },
      issueCount: load.issues.length,
      issues: load.issues.slice(0, MAX_ISSUES_SHOWN),
      formulaLike: load.formulaLike,
      outcome: {
        changes: compare(before, planned),
        kept: c.kept,
        notKept: c.notKept,
        dropped: c.dropped,
        previouslyErased: c.previouslyErased,
        linked: c.linked,
        links: c.links,
        toMatch: c.waiting,
        unlinked: c.unlinked,
        items: c.items,
      },
      linking,
      waiting,
      statements: plan.statements.length,
      fingerprint,
    },
  };
}

/**
 * A keyed hash of a file's set of column names (the deployment's salt): what a saved mapping
 * keeps to know the next export of the same shape, never the names themselves (the review, M3).
 */
function shapeOf(db: Db, headers: readonly string[]): Promise<string> {
  return saltedHash(db, `outside:shape:${JSON.stringify([...new Set(headers)].sort())}`);
}

/** The next export of the same shape: the same columns, by name, in any order. */
async function sameShape(db: Db, saved: SavedMapping, headers: readonly string[]) {
  const have = new Set(headers);
  return (
    typeof saved.shape === "string" &&
    saved.shape === (await shapeOf(db, headers)) &&
    Object.values(saved.columns ?? {}).every((h) => have.has(h))
  );
}

/** The statement that saves a load's mapping as its kind's, for the next export of that shape. */
export async function saveMappingStatement(
  db: Db,
  kind: ListKind,
  mapping: FileMapping,
  headers: readonly string[],
): Promise<CompiledQuery> {
  const saved: SavedMapping = {
    columns: mapping.columns,
    ...(mapping.values ? { values: mapping.values } : {}),
    ...(mapping.dateFormat ? { dateFormat: mapping.dateFormat } : {}),
    shape: await shapeOf(db, headers),
  };
  return CompiledQuery.raw(
    "UPDATE core_outside_settings SET mappings = json_set(CASE WHEN json_valid(mappings) THEN mappings ELSE '{}' END, ?, json(?)) WHERE id = 1",
    [`$.${kind}`, JSON.stringify(saved)],
  );
}

/** The statement that forgets a kind's saved mapping (`outside.settings.update`, a human admin). */
export function clearMappingStatement(kind: ListKind): CompiledQuery {
  return CompiledQuery.raw(
    "UPDATE core_outside_settings SET mappings = json_remove(CASE WHEN json_valid(mappings) THEN mappings ELSE '{}' END, ?) WHERE id = 1",
    [`$.${kind}`],
  );
}

/** The copy's version now (migration 1413's view): counts, rowids and times, never a value. */
export async function copyVersion(db: Db): Promise<string> {
  const row = await db.selectFrom("core_outside_version").select("version").executeTakeFirst();
  return row?.version ?? "";
}

/**
 * The load's guard, the first statement of its batch: the trigger fails the whole batch
 * (`core_outside_stale`) unless the copy is still `version` (the review, S3).
 */
export function guardStatement(version: string): CompiledQuery {
  return CompiledQuery.raw("INSERT INTO core_load_guard (expected) VALUES (?)", [version]);
}
