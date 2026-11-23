// The iCalendar (RFC 5545) writer, written once (ADR 0628, amending ADR 0571). Two callers share it:
// the email gatekeeper's "add to calendar" file (one event, attached to a booking email, ADR 0571)
// and the host's private staff calendar feed (a person's own shifts, polled by a calendar app,
// ADR 0628). No dependencies, so the gatekeeper and the app import it without either depending on
// the other, and the core's runner bundle does not carry it.
//
// What every file it writes holds:
// - CRLF line ends, every content line folded at 75 octets without splitting a UTF-8 character
//   (RFC 5545 3.1), and a final CRLF.
// - Times as UTC instants (`DTSTART:20261124T190000Z`, RFC 5545 3.3.5 form 2): a calendar shows the
//   event at the same instant across a clock change, in whatever zone the reader's device is, and
//   no VTIMEZONE is needed.
// - Text escaped (backslash, semicolon, comma and newlines, RFC 5545 3.3.11), and every control
//   character but a tab removed first (a newline in text becomes the two characters `\n`). So no
//   value can end its line: a title holding CR or LF cannot start a property or an event of its
//   own. Values that are not text (a mailto address, a link) lose every control character.
// - The same values in, the same bytes out: nothing here reads a clock or a random number.

/** One event. */
export interface CalendarEvent {
  /** The event's globally unique id, the same on every change (a record id at a domain). */
  uid: string;
  /** DTSTAMP, an ISO 8601 instant: when the file was made, or (in a feed) when the event last changed. */
  stamp: string;
  /** ISO 8601 instants. */
  start: string;
  end: string;
  /** SUMMARY. */
  title: string;
  location?: string | undefined;
  description?: string | undefined;
  /** A link (the caller checks its scheme). */
  url?: string | undefined;
  /** 0 to 2,147,483,647, higher on each change of the same event sent as its own file. */
  sequence?: number | undefined;
  /** CONFIRMED unless given. */
  status?: "CONFIRMED" | "CANCELLED" | undefined;
  /** RFC 5546's ORGANIZER, as an email address (written as a mailto: URI). */
  organizer?: string | undefined;
  /** RFC 5546's ATTENDEEs, as email addresses. */
  attendees?: readonly string[] | undefined;
  /** LAST-MODIFIED, an ISO 8601 instant. */
  lastModified?: string | undefined;
}

/** One calendar: its product id, its method, an optional name and refresh hint, and its events. */
export interface Calendar {
  /** PRODID, e.g. `-//Composable OS//Calendar file//EN`. */
  prodId: string;
  /** METHOD (RFC 5546): PUBLISH for a file or a feed, CANCEL to take an event off. */
  method?: "PUBLISH" | "CANCEL" | undefined;
  /** The calendar's name as a calendar app shows it (RFC 7986 NAME, and X-WR-CALNAME). */
  name?: string | undefined;
  /**
   * How often a subscribed calendar should fetch it again, as an RFC 5545 duration (`PT1H`): RFC
   * 7986's REFRESH-INTERVAL, and X-PUBLISHED-TTL. A hint: each calendar app decides.
   */
  refresh?: string | undefined;
  events: readonly CalendarEvent[];
}

// Every C0 control character but tab, and DEL. CR and LF are handled first (as `\n` in text).
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is removed.
const CONTROL = /[\u0000-\u0008\u000a-\u001f\u007f]/g;

/** A text value: control characters removed, newlines kept as `\n`, then escaped (RFC 5545 3.3.11). */
export function escapeText(value: string): string {
  return value
    .replace(/\r\n|\r|\n/g, "\n")
    .split("\n")
    .map((part) => part.replace(CONTROL, ""))
    .join("\n")
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\n/g, "\\n");
}

/** A value that is not text (an address, a link): every control character removed. */
function plain(value: string): string {
  return value.replace(/[\r\n]/g, "").replace(CONTROL, "");
}

/** `20261124T190000Z`: an instant in UTC, as DATE-TIME (RFC 5545 3.3.5, form 2). */
export function icsTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) throw new TypeError(`Invalid time: ${iso}`);
  return d
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
}

const DURATION = /^P(?:\d+W|(?:\d+D)?(?:T(?:\d+H)?(?:\d+M)?(?:\d+S)?)?)$/;

const utf8 = new TextEncoder();

/** Folds a content line at 75 octets, never inside a UTF-8 character (RFC 5545 3.1). */
export function fold(line: string): string {
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

function sequenceOf(value: number | undefined): number {
  const n = value ?? 0;
  if (!Number.isInteger(n) || n < 0 || n > 2_147_483_647) {
    throw new TypeError(`Invalid sequence: ${n}`);
  }
  return n;
}

/** The content lines of one event, unfolded. */
function eventLines(event: CalendarEvent): string[] {
  return [
    "BEGIN:VEVENT",
    `UID:${escapeText(event.uid)}`,
    ...(event.organizer ? [`ORGANIZER:mailto:${plain(event.organizer)}`] : []),
    ...(event.attendees ?? []).map((to) => `ATTENDEE:mailto:${plain(to)}`),
    `DTSTAMP:${icsTime(event.stamp)}`,
    `DTSTART:${icsTime(event.start)}`,
    `DTEND:${icsTime(event.end)}`,
    `SEQUENCE:${sequenceOf(event.sequence)}`,
    `STATUS:${event.status ?? "CONFIRMED"}`,
    `SUMMARY:${escapeText(event.title)}`,
    ...(event.location ? [`LOCATION:${escapeText(event.location)}`] : []),
    ...(event.description ? [`DESCRIPTION:${escapeText(event.description)}`] : []),
    ...(event.url ? [`URL:${plain(event.url)}`] : []),
    ...(event.lastModified ? [`LAST-MODIFIED:${icsTime(event.lastModified)}`] : []),
    "END:VEVENT",
  ];
}

/** The `.ics` text of a calendar: CRLF line ends, folded, ending in CRLF. */
export function writeCalendar(calendar: Calendar): string {
  if (calendar.refresh !== undefined && !DURATION.test(calendar.refresh)) {
    throw new TypeError(`Invalid refresh interval: ${calendar.refresh}`);
  }
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    `PRODID:${plain(calendar.prodId)}`,
    "CALSCALE:GREGORIAN",
    ...(calendar.method ? [`METHOD:${calendar.method}`] : []),
    ...(calendar.name
      ? [`NAME:${escapeText(calendar.name)}`, `X-WR-CALNAME:${escapeText(calendar.name)}`]
      : []),
    ...(calendar.refresh
      ? [
          `REFRESH-INTERVAL;VALUE=DURATION:${calendar.refresh}`,
          `X-PUBLISHED-TTL:${calendar.refresh}`,
        ]
      : []),
    ...calendar.events.flatMap(eventLines),
    "END:VCALENDAR",
  ];
  return `${lines.map(fold).join("\r\n")}\r\n`;
}
