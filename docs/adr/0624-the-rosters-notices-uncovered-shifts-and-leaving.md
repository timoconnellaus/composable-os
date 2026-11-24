# ADR 0624: The roster's notices, uncovered shifts and leaving

Status: accepted, 2026-11-23 (stage 45, build step 3; amended in the review of PR #282 before
merge). Builds on ADRs [0621](0621-the-staffed-behaviour-and-the-time-claim.md),
[0622](0622-warnings-in-a-writes-answer.md) and
[0623](0623-offers-and-takes-the-race-and-the-cut-off.md); amends the deactivation of
`user.deactivate` ([ADR 0170](0170-automation-run-as-bindings.md)).

## Context
Stage 45's notifications table: a person is told when they are put on or taken off a shift, when
theirs changes time or is cancelled; rosterers are told of takes, lapses, leave over rostered
shifts, a pattern that could not be applied, and uncovered shifts (daily, and at once). A shift's
person may be written by many paths (a person editing a class's coach, a rosterer's assign, the
assistant once approved, an import, a change of a series), so a notice sent by one tool would miss
the others, and a write of many shifts at once must not send one notice per shift. A staff member
leaving must not leave their future classes pointing at an account that cannot work them.

## Decision
- **The notices are the host's**, worked out for every write of a staffed record
  (`packages/core/src/staffing/changes.ts`): its open offer is cancelled when the shift goes to
  someone else, is cancelled or removed (the offerer told); the person put on or taken off it by
  someone else is told, and the person whose shift changed time, was cancelled or removed; a live
  shift inside the uncovered window (14 days) left with nobody on it is told to the rosterers.
  Nobody is told what they did themselves. A series' generation (the host making records) tells
  nobody here; a date it leaves uncovered because its pattern person is already on another shift
  tells the rosterers the date and why.
- **One notice per person per call.** The notices of one operation are gathered and written once
  its handler has queued everything (a new `beforeCommit` on the handler's context, in the same
  batch): a person whose call touched one shift gets that shift's notice; one whose call touched
  several (a change of a series' coach or time, a cancelled day of it, an import, a staff
  `record.import`) gets one summary: how many, the first and last dates, and the shifts listed.
  So a rosterer changing a series' coach tells the coach taken off and the coach put on once each.
- **They are in-app notices** (`system.message`, delivered by email as each person's preferences
  say). A notice about someone's availability (leave added over rostered shifts) is `humanOnly`
  ([ADR 0643](0643-health-answers-read-by-a-person-with-the-permission-every-read-audited.md)): no
  AI acting for a rosterer lists it, and it never carries the note.
- **Leave stays with people** (decided in review): a leave's note is redacted from the audit log
  (`redact: ["note"]`), which an admin's MCP client could read; other people's leave
  (`staffing.awayList` for anyone but yourself) is read only through a tool a person calls
  (`humanOnly`), never by an assistant acting for a rosterer. A person's own list is theirs
  through any tool.
- **Uncovered shifts**: `staffing.uncovered` (a rosterer's read) and the minute cron's
  `staffing.due`, which once a local day from 07:00 (guess) tells the rosterers every live shift
  with nobody on it in the window. It runs once a day by a row in `core_staff_run` (migration
  0812), and reads through each staffed object's index on its person field, so a long covered
  history is never read. `staffing.due`, like `recurring.generate` (fixed in the same review), is
  a `hostStep`: never queued for review under an approval floor on automation writes.
- **Who may roster** is one function (`staffing/rosterers.ts`: `mayRoster`, `rosterers`): admins
  until stage 45 step 4 gives it to `rostering:manage`.
- **Leaving**: `user.deactivate` answers with the person's future shifts (from their claims, read
  by account and end, never their past) and the series whose pattern names them, in or out of the
  Trash, and is refused (`deactivate_confirm`, with the count and the list) until confirmed with
  that count, as `recurring.change` is. Confirmed, in the same batch: every pattern naming them
  names nobody (its version bumped, so a generation planned before fails), every shift of theirs
  that has not started names nobody, their claims are released by the triggers, their open offers
  and those named to them are cancelled (whoever offered one to them is told), and the rosterers
  are told with the list. Past shifts and shifts under way keep them. Reactivating puts nothing
  back.
- **Exactly what was read is changed, recorded and marked.** The shifts are cleared by the ids read
  and only while they still name the person; each statement is followed by a guard on how many
  rows it changed (`core_staff_guard`, migration 0812: `changes()` against the count read), and a
  guard first counts their future shifts again, so a class the series made meanwhile or a shift
  changed meanwhile fails the whole batch (`roster_changed`: try again) rather than leave a row
  cleared without its audit row and mark, or recorded without being cleared. The changes are the
  host's (their marks, ADR 0590). Someone on more future shifts than one call reads (2,000) is
  refused (`deactivate_too_many`) rather than partly cleared.
- **A deactivated account is never put on a new shift by the host**: a date whose series still
  names someone who left (a series restored from the Trash, or set back by hand) is made with
  nobody on it.

## Consequences
- A notice reaches the same people whatever wrote the shift; a new write path that goes through
  the record operations tells them without more code, once per person per call.
- Stage 33's import writes as staff or the host; either way each person hears once per batch.
- The feed's revocation on leaving and `staffing.forget` are later steps (5 and 4).

## Amended 2026-11-24 (stage 45 step 7, ADR 0629; a coordinator's decision)

An assistant or MCP acting for a rosterer no longer gets `unavailable` warnings from `staffing.week`, `staffing.check` or `staffing.candidates` (or from Rostering's tools over them): it learns clashes and qualifications, never who is away. A person at the screen sees them as before.

## Amended 2026-11-24 (stage 58 step 4, ADR 0853)

Leaving also cancels the leaver's leave requests still waiting, and marks a time entry they left
open finish missing (no finish is written; ADR 0850), in `user.deactivate`'s batch
(`staffing/leaving.ts`); approved leave, approved entries and leave balances stay as they are, as
payroll records.
Approving leave takes the person off each covered shift that has not started and offers it, and
the rosterers get this ADR's notice of someone away over their shifts with which were offered and
which nobody could be. See
[ADR 0853](0853-leave-types-requests-the-balance-ledger-and-approved-leave-as-unavailability.md).
