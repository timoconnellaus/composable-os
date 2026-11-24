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
its search document's delete and insert), and 3 for the call itself: a batch of one is 7
statements and a batch of 50 is 203, about a fifth of D1's 1,000 queries per invocation. `assign` writes in batches of 50: the
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
tool's input and by the fields' own bounds below.

**The numbers are bounded by the host.** Number fields have `min`, `max` and `step` (added to the
platform at review, held for every actor, the import and the dry run): RPE 1 to 10 in halves; set
number 1 to 30 and level 1 to 5, whole; reps 0 to 999 and seconds 0 to 7,200, whole; load 0 to
1,000 kg in quarters; a session's week 1 to 52 and day 1 to 7. A staff `record.update` cannot store
an RPE of 50.

**Erasing a person (ADR 0320).** The erase finds Programs' records through the schema, as for
every extension, in the erase's own batch:
- **Their logged sets are deleted.** A set's person is required: it exists only to be someone's.
  Keeping sets in anonymous form was considered for the gym's numbers and not done: the set's note
  is the person's own words, which no rule can show does not identify them, and its session and
  assignment tie it to the rest of their schedule. Keeping them would need an object to declare
  what an erase keeps, field by field; that is later work if a gym asks.
- **Their assignments and sessions are kept with no person:** the relation is cleared, and their
  text fields and plans lose the person's identifying terms and names (an assignment's title "…
  for Ada" becomes "… for [erased]"). What is left is a program version given from a date and
  which sessions were done, which says nothing about who. A gym's planned-and-done counts keep
  them.
- **Documents are scrubbed inside, not dropped** (`scrubDocument`, `erase-stores.ts`): every
  string in a document field that is their address, phone or id becomes `[erased]`, and others
  lose their terms and names, so the document keeps its shape and still reads as its schema.
  Published versions in `core_publish_version` that mention their terms are scrubbed the same way,
  keeping their numbers.
Proof: `apps/runner/test/programs.test.ts`, "erasing a person".

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

## Amendment, 2026-11-21 (stage 41, steps 4 to 6)
- **Names a member reads without a second lookup.** A logged set stores `exerciseName` and a
  session `programTitle` and `classTypeName`, copied when the tools write them, as the target is.
  A rename in the bank or the program does not rewrite what was done.
- **Staff side:** the Training dashboard, six saved views, the Person page's Training tab and two
  panels are declarations over the `rec_*` views; nothing in the host is Programs-specific.
- **Working copies without the builder.** `x.programs.draft` and `x.programs.importText` (staff)
  create a program from a brief or from coaches' shorthand, and never publish it. They pick
  exercises from the bank by name and list what they could not read rather than guess; the record
  write still checks the schema and every ref. The draft asks for the `extract` model role and
  reads the brief itself when no model is configured.

## Amendment, 2026-11-24 (ADR 0889): the coach role
"Every staff member sees every client's training until stage 14a" still holds for staff; a staff
account given Programs' pack role `programs.coach` sees only its own clients': an assignment gains
`coach` (a user field a person approves: anyone else's write waits for one) and declares a `team`, and the role
reaches assignments, sessions and logged sets only for the People an active assignment names it
coach of. The read and log tools declare `programs:coach`. See
[ADR 0889](0889-a-pack-role-limited-to-the-people-its-holder-looks-after.md).

## Amendment, 2026-11-24 (past sessions in the app)
- **A person's past sessions are read through the reads each caller already has,** not a new
  tool: a member's `my.list` (the seam: their own sessions and sets only) and a coach's
  `record.list` naming the client. Sets done and planned are worked out in the pack's client
  (`sessionSets`): an item with levels counts the level the person logged at, or its first level;
  alternatives the one they did, or the first. That count is a display, not a rule, so it is not
  the host's; the host's progress numbers (`progress`) are unchanged.
- **Only personal sessions are a person's history.** A class session is shared by every member of
  the class type; listing the class sessions a member logged on needs a read of their sets first,
  which is later work if a gym asks.
- **Correcting a set is `logUpdate` as it was:** nothing new is allowed. A page of 20 sessions
  reads the sessions and their sets in two to six calls (an `in` filter of at most 20 ids).

## Amendment, 2026-11-24 (stage 41: a safe, repeatable import)
Found while moving the first client's programs onto the platform: running `x.programs.importText`
twice made two programs, and a logged set must name a session, which only an assignment made, so
past training had nowhere to go.
- **`cos programs import <folder>`** (`packages/create-composable-os/src/programs-import/`), on the
  import door (ADR 0470) and shaped as `cos courses import` is: exercises, class types, programs in
  the shorthand (read by the pack's own `readProgramText`, exported from its public entry) and
  past training, checked whole before signing in, every batch dry-run on the host, then written in
  order with `record.import`, each batch naming what the one before made by id. A shorthand line
  the reader cannot use stops the run with its file and line: an import that silently dropped a
  coach's line would be wrong in a way nobody sees. `docs/importing.md`, Programs, is the format;
  `skills/import-programs` the order.
- **Past sessions.** A session is an assignment's, or one brought in from before:
  `programs.session.assignment` is no longer required, and `requireOneOf: [["assignment",
  "source"]]` holds the rule in the host. An imported session is done, has no assignment, plan or
  kind (it was never planned here, so the dashboard's planned and done leave it out), and says
  `source: import`; its sets say `source: import` too. A member reads their own as the rest of
  their training and cannot log on one (no plan). Past training is personal: a class's past
  attendance is the booking import's.
- **What the import door writes starts nothing** (ADR 0470, amended): no automation, not even one
  that takes bulk changes, and no notification.
- **`x.programs.importText` with a key** makes one program per key: `importKey` and
  `importedHash` (read-only, the tool's own) on `programs.program`, and a declared unique rule on
  `importKey` (ADR 0502), so two runs at once cannot make two. Run again, the program is updated
  while it still holds what the import last wrote, left unchanged when the text is the same, and
  reported as a conflict, untouched, when someone has edited it since: the door's rule, kept by
  the tool because a tool's own calls are not a person's and cannot use `record.import`. The hash
  is of the title, kind, guidance and layout, canonical (keys in order), so publishing or a
  change elsewhere on the record is not an edit. `dryRun` reads and checks the text against the
  layout schema (`faults`, with their paths) and says what would happen, writing nothing. A
  `Kind:` line says the program's kind.
- **An item may have an exercise for everyone and levels**: the `levels` item takes optional
  `exercises` beside its levels (a hold everyone does after the level they took). Logging one
  needs no level; with the level taken, the set keeps it. The builder, the session blocks and the
  hooks (`At.everyone`) show and edit them; the shorthand writes it as an exercise on the item's
  line with level lines under it.

### Fixed at review (2026-11-24)
- **One set is never written over another.** Set numbers left out, and duplicates, are worked out
  after each row's exercise (a key or a name) and person (either of their addresses) are known,
  by the same identity the set's import key is made from. Two rows that are one set are a problem
  with both lines. A key longer than the door takes (200), or the same key twice in a batch, is a
  problem with its line, and the run stops at that batch; a session's name is at most 100
  characters.
- **A member cannot reopen an imported session:** the move back to planned is `staffOnly` while
  the formula `imported` (`source` is `import`) is true.
- **`x.programs.importText`'s check and write are two calls.** It reads the program, compares the
  hash, then updates it; `record.update` has no "unchanged since" guard for a record without
  states, so a coach's save landing between the two (milliseconds) would be overwritten. A save
  before the run is never overwritten, and two runs cannot make two programs (the unique rule).
  Closing the window needs a version guard on `record.update` for any object: platform work, not
  this step's.

