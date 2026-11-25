# Stage 58: Timesheets and leave

Read first: [`AGENTS.md`](../../AGENTS.md), [`CONTEXT.md`](../../CONTEXT.md) (Shift to Pay period),
stage [45](45-rostering.md) in full, ADRs [0621](../adr/0621-the-staffed-behaviour-and-the-time-claim.md)
to [0627](../adr/0627-pay-periods-the-basis-the-totals-the-lock-and-the-export.md) and
[0629](../adr/0629-the-rosters-screens-role-clients-with-grants-and-the-roster-import.md), stage
[47](47-pack-screens.md) (staff screens are declared by the pack), and the code this stage amends:
`packages/core/src/staffing/pay.ts`, `packages/core/src/operations/staffing-pay.ts`,
`packages/core/src/operations/staffing.ts`, `packages/core/src/staffing/sets.ts`,
`packages/core/src/staffing/leaving.ts`, `packages/core/src/staffing/rosterers.ts`,
`packages/db/migrations/0811_staff_time.sql` and `0813_pay_periods.sql`, `packs/rostering/index.ts`.

Status: **spec agreed** (owner interviewed 2026-11-24: decision 1; the owner's earlier pay
decisions of 2026-11-24 stand as decisions 2 to 4; decisions 5 to 13 decided as best practice by
the coordinator, open to override). Build may start.

## Status

- **Step 1** — built — PR #364 — Time entries
  (built 2026-11-24, migration 1270, [ADR 0850](../adr/0850-time-entries-the-hosts-clock-overlaps-refused-and-worked-on.md)):
  `core_time_entry` with the overlap triggers (every statement shape), one open entry per person
  and a start's idempotency key; the tool-only `staffing.time.clockIn`, `clockOut` (the host's
  clock), `enter`, `edit`, `withdraw` and `mine`, a person's own act on their own entries, working
  once the pack's `staffing.settings.recordsTime` is on (`enterDays`, `finishMissingHours` read
  beside it); what an entry is against (an own live shift, a live `workedOn` record, or other
  work); finish missing on the minute cron (`staffing.due`); `workedOn` in the SDK, refused to a
  runtime extension. Until step 2 every finished or entered entry waits. Leaving does not yet mark
  an open entry finish missing (step 4 amends `leaving.ts`).

- **Step 2** — built — PR #417 — Differences and approval
  (branch `feat/stage-58-approval`; migration 1273,
  [ADR 0851](../adr/0851-differences-from-the-roster-and-approval-of-time.md); amends ADR 0850):
  built in core. The tolerance (`staffing.settings.matchMinutes`, 5, 0 to 30); an entry finished,
  entered or corrected that matches the person's own live shift within it is approved by the host
  (`approved_by = 'host'`, the claim guarded in the batch), the rest wait (time with no shift, and
  an entry held, `core_time_entry.held`: an approver's entry for someone, a missing finish entered
  afterwards, one an approver sent back or reopened, which its person corrects and never
  withdraws). Differences in minutes, any part of a minute counting as one; no note or reason in
  `differences`. The tool-only `staffing.time.waiting`, `differences` (an approver
  reads everyone's, a person their own; early and late in whole minutes, unrostered, over 12 hours,
  not recorded for people counted by time; set-based, `staffing/sets.ts`), `approve` (up to 100,
  as is or changed, the recorded times kept beside; all or none), `reject` (with why, the person
  told; a correction waits again or matches), `reopen` (with why, `core_time_entry.reopened_why`,
  while the period is open) and `enterFor` (`staffing/time.ts`, `operations/staffing-time-approve.ts`).
  Nobody decides their own entry (an admin may when nobody else can). Tests:
  `packages/core/test/staffing-time-approve.test.ts` (the hand-worked fixture across midnight and
  Sydney's clock change), `staffing-time-approve-cost.test.ts` (100 changed approvals in 614
  statements; differences in 24 statements whatever the range). Notices name no approver and no
  time. Amended after the review of PR #417. Left for later steps: not recorded
  from `recordedFrom` (step 3), the 07:00 summary to approvers and Rostering's tools and setting
  (step 5), the screens (step 6).

- **Step 3** — not built — needs: step 2, step 4 — Pay: `recordedFrom`, lines from entries and leave, the lock's refusals and triggers, export columns, `myPay` (migration 1272)

- **Step 4** — built — PR #374 — Leave
  (branch `feat/stage-58-leave`; migration 1271, ADR 0853; amends ADRs 0622,
  0624, 0629): built in core. `core_leave_type`, `core_leave_request`, `core_leave_day`,
  `core_leave_balance_entry` (insert only) and `core_staff_away.leave_request`, with triggers
  (a request decided once, so two approvals at once apply once; what it asked fixed; an approved
  one never deleted; a refusing type's approval refused below zero by the database). The tool-only
  operations `staffing.leave.types`, `saveType`, `request`, `requestFor` (with `approve`),
  `cancel`, `mine`, `pending`, `approve`, `decline`, `cancelApproved`, `balances`, `setBalance`,
  `adjust` (`staffing/leave.ts`, `operations/staffing-leave.ts`). Approval in one batch writes the
  balance entry, the away row and takes the person off each covered shift not started, offering
  each to everyone eligible (each take-off guarded on the person still holding it; eligibility and
  the offer notices set-based; at most 40 shifts an approval, 670 queries at that size with four
  kinds of 100 qualified people, `staffing-leave-cost.test.ts`). Approved leave is cancelled only
  with its away row removed and its balance reversed (a stale cancel fails whole). Open: a weekly
  pattern's later generation can name the person on a shift inside approved leave (ADR 0853).
  `staffing.back` refuses a request's row;
  `staffing.away` makes no new kind `leave` once a type exists; `user.deactivate` cancels waiting
  requests and marks an entry left open finish missing (no finish written). Tests: `packages/core/test/staffing-leave.test.ts`. Left for later steps: the lock's
  triggers over leave and leave lines in pay (step 3, migration 1272), Rostering's tools and
  notification words (step 5), the screens (step 6), the `forget` additions (with `staffing.forget`).

- **Step 5** — not built — needs: step 1, step 2, step 4 — Rostering's tools, settings, labels, notification words

- **Step 6** — not built — needs: step 5 — Screens: My time; leave in My time off and Time off; Time to approve, Differences, Leave types and balances, Pay's additions; stage 47 declarations

- **Step 7** — not built — needs: step 1 — The Jobs seam: a test pack with `workedOn` and `partOf`; `forRecord`

- **Step 8** — not built — needs: step 6, the first client — The first client: hours and leave recorded, leave types and balances entered, a fortnight recorded, the export checked

## Goal

Staff record the time they actually worked, and the business pays from it. A cleaner taps "start"
on their phone when they arrive and "finish" when they leave; a coach who forgot enters their hours
afterwards; a tradesperson records three hours on one job and four on another. The manager sees
each entry beside the roster (started 20 minutes late, a shift nobody recorded, time worked with no
shift at all) and approves it, or approves it changed; entries that match the roster are approved
on their own. Staff ask for leave of a type the business sets (annual, personal, unpaid), see the
balance the business keeps for them, and the manager approves or declines; approved leave shows on
the roster as time away, takes the person off the shifts it covers and offers them, and is listed
in the pay period beside their hours. Pay periods count **approved recorded hours** for staff paid
by the hour, and export them for payroll. **No pay rule, rate, entitlement or accrual is computed**:
the business, its payroll and its accountant apply those.

This stage owns **the one time-entry record**: hours a person recorded, at the business or on a job
site. Jobs (stage 39) links entries to a job and keeps no hours of its own.

## Who it is for

- **Gyms and studios first.** Hourly staff (cleaners, front of house, casual coaches) record their
  time; a coach paid by the class need not (the class list is already the evidence, ADR 0627).
  Leave for part-time and full-time staff, approved by the owner.
- **Trades and services** (the next vertical) need it more:
  - Time is recorded **against a job** as often as against a shift, often with no roster at all. A
    tradesperson's day is several jobs. One record (a time entry) serves both, so a job's hours and
    the pay period's hours are one set of facts, never two.
  - Recording time afterwards is normal (no signal on a site), so entering time is a first-class way
    in, not an exception. Offline clocking is deferred.
  - Crews: each person records their own time; a supervisor recording for a crew is deferred.

## What exists today (from the code, checked 2026-11-24)

- **Shifts and the roster** (stage 45, built): the `staffed` behaviour
  (`packages/sdk/src/staffed.ts`), each live covered shift's time claim (`core_staff_time`,
  `packages/core/src/staffing/sql.ts`), the roster read `staffing.week`
  (`packages/core/src/staffing/week.ts`), set-based reads (`packages/core/src/staffing/sets.ts`).
  Bookings' class and Rostering's duty shift (`packs/rostering/index.ts`) declare `staffed`. The
  `staffing.*` operations are in `packages/core/src/operations/staffing.ts` (roster, offers,
  unavailability, `staffing.assign`), `staffing-pay.ts` (pay) and `staffing-feed.ts`.
- **Unavailability** (`core_staff_away`, migration 0811, ADR 0622): kind `leave`, `regular` or
  `other`, one-off or regular, made by the person (`staffing.away`, `staffing.back`) or a rosterer
  (`awayFor`). **Nobody approves it** (stage 45: "Nobody approves leave in this stage"); it drives
  the `unavailable` warning, who is eligible for an offer, and the "away over rostered shifts"
  notice. Stage 45 decided that being away over rostered shifts **does not unassign them**. Notes
  are redacted from the audit log and never reach an AI (ADR 0626).
- **Pay periods** (`packages/core/src/staffing/pay.ts`, `operations/staffing-pay.ts`, migration
  0813, ADR 0627):
  - who is counted (`core_staff_pay_basis`: `by_time`, `by_class`, `not_counted`, from a local
    date); the period (Rostering's settings `payPeriod`, `payPeriodStart`, `payPeriodDay`, read
    through the pack's `staffing.settings` declaration, `payPeriodSettings` in `rosterers.ts`);
  - `periodLines` makes **one line per live covered shift** of a counted person, its
    `countedMinutes` = the shift's own minutes (end minus start as instants) **plus** its kind's
    set-up and pack-down minutes (`staffed.payBefore`, `payAfter`, stage 45 decision 19), or 0 when
    marked not worked (`core_staff_not_worked`);
  - evidence (`staffed.evidence`: the class list taken, by whom; `flagged` when someone else took
    it); `totalsOf` per person, basis and kind; hours from summed minutes (`hoursOf`);
  - the lock (`staffing.payPeriod.lock`): a fingerprint of what the lines came from
    (`periodFingerprint`), guarded in the lock's batch; lines written with `lineInserts` into
    `core_pay_line`, whose `basis` is `CHECK (basis IN ('by_time', 'by_class'))` and whose
    `object_type`, `record_id`, `kind_name` and `title` are `NOT NULL`; triggers on every staffed
    table (`<table>__paylock_*`), the not-worked mark and the basis refusing changes inside a locked
    period; reopen with versions;
  - the CSV (`payCsv`): a summary row per person, basis and kind; a blank row; a row per shift
    ending in `for review` and `note`;
  - a person's own totals (`staffing.myPay`, `staffing.myPay.periods`, ADR 0627 amended).
  - **Stage 45 decision 18**: what counts is the roster as it stands at the lock, corrected by a
    rosterer. **Decision 10**: the host totals rostered hours.
- **Leaving**: `user.deactivate` (in `packages/core/src/operations/automation-binding.ts`) calls
  `leaveRoster` (`staffing/leaving.ts`, ADR 0624). `staffing.forget` is specced in stage 45, not
  built.
- **Permissions**: `rostering:team` / `rostering:roster` (the team's tools), `rostering:manage`
  (rosterers, restricted), `rostering:pay` (pay, restricted), restricted pack permissions (ADR
  0625), the verified caller of a pack's tool (`calledBy`).
- **Stage 45's out of scope** names this stage: "Clocking in and out, timesheets beyond the roster,
  breaks"; "Leave approval, leave balances".
- **Not there**: any record of actual time worked, any time against a record that is not a shift,
  any leave type, request or balance. Stage 47 (pack screens in the admin) is being built (PR #303).
  Jobs (stage 39) is not specced.

## Decided at the interview (2026-11-24)

| # | Decision |
| --- | --- |
| 1 | **Hourly staff are paid from approved recorded hours.** A rostered shift with nothing recorded counts its rostered time and is **flagged for the manager to check**. This holds at the business and on a job site |

### The owner's earlier decisions on pay that still hold (2026-11-24)

| # | Decision |
| --- | --- |
| 2 | **Payroll applies its own rules.** Nothing more is computed: no overtime, penalty hours, minimum engagement, break rules or rounding rules. No rates are held |
| 3 | **Exact minutes are summed; hours are shown to two decimals** (from the summed minutes, never a sum of rounded hours) |
| 4 | **A staff member sees their own totals** for a pay period (`myPay`), and nobody else's |

### Decided by the coordinator (2026-11-24)

Points the interview did not ask, each decided at the draft's recommendation under the owner's
standing rule (best-practice answers are decided, not asked). The owner may override any of them.

| # | Decision | Why |
| --- | --- | --- |
| 5 | **Only entries that differ from the roster need a manager**: an entry against the person's shift that starts and finishes within the tolerance is approved by the host and marked so; the rest wait. Time with no shift (a job, other work) always waits for a person | Most shifts match; the manager's attention goes to the late, early, unrostered and forgotten ones |
| 6 | **The tolerance is 5 minutes** (a setting, 0 to 30). Exact minutes are always kept; the tolerance decides only what shows as a difference and what is approved on its own | Allows for walking in the door without hiding a real difference |
| 7 | **Approved leave takes the person off the shifts it covers** that have not started, and offers each to everyone qualified and free; the manager is told which are still uncovered | Approved leave means they will not be there; the offer system staff already use fills the gap |
| 8 | **Staff can still say when they cannot work without approval** (stage 45's unavailability stays); leave requests are for time off that is paid or counted against a balance | A regular afternoon off is not leave |
| 9 | **A balance below zero is decided per leave type**: allowed with a warning, or refused; a type may keep no balance at all | Whether leave may be taken in advance differs by type and business, for it to confirm with its accountant |
| 10 | **Staff see their own leave balances** in the app and on the web; nobody sees anyone else's | People check before they ask |
| 11 | **No location is recorded** at start or finish | Location is personal data; approval and differences from the roster are the check. Trades may ask later |
| 12 | **The people who roster approve hours and leave** (`rostering:manage`: the owner, admins, and anyone granted it). Leave types and balances are for whoever handles pay (`rostering:pay`). Nobody approves their own | Rosterers already correct who worked what before a period closes |
| 13 | **How the gym records hours and handles leave today was not asked**: the draft's assumptions stand, to be checked with the business during setup (step 8) | A fact for setup, not a design choice |

## The design in one page

**A time entry is the one record of time worked.** A core table keyed by staff account, in no
`rec_*` view (as pay and unavailability are): one person, a start and a finish as instants, unpaid
break minutes they entered, what it was against (a shift, a job, or nothing: "other work"), how it
was made (clocked, entered, or entered by an approver), and its state (open, waiting, approved,
rejected). The database refuses two entries of one person that overlap, as it refuses two shifts.
The start and finish of a clocked entry are the host's clock, never the phone's.

**What it is against is declared, not hard-coded.** A shift is any `staffed` record. A job is any
record of an object that declares a new, small declaration, **`workedOn`** ("time can be recorded
against this"). Jobs' job declares it; a duty shift and a class need not (they are shifts already).
A job's hours are the entries against it; the pay period's hours are the same entries. Jobs keeps
no second "time spent" record.

**Differences from the roster are worked out by the host**, never by a screen: for an entry against
a shift, started early or late and finished early or late, in minutes; a past live covered shift of
a person counted by time with no entry (**not recorded**); an entry with no shift (**unrostered**).
The tolerance (5 minutes) decides what counts as matching.

**A manager approves what differs** (decision 5). An approver approves an entry, approves it
changed (the recorded and the approved times are both kept), or rejects it with why; the person
corrects it and sends it again. Entries that match their shift within the tolerance are approved by
the host as they are finished or entered, recorded as "approved: matched the roster".

**Pay counts approved recorded hours** (decision 1), through the pay code that exists. For a person
counted **by time**, on and after the date the business starts paying from recorded hours: a shift
with approved entries counts their minutes less breaks; a shift with no approved entry counts its
rostered time, as today, and is flagged **not recorded**; an approved entry with no shift (a job,
other work) is a line of its own. **By class** lines are unchanged. A period cannot be locked while
an entry or a leave request in it waits. After the lock nothing in it changes. Exactly what is
amended in ADR 0627's code is below.

**Leave is a request; unavailability stays a statement** (decision 8). A leave request has a type
the business sets, dates (whole days, or a time range on one day), an amount per date (in the
type's unit, hours or days), a note and a state. Approved, the host writes **the existing**
unavailability row for it (`core_staff_away`, kind `leave`, linked to the request), so every stage
45 rule (the warning, who is eligible, the notice) works unchanged; it takes the person off the
shifts it covers and offers each (decision 7); and it writes the amount to the balance ledger.

**Balances are the business's numbers.** A ledger per person and leave type: entries a pay holder
sets or adjusts ("opening balance 76 hours", "added 2.9 hours for this fortnight"), and the host's
own entries when leave is approved or an approved request is cancelled. The balance is the sum.
**The host never accrues**: how leave is earned is for the business to confirm with its accountant,
and it enters the result.

### What was weighed and rejected

| Option | Why not |
| --- | --- |
| **Actual start and finish fields on the shift itself** | A shift is the plan, and a class's times are what members read. Writing actual times onto it would move the class on the timetable and its time claim, and the lock's triggers guard its times. Time with no shift (a job, other work) would have nowhere to go |
| **Time entries as Rostering pack records** | Records are in `rec_*` views: every member with `records:read` would read colleagues' hours by SQL, export and the assistant. Pay and unavailability are core for the same reason |
| **A separate "time spent" record in Jobs** | Two records of one person's hour: the job says 3 hours, the pay period says 4. One entry, read by both through the host, cannot disagree |
| **Jobs as `staffed` objects** | A job lasts weeks and many people work on it; a shift is one person at one time, with a claim that refuses overlaps. A scheduled visit to a site *is* a shift (it may declare `staffed`); the job it belongs to is not |
| **Counting only recorded time** (a shift with nothing recorded counts nothing) | The owner chose to count the roster and flag it (decision 1): nobody goes unpaid for a shift they worked and forgot to record |
| **A second, approved "away" table for leave** | Stage 45 already knows "away": its warning, eligibility and notice. Writing the existing row once leave is approved reuses all of it and cannot drift |
| **Making every unavailability a request** | Decision 8 |
| **Accruing balances** | An entitlement rule, which differs by agreement and place. For the business to confirm with its accountant; the host keeps the number it is given |
| **Working out a leave day's hours** (a part-timer's "day") | A pay rule. The request proposes each date's amount from the person's rostered minutes that day, as a hint; the approver confirms it |
| **Leave lines in `core_pay_line`** | Its `basis` check allows only counted people, and salaried staff's leave goes to payroll too. A leave section has its own locked table |
| **The phone's clock, or its location, as the record** | A phone's clock can be set by its owner; location is off (decision 11) |

## What is platform work and what is pack work

| Piece | Platform or pack | Why |
| --- | --- | --- |
| **Time entries**: `core_time_entry`, the overlap trigger, one open entry per person, the host's clock | **Platform** (new core table and operations) | Personal, keyed by staff account, read by pay; must hold for every actor and under races |
| **`workedOn`**: a record time can be recorded against | **Platform** (new declaration, SDK; small) | Jobs and any later pack declare it without depending on Rostering |
| **Differences** from the roster, the tolerance, approval on match | **Platform** (tool-only read over `staffing/sets.ts`) | The same answer on every screen; no rule in a block |
| **Approval** of entries, approved as changed, rejection, reopening | **Platform** (tool-only operations) | Feeds pay; a person's act; audited |
| **Pay counts approved recorded hours** (the amendments below) | **Platform** (amends `staffing/pay.ts`, `operations/staffing-pay.ts`, ADR 0627; a migration) | Pay periods are the host's; no second totaller |
| **Leave types**, **requests**, **days**, the **balance ledger** | **Platform** (new core tables) | Personal (a sick day is health information), read by approvers and the person only |
| **Approved leave writes unavailability** and takes the person off shifts | **Platform** (amends ADR 0622's table; reuses `staffing.assign`'s and `staffing.offer`'s statements) | Reuses every roster rule about being away |
| **A job's time**, read by its readers | **Platform** (tool-only `staffing.time.forRecord`) | The Jobs pack reads it through its own tool; it never reads the table |
| Rostering: tools, settings, labels, notification words, the screens (web and native), its stage 47 screen declarations | **Pack** (Rostering, additions) | Composition |
| Jobs: `workedOn` on its job, a "time on this job" panel calling the host's read | **Pack** (Jobs, in its own stage) | Composition; Jobs does not require Rostering |

No new behaviour is hooked by a pack: entries and leave are host tables behind tool-only operations,
as pay is.

## The model

### Words

A **time entry** is one stretch of time a staff member worked: a start, a finish, unpaid break
minutes, against a shift, a job or nothing. **Clocked** when made by starting and finishing it;
**entered** when typed afterwards. A person's **timesheet** for a pay period is their time entries
in it (a view, not a record). A **difference** is where an entry and the roster disagree: early,
late, **not recorded** (a past shift of someone counted by time with no entry) or **unrostered**
(an entry with no shift). An **approver** is a rosterer. **Leave** is approved time off of a **leave
type** the business sets; a **leave request** asks for it; a **balance** is what the business says
a person has of a type. **Unavailable** stays as stage 45 defines it. _Avoid_: shift (the plan),
entitlement, accrual.

### Records

| Table | What |
| --- | --- |
| `core_time_entry` | account, starts, ends (null while open), break minutes, zone, local date (of its start, in the organisation's zone), against (object and record) or none, how (`clocked`, `entered`, `by_approver` with why), state (`open`, `waiting`, `approved`, `rejected`), finish missing (0 or 1), the recorded starts and ends kept when approved changed, approved by (an account, or `host` when it matched), approved at, rejected why, note, created at, updated at |
| `core_leave_type` | name, unit (`hours` or `days`), keeps a balance (0 or 1), below zero (`warn` or `refuse`, decision 9), paid (a label for the export only), active, order |
| `core_leave_request` | account, type, local start date and end date, or one date with a local start and end time, zone, state (`requested`, `approved`, `declined`, `cancelled`), note, asked by (the person, or an approver for them), decided by and at, why declined or cancelled |
| `core_leave_day` | request, local date, amount asked, amount approved (integers: minutes for an hours type, hundredths of a day for a days type) |
| `core_leave_balance_entry` | account, type, amount (signed, in the type's unit), why (`set`, `adjust`, `approved`, `cancelled`), the request if any, by, at, note. Insert only: the balance is the sum |
| `core_staff_away` (amended) | gains `leave_request` (null for unavailability a person said) |
| `core_pay_line` (amended) | gains columns, below |
| `core_pay_leave_line` (new) | a locked version's leave lines, below |

Amounts are integers. No money anywhere.

### States

Time entry:

| From | To | By | What happens |
| --- | --- | --- | --- |
| (new) | `open` | the person (start) | starts is the host's now; one open entry per person (a partial unique index) |
| `open` | `waiting` or `approved` | the person (finish) | ends is the host's now; break minutes as entered; approved by the host if it matches its shift within the tolerance (decision 5) |
| `open` | `open`, finish missing | the host, 4 hours after its shift's end, or 14 hours after its start with no shift | the person is told to enter their finish; **no finish is invented**; it cannot be approved until one is |
| (new) | `waiting` or `approved` | the person (entered), or an approver for them (`by_approver`, with why) | up to 14 days back (a setting), never into a locked period; the same match rule. An approver's entry for someone else is never approved by the host on match: it waits, and its maker may approve it (it is not their own time) |
| `waiting` | `approved` | an approver | as is, or **as changed** (the recorded times kept beside) |
| `waiting` | `rejected` | an approver, with why | the person is told; correcting it sends it back to `waiting` (or `approved` on match) |
| `waiting`, `rejected` | (deleted) | the person (withdraw) | only their own, before approval |
| `approved` | `waiting` | an approver (reopen, with why) | only while its pay period is open |

A person edits only their own entry, only before approval. No entry dated in a locked period is
created, changed or deleted, by anyone (a trigger).

Leave request: `requested` → `approved` (an approver) / `declined` (with why) / `cancelled` (the
person, before it is decided). An approved request may be **cancelled** by the person for dates not
yet started, or by an approver while its pay period is open: the away row is removed, the balance
entry reversed, and shifts it took them off are **not** put back (the rosterers are told and
reassign). An approver may record leave already approved for someone (a sick day phoned in):
`requestFor` with `approve`.

### Platform: recording time, against what

- **Start** (`staffing.time.clockIn { against? }`): with no `against`, the host proposes the
  person's own live shift that starts within 60 minutes or is under way, and the screen shows it
  with "not this shift". `against` may be one of their own live shifts, a live `workedOn` record, or
  nothing. The host's clock; a time in the request is ignored. A retried request with the same
  idempotency key makes one entry.
- **`workedOn`** on an object:

  ```ts
  workedOn: {
    live: ["scheduled", "in_progress"],   // states in which time may be recorded against it
    title: "name",                        // shown on the entry, the timesheet and the export
    kind?: "jobType",                     // a relation, shown as the export's kind
    place?: "site.suburb",
    readers: "jobs:manage",               // a permission of the same pack: who reads its time
    partOf?: "job",                       // on a staffed visit: the record its time also counts to
  }
  ```

  Shipped packs and the org's own extensions only; a runtime extension is refused (as `staffed` and
  `screens` are). Anyone who may record time may record against a live `workedOn` record; Jobs may
  narrow it to the job's crew with an optional `who` field list when its spec is agreed.
- **The seam with Jobs**: a job's time is `staffing.time.forRecord { object, id }`: each entry's
  person, date, minutes and state, and the total of approved minutes, for a caller holding the
  declared `readers` permission, a person (no AI in this stage). A staffed visit with `partOf` adds
  its entries to the job's total. **Jobs keeps no hours of its own**: any billing it adds (rate,
  billable, billed) sits beside the entry and names it, so colleagues' hours never reach a `rec_*`
  view. Billing is not in this stage.
- **Overlaps**: a `BEFORE INSERT` and `BEFORE UPDATE` trigger refuses an entry overlapping another
  of the same account (`time_overlap`, naming it), half-open ranges, every statement shape (as stage
  45 step 2's tests). An open entry overlaps everything after its start. Separate from the shift
  claim: an entry may run past its shift into the next shift's rostered time.
- **Who records**: anyone who holds Rostering's team tools may record time. Missing entries are
  flagged only for people counted **by time** (they are the ones pay counts from); a by-class coach
  or a salaried person may record (a job's hours) and is never flagged.

### Platform: differences

`staffing.time.differences { from, to, account? }` (tool-only, read; an approver, or the person for
their own): per entry against a shift, the start and finish difference in minutes, beyond the
tolerance or not; per past live covered shift of a person counted by time on or after the
recorded-hours date, **not recorded** when no approved or waiting entry is against it; per entry
with no shift, **unrostered**; an entry over 12 hours flagged. Set-based, at most 62 days a call.
Nothing about why, and nothing of anyone else for a person.

### Platform: pay counts approved recorded hours (amends ADR 0627 and stage 45)

**What is amended, exactly.** Stage 45's decisions 10 ("the host totals rostered hours") and 18
("what counts as worked is the roster as it stands when the period is closed") are amended for
people counted **by time**, from the date a business starts paying from recorded hours: what
counts is approved recorded time, with the roster counted, and flagged, where nothing was approved.
Decision 19 (set-up and pack-down count for pay) holds for roster-counted lines only. ADR 0627 gets
a dated amendment; ADR 0626 gets one for the new settings. In the code:

1. **The switch** (`recordedFrom`, a Rostering setting declared in its `staffing.settings`, read
   beside `payPeriodSettings` in `rosterers.ts`; a pay holder's, `personApproves`): a local date,
   empty by default (today's behaviour exactly). It may be set only to a date after the last stored
   (locked or reopened) period ends (`pay_period_held`, as `periodFor` places a changed period). A
   shift or entry dated before it is counted as today.
2. **`periodLines`** (`pay.ts`) gains, for each `by_time` shift dated on or after `recordedFrom`,
   its approved entries (one set-based read of `core_time_entry` by account and local date, for the
   period's accounts):
   - **a shift with approved entries**: one line, `source: entry`, `countedMinutes` = the sum of its
     entries' minutes (end minus start as instants, so a clock change counts the time really
     worked) less their break minutes; `beforeMinutes` and `afterMinutes` 0 (the entries cover
     set-up and pack-down); `rosteredMinutes` = shift plus before plus after, kept beside;
   - **a shift with no approved entry** (none, rejected or withdrawn): `source: roster`,
     `countedMinutes` as today (shift plus before plus after), and **`notRecorded: true`** (for
     review);
   - **a shift marked not worked**: counts nothing, as today; an approved entry against it sets for
     review;
   - **an approved entry with no shift, or against a `workedOn` record**: a line of its own,
     `source: entry`, `object` and `id` the `workedOn` record (or `core_time_entry` and the entry's
     id for other work), `kindName` the `workedOn` kind's name or "Other work", `title` its title
     or "Other work", `shiftMinutes` 0;
   - **by class** lines and evidence are unchanged; entries against classes are shown, never
     counted.
   An entry belongs to the period of its local start date, as a shift does.
3. **`PayLine`, `lineFromRow`, `lineInserts`** gain: `source` (`roster`, `entry`),
   `rosteredMinutes`, `recordedMinutes`, `breakMinutes`, `entries` (how many), `notRecorded`,
   `approvedBy` (names). Migration 1272 adds them to `core_pay_line` with `ALTER TABLE ADD COLUMN`
   and defaults that read every line already locked as `source: roster` exactly as before.
4. **Leave lines**: every approved leave day in the period of anyone (counted or not; payroll keeps
   salaried staff's leave too) is a leave line: name, email, local date, type, paid label, unit,
   amount approved, approved by. Stored at the lock in **`core_pay_leave_line`** (period, n, …),
   insert-only into a version being locked, never changed or deleted, with the same triggers as
   `core_pay_line`'s.
5. **`totalsOf`** is unchanged in shape: per person, basis and kind; `shifts` counts lines (an
   entry line with no shift counts one); minutes are the counted minutes. Leave is not in the
   totals (it is in its own section).
6. **The lock** (`staffing.payPeriod.lock`) is refused while any entry dated in the period is
   `open` or `waiting` (`time_waiting`, saying how many and whose, to the pay holder only), or a
   leave request with a date in it is `requested` (`leave_waiting`). **`periodFingerprint`** adds
   the period's entries (count and latest `updated_at`), its leave days and requests, the balance
   entries for them, and the `recordedFrom` setting. New triggers refuse every insert, update,
   replace and delete of an entry dated in a locked period, and of a leave request or day with a
   date in one.
7. **The export** (`payCsv`): when the business records no time and has no leave type, the file is
   **byte for byte as today**. Otherwise every existing column stays in place; the lines section
   gains at the end of each row: source, rostered minutes, recorded minutes, break minutes, not
   recorded, approved by; `for review` also says yes for a not-recorded line; and a blank row and a
   third section, **leave**, one row per leave day (name, staff email, date, type, paid, unit,
   amount). The same neutralising of formula cells.
8. **`staffing.myPay`** shows the person's own lines the same way, with their source, recorded,
   rostered and break minutes and not-recorded flag, and their own leave days; not who approved
   (another person's name, as it hides who took the list).
9. **Unchanged**: who is counted, the period and `periodFor`, `hoursOf`, reopening and versions,
   the shift lock triggers, the not-worked mark, the 10,000-line limit (entry lines count toward
   it), who reads pay, and that nothing is computed beyond summing minutes (decisions 2 and 3).
   Subtracting a break the person entered is arithmetic on what they entered, not a break rule: no
   break is ever added, required or rounded.

### Platform: leave

- **Types** are the business's (`staffing.leave.saveType`, a pay holder, `personApproves`). None
  ship and the screen suggests none: what types a business must offer is for it to confirm with its
  accountant or lawyer.
- **Request** (`staffing.leave.request`): the person picks the type and dates; the host proposes
  each date's amount from their rostered minutes that day (an hours type) or one day each (a days
  type), which they may change; it answers the balance after, and the shifts it covers. Refused
  into a locked period.
- **Approve** (`staffing.leave.approve { id, amounts? }`), one batch: the request `approved`
  (guarded: only from `requested`, so two approvals at once apply once), the day amounts as
  approved, the balance entry (when the type keeps one), the `core_staff_away` row (kind `leave`,
  its `leave_request`), and for each covered shift that has not started, the person taken off it
  and an offer to everyone eligible, through the same statements as `staffing.assign` and
  `staffing.offer` (decision 7). The rosterers get stage 45's notice with which shifts are still
  uncovered. A balance below zero warns or is refused as the type says (decision 9).
- **Balances** (`staffing.leave.setBalance`, `staffing.leave.adjust`, a pay holder, `humanOnly`,
  with a note): ledger entries. `staffing.leave.balances`: a pay holder or an approver reads
  everyone's; the person reads their own (decision 10).
- **Unavailability, amended (ADR 0622)**: `staffing.back` refuses to remove an away row that came
  from a request (cancel the request). Once the business has a leave type, `staffing.away` and
  `awayFor` no longer make new kind `leave` rows (a person says `other` or `regular`; leave is
  asked for); rows already made stay as they are.

### Operations

All are tool-only staff operations (callable only from Rostering's tools, the verified caller from
`calledBy`), audience **staff** only (ADR 0402). None is opened to customers or the public.

| Operation | Who may | Risk |
| --- | --- | --- |
| `staffing.time.clockIn`, `clockOut`, `enter`, `edit`, `withdraw` | the person, own only (`humanOnly`) | write |
| `staffing.time.mine { from, to }` | the person | read |
| `staffing.time.enterFor { account, …, why }` | an approver (`humanOnly`) | write (audited) |
| `staffing.time.waiting`, `staffing.time.differences` | an approver; the person for their own | read |
| `staffing.time.approve { ids, changes? }`, `reject`, `reopen` | an approver (`humanOnly`), never their own entry | write (audited) |
| `staffing.time.forRecord` | a person holding the record's `readers` permission | read |
| `staffing.leave.types`, `saveType` | everyone reads; a pay holder saves | read / write |
| `staffing.leave.request`, `cancel`, `mine` | the person (`humanOnly`) | write / read |
| `staffing.leave.requestFor`, `pending`, `approve`, `decline`, `cancelApproved` | an approver (`humanOnly`), never their own request | write (audited) / read |
| `staffing.leave.balances`, `setBalance`, `adjust` | a pay holder (approvers and the person read) | read / write (audited) |

The audit log keeps who did what to which entry or request, never a note, reason, amount or balance
(redacted, as stage 45's leave note and pay figures are); reads of balances and differences are
audited as reads (`auditReads`).

### Pack: Rostering (additions)

- **Tools** (team): `clockIn`, `clockOut`, `enterTime`, `editTime`, `withdrawTime`, `myTime`,
  `leaveTypes`, `requestLeave`, `cancelLeave`, `myLeave`, `myBalances`. (manage): `timeWaiting`,
  `differences`, `approveTime`, `rejectTime`, `reopenTime`, `enterTimeFor`, `leavePending`,
  `approveLeave`, `declineLeave`, `requestLeaveFor`, `cancelApprovedLeave`. (pay): `saveLeaveType`,
  `leaveBalances`, `setBalance`, `adjustBalance`. Every write tool `humanOnly`.
- **Settings** (each `personApproves`, declared in `staffing.settings` so the host reads them):
  staff record their time (`recordsTime`, off by default: nothing changes for a business that does
  not use it), the tolerance (`matchMinutes`, 5, 0 to 30), how far back time may be entered
  (`enterDays`, 14), when a finish is missing (`finishMissingHours`, 4), pay counts recorded hours
  from (`recordedFrom`, empty; a pay holder's).
- **Grantable labels**: `rostering:manage` gains "approve time and leave", `rostering:pay` "leave
  types and balances". The team role's description gains "records their time and asks for leave".
- **Notifications** (in-app through the roster's notices, `queueNotice`; email by preference;
  staff only, nothing to a member; push and text wait for stage 30):

| Event | Told |
| --- | --- |
| Entries waiting (a daily summary at 07:00 local, not one per entry) | approvers |
| Finish missing; an entry rejected or approved changed | the person |
| A leave request | approvers |
| Leave approved, declined, or an approved one cancelled | the person; rosterers for a cancel |
| Approved leave took someone off shifts | rosterers (stage 45's notice, with the shifts offered and those still uncovered) |
| A balance set or adjusted | the person |

### Screens

Declared as stage 47 pack screens in the product's admin (web) and as native blocks in the app. No
block decides a difference, a balance or who may approve; the block lint
(`scripts/check-blocks.mjs`) passes.

| Where | Who | What |
| --- | --- | --- |
| Native and web: **My time** (new) | the person | Start and finish (the shift proposed, "not this shift", a job, other work), break minutes, my entries this period with their state, enter time afterwards, fix a rejected one |
| Native and web: **My time off** (existing, gains a section) | the person | Ask for leave (type, dates, amounts proposed), my requests, my balances; saying when I cannot work stays as it is |
| Web: **Time to approve** (new) | approvers | Entries waiting, by person, each with its differences; approve, approve changed, reject |
| Web: **Differences** (new) | approvers | The roster beside what was recorded for a range: late, early, not recorded, unrostered |
| Web: **Time off** (existing, gains a section) | approvers | Leave requests waiting with the balance after and the shifts covered; approve (saying what happens to the shifts), decline; everyone's approved leave by week |
| Web: **Leave types and balances** (new) | pay holders | Types; each person's balance per type with its history; set and adjust |
| Web: **Pay** (existing) | pay holders | Gains each line's source, not-recorded flags, what blocks a lock, the leave section |
| Job page (Jobs, its stage) | the job's readers | Time on this job (Jobs' block, the host's read) |

Nothing here is customer-facing: My account (stage 48) gains no section from this stage.

### What an AI may do

| Action | Under `balanced` |
| --- | --- |
| Start, finish, enter, edit or withdraw time; ask for or cancel leave | refused: a person's own act |
| Approve, reject or change time; approve or decline leave | refused: a person only, at the screen |
| Read anyone's entries, differences, leave or balances, its own person's included | refused (as pay and others' leave are) |
| Draft a leave type's name | waits for a pay holder's approval (`personApproves`) |
| Read a job's time through Jobs | not in this stage |

### Privacy, erase and retention

- **Who sees what**: a person sees their own entries, requests and balances; approvers see
  everyone's entries, differences, requests and balances; pay holders see all of it; other staff see
  nothing, not even that someone is on leave (the roster shows them off their shifts and the shifts
  offered, as it already does). A job's readers see time on that job only: person, date, minutes
  and state, never a note.
- **Notes**: a leave note may say why (a medical reason). It is redacted from the audit log, never
  in a notice, an error or a tool run's stored output, and kept from the assistant. Attachments (a
  certificate) are deferred.
- **Nothing in a `rec_*` view**: no dashboard, `query.sql`, `export.csv` or record read reaches
  these tables.
- **Leaving**: `user.deactivate` (`leaveRoster`) also marks an open entry finish missing, cancels
  requested leave, and leaves approved entries, approved leave and balances as they are.
- **`staffing.forget`** (stage 45, not built) gains: deletes notes, requests not approved and
  entries not approved; keeps approved entries, approved leave and balance entries in or before
  locked periods, as payroll records. How long the business must keep them is for it to confirm
  with its accountant.

## Out of scope

- Any pay rule: rates, overtime, penalty or holiday rates, minimum engagement, break rules,
  rounding, allowances (decision 2).
- Accrual and entitlements; public holidays; leave loading; what leave types a business must offer
  (for the business to confirm with its accountant or lawyer).
- Payroll connections: the CSV is the hand-off.
- Location or a fence at start, photos, offline clocking (decision 11).
- A supervisor recording a crew; a shared tablet clocking staff in (an enrolled shared device is
  stage 51's, Kiosk check-in; the seam would be `staffing.time.clockIn` with that device as the
  caller, not built here).
- Job costing and billing time to customers (Invoices, stage 35; Jobs, stage 39); a job's time read
  by an AI.
- Leave attachments, leave for a whole team, half-day presets, leave across a locked period.
- A native approver's screen; push and text notices (stage 30).

## Acceptance criteria

1. **Recording**: a person starts and finishes from the app and the web; the times are the host's
   (a request carrying a client time is ignored); a second start while one is open is refused;
   twenty starts at once leave one open entry; a retried start with the same idempotency key makes
   one entry.
2. **Overlaps refused**: two entries of one account that overlap are refused (`time_overlap`) by
   every path, including raw `INSERT OR REPLACE`, upserts and `UPDATE OR REPLACE`; back to back is
   allowed; an entry over a different shift's rostered time is allowed.
3. **Finish missing**: an entry left open past the setting is marked finish missing, the person is
   told, no finish is written, and it cannot be approved until one is entered.
4. **Against what**: an entry may be against the person's own live shift, a live `workedOn`
   record, or nothing, and is refused against another person's shift, a cancelled shift, or a
   record of an object that does not declare `workedOn`; a runtime extension declaring `workedOn`
   is refused.
5. **Differences** match a fixture worked out by hand: early, late, within the tolerance, not
   recorded, unrostered, over 12 hours, across midnight and a clock change.
6. **Approval**: only an approver approves, never their own entry; approved changed keeps both sets
   of times; rejection tells the person and their correction returns it to waiting; an entry
   matching its shift within 5 minutes is approved by the host and recorded as the host's; an entry
   with no shift always waits.
7. **Pay, unchanged until switched**: with `recordedFrom` empty and no leave type, every existing
   test in `packages/core/test/staffing-pay.test.ts` passes unchanged and the CSV is byte for byte
   as before; lines locked before migration 1272 read back as before.
8. **Pay, from recorded hours**, matches a hand-worked fortnight: an hourly cleaner with entries
   matching, late and approved changed; a shift not recorded (counted as rostered with its set-up
   minutes, flagged); a job entry with no shift; a break subtracted; a per-class coach whose entries
   change nothing; a shift marked not worked with an entry; set-up minutes not added to recorded
   lines; a shift before `recordedFrom` counted from the roster; leave days for an hourly and a
   salaried person. The lock is refused while an entry or leave request waits; after it, an entry,
   a leave request or day and a balance entry in the period refuse every change, by every
   statement shape; reopening and locking again gives the same lines unless something was changed.
9. **Own totals**: `myPay` for the cleaner equals the pay holder's lines for them, with no approver
   name; nothing of anyone else.
10. **Leave**: a request proposes amounts from the roster; approval in one batch writes the balance
    entry, the away row and the shift changes (decision 7); the stage 45 `unavailable` warning and
    eligibility follow; `staffing.back` refuses the request's away row; cancelling an approved
    request reverses the balance and removes the row but puts no one back on a shift; a balance
    below zero warns or is refused as its type says; two approvals at once apply once.
11. **Balances**: the balance is the ledger's sum; only a pay holder sets or adjusts; nothing
    accrues.
12. **Privacy**: another staff member reads none of a person's entries, requests or balances; no
    table is in a `rec_*` view, `query.sql`, a dashboard or `export.csv`; no note, amount or balance
    is in the audit log, a notice or an error; an assistant and MCP are refused every tool above,
    whatever is granted.
13. **Jobs seam**: a test pack declaring `workedOn` (and a staffed visit with `partOf`) gets entries
    against its records and `forRecord` totals, read only with its declared permission.
14. **Cost**: a period's totals and lock with 10,000 lines and a year of entries read the period's
    rows only (a statement-count test beside `staffing-pay-cost.test.ts`).
15. `pnpm lint typecheck test`, `cos ext check` and `cos ext test` on `packs/rostering`, the block
    lint, and one e2e test per journey (a cleaner records a shift and the owner approves it with a
    difference; a coach asks for leave, the owner approves it and the shifts are offered; a pay
    period from recorded hours locked and exported); ADRs written; `CONTEXT.md` (time entry,
    timesheet, leave, balance; the "Avoid: timesheet" note on Pay period revised) and
    `docs/architecture.md` updated; `apps/marketing/SITE.md` checked.

## Dependencies

- **Stage 45** steps 2 to 7 (built): shifts, unavailability, offers, pay periods, the Rostering pack.
- **Stage 47** (being built, PR #303): the web screens appear in the admin once it merges; until
  then they mount on `/blocks` like stage 45's.
- **`staffing.forget`** (stage 45, not built): this stage adds to its list; whichever builds second
  includes the other's tables.
- **Stage 39, Jobs** (not specced): declares `workedOn` and refers to this stage's time entry. This
  stage ships first with a test pack; the Jobs spec must use the declaration's shape above (or amend
  it here) before either builds the seam.

## Migrations and numbers

Block **BT**: migrations 1270 to 1289, ADRs 0850 to 0859.

| Migration | What |
| --- | --- |
| 1270 | `core_time_entry`, the overlap triggers, the one-open-entry partial unique index, indexes by account and local date and by against |
| 1271 | `core_leave_type`, `core_leave_request`, `core_leave_day`, `core_leave_balance_entry` (insert only); `core_staff_away.leave_request` |
| 1272 | `core_pay_line`'s new columns (defaults reading old lines as roster lines); `core_pay_leave_line` and its insert-only triggers; the lock triggers on entries, leave requests and days |

| ADR | Decision |
| --- | --- |
| 0850 | Time entries: one record of time worked, the host's clock, overlaps refused by the database; `workedOn` and the Jobs seam |
| 0851 | Differences from the roster and approval: the tolerance, approval on match, approved as changed, nobody their own |
| 0852 | Pay counts approved recorded hours: the switch date, lines from entries, not recorded counted and flagged, leave lines, the lock's refusals, the export's added columns. Amends ADR 0627 and ADR 0626 (settings), with dated notes; records the amendment of stage 45 decisions 10 and 18 |
| 0853 | Leave: types, requests, days and the balance ledger; approved leave written as unavailability and taking the person off shifts. Amends ADRs 0622 (the away row, `staffing.back`), 0624 (leaving) and 0629 (the screens) |

## Suggested build order

| Step | What | Files it touches | Beside |
| --- | --- | --- | --- |
| 1 | **Time entries**: the table, overlap trigger, open-entry index, start and finish, enter, edit, withdraw, finish missing on the cron; `workedOn` in the SDK | `packages/core/src/staffing/time.ts` (new), `operations/staffing-time.ts` (new), `staffing/due.ts`, `packages/sdk/src/worked-on.ts` (new), `packages/sdk/src/manifest.ts`, migration 1270 | Beside step 4 and anything outside `staffing/`. `manifest.ts` collides with any other declaration being added (stage 47's `screens`, Jobs): merge in order |
| 2 | **Differences and approval**: tolerance, approval on match, approved changed, reject, reopen | `staffing/time.ts`, `staffing/sets.ts` | After 1; beside 4 |
| 3 | **Pay**: `recordedFrom`, lines from entries and leave, the lock's refusals and triggers, export columns, `myPay` | `staffing/pay.ts`, `operations/staffing-pay.ts`, `staffing/rosterers.ts`, migration 1272, `packs/rostering` settings | After 2 and 4. **Collides** with any other work on `staffing/pay.ts`, `staffing-pay.ts` or the pay lock's triggers: run alone there |
| 4 | **Leave**: types, requests, days, the ledger, approval writing `core_staff_away` and the shift changes; `staffing.back` and `staffing.away` amended; leaving | `staffing/leave.ts` (new), `operations/staffing-leave.ts` (new), `operations/staffing.ts`, `staffing/offers.ts`, `staffing/leaving.ts`, migration 1271 | Beside 1 and 2. Touches `staffing.ts` and `leaving.ts`: not beside other work on the roster's operations |
| 5 | **Rostering's tools, settings, labels, notification words** | `packs/rostering/index.ts`, `tools.ts`, tests | Each step adds its own tools; merge in order, as `index.ts` collides |
| 6 | **Screens**: My time; leave in My time off and Time off (web and native); Time to approve, Differences, Leave types and balances, Pay's additions (web); stage 47 declarations | `packs/rostering/blocks`, `packs/rostering/client`, the pack's `screens` | After 5; beside Jobs' screens. If stage 47 has not merged, mount on `/blocks` |
| 7 | **The Jobs seam**: a test pack with `workedOn` and `partOf`; `forRecord` | `packages/core/test`, `staffing/time.ts` | After 1; beside everything else |
| 8 | **The first client**: how it records hours and leave today checked (decision 13), leave types and opening balances entered, a fortnight recorded, the export checked by the owner and their payroll | the client's repository | After 6 |

No step touches `orders/`, `subscriptions/`, the email gatekeeper, `pack-roles.ts` or
`core_write_guard` (guarded updates and triggers, as stage 45's).

## Size

**Large**: five new core tables and two amended, a new declaration, an amendment to pay and its
lock, and six new or extended screens. **Up to three build sessions at once**: time (steps 1, 2),
leave (step 4) and the Jobs seam (step 7); pay (step 3) alone after them; then the screens.

## Decided by this spec, open to override

- **One time-entry record** for shifts and jobs (Jobs keeps no hours); entries and leave are core
  tables in no `rec_*` view, behind Rostering's tools.
- **The host's clock is the record**: exact minutes, no rounding; break minutes as entered and
  subtracted; no finish ever invented.
- **Pay from recorded hours starts at a date** the pay holder sets after the last locked period
  (`recordedFrom`, empty by default), so a business can try recording before pay depends on it and
  nothing locked moves. Recording itself is off until switched on.
- **Only people counted by time are flagged** for a shift not recorded; anyone with the team's tools
  may record.
- **Set-up and pack-down minutes are not added to recorded lines** (the entry covers them); a
  roster-counted line keeps them.
- **One pay line per shift** with its approved entries summed (so `shifts` stays a count of
  shifts); an entry with no shift is its own line.
- **The lock waits for every entry and leave request dated in the period**, anyone's, so nothing
  frozen by the lock is left undecided.
- **Leave lines have their own locked table** (`core_pay_leave_line`), not `core_pay_line`.
- **The export is byte for byte as today** for a business that records no time and has no leave
  type; otherwise columns are appended and a leave section added.
- **Leave sits in the existing time-off screens** (My time off, Time off) rather than new ones.
- **Once a business has a leave type, new kind `leave` unavailability comes only from requests.**
- **Nobody approves their own entry or leave**, except an admin when no other person may approve:
  then it is approved by themselves and the export's "approved by" says so.
- The numbers: start proposes a shift within 60 minutes; finish missing after 4 hours past the
  shift (14 hours with none); entering back 14 days; an entry over 12 hours flagged; a daily
  summary to approvers at 07:00.
- **An AI has no part** beyond drafting a leave type's name.

## Questions for the owner

None. The interview's one question is decision 1; the rest were decided as best practice (decisions
5 to 13) and above.

## Risks

- **Money and payroll**: paying from recorded time changes what people are paid. It takes effect
  only from a date after the last locked period; the unchanged path must be proved byte for byte
  (criterion 7); new columns are appended, to be checked against the client's payroll import.
- **Leave and the law**: what leave a business must give, how it accrues and a day's hours are for
  the business to confirm with its accountant or lawyer; no screen suggests types or amounts.
- **Privacy**: a leave note can carry health information. Pay's guards (no views, redaction, no AI)
  are the minimum; the isolation and AI-refusal tests walk every new tool.
- **Trust in the clock**: a person can start from home; approval and differences are the only check
  (decision 11). What staff must be told about how their time is recorded is for the business to
  confirm with its lawyer.
- **Needs a real device and a real client**: a retried start on a weak connection must not make two
  entries, tried on a real phone; the native screens on phones; a real fortnight checked by the
  owner and their payroll.
- **One seam with Jobs**: the Jobs spec is not written; it must take this stage's time entry, not
  define hours of its own.
