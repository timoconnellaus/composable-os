// Input validation for everything that reaches this Worker over RPC. Sessions are called by
// untrusted extension code, so every value is parsed strictly and bounded in size; nothing relies
// on TypeScript types surviving the RPC boundary.

import { z } from "zod";
import { isEmailAddress } from "./address";
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

const line = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((text) => !/[\r\n]/.test(text), "must be a single line");
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
    description: z.string().min(1).max(2000).optional(),
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
    calendar: calendarSchema.optional(),
  })
  .refine((message) => message.text !== undefined || message.html !== undefined, {
    message: "needs a text or html body",
  })
  .refine(
    (message) =>
      message.to.length + (message.cc?.length ?? 0) + (message.bcc?.length ?? 0) <= MAX_RECIPIENTS,
    { message: `may have at most ${MAX_RECIPIENTS} recipients across to, cc and bcc` },
  );

/** Validates a `send()` argument, throwing a readable error naming the first bad field. */
export function parseMessage(input: unknown): EmailSendMessage {
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
    ...(message.calendar ? { calendar: calendarOf(message.calendar) } : {}),
  };
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
