# ADR 0651: Checklists on their own: a schedule, a run a day, and who may do it

Status: accepted, 2026-11-24 (a follow-on to stage 45 step 4b and [ADR 0650](0650-checklists-templates-runs-ticks-and-a-done-run-kept-unchanged.md);
the owner's decision of 2026-11-24 that the first client starts with checklists alone: opening,
closing and cleaning, with the roster and hours later). Builds on ADRs
[0404](0404-behaviours-are-the-vocabulary.md) (rules live in the host),
[0436](0436-pack-roles-and-the-door-role.md) and [0600](0600-a-pack-role-and-its-grants-add-up.md)
(pack roles and grants), [0449](0449-permissions-granted-one-by-one.md) (`checklists:write`,
grantable), [0660](0660-pack-screens-in-the-admin.md) (pack screens) and
[0871](0871-day-windows-in-the-business-zone.md) (the business's day). With
[ADR 0652](0652-a-tool-for-every-staff-account-and-a-tool-held-to-a-core-permission.md) (the two
tool declarations this needs). Migration 0816.

Amended 2026-11-24, after the review of #383 (migration 0817):
- **The database holds when, too.** A tick on an open day run is refused unless its `ticked_at` is
  inside the run's day, and a day run is closed as missed only with a `closed_at` at or after its
  `closes`, by nobody (no closer, person or why): `core_checklist_window`. The time judged is the
  one the writer records, as every time in the host is the caller's clock (the minute cron is run
  with a clock in tests): a run closed at noon by a host bug or a script is refused; a writer that
  records a false time is not, as for any time it writes.
- **A day's run is the date in its record.** Today's list and the history find runs by the date in
  `record_id` (read by the opening index two days either side), not by where a run's window falls
  in the zone now, so a run made before the business's zone was moved is still its date's (as a
  tick finds it): never shown as not started while every tick on it is refused.
- **Who it can be for** (`checklist.whoChoices`, which names the grantable permissions, otherwise
  an admin's to read) is held to `checklists:write`, a person's own read, off MCP.
- **The refusals are answered as refusals**: `core_checklist_not_allowed` (a race: an account's role
  changed between the host's read and the write) is `forbidden`, `core_checklist_window` a conflict.
- A tick and a finish answer the run as committed (the run the minute cron made meanwhile, and
  finished only if this call finished it); the people told of a missed day are read as managers in
  the query, not after a limit; the history counts the steps ticked not done, so a day done with
  every step "not done, with why" shows as such.
- Left as they were, consistent with ADR 0650: changing someone else's tick is a manager's, judged
  by the host on its read (two first ticks at once both stand, the later counting); erasing a staff
  account does not yet clear its ticks (ADR 0650's open item); a door account reaches Today's
  checklists for everyone on staff (ADR 0652, for the owner to confirm).

## Context
Until now a checklist run existed only on a record that declares `checklists`: Rostering's duty
shift. A business with no roster (the first client: an opening, a closing and a cleaning checklist,
the roster to come later) had templates and nowhere to tick them. ADR 0650 left "a checklist with no
shift (a daily opening check on its own)" as a follow-on; this is it. Its two host rules must hold
here too, for every actor and every write path: **only someone allowed ticks**, and **a finished
run never changes**.

## Decision

**A template may have a standing schedule** (migration 0816, columns of `core_checklist`): the ISO
weekdays it is due (`days`, 1 Monday to 7 Sunday), a local time it is due by (`due_by`, optional),
and who may do it (`doers_kind`, `doers_value`):
- `staff`: every active staff account that may write (admins, members, and accounts with a pack
  role); a viewer may not (it cannot write);
- `role`: the accounts with that role (`admin`, `member`) or that pack role (`rostering.team`,
  `bookings.coach`: a cleaner's or a coach's account), checked to be one an admin can give now;
- `grant`: the accounts granted that permission one by one (any `user.grantablePermissions` entry).
It is written with the template (`checklist.save`'s `schedule`, null to remove it, left out to keep
it), so the assistant may draft a scheduled checklist and a person who holds `checklists:write`
approves it before any run is made (decision 25, unchanged). `checklist.whoChoices` gives the form
the roles and grants to pick from, naming no account. Settings → Checklists has a "Done on its own"
part: the days, the due time and who.

**Each due day has one run**, in the same `core_checklist_run` table as a shift's, so every trigger
of migration 0815 holds for it unchanged: `object_type` is `checklist.day` and `record_id`
`<template>:<YYYY-MM-DD>`, so the table's own `UNIQUE (object_type, record_id)` makes it one a day,
ever. The day is the business's, in its time zone (`localDay` of `time/local.ts`, ADR 0871): the run
opens at the start of that local day and closes at the start of the next (23 or 25 hours across a
change of clocks), with **no grace**. It copies the template's name, steps and version, and also
**who may do it** and its due time (`doers_kind`, `doers_value`, `due_at`, migration 0816), so a
template changed or retargeted later changes no run already made. It is nobody's own
(`account_id` null) while open. The minute cron (`checklist.due`, the same two steps) makes today's
run of every active scheduled template due today with one to 50 steps (at most 200 a minute, bound
as JSON in statements of at most 256 KiB, as a shift's are); the first tick makes it if the cron has
not yet. Only today's is ever made: a day passed with no run (the schedule set later, the template
inactive that day) has none, and nothing is made ahead.

**Ticking** (`checklist.dayTick`): on its own day only, while open. Anyone who may do it ticks any
step as themselves, done (with a note where the step asks), not done (with why) or cleared; every
tick is kept, the latest counts, and a step someone else ticked is changed only by someone who
manages checklists (as ADR 0650's rule for a rosterer). **Whoever ticks the last step finishes
it**: the tick's batch also marks the run done, by the ticker, for the person it was for, with a
guard judged in the batch after the tick (`every step's latest tick is not a clear`), so two people
ticking the last two steps at once still finish it and nobody finishes it early. A checklist with
optional steps left is finished by hand once every required step is ticked
(`checklist.dayDone`, guarded the same way). A run not finished when its day ends is closed by the
cron as **missed** (the required steps nobody ticked kept), and those who manage checklists are told
in one person-only notice a minute naming each checklist, its day and the steps not done (never a
note). A finished or missed run never changes.

**Who manages checklists** is the permission that already writes them, `checklists:write`: an
active admin, or an account granted it one by one; never a pack role (which holds no core
permission). They see every day of every scheduled checklist (`checklist.days`, at most 62 days and
500 runs; and `checklist.day`, any day's steps and ticks), and may tick or finish one **for**
someone who may do it, naming them and saying why: kept as "ticked by X for Y", the finish as
closed by X for Y with why (ADR 0650's on-behalf, with a manager in the rosterer's place). Someone
who manages checklists but may not do this one only ticks for someone (`checklist_for_whom`).

**Who reads**: today's run, its steps and who ticked each and when, by anyone who may do it
(`checklist.today`, `checklist.day`); what someone wrote on a tick only by its author and those who
manage checklists (`withheld` for anyone else, as ADR 0650); any day's, and how each day went, only
by those who manage checklists. To anyone else a day is not there (`not_found`), not even that it
was missed. Every operation is tool-only and a person's own at the screen (`humanOnly` tools, the
verified caller a person): no assistant, MCP client or automation reads how a day went or ticks one.

**The database holds it for every writer** (migration 0816, beside 0815's triggers):
- a day run is inserted with who may do it, and a shift's run without; a day run's who, due time,
  window and day are fixed; it is nobody's own while open; it is never cancelled;
- a tick on a day run is refused unless it is for someone who may do it (the same rule as the host's,
  read from `core_user`: active, a person, not a support account, not a viewer, and holding the role,
  pack role or grant the run names), and, on someone's behalf, made by someone who manages checklists
  (`core_checklist_not_allowed`);
- a day run is marked done only by someone who may do it, for themselves, or by someone who manages
  checklists for someone who may, with why; and 0815's trigger still refuses done with a required
  step unticked. A closed run refuses every change first (`core_checklist_closed`).

**Kept apart from a shift's checklist.** Rostering's operations never see a day run:
`checklist.forRecord`, `.tick` and `.complete` find no record for `checklist.day`, the rosterers'
`checklist.runs` lists shifts' runs only, and `checklist.correct` answers a day run "not found". The
cron's shift steps read declared objects only. A duty's checklist is unchanged, and one template can
be both a duty's and scheduled on its own: each gives its own runs.

**Where the screens live: a small pack of its own, Daily checklists** (`packs/dailychecks`). The
operations and rules are core, but a screen in the admin is a shipped pack's (ADR 0660), and putting
these in Rostering would leave a business that has not installed it without them (the first client's
case). The base layer has no screen declaration. So the pack is two screens (Today's checklists,
`today` and `tick`; Checklist history, `history`) under a "Checklists" navigation group, a native
block for the app, its headless hooks, and five tools that ask the host and decide nothing; it
requires nothing and declares no objects, roles or grants. Today's checklists is listed for every
staff account that may write, pack roles included (each sees only what they may do: possibly
nothing, said as "Nothing is due for you today"); the history only for those who manage checklists.

**Cost.** Every read is set-based. Measured D1 statements per call at the largest input (200
scheduled checklists of 50 long steps; ceiling 250, D1 allows 1,000): the cron making 200 days, 30;
closing 200 (and making the next day's), 52; Today's checklists listing them all for a manager, 21;
the history over 62 days, 17.

## Consequences
- A business can run its opening, closing and cleaning checklists with no roster, from the admin
  on the web (Today's checklists, Checklist history) and from the app (the native block, over the
  role client or the staff client).
- A cleaner's or a coach's fixed-role account reaches today's checklists meant for its role with no
  grant (ADR 0652's `anyStaff`), and nothing else it did not reach before.
- With Rostering installed nothing about a duty's checklist changes.
- Who may do a day's checklist is fixed for that day: a template retargeted at noon applies from
  tomorrow (the day's run was made at the start of the day, or by its first tick).
- The cron reads the scheduled templates (one statement) and today's runs every minute there is a
  scheduled one; a quiet minute writes nothing.

## Left out
Corrections beside a day run (ADR 0650's are a rosterer's, about a shift); several runs a day (an
opening and a closing are two checklists); a schedule by date (every other week, the first of the
month), closures and public holidays; a reminder before the due time; ticking offline; an export
of runs; photos (decision 22, unchanged); a step missed twice raising a task. Not yet tried on a
live host, and the app's screen not yet tried on a phone.

## Proof
`apps/runner/test/checklists-standalone.test.ts` (the schedule and its checks, the assistant's draft
waiting for a person, a run a day as the template was, anyone ticking and the last tick finishing it,
a finish by hand with optional steps left, who may do it by role, grant and pack role, a viewer, the
triggers refusing every other writer, an AI refused, ticking for someone with why, a day missed and
told, the history, Rostering installed, and the statement counts);
`packs/dailychecks/test/dailychecks.test.ts`; `packages/core/test/screens.test.ts`;
`packages/core/test/any-staff-tools.test.ts`; `apps/app/e2e/checklists-today.spec.ts`.
