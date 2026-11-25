// Routine mail (ADR 0590): the fixed emails a shipped pack declares (a booking's confirmation,
// a class reminder), which the host sends without a person's approval. The declaration is the
// wording: a subject and a body with named slots, the record it is about, and what each slot
// holds. The host fills the slots itself from that record (and the records it points to), decides
// who it goes to, checks every value it puts in, and sends it; a pack names a kind, a record and
// a message, and may pass only a choice among declared words, a time, a count or a flag. Nothing
// a pack, an AI or a member types becomes free text, a link or an address in a routine email.
//
// Routine messages (ADR 0670, stage 30): a kind may also declare a text message's words and a push
// notification's (a title and one line), with the same slots and the same checks, and say whether
// a person may turn its email off (`essential`), what it is for (`purpose`), whether it may go
// during quiet hours (`urgent`), the moment after which a text or push is pointless (`until`) and
// the app screen a push opens (`open`). A kind that declares neither sends email only, as before.
//
// This module is the contract's part: the declaration's shape and checks, and the pure template
// rendering and value checks the host and the testing harness share.
import { z } from "zod";

/** The host module that sends routine mail, in an automation of a shipped pack only. */
export const ROUTINE_MAIL_MODULE = "routine-mail";

/** A kind may be about the host's own orders: the buyer's own address. */
export const ROUTINE_ABOUT_ORDER = "order";

/** What a routine email may read of an order (the host's own columns), by type. */
export const ROUTINE_ORDER_FIELDS = {
  total: "number",
  paid: "number",
  balance: "number",
  currency: "text",
  balanceDueAt: "datetime",
  state: "text",
} as const;

/** The host fills this one: the name of the member a guardian's email is about. */
export const ROUTINE_MEMBER_SLOT = "member";

/** Most routine emails one recipient gets in a rolling day before the rest wait for a person. */
export const ROUTINE_DAILY_CAP = 20;

/** The channels a routine message goes on (ADR 0670). Email is every kind's. */
export const ROUTINE_CHANNELS = ["email", "text", "push"] as const;
export type RoutineChannel = (typeof ROUTINE_CHANNELS)[number];

/**
 * What a kind is for, as far as consent goes (stage 30): `account` (about something the person
 * has or did) or `follow_up` (Reviews' ask, a welcome). Never `news_and_offers`: a routine kind is
 * not promotional.
 */
export const ROUTINE_PURPOSES = ["account", "follow_up"] as const;
export type RoutinePurpose = (typeof ROUTINE_PURPOSES)[number];

/**
 * A personal link (ADR 0723): the route on the business's site a form-link slot opens, and the
 * query parameter its token travels in. The client web app's form page serves it.
 */
export const PERSONAL_LINK_PATH = "/form";
export const PERSONAL_LINK_PARAM = "t";
/** How long a personal link stays good unless the slot says (decision 4: a week). */
export const PERSONAL_LINK_DAYS = 7;
/** The longest a personal link may stay good. */
export const PERSONAL_LINK_MAX_DAYS = 30;
/** Most receipts (ADR 0724) one mailbox is sent in a rolling day: the fourth is not sent. */
export const RECEIPT_DAILY_CAP = 3;

/** The longest business name a text begins with: a longer one is cut to this (ADR 0670). */
export const TEXT_SENDER_MAX = 30;
/** What every text ends with, added by the host. */
export const TEXT_STOP_LINE = "Reply STOP to stop";
/** A text is at most two segments, the name and the stop line counted in. */
export const TEXT_MAX_SEGMENTS = 2;
/** A push's title and body, at most (it shows on a locked screen). */
export const PUSH_TITLE_MAX = 60;
export const PUSH_BODY_MAX = 140;

// ---------------------------------------------------------------------------------------------
// The declaration

/** A slot the host fills from the record: a field, or a path through relations (`class.title`). */
export interface RoutineFieldSlot {
  field: string;
  /** How it is written. Default `text` (one line, checked: no link, no address, no markup). */
  format?: "text" | "datetime" | "time" | "date" | "money" | "count";
  /** For a time: the path to the time zone field it is read in. */
  zone?: string;
  /** For money: the path to the currency (an order's own `currency`). */
  currency?: string;
  /** For a date or a time: include the year. */
  year?: boolean;
  /** For text: the longest value that is routine (default 120, at most 300). */
  max?: number;
  /** May be empty: only inside an optional part (`[...]`), which is left out when it is. */
  optional?: boolean;
  /**
   * Private (health, pay, a note): never in a push's words, which show on a locked screen
   * (ADR 0670). Email and text may carry it.
   */
  private?: boolean;
}

export type RoutineSlotSpec =
  | RoutineFieldSlot
  /** The pack passes one of these keys; the email says the declared words. */
  | { choice: Record<string, string>; guardian?: Record<string, string> }
  /** The pack passes a moment (ISO); the host writes it like a datetime field. */
  | { at: true; zone?: string; year?: boolean; optional?: boolean }
  /** The pack passes a whole number from 0 to `max`. */
  | { count: { max: number } }
  /** The pack passes true or false; false leaves out the optional part it is in. */
  | { flag: true }
  /**
   * A link to one of this extension's text settings, used only when it is on the business's own
   * site (Settings → Routine email); otherwise its optional part is left out. `withId` adds the
   * record's id as that query parameter.
   */
  | { link: string; withId?: string }
  /**
   * A personal link (ADR 0723, the form-link slot): the host makes, while preparing each email, a
   * link for the record's own Person to answer one form, about this record, once, and writes its
   * address on the business's site here. `object` is a form object's registry name
   * (`forms.form`); `setting` one of this extension's text settings, a person's to change
   * (`personApproves`), holding the form's address. The link stays good `days` days (default 7,
   * at most 30). With `once`, a Person who was sent a link to that form in the last `once` days,
   * about any other record, is not sent this email at all (decision 4: once a month). A kind with
   * one goes by email only, never to the record's Person when they have a live guardian (the
   * guardian is sent it instead), and the email is not sent when no link can be made.
   */
  | { formLink: { object: string; setting: string; days?: number; once?: number } }
  /**
   * The business's name (ADR 0724), which the host fills from Settings → Routine email (the name
   * a human admin gave, the one texts begin with): never anything a pack or a sender wrote. Left
   * unset there, the email is held for a person.
   */
  | { business: true }
  /** One line per record of `object` whose `via` is this record (a buyer's tickets). */
  | {
      each: {
        object: string;
        via: string;
        where?: { field: string; in: readonly string[] };
        distinct?: string;
        max: number;
        line: string;
        slots: Record<string, RoutineFieldSlot>;
      };
    };

/** An "add to calendar" event, every value read by the host from the record. */
export interface RoutineCalendarSpec {
  /** A relation of the record whose id is the event's id (a moved booking's old one). */
  uid?: string;
  start: string;
  end?: string;
  title: string;
  location?: string;
  /** A link slot for the event's link. */
  link?: string;
  cancelled?: boolean;
  /** A change: the file carries a later sequence, so a calendar replaces the event. */
  update?: boolean;
  /** A flag slot: the event is attached only when the pack passes true. */
  if?: string;
}

/** A push notification's words: a title and one line, with the same slots (ADR 0670). */
export interface RoutinePushWords {
  title: string;
  body: string;
}

export interface RoutineMessageSpec {
  subject: string;
  /** Lines of words with `{slot}` and optional parts `[...]`. */
  text: string;
  /**
   * A text message's words, one line (ADR 0670): the host puts the business's name first and
   * "Reply STOP to stop" last, and the whole must fit two segments with every slot at its longest.
   */
  textMessage?: string;
  /** A push's words: a title of at most 60 characters and a body of at most 140, slots filled. */
  push?: RoutinePushWords;
  /**
   * What a guardian of the member is sent instead (ADR 0540); `{member}` is the member's name. A
   * guardian is texted or pushed only when their own words for that channel are declared.
   */
  guardian?: { subject: string; text: string; textMessage?: string; push?: RoutinePushWords };
  calendar?: RoutineCalendarSpec | readonly RoutineCalendarSpec[];
}

export interface RoutineMailSpec {
  /** For admins: "Booking confirmations". */
  label: string;
  /** For admins: when it is sent and to whom. */
  description: string;
  /** An object of this extension (`booking`), or `order`. */
  about: string;
  /** Sent unless an admin turns it off (default true). */
  on?: boolean;
  /**
   * Whether its email must always go (ADR 0670): a person may turn an optional kind's email off,
   * never an essential one's (text and push of any kind can be turned off). Default true for
   * `account`, false for `follow_up`, which is never essential.
   */
  essential?: boolean;
  /** What it is for (default `account`). */
  purpose?: RoutinePurpose;
  /**
   * May go during quiet hours, but only when waiting for them to end would make it late (its
   * `until` moment is before they end): a class cancelled at short notice (ADR 0676).
   */
  urgent?: boolean;
  /** A datetime path of the record (`class.startsAt`): a text or push not sent by then is dropped. */
  until?: string;
  /** The channels it may go on (default email only); text and push need their words. */
  channels?: readonly RoutineChannel[];
  /** The app screen a push opens, with the record's id: one the pack's native blocks declare. */
  open?: { screen: string };
  /**
   * A receipt (ADR 0724): about one of this extension's intake submissions, sent to whoever sent
   * it (their own sign-in address when signed in, else the address they typed, which may be one
   * only the public stands behind), at most three a day to one mailbox. Its words show only the
   * form's own fields (slots through the submission's form), never anything the sender typed.
   */
  receipt?: boolean;
  slots?: Record<string, RoutineSlotSpec>;
  messages: Record<string, RoutineMessageSpec>;
}

/** What `ctx.routineMail.send` takes. */
export interface RoutineSendInput {
  /** A kind this extension declares (`confirmation`). */
  kind: string;
  /** The record it is about: the host decides who it goes to from it. */
  record: string;
  /** One of the kind's messages (default its only one). */
  message?: string;
  /** Values of the slots the pack may fill: choices, moments, counts and flags. */
  values?: Record<string, string | number | boolean>;
}

/** What it answers: how many emails went, waited for a person, or were not sent. */
export interface RoutineSendResult {
  /** Sent on their own. */
  sent: number;
  /** Waiting for a person (over the daily cap, a value that is not routine, the policy). */
  held: number;
  /** The kind is turned off: nothing was sent or queued. */
  off: boolean;
  /** Nobody to send it to (no address, an unpaid hold, a test run). */
  none: boolean;
}

export interface RoutineMailModule {
  send(input: RoutineSendInput): Promise<RoutineSendResult>;
}

// ---------------------------------------------------------------------------------------------
// The manifest's shape

const NAME = /^[a-z][a-zA-Z0-9]{0,39}$/;
const name = z.string().regex(NAME, "camelCase letters and digits, starting lowercase");
const path = z
  .string()
  .regex(/^[a-z][a-zA-Z0-9]{0,39}(\.[a-z][a-zA-Z0-9]{0,39}){0,3}$/, "a field or a.relation.path");
const words = z.string().min(1).max(300);

const fieldSlotSchema = z
  .object({
    field: path,
    format: z.enum(["text", "datetime", "time", "date", "money", "count"]).optional(),
    zone: path.optional(),
    currency: path.optional(),
    year: z.boolean().optional(),
    max: z.number().int().min(1).max(300).optional(),
    optional: z.boolean().optional(),
    private: z.boolean().optional(),
  })
  .strict();

const slotSchema = z.union([
  fieldSlotSchema,
  z
    .object({
      choice: z.record(name, words),
      guardian: z.record(name, words).optional(),
    })
    .strict(),
  z
    .object({
      at: z.literal(true),
      zone: path.optional(),
      year: z.boolean().optional(),
      optional: z.boolean().optional(),
    })
    .strict(),
  z.object({ count: z.object({ max: z.number().int().min(1).max(1000) }).strict() }).strict(),
  z.object({ flag: z.literal(true) }).strict(),
  z.object({ business: z.literal(true) }).strict(),
  z
    .object({
      formLink: z
        .object({
          object: z.string().regex(/^[a-z][a-z0-9]{0,29}\.[a-z][a-zA-Z0-9]{0,49}$/),
          setting: name,
          days: z.number().int().min(1).max(PERSONAL_LINK_MAX_DAYS).optional(),
          once: z.number().int().min(1).max(365).optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      link: name,
      withId: z
        .string()
        .regex(/^[a-z][a-zA-Z0-9]{0,20}$/)
        .optional(),
    })
    .strict(),
  z
    .object({
      each: z
        .object({
          object: z.string().regex(/^[a-z][a-z0-9]{0,29}$/),
          via: name,
          where: z
            .object({ field: name, in: z.array(z.string().max(100)).min(1).max(20) })
            .strict()
            .optional(),
          distinct: path.optional(),
          max: z.number().int().min(1).max(100),
          line: z.string().min(1).max(500),
          slots: z.record(name, fieldSlotSchema),
        })
        .strict(),
    })
    .strict(),
]);

const calendarSchema = z
  .object({
    uid: name.optional(),
    start: path,
    end: path.optional(),
    title: path,
    location: path.optional(),
    link: name.optional(),
    cancelled: z.boolean().optional(),
    update: z.boolean().optional(),
    if: name.optional(),
  })
  .strict();

const pushSchema = z
  .object({ title: z.string().min(1).max(200), body: z.string().min(1).max(400) })
  .strict();
const textMessageSchema = z.string().min(1).max(600);

const messageSchema = z
  .object({
    subject: z.string().min(1).max(200),
    text: z.string().min(1).max(4000),
    textMessage: textMessageSchema.optional(),
    push: pushSchema.optional(),
    guardian: z
      .object({
        subject: z.string().min(1).max(200),
        text: z.string().min(1).max(4000),
        textMessage: textMessageSchema.optional(),
        push: pushSchema.optional(),
      })
      .strict()
      .optional(),
    calendar: z.union([calendarSchema, z.array(calendarSchema).min(1).max(2)]).optional(),
  })
  .strict();

const routineMailKindSchema = z
  .object({
    label: z.string().min(1).max(80),
    description: z.string().min(1).max(500),
    about: z.string().regex(/^[a-z][a-z0-9]{0,29}$/),
    on: z.boolean().optional(),
    essential: z.boolean().optional(),
    purpose: z.enum(ROUTINE_PURPOSES).optional(),
    urgent: z.boolean().optional(),
    until: path.optional(),
    channels: z.array(z.enum(ROUTINE_CHANNELS)).min(1).max(3).optional(),
    open: z.object({ screen: name }).strict().optional(),
    receipt: z.boolean().optional(),
    slots: z.record(name, slotSchema).default({}),
    messages: z.record(name, messageSchema),
  })
  .strict();
// The manifest's types are the declaration's (written out, so the SDK's declarations the sandbox
// checks extensions against stay small): what the schema parses is exactly these.
export type RoutineFieldSlotManifest = RoutineFieldSlot;
export type RoutineSlotManifest = RoutineSlotSpec;
export type RoutineCalendarManifest = RoutineCalendarSpec;
export interface RoutineMessageManifest {
  subject: string;
  text: string;
  textMessage?: string | undefined;
  push?: RoutinePushWords | undefined;
  guardian?:
    | {
        subject: string;
        text: string;
        textMessage?: string | undefined;
        push?: RoutinePushWords | undefined;
      }
    | undefined;
  calendar?: RoutineCalendarSpec | readonly RoutineCalendarSpec[] | undefined;
}
export interface RoutineMailKindManifest {
  label: string;
  description: string;
  about: string;
  on?: boolean | undefined;
  essential?: boolean | undefined;
  purpose?: RoutinePurpose | undefined;
  urgent?: boolean | undefined;
  until?: string | undefined;
  channels?: readonly RoutineChannel[] | undefined;
  open?: { screen: string } | undefined;
  receipt?: boolean | undefined;
  slots: Record<string, RoutineSlotSpec>;
  messages: Record<string, RoutineMessageManifest>;
}

export const routineMailManifestSchema: z.ZodType<Record<string, RoutineMailKindManifest>> =
  z.record(name, routineMailKindSchema) as never;

/** The channels a kind may go on: email, and what it declares. */
export function channelsOf(kind: Pick<RoutineMailKindManifest, "channels">): RoutineChannel[] {
  const declared = new Set<RoutineChannel>(kind.channels ?? ["email"]);
  return ROUTINE_CHANNELS.filter((c) => declared.has(c));
}

/** Whether a person may not turn the kind's email off (decision 9; follow-ups never are). */
export function essentialOf(kind: Pick<RoutineMailKindManifest, "essential" | "purpose">): boolean {
  return kind.essential ?? (kind.purpose ?? "account") === "account";
}

/** A kind's messages' calendar events, as a list. */
export function calendarsOf(message: RoutineMessageManifest): RoutineCalendarManifest[] {
  const c = message.calendar;
  return c ? (Array.isArray(c) ? [...c] : [c as RoutineCalendarManifest]) : [];
}

// ---------------------------------------------------------------------------------------------
// Templates: `{slot}`, and optional parts `[...]` left out when a slot in them is empty

type Piece = { text: string } | { slot: string };
type Part = Piece | { optional: Piece[] };

export interface ParsedTemplate {
  lines: Part[][];
  /** Every slot the template names. */
  slots: Set<string>;
  /** Slots named only inside optional parts. */
  optionalOnly: Set<string>;
  error: string | null;
}

/** Parses a template; `error` says what is wrong with it (the manifest check reports it). */
export function parseTemplate(template: string): ParsedTemplate {
  const slots = new Set<string>();
  const bare = new Set<string>();
  const lines: Part[][] = [];
  let error: string | null = null;
  for (const line of template.split("\n")) {
    const parts: Part[] = [];
    let optional: Piece[] | null = null;
    let i = 0;
    while (i < line.length) {
      const ch = line[i] as string;
      if (ch === "[") {
        if (optional) error ??= "An optional part [...] cannot hold another";
        optional = [];
        i += 1;
      } else if (ch === "]") {
        if (!optional) error ??= "A ] with no [ before it";
        else parts.push({ optional });
        optional = null;
        i += 1;
      } else if (ch === "{") {
        const end = line.indexOf("}", i);
        const slot = end > i ? line.slice(i + 1, end) : "";
        if (!NAME.test(slot)) {
          error ??= `"{${slot}}" is not a slot name`;
          i = end > i ? end + 1 : line.length;
          continue;
        }
        slots.add(slot);
        if (!optional) bare.add(slot);
        (optional ?? parts).push({ slot });
        i = end + 1;
      } else if (ch === "}") {
        error ??= "A } with no { before it";
        i += 1;
      } else {
        let j = i;
        while (j < line.length && !"[]{}".includes(line[j] as string)) j += 1;
        (optional ?? parts).push({ text: line.slice(i, j) });
        i = j;
      }
    }
    if (optional) error ??= "An optional part [ is not closed on its line";
    lines.push(parts);
  }
  const optionalOnly = new Set([...slots].filter((s) => !bare.has(s)));
  return { lines, slots, optionalOnly, error };
}

/** The literal words of a template (what the pack wrote, not the slots). */
export function literalText(parsed: ParsedTemplate): string {
  const out: string[] = [];
  for (const line of parsed.lines) {
    for (const part of line) {
      const pieces = "optional" in part ? part.optional : [part];
      for (const piece of pieces) if ("text" in piece) out.push(piece.text);
    }
  }
  return out.join(" ");
}

/**
 * Renders a template. A slot with no value (null or undefined) empties its optional part; outside
 * one it is written as nothing (the host holds such a send for a person). A line that had words
 * and is left with none is dropped.
 */
export function renderTemplate(
  template: string | ParsedTemplate,
  values: Readonly<Record<string, string | null | undefined>>,
): string {
  const parsed = typeof template === "string" ? parseTemplate(template) : template;
  const piece = (p: Piece) => ("text" in p ? p.text : (values[p.slot] ?? ""));
  const out: string[] = [];
  for (const line of parsed.lines) {
    if (!line.length) {
      out.push("");
      continue;
    }
    let text = "";
    for (const part of line) {
      if ("optional" in part) {
        const missing = part.optional.some(
          (p) => "slot" in p && (values[p.slot] === null || values[p.slot] === undefined),
        );
        if (!missing) text += part.optional.map(piece).join("");
      } else {
        text += piece(part);
      }
    }
    if (text.trim()) out.push(text.replace(/ {2,}/g, " ").trimEnd());
  }
  return out.join("\n");
}

// ---------------------------------------------------------------------------------------------
// What a value may hold to be routine

// Control and format characters (bidirectional overrides, zero-width joiners) let a value hide
// or reorder what it shows.
const HIDDEN =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching them is the point.
  // biome-ignore lint/suspicious/noMisleadingCharacterClass: single code points, on purpose.
  /[\u0000-\u001f\u007f-\u009f\u00ad\u034f\u061c\u115f\u1160\u17b4\u17b5\u180b-\u180e\u200b-\u200f\u2028-\u202e\u2060-\u206f\u3164\ufe00-\ufe0f\ufeff\uffa0\ufff9-\ufffb]/u;
/** Dots, and the characters that look like one. */
const DOT =
  "[.\\u2024\\u2027\\u00b7\\u2219\\u22c5\\u0701\\u3002\\uff0e\\uff61\\u0589\\u06d4\\ua4f8\\u2e33\\u2022\\u2e31]";
/** Top-level domains a reader would take for one (a dot before one makes `example.com`). */
const TLD =
  "(?:com|net|org|io|co|au|uk|nz|info|biz|xyz|app|dev|me|ly|gg|tv|online|site|shop|club|top|link|click|to|us|ca|de|fr|in|ru|cn|ai|be|fm|gl|cc|ws|vip|live|pro|store|tk|ml|ga|cf)";
/** A domain's letters, and the letters a reader takes for them (`c0m`). */
const TLD_LOOSE = `(?:${TLD}|c[o0]m|n[e3]t|[o0]rg)`;
// A link, an address, markup, or something a mail program (or a reader) turns into one:
// `example.com`, `example . com`, `gymhelp,com`, `gymhelp com`, `example(dot)com`, `dot xyz`,
// `bit ly slash`, `https colon slash slash`, `hxxp`, an IP address, a scheme.
const LINKISH = new RegExp(
  [
    ":\\/\\/",
    `www\\s*${DOT}`,
    "@",
    "[<>[\\]{}\\\\]",
    "xn--",
    `[\\p{L}\\p{N}-]${DOT}${TLD_LOOSE}\\b`,
    `[\\p{L}\\p{N}]\\s*(?:${DOT}|,)\\s*${TLD_LOOSE}\\b`,
    `\\b[\\p{L}\\p{N}-]{3,}\\s+(?:com|net|org|xyz|c0m)\\b`,
    "[([]\\s*(?:dot|\\.)\\s*[)\\]]",
    `\\bdot\\s*${TLD_LOOSE}\\b`,
    "\\bbit\\s*ly\\b",
    "\\b(?:colon\\s*slash|slash\\s*slash)\\b",
    "\\bhxxps?\\b",
    "\\b\\d{1,3}(?:\\s*\\.\\s*\\d{1,3}){3}\\b",
    "\\b(?:mailto|tel|sms|javascript|data|file|ftp|https?)\\s*:",
  ].join("|"),
  "iu",
);
// A phone number (eight or more digits, spaced or not), or an instruction to call or text one;
// five or more numbers in words; a messaging app's name (a handle follows it).
const PHONE = new RegExp(
  [
    "(?:\\+|\\b)\\d(?:[\\s().-]*\\d){7,}",
    "\\b(?:call|ring|text|sms|phone|whatsapp|tel)\\b\\D{0,20}\\d[\\d\\s().-]{2,}\\d",
    "\\b(?:(?:zero|oh|one|two|three|four|five|six|seven|eight|nine|double|triple)\\b[\\s,.-]*){5,}",
    "\\b(?:whats\\s*app|signal|telegram|wechat|viber|snapchat|kik|line\\s+id)\\b",
  ].join("|"),
  "iu",
);

/**
 * Why `value` cannot go into a routine email, or null when it can: one line of at most `max`
 * characters, no hidden, blank-looking or direction-changing characters, nothing that is or
 * becomes a link or an address (look-alike dots and spelled-out ones included), no markup, no
 * phone number and nothing asking the reader to call or text one. A member's name, a class's
 * title and a cancellation's reason are checked with it. A legitimate title with a phone number
 * in it is held for a person: that is the intended outcome.
 */
export function unroutineText(value: string, max: number): string | null {
  if (value.length > max) return `longer than ${max} characters`;
  if (HIDDEN.test(value)) return "a line break or hidden character";
  if (LINKISH.test(value)) return "a link, an address or markup";
  if (PHONE.test(value)) return "a phone number or a messaging handle";
  return null;
}

/** Why the words a pack declares cannot be routine, or null (a link only through a link slot). */
export function unroutineWords(words: string): string | null {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching them is the point.
  if (/[\u0000-\u0009\u000b-\u001f\u007f-\u009f​-‏‪-‮⁠-⁯﻿]/.test(words)) {
    return "a hidden character";
  }
  if (/:\/\/|www\.|@|<|>|\\|xn--|[\p{L}\p{N}-]\.\p{L}{2,}/iu.test(words)) {
    return "a link, an address or markup (links go in a link slot)";
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// How a value is written

/** A moment as a member reads it, in a zone (ADR 0460): "Monday 7 December at 06:00 (Europe/London time)". */
export function formatMoment(
  iso: string,
  zone: string | null,
  as: "datetime" | "time" | "date",
  year = false,
): string | null {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return null;
  const timeZone = zone || "UTC";
  try {
    const clock: Intl.DateTimeFormatOptions = {
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    };
    const day: Intl.DateTimeFormatOptions = {
      weekday: "long",
      day: "numeric",
      month: "long",
      ...(year ? { year: "numeric" } : {}),
    };
    const options = as === "time" ? clock : as === "date" ? day : { ...day, ...clock };
    const local = new Intl.DateTimeFormat("en-GB", { timeZone, ...options }).format(at);
    return as === "datetime" ? `${local} (${timeZone.replace(/_/g, " ")} time)` : local;
  } catch {
    return null;
  }
}

/** An amount in minor units: "12.50 AUD". */
export function formatMoney(minor: number, currency: string): string | null {
  if (!Number.isFinite(minor) || !/^[A-Za-z]{3}$/.test(currency)) return null;
  return `${(minor / 100).toFixed(2)} ${currency.toUpperCase()}`;
}

// ---------------------------------------------------------------------------------------------
// Text messages: segments, and the words the host wraps around a kind's (ADR 0670)

// The GSM 03.38 alphabet a text is sent in when it can be; the extension table's characters take
// two units. Anything else sends the whole text in the longer encoding (UCS-2).
const GSM_BASIC = new Set(
  "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà",
);
const GSM_EXTENDED = new Set("^{}\\[~]|€\f");

/** How a text is sent: its encoding, its length in that encoding's units, and its segments. */
export function textSegments(value: string): {
  encoding: "gsm" | "ucs2";
  units: number;
  segments: number;
} {
  let units = 0;
  let gsm = true;
  for (const ch of value) {
    if (GSM_BASIC.has(ch)) units += 1;
    else if (GSM_EXTENDED.has(ch)) units += 2;
    else {
      gsm = false;
      break;
    }
  }
  if (gsm) return { encoding: "gsm", units, segments: units <= 160 ? 1 : Math.ceil(units / 153) };
  const length = value.length;
  return { encoding: "ucs2", units: length, segments: length <= 70 ? 1 : Math.ceil(length / 67) };
}

/**
 * A text in the plainest characters that say the same (a dash for an en dash, straight quotes,
 * a space for a no-break space), so one typographic character does not double its cost.
 */
export function textForm(value: string): string {
  return value
    .replace(/[\u2013\u2014\u2212]/g, "-")
    .replace(/[\u2018\u2019\u201b\u2032]/g, "'")
    .replace(/[\u201c\u201d\u2033]/g, '"')
    .replace(/\u2026/g, "...")
    .replace(/[\u00a0\u2007\u202f]/g, " ");
}

/** A text as it is sent: the business's name first, the words, and the stop line last. */
export function wrapText(sender: string, words: string): string {
  const name = sender.trim().slice(0, TEXT_SENDER_MAX).trim();
  return textForm(`${name}: ${words.trim()} ${TEXT_STOP_LINE}`);
}

/** The longest a moment written by `formatMoment` can be (the longest zone name counted). */
const LONGEST_ZONE = 32;
const MOMENT_MAX = {
  // "Wednesday 30 September 2026 at 23:59 (America/Argentina/ComodRivadavia time)"
  datetime: 9 + 1 + 2 + 1 + 9 + 4 + 5 + 2 + LONGEST_ZONE + 6,
  time: 5,
  date: 9 + 1 + 2 + 1 + 9,
} as const;
const YEAR = 5;

/** The longest value a slot can be filled with (for the length checks), or null: not allowed. */
function slotMaxLength(slot: RoutineSlotSpec, guardian: boolean): number | null {
  if ("field" in slot) {
    const format = slot.format ?? "text";
    if (format === "text") return slot.max ?? 120;
    if (format === "money") return 16;
    if (format === "count") return 12;
    return MOMENT_MAX[format] + (slot.year && format !== "time" ? YEAR : 0);
  }
  if ("choice" in slot) {
    const words = Object.entries(slot.choice).map(
      ([k, v]) => (guardian ? slot.guardian?.[k] : undefined) ?? v,
    );
    return Math.max(0, ...words.map((w) => w.length));
  }
  if ("at" in slot) return MOMENT_MAX.datetime + (slot.year ? YEAR : 0);
  if ("count" in slot) return String(slot.count.max).length;
  if ("flag" in slot) return 0;
  if ("business" in slot) return TEXT_SENDER_MAX;
  return null;
}

/** A form-link slot's declaration. */
export interface FormLinkSlotSpec {
  object: string;
  setting: string;
  days?: number;
  once?: number;
}

/** The kind's form-link slots, by name (at most one is allowed). */
export function formLinkSlotsOf(
  kind: Pick<RoutineMailKindManifest, "slots">,
): [string, FormLinkSlotSpec][] {
  const out: [string, FormLinkSlotSpec][] = [];
  for (const [slotName, slot] of Object.entries(kind.slots)) {
    if ("formLink" in slot) out.push([slotName, slot.formLink]);
  }
  return out;
}

/** The longest a member's name is written (`unroutineText`'s bound for it). */
const MEMBER_MAX = 80;
/** The longest link a text may carry: a longer one fails its row at the host (ADR 0670). */
export const TEXT_LINK_MAX = 120;

// ---------------------------------------------------------------------------------------------
// The manifest check

/** Field types a text slot may read: never an address, a link, a phone number or a user. */
const TEXT_FIELD_TYPES = new Set(["text", "longText", "select", "number", "timezone"]);
const TIME_FIELD_TYPES = new Set(["datetime", "date"]);

interface CheckFieldManifest {
  type: string;
  to?: string | undefined;
  readOnly?: boolean | undefined;
}
interface CheckManifest {
  id: string;
  objects: Record<
    string,
    {
      fields: Record<string, CheckFieldManifest>;
      customer?: { field: string } | undefined;
      intake?: { role: string; form?: string } | undefined;
    }
  >;
  settings: Record<string, { type: string; personApproves?: boolean | undefined }>;
  permissions: { modules: readonly string[] };
  routineMail?: Record<string, RoutineMailKindManifest> | undefined;
}

/**
 * The type of the field at `path` from `object` (a local object name, or `order`), walking only
 * relations to this extension's own objects; or why it cannot be read.
 */
export function routinePathType(
  manifest: CheckManifest,
  object: string,
  fieldPath: string,
): { type: string; to?: string } | { problem: string } {
  const segments = fieldPath.split(".");
  if (object === ROUTINE_ABOUT_ORDER) {
    const type = ROUTINE_ORDER_FIELDS[segments[0] as keyof typeof ROUTINE_ORDER_FIELDS];
    if (segments.length !== 1 || !type) {
      return {
        problem: `an order's routine email reads ${Object.keys(ROUTINE_ORDER_FIELDS).join(", ")} only`,
      };
    }
    return { type };
  }
  let current = manifest.objects[object];
  for (const [i, segment] of segments.entries()) {
    const field = current?.fields[segment];
    if (!field) return { problem: `${segments.slice(0, i + 1).join(".")} is not a field` };
    if (i === segments.length - 1)
      return { type: field.type, ...(field.to ? { to: field.to } : {}) };
    const own = field.type === "relation" && field.to?.startsWith(`${manifest.id}.`);
    if (!own) {
      return {
        problem: `${segments.slice(0, i + 1).join(".")} is not a relation to one of this extension's objects`,
      };
    }
    current = manifest.objects[(field.to as string).slice(manifest.id.length + 1)];
  }
  return { problem: "an empty path" };
}

/** Contract issues in an extension's routine mail. */
export function routineMailIssues(manifest: CheckManifest): { path: string; message: string }[] {
  const issues: { path: string; message: string }[] = [];
  const kinds = manifest.routineMail ?? {};
  const contract = (path: string, message: string) => issues.push({ path, message });
  const names = Object.keys(kinds);
  if (names.length && !manifest.permissions.modules.includes(ROUTINE_MAIL_MODULE)) {
    contract(
      "permissions.modules",
      `Routine mail is sent through the "${ROUTINE_MAIL_MODULE}" module`,
    );
  }
  if (names.length > 12) contract("routineMail", "At most 12 kinds of routine mail");
  for (const [kindName, kind] of Object.entries(kinds)) {
    const base = `routineMail.${kindName}`;
    const about = kind.about;
    if (about !== ROUTINE_ABOUT_ORDER && !manifest.objects[about]) {
      contract(`${base}.about`, `"${about}" is not an object of this extension, nor order`);
      continue;
    }
    const checkField = (at: string, from: string, slot: RoutineFieldSlotManifest) => {
      const found = routinePathType(manifest, from, slot.field);
      if ("problem" in found) return contract(`${at}.field`, found.problem);
      const format = slot.format ?? "text";
      const fits =
        format === "text"
          ? TEXT_FIELD_TYPES.has(found.type)
          : format === "money" || format === "count"
            ? found.type === "number"
            : TIME_FIELD_TYPES.has(found.type);
      if (!fits) contract(`${at}.format`, `A ${found.type} field cannot be written as ${format}`);
      if (slot.zone) {
        const zone = routinePathType(manifest, from, slot.zone);
        if ("problem" in zone) contract(`${at}.zone`, zone.problem);
        else if (zone.type !== "timezone" && zone.type !== "text")
          contract(`${at}.zone`, "zone must be a time zone field");
      }
      if (format === "money") {
        const currency = slot.currency
          ? routinePathType(manifest, from, slot.currency)
          : { problem: "money needs currency" };
        if ("problem" in currency) contract(`${at}.currency`, currency.problem);
      }
    };
    const slots = kind.slots;
    for (const [slotName, slot] of Object.entries(slots)) {
      const at = `${base}.slots.${slotName}`;
      if (slotName === ROUTINE_MEMBER_SLOT) contract(at, `"${slotName}" is filled by the host`);
      if ("field" in slot) checkField(at, about, slot);
      else if ("choice" in slot) {
        for (const [key, said] of Object.entries({ ...slot.choice, ...(slot.guardian ?? {}) })) {
          const why = unroutineWords(said);
          if (why) contract(`${at}.choice.${key}`, `The words hold ${why}`);
        }
        for (const key of Object.keys(slot.guardian ?? {})) {
          if (!(key in slot.choice)) contract(`${at}.guardian.${key}`, `"${key}" is not a choice`);
        }
      } else if ("at" in slot) {
        if (slot.zone) {
          const zone = routinePathType(manifest, about, slot.zone);
          if ("problem" in zone) contract(`${at}.zone`, zone.problem);
        }
      } else if ("formLink" in slot) {
        const setting = manifest.settings[slot.formLink.setting];
        if (setting?.type !== "text") {
          contract(
            `${at}.formLink.setting`,
            `"${slot.formLink.setting}" is not a text setting of this extension`,
          );
        } else if (setting.personApproves !== true) {
          // Which form members are sent to is a person's to choose, never an AI's (ADR 0723).
          contract(
            `${at}.formLink.setting`,
            `"${slot.formLink.setting}" must be a setting a person approves (personApproves)`,
          );
        }
        if (about === ROUTINE_ABOUT_ORDER || !manifest.objects[about]?.customer) {
          contract(
            `${at}.formLink`,
            "A personal link is for the record's own Person: the kind is about an object with a customer",
          );
        }
      } else if ("link" in slot) {
        const setting = manifest.settings[slot.link];
        if (setting?.type !== "text") {
          contract(`${at}.link`, `"${slot.link}" is not a text setting of this extension`);
        } else if (setting.personApproves !== true) {
          // The link every email carries: a person's to change, never an AI's (ADR 0590).
          contract(
            `${at}.link`,
            `"${slot.link}" must be a setting a person approves (personApproves)`,
          );
        }
      } else if ("each" in slot) {
        const each = slot.each;
        const object = manifest.objects[each.object];
        if (!object) {
          contract(`${at}.each.object`, `"${each.object}" is not an object of this extension`);
          continue;
        }
        const via = object.fields[each.via];
        const target = about === ROUTINE_ABOUT_ORDER ? "order" : `${manifest.id}.${about}`;
        if (!via || (via.type !== "text" && !(via.type === "relation" && via.to === target))) {
          contract(`${at}.each.via`, `${each.object}.${each.via} must point to the ${about}`);
        } else if (via.readOnly !== true) {
          // Which records are the lines is the host's (a grant's order): a caller re-pointing a
          // ticket at another order must not put it in that buyer's email (ADR 0590).
          contract(
            `${at}.each.via`,
            `${each.object}.${each.via} must be readOnly (set by the host)`,
          );
        }
        if (each.where && !object.fields[each.where.field]) {
          contract(`${at}.each.where`, `"${each.where.field}" is not a field of ${each.object}`);
        }
        if (each.where?.in.some((v) => v === "")) {
          // An empty value is never checked (nothing shown): a line it picked would go unchecked.
          contract(`${at}.each.where`, "where.in cannot hold an empty value");
        }
        if (each.distinct) {
          const d = routinePathType(manifest, each.object, each.distinct);
          if ("problem" in d) contract(`${at}.each.distinct`, d.problem);
        }
        for (const [inner, innerSlot] of Object.entries(each.slots)) {
          checkField(`${at}.each.slots.${inner}`, each.object, innerSlot);
        }
        const line = parseTemplate(each.line);
        if (line.error) contract(`${at}.each.line`, line.error);
        if (each.line.includes("\n")) contract(`${at}.each.line`, "One line");
        const why = unroutineWords(literalText(line));
        if (why) contract(`${at}.each.line`, `The words hold ${why}`);
        for (const used of line.slots) {
          if (!(used in each.slots))
            contract(`${at}.each.line`, `{${used}} is not one of its slots`);
          else if (each.slots[used]?.optional && !line.optionalOnly.has(used)) {
            contract(`${at}.each.line`, `{${used}} may be empty: put it in an optional part [...]`);
          }
        }
      }
    }
    channelIssues(manifest, base, kind, contract);
    personalLinkIssues(manifest, base, kind, contract);
    const messages = Object.entries(kind.messages);
    if (!messages.length || messages.length > 12) {
      contract(`${base}.messages`, "A kind has 1 to 12 messages");
    }
    for (const [messageName, message] of messages) {
      const at = `${base}.messages.${messageName}`;
      const texts: [string, string, boolean][] = [
        [`${at}.subject`, message.subject, false],
        [`${at}.text`, message.text, false],
        ...(message.guardian
          ? ([
              [`${at}.guardian.subject`, message.guardian.subject, true],
              [`${at}.guardian.text`, message.guardian.text, true],
            ] as [string, string, boolean][])
          : []),
      ];
      for (const [where, template, guardian] of texts) {
        const parsed = parseTemplate(template);
        if (parsed.error) contract(where, parsed.error);
        if (where.endsWith("subject") && template.includes("\n")) contract(where, "One line");
        const why = unroutineWords(literalText(parsed));
        if (why) contract(where, `The words hold ${why}`);
        for (const used of parsed.slots) {
          if (used === ROUTINE_MEMBER_SLOT) {
            if (!guardian) contract(where, `{${used}} is only for what a guardian is sent`);
            continue;
          }
          const slot = slots[used];
          if (!slot) {
            contract(where, `{${used}} is not a slot of ${kindName}`);
            continue;
          }
          if ("formLink" in slot) {
            // The link is what the email is for: never in its subject, never in an optional part.
            if (where.endsWith("subject")) contract(where, `{${used}} is a link: not in a subject`);
            else if (parsed.optionalOnly.has(used)) {
              contract(where, `{${used}} is what the email is for: not in an optional part [...]`);
            }
            continue;
          }
          const mayBeEmpty =
            "link" in slot ||
            "flag" in slot ||
            (("field" in slot || "at" in slot) && slot.optional === true);
          if (mayBeEmpty && !parsed.optionalOnly.has(used)) {
            contract(where, `{${used}} may be empty: put it in an optional part [...]`);
          }
        }
      }
      for (const [i, event] of calendarsOf(message).entries()) {
        const ev = `${at}.calendar.${i}`;
        for (const key of ["start", "end", "title", "location"] as const) {
          const p = event[key];
          if (!p) continue;
          const found = routinePathType(manifest, about, p);
          if ("problem" in found) contract(`${ev}.${key}`, found.problem);
          else if ((key === "start" || key === "end") && !TIME_FIELD_TYPES.has(found.type)) {
            contract(`${ev}.${key}`, "must be a date or datetime field");
          } else if ((key === "title" || key === "location") && !TEXT_FIELD_TYPES.has(found.type)) {
            contract(`${ev}.${key}`, `A ${found.type} field cannot be a calendar's ${key}`);
          }
        }
        if (event.uid) {
          const uid = routinePathType(manifest, about, event.uid);
          if ("problem" in uid || uid.type !== "relation") {
            contract(`${ev}.uid`, "uid must be a relation of the record");
          }
        }
        if (event.link && !(event.link in slots && "link" in (slots[event.link] as object))) {
          contract(`${ev}.link`, `"${event.link}" is not a link slot`);
        }
        if (event.if && !(event.if in slots && "flag" in (slots[event.if] as object))) {
          contract(`${ev}.if`, `"${event.if}" is not a flag slot`);
        }
      }
    }
  }
  return issues;
}

/**
 * A personal link's kind and a receipt (ADRs 0723 and 0724). A kind with a form-link slot has one,
 * goes by email only and is not a receipt. A receipt is about one of this extension's intake
 * submissions, goes by email only, has no guardian's words (it goes to whoever sent it), is about
 * something they did (purpose `account`), and shows only fields of the submission's form (a path
 * through its `form` relation): never a list, a calendar or anything the sender typed.
 */
function personalLinkIssues(
  manifest: CheckManifest,
  base: string,
  kind: RoutineMailKindManifest,
  contract: (path: string, message: string) => void,
): void {
  const links = formLinkSlotsOf(kind);
  const channels = kind.channels ?? ["email"];
  if (links.length > 1) contract(`${base}.slots`, "At most one form-link slot");
  if ((links.length || kind.receipt) && channels.some((c) => c !== "email")) {
    contract(`${base}.channels`, "A personal link and a receipt go by email only");
  }
  if (!kind.receipt) return;
  if (links.length) contract(`${base}.receipt`, "A receipt carries no personal link");
  const object = manifest.objects[kind.about];
  const form = object?.intake?.role === "submission" ? object.intake.form : undefined;
  if (!form) {
    contract(`${base}.about`, "A receipt is about one of this extension's intake submissions");
  }
  if ((kind.purpose ?? "account") !== "account" || kind.essential === false) {
    contract(`${base}.purpose`, "A receipt is about something the person did: purpose account");
  }
  for (const [slotName, slot] of Object.entries(kind.slots)) {
    const at = `${base}.slots.${slotName}`;
    if ("each" in slot) contract(at, "A receipt shows no list");
    if ("field" in slot && form && !slot.field.startsWith(`${form}.`)) {
      contract(
        at,
        `A receipt shows only the form's own fields (${form}.<field>), never what the sender typed`,
      );
    }
  }
  for (const [messageName, message] of Object.entries(kind.messages)) {
    const at = `${base}.messages.${messageName}`;
    if (message.guardian) contract(`${at}.guardian`, "A receipt goes to whoever sent it");
    if (calendarsOf(message).length) contract(`${at}.calendar`, "A receipt has no calendar file");
  }
}

/**
 * A kind's text and push words, and what it says of itself (ADR 0670): the words use only its
 * slots and fit when every slot is at its longest (a text two segments with the business's name
 * and the stop line counted in; a push's title 60 characters and its body 140); a push shows no
 * private slot, no link and no list; `until` is a time of the record; a push names the screen it
 * opens; a follow-up is never essential. A channel needs its words in every message, and words
 * need their channel declared.
 */
function channelIssues(
  manifest: CheckManifest,
  base: string,
  kind: RoutineMailKindManifest,
  contract: (path: string, message: string) => void,
): void {
  const declared = kind.channels ?? ["email"];
  if (new Set(declared).size !== declared.length) contract(`${base}.channels`, "A channel twice");
  if (!declared.includes("email")) {
    contract(`${base}.channels`, "Every kind goes by email: list email first");
  }
  const channels = new Set(declared);
  if ((kind.purpose ?? "account") === "follow_up" && kind.essential === true) {
    contract(`${base}.essential`, "A follow-up is never essential: a person may always stop it");
  }
  if (kind.until) {
    const found = routinePathType(manifest, kind.about, kind.until);
    if ("problem" in found) contract(`${base}.until`, found.problem);
    else if (!TIME_FIELD_TYPES.has(found.type)) {
      contract(`${base}.until`, "until must be a date or datetime field of the record");
    }
  }
  if (kind.urgent && !kind.until) {
    contract(
      `${base}.urgent`,
      "An urgent kind names its moment (until): it goes in quiet hours only when waiting would be too late",
    );
  }
  if (channels.has("push") && !kind.open) {
    contract(`${base}.open`, "A push opens a screen of the app: name it (open.screen)");
  }
  if (kind.open && !channels.has("push")) {
    contract(`${base}.open`, "open is for a push: declare the push channel");
  }
  const slots = kind.slots;
  // Private is the field's, not one slot's: a second slot reading a private field without saying
  // so is private too (the review of PR #339).
  const privateFields = new Set(
    Object.values(slots).flatMap((slot) => ("field" in slot && slot.private ? [slot.field] : [])),
  );
  const check = (
    at: string,
    template: string,
    guardian: boolean,
    channel: "text" | "push",
    bound: number | null,
  ) => {
    const parsed = parseTemplate(template);
    if (parsed.error) return contract(at, parsed.error);
    if (template.includes("\n")) contract(at, "One line");
    const why = unroutineWords(literalText(parsed));
    if (why) contract(at, `The words hold ${why}`);
    const longest: Record<string, string> = {};
    for (const used of parsed.slots) {
      if (used === ROUTINE_MEMBER_SLOT) {
        if (!guardian) contract(at, `{${used}} is only for what a guardian is sent`);
        longest[used] = "a".repeat(MEMBER_MAX);
        continue;
      }
      const slot = slots[used];
      if (!slot) {
        contract(at, `{${used}} is not a slot of the kind`);
        continue;
      }
      if ("each" in slot) {
        contract(
          at,
          `{${used}} is a list: a ${channel === "text" ? "text" : "push"} has no room for one`,
        );
        continue;
      }
      if ("formLink" in slot) {
        contract(at, `{${used}} is a personal link: it goes by email only`);
        continue;
      }
      if (channel === "push" && "link" in slot) {
        contract(at, `{${used}} is a link: a push opens a screen of the app, never a web address`);
        continue;
      }
      if (
        channel === "push" &&
        "field" in slot &&
        (slot.private || privateFields.has(slot.field))
      ) {
        contract(at, `{${used}} is private: a push shows on a locked screen`);
        continue;
      }
      const mayBeEmpty =
        "link" in slot ||
        "flag" in slot ||
        (("field" in slot || "at" in slot) && slot.optional === true);
      if (mayBeEmpty && !parsed.optionalOnly.has(used)) {
        contract(at, `{${used}} may be empty: put it in an optional part [...]`);
      }
      const max = "link" in slot ? TEXT_LINK_MAX : slotMaxLength(slot, guardian);
      longest[used] = "a".repeat(max ?? 0);
    }
    const filled = renderTemplate(parsed, longest);
    if (channel === "text") {
      const sent = wrapText("a".repeat(TEXT_SENDER_MAX), filled);
      // The words decide the encoding: a value that forces the longer one fails its row (ADR 0670).
      // Declared words decide it, a choice's words (and a guardian's) among them: one that forces
      // the longer encoding forces it for the whole text (the review of PR #339).
      const choices = [...parsed.slots].flatMap((used) => {
        const slot = slots[used];
        if (!slot || !("choice" in slot)) return [];
        return [...Object.values(slot.choice), ...Object.values(slot.guardian ?? {})];
      });
      const literal = textSegments(wrapText("a", [literalText(parsed), ...choices].join(" ")));
      const units = literal.encoding === "gsm" ? textSegments(sent).units : sent.length;
      const limit = literal.encoding === "gsm" ? 153 * TEXT_MAX_SEGMENTS : 67 * TEXT_MAX_SEGMENTS;
      if (units > limit) {
        contract(
          at,
          `With every slot at its longest, the business's name and "${TEXT_STOP_LINE}" it is ${units} characters: a text is at most ${limit} (two segments). Use shorter slots (a time, a date, a lower max)`,
        );
      }
    } else if (bound !== null && filled.length > bound) {
      contract(
        at,
        `With every slot at its longest it is ${filled.length} characters: at most ${bound}`,
      );
    }
  };
  for (const [messageName, message] of Object.entries(kind.messages)) {
    const at = `${base}.messages.${messageName}`;
    type Version = RoutineMessageManifest | NonNullable<RoutineMessageManifest["guardian"]>;
    const versions: [string, Version, boolean][] = [[at, message, false]];
    if (message.guardian) versions.push([`${at}.guardian`, message.guardian, true]);
    for (const [where, version, guardian] of versions) {
      if (version.textMessage !== undefined) {
        if (!channels.has("text")) contract(`${where}.textMessage`, "Declare the text channel");
        check(`${where}.textMessage`, version.textMessage, guardian, "text", null);
      }
      if (version.push) {
        if (!channels.has("push")) contract(`${where}.push`, "Declare the push channel");
        check(`${where}.push.title`, version.push.title, guardian, "push", PUSH_TITLE_MAX);
        check(`${where}.push.body`, version.push.body, guardian, "push", PUSH_BODY_MAX);
      }
    }
    if (channels.has("text") && message.textMessage === undefined) {
      contract(`${at}.textMessage`, "The kind goes by text: each message needs its text words");
    }
    if (channels.has("push") && !message.push) {
      contract(`${at}.push`, "The kind goes by push: each message needs its push words");
    }
  }
}
