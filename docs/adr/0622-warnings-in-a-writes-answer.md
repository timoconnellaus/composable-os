# ADR 0622: Warnings in a write's answer; qualifications and unavailability as core tables

Status: accepted, 2026-11-23 (stage 45, build step 2). Builds on
[ADR 0621](0621-the-staffed-behaviour-and-the-time-claim.md) (`staffed`).

## Context
Decision 9 of stage 45's interview: warn, do not refuse, when someone is rostered while away, is not
qualified for the class type, or a class has no coach. Only double-booking is refused (ADR 0621).
A warning must reach whoever writes (a person on the web, the assistant's approval card, an import)
the same way, and be kept with the write. Who may do which work and who is away are about staff
accounts, which extensions cannot read, and are personal: a record in a `rec_*` view would be read
by every member with `records:read`, by SQL, exports and the assistant.

## Decision
- **Three warnings**, worked out by the host for a live shift whenever a write creates it, restores
  it, or changes its person, time, kind or state (a write of its title warns of nothing):
  - `uncovered`: nobody on it, and it starts within the uncovered window (14 days from now; the
    Rostering pack's setting from step 4);
  - `not_qualified`: its person's account is not qualified for its kind (no row in
    `core_staff_qualification`, or the kind record is in the Trash or gone), and only when the
    business has set qualifications up for that kind's object (at least one row for it): a
    business that marks nobody is not warned about everybody;
  - `unavailable`: its person's account has an unavailability overlapping it (`core_staff_away`),
    told only to the person themselves and to whoever may roster (admins until stage 45 step 4's
    `rostering:manage`). Anyone else's write is answered without it: other staff never learn that
    someone is away.
  A person with no account (a visiting coach) has neither of the last two.
- **A write is made with its warnings, never refused for them.** `record.create` and
  `record.update` answer `warnings` (each a code, the record, the account and a message; no note of
  anyone's leave), and the write's audit row records them in its summary (each record's codes and
  account). A host's write (the series' generation) is made with them silently.
- **`staffing.check { object, id, account? }`** (read, tool-only, ADR 0621) is the dry run: the
  warnings the record would be made with, as it is or with `account` as its person (null:
  nobody), and the other shift it would clash with. The same code answers both, so the check and
  the write cannot disagree.
- **Qualifications and unavailability are core tables** (migration 0811), in no `rec_*` view:
  `core_staff_qualification` (account, kind object, kind record, who set it, when) and
  `core_staff_away` (a one-off range as instants with the zone it was given in, or a regular rule:
  weekdays, a local start and end time, from and until dates, a zone). A regular rule is checked by
  wall clock on the fly, so 13:00 is 13:00 across a clock change; an end at or before its start is
  the next day's. Nothing is generated. **Nobody is qualified by default**: rostering someone never
  marked qualified warns, so the first roster works before the matrix is filled. Step 3 adds the
  operations that write them (`staffing.qualify`, `staffing.away`, `staffing.back`), and who reads
  them.

## Consequences
- Until step 3 nothing writes the two tables, so no shift answers `not_qualified` or
  `unavailable` yet. Step 3 keeps both rules (no `not_qualified` before a kind's object has any
  qualification; `unavailable` only to the person and rosterers).
- A warning names that someone is away, never why: no note reaches the write's caller.
- An assistant acting for an admin is answered as the admin is.
- The approval card can show the warnings from the dry run's answer (stage 45 step 7 shows them).

## Amended 2026-11-23 (stage 45 step 3)
The writers and readers are built (ADRs [0623](0623-offers-and-takes-the-race-and-the-cut-off.md)
and [0624](0624-the-rosters-notices-uncovered-shifts-and-leaving.md)), all tool-only:
`staffing.qualify` (a rosterer; applied by a person) and `staffing.qualifications` (a rosterer's,
or one's own); `staffing.away`, `staffing.back` (a person's own act, for themselves, or a rosterer
for anyone) and `staffing.awayList` (one's own, or a rosterer's; with the note). Someone else's
unavailability is answered as not there. Both rules above are kept. The unavailability read for a
warning is now bounded: only one-off times ending after the shift starts and regular rules not
ended before it are read, never a person's past leave. A take is held to the qualification
strictly (a row must exist), unlike the warning. "Who may roster" is one function
(`staffing/rosterers.ts`), the admins until step 4.

## Amended 2026-11-24 (stage 45 step 7, ADR 0629; a coordinator's decision)

An assistant or MCP acting for a rosterer no longer gets `unavailable` warnings from `staffing.week`, `staffing.check` or `staffing.candidates` (or from Rostering's tools over them): it learns clashes and qualifications, never who is away. A person at the screen sees them as before.
