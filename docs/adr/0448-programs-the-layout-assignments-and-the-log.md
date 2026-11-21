# ADR 0448: Programs: the layout, assignments and their sessions, and the log

Status: accepted, 2026-11-21 (stage 41, build steps 2 and 3). Builds on ADRs
[0445](0445-the-document-field.md), [0446](0446-publishable-without-its-public-half.md) and
[0447](0447-the-signed-in-scope.md).

## Context
The stage 41 interview settled one layout for every program, real dated sessions from a start
date, and a log of every set against its target that the gym's data comes from. The coordinator's
design kept the layout one document and the log a row per set. This records how the pack's spine
is built: the objects, the layout schema, how an assignment pins a version and makes its sessions,
how logging finds a target, and the statement budget of making sessions.

## Decision

**Six objects** (`packs/programs/index.ts`): `exercise` (the bank), `program` (title, kind, theme,
guidance for coaches, and `layout`, a document; `publishable` over all five), `classtype`,
`assignment`, `session` and `log`. Object names are lowercase (`programs.classtype`).

**The layout** (`packs/programs/layout.ts`, `LAYOUT_SCHEMA`) is weeks (at most 52) of sessions (at
most 14 a week; a name, a focus, a day of the week 1 to 7, a warm-up, notes) of blocks (a label,
rounds, notes; labels unique) of items (labels unique). An item is a union on `kind`: `all`, for
everyone, one to three bank exercises done together; or `levels`, one to five levels with unique
numbers from 1 to 5 (so 1 and 5 alone is valid), each a union on `mode`: `one` exercise,
`together` or `alternatives` (two or three). An exercise in a layout is a prescription: a `ref` to
a live `programs.exercise`, one to twelve typed sets, and a note in the coach's words. A set is a
union on `kind`: `reps` (reps, a top of range, load, tempo of four characters from `0-9X`, rest),
`time` (seconds, load, rest) or `hold` (seconds each, holds, load, rest). Load is kilograms in
quarters; RPE is the log's, not the layout's. A note on a session, block or item is `private`
unless `members: true`. The schema is the whole rule: the builder, an import, the assistant and
the API all write through it.

**An assignment pins a version and carries its sessions' plans.** `x.programs.assign { programId,
personId | classTypeId, startDate }` (staff, `bulk-write`) reads the program's current version
(`record.version`; refused while it has none), creates the assignment in `generating` with the
version number, and makes one session per session of the layout, dated `start + 7(w - 1) + (day -
1)`. A session record carries its own `plan`: the session of the layout as that version had it, a
document checked against `SESSION_PLAN_SCHEMA` (the session node and the definitions it uses). So
"what does this person do today" is one read, an edit or a new version changes no session, and a
member reads a class's plan through the seam with the coach's notes taken out. The assignment moves
to `active` last, from `generating` (ADR 0437). A call that stopped part-way is finished by calling
again: the assignment still `generating` for that program, version, person or class type and
start date is found, and the sessions already made are found by their `key` (assignment, week,
place) and skipped. A repeated cycle is a new assignment.

**The statement budget.** Sessions are made with `record.createMany` (a new core operation,
`bulk-write`, `bulkSize` the count): up to 50 records of one object in one batch, all or none,
each through `record.create`'s own code. Measured in workerd's D1 (`packages/core/test/
create-many.test.ts`): **4 statements per session** (the record, its first state's history row,
its search document's delete and insert), so a batch of 50 is the call's own few statements plus
200, about a fifth of D1's 1,000 queries per invocation. `assign` writes in batches of 50: the
largest layout (52 weeks of 14, 728 sessions) is 15 batches, and `apps/runner/test/programs.test.ts`
assigns it. Under the balanced policy an extension's bulk write of up to 100 records applies
without review, so a pack's batches of 50 do too; under cautious they wait for a person.

**The log is one row per set.** `log`: person (its customer), session, assignment, exercise (a
relation, so a set can be charted by exercise), item, set number, level taken, date, target reps,
seconds and load, actual reps, seconds and load, RPE, a note, and who recorded it (`recordedAs`
self or staff, `recordedBy` and `recordedByName` for a coach). `x.programs.logAdd` takes the
item, the exercise when the item has more than one, the level when it has levels, the set number
and what was done; it reads the session (as the caller, so a member reads only their own or their
class types' sessions), finds the prescription in its plan and copies the target from that set.
A member's set is written with `my.create`, which makes it theirs and refuses a session they
cannot see (ADR 0447); a coach's with `record.create`, the person being the session's, or the
member they name on a class session. RPE is 1 to 10 in halves and actuals are bounded, by the
tool's input.

**Reading and progress are worked out in the host from records the caller may see.**
`today`, `sessionGet` and `classToday` read sessions with their plans, the bank exercises they use,
and the person's sets of each from before (the last time). `history` is a person's sets of one
exercise and their bests (heaviest load, most reps, longest time); `progress` the same per exercise
and, per assignment, sessions planned, done and skipped. Each reads at most 2,000 sets and says
when it stopped. A member calls them as themselves and never names a person; staff name one.

**Who calls what.** Every tool but `assign` is open to staff and customers; their risks are `read`
or `write`. `logAdd` widens `programs.log`'s customer fields to the ones the tool fills from the
plan; `sessionComplete` widens `programs.session`'s `state` and `completedAt`. A class's sessions
are not a member's to mark. Every staff member sees every client's training until stage 14a.

## Why
- Copying a session's plan onto the session, rather than reading the version each time, keeps a
  member's reads to their own records through the seam (a program is staff-only, and a version is
  not a record), and makes "nothing changes for people already assigned" true by construction.
- Generating sessions is the pack composing the host's writes, not a behaviour: the dates come
  from the layout's own days, which no generic `recurring` declaration knows about. The host's part
  is that every session is validated and written as any record is, in batches it can afford.
- A target copied from the plan into each logged set keeps the log self-contained: the data says
  what was asked and what was done, whatever happens to the program afterwards.

## Consequences
- A session's plan repeats its part of the layout: a 52-week, 14-a-week program assigned to one
  person stores 728 plans. Each plan is at most 64 KB; in practice a few kilobytes.
- Logging a set reads the session and writes the set: two operations. Reading today reads the
  sessions, the bank and the person's earlier sets of those exercises: three or four reads.
- Not built here (stage 41 steps 4 to 7): the Training dashboard, saved views, the Person page's
  tab, the hooks and blocks (the builder, the bank, today and session, history and progress, class
  today, the coach's client view), the assistant's draft, the text import and Ghetto.
