// The "add to calendar" file (ADR 0571): an iCalendar (RFC 5545) file of one event, made by this
// gatekeeper from a message's `calendar` (an event's title, start, end, place and link), never
// from bytes the caller supplies. A caller cannot attach anything else: no other attachment is
// accepted, and every value is checked and escaped here.
//
// Times are written in UTC (`DTSTART:20261124T190000Z`), so a calendar shows the event at the same
// instant across a clock change, in whatever zone the reader's device is. A change by the sender
// sends the same `uid` with a higher `sequence`; a cancellation sends `cancelled: true`, which a
// calendar that imported the first file uses to remove the event.
//
// The format itself (escaping, folding, UTC times, CRLF) is the shared writer's
// (`@composable-os/calendar-file`, ADR 0628, amending ADR 0571), which the host's staff calendar
// feed uses too: this file says only what an email's event holds.
import { icsTime, writeCalendar } from "@composable-os/calendar-file";

export { icsTime };

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
/** The file name of an event's cancellation, beside a new event's (a move). */
export const CANCEL_FILENAME = "cancelled.ics";

/**
 * The `.ics` text of one event. The UID is the event's at the sending address's domain, so it is
 * globally unique; `stamp` is when the file was made. RFC 5546 names the ORGANIZER (the sending
 * address) in a PUBLISH and a CANCEL, and the ATTENDEEs (the recipients) in a CANCEL. How each
 * calendar app treats a file sent as an attachment is not verified (ADR 0571).
 */
export function calendarFile(
  event: EmailCalendarEvent,
  from: { address: string; to: readonly string[] },
  stamp: Date,
): string {
  const domain = from.address.slice(from.address.lastIndexOf("@") + 1).toLowerCase();
  return writeCalendar({
    prodId: "-//Composable OS//Calendar file//EN",
    method: event.cancelled ? "CANCEL" : "PUBLISH",
    events: [
      {
        uid: `${event.uid}@${domain}`,
        organizer: from.address,
        ...(event.cancelled ? { attendees: from.to } : {}),
        stamp: stamp.toISOString(),
        start: event.start,
        end: event.end,
        sequence: event.sequence ?? 0,
        status: event.cancelled ? "CANCELLED" : "CONFIRMED",
        title: event.title,
        location: event.location,
        description: event.description,
        url: event.url,
      },
    ],
  });
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
