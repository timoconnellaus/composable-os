# ADR 0762: Open hours and free times

Status: accepted, 2026-11-24 (stage 49, build step 3: open hours). Builds on
[ADR 0621](0621-the-staffed-behaviour-and-the-time-claim.md) (`staffed`),
[ADR 0622](0622-warnings-in-a-writes-answer.md) (time off as a core table) and
[ADR 0625](0625-restricted-pack-permissions.md) (tool-only operations for the verified caller).
Free times, the computation and its bounds, are stage 49 step 4's and amend this ADR when built.

## Context
Stage 49 lets a person book a one-to-one session with a coach (and, from step 7, an outside
practitioner). Each provider says when they take appointments, week by week, with one-off extra
hours; a manager can change them (decision 9). Free times combine these hours with time off,
duties and classes, which are core tables a pack cannot read, so the hours cannot be pack records
in a `rec_*` view (every staff account reads those by SQL), for the reason stage 45 kept time off
out of records. "Not open" already has a home: time off (`core_staff_away`).

## Decision
- **`core_staff_hours`** (migration 1090), beside `core_staff_away` and read the same way. An entry
  is **weekly** (weekdays, a local start and end time in a zone, from a date, default today, until
  one, empty: ongoing; an end at or before the start runs overnight into the next day) or **extra**
  (a one-off range of instants, given as local date-times in a zone, at most 24 hours). An entry may
  be **for some kinds of work only** (`only_for`, a list of the shift's kind records: a service);
  empty, it is open for every kind. Keyed by an account id, text with no foreign key, as the time
  claim is: a staff account now, a practitioner account from step 7. In no `rec_*` view.
- **No "closed" entry.** A one-off "not open" is time off (`staffing.away`): one place for "not
  working". Free times subtract it.
- **Read by wall clock, on the fly** (`staffing/hours.ts`, `openRanges` and `openCovers`): each
  weekly entry is laid on every local date the asked range touches, and the day before (an
  overnight entry that started then), in its own zone, so 09:00 to 17:00 is eight hours on both
  sides of a clock change and 22:00 to 06:00 is nine hours the night the clocks go back. Ranges
  that touch or overlap are merged (09:00 to 12:00 and 12:00 to 15:00 cover 11:00 to 13:00). No
  row is generated per week or per time: nothing goes stale.
- **Who sets them** (`staffing.hours.set`, `.clear`, `.list`; tool-only, called from a shipped
  pack's tool run for its verified caller): the person themselves, or someone who rosters
  (`mayRoster`: admins, and `rostering:manage` where Rostering is installed) for anyone. Someone
  else's entry is as if it were not there. An AI's change waits for a person (the calling tool is
  `humanOnly` or `personApproves`); reading one's own is open to it. `set` with an `id` changes an
  entry in place; the entry stays with whoever it is for.
- **Bounded**: at most 50 entries per account (`hours_too_many`), so a free-times read over 20
  people reads at most 1,000 rows; a list reads at most 500. Every write is one statement.
- **Leaving** (`user.deactivate`, `staffing/leaving.ts`): their entries are removed in the same
  batch, by one statement.
- **Audited** as every operation is; nothing in an entry is a note.

## Consequences
- The practitioner side (an account that is a practitioner's, set by themselves or someone with
  `practitioners:manage`) waits for stage 49 step 7 and stage 43's principal: today the account
  must be an active staff account.
- The screens (*My open hours*, a rosterer's view of everyone's) are step 6's pack screens, over
  these operations through Bookings' tools. Until then nothing calls them outside tests.
- Free times (step 4) read these entries with time off, claims with margins, rooms and closures; the
  customer's check reads the same answer.
