# ADR 0762: Open hours and free times

Status: accepted, 2026-11-24 (stage 49, build step 3: open hours). Builds on
[ADR 0621](0621-the-staffed-behaviour-and-the-time-claim.md) (`staffed`),
[ADR 0622](0622-warnings-in-a-writes-answer.md) (time off as a core table) and
[ADR 0625](0625-restricted-pack-permissions.md) (tool-only operations for the verified caller).
Free times, the computation and its bounds, were built by stage 49 step 4 (amended below).

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

## Amended 2026-11-24 (stage 49 step 4: free times)
- **What asks for them.** A staffed object booked at free times declares `staffed.open`: the
  kind's `length` (minutes), `step` (minutes between start times, 30 when empty; any whole number
  from 5 to 1,440 is read, the pack offers 15, 30 or 60), `rooms` (a relation, many, of the kind
  to the things the object `occupies`, in the order they are offered), the record's `client` (a
  relation to a Person) and `closedBy` (another of the pack's objects whose records are date
  ranges). The kind is another of the pack's objects, as for claim margins.
- **The computation** (`staffing/free.ts`, `freeTimes`), at read time, nothing stored. Start
  times sit on the step counted from the organisation's local midnight, so a clock change keeps
  09:00 and 09:30 where they are, and a time that has started is never free. A start time is free
  for a provider when their open hours for the kind (`openRanges`, merged) cover the whole shift;
  their time off (one-off and regular, read by wall clock as open hours are) does not touch it; its
  claim with the kind's margins overlaps none of their claims, with what the batch has queued
  counted over what is held; the first of the kind's rooms is free then (a room not marked one
  booking at a time always is, one in the Trash is never offered, and an empty list needs none);
  no closure covers its local dates; the client has no live shift of the object overlapping it;
  and, for a customer or the public, the object's create rules allow it (their staff-only flag,
  and their window, its numbers read once for every start time). A record being moved does not
  count against itself.
- **Who is a provider.** The accounts qualified for the kind (strictly: a qualification row),
  active, through a profile not in the Trash when the person is a relation (one profile per
  account); "anyone" is every one of them, in order of the profile. An unqualified person with
  open hours is never offered.
- **The bounds.** At most 31 days of start times and 20 providers a call, in a fixed number of
  reads however many hours, claims, time off or times there are (the kind, the providers, hours,
  time off, claims, closures, the client's shifts, the rooms and their claims, the settings:
  `staffing-free.test.ts` holds 31 days of 20 busy coaches to the same count as one quiet coach,
  at most 20 statements with the pipeline's own; 15 when this was written).
  Every list is passed as one JSON value, so no statement nears D1's bound-variable limit.
- **The operation.** `staffing.free { object, kind, from?, to?, providers?, client? }` is
  tool-only and `hostInternal` (it reads core tables), open to staff, customers and the public
  through a shipped pack's tool (Bookings' freeTimes, step 6; listed in `open-operations.json`).
  The kind must be one the caller may read (the public only a public one). `providers` are the
  shift's person values (coach profiles), never accounts, so a customer's tool never handles a
  staff account id; the spec's `accounts?` is this. Where the person is a staff account itself
  (a user field, not a profile), a customer or visitor is answered the times with no providers. A customer's `client` is themselves (the
  default) or a live dependant; the public names nobody. It answers each free time with who is
  free and the first free room, never why another is not. A rate limit per address is the pack
  tool's call (the pipeline limits a tool's outside call, not the operations inside it).
