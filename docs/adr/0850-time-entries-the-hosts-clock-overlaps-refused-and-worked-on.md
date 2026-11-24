# ADR 0850: Time entries: one record of time worked, the host's clock, overlaps refused, and `workedOn`

Status: accepted, 2026-11-24 (stage 58, build step 1: time entries). Builds on
[ADR 0621](0621-the-staffed-behaviour-and-the-time-claim.md) (`staffed` and the time claim),
[ADR 0622](0622-warnings-in-a-writes-answer.md) (staff data as core tables in no `rec_*` view),
[ADR 0625](0625-restricted-pack-permissions.md) (tool-only operations for the verified caller),
[ADR 0626](0626-the-rostering-pack-and-bookings-additions.md) (the roster's settings read
through the pack's `staffing.settings`) and [ADR 0627](0627-pay-periods-the-basis-the-totals-the-lock-and-the-export.md)
(the pay lock). Differences from the roster and approval are stage 58 step 2's (ADR 0851); pay
from recorded hours is step 3's (ADR 0852), and amends ADR 0627.

## Context
Stage 58 has staff record the time they actually worked: a cleaner starts and finishes on their
phone, a coach who forgot enters their hours afterwards, a tradesperson records three hours on one
job and four on another. Pay (step 3) and a job's hours (stage 39, Jobs) must read **one** set of
facts, never two records of one person's hour that can disagree. The record is personal (someone's
working day), keyed by a staff account, read by pay, and must hold for every writer and under
races, as the shift claim does.

## Decision
- **`core_time_entry`** (migration 1270) is the one record of time worked: an account, a start and
  a finish as whole unix seconds (the finish null while open), unpaid break minutes the person
  entered, the zone it was given in, its local date (of its start, in the organisation's zone: the
  pay period it belongs to), what it was against, how it was made (`clocked`, `entered`,
  `by_approver` with why), its state (`open`, `waiting`, `approved`, `rejected`), whether its
  finish is missing, and the columns step 2's approval fills (the times as recorded, kept beside
  when approved changed; who approved and when, or `host`; why rejected). A core table in no
  `rec_*` view, as pay and time off are: no member's SQL, export, dashboard or the assistant's
  record reads reach it.
- **The host's clock is the record.** `staffing.time.clockIn` and `clockOut` take `ctx.now`; a time
  in the request is never read (the input schema has none, and unknown keys are dropped). Times are
  kept to the second; the minutes an entry shows are whole minutes from start to finish less its
  break. Times entered afterwards are local date-times to the minute, in a zone (the
  organisation's by default). Nothing is rounded, and **no finish is ever invented**.
- **Overlaps are refused by the database.** `BEFORE INSERT` and `BEFORE UPDATE` triggers refuse an
  entry overlapping another of the same account (`core_time_overlap`, answered as `conflict`,
  `rule: "time_overlap"`), half-open (12:00 to 15:00 follows 09:00 to 12:00), an open entry running
  on from its start. As migration 0811's claim triggers, each leaves out only the row's own id, so
  an `INSERT OR REPLACE`, an upsert and an `UPDATE OR REPLACE` are refused too (D1 runs with
  recursive triggers off). The id is `NOT NULL` and compared with `IS NOT`, so a NULL id cannot
  slip past the check (the review of PR #364). The check reads by an index on account and end, so a person's history is
  never read. A write the host reads first names the other entry (`entry`, its times). Entries are
  separate from the shift claim: an entry may run past its shift into another shift's time.
- **One open entry per person** (a partial unique index, and the trigger saying so first,
  `core_time_open`, answered as `rule: "time_open"`): of twenty starts at once, one lands, the rest
  are refused. A start may carry an **idempotency key** (`key`, 16 to 128 characters, unique
  per account in `start_key`): a retry with it answers the entry it made (`replayed`).
- **What an entry is against is declared, not hard-coded.** A **shift** is a record of a `staffed`
  object, and it must be one of the person's own live, covered shifts: read from its time claim.
  Someone else's shift is refused as `not_your_shift` whatever its state, so a colleague's shift
  never says whether it is cancelled or in the Trash; one of their own that is cancelled is
  `shift_not_live`. A correction checks the shift it is against again (a shift given to someone
  else since is refused until the entry says other work). A **job** is a record of an object that declares **`workedOn`** (below), in one
  of its live states and out of the Trash (`not_live`). Nothing is **other work**. Any other object
  is refused (`not_worked_on`). With no `against`, a start proposes the person's own shift under way
  or starting within 60 minutes (`proposed`, so the screen shows "not this shift"); `null` is other
  work. A start against a shift that is over is refused (enter the time instead).
- **`workedOn`** (SDK, `packages/sdk/src/worked-on.ts`): `live` (states in which time may be
  recorded against it), `title` (a field), `kind` (a relation, the export's kind), `place`,
  `readers` (a permission of the same pack's tools: who reads its time) and `partOf` (on a staffed
  visit only: the relation to the `workedOn` record its time also counts to). Only shipped packs
  and the org's own extensions declare it: a runtime extension is refused (`outside_audience`), as
  `staffed` is. A record keeps no hours of its own: a job's time is the entries against it, read
  through the host (`staffing.time.forRecord`, step 7), never a "time spent" record and never in a
  `rec_*` view.
- **Operations** (tool-only, audience staff, `mcp.expose: false`): `staffing.time.clockIn`,
  `clockOut`, `enter`, `edit`, `withdraw` (writes) and `staffing.time.mine` (read). Each is a
  person's own act on their own entries: refused unless the calling tool is `humanOnly` and the
  verified caller a person (an assistant or MCP is refused whatever is granted), and unless the
  business records time (Rostering's `recordsTime` setting, read through `staffing.settings` beside
  `enterDays`, 14, and `finishMissingHours`, 4; with no pack declaring it, nobody records). Someone
  else's entry is as if it were not there. Notes are redacted from the audit log, whose rows name
  the entry only.
- **Entering and correcting.** Time entered afterwards has finished, is at most 24 hours long,
  starts no more than `enterDays` back (by the organisation's local date), and is never in a locked
  pay period (the locked period's rule, `pay_period_locked`, checked by the operation; step 3 adds
  the triggers). A person corrects their own entry until it is approved: what it is against, the
  break, the note, and a finished entry's times; changing a clocked entry's times makes it
  `entered` (they are no longer the host's clock); a rejected entry corrected waits again. An open
  entry keeps the host's start and is finished by the clock, never inside a locked pay period. A
  person withdraws a waiting or rejected entry (deleted); an open one is finished first, unless
  its finish is missing. Every correction, finish and withdrawal is guarded on the entry exactly
  as it was read, and fails whole (`core_staff_changed`) rather than answer a change that was not
  saved.
- **Finish missing** (the minute cron, `staffing.due`): an entry still open `finishMissingHours`
  after its shift's end, or 14 hours after its start with no shift (or a shift cancelled meanwhile),
  is marked `finish_missing` and its person told once ("Enter the time you finished", to them only).
  No finish is written; the clock can no longer finish it, and the person enters their real finish
  with `edit` however long ago it started (the days-back setting does not apply to it), or
  withdraws it, so an entry left open never stops them recording time again. Inside a locked pay
  period, whoever handles pay reopens it first (step 3 refuses a lock while an entry is open). At most 50 a tick; a quiet minute reads one indexed row and writes nothing.
- **Until step 2, every finished or entered entry waits.** Approval on a match with the roster and
  the approver's acts are step 2's; the columns are in place so it needs no migration.
  _Amended 2026-11-24 (stage 58 step 2, [ADR 0851](0851-differences-from-the-roster-and-approval-of-time.md)):_
  a finished, entered or corrected entry that matches the person's own live shift within the
  tolerance is now approved by the host; the rest wait. A start's proposal and the match read the
  shift's own time (its claim less its margins). Step 2 added one column, `reopened_why`
  (migration 1273).

## Consequences
- Rostering's tools, its settings (`recordsTime` and the numbers), labels and the screens are
  stage 58 steps 5 and 6; until then nothing outside tests calls these operations, and no business
  records time (`recordsTime` is off with no declaration).
- `staffing.due` answers `finishMissing` beside what it did before.
- Leaving (`leaveRoster`) does not yet mark an open entry finish missing: stage 58 step 4 amends
  `staffing/leaving.ts` with leave and does it there.
- The SDK's `staffing.settings` gains `recordsTime` (a boolean setting), `enterDays` and
  `finishMissingHours` (number settings), each `personApproves`.
- Jobs (stage 39) declares `workedOn` on its job and reads its time through the host; its spec must
  use this shape or amend it here.
