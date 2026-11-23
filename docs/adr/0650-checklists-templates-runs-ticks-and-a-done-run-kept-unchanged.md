# ADR 0650: Checklists: templates, runs, ticks, and a done run kept unchanged

Status: accepted, 2026-11-24 (stage 45, build step 4b; decisions 15 and 22 to 25 of the stage's
interview). Builds on ADRs [0404](0404-behaviours-are-the-vocabulary.md) and
[0405](0405-skills-ship-with-the-platform.md) (a rule that must hold for every actor is the host's),
[0621](0621-the-staffed-behaviour-and-the-time-claim.md) (tool-only staffing operations),
[0625](0625-restricted-pack-permissions.md) (the verified caller, `calledBy`),
[0626](0626-the-rostering-pack-and-bookings-additions.md) (Rostering's duty and tools) and
[0629](0629-the-rosters-screens-role-clients-with-grants-and-the-roster-import.md) (the blocks and
their `shiftExtra` slot). Amends ADR [0449](0449-permissions-granted-one-by-one.md): a new grantable
core permission, `checklists:write`. Migration 0815.

## Context
Decision 15: a duty shift may carry a checklist its person ticks off ("a bit like a fast-food
chain runs its back of house"), built as a small reusable piece, not a cleaning feature. Decisions
22 to 25: no photos; how a checklist went is read by the person and by people who roster, not all
staff; someone who rosters may tick on someone's behalf, with a reason, recorded as "ticked by X for
Y"; the assistant may draft a template, which a person approves before it is used. The spec's two
rules, "only the right person ticks" and "a completed run never changes", must hold for every
actor, so they are the host's: a pack tool cannot hold them, and D1 runs with `recursive_triggers`
off, so a `REPLACE` deletes a row without firing a delete trigger.

## Decision

**Core tables** (migration 0815), in no `rec_*` view, so no dashboard, `query.sql`, `export.csv` or
the assistant's record reads reach them:

| Table | What |
| --- | --- |
| `core_checklist` | A template: name, purpose, active, a version counter, who wrote it and when |
| `core_checklist_step` | Its steps as they are now, in order: text, required, asks for a note |
| `core_checklist_run` | A run on one record: the template's id, version, name and steps copied as JSON, its person, opens and closes (unix seconds), state (`open`, `done`, `missed`, `cancelled`), when and by whom its record was ended after it opened, who closed it and why, the missed required steps |
| `core_checklist_tick` | Every tick of a run's steps, insert-only: done, not done with why, or cleared; a note; who ticked it and for whom; on someone's behalf and why. The latest of a step counts |
| `core_checklist_note` | A correction someone who rosters adds beside a closed run |

The fifth table is a deviation from the spec's four: the spec says a correction is "a note added to
the run by a rosterer, kept beside it", which needs somewhere to live that is not the closed run.

**A run copies its template.** When a run is made it copies the template's name and steps; the
template's version counter (bumped by a change of its name or steps) is recorded on the run. A
template changed later changes no run already made. We chose copying over versioned step rows: the
run is whole on its own and its steps are guarded by the same trigger as the rest of it.

**One run per record, ever** (`UNIQUE (object_type, record_id)`). A run is made by the minute cron
once a live record with a usable template (active, 1 to 50 steps) is within a day of opening (a
guess), or by the first tick if that comes sooner, only from an active checklist whose holder (the
duty) is not in the Trash. A shift with no checklist has no run. A shift restored after its run's
close keeps that closed run and gets no new one.

**Whose run it is** is the record's person now: the host keeps it current while the run is open
(the cron, and every tick and done). A shift reassigned mid-run is continued by its new person, who
sees which steps are done and by whom but not the earlier person's notes or reasons, and cannot
change or clear a tick someone else made (only someone who rosters can, `checklist_not_your_tick`);
the earlier person keeps reading their own ticks. The person is fixed when the run closes. **When it may be ticked**: from the record's start until its end and a grace of
2 hours (the spec's guess), read from the record as it is now, so a shift moved moves its window. A
record that is not live (cancelled, in the Trash) takes no ticks; one with nobody on it neither.

**Closing.** The person marks it done, or someone who rosters for them, with why; the database
refuses `done` unless every required step's latest tick is done or not done with why. A step that
asks for a note is not ticked done without one (refused by the operation and by the tick's
trigger). **Every tick is kept**: a later tick of a step (by the person, or by someone who rosters
for them) is a new row and the latest counts; a clear is a `cleared` tick. Earlier ticks are history
read by those who roster and by their authors. After its close and grace the cron closes an open
run: **missed** when its record is live, or when the record left its live states after the run
opened by someone who does not roster, keeping the positions of the required steps nobody ticked,
and the rosterers are told in one person-only notice per minute that names the shift, its person
and the required steps not done (never a note); **cancelled** when its record left its live states
before the run opened, or was ended by someone who rosters or by the host (who is kept as the run's
`closed_by`). An open run nobody has ticked whose record now names another checklist (or none) is
removed and remade, **only before its window opens**: once open, a run keeps the checklist it opened
with.

**Who may change what a run hangs on** (where a pack declares who rosters, by every write path, as
ADRs 0626 and 0627 hold who works a shift and when): a write of a field a `checklists` declaration
names as its template (a duty's `checklist`) is a rosterer's, and an AI's change of it is approved
only by a rosterer; cancelling, putting in the Trash or removing a shift that has started is a
rosterer's, and an AI never does it (`person_applies`), so the person on a shift cannot make a
checklist disappear before it is missed. Every such end of a record is marked on its open, opened
run with who did it, which decides missed or cancelled at its close.

**A closed run never changes**, for every writer and statement shape. Triggers refuse: inserting a
run over any existing one (by id or record) or a closed one; any change of a closed run; changing an
open run's record, template, version, name, steps or made time; deleting a closed or ticked run;
inserting a tick on a run that is not open, or over an existing tick's id (a `REPLACE`); any change
or removal of a tick, on an open run or a closed one; any change or removal of a correction.
Mapped to `checklist_closed`, `checklist_fixed`, `checklist_incomplete` and
`checklist_note_needed`. **No host step can fail for ever on them**: the cron inserts runs only
`WHERE NOT EXISTS` a run for the record, removes only open runs with no tick (in the `WHERE`), and
closes with a guard that fails the batch if one closed meanwhile (a person's done), so the next
minute looks again without it. The run table has no foreign key to records, so a Trash purge,
erase or merge of a shift is never refused by it; the pay lock's triggers are on the shift tables
and the checklist writes none of them; deactivation and generation never touch the run tables.

**Who reads a run**: while it is open, the record's person now; once closed, the person it closed
for (`account_id`), never whoever is on the shift later; anyone who made a tick on it (their own
ticks' words only); and people who roster (`isRosterer`: admins, and accounts granted `rostering:manage`). To anyone else
it is answered as not there (`not_found`), not even that it was missed. **Never an AI**: every
checklist tool is `humanOnly`, and each operation also checks that the verified caller
(`calledBy.actor`) is a person. The roster (`staffing.week`) gives everyone a shift's checklist
name, and its state (not started, in progress, done, missed, cancelled) only to its person and
people who roster, at the screen (null otherwise, and for any AI).

**Templates** are not personal: every staff account reads them (`checklist.list`, `checklist.get`).
`checklist.save` needs `checklists:write`, a new core permission admins hold and an admin may grant
one by one (ADR 0449 amended). It is `alwaysReview` for the assistant and MCP, and approving it
needs a person who holds `checklists:write` (approval.ts): a checklist staff are asked to follow is
always one a person approved (decision 25). Settings → Checklists is the core admin screen for it,
open to every staff account; a member without the permission sees the form and the host refuses
the save (the browser session cannot see grants).

**The field type and the declaration.** A `checklist` field names a template by id; only an active
one may be written. Rostering's `duty.checklist` is one, `personApproves`. An object declares
`checklists: { template, who, opens, closes, live }`: the checklist field (its own, or
`relation.field` through a relation to another object of its extension), the user field of whose
run it is, the datetime fields it opens and closes at, and the states it applies in. Rostering's
shift declares `{ template: "duty.checklist", who: "staff", opens: "startsAt", closes: "endsAt",
live: ["scheduled"] }`. Shipped packs and the org's own extensions only; a runtime extension
declaring it is refused (`outside_audience`).

**Operations and tools.** Tool-only host operations, as the roster's: `checklist.forRecord` (a
shift's checklist, its run or a preview of its steps, whether the caller may tick now and for
whom), `checklist.tick`, `checklist.complete`, `checklist.correct`, `checklist.runs` (the
rosterers' view by checklist and date, at most 62 days and 500 runs) and `checklist.due` (the
minute cron, as the host). Rostering's tools: the team's `checklist`, `tick`, `checklistDone`
(`rostering:team`, `rostering:roster`) and the rosterers' `checklistRuns`, `checklistCorrect`
(`rostering:manage`, restricted). Ticking for someone is the team's tool too: the host decides,
from the caller's standing, whether it is their own or on someone's behalf.

**Private text.** A step's note, why it was not done, why it was ticked or marked done for someone,
and a correction's text are redacted from the audit log (the tool's and the operation's `redact`);
the writes answer without them, so no stored idempotent reply holds them; they are never in a
notice or an error. A tick's words are read only by its author and those who roster. The audit
rows of the checklist operations (`auditForPeople`) and of every `humanOnly` extension tool are
never listed to an AI actor (`audit.list`), and a tick's audit summary names its run and step, not
how it went. The blocks keep them in component state only, send them through
`forgetAfter`, read runs with `gcTime: 0`, and clear them on `pagehide` and a bfcache restore, and
in the app when it leaves the foreground.

**The blocks** (ADR 0629's slot): `rostering-checklist` (web: `ShiftChecklist` for `my-shifts`'
`shiftExtra`, fetched only when opened; and `MyShiftsWithChecklist`), `rostering-native-checklist`
(the app), the week grid's checklist badge, and `rostering-checklists` (the rosterers' view, with
corrections). Each host refusal has its own state.

**Cost.** Every read is set-based: per declaring object one read of its records with their
template, one of the runs, one of the ticks, one of the names; nothing per step or per shift. The
cron runs in two steps, each its own batch and only when it has work (a quiet minute writes
nothing): closing (one update of the runs following their record, one close of the missed and one
of the cancelled, one removal) and making (new runs bound as JSON in statements of at most 256 KiB
each, so 200 runs of a 50-step checklist never pass D1's limit on a bound value); a failure of one
never holds the other back. At most 200 runs a minute per object. Measured D1 statements per call at the largest input (ceiling
250, D1 allows 1,000): the cron making 400 runs' first 200, 10; the cron closing 200, 16; `week`
over 62 days with 400 shifts with checklists, 30; `checklist` of a 50-step run, 19;
`checklistRuns`, 17.

## Consequences
- Any pack can give its records a checklist by declaring `checklists` and a `checklist` field; the
  rules come with it.
- A run reflects the template as it was. To change what today's shift asks, change the duty's
  checklist before anyone ticks it (an untouched open run is remade).
- The person and rosterers read how it went; nobody else, and no AI, does. An assistant can draft a
  template; it cannot read a run or tick.
- A run cancelled by its shift's cancellation stays cancelled if the shift comes back after its
  close.
- **Known gap** (ADR 0629's open item): Rostering's web blocks still mount only on the host app's
  development page (`/blocks`); the product's admin cannot yet show a pack's own screens to staff.
  Settings → Checklists is real admin UI.

- **A pack disabled** leaves its open runs as they are: its objects leave the field registry, so the
  cron neither ticks nor closes them; enabled again, they close by the rules above (a run past its
  close and grace then is missed, and the rosterers are told).
- **`staffing.forget`** (not built) will need a guarded way to clear notes, reasons and account ids
  on closed runs and ticks: the immutability triggers refuse any change, so it needs its own
  trigger exception (a reviewed migration), not a workaround.

## Left out (the spec's follow-ons)
Photos on a step (decision 22); a step missed twice raising a task; checklists on a class type, an
event or a new member's first week; a second person signing a run off; steps that depend on an
answer; scores; ticking offline; a checklist with no shift; an export of runs.

## Proof
`apps/runner/test/rostering-checklists.test.ts` (templates and who writes them, the assistant's
draft waiting for a person, a run as the template was, who ticks, on someone's behalf, notes, done
final under every statement shape, missed and told, who reads, the shift reassigned, moved,
cancelled, in the Trash and its person deactivated mid-run, the operations' own guards through
another shipped pack's tools, and the statement counts); `apps/runner/test/rostering.test.ts` (the
team role's and the restricted tools' walks); `packs/rostering/test/rostering.test.ts`;
`packages/core/test/visibility-one-seam.test.ts`; `apps/app/e2e/rostering-checklists.spec.ts`.
