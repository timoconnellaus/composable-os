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
[0572](../adr/0572-bookings-messages-the-dashboard-and-the-coachs-app-screen.md); ADR 0600 (a pack
role and its grants add up, issue [#258](https://github.com/timoconnellaus/composable-os/issues/258),
on `feat/coach-desk-permissions`, not yet merged); stage [31](31-bookings.md) (all of 31a, and 31b's
time-range claim); `packages/core/src/recurring/`, `packages/core/src/pack-roles.ts`,
`pack-role-today.ts`, `packages/core/src/operations/notification.ts`, `operations/user.ts`,
`operations/export.ts`, `packages/core/src/extensions/tools.ts`, `packs/bookings` (`index.ts`,
`tools.ts`, `automations.ts`, `dashboards.ts`), `packages/gatekeeper-email-send/src/calendar.ts`.

Status: **spec proposed** (owner interviewed 2026-11-23; the questions at the end are still open).
Builds on stage 31a (built) and ADR 0600 (in flight). Replaces the roadmap's placeholder stage 40
(Rosters), which was never specced. Where this spec guesses, it says **(guess)**.

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
  once. `generates` must be another object of the same extension. **An edit to a made record's
  times, zone, copied fields or state by anyone but the host marks the whole record `changed`**,
  and the series never writes to it again: one coach swapped on one date detaches that class from
  every later change to its series (room, places, time). `recurring.change { from }` applies a
  series change from a date; a change that moves records with places taken needs the count
  confirmed.
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
- **Pack roles and grants** (ADRs 0436, 0449, and 0600 in flight). An account holds at most one pack
  role (`core_user.pack_role`), which replaces its role. ADR 0600 makes a pack role and its grants
  add up: a pack-role account may be granted any **pack** permission a shipped pack declares
  `grantable` (`bookings:desk`), never a core permission; a permission a role holds cannot be
  grantable; a tool may name several permissions (`day` is `["bookings:coach", "bookings:desk"]`);
  the role's today limit applies only to calls that come through the role.
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
| 10 | **Pay**: staff are salaried, part-time or hourly, so the roster feeds a pay period for some people, not all. Recorded reading: each staff member is marked as **counted by time, counted by class, or not counted**; the host totals rostered hours and classes per pay period for those counted and exports them for payroll. **It holds no pay rates, calculates no pay and runs no payroll.** Whether it should hold rates is question 1 |
| 11 | **All staff see everyone's shifts**; members see only the coach on each class |
| 12 | **Members are not emailed when a class's coach changes**; the timetable shows the new coach (as Bookings already behaves) |
| 13 | Start now, in parallel with the rest |

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
restricted permission held by admins and by grant.

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

### Platform: patterns and exceptions (amends `recurring`)
- **The series' person is the pattern.** For classes, `bookings.series.coach`, unchanged. For
  duties, `rostering.dutyseries.staff`. Changing it applies from a date to future shifts whose
  person was not changed by hand (`recurring.change { from }`). A change that would double-book
  someone on any date is refused whole, naming the dates; the rosterer settles those dates first.
- **Field-level exceptions** (an amendment to ADR 0500): a write that changes only a copied field
  marks **that field** as the occurrence's own (`core_recurrence_occurrence.edited_fields`). The
  series never writes that field again, and still writes the others. A change of times, zone or
  state still detaches the whole record, as today. So a coach swapped for one Monday keeps the
  swap when the owner later moves the class to another room. Host writes of the person (a take) mark
  the field too, so a series change never overwrites a take.
- **Back to the pattern**: setting the field back to the series' value clears its mark (guess), and
  the roster's "back to the pattern" action does that.
- `changed` stays true for a whole-record edit only. Bookings' `changed` field's description
  changes to say so.

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
- **The cut-off**: an offer can be made and taken until 1 hour before the shift starts (a setting,
  guess); then it lapses. Closer to the start, the rosterer reassigns.
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
| `rostering:manage` | admins; grantable; **restricted** | roster anyone, patterns, qualifications, others' unavailability, offer uncovered shifts, mark not worked |
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
  question 6).
- Bookings' dashboard: classes with no coach in the dates. Its automations are unchanged: a coach
  change still sends members nothing (decision 12).
- Bookings' existing tool `roster` keeps its name and meaning (the class list).

### Pack: Rostering (`packs/rostering`)
| Object | What | Behaviours |
| --- | --- | --- |
| `rostering.duty` | Name (Cleaning, Open up), colour, default length, place, what to do (text: question 2), active | none |
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
- **Settings** (a person's, `personApproves`): the offer cut-off (60 minutes), the uncovered window
  (14 days), the duty horizon (56 days), the pay period (below).
- **Notification words** are the pack's; the host sends them (below).

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
- **The period** is a setting: weekly, fortnightly or monthly; for weekly and fortnightly, the date
  one period starts (which fixes the weekday); for monthly, the day of the month (1 to 28). In the
  organisation's zone. A shift belongs to the period of its local start date.
- **Who is counted** (`core_staff_pay_basis`, set by `rostering:pay`): `by_time`, `by_class` or
  `not_counted` (the default). Salaried staff are not counted.
- **What is totalled**, per counted person and kind: the number of shifts (classes for class kinds)
  and the hours (each shift's end minus start, plus the class type's before and after minutes).
  Cancelled shifts and shifts **marked not worked** count for nothing.
- **Rostered, corrected before the lock** (question 5): the total is the roster as it stands when the
  period is locked. A rosterer corrects it first: who actually worked a class (reassign it, which
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

## Out of scope
- Pay rates, pay amounts, payroll, tax, award rules, overtime and penalty rates (decision 10;
  question 1).
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
3. **Patterns**: a class series' coach and a duty series' person fill every shift in the horizon; a
   coach swapped for one date keeps the swap after the series changes room, places and coach from
   a later date; setting it back clears the exception; a pattern change that would double-book on
   any date is refused whole, naming the dates.
4. **The take race**: twenty eligible people taking one offer at once: exactly one is on the shift,
   one time claim moved, the rest told who took it; a take by someone not qualified is refused; a
   take after the cut-off is refused and the offer has lapsed; the offerer stays on the shift until
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
10. **Pay totals** match a fixture worked out by hand: a fortnight with hourly, per-class and
    not-counted staff, a cancelled class, a shift marked not worked, a take mid-period, a class with
    before and after minutes, a shift across midnight and a clock change; the CSV matches it line by
    line; after the lock, a change to a shift in the period is refused; reopening is a person's and
    audited; nothing of pay is in any `rec_*` view, `query.sql`, a dashboard or `export.csv`.
11. **Members**: stage 22's isolation suite with Rostering installed: a customer and the public read
    a class's coach name, photo and bio and nothing else of staff; every Rostering object is
    invisible to them; a coach swap sends no member email.
12. **Leaving**: deactivating a coach with future classes and a duty pattern makes each uncovered,
    tells rosterers, cancels their offers and keeps past shifts; `staffing.forget` keeps locked pay
    lines and is refused while an unlocked period counts them.
13. `pnpm lint typecheck test`, `cos ext check` and `cos ext test` on `packs/rostering` and
    `packs/bookings`, the block lint, and one e2e test per journey (the owner rosters a week with a
    warning; a coach offers a shift and another takes it; a cleaner sees their shifts and adds leave;
    the pay export of a locked period) pass in CI. ADRs for each platform piece; `CONTEXT.md` and
    `docs/architecture.md` updated.

## Dependencies
- Stage 31a (built). ADR 0600 (issue #258, `feat/coach-desk-permissions`) merged before step 4.
- 31b's time-range claim is this stage's step 2; whichever builds first builds it, and 31b's spec
  is amended to point here.
- Nothing from stages 32b, 43 or 44. Stage 33 uses step 7.

## Migrations and numbers
The next free block in [`parallel-work.md`](../parallel-work.md), claimed in the build's first
commit (block AU, migrations 0790 to 0809 and ADRs 0610 to 0619, looks next free on 2026-11-23):
`core_staff_time` and its triggers, `core_recurrence_occurrence.edited_fields`,
`core_staff_qualification`, `core_staff_away`, `core_staff_offer` (with a guard kind),
`core_staff_feed`, `core_staff_pay_basis`, `core_pay_period`, `core_pay_line`, the not-worked mark.
No `x_*` table is touched by a migration. ADRs the build will need (not written until built):
1. The `staffed` behaviour and the time claim (31b's time-range claim).
2. Field-level exceptions in `recurring` (amends ADR 0500).
3. Warnings in a write's answer, and qualifications and unavailability as core.
4. Offers and takes: the race, the cut-off.
5. Restricted pack permissions (amends ADRs 0436, 0449 and 0600).
6. The calendar feed and the shared calendar writer (amends ADR 0571).
7. Pay periods: the basis, the totals, the lock, the export.
8. The Rostering pack and Bookings' additions; leaving and `staffing.forget` (amends ADR 0553's
   coach role note on what a coach reaches).

## Suggested build order
| Step | What | Files it touches | Runs beside stages 31, 32, 43 and 44? |
| --- | --- | --- | --- |
| 1 | **Field-level exceptions** in `recurring` | `packages/core/src/recurring/`, `operations/recurring.ts`, a migration | **Yes, now.** Collides only with 31a step 10's import if it matches generated classes (agree the order) |
| 2 | **`staffed` and the time claim**: the declaration, `core_staff_time` and its trigger, warnings in the write's answer, `staffing.check`; Bookings' class declares it, `bookings.coach.user` unique | `packages/sdk` (the declaration, contract), `packages/core/src/staffing/` (new), `records/` writes (the claim in the batch), a migration, `packs/bookings/index.ts` | **Yes, now**, but **not beside 31b** (same piece: one session builds it) and agree with stage 44 step 2 on the order of `core_write_guard` migrations |
| 3 | **Qualifications, unavailability, offers and takes, uncovered**, the host's notices, `user.deactivate`'s answer | `staffing/`, `operations/user.ts` (deactivate), notifications, a migration | After step 2. Beside 43 and 44, which do not touch these files |
| 4 | **Permissions**: restricted pack permissions; the `rostering.team` role; the Rostering pack's spine (duties, duty series, duty shifts, tools, settings); `personApproves` on Bookings' coach fields | `pack-roles.ts`, `extensions/tools.ts`, `packages/sdk/src/manifest.ts`, `packs/rostering` (new), `packs/bookings/index.ts` | **After ADR 0600 merges** (same files). Not beside other pack-role work |
| 5 | **The feed** and the shared calendar writer | `apps/app/src/server/http/` (a route), `access-layout.ts`, `packages/gatekeeper-email-send/src/calendar.ts` (moved), a migration | Beside anything but stage 43 step 3 (sign-in routes) and stage 44 step 4 (the same gatekeeper files): agree the order |
| 6 | **Pay**: the basis, periods, totals with evidence, lock, export | `staffing/pay.ts` (new), `packs/rostering` tools, a migration | Yes, after step 3 |
| 7 | **Blocks and hooks**: the week grid, assign, patterns, qualifications, pay (web); my shifts, offers, availability, calendar, the roster (web and native); role clients with grants; `cos rostering import` | `packs/rostering/blocks`, `client/`, `packages/client` codegen (`mobile.roles`), `packages/create-composable-os` | Yes, once steps 3 and 4 are merged |
| 8 | **The first client**: invites, qualifications, patterns from the moved timetable, a fortnight's pay export checked by the owner | The first client's own repository | After 7, with stage 33 |

**The spine is steps 2 to 4**: without the claim, the rules and the permissions, nothing can be
rostered safely. Steps 1 and 2 can start today; step 2 is the riskiest (every write that covers a
shift) and gets the most careful review.

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
- **Offers close 1 hour before a shift**; uncovered shifts are surfaced 14 days ahead.
- **A private feed, not emailed calendar files**.
- **Nobody sees their own pay totals through the pay tools**; pay is `rostering:pay`'s, a person
  only.
- **A cancelled shift counts for nothing**, whoever cancelled it and however late.

## Questions for the owner
1. **Should the system hold pay rates (an hourly rate, a rate per class)?**
   - (a) No: it exports hours and classes, and payroll applies the rates.
   - (b) Yes: a rate per person (and per kind), and the export shows amounts.
   **Recommended: (a).** Rates change with awards, ages and agreements; payroll already holds them,
   and a second copy goes wrong quietly. Amounts are added later if payroll cannot take hours.
2. **Do cleaning shifts need a checklist, or just a time and a person?**
   - (a) A time, a person and a short "what to do" note on the duty.
   - (b) A checklist ticked off on each shift.
   **Recommended: (a).** It is what was asked; a checklist is a second feature (tasks with ticks and
   evidence) and can follow when someone needs to prove the clean was done.
3. **Does anyone other than you roster?**
   - (a) Only you (admins).
   - (b) You, and named people you tick (`rostering:manage`).
   **Recommended: (b), ticked for nobody to begin with.** The permission exists either way; it costs
   nothing until it is given.
4. **How far ahead is the pattern made into shifts?**
   - (a) 8 weeks, as the classes are.
   - (b) Further (12 or 26 weeks), so staff can plan leave against it.
   **Recommended: (a).** Classes are already made 8 weeks ahead (or as far as booking opens); one
   horizon for both keeps the roster whole, and the regular week is on the patterns screen.
5. **What counts as worked for pay?**
   - (a) The roster as corrected before the period is locked, with the class list's ticks shown as
     evidence.
   - (b) Only classes whose list the rostered coach ticked, plus duty shifts.
   - (c) Clocking in and out.
   **Recommended: (a).** Ticks are not always taken, and the coach who ticks is not always the one
   who ran it; (c) is a new feature. The person locking the period checks the flags.
6. **Are coaches paid for time before and after a class (setting up, packing down)?**
   - (a) No, the class's own time.
   - (b) Yes, a set number of minutes per class type.
   **Recommended: tell us your rule.** The spec supports both (default 0); it only changes hours.
7. **What is your pay period?** Weekly, fortnightly or monthly, and the day it starts.
   **Recommended: your payroll's own.** One setting.
8. **How close to a shift may it be offered and taken?**
   - (a) Until 1 hour before.
   - (b) Until 12 or 24 hours before; after that, you reassign.
   **Recommended: (a).** It lets a coach who wakes up ill still hand a class over without calling you,
   and you are told of every take.

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
