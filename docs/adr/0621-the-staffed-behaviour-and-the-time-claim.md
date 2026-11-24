# ADR 0621: The `staffed` behaviour and the time claim

Status: accepted, 2026-11-23 (stage 45, build step 2). Is stage 31b's "time-range claim". Builds on
ADRs [0404](0404-behaviours-are-the-vocabulary.md) (behaviours are the vocabulary),
[0500](0500-recurring-a-weekly-rule-in-local-time.md) and
[0620](0620-field-level-exceptions-in-recurring.md) (`recurring` and its field exceptions) and
[0502](0502-declared-uniqueness.md) (declared uniqueness). Amends
[ADR 0414](0414-pack-tools-run-as-the-customer.md) (a staff operation may be tool-only).

## Context
Stage 45 rosters people onto shifts: a coach on each class, a cleaner on a duty, later a coach on an
appointment (31b). Decision 9 of its interview: warn about the rest, but **refuse one person on two
overlapping shifts**. That must hold for every writer (a person editing a class's coach, the
assistant once approved, MCP, an import, the host's generation and later the take of an offer) and
under races (two takes at once both read "free"). A read before a write is not a guarantee, and a
rule in one pack's tool binds no other writer (ADRs 0404 and 0405). Classes, duties and
appointments live in different objects, possibly different packs, so no pack can hold the rule.

## Decision
- **A platform behaviour, `staffed`**, declared on an object (shipped packs and the org's own
  extensions only; a runtime extension is refused as `outside_audience`: who works when feeds pay):
  `staffed: { who, starts, ends, zone?, kind, live, place?, pattern?, payBefore?, payAfter? }`
  (`packages/sdk/src/staffed.ts`). `who` is a `user` field (`{ field: "staff" }`) or a relation to
  another of the extension's objects whose user field holds the account (`{ field: "coach",
  account: "user" }`: a class's coach profile). `live` are the states in which the record is a
  shift. A profile with no account (a visiting coach) covers the shift for members and claims no
  one's time. `place`, `pattern` and the pay minutes are checked now and read by later steps.
- **The time claim is a core table kept by the database** (`core_staff_time`, migration 0811): one
  row per live, covered shift whose person has an account, with the shift's own time as whole unix
  seconds, half-open (06:00 to 07:00 and 07:00 to 08:00 do not clash). `BEFORE INSERT` and
  `BEFORE UPDATE` triggers refuse a row that overlaps another of the same account
  (`core_staff_double_booked`, answered `conflict`, `rule: "double_booked"`). D1 runs one batch at
  a time, so of two batches that would double-book one person, one fails whole. The claims are
  indexed by account and **end** (`account_id, ends, starts`), so the check reads only the claims
  that end after the new one starts: a coach's years of past classes are never read. Claims are
  always derived in order of start, so re-deriving many at once (a profile given another account)
  reads a few rows each.
- **A live shift ends after it starts.** One that does not would claim nothing and could sit
  inside another of its person's shifts, so it is refused: as a validation error at write time
  (`rule: "staffed_time"`), and by the trigger for any other writer (`core_staff_time_backwards`).
- **The claims are derived by triggers on the staffed object's own table**, which the schema
  reconciler builds (never a migration: no `x_*` table is touched by one), not written by the record
  operations. `AFTER INSERT`, `AFTER UPDATE OF` every column the claim reads plus the id, and
  `AFTER DELETE` re-derive the row's claim from the row as stored; on the account holder's table
  (the coach profile), an insert, a delete, or a change of its account or id re-derives every
  shift naming it. So every statement that writes a shift writes its claim in the same statement,
  whatever wrote it: create, edit, move, cancel, the Trash and a restore, an erase, a merge, the
  CSV import, a series' generation and changes, `recurring.follow`, and any later path. Writing the
  claim in each operation's batch by hand was rejected: it would be right only on the paths someone
  remembered, and wrong on the next one written.
- **Statement shapes.** D1 runs with recursive triggers off, so the rows an `INSERT OR REPLACE` or
  `UPDATE OR REPLACE` deletes fire no delete trigger. The overlap checks are therefore on insert
  and on every update (a REPLACE and an upsert are inserts first; an id change is an update), each
  leaving out only the row's own key, which such a statement replaces. A row a REPLACE deletes
  silently leaves its claim behind, which can only refuse more, never let a double-booking
  through, and the next reconcile of the extension heals it (it derives every claim again from the
  rows, so a claim whose row is gone is not written back). Tests write every shape to the shift's
  table, the holder's table and the claims.
- **The claim is the shift's own time.** Preparation and pack-down minutes are for pay only
  (`payBefore`, `payAfter`); counting them here would refuse a coach two classes back to back.
- **A read before the write** (`packages/core/src/staffing/`) names the other shift in the common
  case (the trigger's message is fixed) and keeps what the batch queued; the trigger refuses the
  race it cannot see, with a generic message. A restore into a time since taken is refused the same
  way.
- **The host's generation never fails on a clash**: a date whose pattern person is already on an
  overlapping shift is made with nobody on it, and that empty person is kept as the record's own
  (a field exception, ADR 0620), so the series does not write the clash back. Telling rosterers is
  step 3's (its notices).
- **A series change that would double-book someone on any date is refused whole**, naming the
  dates (`details.dates`); the rosterer settles those dates first (a coach swapped by hand there is
  an exception the change leaves alone).
- **A coach profile given another account** is checked set-based, in at most three reads however
  many classes it has (its shifts against the new account's claims, then against each other), so
  a profile with thousands of classes stays far inside D1's 1,000 queries per invocation.
- **A coach profile in the Trash still names its classes' account**, so trashing one is refused
  while a live shift that has not ended names it (`rule: "staffed_holder"`, with how many): a
  person reassigns them or leaves them with nobody first. With only past shifts it may be trashed,
  and their claims stay (they were worked).
- **Installing the declaration over records that already clash** (imported data, an upgrade) is
  refused by the reconcile before the triggers are built (`staffed_conflict`) when any of the
  clashing shifts has not ended, naming each pair by title and start; two profiles sharing an
  account are refused by the profile's declared uniqueness. Clashes between shifts that have both
  ended are not refused: the later shift of each is left without a claim, and the plan says which
  (`skip_claims`). The check is one pass per account in order of start (a running latest end),
  never a pair of every two shifts. A shipped extension whose upgrade is refused keeps running as
  it was, and the admins are told in the product (a notification, once per release of it), not
  only in a log. Each reconcile of the extension drops the triggers and builds them again, derives
  every claim again, and drops the claims of an object that no longer declares it.
- **Bookings' class declares it** (`who: { field: "coach", account: "user" }`, `kind: "classType"`,
  `live: ["scheduled", "done"]`: a class done still counts for pay, a cancelled one does not), and
  `bookings.coach` declares `user` unique, so an account has at most one coach profile.
- **The host's staffing operations are tool-only.** `staffing.check` (ADR 0622) is the first: a
  shipped pack's tool calls it with the caller the runtime verified; a person, MCP or the assistant
  calling it directly is answered as an unknown operation, and it is left out of the HTTP contract.
  ADR 0414's `toolOnly` now applies to a staff-only operation too (the pipeline refuses a call that
  is not a tool's run); the handler also refuses a runtime extension's tool.

## Consequences
- The rule holds for a writer that does not exist yet (stage 33's import, step 3's take, 31b's
  appointments): it declares `staffed` or writes a staffed object's table, and the claim follows.
- A batch is checked statement by statement: two shifts of one person swapped in time within one
  batch are refused even though the end state is fine (the first move overlaps the other's old
  time). A series change moves each date by its own rule, so its records do not swap; a person
  swapping two of their own shifts moves one out of the way first.
- The claim reads a coach profile's account whether or not the profile is in the Trash (the class
  still names it); a profile deleted for good, or given another id, leaves its classes claiming
  nobody.
- A datetime the database cannot read (never written by the record operations, which check ISO
  8601) claims nothing.
- Stage 33's import (the move from the old booking system) must run the same check before it
  writes: refuse, or import uncovered, what would clash and has not ended.

## Amended 2026-11-23 (review of PR #279, before merge)
The index by end, claims derived in order of start, the one-pass clash check, the set-based check
of a profile's new account, refusing a backwards shift, refusing to trash a profile on shifts not
yet ended, not refusing an upgrade over past clashes (skipped and reported), and telling admins of
a refused upgrade were added in review (above). Migration 0811 was edited in place (unmerged); a
local or preview database that applied the earlier version must be rebuilt.
- `staffName` (the name kept on a shift as it was) is not in this step; step 3 or 4 adds it with
  `staffing.forget`.

## Amended 2026-11-24 (stage 49 step 1, ADR 0760)
The claim is no longer always the shift's own time: a shift may declare minutes kept free before
and after it (`claimBefore`, `claimAfter`, read from its kind), which widen its claim and are kept
on it (migration 1091); classes declare none, so back to back stays allowed. A shift may also
require an account (`account: "required"`): one naming a profile with no account is refused while
it has not ended. See [ADR 0760](0760-claim-margins-and-a-required-account-on-staffed.md).
