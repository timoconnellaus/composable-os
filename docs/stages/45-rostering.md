# Stage 45: Rostering

Read first: [`AGENTS.md`](../../AGENTS.md), [`docs/architecture.md`](../architecture.md) (Behaviours,
Packs and blocks, Identity), [`CONTEXT.md`](../../CONTEXT.md), ADRs
[0402](../adr/0402-staff-and-customers.md), [0404](../adr/0404-behaviours-are-the-vocabulary.md),
[0405](../adr/0405-skills-ship-with-the-platform.md), [0436](../adr/0436-pack-roles-and-the-door-role.md),
[0437](../adr/0437-a-move-is-made-from-a-current-read.md), [0449](../adr/0449-permissions-granted-one-by-one.md),
[0451](../adr/0451-role-clients-staff-in-the-mobile-app-and-browser-calls.md),
[0455](../adr/0455-staff-invites-and-native-sign-in-by-tokens.md),
[0500](../adr/0500-recurring-a-weekly-rule-in-local-time.md) to
[0505](../adr/0505-window-numbers-through-two-relations-and-settings.md),
[0552](../adr/0552-a-tool-a-person-approves.md), [0553](../adr/0553-attendance-the-coach-role-moves-and-cancelling-a-class.md),
[0571](../adr/0571-a-calendar-file-made-by-the-email-gatekeeper.md) and
[0572](../adr/0572-bookings-messages-the-dashboard-and-the-coachs-app-screen.md);
[0600](../adr/0600-a-pack-role-and-its-grants-add-up.md) (a pack role and its grants add up, issue
[#258](https://github.com/timoconnellaus/composable-os/issues/258), merged as PR #263);
[0620](../adr/0620-field-level-exceptions-in-recurring.md) (field-level exceptions, this stage's
step 1); stage [31](31-bookings.md) (all of 31a, and 31b's time-range claim); `packages/core/src/recurring/`, `packages/core/src/pack-roles.ts`,
`pack-role-today.ts`, `packages/core/src/operations/notification.ts`, `operations/user.ts`,
`operations/export.ts`, `packages/core/src/extensions/tools.ts`, `packs/bookings` (`index.ts`,
`tools.ts`, `automations.ts`, `dashboards.ts`), `packages/gatekeeper-email-send/src/calendar.ts`.

Status: **spec agreed** (owner interviewed 2026-11-23 and answered the open questions the same day:
decisions 14 to 25). Build step 1, field-level exceptions in `recurring`, is built
([ADR 0620](../adr/0620-field-level-exceptions-in-recurring.md), migration 0810). Build step 2,
`staffed` and the time claim, is built ([ADR 0621](../adr/0621-the-staffed-behaviour-and-the-time-claim.md),
[ADR 0622](../adr/0622-warnings-in-a-writes-answer.md), migration 0811; see "Built in step 2"
below). Build step 3, qualifications, unavailability, offers and takes, uncovered shifts, the
notices and leaving, is built ([ADR 0623](../adr/0623-offers-and-takes-the-race-and-the-cut-off.md),
[ADR 0624](../adr/0624-the-rosters-notices-uncovered-shifts-and-leaving.md), migration 0812; see
"Built in step 3" below). Build step 4, restricted pack permissions, the `rostering.team` role
and the Rostering pack's spine, is built ([ADR 0625](../adr/0625-restricted-pack-permissions.md),
[ADR 0626](../adr/0626-the-rostering-pack-and-bookings-additions.md), no migration; see "Built in
step 4" below). Build step 6, pay periods (who is counted, totals with evidence, the not-worked
mark, the lock, reopening and the export), is built ([ADR
0627](../adr/0627-pay-periods-the-basis-the-totals-the-lock-and-the-export.md), migration 0813; see
"Built in step 6" below). Build step 7, the screens as blocks (web and native), role clients with
grants and `cos rostering import`, is built ([ADR
0629](../adr/0629-the-rosters-screens-role-clients-with-grants-and-the-roster-import.md), no
migration; see "Built in step 7" below). Builds on stage
31a (built) and ADR 0600 (merged). Replaces the roadmap's placeholder stage 40 (Rosters), which was
never specced. Where this spec guesses, it says **(guess)**.

## Goal

A business keeps its roster on its host. The owner sets the regular week once: a named coach takes
Monday's 06:00 class, the cleaner cleans on Tuesday and Friday evenings, a coach does the Saturday
clean after the last class. The host keeps that pattern going, week after week. The owner edits the
exceptions. Staff see their own shifts in the app and in their phone's calendar. They say when they
are away. They offer a shift they cannot work, and another qualified person takes it without
anybody approving; the owner is told. The host refuses to put one person in two places at once and
warns about the rest: someone away, someone not qualified for a class type, a class with no coach.
For staff paid by the hour or by the class, the host totals each pay period and exports it for
payroll. Members see what they see today: the coach's name on each class.

## What exists today (from the code)

- **`recurring`** (ADR 0500, `packages/core/src/recurring/`, `operations/recurring.ts`). A series
  declares `recurring: { generates, link, rule, into, copy, cancel, ended?, closures?,
  horizonDays?, horizonAtLeast? }`. The rule is weekly only, in local wall-clock time. The minute
  cron makes each due series' records ahead, up to the horizon (56 days by default), as the host.
  Each is keyed in `core_recurrence_occurrence` on the series and its local date, so it is made
  once. `generates` must be another object of the same extension. Until step 1, **an edit to a
  made record's times, zone, copied fields or state by anyone but the host marked the whole record
  `changed`**, and the series never wrote to it again: one coach swapped on one date detached that
  class from every later change to its series (room, places, time). **Step 1 changed that** (ADR
  0620, below): a copied field changed by hand is now a field exception, and only a change of
  time, zone or state detaches the whole record. `recurring.change { from }` applies a series
  change from a date; a change that moves records with places taken needs the count confirmed.
- **Bookings** (`packs/bookings`, stage 31a). `bookings.coach` is a public profile (name, photo,
  bio) with an optional `user` field: the staff account, "if they have one (a visiting coach may
  not)". `bookings.series` and `bookings.class` each have a `coach` relation to it; the series
  copies its coach onto each class. There is no tool to swap a coach: staff edit `class.coach`, and
  members are not emailed (decision 16 of stage 31; `classChanged` sends nothing for a coach). A
  class has `startsAt`, `endsAt` (required), `timezone`, `room`, a class type (Programs'
  `programs.classtype`, on which Bookings adds its booking rules) and states `scheduled`,
  `cancelled`, `done`. The pack requires Programs.
- **The coach pack role** (`bookings.coach`, ADRs 0436 and 0553): the tools `day`, `roster` (the
  class list), `markAttended`, `undoAttended`, `markNoShow`, `markAll`, and reading classes. It
  reaches **today only** (`pack-role-today.ts`), and every class today, not only the coach's own.
  **The word `roster` is already Bookings' tool for a class list**; this stage does not reuse it as
  a tool name.
- **Pack roles and grants** (ADRs 0436, 0449 and 0600, merged). An account holds at most one pack
  role (`core_user.pack_role`), which replaces its role. ADR 0600 makes a pack role and its grants
  add up: a pack-role account may be granted any **pack** permission a shipped pack declares
  `grantable` (`bookings:desk`), never a core permission; a permission a role holds cannot be
  grantable; a tool may name several permissions (`day` is `["bookings:coach", "bookings:desk"]`);
  the role's today limit applies only to calls that come through the role; a tool that both a role
  and a grantable permission open sets `grantLiftsRoleLimits` when the grant should lift the role's
  limits (the review's fix, merged with it).
- **Every ordinary staff role holds every pack tool.** A tool's core permission is `records:write`
  (or `records:read` for a read tool, `extensions/tools.ts`), which members hold; a pack permission
  only adds a way in. So there is today no pack tool that a member does not hold. Pay totals need
  one (below).
- **Staff accounts** (`core_user`: role `admin`, `member` or `viewer`, `pack_role`,
  `granted_permissions`, `deactivated_at`). A staff account is not a Person. Invites carry a role,
  pack role and grants (ADR 0455). **There is no staff erase**: `user.deactivate` ends sessions and
  connections, and records keep pointing at the deactivated account. Extensions cannot read users;
  a pack that needs a name keeps a copy (`usedByName`).
- **Native staff surfaces**: the coach's class list (`bookings-native-class-list`), the door
  scanner, Programs' coach blocks. The mobile app gets a typed client per **pack role**
  (`product.ts` `mobile.roles`, ADR 0451); an account's grants have no client of their own.
- **Notifications** (`core_notifications`, `notification.send`, delivery by preference to email or
  Slack by the minute cron). Recipients: a user, `admins`, a user field on the record, `actor`. This
  is staff mail, not member mail.
- **Calendar files**: only email-send's attachment (ADR 0571, `calendar.ts`, times in UTC, one
  event). No feed, `webcal` address or token route exists anywhere.
- **Dashboards** read `rec_*` views; `export.csv` exports any object's records to anyone with
  `records:read`. Anything in a `rec_*` view is readable by every staff account with
  `records:read`, by SQL and by the assistant.
- **Declared uniqueness** (ADR 0502) is a partial unique index. **No time-range claim exists**:
  31b's "no two appointments of one coach overlap" is specced, not built.
- **Routine mail** (`feat/routine-mail`, in flight) is a member-facing kind: the host writes to a
  record's customer Person. Nothing in this stage writes to members, so it does not depend on it.

## Decided at the interview (2026-11-23)

| # | Decision |
| --- | --- |
| 1 | Today the roster is kept in the business's current booking system, so it moves to the platform with everything else. The move is stage 33; this spec says what the roster needs from it |
| 2 | **What is rostered**: which coach takes each class on the timetable, and **shifts that are not classes** (cleaning: a duty with a time and a person). A cleaner is rostered, and coaches do some cleaning and are rostered for it. Rostered staff need not be coaches. The first client has no front desk |
| 3 | **A regular pattern repeats every week** (a named coach takes Monday 06:00); someone edits the exceptions |
| 4 | **Staff themselves**: see their own shifts in the app and add them to their calendar; say when they are unavailable (leave, a regular afternoon off); offer a shift for someone else to take; take an offered shift |
| 5 | **Nobody approves a swap**, as long as the person taking it may coach that class type. The manager is told |
| 6 | **The system knows who may coach which class types**, and only offers a shift to people who can take it |
| 7 | Outside commitments are ignored for now: no connection to the calendars or practice systems some staff use elsewhere |
| 8 | A shift does not block time in any outside system; that comes later with proper integrations |
| 9 | **Warnings**: someone rostered while unavailable; a class with no coach; someone not qualified for the class type. **Warn rather than refuse, except double-booking one person, which is refused** (the coordinator's recommendation, accepted) |
| 10 | **Pay**: staff are salaried, part-time or hourly, so the roster feeds a pay period for some people, not all. Recorded reading: each staff member is marked as **counted by time, counted by class, or not counted**; the host totals rostered hours and classes per pay period for those counted and exports them for payroll. **It holds no pay rates, calculates no pay and runs no payroll.** Rates: none (decision 14) |
| 11 | **All staff see everyone's shifts**; members see only the coach on each class |
| 12 | **Members are not emailed when a class's coach changes**; the timetable shows the new coach (as Bookings already behaves) |
| 13 | Start now, in parallel with the rest |

### The owner's answers to the open questions (2026-11-23)

| # | Decision | Was |
| --- | --- | --- |
| 14 | **The system holds no pay rates.** It totals hours and classes per pay period for those counted; payroll applies the rates | question 1, (a) |
| 15 | **A duty shift can carry an optional checklist the person ticks off.** The owner's reasoning: "Part of the point of this software is to make it easy to run the business. So checklists are great, a bit like [a fast-food chain] runs their back of house. It makes automating the business easier." Built as **its own small reusable piece**, not a cleaning feature (below, "Checklists"): duty shifts ship first with a time and a person, and the checklist is the next step without holding the roster up. The coordinator's proposal, put to the owner, who did not object | question 2, (b), as a reusable piece |
| 16 | **Who rosters: the owner and any admin.** A separate permission, `rostering:manage`, exists so it can be given to someone else later; it is granted to nobody to begin with | question 3, (b) |
| 17 | **The regular pattern is made into actual shifts 8 weeks ahead**, as classes are | question 4, (a) |
| 18 | **What counts as worked for pay: the roster as it stands when the pay period is closed** (after corrections), with the class list's ticks shown beside it as evidence | question 5, (a) |
| 19 | **Set-up and pack-down time is possible but optional**: a number of minutes per class type, default 0, that adds to pay hours only and never makes two classes clash | question 6, (b), optional |
| 20 | **The pay period is fortnightly.** The period and its start day are a setting, defaulting to fortnightly | question 7 |
| 21 | **A shift can be offered and taken in the app until 1 hour before it starts** (a setting, default 60 minutes) | question 8, (a) |

The checklist design's four open points, put to the owner afterwards (2026-11-23):

| # | Decision | Was |
| --- | --- | --- |
| 22 | **No photos for now.** A step is a tick and an optional note only | the design's photo steps |
| 23 | **Who sees how checklists went** (done, missed, and who was on the shift): the person themselves, and people who can roster (the owner and admins). Not all staff. A host-enforced read rule | the design's "staff records" |
| 24 | **Ticking on someone's behalf: yes**, by people who can roster, with a reason, recorded as "ticked by X for Y" (both kept, never shown as the shift person's own tick) | the design's proposal |
| 25 | **The assistant may draft a template**; a person approves it before it is used | the design's proposal |

## The design in one page

**The rules are a platform behaviour, `staffed`; the screens and duties are a Rostering pack.** A
record that declares `staffed` is a **shift**: a time, a kind of work, and at most one staff account
working it. Bookings' class declares it (its coach is the person; its class type is the kind).
Rostering's own duty shift declares it (its staff field is the person; its duty is the kind). 31b's
appointment will declare it too. The host does what must hold for every actor: it refuses a second
shift that overlaps one person's time, in the database; it works out the warnings; it carries
offers and takes; it keeps who may do which kind of work, who is away, and who is counted for pay.

**The class's coach stays the one source of truth.** There is no second "class shift" record. The
roster shows the class itself; a swap writes the class's `coach`; the timetable members see is what
it was. The series' coach is the class's pattern, as it is today.

**Duties that are not classes** (cleaning, opening up) are the Rostering pack's: a duty, a duty
series (`recurring`) with its regular person, and the duty shifts it makes. The Rostering pack does
not require Bookings, so a business with shifts and no classes uses it alone, and a cleaner is not
a coach.

**People are staff accounts.** Everyone rostered has a staff account, because everyone sees their
own shifts. The cleaner's account holds a new pack role, `rostering.team`: the roster and their own
shifts, nothing else. A coach keeps the `bookings.coach` role and is granted Rostering's
`rostering:roster` (ADR 0600: roles and grants add up), so they see every future shift without the
today limit reaching any member's data.

**Pay totals are kept out of everything staff read in bulk.** Who is counted, and the locked totals
of each pay period, are core tables in no `rec_*` view, read only through tools that need a
restricted permission held by admins and by grant. No rates or amounts are held (decision 14).

**A duty shift may carry a checklist** (decision 15): a reusable platform piece, not part of
cleaning. A business writes a checklist once, attaches it to a kind of work, and each shift of that
kind gets a run of it that its person ticks off; what was and was not done is kept, never changed
once done, for the business to see and later automation to act on.

### What was weighed and rejected

| Option | Why not |
| --- | --- |
| **Everything in the Bookings pack** (duty shifts as a kind of class) | A cleaner is not a coach and a clean is not a class: it has no places, bookings, booking windows or public timetable. Bookings requires Programs, so a business with shifts only would install two packs it does not use. And the clash rule spans classes and duties, which one pack's code cannot hold without hooking writes |
| **A Rostering pack that requires Bookings** | Precedent exists (Bookings requires Programs), but decision 2 names shifts that are not classes, and a business with no classes would carry a public timetable and booking rules for nothing |
| **A "class shift" record per class**, holding the coach, mirrored onto the class | Two copies of who coaches. Members read the class; a mirror needs a pack hooking writes, or a platform copy that can disagree. One field is the truth |
| **The rules in the Rostering pack's tools** (a tool checks for a clash before it writes) | A read before a write is not a guarantee: two takes at once both read "free". Staff edit `class.coach` with `record.update`, the assistant and an import write too; a rule in a tool binds none of them. Rules live in the host (ADRs 0404 and 0405) |
| **Qualifications on Bookings' coach profile** (a list of class types) and on each duty | Two places and two shapes, and the offer's "who may take this" would be a different query per pack. One host table, keyed by account and kind, answers it for every staffed object |
| **Unavailability and pay basis as Rostering records** | Records are in `rec_*` views: every member with `records:read` would read colleagues' leave and who is hourly by SQL, exports and the assistant. Core tables are in no view (stage 44 did the same for agreements) |
| **Core operations with core permissions** for the roster | ADR 0600 lets a pack-role account (a coach) be granted pack permissions only, never core ones. So the operations a person calls are Rostering's tools with grantable pack permissions; each calls a tool-only host operation that holds the rule (as `x.bookings.buy` calls `order.startHeld`) |
| **Each change emailed as a calendar file** | A file per change, each an outbound email; the regular pattern is never in it; a missed email leaves the calendar wrong. A private feed always shows the current roster (below) |

## What is platform work and what is pack work

| Piece | Platform or pack | Why |
| --- | --- | --- |
| The **`staffed`** behaviour: the person, the time, the kind, the states in which it is a shift | **Platform** (new behaviour, ADR 0404's row) | Classes, duty shifts and 31b's appointments share it; no pack hooks writes |
| The **time claim**: one staff account's shifts never overlap, refused by the database | **Platform** (new; is 31b's time-range claim) | Must hold for every actor and under races |
| **Warnings** (away, not qualified, uncovered) in the write's answer and a dry run | **Platform** | The same answer whoever writes |
| **Field-level exceptions** in `recurring`: a swapped coach detaches only the coach field | **Platform** (amends ADR 0500) | Without it, every swap freezes a class against its series |
| **Offers and takes**, the race, the cut-off, lapsing | **Platform** (`core_staff_offer`, host writes of the person) | Exactly one take, enforced in the database, for any staffed object |
| **Qualifications, unavailability, pay basis, pay periods, feed tokens** keyed by staff account | **Platform** (core tables, in no `rec_*` view) | About staff accounts, which extensions cannot read; personal; read by the host's rules |
| The **roster read** across every staffed object | **Platform** (tool-only host operation) | No pack may read another it does not require |
| A **restricted** pack permission: held by admins and by grant only | **Platform** (small; amends ADRs 0436 and 0449) | Today every member holds every pack tool; pay must not be one |
| The **calendar feed** route and the shared calendar writer | **Platform** (HTTP route; ADR 0571's writer moved to a shared module) | A token route is the host's; the format is written once |
| Leaving: future shifts made uncovered on deactivation | **Platform** (`user.deactivate`) | A core operation |
| Bookings: the class declares `staffed`; one coach profile per account; `personApproves` on the coach fields; prep and pack-down minutes on the class type; uncovered classes on its dashboard | **Pack** (Bookings, additions) | Composition |
| Rostering: duties, duty series, duty shifts, the `rostering.team` role, tools, settings, notifications' words, the dashboard, hooks and blocks | **Pack** (`packs/rostering`, new) | Composition |
| **Checklists**: templates and their steps, a run attached to a record, ticks, a completed run kept unchanged, the `checklists` declaration | **Platform** (new, small; core tables) | Reusable by any pack (a duty first; a class type, an event, a new member's first week later) without a pack depending on another, and its rules (who ticks, nothing changes once done) must hold for every actor |

## The model

### Words
A **shift** is a time someone works: a class (its coach works it) or a **duty shift** (cleaning,
from 18:00 to 19:00, by the person on it). The **roster** is every shift in a range, with who works
each. A shift is **covered** when it has a person and **uncovered** when it has none. The **pattern**
is the regular week: a class series' coach, or a **duty series**' person. An **exception** is one
date changed from its pattern. A **duty** is a kind of work that is not a class (Cleaning, Open up).
The **kind** of a shift is its class type or its duty. A staff member is **qualified** for a kind
when the rosterer says they may do it. **Unavailable** (away) is a time someone said they cannot
work: one-off (leave) or **regular** (every Wednesday afternoon). A **double-booking** is two of one
person's shifts that overlap; it is refused. An **offer** is a shift its person asks someone else to
take; a **take** is a qualified, free person accepting it. A **rosterer** is a person who may roster
others. A staff member is **counted** for pay by time or by class, or not counted. A **pay period**
is a run of dates the totals are made for; a **locked** period's totals no longer change. The
**calendar feed** is a private address a phone's calendar subscribes to.

### Platform: the `staffed` behaviour
An object declares who works it, when, and on what:

```ts
staffed: {
  who: { field: "coach", account: "user" } | { field: "staff" },
  // a relation whose record holds the staff account (a class's coach profile), or a user field
  starts: "startsAt", ends: "endsAt", zone: "timezone",
  kind: "classType",            // the relation qualifications are for
  live: ["scheduled"],          // the states in which the record is a shift
  place?: "room.name",          // shown on the roster and in the feed
  pattern?: { link: "series", who: "coach" },  // the series field that is its pattern
  payBefore?: { field: "classType.rosterBeforeMinutes" },  // pay only (below)
  payAfter?:  { field: "classType.rosterAfterMinutes" },
}
```

- Shipped packs and the org's own extensions only; a runtime extension is refused
  (`outside_audience`), as for roles and `sellable`: who works when feeds pay.
- **The person** is always a staff account. For a class it is the coach profile's `user`; Bookings
  declares `user` unique on `bookings.coach` (ADR 0502), so an account has at most one coach
  profile, and the host can write the right profile on a take. A class whose coach has no account
  (a visiting coach) is covered for members, shown on the roster as "no account", never in anyone's
  feed and never counted for pay.
- **The host keeps a name** on each shift as it was (`staffName`, read only), as Ticketing keeps
  `usedByName`, so past shifts read right after an account changes.

### Platform: the time claim (double-booking refused)
- Every live, covered shift holds one **time claim** in `core_staff_time` (account, object, record,
  starts, ends), written in the batch of the write that covers it, changes its times or person, or
  ends it. Ranges are half-open: a class 06:00 to 07:00 and another 07:00 to 08:00 do not clash.
- **The database refuses an overlap.** A `BEFORE INSERT` and `BEFORE UPDATE` trigger raises when a
  live claim of the same account overlaps the new range (`starts < NEW.ends AND ends >
  NEW.starts`). D1 runs one write at a time, so two batches cannot both pass the trigger: of two
  writes that would double-book one person, one fails whole. Answered `conflict`, `rule:
  "double_booked"`, naming the other shift. It binds everyone: a person, the assistant, MCP, an
  import, the host's own generation and takes.
- **The claim is the class's own time.** Preparation and pack-down minutes count for pay only
  (below); counting them in the claim would refuse a coach two classes back to back.
- **The host's generation never fails on a clash**: an occurrence whose pattern person is already on
  an overlapping shift (a one-off shift made beyond the horizon, say) is made uncovered, and
  rosterers are told.
- **31b's appointments** declare `staffed` and get the same claim, so "an appointment over a class
  the coach teaches is refused" is this trigger. 31b's own spec is amended to point here.
- Installing the behaviour over records that already clash (imported data) is refused before the
  trigger is built, naming the clashing shifts, as declared uniqueness is (ADR 0502's amendment).

### Platform: warnings
Three warnings, worked out by the host for a shift and a person:

| Warning | When |
| --- | --- |
| `unavailable` | The person has a one-off or regular unavailability overlapping the shift |
| `not_qualified` | The person is not qualified for the shift's kind |
| `uncovered` | The write leaves a live shift with no person (only within the uncovered window, below) |

- **A write is made with its warnings, not refused** (decision 9). `record.update`, `record.create`
  and the host's tools answer with `warnings`, which the audit log records with the write.
  `staffing.check { object, id, account? }` (tool-only, read) is the dry run the screens show before
  a person saves, and the approval card shows for an AI's request.
- **Who may override**: anyone who may write the person. Writing the person of someone else's shift
  is a rosterer's (below), and an AI's write of it always waits for a person (`personApproves`), so
  a warning is always overridden by a person who saw it.
- **A take is held to the rules, not warned**: decision 5 lets a take through without approval
  *because* the taker is qualified, so `not_qualified` refuses a take. A taker who is unavailable is
  told and confirms (it is their own time).

### Platform: patterns and exceptions (amends `recurring`; step 1, built)
- **The series' person is the pattern.** For classes, `bookings.series.coach`, unchanged. For
  duties, `rostering.dutyseries.staff`. Changing it applies from a date to future shifts whose
  person was not changed by hand (`recurring.change { from }`). A change that would double-book
  someone on any date is refused whole, naming the dates; the rosterer settles those dates first.
- **Field-level exceptions** ([ADR 0620](../adr/0620-field-level-exceptions-in-recurring.md),
  amending ADR 0500; built in step 1): a write by anyone but the host that changes a copied field
  makes **that field** the record's own: a row in `core_recurrence_exception` (migration 0810:
  record, field, who, when). The series never writes that field again, and still writes the others,
  field by field. A change of times, zone or state still detaches the whole record, as before. So a
  coach swapped for one Monday keeps the swap when the owner later moves the class to another room
  or another time. Every `recurring` declaration gets this; no pack declares anything. Host writes
  of the person (a take, step 3) must mark the field too (they write it as the host, so step 3
  writes the exception row in the take's batch), so a series change never overwrites a take.
- **Back to the pattern**: setting the field by hand back to the series' value clears its exception
  (decided in step 1: an exception equal to the series' value is indistinguishable from following
  it). The roster's "back to the pattern" is `recurring.follow { object, id, fields? }`, which also
  re-attaches a record detached whole when its time is still the series'. `recurring.exceptions`
  reads a record's exceptions.
- **Upgrade**: records detached whole before step 1 stay detached whole; nothing generated changes
  meaning. A person re-attaches one with `recurring.follow`.
- **Races**: an edit to a series' record and a change of the series guard each other per
  occurrence (`core_recurrence_guard`), so of the two racing one commits and the other fails as
  `recurring_stale`; edits of different records of one series, and runs, do not contend. One batch
  sees what it queued (a hand edit and a series edit of one field in one batch keep the hand's).
- `changed` stays true for a whole-record edit only. Bookings' `changed` field's description
  says so.

### Platform: qualifications
- `core_staff_qualification` (account, kind object, kind record, who set it, when). Set by a
  rosterer (`staffing.qualify`, `personApproves`): Sam may take Strength and Yoga, and Cleaning.
- **Who is eligible for a shift**: active accounts qualified for its kind, not unavailable over it,
  with no overlapping claim. The offer goes to them only (decision 6).
- A kind record in the Trash or deleted qualifies nobody; restored, its qualifications return.
- New installs and the move (stage 33) seed qualifications for review (below); nobody is qualified
  by default (guess: a coach who has never been made qualified for a class type is warned about
  when rostered on it, not refused, so the first roster works before the matrix is filled).

### Platform: unavailability
- `core_staff_away` (account, kind `leave`, `regular` or `other`, a note, and either a one-off range
  of local date-times, or a regular rule: weekdays, a local start and end time, from and until dates,
  the zone). A regular rule is checked by wall clock on the fly; nothing is generated.
- **Made by the person themselves** (`staffing.away`, `staffing.back`) or by a rosterer for them.
  Nobody approves leave in this stage (leave approval is out of scope).
- **Who sees it**: the person and rosterers, with the note. Other staff see nothing of it, not even
  that someone is away (guess: the roster shows shifts, and decision 11 is about shifts).
- **Leave over shifts already rostered** does not unassign them. The rosterers are told ("Sam is
  away 3 to 14 March and is on 6 shifts"), the shifts show the warning, and Sam is offered "offer
  these shifts" in one step.

### Platform: offers and takes
`core_staff_offer`: the shift (object, record), from (the account, or none for an uncovered shift a
rosterer offers), to (optional: one named person), state, made at, taken by, taken at, ended at and
why.

| From | To | By | What happens in the same batch |
| --- | --- | --- | --- |
| (new) | `open` | the shift's person, or a rosterer (also on an uncovered shift) | eligible people are told; one open offer per shift (a partial unique index) |
| `open` | `taken` | an eligible person (not the offerer) | the shift's person written to the taker by the host, the time claim moved, the field marked as an exception |
| `open` | `withdrawn` | the offerer, a rosterer | none |
| `open` | `cancelled` | the host: the shift reassigned by a rosterer, cancelled, ended, or its person deactivated | the offerer told |
| `open` | `lapsed` | the host, at the cut-off | the offerer told it is still theirs; rosterers told |

- **The race: exactly one take.** A take is one batch: a conditional update of the offer (`SET
  state = 'taken' ... WHERE id = ? AND state = 'open'`) followed by a guard statement that fails the
  batch when that update changed no row (`core_write_guard`, as ADR 0550's guards), the person's
  write, the time claim (whose trigger refuses a clash) and the audit row. Of twenty takes at once,
  one commits; the rest fail whole and are told who took it (ADR 0437's answer).
- **The offerer stays responsible until it is taken.** The shift is theirs: in their feed, on their
  list, counted for their pay, and theirs to work if nobody takes it.
- **The cut-off**: an offer can be made and taken until 1 hour before the shift starts (decision 21;
  a setting, default 60 minutes); then it lapses. Closer to the start, the rosterer reassigns.
- **The manager is told**, not asked (decision 5): every take notifies the rosterers, with who gave
  it and who took it.
- **Undoing a take**: no undo by the two people. The taker can offer it on at once, and a rosterer
  can reassign it (guess: an undo would race the offerer's own plans for that time).
- **A take is a person's own act** (`humanOnly`): the assistant cannot take or offer a shift for
  someone.

### Platform: uncovered shifts
- A live shift with no person is **uncovered**: a series with no coach, a coach who left, a person
  removed, a pattern that could not be applied.
- **Surfaced to rosterers**: on the roster (marked), in a daily in-app notice listing those in the
  next 14 days (a setting, guess), and at once when a shift in that window becomes uncovered. The
  Rostering dashboard counts them; Bookings' dashboard counts classes with no coach in its dates.
- A rosterer may offer an uncovered shift to everyone eligible; the first take covers it.
- **Members** see a class with no coach as they do today: the class, with no coach name.

### Platform: the roster read
`staffing.week { from, to, account? }` (tool-only, read): every live shift of every object declaring
`staffed`, in the range: the object and id, the kind's name, the title, the times and zone, the place,
the person's name (and whether it is the reader), uncovered or not, an open offer, and, for a
rosterer only, its warnings. **Nothing else**: never a class's bookings, places taken, its list or
any Person. So the roster gives a coach the whole future week without reaching what the coach role's
today limit protects. At most 62 days per call (guess).

### Platform: tool-only operations and permissions
The host's operations are tool-only (callable only from a shipped pack's tool run, with the verified
caller from `ctx.caller`, never from input): `staffing.week`, `staffing.check`, `staffing.assign`,
`staffing.offer`, `staffing.withdraw`, `staffing.take`, `staffing.away`, `staffing.back`,
`staffing.qualify`, `staffing.markNotWorked`, `staffing.payBasis`, `staffing.payPeriod.*`,
`staffing.feed.*`. The Rostering pack's tools call them, and the permissions are the pack's:

| Permission | Held by | Opens |
| --- | --- | --- |
| `rostering:team` | the `rostering.team` role | the roster, my shifts, my unavailability, offer, withdraw, take, my feed |
| `rostering:roster` | ordinary roles (members, viewers for the reads); grantable, held by no role | the same as `rostering:team`, for an account with another pack role (a coach) |
| `rostering:manage` | admins (the owner and any admin, decision 16); grantable, to nobody at first; **restricted** | roster anyone, patterns, qualifications, others' unavailability, offer uncovered shifts, mark not worked, tick a checklist on someone's behalf |
| `rostering:pay` | admins; grantable; **restricted** | who is counted, pay periods, totals, lock, reopen, export |

- **A restricted permission** (new platform piece, small): a pack declares a tool permission
  `restricted`, and then the tool's own core permission is not enough: a member or viewer holds it
  only by grant; admins hold it. Today every member holds every pack tool, so without this every
  member would see pay totals.
- `rostering:team` and `rostering:roster` are two names for one set of tools, because ADR 0600
  forbids a grantable permission that a role holds. The tools name both.
- The cleaner's account: the `rostering.team` role (no record reads; only its tools). A coach: the
  `bookings.coach` role plus the grant `rostering:roster`, and, if they also roster, `rostering:manage`.
- Under ADR 0600, the coach's today limit applies to the calls their role makes; their Rostering
  calls come through the grant and see every date, and only roster fields.

### Pack: Bookings (additions)
- `bookings.class` declares `staffed` (above). `bookings.coach` declares `unique: [{ fields:
  ["user"] }]`.
- **`personApproves`** on `bookings.class.coach` and `bookings.series.coach`: the assistant and MCP
  may ask to change a coach; a person applies it. This tightens what an AI may do today.
- Programs' class type gains `rosterBeforeMinutes` and `rosterAfterMinutes` (pay only; default 0,
  decision 19), added by Bookings as it adds its booking rules.
- Bookings' dashboard: classes with no coach in the dates. Its automations are unchanged: a coach
  change still sends members nothing (decision 12).
- Bookings' existing tool `roster` keeps its name and meaning (the class list).

### Pack: Rostering (`packs/rostering`)
| Object | What | Behaviours |
| --- | --- | --- |
| `rostering.duty` | Name (Cleaning, Open up), colour, default length, place, what to do (text), checklist (optional, step 4b; decision 15), active | none |
| `rostering.dutyseries` | Duty, weekdays, local start time, length, from, until, zone, staff (a `user` field, the pattern), state (`active`, `ended`) | `recurring`, generating `rostering.shift` |
| `rostering.shift` | Duty, series (host), starts, ends, zone, staff (a `user` field), staff name (host), notes, state (`scheduled`, `cancelled`), changed (host) | `staffed` (`who: { field: "staff" }`, `kind: "duty"`); `states` |

- **Requires nothing.** It works alone; with Bookings installed its roster shows classes too, through
  the host's read.
- **The role** `rostering.team`: `permissions: ["rostering:team"]`, `read: []`.
- **Tools** (staff): `week`, `mine { from?, to? }`, `offers` (offers open to me), `offer`,
  `withdraw`, `take`, `away`, `back`, `myAway`, `feed` and `feedRotate` (team); `assign { object, id,
  account | null }`, `check`, `qualify`, `qualifications`, `awayFor`, `uncovered`, `markNotWorked`
  (manage, `personApproves`); `payBasis`, `periods`, `periodTotals`, `lock`, `reopen`, `export`
  (pay, `humanOnly`).
- **Settings** (a person's, `personApproves`): the offer cut-off (60 minutes, decision 21), the
  uncovered window (14 days), the duty horizon (56 days: 8 weeks, decision 17), the pay period
  (fortnightly, decision 20; below).
- **The duty** gains an optional `checklist` (a template, step 4b). Until step 4b it has a "what to
  do" note only.
- **Notification words** are the pack's; the host sends them (below).

### Platform: checklists (decision 15)
A **checklist** is a list of steps the business writes once (close-down clean, opening up, setting
up for a class type, onboarding a new coach). It is attached to things that happen; each time, a
person ticks it off, and the host keeps who did what and when. The business sees what was and was
not done, which is what later automation builds on.

- **Where it lives: the platform**, as a small capability of its own (core tables and operations, a
  declaration on an object), not a Checklists pack. Rostering's duty uses it without depending on
  any other pack, and a later class type, event or a new member's first week attaches it the same
  way. Its two rules (only the right person ticks; a completed run never changes) hold for every
  actor, so they are the host's (ADRs 0404 and 0405). A Checklists pack is not needed for this
  stage; one can come later if templates need screens of their own beyond Settings.
- **The objects** (core tables; ADRs named in "Migrations and numbers"):

  | Table | What |
  | --- | --- |
  | `core_checklist` | A **template**: name, what it is for, active, version, who wrote it and when |
  | `core_checklist_step` | Its **steps**, in order: the text, whether it is required, and whether it asks for a note (optional on any step). No photos (decision 22) |
  | `core_checklist_run` | A **run**: one template version attached to one record (object, record), its person (the staff account whose shift it is), opened, completed or missed, and when |
  | `core_checklist_tick` | One **tick** per step of a run: the account that ticked, the account it was for (the run's person), whether on their behalf and why, when, the note, or "not done" with why |

- **Attaching**: an object declares `checklists: { template, who, opens, closes, live }`: the field
  that names the template (Rostering's `rostering.duty.checklist`, reached from the shift through
  its duty), the field holding the staff account who ticks (the shift's `staff`), the times it
  opens and closes (the shift's start and end), and the states in which it applies. A template
  field is a new field type, `checklist`, that picks an active template. Shipped packs and the
  org's own extensions only (as `staffed`).
- **A run is made by the host** when a live record with a template is within a day of opening
  (guess), copying the template's steps as they are then: editing a template later changes no run
  already made. A shift with no template has no run. Reassigning the shift moves an unstarted run to
  the new person; a run with ticks stays with who ticked and the new person continues it.
- **Who writes templates**: a person holding `checklists:write`, a core permission that admins
  hold and that can be granted to a member one by one (ADR 0449). **The assistant may draft** a
  template or its steps (decision 25); a draft is not used until a person approves it
  (`personApproves` on the template's fields, ADR 0507's shape): it never changes what staff are
  asked to do on its own.
- **Who ticks**: the run's person, from their shift, on the web or the app, from when it opens until
  it closes plus a grace period (2 hours, guess). **A rosterer may tick on someone's behalf**
  (decision 24), with a reason (a shift worked by someone else on the day). Such a tick records
  both accounts: the rosterer who ticked and the person it was for, with the reason, and every
  screen and export shows it as "ticked by X for Y"; it is never shown or counted as the shift
  person's own tick. Nobody else ticks, and **never an AI actor** (`humanOnly`): a tick says a
  person did the step.
- **Done is final**: the person (or a rosterer on their behalf, recorded as above) marks the run
  done: every required step ticked or marked "not done" with why. A **completed run is
  immutable**: a trigger refuses any insert, change or delete of its ticks, for everyone. A
  correction is a note added to the run by a rosterer, kept beside it, never a change to a tick. A
  run not done by its close and grace is closed by the host as **missed**, with the steps that
  were not ticked.
- **Who sees how it went** (decision 23), held by the host for every path: a run, its ticks and
  whether it was missed are read only by the run's person and by rosterers (`rostering:manage`:
  the owner and admins, and anyone granted it). Checklist runs are core tables in no `rec_*` view,
  so no dashboard, `query.sql`, `export.csv` or the assistant's record reads reach them; they are
  read through tool-only operations that check the caller is the run's person or a rosterer. Other
  staff see that a shift has a checklist (it is on the roster), never how it went. Templates and
  their steps are not personal and are readable by every staff account.
- **What the person and rosterers see**: the person sees their shift's checklist on "my shifts" and
  ticks it there. Rosterers see each shift's checklist state on the roster (none, not started, in
  progress, done, missed), a run's ticks with who ticked and for whom, and a Checklists view of
  runs by template and date with the steps missed.
- **Its place in the build**: step 4b, after the Rostering pack's duty shifts (step 4), beside
  steps 5 to 7. Duty shifts ship with a time and a person first; the checklist follows without
  holding the roster up.
- **Left out, as follow-ons**: **photos on a step** (left out by the owner's decision 22; when
  they come, the media path must be checked first: today's media library stores an upload's bytes
  as given, strips no location or other metadata, and nothing could enforce "the room, not
  people"); a step missed twice raising a task (the automation this is built for, next);
  checklists on a class type, an event or a new member's first week (each a
  `checklists` declaration of its pack); a second person signing a run off; steps that depend on
  an answer; scores; ticking offline; a checklist with no shift (a daily opening check on its own).

### Notifications
In-app notices through `notification.send`, delivered by email as each person's preferences say
(the existing staff path). No push or text (stage 30). **Nothing is sent to a member.**

| Event | Told | What it says |
| --- | --- | --- |
| You were put on a shift, or taken off one, by a rosterer | the person | the shift, and who changed it |
| A shift of yours changed time or was cancelled | the person | the shift, before and after |
| A shift is offered | eligible people (or the one named) | the shift, who offers it |
| Your offer was taken, withdrawn by a rosterer, cancelled or lapsed | the offerer | who took it, or that it is still theirs |
| A take | rosterers | who gave it, who took it |
| Uncovered shifts in the window (daily), or one just uncovered | rosterers | the shifts |
| Leave added over rostered shifts | rosterers | who, when, and the shifts |
| A pattern could not be applied on a date (a clash) | rosterers | the date and why |
| A checklist run was missed (step 4b) | rosterers | the shift, its person and the steps not done |

These are the host's own notices, sent in or after the write that causes them, so a take made by
any path tells the same people. A rosterer is an account holding `rostering:manage` (admins and
grants).

### Staff's own calendar: a private feed
**Recommended: a private calendar feed per staff account**, not emailed files.
- `GET /api/v1/staffing/feed/<token>.ics` (also offered as `webcal://`): the person's shifts from 14
  days back to the horizon, one event per shift (title: the kind and the place; times in UTC;
  `UID` the shift's id), rebuilt on each fetch. A cancelled shift drops out.
- **The token** is 32 random bytes, shown once, stored only as its SHA-256 hash
  (`core_staff_feed`). It is revocable and rotatable by the person and by an admin, and is revoked
  when the account is deactivated or loses its Rostering permission. An unknown or revoked token is
  answered 404, the same as any missing path. Rate limited per token.
- **It shows only that person's shifts**: no other staff member's name, no member data, no class
  list or places, no notes. Under Cloudflare Access the feed path bypasses Access (the token is the
  secret), recorded in `access-layout.ts`.
- **The trade-off**: a calendar provider fetches the feed on its own schedule (often hours), so the
  phone's calendar can lag; the app is the truth. The URL is a bearer secret, so the screen says
  not to share it.
- **The calendar writer is shared**: ADR 0571's RFC 5545 writer moves from the email gatekeeper to a
  small shared module used by both (an amendment to ADR 0571), so the format is written once.

### Pay periods
- **The period** is a setting (decision 20): weekly, fortnightly (the default) or monthly; for
  weekly and fortnightly, the date one period starts (which fixes the weekday; the pay screens ask
  for it before the first period, and until then nothing is totalled); for monthly, the day of the
  month (1 to 28). In the organisation's zone. A shift belongs to the period of its local start date.
- **No rates** (decision 14): hours and counts only; payroll applies the rates.
- **Who is counted** (`core_staff_pay_basis`, set by `rostering:pay`): `by_time`, `by_class` or
  `not_counted` (the default). Salaried staff are not counted.
- **What is totalled**, per counted person and kind: the number of shifts (classes for class kinds)
  and the hours (each shift's end minus start, plus the class type's before and after minutes:
  optional, default 0, decision 19; they never enter the time claim).
  Cancelled shifts and shifts **marked not worked** count for nothing.
- **Rostered, corrected before the lock** (decision 18): the total is the roster as it stands when
  the period is closed (locked). A rosterer corrects it first: who actually worked a class (reassign it, which
  is allowed after the shift for a rosterer), or `markNotWorked` (a core mark on the shift, with a
  reason). The totals screen shows evidence beside each class: whether its list was taken, and by
  whom; a class whose list was ticked by someone other than its rostered coach is flagged for
  review. A coach who did not turn up and whose class nobody ran is marked not worked.
- **Locking**: a period that has ended is locked by a person with `rostering:pay`. Locking writes its
  totals and lines to `core_pay_period` and `core_pay_line` (person, account, basis, kind, count,
  minutes, and each shift's line). After the lock, a write that changes the person, times or state
  of a shift inside it is refused (`pay_period_locked`) for everyone. **Reopening** is a person's
  act with a reason, audited; locking again makes a new version and keeps the old.
- **The export** (CSV, from a locked period, or a preview of an open one marked as such): a summary,
  one row per person and kind (period start, end, name, staff email, basis, kind, shifts, hours as
  a decimal and in minutes); and the lines, one row per shift (date, start, end, kind, place,
  minutes counted, not-worked reason). No rates, no money. Never through `export.csv`, dashboards
  or `query.sql`: the tables are in no `rec_*` view.
- **Who sees it**: `rostering:pay` only, a person only (`humanOnly`): never an AI actor, never the
  person themselves through these tools (guess: they see their own shifts, which is the same data
  unsummed).

### Members' view
Unchanged except what the coach field already gives: the coach's name, photo and bio on each class
(`bookings.coach`'s public fields). Rostering's objects declare no `customer` or `public` key, so no
member or visitor reads a duty, a shift, unavailability, qualifications, offers or anything of pay.
Stage 22's isolation suite gains every Rostering object and the feed.

### What an AI may do
| Action | Under `balanced` |
| --- | --- |
| Read the roster, a shift's warnings, who is qualified | applied |
| Propose a roster ("put Sam on Mondays at 06:00 from March"): `assign`, a series' person, `qualify`, `markNotWorked` | waits for a person (`personApproves`); the card shows the warnings |
| Offer, take, withdraw, say someone is away | refused: a person's own act |
| Anything of pay | refused: a person only |

Roster changes are a person's to apply because they change other people's working week, are told
to them, and feed their pay. The assistant drafting a week and a person approving it is ADR 0552's
shape.

### Leaving, erasure and the Trash
- **A staff member leaving** is `user.deactivate`. It now answers with their future shifts and the
  patterns that name them, and, confirmed with that count (as `recurring.change` is), in the same
  operation: clears them from every future shift and pattern (each now uncovered), releases their
  time claims, cancels their open offers, revokes their feed, and tells rosterers with the list.
  Past shifts keep them and their name. Reactivating puts nothing back.
- **Removing a staff member's roster data** on request (`staffing.forget`, a human admin, after
  deactivation; there is no staff erase today and this stage does not add one): deletes their
  unavailability, qualifications, feed tokens and offers, and replaces their name on past shifts
  with "a former staff member". **Locked pay lines keep the name and totals**: they are the
  business's payroll records, which it may have to keep. `staffing.forget` is refused while an
  unlocked pay period contains their counted shifts (the answer names the periods).
- **The Trash**: a shift in the Trash holds no claim and is no one's; restored, its claim is made
  again or the restore is refused as a double-booking.

### Screens
| Where | Who | What |
| --- | --- | --- |
| Web: the roster week | everyone with Rostering | A week grid, days across, shifts by time, each with its kind's colour, place and person; uncovered marked; my shifts highlighted. Read only for the team |
| Web: assign | rosterers | From a shift: eligible people first (qualified, free, available), the rest below with their warnings; "back to the pattern"; offer to everyone |
| Web: patterns | rosterers | The class series' coaches and the duty series, as a regular week; change from a date |
| Web: qualifications | rosterers | People down, kinds across, a tick each |
| Web: unavailability | rosterers | Everyone's, by week |
| Web: pay | `rostering:pay` | Periods, who is counted, a period's totals with evidence and flags, lock, reopen, export |
| Web and native: my shifts | every rostered person | The next weeks' shifts; offer, withdraw; my open offers |
| Web and native: offered to me | every rostered person | Shifts offered that I can take; take (with the unavailable confirmation) |
| Web and native: my availability | every rostered person | Leave and regular time off; add, end |
| Web and native: my calendar | every rostered person | The feed's address to copy or open, rotate |
| Native: the roster | every rostered person | The week as a day-by-day list on a phone |
| Host admin: Settings, Rostering | admins | The cut-off, the uncovered window, the horizon, the pay period |
| Host admin: Users | admins | The team role, the Rostering grants (one tick each, ADR 0600's screen) |

Native screens need a typed client for a coach whose Rostering tools come by grant: a role client
(ADR 0451) gains the grantable permissions a product lists for it (`mobile.roles` with grants,
guess at the shape). No block decides eligibility, a clash or a permission; the block lint passes
for each.

## The move (stage 33)
What the roster needs, beside what stage 31's import door already loads (class types, rooms,
coaches, series with their coach, one-off and future classes):
- **Staff**: each coach and other rostered person with a name and email, as a list a human admin
  invites (accounts are never made by an import, ADR 0455), with the role each should hold.
- **Coach profiles to accounts**: each imported coach profile linked to the invited account.
- **Exceptions already made**: future classes whose coach differs from their series' are imported
  onto the generated classes as coach exceptions (the field marked), not as detached classes.
- **Qualifications**, if the old system exports who may teach what; otherwise **proposed** from the
  last 12 weeks (every class type each coach taught), for the rosterer to review and apply.
- **Duties and their regular people** (cleaning is not in a booking system): entered on the
  patterns screen, or `cos rostering import` from a CSV of duties and duty series (guess).
- **Not imported**: unavailability (staff enter it), pay basis (the owner sets it), past pay.
- Clashes found on import are reported as conflicts and imported uncovered; warnings are listed.
  The import runs the same check as the reconcile (ADR 0621): what clashes and has not ended is
  refused or imported uncovered; clashes between shifts that have both ended are reported.

## Out of scope
- Pay rates, pay amounts, payroll, tax, award rules, overtime and penalty rates (decisions 10 and
  14).
- Checklists' follow-ons (above): the missed-step task, checklists on class types, events and a new
  member's first week, a second sign-off, conditional steps, offline ticking.
- Clocking in and out, timesheets beyond the roster, breaks.
- Leave approval, leave balances.
- Connections to outside calendars or practice systems, and blocking time in them (decisions 7
  and 8).
- Two coaches on one class (a second coach is a duty shift at the same time, guess).
- Rules other than weekly (every second week): `recurring`'s own limit.
- Several locations with their own rosters.
- Push and SMS notices (stage 30).
- Members seeing anything new.

## Acceptance criteria
1. **Double-booking refused**: one account put on two overlapping shifts (two classes, a class and a
   duty, a duty and a 31b fixture appointment) by a person, the assistant (once approved), MCP, an
   import and a take is refused (`double_booked`) every time; 50 writes at once that would each
   double-book one person leave exactly one shift on them; back-to-back shifts are allowed.
2. **Warnings**: putting someone on a shift while they are away (one-off and regular, across a clock
   change), not qualified, or leaving a shift uncovered within the window, is made and answers each
   warning; `staffing.check` gives the same answer first; the audit row records them.
3. **Patterns**: a class series' coach and a duty series' person fill every shift in the horizon (8
   weeks); a coach swapped for one date keeps the swap after the series changes room, places, time
   and coach from a later date; setting it back, or "back to the pattern", clears the exception; a
   record detached before step 1 stays detached until a person makes it follow; a series change and
   an edit racing leave exactly one applied (step 1, built); a pattern change that would
   double-book on any date is refused whole, naming the dates.
4. **The take race**: twenty eligible people taking one offer at once: exactly one is on the shift,
   one time claim moved, the rest told who took it; a take by someone not qualified is refused; a
   take later than 1 hour before the start (the default cut-off) is refused and the offer has lapsed; the offerer stays on the shift until
   it is taken; rosterers are told of each take and nobody approves it.
5. **Offers reach only the eligible**: an offer notifies exactly the qualified, available, free
   accounts (fixture of eight people covering each reason to be left out).
6. **The coach's reach**: a coach with the `bookings.coach` role and the `rostering:roster` grant
   reads every future shift and their own, offers and takes; still reaches class lists, bookings and
   names only today, exactly as before; the roster read never returns a booking, a place count or a
   Person (a registry walk of the coach's account, before and after the grant, differs only by
   Rostering's team tools).
7. **The team role**: an account with `rostering.team` only is refused every operation in the
   registry but Rostering's team tools (ADR 0436's walk).
8. **Restricted permissions**: a member is refused every pay and manage tool until granted; an admin
   holds them; an AI actor is refused pay tools whatever is granted; the assistant's `assign` waits
   for a person.
9. **The feed**: a person's feed shows exactly their own shifts in the range, parses as RFC 5545,
   and holds no other staff name and no member data; another person's token, a revoked, rotated or
   made-up token all answer 404; deactivation revokes it.
10. **Pay totals** match a fixture worked out by hand: a fortnight (the default period) with hourly,
    per-class and not-counted staff, a cancelled class, a shift marked not worked, a take mid-period, a class with
    before and after minutes, a shift across midnight and a clock change; the CSV matches it line by
    line; after the lock, a change to a shift in the period is refused; reopening is a person's and
    audited; nothing of pay is in any `rec_*` view, `query.sql`, a dashboard or `export.csv`; no
    rate or amount is held anywhere.
11. **Members**: stage 22's isolation suite with Rostering installed: a customer and the public read
    a class's coach name, photo and bio and nothing else of staff; every Rostering object is
    invisible to them; a coach swap sends no member email.
12. **Leaving**: deactivating a coach with future classes and a duty pattern makes each uncovered,
    tells rosterers, cancels their offers and keeps past shifts; `staffing.forget` keeps locked pay
    lines and is refused while an unlocked period counts them.
13. **Checklists** (step 4b): a duty with a checklist gives each of its shifts a run of the template
    as it was; only the shift's person, or a rosterer on their behalf with a reason, ticks it, and
    an AI actor is refused; a tick on someone's behalf keeps both accounts and reads "ticked by X
    for Y" everywhere; a step asking for a note is not done without one; a completed run refuses
    every change to its ticks, for everyone; a run not done by its close is missed, with the steps
    not ticked, and rosterers are told; a run (missed or not) is read by its person and rosterers
    only, and by no other staff account, `rec_*` view, dashboard, `query.sql`, `export.csv` or AI
    read; an assistant's template is not used until a person approves it.
14. `pnpm lint typecheck test`, `cos ext check` and `cos ext test` on `packs/rostering` and
    `packs/bookings`, the block lint, and one e2e test per journey (the owner rosters a week with a
    warning; a coach offers a shift and another takes it; a cleaner sees their shifts and adds leave;
    a cleaner ticks off a close-down checklist; the pay export of a locked period; and step 1's: a
    coach swapped on one class, then the series' time changed, the class moves and keeps its coach)
    pass in CI. ADRs for each platform piece; `CONTEXT.md` and
    `docs/architecture.md` updated.

## Dependencies
- Stage 31a (built). ADR 0600 (issue #258, PR #263): merged, so step 4 no longer waits on it.
- 31b's time-range claim is this stage's step 2; whichever builds first builds it, and 31b's spec
  is amended to point here.
- Nothing from stages 32b, 43 or 44. Stage 33 uses step 7.

## Migrations and numbers
Block **AV** in [`parallel-work.md`](../parallel-work.md): migrations 0810 to 0829 and ADRs 0620 to
0629, claimed by step 1's build (block AU, which this spec first named, went to stage 46, and stage 44
moved to AX; AS and AT went to routine mail and ADR 0600). Step 1 used migration 0810 (`core_recurrence_exception`, a table of
its own rather than a column on the occurrence, so each exception carries who and when) and ADR
0620. The later steps: `core_staff_time` and its triggers, `core_staff_qualification`,
`core_staff_away`, `core_staff_offer` (with a guard kind), `core_staff_feed`,
`core_staff_pay_basis`, `core_pay_period`, `core_pay_line`, the not-worked mark, and step 4b's
`core_checklist`, `core_checklist_step`, `core_checklist_run`, `core_checklist_tick` (with the
trigger keeping a completed run unchanged). No `x_*` table is touched by a migration. ADRs:
1. The `staffed` behaviour and the time claim (31b's time-range claim).
2. Field-level exceptions in `recurring` (amends ADR 0500): **ADR 0620, written with step 1**.
3. Warnings in a write's answer, and qualifications and unavailability as core.
4. Offers and takes: the race, the cut-off.
5. Restricted pack permissions (amends ADRs 0436, 0449 and 0600).
6. The calendar feed and the shared calendar writer (amends ADR 0571).
7. Pay periods: the basis, the totals, the lock, the export.
8. The Rostering pack and Bookings' additions; leaving and `staffing.forget` (amends ADR 0553's
   coach role note on what a coach reaches).
9. Checklists: templates, runs, ticks, a completed run kept unchanged, the declaration (step 4b).

## Suggested build order
| Step | What | Files it touches | Runs beside stages 31, 32, 43 and 44? |
| --- | --- | --- | --- |
| 1 | **Field-level exceptions** in `recurring` (**built**: ADR 0620, migration 0810, `recurring.follow`, `recurring.exceptions`) | `packages/core/src/recurring/`, `operations/recurring.ts`, a migration | Built. 31a step 10's import must write a coach that differs from its series as a field exception (ADR 0620, Consequences) |
| 2 | **`staffed` and the time claim** (**built**: ADRs 0621 and 0622, migration 0811): the declaration, `core_staff_time` and its trigger, warnings in the write's answer, `staffing.check`; Bookings' class declares it, `bookings.coach.user` unique | `packages/sdk` (the declaration, contract), `packages/core/src/staffing/` (new), `records/` writes (the claim in the batch), a migration, `packs/bookings/index.ts` | **Yes, now**, but **not beside 31b** (same piece: one session builds it) and agree with stage 44 step 2 on the order of `core_write_guard` migrations |
| 3 | **Qualifications, unavailability, offers and takes, uncovered**, the host's notices, `user.deactivate`'s answer | `staffing/`, `operations/user.ts` (deactivate), notifications, a migration | After step 2. Beside 43 and 44, which do not touch these files |
| 4 | **Permissions**: restricted pack permissions; the `rostering.team` role; the Rostering pack's spine (duties, duty series, duty shifts with a time and a person, tools, settings); `personApproves` on Bookings' coach fields | `pack-roles.ts`, `extensions/tools.ts`, `packages/sdk/src/manifest.ts`, `packs/rostering` (new), `packs/bookings/index.ts` | ADR 0600 has merged, so after steps 2 and 3. Not beside other pack-role work |
| 4b | **Checklists**: the templates, steps, runs and ticks, the `checklists` declaration and the `checklist` field type, the immutability trigger, the read rule (the person and rosterers only), Settings → Checklists, the duty's `checklist`, ticking on "my shifts" | `packages/core/src/checklists/` (new), `packages/sdk` (the declaration, the field type), a migration, `packs/rostering` | After step 4, beside 5 to 7: the roster does not wait for it (decision 15) |
| 5 | **The feed** and the shared calendar writer | `apps/app/src/server/http/` (a route), `access-layout.ts`, `packages/gatekeeper-email-send/src/calendar.ts` (moved), a migration | Beside anything but stage 43 step 3 (sign-in routes) and stage 44 step 4 (the same gatekeeper files): agree the order |
| 6 | **Pay**: the basis, periods, totals with evidence, lock, export | `staffing/pay.ts` (new), `packs/rostering` tools, a migration | Yes, after step 3 |
| 7 | **Blocks and hooks**: the week grid, assign, patterns, qualifications, pay (web); my shifts, offers, availability, calendar, the roster (web and native); role clients with grants; `cos rostering import`; the checklist blocks once 4b is merged | `packs/rostering/blocks`, `client/`, `packages/client` codegen (`mobile.roles`), `packages/create-composable-os` | Yes, once steps 3 and 4 are merged |
| 8 | **The first client**: invites, qualifications, patterns from the moved timetable, a fortnight's pay export checked by the owner | The first client's own repository | After 7, with stage 33 |

### Built in step 2 (2026-11-23)
- **The claim is kept by triggers, not written by each operation.** The reconciler builds `AFTER`
  triggers on the staffed object's own table and on the account holder's (the coach profile), which
  derive each row's claim from the row as stored (`packages/core/src/staffing/sql.ts`); the claims'
  own `BEFORE INSERT` and `BEFORE UPDATE` triggers refuse the overlap. So every write path (create,
  update, move, cancel, Trash, restore, erase, merge, import, generation, series changes, field
  exceptions, `recurring.follow`) writes its claim in the statement that writes the shift, and the
  tests write `INSERT OR REPLACE`, upserts, `UPDATE OR REPLACE` and id changes to all three tables.
  The TypeScript read before the write (`packages/core/src/staffing/index.ts`) only names the other
  shift, keeps the batch's queued claims, uncovers a clashing generated date, and refuses a series
  change naming its dates.
- **Bookings' class is live in `scheduled` and `done`** (not `scheduled` alone, as this spec's
  example has it): a class done still counts for pay, and its time was worked.
- **The warnings' tables are made in this step** (`core_staff_qualification`, `core_staff_away`),
  so the warnings and `staffing.check` are whole now; their writers (`staffing.qualify`,
  `staffing.away`, `staffing.back`) are step 3's. A one-off unavailability is stored as instants
  with its zone. **Decided in review** (the coordinator, 2026-11-23), and kept by step 3: no
  `not_qualified` warning while there is no qualification row at all for that kind's object (a
  business that has not set qualifications up is not warned); the `unavailable` warning goes only
  to the person themselves and to someone who may roster (admins until step 4's permission).
- **Decided in review**: a reconcile (an upgrade) is refused when shifts that have not ended clash
  or two coach profiles share an account, naming the shifts by title and start; clashes between
  shifts that have both ended are skipped (the later one claims no time) and reported; a refused
  shipped upgrade is told to admins as a notification. A coach profile on live shifts that have not
  ended cannot go to the Trash. A live shift must end after it starts. The claims are indexed by
  account and end (migration 0811 edited in place before merge).
- **The uncovered window is 14 days, fixed** until the Rostering pack's setting (step 4). No
  notices are sent in this step (step 3's): a date the generation leaves uncovered is kept as a
  field exception on the person, so the series does not write the clash back.
- **`staffing.check` is tool-only for staff**: ADR 0414's `toolOnly` now covers a staff-only
  operation (the pipeline refuses a call that is not a tool's run, the contract leaves it out); the
  handler also refuses a runtime extension's tool. Nothing calls it until Rostering's tools (step
  4).
- **Not in this step**: `staffName` (with `staffing.forget`), the `pay_period_locked` refusal and
  the notices.

### Built in step 3 (2026-11-23)
[ADR 0623](../adr/0623-offers-and-takes-the-race-and-the-cut-off.md),
[ADR 0624](../adr/0624-the-rosters-notices-uncovered-shifts-and-leaving.md), ADR 0622 amended,
migration 0812 (`core_staff_offer` and its triggers, with its shift's start and kind kept on it;
the qualification index by kind; `core_staff_run`; `core_staff_guard`; edited in place in the
review of PR #282, before merge). All of the host's new operations are tool-only, as `staffing.check` is; nothing
calls them until Rostering's tools (step 4).
- **Qualifications**: `staffing.qualify` (a rosterer; the calling tool must be `personApproves` or
  `humanOnly`, so an AI's request waits for a person) and `staffing.qualifications`.
- **Unavailability**: `staffing.away` (one-off as local date-times in a zone, or regular), answering
  the shifts it covers (to offer in one step) and telling the rosterers in a person-only notice;
  `staffing.back` (removes it); `staffing.awayList`. Their own, or anyone's for a rosterer; a
  person's own act. Someone else's is answered as not there. The note is redacted from the audit
  log, and other people's leave is read only through a tool a person calls (`humanOnly`), never by
  an assistant (decided in review).
- **Offers and takes**: `staffing.offer`, `staffing.take`, `staffing.withdraw`, `staffing.offers`,
  as this spec says, with these decisions: **the race is decided by a trigger on the offer, not a
  `core_write_guard` kind** (an offer leaves `open` once; the take updates it by id; migration 0852,
  reserved for the guard remake, is released); a take needs a qualification row even where the
  business has set none up, and a shift with no kind can be taken by nobody; an offer to one named
  person checks they are qualified, have a profile and are free, never whether they are away; the
  offerer is never told how many were told (a rosterer is); after a failed take the pipeline's new
  `explainFailure` names who took it. Decided in review: every write that changes a shift's person
  (or its coach profile's account) cancels its open offer by the shift at commit, and the take
  refuses an offer whose shift has changed hands (`offer_stale`), so a take never removes someone
  who did not offer it; an offer to everyone is refused when nobody but the offerer is qualified
  for the kind, or the shift has no kind (`nobody_qualified`, from qualifications alone; the owner
  may override); a taker's list reads only offers of kinds they are qualified for, soonest first.
- **The cut-off** is fixed at 60 minutes until Rostering's setting (step 4). The minute cron's
  `staffing.due` lapses offers past it, nearest first (the offer keeps its shift's start, indexed),
  and cancels those whose shift is gone. It and `recurring.generate` are host steps, never queued
  for review under an approval floor.
- **`staffing.assign`** (a rosterer; applied by a person) is built here, since it shares the take's
  write of the person; **`staffing.uncovered`** too.
- **Notices** are written for every write of a shift, whatever path (`staffing/changes.ts`), and
  gathered over the call: **one notice per person per call**, a summary (how many, the dates) when
  it touched several of their shifts. So a change of a series' coach or time tells each person on,
  off or moved once, and an import tells each person once. A series' generation tells nobody per
  record; a date it leaves uncovered tells the rosterers. The daily uncovered notice goes from
  07:00 local, once a day.
- **Leaving**: `user.deactivate { id, confirm }` as this spec says; shifts under way keep their
  person; patterns in the Trash are cleared too; the changes are the host's (ADR 0590's marks), and
  a guard fails the batch if anything it read changed, so what is recorded is exactly what was
  cleared; more than 2,000 future shifts is refused, not partly done. The generation never puts a
  deactivated account on a new date. The feed's revocation is step 5's.
- **Not in this step**: `staffing.week`, `staffing.forget`, `staffName`, the feed, pay, the
  permissions and the pack.

### Built in step 4 (2026-11-23)
[ADR 0625](../adr/0625-restricted-pack-permissions.md) (amends ADRs 0436, 0449 and 0600),
[ADR 0626](../adr/0626-the-rostering-pack-and-bookings-additions.md) (amends ADR 0553). No
migration; no `core_write_guard` remake (0852 stays free).
- **Restricted permissions** as this spec says: `restricted` in a pack's manifest; a tool naming
  only restricted permissions is held by admins and by a grant of it, never by a member's or
  viewer's role or a pack role; never called by an automation or another extension's code (its
  `actors` are a person, an assistant and MCP); a human admin grants it, **never to their own
  account** (`rule: "self_grant"`, decided here: an admin would keep it once made a member);
  `user.grantablePermissions` marks it. The contract refuses one no tool declares, one a role holds,
  a tool mixing it with another permission, and a runtime extension declaring it.
- **The caller of a pack's tool** (found in this step): inside a tool's run `ctx.user` is the
  extension's own account, so step 3's operations, tested with the person as `ctx.user`, would have
  acted for the extension in the real runtime. The runtime now puts the verified caller on the run
  (`ctx.extension.tool.calledBy: { account, actor }`), and every staffing operation acts for it,
  and refuses a run not called for a staff account.
- **Who rosters** is `rostering:manage` everywhere (`staffing/rosterers.ts`): admins, and accounts
  granted it, read through the pack's `staffing.rosters` declaration (ADR 0626), so the host names
  no pack. The cut-off and the uncovered window are Rostering's settings, read by the host through
  the same declaration; the host's defaults (60 minutes, 14 days) without it.
- **The roster read** `staffing.week { from, to, mine?, account? }` (it was not built in step 3),
  set-based, warnings for a rosterer only.
- **The pack**: `rostering.duty`, `rostering.dutyseries` (`recurring`, with a new
  `horizonSetting`: the duty horizon), `rostering.shift` (`staffed`, `states`); the team role; the
  team's tools (`rostering:team` and the grantable `rostering:roster`) and the rosterers' tools
  (`rostering:manage`), as the AI table says; the settings (cut-off, uncovered window, horizon).
  Who is on a duty shift and a series' regular person are `personApproves`, as Bookings' coach
  fields now are.
- **Decided here**: a rosterers' read of everyone's time off, `awayList` (`humanOnly`), beside the
  spec's `awayFor`, for the unavailability screen; a tool may declare input fields the audit log
  never keeps (`redact`), used for the leave note (the tool's own audit row held it); an assistant
  reading its own person's time off gets the times without the notes (step 3 gave it the notes).
- **Who works a shift is a rosterer's to say, by every path** (the review of PR #284; a
  coordinator's decision the owner may override): where a pack declares who rosters, a caller's
  write of a shift's person, a pattern's person or a coach profile's account is refused unless
  they roster, by record writes, imports, series changes, `recurring.follow` and restores; the
  host's own writes (a take, the generation, a leaver) are not refused. A product with Bookings
  alone is unchanged. An AI's roster change is approved only by someone who could make it. See
  ADR 0626. (Step 4 as first written restricted only the tools: a member could still write a
  shift's person directly.)
- **A `rostering.team` account may be granted `rostering:manage`** by a human admin, and then rosters
  (ADR 0625 allows a fixed-role account any pack permission; a coach who also rosters is the case
  the spec names). This is deliberate.
- **The roster read says when it is cut short** (`truncated`, past 1,000 shifts of one object).
- **Not in this step**: `markNotWorked` and the pay tools and settings (step 6, so `rostering:pay`
  is not declared yet: a permission must be a tool's), `feed`/`feedRotate` (step 5), the checklist
  (4b), the dashboards and screens (7), `staffName` with `staffing.forget`, the notices' words in
  the pack (they stay the host's), and the class type's preparation and pack-down minutes (pay).

### Built in step 6 (2026-11-23)
[ADR 0627](../adr/0627-pay-periods-the-basis-the-totals-the-lock-and-the-export.md), migration 0813
(`core_staff_pay_basis`, `core_staff_not_worked`, `core_pay_period`, `core_pay_line` and their
triggers). No `core_write_guard` remake (0852 stays free). All new operations are tool-only.
- **Who is counted** (`staffing.payBasis`, `staffing.payBases`): by time, by class or not counted,
  **from a local date** (decided here: so a period totalled again uses the basis in force on each
  shift's date, not today's). A date on or before a locked period's last day is refused.
- **The period** is Rostering's settings (`payPeriod`, default fortnightly; `payPeriodStart`, a
  `YYYY-MM-DD` text setting, as the manifest has no date setting; `payPeriodDay` for monthly), read
  by the host through `staffing.settings`, each a person's to change. A pack declares who handles pay
  as `staffing.pays` (a restricted, grantable permission: Rostering's `rostering:pay`).
- **Totals** (`staffing.payPeriod.totals`, `staffing.payPeriod.list`): as this spec says, worked
  out set-based from every staffed object. Decided here: every total carries **both** shifts and
  whole minutes whatever the basis (payroll reads the one it pays on); hours are minutes ÷ 60
  rounded half up to two places, from summed minutes; a shift's minutes are its instants' difference
  (a clock change counts the real time); a shift with no account, a cancelled one and one in the
  Trash are no line. Bookings' class type gains `rosterBeforeMinutes` and `rosterAfterMinutes`
  (`personApproves`), declared as the class's `payBefore` and `payAfter`.
- **Evidence**: a new `staffed.evidence` declaration (an object of the same extension naming the
  shift, and who marked it); Bookings' class names its bookings' `markedBy`. Each line says whether
  its list was taken, by whom, and is flagged when not by its person.
- **The not-worked mark** (`staffing.markNotWorked`, Rostering's `markNotWorked`): a rosterer's,
  `personApproves`, with why, only once the shift has started (decided here), clearable.
- **The lock** (`staffing.payPeriod.lock`) of an ended period writes its lines in one batch, guarded
  by a fingerprint of what they were read from (a write in between fails it as `roster_changed`).
  After it, the database refuses a change of the person, times, kind or liveness of a shift inside
  it (triggers the reconciler builds with the time claim's), its marks, and who is counted then,
  for every writer and every statement shape (REPLACE, upserts, `UPDATE OR REPLACE`, deletes).
  Decided here: a note, or `scheduled` to `done`, is not refused (neither changes pay); a coach
  profile in the Trash may still be purged. More than 10,000 shifts in one period is refused.
- **Reopen** with why (kept with the version, not in the audit log); locking again makes version 2
  and keeps version 1's lines readable.
- **The export** (`staffing.payPeriod.export`, Rostering's `export`): the CSV as this spec says,
  with an end date on each line's times (a shift across midnight), the evidence, and text a
  spreadsheet would run prefixed with an apostrophe. A preview of an open period says so.
- **Pay is a person's only**: every pay operation refuses a caller who is not a person (the tool
  `humanOnly` and the verified caller a person) or does not handle pay. Reads of totals and exports
  are audited (`auditReads`) as which period and who; no figure, basis or reason reaches the audit
  log, a notice, a tool run or an error. Rostering adds `payBases` (a read of who is counted, not in
  this spec's tool list) beside `payBasis`.
- **Decided in review** (PR #287, coordinator's decisions the owner is asked about; ADR 0627's
  amendment): a change of the pay period or the zone after a lock takes effect from the day after
  the last locked period (periods never overlap or leave a gap); a kind's set-up and pack-down
  minutes and the times of a shift that has started are a rosterer's to change; a redacted input
  in the approval queue is read only by someone who could approve it; every CSV text cell quoted.
- **Not in this step**: the screens (7), `staffing.forget`, overtime or any pay rule.

### Built in step 7 (2026-11-24)
[ADR 0629](../adr/0629-the-rosters-screens-role-clients-with-grants-and-the-roster-import.md)
(amends ADR 0451). No migration. ADR 0628 is left to the calendar feed (step 5).
- **The blocks** (`packs/rostering/blocks`), over the pack's headless entry
  (`@composable-os/pack-rostering/client`, as every pack's: Bookings' and Ticketing's are the same
  shape): on the web, `rostering-week` (the week grid, days across from 768 px and one under another
  on a phone; each shift's kind colour, place and person; uncovered and my own marked; an open
  offer shown; read only for the team, and for a rosterer each shift opens its assign panel:
  eligible people first and the rest with the host's warnings or the shift they would clash with,
  "back to the pattern", nobody on it, offer to everyone, and mark not worked once its day has
  come), `rostering-patterns` (the regular week, a pattern's person from a date),
  `rostering-qualifications` (people down, kinds across, a tick each), `rostering-away` (everyone's
  time off by week, adding or ending someone's) and `rostering-pay` (periods, who is counted, a
  period's totals with its evidence and flags, lock, reopen, the CSV); on the web and in the app,
  `rostering-my-shifts` (offer, withdraw, my open offers), `rostering-offers` (take, with the
  unavailable confirmation), `rostering-my-availability` (leave and regular time off; the shifts it
  covers offered in one step) and, in the app, `rostering-native-roster` (the week day by day).
  The native blocks use the native base only: dates and times are typed (no date picker module).
- **Where the next steps go**: the calendar feed's block (step 5) is `my-shifts`' `calendar` slot;
  a duty shift's checklist (step 4b) is the `shiftExtra` slot of `my-shifts` and the week grid.
- **Decided here: what a screen needed is the host's** (no rule in a block, ADR 0405). New
  tool-only operations, each behind one Rostering tool: `staffing.me` (`me`, team: whether the
  reader rosters and handles pay, the zone, today there, the cut-off), `staffing.candidates`
  (`candidates`, manage: who could be put on a shift, from the write's own dry run),
  `staffing.people` (`people`, manage: the staff and the kinds of work), `staffing.patterns` and
  `staffing.setPattern` (`patterns`, `setPattern` with `personApproves`: the regular week and a
  pattern's person from a date, refused whole on a clash), `staffing.follow` (`follow`,
  `personApproves`: back to the pattern) and `staffing.planCheck` (`planCheck`, `humanOnly`: the
  import's dry run). `staffing.week` answers `days` (each local date's hours in the zone: a clock
  change is 23 or 25), and `staffing.payBases { everyone }` lists every active account. A coach
  granted `rostering:manage` rosters through these, as an admin does (they hold no core
  permission, so `recurring.change` and `recurring.follow` were out of their reach).
- **Who sees what**: every screen asks `me` first, so no block fetches what its reader may not
  see: a team member's week is read only and carries no warnings; the patterns, qualifications and
  everyone's time off show only to a rosterer, pay only to a person who handles pay. Notes, reasons
  and pay figures are kept in the app's cache no longer than they are shown (`gcTime: 0`), what was
  sent is forgotten after the call (`forgetAfter`) and the web screens hide them on leaving the
  page and read them again when the browser brings it back. The CSV is fetched when asked and
  handed over as a file.
- **Refusals**: `rosterRefusal` gives each rule its own state (`double_booked` with the dates and
  the other shift, `nobody_qualified`, `offer_stale`, `offer_taken` naming who, `offer_closed`,
  `offer_cutoff`, `unavailable_confirm`, `rostering`, `pay_period_locked`, `pay_period_held`,
  `roster_changed`, `deactivate_confirm` and the rest), keeping the host's words.
- **Role clients with grants**: the release's `roles.json` lists each grantable permission with
  the tools it opens; `mobile.roles` takes `{ role: "bookings.coach", grants: ["rostering:roster"] }`,
  and that role's client holds the granted tools too (`rostering.team`'s needs none).
- **`cos rostering import <roster.csv>`** (the spec's guess, built): duties as weekly patterns or
  one-off shifts with their person; a dry run unless `--apply`; staff never made; every row checked
  in one call by the host's own clash check (`planCheck`), clashes named by title and start (both
  ended: reported only), away and not-qualified dates as warnings; a clashing one-off shift made
  with nobody on it, a pattern made with its person and each clashing date left uncovered by the
  host; through `record.create` as the person who signed in; nothing made twice on a re-run.
  `docs/importing.md` says how.
- **Not in this step**: the checklist blocks (4b, not built), the calendar block (step 5, in
  progress), Settings → Rostering and Users (the host admin's existing screens serve), a native
  rosterer's screen (rostering is on the web), and a device test: the app's screens are typed and
  linted against the role clients but not yet tried on a phone.

**The spine is steps 2 to 4**: without the claim, the rules and the permissions, nothing can be
rostered safely. Step 1 is built; step 2 can start now and is the riskiest (every write that covers
a shift), so it gets the most careful review.

## Decided by this spec, open to override
- **A platform behaviour and a Rostering pack**, not additions to Bookings alone (above).
- **The class's coach is the only record of who coaches it**; the series' coach is its pattern.
- **Everyone rostered has a staff account**; a coach with none is covered for members and never on
  anyone's roster, feed or pay.
- **Preparation and pack-down count for pay only**, never for a clash.
- **Nobody is qualified by default**; rostering someone unqualified is a warning, a take by them is
  refused.
- **Other staff do not see anyone's unavailability.**
- **No undo of a take**; offer it on, or a rosterer reassigns.
- **Uncovered shifts are surfaced 14 days ahead** (offers closing 1 hour before is decision 21).
- **Checklists are the platform's, not a pack's**, a completed run never changes, and an AI never
  ticks (decision 15's design; decisions 22 to 25 settle photos, who sees, ticking for someone and
  the assistant).
- **A private feed, not emailed calendar files**.
- **Nobody sees their own pay totals through the pay tools**; pay is `rostering:pay`'s, a person
  only.
- **A cancelled shift counts for nothing**, whoever cancelled it and however late.

## Questions for the owner
None open. The eight questions of the proposal were answered on 2026-11-23: decisions 14 to 21
(question 1 is decision 14, question 8 is decision 21); the checklist design's four points the
same day: decisions 22 to 25. The questions as they were put, with the
recommendations, are in this file's history.

## Sources
Read 2026-11-23, all in this repository: `AGENTS.md`, `CONTEXT.md`, `docs/architecture.md`,
`docs/roadmap.md`, `docs/parallel-work.md`, stages 31, 43 and 44; ADRs 0436, 0449, 0500, 0502, 0503,
0553, 0571, 0572, and ADR 0600 on `feat/coach-desk-permissions`; issue #258;
`packages/core/src/pack-roles.ts`, `extensions/tools.ts`, `recurring/`, `operations/notification.ts`,
`operations/user.ts`, `operations/export.ts`, `packages/db/src/schema.ts` (`core_user`),
`packs/bookings` (`index.ts`, `tools.ts`, `automations.ts`, `dashboards.ts`),
`packages/gatekeeper-email-send/src/calendar.ts`, `scripts/check-stray-names.mjs`.

Not confirmed, and checked at build: that a trigger refusing an overlapping range holds under D1's
batches as capacity's CHECK does; whether `recurring.change { from }` already covers every copied
field as ADR 0500's amendment says; how a role client carries a grant's tools (ADR 0451); how often
the common phone calendars refresh a subscribed feed.
