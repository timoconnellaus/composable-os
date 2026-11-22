// The "add to calendar" file (ADR 0571): an iCalendar (RFC 5545) file of one event, made by this
// gatekeeper from a message's `calendar` (an event's title, start, end, place and link), never
// from bytes the caller supplies. A caller cannot attach anything else: no other attachment is
// accepted, and every value is checked and escaped here.
//
// Times are written in UTC (`DTSTART:20261124T190000Z`), so a calendar shows the event at the same
// instant across a clock change, in whatever zone the reader's device is. A change by the sender
// sends the same `uid` with a higher `sequence`; a cancellation sends `cancelled: true`, which a
// calendar that imported the first file uses to remove the event.

/** One event to attach as an `.ics` file (the `calendar` of an email). */
export interface EmailCalendarEvent {
  /** A stable id of what the event is (a record id): the same on a change or a cancellation. */
  uid: string;
  /** ISO 8601 instants. The end is after the start, at most 7 days later. */
  start: string;
  end: string;
  /** One line, up to 200 characters. */
  title: string;
  /** One line, up to 200 characters. */
  location?: string;
  /** Up to 2,000 characters. */
  description?: string;
  /** An https link to the event (the timetable or the booking). */
  url?: string;
  /** 0 to 2,147,483,647: higher on each change of the same event. Default 0. */
  sequence?: number;
  /** The event is cancelled: the file tells a calendar to remove it. */
  cancelled?: boolean;
}

/** The file name a message's calendar is attached as. */
export const CALENDAR_FILENAME = "invite.ics";

/** Text values: backslash, semicolon, comma and newlines escaped (RFC 5545 3.3.11). */
function escapeText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r\n|\r|\n/g, "\\n");
}

/** `20261124T190000Z`: an instant in UTC, as DATE-TIME (RFC 5545 3.3.5, form 2). */
export function icsTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) throw new TypeError(`Invalid time: ${iso}`);
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

const utf8 = new TextEncoder();

/** Folds a content line at 75 octets, never inside a UTF-8 character (RFC 5545 3.1). */
function fold(line: string): string {
  if (utf8.encode(line).byteLength <= 75) return line;
  const parts: string[] = [];
  let current = "";
  let bytes = 0;
  for (const char of line) {
    const size = utf8.encode(char).byteLength;
    // The first line holds 75 octets; each continuation starts with a space, so 74 more.
    const limit = parts.length === 0 ? 75 : 74;
    if (bytes + size > limit) {
      parts.push(current);
      current = "";
      bytes = 0;
    }
    current += char;
    bytes += size;
  }
  parts.push(current);
  return parts.join("\r\n ");
}

/**
 * The `.ics` text of one event. `domain` makes the UID globally unique (`<uid>@<domain>`, the
 * sender's domain); `stamp` is when the file was made.
 */
export function calendarFile(event: EmailCalendarEvent, domain: string, stamp: Date): string {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Composable OS//Calendar file//EN",
    "CALSCALE:GREGORIAN",
    `METHOD:${event.cancelled ? "CANCEL" : "PUBLISH"}`,
    "BEGIN:VEVENT",
    `UID:${event.uid}@${domain}`,
    `DTSTAMP:${icsTime(stamp.toISOString())}`,
    `DTSTART:${icsTime(event.start)}`,
    `DTEND:${icsTime(event.end)}`,
    `SEQUENCE:${event.sequence ?? 0}`,
    `STATUS:${event.cancelled ? "CANCELLED" : "CONFIRMED"}`,
    `SUMMARY:${escapeText(event.title)}`,
    ...(event.location ? [`LOCATION:${escapeText(event.location)}`] : []),
    ...(event.description ? [`DESCRIPTION:${escapeText(event.description)}`] : []),
    ...(event.url ? [`URL:${event.url}`] : []),
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  return `${lines.map(fold).join("\r\n")}\r\n`;
}

/** What the approver is shown of a message's calendar file: what it says, in one line. */
export function calendarSummary(event: EmailCalendarEvent): string {
  const when = `${event.start} to ${event.end}`;
  return [
    event.cancelled ? "Cancels" : "Adds",
    `"${event.title}"`,
    when,
    ...(event.location ? [`at ${event.location}`] : []),
  ].join(" ");
}
