# Stage 59: Equipment

Read first: [`AGENTS.md`](../../AGENTS.md), [`docs/architecture.md`](../architecture.md),
[`CONTEXT.md`](../../CONTEXT.md) (Behaviour, Pack, Series, Checklist, Task, Pack role, Permission
grant, Restricted permission, Signed-in scope, Approved by a person), ADRs
[0402](../adr/0402-staff-and-customers.md) (opening an operation to customers is reviewed),
[0404](../adr/0404-behaviours-are-the-vocabulary.md) and
[0405](../adr/0405-skills-ship-with-the-platform.md) (rules are the host's; no workaround in pack
code), [0414](../adr/0414-pack-tools-run-as-the-customer.md) (`my.create`),
[0447](../adr/0447-the-signed-in-scope.md) (the signed-in scope, and a customer's write points only
at what they can see), [0500](../adr/0500-recurring-a-weekly-rule-in-local-time.md) and
[0620](../adr/0620-field-level-exceptions-in-recurring.md) (`recurring`),
[0502](../adr/0502-declared-uniqueness.md) (declared uniqueness),
[0513](../adr/0513-a-granted-holder-keeps-what-it-was-granted.md) and
[0552](../adr/0552-a-tool-a-person-approves.md) (a move only a tool makes; a tool a person
approves), [0600](../adr/0600-a-pack-role-and-its-grants-add-up.md) and
[0625](../adr/0625-restricted-pack-permissions.md) (grants on a pack role; restricted permissions),
[0650](../adr/0650-checklists-templates-runs-ticks-and-a-done-run-kept-unchanged.md) (checklists),
[0240](../adr/0240-imports-one-job-one-ledger-one-undo.md) (the admin's import); stages
[47](47-pack-screens.md) (staff screens declared by the pack) and [48](48-my-account.md) (what a
customer sees is a section of My account); `packages/sdk/src/recurring.ts`,
`packages/sdk/src/checklists.ts`, `packages/core/src/checklists/`,
`packages/core/src/operations/checklist.ts`, `packages/core/src/staffing/rosterers.ts`,
`packages/core/src/visibility/writes.ts`.

Status: **spec agreed** (2026-11-24). Every question was decided as best practice under the
owner's standing rule (best-practice answers are decided, not asked; the owner may override any of
them): decisions 1 to 10 below. Nothing waits for an interview. Roadmap stage 59; no issue.

- **Step 1 built** (P1, `feat/stage-59-interval`): `recurring`'s interval rule. The rule gains
  optional `unit` (a select of `week`, `month`, `year`), `every` (1 to 100), `day` (1 to 31, the
  month's last day when shorter), `month` (1 to 12) and `lengthDays` (a length in whole days,
  ending at the same wall-clock time); `day` and `month` default to the `from` date's. Dates are
  fixed on the calendar from `from` (weeks from its Monday-first week, months from its month,
  years from its year). Without `unit` a rule is weekly as before; `weekdays` is optional only
  when the unit cannot be `week`. Contract checks in `packages/sdk/src/recurring.ts`, the host's
  rule in `packages/core/src/recurring/index.ts`, tests in
  `packages/core/test/recurring-interval.test.ts` (Bookings', Rostering's and the weekly recurring
  suites unchanged and green). No migration; ADR 0860 (0500 amended). Left: the plan and
  maintenance objects that use it are step 4's.

## Goal

A business keeps a register of what it owns and must look after: a gym's treadmills, racks, cable
machines and sauna; a tradesperson's tools, test gear and vans. Each item has its details, where it
is, who supplied it, what it cost and when its warranty ends. Services and safety checks come round
on fixed dates and land on someone's list, with a checklist where the check needs one (Rostering's
checklists, reused) and a record of each kept unchanged. Staff and signed-in members report faults
from the floor, the app or the website; staff take a broken machine out of service in one tap and
members can see it is out of order. Every repair and service records its cost and supplier, so the
business sees what each item has cost it and when to replace it.

## Who it is for

**Gyms and studios first.** Dozens to a few hundred items in one or a few rooms. Cleaning and
safety checks daily or weekly (often already a Rostering duty), outside servicing quarterly or
yearly by a supplier's technician, faults noticed mostly by coaches and members, an "out of order"
sign on the machine, and warranty claims when a new machine breaks in its first year. The business
wants fewer members reporting the same broken bike twice, and evidence that it checks its
equipment, for its insurer.

**Trades and services next.** From the same pack: tools and test gear with periodic safety tests
(tested and tagged every few months), each pass or fail kept; who has a tool now; vans with a
registration renewal date and a service every so many months. Servicing by kilometres or engine
hours is later (decision 10). Equipment that belongs to customers (a boiler serviced each year) is
not this stage's (decision 9): it is booked work and invoices, stages 39 and 35.

## What exists today (from the code, checked 2026-11-24)

| Piece | Where | What it gives this stage |
| --- | --- | --- |
| `states` and the transition engine | `packages/sdk/src/states.ts`, `packages/core/src/records/states.ts` | Item, maintenance and fault states; moves by `staff`, `customer` or `host`, `requires` fields, and `tools` (a move only a named tool makes, for whoever called it: ADRs 0513, 0552) |
| `recurring` | `packages/sdk/src/recurring.ts`, `packages/core/src/recurring/index.ts` (ADRs 0500, 0620) | A series making dated records ahead, each once, keyed on the series and local date; one edited by hand left alone; closures; `ended`. **Weekly only**: a rule is weekdays, a time and a length in minutes (`ruleOf`, `occurrencesBetween`), the horizon at most 366 days (`RECURRING_HORIZON_MAX`). It cannot say "every 3 months" or "every year" |
| Checklists | `packages/sdk/src/checklists.ts`, `packages/core/src/checklists/` (`index.ts`, `runs.ts`, `writes.ts`), `packages/core/src/operations/checklist.ts`, migration `0815_checklists.sql` (ADR 0650) | Templates in Settings → Checklists; one run per record, ever, copied from the template a day before it opens; ticks kept; a done run never changes (database triggers); missed runs closed by the cron after the close and a 2-hour grace. The declaration (`template`, `who`, `opens`, `closes`, `live`) takes any object of a shipped pack. **But** who reads runs, ticks for someone, adds corrections, changes a record's template and is told of a missed run is "who rosters" everywhere (`isRosterer` and `rosterers` in `staffing/rosterers.ts`: the holders of a pack's `staffing.rosters` permission, else the admins). An equipment manager is not a rosterer |
| Rostering's duty checklists | `packs/rostering/index.ts` (`duty.checklist`) | Works today for "close-down clean of the gym floor", per shift, not per item. Stays |
| Tasks | `core_task`, `core_task_links` (migration `0004_activities_tasks.sql`), `packages/core/src/operations/task.ts` (`task.create`, `task.update`, `task.complete`), `records/links.ts` | A to-do with an assignee and due date, linked to any record |
| Automations | `packages/sdk/src/automation.ts` | `dateRelative`, `fieldChanged`, `record`, `schedule` triggers; steps that call operations and notify a user field or the admins |
| Customer writes | `packages/core/src/operations/my-write.ts` (ADR 0414), `customer` in `packages/sdk/src/manifest.ts` | A member's fault report through a pack tool, the reporter set by the host; their own reports read back with `my.list` |
| Signed-in scope | `signedIn: { read, when }` in `manifest.ts` (ADR 0447); `when` is one select field (`visibility/public.ts`) | Members read the items the business lists (name, place, state, since) with `my.list` |
| A customer's relation | `visibility/writes.ts` (ADR 0447) | Already refuses a member's write that points at a record they cannot see, for every pack. The draft's worry that `my.create` might not is unfounded |
| Media | `packages/core/src/operations/media.ts` | Staff upload photos (`image` field). Members cannot upload: issue [#117](https://github.com/timoconnellaus/composable-os/issues/117), and Forms' step 8 (stage 29) |
| Declared uniqueness | `packages/sdk/src/unique.ts` (ADR 0502) | An item's tag unique per business |
| Grants and pack roles | `packages/core/src/pack-roles.ts` (ADRs 0436, 0600, 0625) | A coach on `bookings.coach` or a cleaner on `rostering.team` granted "report faults" and nothing else |
| The admin's import | `import.records.*`, ADRs 0102 and 0240 (stage 12) | Loading a register from a spreadsheet, as one undoable unit. No pack-specific `cos` command is needed |
| Currency fields | `numberType("currency")` in `packages/core/src/fields/field-types.ts` | Costs as Deals' value is kept: a decimal in the base currency |
| Programs' `exercise.equipment` | `packs/programs/index.ts` | A text list of what an exercise needs. Not linked; left alone |

No pack today has a register of things, a fault report or a schedule longer than weekly.

## Decided on 2026-11-24

No interview: each was decided as best practice under the owner's standing rule; the owner may
override any of them.

| # | Decision |
| --- | --- |
| 1 | **How the first gym looks after its equipment today** was not asked: the assumptions in "Who it is for" stand, to be checked with the business during setup (categories, the job window, the out-of-order wording) |
| 2 | **Staff and members signed in to the app or website report faults.** Visitors without an account do not |
| 3 | **A safety-risk report:** a staff member reporting it may take the item out of use in the same step; a member's report only tells the manager, at once. Nothing is taken out automatically |
| 4 | **Any staff member may take an item out of use; only a manager puts it back** |
| 5 | **Members see a list of what is out of order**, in the app and on the website, for the items the business chooses to list |
| 6 | **Services and checks are on fixed dates** (every 3 months from 1 March, every Monday), whether or not the last one was late. Not counted from when the last one was done |
| 7 | **How an inspection went** (each step ticked, notes, anything not done) is read by the person who did it and the managers; every staff member sees only passed or failed and the date. As duty checklists already work |
| 8 | **Costs** (to buy and to repair) are seen by every staff member |
| 9 | **Only the business's own equipment** in this stage. Customers' equipment is later, with Jobs and Invoices |
| 10 | **No servicing by usage** (kilometres, hours) in the first version |

## The design in one page

- **A new pack, Equipment** (`packs/equipment`), needing no other pack. Four objects: **item**,
  **service plan**, **maintenance**, **fault**.
- **An item** is in service, out of service (why, since when) or retired. Its details: name,
  category, place, a **tag** (unique: the code on its sticker), make, model, serial, bought on,
  cost, supplier (an Organisation), warranty until, a photo, its **keeper** (who looks after it),
  who has it now (trades), whether it is **listed for members**, notes.
- **A service plan** is a series: "Quarterly service of the treadmills by the supplier", "Weekly
  safety check of the cable machines". It makes **maintenance** records ahead, as Rostering's duty
  series makes shifts. Platform work: `recurring` gains an **interval rule** (every N weeks on
  given weekdays, every N months on a day, every N years on a date), on fixed dates (decision 6).
- **A maintenance** is one dated piece of work on one item: a service, an inspection, a safety
  test or a repair, from a plan or made by hand. It has a window (starts, due by), who does it, the
  supplier if outside, the cost, the supplier's reference and the outcome.
- **Inspections reuse Rostering's checklists** (ADR 0650): when the plan names a checklist, each
  of its maintenance records carries it, and its **inspection record** is the checklist's run,
  ticked by its person and kept unchanged once done. No second checklist. Two platform changes
  make checklists general: **who oversees** a run becomes part of the declaration (Equipment's
  managers, not the rosterers), and **a move can need its checklist done** (an inspection cannot be
  marked done with its checklist untouched).
- **A fault** is a report that something is wrong, by staff (including a coach or a cleaner with a
  grant) or a signed-in member. It names the item, what is wrong and how bad. Managers or the
  item's keeper acknowledge it, fix it through a repair, or close it as not a fault or a duplicate.
  A member reads their own reports and their state in **My account** (stage 48: a section).
- **Out of service** is a move on the item: any staff with the report permission, with why; a
  staff reporter may make it in the same call as the report (decision 3). **Back in service** is
  a manager's, and a person's own (decision 4).
- **Members see** the listed items, and so what is out of order, through the signed-in scope:
  name, place, state, since. Nothing else (decision 5).
- **A Task per assigned maintenance**, made by the pack's automation, so people see it where they
  already look; finishing the maintenance completes it.
- **Costs** are recorded on the item (purchase) and on maintenance (each service or repair),
  read by all staff (decision 8): a cost history per item and a dashboard. Nothing here pays,
  charges or reaches the books.
- **Warranties**: a warranty end date; managers told 30 days before; a fault on an item under
  warranty says so.

### What was weighed and rejected

| Option | Why not |
| --- | --- |
| **Inspections as Rostering duties** | Works today with no platform work, but a run belongs to a shift, not an item: the register cannot show "last inspected, passed" per machine; it needs Rostering installed; trades do not roster. A gym that does its floor checks as a duty keeps doing so |
| **A checklist of Equipment's own** | The owner's note: reuse Rostering's (ADR 0650). Templates, runs, ticks, the kept record, privacy and missed runs are all there; only who oversees is hard-wired |
| **Maintenance as core Tasks with extra fields** | A task has two states and no window; adding fields to a base record for one pack changes every product. A Task is linked instead |
| **The next maintenance made when the last is done** (an automation) | "Made once, never twice, an edited one left alone, moved by a closure" is what `recurring` already holds for every writer, and the owner chose fixed dates (decision 6). Rules are the host's (ADR 0404) |
| **Out of service automatically on a safety-risk fault** | A member could set it off by mistake or on purpose (decision 3) |
| **Fault reports through a general form** | Forms (stage 29) is agreed but its door is for the public and for answers, not a record with an item and a state. A member's fault is a pack record a customer tool writes as theirs. A visitor's report can use stage 29's public-write door later |
| **Customer tools for the out-of-order list and "my reports"** | `my.list` already answers the signed-in scope and a customer's own records (ADR 0447). One customer tool is needed, the write |
| **Pass or fail on every checklist step** | A step is done (with a note) or not done (with why). The inspection's result is on the maintenance (passed, passed with faults, failed); each problem found is a fault. Step-level pass or fail waits for a business to ask |
| **A `cos equipment import` command** | The admin's import (stage 12) already loads records of any object from a spreadsheet as one undoable job |
| **The record called "job"** | Jobs (stage 39) owns "job" (work for a customer) and says to avoid "work order". Equipment's record is a **maintenance** |

## Platform work and pack work

| # | What | Kind | Why it cannot be pack code |
| --- | --- | --- | --- |
| P1 | `recurring` gains an **interval rule**: every N weeks on given weekdays, every N months on a day of the month (the last day when the month is shorter), every N years on a date; a time of day; the length may be given in days; anchored on the series' `from` date; the horizon still at most 366 days. Weekly series unchanged | Platform: `packages/sdk/src/recurring.ts`, `packages/core/src/recurring/index.ts`; ADR 0860 (amends 0500) | Generation is the host's, keyed on the series and local date |
| P2 | **Who oversees a checklist** becomes part of the `checklists` declaration: `oversees`, a restricted, grantable permission of the declaring pack. Overseers read runs, tick for someone with why, add corrections, change what a run hangs on and are told of missed runs. Without `oversees`, the rule is today's (who rosters, else the admins), so Rostering and Jobs behave as before | Platform: `packages/sdk/src/checklists.ts`, `packages/core/src/checklists/`, `operations/checklist.ts`; ADR 0861 (amends 0650) | Who reads a run is enforced in the host for every actor |
| P3 | **A move that needs its checklist done**: `checklists.requiredFor: ["done"]`: the transition engine refuses that move unless the record's run is done, in the same batch; when the run is closed missed, the host moves the record to a declared state (`onMissed: "missed"`) in the cron's batch | Platform: `packages/core/src/records/states.ts`, `checklists/`; ADR 0861 | Otherwise an inspection is marked done from the record page or a board with its checklist untouched |
| P4 | Wording of the shared checklist operations and errors: "the record" and "whoever oversees it", not only shifts and rosters | Platform (with P2) | Their descriptions are model-facing |
| K1 | The Equipment pack: objects, states, uniqueness, the plan's `recurring` (P1), the maintenance's `checklists` (P2, P3), permissions, settings, staff tools | Pack: `packs/equipment/index.ts`, `tools.ts`; ADR 0862 | |
| K2 | The member's report (one customer tool over `my.create`), the item's `signedIn` read, the fault's `customer` read; the My account section | Pack (opens a customer write and a signed-in read: reviewed, ADR 0402) | |
| K3 | Automations: a Task per assigned maintenance, overdue, warranty ending, a new fault told to the keeper | Pack: `packs/equipment/automations.ts` | |
| K4 | Dashboard and views: open faults, maintenance due and overdue, out of service, cost per item this year, warranties ending | Pack: `dashboards.ts`, views | |
| K5 | Headless hooks and blocks, web and native: register, item, fault inbox, my maintenance, inspection, report a fault (staff and member), out of order, my reports | Pack: `client/`, `blocks/` | |
| K6 | Staff screens declared (stage 47's `screens`); the My account section (stage 48's `portal`) | Pack, after stages 47 and 48 | |

No new core table: P1 and P3 change behaviour, P2 reads a declaration. If P2 needs the overseeing
permission recorded on a run, it is one column in a migration of its own (block BU).

## The model

### Words

- **Item**: one thing the business looks after. _Avoid_: asset (fine in prose), equipment (the
  pack's name, not one record), machine (only some items are).
- **Service plan**: a series that makes maintenance on a schedule. _Avoid_: schedule (an
  automation's trigger), maintenance plan.
- **Maintenance**: one dated piece of work on one item (a service, an inspection, a safety test, a
  repair). _Avoid_: job (stage 39's), work order (stage 39 avoids it too), task (a base record).
- **Inspection**: a maintenance whose kind is inspection or safety test, carrying a checklist. Its
  **inspection record** is the checklist's run. CONTEXT.md's Checklist entry lists "inspection"
  under _Avoid_: the build amends it to say an inspection is a maintenance that carries one.
- **Fault**: a report that something is wrong with an item. _Avoid_: ticket (Ticketing's), issue,
  incident (an injury to a person is not this stage's: Forms' staff-only incident form).
- **Out of service**: an item's state while it must not be used. _Avoid_: broken (a fault's word).
- **Keeper**: the staff account who looks after an item; empty means the managers.

### Records

**`equipment.item`**: `name` (required), `category` (select, editable options; seeded: Cardio,
Strength, Free weights, Studio, Wet area, Tool, Test gear, Vehicle, Other), `place` (text), `tag`
(text, unique), `make`, `model`, `serial`, `boughtOn` (date), `cost` (currency), `supplier`
(relation to an Organisation), `warrantyUntil` (date), `warrantyNotes` (long text), `photo`
(image), `keeper` (user), `issuedTo` (user: who has it now), `renewalDue` (date, optional: a van's
registration), `listForMembers` (select: listed, not listed; default not listed), `state`,
`outSince` (datetime, host-set), `outReason` (text), `notes` (long text). Read on its page, not
stored: last inspection and its outcome, next maintenance due, open faults, cost this year.
`signedIn: { read: ["name", "category", "place", "state", "outSince"], when: { field:
"listForMembers", in: ["listed"] } }`.

**`equipment.plan`**: `item` (relation, required), `title`, `kind` (service, inspection, safety
test), the interval rule (P1: every, unit, weekdays or day of month or date, time, from, until,
zone), `windowDays` (how long each stays open, default 7, the generated length), `assignee`
(user), `supplier` (Organisation), `checklist` (checklist field, `personApproves`), `status`
(active, ended). `recurring` copies `assignee`, `supplier`, `kind` and `checklist` to what it makes.

**`equipment.maintenance`**: `item`, `plan` (read-only, host-set), `title`, `kind` (service,
inspection, safety test, repair), `startsAt`, `dueBy` (datetimes; from the plan, `dueBy` is the
start plus `windowDays`), `zone`, `assignee` (user), `supplier`, `checklist`, `outcome` (passed,
passed with faults, failed), `cost` (currency), `reference` (text: the supplier's invoice number),
`notes`, `fault` (relation: the fault a repair fixes), `changed` (host-set). Declares
`checklists: { template: "checklist", who: "assignee", opens: "startsAt", closes: "dueBy", live:
["due"], oversees: "equipment:manage", requiredFor: ["done"], onMissed: "missed" }` (P2, P3).

**`equipment.fault`**: `item` (required), `description` (long text, required), `severity` (safety
risk, not working, worn or cosmetic), `photo` (image, staff only), `reporter` (relation to a
Person, host-set for a member; not required, so an erase clears it and the fault stays),
`reportedBy` (user: a staff reporter), `state`, `maintenance` (relation: the repair), `closedWhy`
(text), `underWarranty` (formula: the item's `warrantyUntil` on or after the report). `customer: {
field: "reporter", read: ["item", "description", "severity", "state", "createdAt"], write:
["item", "description", "severity"], createOnly: ["item", "description", "severity"] }`.

### States

| Object | States | Moves (who) |
| --- | --- | --- |
| Item | `in_service` (initial), `out_of_service`, `retired` (final) | out: the tools `takeOut` and `reportFault` (`equipment:report`), requires `outReason`; back in: the tool `putBack` only (`equipment:manage`, `humanOnly`); retired: the tool `retire` (`equipment:manage`), requires `notes`, and sets "not listed" in the same write |
| Maintenance | `due` (initial), `done` (final), `missed` (final), `cancelled` (final) | done: the assignee or a manager, requires `outcome`, and the checklist run done when it carries one (P3); missed: the host when its run is closed missed (P3), or a manager; cancelled: a manager, or the host when the plan ends or a closure covers it |
| Fault | `reported` (initial), `acknowledged`, `fixed` (final), `not_a_fault` (final), `duplicate` (final) | staff with `equipment:manage`, or the item's keeper; `fixed` requires `maintenance` or `closedWhy`; the others require `closedWhy` |

A maintenance without a checklist stays `due` past `dueBy` (shown overdue) and may be done late.
One with a checklist is ticked within its window and the 2-hour grace (ADR 0650); rescheduling it
(`startsAt`, `dueBy`) before its run closes moves the run's window. Once its run is missed it is
`missed`, and a manager makes a new one. The plan's next date is unchanged by a late one
(decision 6).

### Permissions

- `equipment:report` (grantable): read the register, report a fault, take an item out of service.
  Held by every staff role; granted to a coach or cleaner on a pack role (ADR 0600).
- `equipment:work` (grantable): see and do the maintenance assigned to them, tick their
  inspections.
- `equipment:manage` (restricted, grantable, ADR 0625): items, plans, faults' triage, putting
  back in service, overseeing inspection runs. Admins hold it.

No new pack role: an outside technician has no account; a staff member records their visit.

### Operations and tools

| Tool | Audience | Who may | Risk | Notes |
| --- | --- | --- | --- | --- |
| `register` (items with state, next due, open faults) | staff | `equipment:report` | read | |
| `item` (one item with its maintenance, faults and costs) | staff | `equipment:report` | read | Costs for all staff (decision 8) |
| `reportFault` | staff | `equipment:report` | write | Optional `takeOut: { reason }` makes the item's move in the same batch (decision 3); tells the keeper |
| `takeOut` / `putBack` | staff | `report` / `manage` | write | `putBack` is `humanOnly` (decision 4) |
| `retire` | staff | `manage` | write | |
| `triage` (acknowledge, close, link a repair) | staff | `manage` or the keeper | write | |
| `myMaintenance`, `maintenance` | staff | `equipment:work` | read | |
| `finishMaintenance` (outcome, cost, reference, notes) | staff | the assignee or `manage` | write | `humanOnly` when it carries a checklist; refused by the host while its run is not done (P3) |
| `inspection`, `tick`, `inspectionDone` | staff | the assignee; overseers for someone | write | Over `checklist.forRecord`, `checklist.tick`, `checklist.complete`; `humanOnly` (ADR 0650) |
| `inspectionRuns`, `inspectionCorrect` | staff | `manage` | read / write | Over `checklist.runs`, `checklist.correct` |
| `costs` (per item, period, supplier) | staff | `equipment:report` | read | |
| `reportFaultAsMember` | **customer** | a signed-in member | write | Over `my.create`; the item must be one the member can read (listed), refused as not found otherwise by the seam (ADR 0447); rate limited per person and per item. **Opens a write to customers: reviewed (ADR 0402)** |

Members read the listed items (the out-of-order list is those `out_of_service`) and their own
reports with `my.list`; no tool. Nothing is opened to the public. Plans, items and maintenance are
ordinary record writes as well, with the same states and rules.

### Screens

- **Web admin (stage 47 screens)**: Equipment (the register, filter by state, category, place); an
  item's page with tabs Maintenance and Faults; Faults (newest safety risks first); Maintenance
  (due, overdue, by person); My maintenance; Inspection; Costs. Settings → Checklists is the
  existing core screen.
- **Native (staff app)**: Report a fault (by tag, by scanning the code that holds the tag, or from
  a list), take out of service, my maintenance, do an inspection, a camera photo on a staff report.
- **Customer web and app**: a **My reports** section in My account (stage 48's `portal`, `has:
  ["equipment.fault"]`); **Report a problem** and **Out of order** are blocks the client puts on
  its pages (not sections: they are not the member's own records). No attention kind: nothing in a
  fault report waits on the member. The rules are the host's.
- **Printed tags**: an item's page shows its tag as a code to print. A code that opens the
  member's report screen for that item is a link into the company's own app.

### Notifications

In-app notices to staff, delivered by email (and push once stage 30 is built) by each person's
preferences: a new fault to the item's keeper or else the managers (a safety risk marked urgent,
decision 3); a maintenance assigned (through its Task); one overdue a day after `dueBy`, to its
assignee and the managers; a missed inspection to the overseers (the host's, P2); a warranty
ending in 30 days to the managers; a van's renewal in 30 days to the keeper. Members get no email
in this stage: they see their report's state in My account.

### What an AI may do

- May: read the register, maintenance, faults and costs as the staff tools allow; draft items from
  a spreadsheet or an invoice; draft a service plan and a checklist template (a person approves the
  template, ADR 0650); report a fault from what a staff member tells it (as that person); ask to
  take an item out of service (waits for a person); summarise an item's history.
- May not: put an item back in service; tick a checklist, mark an inspection done or read how one
  went (`humanOnly`, ADR 0650); change a plan's checklist without a person's approval
  (`personApproves`); act as a member.

### Privacy and erase

- A member's report is linked to their Person and read by staff. Its description is free text:
  the report screen says not to describe injuries there. An injury is recorded on Forms' staff-only
  incident form (stage 29), not here; what must be recorded about one is for the business to
  confirm with its lawyer or insurer.
- Erase: the reporter is cleared and the person's name and address in the text removed (ADR 0320's
  extension erase); the fault and its repair stay as the item's history. A staff member who leaves
  keeps their name on maintenance and ticks, as Rostering.
- Inspection runs keep ADR 0650's privacy, with "who roster" read as "who oversee" (decision 7):
  ticks, notes and reasons read only by the person and the overseers, never an AI, redacted from
  the audit log. The outcome and date are ordinary fields every staff member reads: the evidence a
  business shows.
- Members see only their own reports and the listed items' name, category, place, state and since.
  Never costs, suppliers, notes, keepers, who reported what, or items not listed.

### Money

Costs are recorded, never paid. They use the `currency` field as Deals' value does, in the base
currency; today a decimal, not integer minor units. Totals on the dashboard and in `costs` are
rounded once to the currency's minor unit, half up. Nothing here charges a card, raises an invoice
or reaches the books (stage 52's figures are sales, not this).

## Out of scope

- Visitors without an account reporting a fault (later, through stage 29's public-write door).
- A member attaching a photo (issue #117; Forms step 8).
- Servicing by usage: kilometres, engine hours, counted uses (decision 10).
- Customers' own equipment, reminders to customers, booked visits, invoices for repairs (decision
  9; stages 39 and 35). No "owner" field is added until then.
- Spare parts and stock (stage 37's `stock`); purchase orders to suppliers.
- Depreciation, asset values, anything for the accounts.
- Time spent on maintenance as hours (stage 58's time entry, if a business asks).
- Step-level pass or fail on a checklist; photos on a checklist step (ADR 0650).
- Out of service closing classes or rooms (stage 49's `occupies`).
- Hiring or lending equipment to members.
- An injury or incident register (stage 29's staff-only form).
- Outside technicians with their own sign-in.
- A "your report is fixed, thanks" email (a routine mail kind, later).

## Acceptance criteria

1. A manager adds a treadmill with a tag, supplier, cost and warranty date; a second item with the
   same tag is refused by the host.
2. A plan "every 3 months on the 1st at 09:00" makes its maintenance ahead to its horizon, each
   once; "every month on the 31st" lands on the last day of shorter months; "every year on 1
   March" makes one a year; one done late leaves the next on its date; one moved by hand is never
   moved back; Bookings' and Rostering's weekly series behave as before (their tests unchanged).
3. A maintenance from a plan with a checklist gets a run made by the host; its assignee ticks it
   within the window; marking it done is refused while the run is not done, by the tool, the
   record page and a board alike; once done the run and its ticks never change.
4. Its run is read by the assignee and holders of `equipment:manage`; another staff member is
   answered "not found"; an AI gets nothing. With Rostering installed, rosterers without
   `equipment:manage` cannot read it, and Rostering's runs behave as today.
5. A run not done by `dueBy` and the grace is missed; the overseers are told once; the host moves
   the maintenance to `missed` in the same batch.
6. A coach on `bookings.coach` granted `equipment:report` reports a safety-risk fault and takes the
   machine out of service in one call, and can do nothing else in the pack.
7. Putting an item back in service is refused to anyone without `equipment:manage`, and to an AI.
8. A signed-in member reports a fault on a listed item from the website and the app; the manager is
   told; the item stays in service; the member sees it in My reports with its state, and cannot
   report on an item not listed, set the reporter, or read another member's report.
9. A listed item out of service appears in the members' Out of order list with name, place and
   since; no cost, supplier, note, keeper or reporter is in the answer; an unlisted one is absent.
10. A new safety-risk fault tells the keeper (or the managers) within a minute; a maintenance a day
    overdue tells its assignee and the managers; a warranty ending in 30 days tells the managers.
11. An assigned maintenance has one linked Task on the assignee's list; finishing it completes the
    Task; reassigning it moves the Task.
12. An item's page shows its maintenance, faults and costs in date order; cost this year adds its
    maintenance costs, rounded once.
13. Erasing a member who reported a fault clears the reporter and their name in its text; the fault
    and its repair stay.
14. `cos ext check packs/equipment` and `cos ext test packs/equipment` pass; the contract refuses
    `oversees` naming a permission the pack does not declare restricted, and `requiredFor` or
    `onMissed` naming a state the object does not have.
15. A register loads from a spreadsheet through the admin's import; the tag matches an item that
    exists, so a second run creates nothing twice.
16. E2E, one per journey: a member reports a fault and staff fix it; a manager plans a service and
    the assignee does the inspection.
17. Cost: the register's read and the members' out-of-order read take a bounded number of
    statements (a statement-count test at 500 items).
18. The site and `SITE.md` list the Equipment pack (in the build's last step).

## Dependencies

- Built: stages 22 to 24 (audiences, the typed client, client apps), 25 (`states`), 31a step 2
  (`recurring`, uniqueness), 45 step 4 (restricted permissions) and step 4b (checklists), stage 12
  (the admin's import).
- Not built: **stage 47** (pack screens) for the staff web screens; until then the blocks mount on
  `/blocks`, as Rostering's did. **Stage 48** (My account) for the My reports section; until then
  the block is mounted on its own page.
- Later and related, not needed: stage 29 (visitor reports, photos, the incident form), stage 30
  (push), stage 39 (customers' equipment), stage 35 (invoices), stage 37 (stock), stage 58 (time).

## Migrations and numbers

Block **BU**: migrations 1290 to 1309, ADRs 0860 to 0869.

- Migrations: none expected. 1290 if P2 records the overseeing permission on a run.
- **ADR 0860**: the interval rule in `recurring` (amends 0500).
- **ADR 0861**: who oversees a checklist, and a move that needs its checklist done (amends 0650;
  CONTEXT.md's Checklist entry changes with it).
- **ADR 0862**: the Equipment pack: the four objects, out of service by a tool and back by a
  person, members' reports and the listed items (the reviewed customer write and signed-in read).

## Suggested build order

| Step | What | Files and areas | Can be built beside |
| --- | --- | --- | --- |
| 1 | P1: the interval rule | `packages/sdk/src/recurring.ts`, `packages/core/src/recurring/`, Bookings' and Rostering's recurring tests | Steps 2 and 3. **Collides** with stage 49 step 9 (standing appointments, may touch `recurring/`) and anything changing Bookings' or Rostering's series |
| 2 | P2 to P4: overseers, a move that needs its checklist done, the wording | `packages/sdk/src/checklists.ts`, `packages/core/src/checklists/`, `operations/checklist.ts`, `records/states.ts` | Steps 1 and 3. **Collides** with stage 38 step 8 (a checklist's "how to"), stage 60's missed-checklist reads, Jobs' checklists on crew places, and other work in `records/states.ts` |
| 3 | The pack's spine: items, faults, states, uniqueness, permissions, staff tools, out of service | `packs/equipment/` (new), `products/*/product.ts` packs list, the release golden manifest | Steps 1 and 2; other new packs (**collides** on the golden manifest and `packs.json`: regenerate) |
| 4 | Service plans and maintenance (after 1), inspections (after 2) | `packs/equipment/index.ts`, `tools.ts` | Step 5 |
| 5 | The member's report, Out of order, My reports (reviewed) | `packs/equipment/tools.ts`, `packages/core/open-operations.json` (generated) | Step 4. **Collides** with anything regenerating the open-operations list or the typed client |
| 6 | Automations, dashboard, views | `packs/equipment/automations.ts`, `dashboards.ts` | Step 7 |
| 7 | Hooks and blocks, web and native; screens and the My account section once stages 47 and 48 are in | `packs/equipment/client/`, `blocks/`, `scripts/check-blocks.mjs` registry | Step 6 |
| 8 | The site and `SITE.md` | `apps/marketing` | Anything (**collides** with other site edits) |

No step touches `orders/`, `subscriptions/`, the email gatekeeper, `pack-roles.ts` or the
`core_write_guard` migrations.

## Size

**Medium.** Two contained pieces of platform work (P1; P2 with P3) and a pack the size of
Rostering's spine without pay or offers. Three sessions at once at the start (steps 1, 2, 3), then
two (4 and 5, then 6 and 7).

## Decided by this spec, open to override

| Choice | Decision |
| --- | --- |
| One pack | For gyms and trades alike; customers' equipment waits for stage 39 (decision 9) |
| The record's name | **Maintenance**, not "job" (stage 39's) or "work order" |
| Checklists | Rostering's (ADR 0650), made general by `oversees` and `requiredFor`; no second checklist |
| A Task per maintenance | Linked, not used instead of it |
| Schedules | Fixed on the calendar, anchored on the plan's start date; a late one does not move the next (decision 6) |
| Monthly on a day the month lacks | The month's last day |
| The window | `windowDays`, default 7 |
| Late maintenance | Without a checklist, done late; with one, missed once its run is, and a new one made |
| An inspection's result | On the maintenance (passed, passed with faults, failed); each problem is a fault |
| Out of service | By a tool for anyone with `equipment:report`; back only by a person with `equipment:manage` (decisions 3, 4) |
| Retiring | Unlists the item from members in the same write |
| Members' list | Opt-in per item ("not listed" by default) |
| Costs | Visible to all staff (decision 8); recorded, never paid; totals rounded once, half up |
| Members' email | None in this stage |
| Pack roles | None; grants on existing roles |
| Notice times | Overdue a day after `dueBy`; warranty and renewal 30 days ahead |
| Importing a register | The admin's import, matching on the tag |

## Questions for the owner

None open. Every question was decided as best practice (decisions 1 to 10). The owner may override
any of them.

## Risks

- **Security**: one new customer write and one signed-in read. Rate limits per person and per
  item; staff close duplicates. The seam already refuses a relation to an item the member cannot
  read (ADR 0447).
- **Safety**: a member trusting a machine nobody marked out. The Out of order list is what staff
  marked, not a safety guarantee; the screen says so. What to check, how often, and what an
  inspection record must hold are for the business to confirm with its insurer or lawyer; no
  wording or schedule ships as advice.
- **Privacy**: free text in members' reports may mention health; the form discourages it, and
  erase clears the reporter. ADR 0650's privacy carries over.
- **Platform regressions**: P1 changes the generator Bookings and Rostering run on; P2 changes who
  reads Rostering's runs. Both need those suites green and a statement-count check.
- **Needs a real device**: scanning a tag and a photo in the staff app; the member's report from a
  phone. **Needs a real client**: a gym's register and service cycle (decision 1).
