// Input validation for everything that reaches this Worker over RPC. Sessions are called by
// untrusted extension code, so every value is parsed strictly and bounded in size; nothing relies
// on TypeScript types surviving the RPC boundary.

import { z } from "zod";
import { isEmailAddress } from "./address";
import type { EmailAgreement } from "./agreement";
import type { EmailCalendarEvent } from "./calendar";
import type { EmailSendMessage } from "./types";

/** Recipients across `to`, `cc` and `bcc`; Email Service's own limit. */
export const MAX_RECIPIENTS = 50;
/** Bytes per body part. Two full parts still fit the 96 KiB approval description. */
export const MAX_BODY_BYTES = 32 * 1024;
export const MAX_SUBJECT_LENGTH = 998;
export const MAX_RELATED_RECORDS = 20;
const RECORD_ID = /^[A-Za-z0-9_.:-]{1,128}$/;

const utf8 = new TextEncoder();

const address = z
  .string()
  .refine(isEmailAddress, "must be a plain email address (name@example.com)");
const addressList = z.array(address).max(MAX_RECIPIENTS);
const body = z
  .string()
  .refine(
    (text) => utf8.encode(text).byteLength <= MAX_BODY_BYTES,
    `must be at most ${MAX_BODY_BYTES} bytes`,
  );

/** Control characters a calendar's text may not hold: all but tab, and for one line, newlines. */
const CONTROL = {
  test(text: string): boolean {
    for (const char of text) {
      const code = char.codePointAt(0) ?? 0;
      // Tab (9), newline (10) and carriage return (13) are allowed here; one-line values refuse
      // the last two on their own.
      if ((code < 32 && code !== 9 && code !== 10 && code !== 13) || code === 127) return true;
    }
    return false;
  },
};
const line = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((text) => !/[\r\n]/.test(text), "must be a single line")
    .refine((text) => !CONTROL.test(text), "must not hold control characters");
const instant = z.iso.datetime({ offset: true });
const WEEK_MS = 7 * 86_400_000;

/** A message's "add to calendar" event (ADR 0571): the gatekeeper makes the file from it. */
const calendarSchema = z
  .strictObject({
    uid: z.string().regex(RECORD_ID, "must be a record id"),
    start: instant,
    end: instant,
    title: line(200),
    location: line(200).optional(),
    description: z
      .string()
      .min(1)
      .max(2000)
      .refine((text) => !CONTROL.test(text), "must not hold control characters")
      .optional(),
    url: z
      .url({ protocol: /^https$/ })
      .max(500)
      .optional(),
    sequence: z.number().int().min(0).max(2_147_483_647).optional(),
    cancelled: z.boolean().optional(),
  })
  .refine(
    (e) => {
      const span = Date.parse(e.end) - Date.parse(e.start);
      return span > 0 && span <= WEEK_MS;
    },
    { message: "must end after it starts, within 7 days" },
  );

// --- A signed agreement (ADR 0645): the values the gatekeeper makes the PDF from ----------------

/** Text that may run over lines (a run, a label), without control characters but tab and newline. */
const prose = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((text) => !CONTROL.test(text), "must not hold control characters");
const MAX_AGREEMENT_BYTES = 256 * 1024;
const MAX_LIST_DEPTH = 6;

const inline = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("text"),
    text: prose(5000),
    bold: z.boolean().optional(),
    italic: z.boolean().optional(),
    code: z.boolean().optional(),
    href: line(2000)
      .refine((href) => !/\s/.test(href), "must be a link")
      .optional(),
  }),
  z.strictObject({ type: z.literal("break") }),
]);
const inlines = z.array(inline).max(500);

type ListInput = {
  style: "bullet" | "ordered";
  items: { content: z.infer<typeof inlines>; list?: ListInput }[];
};
const listStyle = z.enum(["bullet", "ordered"]);
const listShape: z.ZodType<ListInput> = z.lazy(() =>
  z.strictObject({ style: listStyle, items: listItems }),
);
const listItems = z
  .array(z.strictObject({ content: inlines, list: listShape.optional() }))
  .min(1)
  .max(200);
const depthOf = (list: ListInput): number =>
  1 + Math.max(0, ...list.items.map((item) => (item.list ? depthOf(item.list) : 0)));

/** An agreement's body: ADR 0440's rich text, only the blocks a version may hold (ADR 0640). */
const agreementBody = z.strictObject({
  blocks: z
    .array(
      z.discriminatedUnion("type", [
        z.strictObject({ type: z.literal("paragraph"), content: inlines }),
        z.strictObject({
          type: z.literal("heading"),
          level: z.number().int().min(1).max(6),
          content: inlines,
        }),
        z
          .strictObject({
            type: z.literal("list"),
            style: listStyle,
            items: listItems,
          })
          .refine((list) => depthOf(list) <= MAX_LIST_DEPTH, "nests too deep"),
        z.strictObject({
          type: z.literal("quote"),
          content: inlines,
          attribution: prose(300).optional(),
        }),
        z.strictObject({
          type: z.literal("callout"),
          tone: z.enum(["info", "note", "success", "warning"]),
          content: inlines,
        }),
        z.strictObject({ type: z.literal("divider") }),
      ]),
    )
    .max(1000),
});

const coordinate = (max: number) => z.number().int().min(0).max(max);

/**
 * A message's `agreement`: the business, the version (title, number, hash, body, tick label, a
 * health form's questions), the record lines and the strokes. Health answers have no field here:
 * only `answers: "in-app"` (decision 21).
 */
const agreementSchema = z
  .strictObject({
    business: line(200),
    title: line(200),
    versionNumber: z.number().int().min(1).max(1_000_000),
    versionHash: z.string().regex(/^[0-9a-f]{64}$/, "must be a SHA-256 in hex"),
    body: agreementBody,
    tickLabel: prose(1000),
    questions: z
      .array(
        z.strictObject({
          key: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/, "must be a question key"),
          text: line(500),
        }),
      )
      .min(1)
      .max(40)
      .optional(),
    answers: z.literal("in-app").optional(),
    record: z
      .array(z.strictObject({ label: line(80), value: line(2000) }))
      .max(30)
      .optional(),
    signature: z
      .strictObject({
        width: z.literal(1000),
        height: z.literal(400),
        strokes: z
          .array(
            z
              .array(z.tuple([coordinate(1000), coordinate(400)]))
              .min(1)
              .max(5000),
          )
          .min(1)
          .max(30),
      })
      .refine((s) => s.strokes.reduce((n, st) => n + st.length, 0) <= 5000, "too many points")
      .optional(),
    acceptanceId: z.string().regex(/^aga_[A-Za-z0-9_-]{1,60}$/, "must be an acceptance id"),
    summary: line(300),
  })
  .refine(
    (a) => utf8.encode(JSON.stringify(a)).byteLength <= MAX_AGREEMENT_BYTES,
    `must be at most ${MAX_AGREEMENT_BYTES} bytes`,
  );

const messageSchema = z
  .strictObject({
    to: addressList.min(1),
    cc: addressList.optional(),
    bcc: addressList.optional(),
    subject: z
      .string()
      .min(1)
      .max(MAX_SUBJECT_LENGTH)
      .refine((subject) => !/[\r\n]/.test(subject), "must be a single line"),
    text: body.optional(),
    html: body.optional(),
    replyTo: address.optional(),
    relatedRecords: z
      .array(z.string().regex(RECORD_ID, "must be a CRM record id"))
      .max(MAX_RELATED_RECORDS)
      .optional(),
    // One event, or two (a move: the old class's cancel and the new class's event).
    calendar: z.union([calendarSchema, z.array(calendarSchema).min(1).max(2)]).optional(),
    // A signed agreement (ADR 0645): only the host's agreements mail may carry it (worker.ts).
    agreement: agreementSchema.optional(),
    // The one-tap stop (ADR 0675): only the host's routine mail may carry it (worker.ts).
    listUnsubscribe: z.string().max(600).optional(),
  })
  .refine((message) => message.text !== undefined || message.html !== undefined, {
    message: "needs a text or html body",
  })
  .refine(
    (message) =>
      message.to.length + (message.cc?.length ?? 0) + (message.bcc?.length ?? 0) <= MAX_RECIPIENTS,
    { message: `may have at most ${MAX_RECIPIENTS} recipients across to, cc and bcc` },
  );

/**
 * A checked message. `agreement` is the host's alone (ADR 0645): it is not in the session's types
 * agents read, and worker.ts refuses it from any queue but the host's agreements mail.
 */
export type ParsedMessage = EmailSendMessage & {
  agreement?: EmailAgreement;
  /** The one-tap stop's link (ADR 0675): the host's routine mail's alone, checked in worker.ts. */
  listUnsubscribe?: string;
};

/** Validates a `send()` argument, throwing a readable error naming the first bad field. */
export function parseMessage(input: unknown): ParsedMessage {
  const result = messageSchema.safeParse(input);
  if (!result.success) {
    const issue = result.error.issues[0];
    const where = issue && issue.path.length > 0 ? `${issue.path.join(".")} ` : "";
    throw new TypeError(`Invalid email: ${where}${issue?.message ?? "is malformed"}.`);
  }
  // Rebuilt field by field, so only known keys reach storage and the approval text.
  const message = result.data;
  return {
    to: [...message.to],
    ...(message.cc?.length ? { cc: [...message.cc] } : {}),
    ...(message.bcc?.length ? { bcc: [...message.bcc] } : {}),
    subject: message.subject,
    ...(message.text !== undefined ? { text: message.text } : {}),
    ...(message.html !== undefined ? { html: message.html } : {}),
    ...(message.replyTo !== undefined ? { replyTo: message.replyTo } : {}),
    ...(message.relatedRecords?.length ? { relatedRecords: [...message.relatedRecords] } : {}),
    ...(message.calendar
      ? {
          calendar: (Array.isArray(message.calendar) ? message.calendar : [message.calendar]).map(
            calendarOf,
          ),
        }
      : {}),
    ...(message.agreement ? { agreement: agreementOf(message.agreement) } : {}),
    ...(message.listUnsubscribe !== undefined ? { listUnsubscribe: message.listUnsubscribe } : {}),
  };
}

/** An agreement rebuilt from its parsed value (only the schema's keys exist on it). */
function agreementOf(agreement: z.infer<typeof agreementSchema>): EmailAgreement {
  return structuredClone(agreement) as EmailAgreement;
}

/** A calendar event rebuilt key by key, times as UTC instants. */
function calendarOf(event: z.infer<typeof calendarSchema>): EmailCalendarEvent {
  return {
    uid: event.uid,
    start: new Date(event.start).toISOString(),
    end: new Date(event.end).toISOString(),
    title: event.title,
    ...(event.location !== undefined ? { location: event.location } : {}),
    ...(event.description !== undefined ? { description: event.description } : {}),
    ...(event.url !== undefined ? { url: event.url } : {}),
    ...(event.sequence !== undefined ? { sequence: event.sequence } : {}),
    ...(event.cancelled ? { cancelled: true } : {}),
  };
}

/** Every recipient of a message. */
export function recipientsOf(message: EmailSendMessage): string[] {
  return [...message.to, ...(message.cc ?? []), ...(message.bcc ?? [])];
}
