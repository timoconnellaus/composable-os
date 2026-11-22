# ADR 0571: A calendar file made by the email gatekeeper

Status: accepted, 2026-11-23 (stage 31a, build step 9). Extends
[ADR 0114](0114-own-gatekeepers-pickers-and-host-modules.md) (the email-send gatekeeper) and
[ADR 0051](0051-outbound-approvals.md) (outbound approvals).

## Context
Decision 16 of stage 31: the booking email carries "add to calendar". No iCalendar file existed
anywhere. Email-send took text and HTML only, every value checked; an attachment of bytes an
extension supplies would be a way to send anything to anyone with the approver reading only a file
name, and a pack building the file itself would write the format in every pack.

## Decision
- **A message may carry `calendar`**: one event (`uid`, `start`, `end`, `title`, `location?`,
  `description?`, `url?`, `sequence?`, `cancelled?`), checked as strictly as the rest of the
  message: the uid a record id, times ISO instants with the end after the start and within a week,
  title and location one line of at most 200 characters, the link https only. Nothing else can be
  attached.
- **The gatekeeper makes the file** (`packages/gatekeeper-email-send/src/calendar.ts`) when the
  send is applied, never before: RFC 5545, one `VEVENT`, times in UTC (a calendar shows the event at
  the right instant across a clock change and in any zone), text escaped, lines folded at 75 octets
  without splitting a character, CRLF line ends, `UID` the given id at the sender's domain. A change
  sends the same uid with a higher `sequence`; `cancelled` makes it `METHOD:CANCEL` and
  `STATUS:CANCELLED`, so a calendar that imported the first file removes the event. It is attached
  as `invite.ics` (`text/calendar; method=PUBLISH` or `CANCEL`) through Email Service's structured
  `attachments`.
- **The approver sees it**: the approval card lists "Calendar file" with what it adds or cancels,
  when and where, in one line. A message with a calendar is never the host's sign-in mail
  (ADR 0456's template check refuses it).

## Why here
The gatekeeper is the host's code at the edge where mail leaves; the format is written once, the
pack hands values it already has, and the approval shows exactly what goes out. The core holds no
copy: the runner's bundle does not grow.

## Proof
`packages/gatekeeper-email-send/test/calendar.test.ts`: the file line by line, escaping and
folding, a cancellation; the approval field; the attachment only once applied; each bad value
refused; no other attachment; never sign-in mail. `apps/runner/test/bookings-messages.test.ts`: the
booking email's file as it reaches the fake Email Service, a change's later sequence and a
cancellation's `METHOD:CANCEL`.

## Amended 2026-11-23, after the review of PR #256
- **The approver sees everything the file says**: beside "Calendar file" (what it adds or cancels,
  when, where), the card shows its link and its description in full.
- **Control characters are refused** in its text (all but tab, and in one-line values newlines too).
- **RFC 5546's parties**: every file names its `ORGANIZER` (the sending address), and a
  cancellation its `ATTENDEE`s (the recipients).
- **One or two files**: `calendar` may be one event or two, each its own attachment
  (`invite.ics`, and `cancelled.ics` for a cancellation): a move cancels the old class's event and
  adds the new one's in one email.
- **Not verified in real calendar apps**: the files are checked line by line against RFC 5545 and
  5546 here; how Apple Calendar, Google Calendar and Outlook treat a PUBLISH or a CANCEL sent as an
  attachment (rather than as an iMIP invitation) has not been tried.
