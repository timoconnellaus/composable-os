# Stage 41: Programs

Read first: [`AGENTS.md`](../../AGENTS.md), [`docs/architecture.md`](../architecture.md) (Packs and
blocks, Behaviours), [`CONTEXT.md`](../../CONTEXT.md), ADRs
[0401](../adr/0401-platform-packs-screens.md) and
[0404](../adr/0404-behaviours-are-the-vocabulary.md), stages [22](22-customers-and-audiences.md),
[23](23-http-surface-and-typed-client.md), [24](24-client-apps.md) and [28](28-content.md)
(`publishable`), the skills in [`skills/`](../../skills/), and in Ghetto's repository
(`origin/main` of `~/repos/ghetto`): `src/programs/` (class programs: `types.ts`, `text.ts`,
`validate.ts`), `src/workouts/types.ts` and migrations `0011` to `0015` (client sessions and
logging), `mobile/` (Today, Workout, History, Progress).

Status: **spec agreed** (interview 2026-11-21). Builds on stages 22, 23, 24 and 28. The first client
is Ghetto Movement. Courses ([stage 42](../roadmap.md)) builds on this stage.

## Status

- **Step 1** — built — PR #162 — The structured document field, and `publishable` on a non-public
  object (see "As built (steps 1 to 3)" below)

- **Step 2** — built — PR #162 — The pack's objects and the layout schema; versions and assign

- **Step 3** — built — PR #162 — Logging, history and progress, with the isolation test

- **Step 4** — built — PR #170 — The dashboard, views and the Person tab (see "As built (steps 4
  to 6)" below)

- **Step 5** — built — PR #170 — Hooks, then the builder and the bank (web), then the native
  blocks

- **Step 6** — built — PR #170 — The assistant's draft and the text import

- **Step 7** — not built — needs: step 6, the first client — Ghetto: the app's Today, Workout,
  History and Progress on the pack; class programs moved in

Follow-ups since, each in its own "As built" section below: AI publish requests (PR #191), fast
logging on a phone (PR #377), past sessions in the app (PR #389), a safe, repeatable import
(PR #391), the coach role and class types for a member's client (PR #392).

## Goal

A gym keeps one bank of exercises and builds every program from it: the plan a coach runs a group
class from, the program written for one client, and the training sessions inside an online school.
All of them are the same thing, laid out the same way, built in the same builder. People record
what they did, set by set, against what was planned, and that record is data the gym uses.

## What exists today

- **On the platform:** nothing for programs. After stages 22 to 24, customers sign in, client apps
  call the host with types, and packs ship headless hooks and blocks. Extensions never ship staff
  UI: a pack's own screens are blocks in the company's client app (ADR 0401).
- **In Ghetto's prototype,** two shapes that do not meet. Class programs are sessions with a
  warm-up and lettered blocks (A, B) of items (A1, A2), each item with up to five levels, and
  targets written as shorthand (`x 5 (5050)`); they have versions and a shared draft, no weeks and
  no dates. Client programs are sessions of exercises from a small library with typed sets (kg,
  reps, seconds) and a log of target against actual with effort. The prototype tried the class
  shape for clients and dropped it because it had no typed sets.
- **Elsewhere:** programming lives in Word documents and spreadsheets. It is built from scratch
  here; nothing is carried over as it is.

## Decided at the interview (2026-11-21)

| Question | Decision |
| --- | --- |
| The four uses | **Online school:** laid out like a school, with classes (stage 42). **Private, semi-private and online private:** an ordinary program for one client, which they track. **Classes:** a program for a class type, as the prototype has |
| Where it starts from | Built from scratch: a full program builder and tracking. **The data will be used, so things are tracked properly** (weights, reps and so on) |
| An exercise carries | A name and a demo video; coaching cues; theme and level; equipment; easier and harder versions; body-area tags |
| Layout | **One layout for everything:** program, weeks, sessions, blocks, items. An item is an exercise from the bank with typed sets, and may have levels (classes use them) |
| Targets | **Structured** (sets, reps or time, tempo, rest, load), with a free-text note beside them for the coach's wording |
| Scheduling | **Real cycles and dated sessions.** A class program is assigned to a class type and a client program to a person, each with a start date |
| Who builds | Coaches. The assistant can draft a program from the bank for a coach to edit and approve |
| Who records | Clients log every set against its target, with effort. Class members can log the level they took and their numbers. Online students mark lessons and sessions done and can log sets. A coach can log for a client during a session |
| The gym TV | Stays Ghetto's own, and reads programs from the platform. It is Ghetto's work, in Ghetto's repository, not part of the pack |
| An online lesson | A video, and optionally a follow-along session from Programs that the student tracks (stage 42) |

## Scope: what the platform needs first

The manifest was written on paper first. What it could not express is this list.

- **A structured document field.** A field whose value is JSON checked against a schema the
  object declares, readable and filterable by path in `rec_*` views where the schema says so.
  Stage 28's `richText` is one fixed schema of this kind; this makes the kind general. A program's
  layout is one document, not five levels of records, so that a program is edited, versioned and
  copied whole.
- **`publishable` on a non-public object.** Stage 28 gives a working copy, versions and a publish
  move for content the public reads. A program uses the same behaviour with no public audience: a
  coach edits a working copy, publishes a version, and assignments follow a version.
- **A customer's own writes to a pack's object,** which stage 22 has (`my.create`, `my.update`
  through a pack tool). Logging uses it; nothing new is expected, and the build says so if it is.

## Scope: the Programs pack (`packs/programs`)

### Objects
| Object | What | Notes |
| --- | --- | --- |
| `programs.exercise` | Name, demo video (a link; a media item once stage 28 is in), cues, theme, level, equipment, body areas, how it is measured (`weight_reps`, `reps`, `time`, `hold`), easier and harder versions (relations to other exercises) | The bank. Staff write, customers read what a program of theirs uses |
| `programs.program` | Title, kind (`class`, `client`, `course`), theme, guidance for coaches, and **the layout** as a structured document | `publishable`: working copy, versions |
| `programs.assignment` | A published program version given to a **person** or to a **class type**, with a start date and an end | `customer: person` for a person's; class assignments are read by any signed-in member |
| `programs.session` | One dated session of an assignment: its date, its place in the layout, its state (planned, done, skipped) | Generated from the assignment's start date and the layout's weeks |
| `programs.log` | One set someone did: the person, the session, the item and exercise, the level taken, target and actual (load, reps, seconds), effort (RPE), a note, who recorded it | `customer: person`. The table the gym's data comes from: one row per set, with the exercise as a relation so it can be charted |
| `programs.classType` | Name, order | Seeded by the company (Mobility, Handstands and so on) |

### The layout document
- Program → **weeks** → **sessions** (a name, a focus, a warm-up) → **blocks** (a label, rounds,
  notes) → **items** (a label such as A1).
- An item names one or more **exercises from the bank**, each with **typed sets**: reps or seconds
  or a hold, load, tempo, rest. Beside the numbers, a free-text note keeps the coach's wording
  ("legs as straight as possible").
- An item may have **levels**, up to five and possibly sparse (only 1 and 5). Each level is one
  exercise, several done together, or alternatives. Without levels an item is for everyone.
- A note is for coaches only unless marked as shown to members.
- A cycle is the program's weeks. Repeating a cycle is a new assignment.

### Tools (operations)
- `programs.assign { programId, personId | classTypeId, startDate }` (staff): pins the published
  version and generates the dated sessions.
- `programs.today` and `programs.session.get` (customer): the caller's sessions for a date, with
  targets and their last numbers for each exercise. For a class type, `programs.class.today`
  (customer, staff).
- `programs.log.add`, `programs.log.update`, `programs.session.complete` (customer; staff for a
  named client): the host fills in who and when, and checks the item belongs to a session the
  person may log.
- `programs.history { exerciseId }` and `programs.progress` (customer; staff for a client): sets
  over time and bests, worked out in the host.
- `programs.draft { brief }` (staff): the assistant's draft, as a working copy for a coach to edit.
  It builds only from the bank and never publishes.
- `programs.import.text` (staff): turns pasted shorthand or a document's text into a working copy
  with structured targets, listing every line it could not read for the coach to fix.

### Staff side, from the host
- The bank, programs, assignments and logs in the admin with lists, record pages and saved views.
- A **Training** dashboard: sessions planned against done, sets logged by week, the most used
  exercises, clients with nothing logged in two weeks.
- A client's Person page gets a Training tab: their assignments, recent sessions and bests.

### Headless hooks and blocks
| Block | Skin | What |
| --- | --- | --- |
| Program builder | web | The coach's builder: weeks, sessions, blocks and items by drag and keyboard, exercises picked from the bank, typed sets, levels, notes, copy a week or a session, versions and publish |
| Exercise bank | web | Browse, add and edit exercises, with their easier and harder versions |
| Today and session | native, web | A person's session: targets, last time's numbers, log each set, rest timer, mark done |
| History and progress | native, web | Per exercise and per program |
| Class today | native, web | The class type's session with its levels, and logging the level taken |
| Coach's client view | web, native | A client's sessions and logs, and logging on their behalf |

## Out of scope
- The online school's courses, lessons and sales (stage 42).
- The gym TV. Ghetto's TV reads `programs.class.today` from its own code (Ghetto's repository).
- Linking sessions to the timetable and to bookings (stage 31).
- Video hosting. A demo video is a link, or a media item from stage 28.
- Chat between coach and client.
- Wearables, bar-speed devices and other automatic logging.
- Nutrition, body measurements, assessments and testing protocols.
- Selling a program by itself (stage 42 and `sellable`).

## Acceptance criteria
1. **Pack on the contract:** Programs is built only on the public contract and the typed client,
   passes `cos ext check` and `cos ext test`, and a product without it has none of its objects.
2. **One layout:** a class program with levels and a client program with typed sets are the same
   object and the same document schema, built in the same builder; a layout that breaks the schema
   is refused with the path of the fault.
3. **Versions:** editing a published program changes nothing for people already assigned until a
   new version is published and assigned; an old version can be read and restored.
4. **Assign:** assigning to a person and to a class type generates the right dated sessions from
   the start date; a person sees only their own assignments and sessions.
5. **Log:** a client logs sets against targets with effort; a coach logs for a client and the row
   says who recorded it; a class member logs a level and numbers on a class session; nobody can
   log on a session that is not theirs.
6. **Isolation:** the stage 22 isolation test covers assignments, sessions and logs.
7. **The data:** `rec_*` views give one row per logged set with exercise, person, date, target and
   actual; the dashboard's numbers match a fixture worked out by hand.
8. **Draft and import:** the assistant's draft uses only bank exercises and is never published
   without a person; pasted shorthand becomes structured targets, with unread lines listed.
9. **Blocks hold no rules:** the stage 24 lint passes for every block.
10. `pnpm lint typecheck test` and one e2e test per journey (a coach builds and assigns; a client
    logs a session) pass in CI. ADRs, `CONTEXT.md` (Exercise, Program, Assignment, Session, Log) and
    `docs/architecture.md` are updated.

## Dependencies
- Stages 22, 23 and 24, and stage 28 for `publishable`. If Programs is wanted before stage 28, the
  `publishable` behaviour is built here first, without its public half, and stage 28 adds that.

## Migrations and numbers
Migrations 0470 to 0479 (the structured document field only; the pack's tables come from the
reconciler). ADRs 0445 to 0449.

## Suggested build order
1. The structured document field, and `publishable` on a non-public object.
2. The pack's objects and the layout schema; versions and assign.
3. Logging, history and progress, with the isolation test.
4. The dashboard, views and the Person tab.
5. Hooks, then the builder and the bank (web), then the native blocks.
6. The assistant's draft and the text import.
7. Ghetto: the app's Today, Workout, History and Progress on the pack; class programs moved in.

Steps 1 to 3 are the spine: the document field every program is stored in, and the log everyone's
data lands in.

## Decided by the coordinator, open to override
- **The layout is one document, not records per level.** A program is edited, versioned and
  copied whole, and only what was done (the log) is a row per set.
- **The builder is a block in the company's web app,** not a screen in the host's admin, because
  extensions never ship staff UI (ADR 0401).
- **Every staff member sees every client's training** until stage 14a's roles and teams.
- **Programs can be built before stage 28** by bringing `publishable` forward.

## As built (steps 1 to 3, 2026-11-21)
- **The document field** ([ADR 0445](../adr/0445-the-document-field.md)): `type: "document"`
  with a declared `schema`, `maxBytes` and `paths`; a fault refused with its path for every actor,
  in the import and in the dry run; refs checked; paths are view columns; `private` parts removed
  for customers and the public.
- **`publishable` without its public half** ([ADR 0446](../adr/0446-publishable-without-its-public-half.md)):
  `core_publish_version` (migration 0470); `record.publish` (`records:publish`, admins by default,
  a person only), `record.versions`, `record.version`, `record.restoreVersion`. What stage 28 adds
  is listed in the ADR.
- **The signed-in scope** ([ADR 0447](../adr/0447-the-signed-in-scope.md)): "class assignments are
  read by any signed-in member" needed a scope the platform did not have. `signedIn` on an object;
  a customer's write may point a relation only at what they can see; `my.update` takes `from`.
  This answers the scope's third bullet: a customer's own writes needed two things new.
- **The pack** ([ADR 0448](../adr/0448-programs-the-layout-assignments-and-the-log.md)): objects
  `programs.exercise`, `program`, `classtype` (lowercase, as object names are), `assignment`,
  `session`, `log`; the layout schema; `record.createMany` for the dated sessions (4 statements a
  session, batches of 50). Tools are camelCase, so `programs.session.get` is
  `x.programs.sessionGet`, `programs.class.today` is `x.programs.classToday`, and so on.
- **Changed from the spec:** customers read the whole exercise bank (`signedIn` on every live
  exercise), not only "what a program of theirs uses": that narrower rule would be a scope through
  a document's refs, which the bank's contents (names, videos, cues) do not warrant. A session
  carries its own plan, copied from the assigned version, rather than reading the version. Load is
  in kilograms.
- **Added at review** ([ADR 0449](../adr/0449-permissions-granted-one-by-one.md)): a human admin grants
  `records:publish` (or `orders:refund`, or a pack tool's grantable permission) to a staff account,
  so a coach who is a member publishes. Number fields gained `min`, `max` and `step`, and the log
  uses them (RPE 1 to 10 in halves). Erasing a person deletes their logged sets and keeps their
  assignments and sessions with no person, documents and versions scrubbed inside (ADR 0448).

## As built (steps 4 to 6, 2026-11-21)
- **The Training dashboard** (`packs/programs/dashboards.ts`): sessions planned and done, sets
  logged and clients quiet for two weeks as numbers; planned against done and sets by week
  (weeks start on Monday); the most used exercises; the quiet clients as a table. All read the
  `rec_*` views over a date range. Its numbers are checked against a fixture worked out by hand
  (`apps/runner/test/programs-dashboard.test.ts`).
- **Saved views:** the bank by theme, published programs, active assignments, sessions this week
  and as a calendar, sets this week. **The Person page:** a Training tab (their logged sets) and
  Assignments and Sessions panels.
- **Grants on screen:** Settings > Users' permissions dialog (ADR 0455), which came from main
  while this was built; this stage's own checkboxes were dropped for it.
- **`user.me`** (staff, read): the caller's id, name, role, grants and resulting permissions, so a
  block offers Publish only to an account that holds it. The host still decides.
- **Hooks** (`@composable-os/pack-programs/client`): the screens' reads and writes, the layout's
  pure edits (`layoutEdits`: weeks, sessions, blocks, items, levels, prescriptions, sets, notes;
  copy, move, remove), a host fault mapped to its path, and a working copy that saves itself 0.8 s
  after the last edit and keeps what the host refused on screen with its fault.
- **Blocks** (twelve, `packs/programs/blocks/`): web: the program builder, the exercise bank,
  session, today, class today, progress and history, the coach's client view. Native: session,
  today, class today, progress, the coach's client view. The native rest timer's end is a prop
  (`onRestDone`), so the app gives it haptics. The block lint passes for all 27 blocks.
- **Member-facing names without a second lookup:** a logged set carries `exerciseName`, a session
  `programTitle` and `classTypeName`, set by the tools when written.
- **`x.programs.draft { brief }`** (staff): a working copy from a brief, never published. It reads
  the brief with the `extract` model role, or, with no model configured, by its own reading of the
  number of weeks, sessions a week and the words it names; it uses only bank exercises. **`x.programs.importText { text }`** (staff):
  coaches' shorthand (the shape of Ghetto Movement's prototype format: title, guidance, weeks,
  sessions by weekday, focus, warm-up, blocks with rounds, items with levels, `+` together,
  `|` alternatives, tempo in brackets, `*` notes for coaches, `TV:` notes for members) into a
  working copy with structured targets; every line it could not read is listed with its number
  and why. Both are written as any record is, so the schema still has the last word.
- **`/blocks` in development:** the app mounts any pack's web block where it sits
  (`/blocks?block=&component=&props=`), over the host's HTTP surface as whoever the cookie says.
  The e2e specs drive the builder and today blocks there; Ticketing's blocks can be mounted the
  same way (ADR 0424, amended).
- **Changed from the spec:** the tools are `x.programs.draft` and `x.programs.importText`
  (camelCase, as every tool is). The Person tab shows logged sets; assignments and sessions are
  its panels, and bests are the progress block's, not the admin's.

## As built: AI publish requests (2026-11-22)
Stage 28's criterion 12 applies to programs too (ADR 0480; ADR 0446 amended): the assistant may
ask for a program to be published (after `x.programs.draft`, for one), and the request always
waits for a person holding `records:publish`, who may be a coach granted it. The human-only
refusal is gone; the coaches' grants are unchanged. The pack changes no code: `usePublish` and
`usePublishOffered` are a person's controls. Proof: `apps/runner/test/programs-authoring.test.ts`
(the assistant's draft, its request, a person's approval) and `apps/runner/test/programs.test.ts`
(the assistant acting for a coach without the permission cannot even ask).

## As built: the coach role and class types for a member's client (2026-11-24)
- **The coach role** ([ADR 0889](../adr/0889-a-pack-role-limited-to-the-people-its-holder-looks-after.md)):
  `programs.coach`, declared in the pack: the tools `today`, `sessionGet`, `logAdd`, `logUpdate`,
  `sessionComplete`, `history` and `progress` (permission `programs:coach`), and reads of
  assignments and sessions, all limited to the People an active assignment names the account
  coach of (`coach` on the assignment, a person's choice (`personApproves`), the object's `team`). The
  platform gained a role's `looksAfter` and an object's `team`, held by the host on the role's
  reads and inside its tools. Its client (`roles.json`) backs `programs-native-coach-client` and
  the session screen for a client. Tests of what it must not reach: `apps/runner/test/programs-coach.test.ts`.
- **Class types for a member's client:** `useClassTypes` reads with `my.list` on a customer's
  client and `record.list` on staff's (a hook may name alternatives, `anyOf`, ADR 0453 amended), so
  `programs-native-class-today` is wired in a member's app as shipped.
- No migration (the coach field comes from the reconciler). ADR 0889, the last of the numbers 0870 to 0889 this work was given (they overlap blocks BV's and BW's ADR ranges).

## As built: past sessions in the app (2026-11-24)
- **The history blocks** (found while putting the first client's app on the platform: Progress
  showed each exercise's history, but nothing listed a person's past sessions): `programs-history`
  (web, `SessionHistory`) and `programs-native-history` (native, `HistoryScreen`) list a person's
  own sessions dated on or before `until` (their local today), newest first, 20 a page, each with
  its date, name and sets done of planned; one opened is read-only set by set (target beside what
  was done, who recorded it) and a logged set is corrected through `x.programs.logUpdate`, the
  rule the host already had (the numbers done, effort and the note; a member their own sets only;
  the target, the exercise and who recorded it never). The logic is in the pack's client
  (`loadPastSessions`, `sessionSets`, `plannedSets`, `correctionOf`; hooks `usePastSessions` over
  the member's `my.list`, `useClientPastSessions` over the staff's `record.list`); no new tool or
  permission. A page is at most 15 statements and 25 bound variables for a member or a coach
  (`apps/runner/test/programs-history.test.ts`); the member's e2e journey now corrects its set in
  the history. Only personal sessions are listed: a class session a member logged on is not
  (ADR 0448, amended).

## As built: a safe, repeatable import (2026-11-24)
Found while moving the first client's programs onto the platform, before step 7 (ADR 0448 and ADR
0470, amended; no migration, no new ADR number).
- **`cos programs import <folder> --host <url> [--dry-run]`**
  (`packages/create-composable-os/src/programs-import/`), shaped as `cos courses import`: reads
  `exercises.csv`, `classtypes.csv`, `programs/*.txt` (the shorthand) and `training.csv`, checks
  them before signing in, finds each training row's person by email, dry-runs every batch on the
  host, then writes class types, exercises, their easier and harder versions, programs (working
  copies), past sessions and their sets with `record.import`, import keys swapped for ids batch by
  batch. A shorthand line it cannot read stops the run with its file and line. Format:
  `docs/importing.md`, Programs; the order: `skills/import-programs/SKILL.md` (listed in
  `AGENTS.md`).
- **`x.programs.importText`** takes a `key` (one program per key, a declared unique rule; updated
  while it holds what the import last wrote, unchanged when the text is the same, a coach's edit
  kept and reported as a conflict) and `dryRun` (reads and checks against the layout schema,
  writes nothing, returns `faults` by path). A `Kind:` line names the kind.
- **`readProgramText`** (and the layout's types and schema) are exported from the pack's public
  entry, so the command reads programs with the tool's own reader.
- **Past sessions and their sets** can be imported: a session's assignment is no longer required
  (`requireOneOf` assignment or `source`); an imported session is done with no assignment or plan,
  and it and its sets say `source: import`. Whatever `record.import` writes starts no automation
  (not even an `includeBulk` one) and sends no notification (`origin.imported`).
- **An item with an exercise for everyone and levels**: the `levels` item takes optional
  `exercises`; logging one needs no level and keeps the level taken when given; the builder, the
  session blocks (web and native) and the hooks show and edit it; the shorthand reads it.
- **Proof:** `apps/app/test/programs-import.test.ts` (the command's engine against cos-app's real
  surface: a bad folder, a dry run, the import, a member's own reads, a re-run, a coach's edit
  kept, nothing started by an import, 25 sets in one batch of 105 statements and at most 20 bound
  values a statement), `apps/runner/test/programs-authoring.test.ts` (importText with a key and a
  dry run on the real host), `packs/programs/test/` (the reader, the schema, logging an item with
  both), `packages/create-composable-os/test/programs-import.test.ts` (the folder's problems by
  line) and `packages/core/test/automations.test.ts` (the imported origin).
- **Fixed at review:**
  - Set numbers and duplicates are now worked out by the identity a set's key is made from, so one
    set is never written over another.
  - A key that is too long, or the same key twice, is a problem with its line.
  - Session names are at most 100 characters.
  - Erase deletes the import door's kept keys and values that name the subject (ADR 0470).
  - A member cannot move an imported session back to planned.
  - `importText`'s read-then-write window is stated in ADR 0448, not closed.
- **Merged with past sessions in the app:**
  - The history blocks list imported sessions too: `kind` personal, or `source` import.
  - A session with no plan lists the sets logged on it.
  - An item with exercises for everyone lists theirs before the level's (`sessionSets`).

## As built: fast, lossless logging on a phone (2026-11-24)
Branch `feat/programs-fast-logging`; no migration, no new ADR number (ADRs 0414 and 0448 amended).
- **The session log** (`packs/programs/client/logging.ts`, exported from the headless entry):
  a pure reducer and one queue per session and person (`useSessionLog`, `useUnsavedSets`). One
  tap on a set's tick logs the numbers its row shows, a number still being typed included (every
  key press is a change); a tick of a done set takes it back; typing over a done set updates it.
  Saves go one at a time in order, a set changed meanwhile is sent again with its latest numbers,
  an answer or a read of the session never undoes a newer change, a failed save is kept, said and
  retried (the same idempotency key while the set is unchanged), a refused one is kept with the
  host's reason, and `flush` sends everything when the screen is left, the app goes to the
  background or the session is finished, saying when it could not. Carry forward: a set not done
  and not edited suggests (greyed) last time's numbers for the first set, else its target, and the
  set before's for a later one, so a change flows down; a field whose planned target differs from
  the set before's suggests its own target; an edited set is never overwritten. Unit tests:
  `packs/programs/test/logging.test.ts`.
- **The blocks:** `programs-native-session` and `programs-session` (web) are the workout logger
  on that logic: a tick per set, an optional effort tap, a rest timer from the set's rest (else
  `defaultRest`, 90 s), a start/stop timer on a timed set that fills its seconds and ticks it, an
  exercise folded when its last set is ticked, sets done of planned at the top, and finishing that
  says what was not ticked. `programs-native-today` says how many sets are not saved yet and
  flushes them when the app changes state. The native base `Screen` lets a tap land with the
  keyboard open (`keyboardShouldPersistTaps="handled"`). **Nothing was tried on a phone.**
- **The host:** `x.programs.logAdd` is idempotent per set (`setKey`, `unique` on person and set,
  ADR 0448 amended): a set saved again changes its row, and two saves at once leave one.
  `x.programs.logRemove` takes a set back (a retry changes nothing); a member's goes through
  the new tool-only `my.delete`, opened by `customer.delete: true` on the log (ADR 0414
  amended); a coach's is `record.delete`, which the approval policy may hold (`waiting`).
  The coach role (ADR 0889, amended) holds `logRemove`; its limit now checks a delete as it
  checks an update (a client's set, else not found) rather than refusing it.
  Proof: `apps/runner/test/programs-logging.test.ts` (once per set, at once too, taking back,
  and the session log driven against the host with a lost answer).
- **Changed from the brief:** "edited" is per set: the first edit of a set freezes every field
  it showed. A coach's un-tick under Balanced waits for a person's approval, because an
  extension's delete for staff is `destructive` and the policy is not this step's to loosen.
  What waits to be saved lives in memory: closing the app before it is sent loses it, and the
  app is told (`useUnsavedSets`) so it can say so.
