---
title: "Rostering"
description: "Who works when. Duties that are not classes, their weekly patterns and dated shifts, and the roster of every shift, with offers, takes, time off, checklists and pay-period totals."
sidebar:
  label: "Overview"
  order: 0
editUrl: false
---

Who works when. Duties that are not classes, their weekly patterns and dated shifts, and the roster of every shift, with offers, takes, time off, checklists and pay-period totals.


## What it is for

Rostering keeps a business's roster on its host. The owner sets the regular week once (who takes
which class, who cleans on which evenings) and the host keeps that pattern going, week after week,
while the owner edits the exceptions. Staff see their own shifts on the web and in the app, and in
their phone's calendar through a private feed. They say when they are away. They offer a shift
they cannot work, and another qualified person takes it without anybody approving. The host
refuses to put one person in two places at once and warns about the rest: someone away, someone
not qualified, a shift with nobody on it. For staff paid by the hour or by the shift, the host
totals each pay period and exports it for payroll. It holds no rates and no money: hours and
counts only.

It requires no other pack. A business with shifts and no classes uses it alone; with
[Bookings](/packs/bookings/) installed, Bookings' classes are shifts on the same roster.

## Concepts

- **Shift**: a record that declares [`staffed`](/reference/behaviours/#staffed): a time, a kind of
  work and at most one staff account on it. Bookings' class is a shift (its coach is the person,
  its class type the kind); so is Rostering's duty shift.
- **Duty** (`rostering.duty`): a kind of work that is not a class (cleaning, opening up), with its
  usual length, place, instructions and optionally a checklist.
- **Duty series** (`rostering.dutyseries`): a duty on chosen weekdays at a local time, with its
  regular person. The host makes its shifts ahead, as far as the duty horizon setting says.
- **Duty shift** (`rostering.shift`): one dated shift of a duty.
- **Offer and take**: a person offers a shift they cannot work; another qualified person takes
  it. Exactly one take wins, decided by the database. Offers close a set time before the shift.
- **Qualification**: which kinds of work a staff account may do, kept by the host.
- **Time off** (unavailability): when a staff account is away. Kept by the host, out of every
  bulk read.
- **Pay period**: weekly, fortnightly or monthly. The host totals each person's hours and shifts
  in it, with the shifts as evidence, and a person with the pay permission locks, reopens and
  exports it.
- **Checklist**: a template the business writes once (Settings → Checklists) and attaches to a
  duty. Each of its shifts gets a run, which the shift's person ticks off; a done run never
  changes.
- **The team role** (`rostering.team`): for someone with no other access (a cleaner): the roster,
  their own shifts, offers and takes, their time off, their calendar feed and their own pay totals.

## How the pieces fit

The rules are platform behaviour, the screens and duties are the pack's:

- **`staffed` and the time claim** are the host's. One staff account is never on two overlapping
  shifts, classes and duties alike, refused by the database for every writer. Each write of a
  shift answers its warnings (away, not qualified, nobody on it).
- **A duty series declares [`recurring`](/reference/behaviours/#recurring).** A person or time
  changed by hand on one date stays that date's own while the series changes around it.
- **Qualifications, time off, who is counted for pay, pay periods and feed tokens** are core
  tables keyed by staff account, in no `rec_*` view, read only through the host's operations.
- **The pack's tools compose the host's tool-only `staffing.*` operations**, which hold the rules.
  The roster read spans every staffed object on the host, so the roster shows Bookings' classes
  without Rostering requiring Bookings.
- **Permissions** are the pack's ([permissions and roles](/packs/rostering/permissions/)):
  `rostering:team` (the team role), `rostering:roster` (the same tools, grantable to an account
  with another role, such as a coach), `rostering:manage` (put people on shifts, qualifications,
  others' time off, uncovered shifts; restricted: admins and those granted it) and `rostering:pay`
  (pay totals, lock, reopen, export; restricted, and every pay tool is a person's only).
- **Who is on a shift, and a duty series' regular person, are a person's to change**: an
  assistant's change waits for a person.
- **Checklists** are a platform piece any pack can use: the duty declares
  [`checklists`](/reference/behaviours/#checklists), and the host makes a run for each shift.
- **The screens are the pack's blocks** over its headless client, declared as staff screens in the
  admin and shown to whoever may open each.

## Main flows

1. **Set the regular week.** A rosterer makes duties and duty series with their regular person
   (`setPattern`, `patterns`); the host makes the shifts ahead. Bookings' series make its classes.
2. **See the roster.** Everyone rostered sees the week (`week`), and their own shifts (`mine`);
   someone who rosters also sees each shift's warnings and the uncovered shifts (`uncovered`).
3. **Put someone on a shift.** A rosterer assigns a person (`assign`), checking candidates first
   (`candidates`, `check`); a clash is refused, the rest come back as warnings.
4. **Offer and take.** A person offers a shift (`offer`) or withdraws the offer (`withdraw`);
   another qualified person takes it (`offers`, `take`), with no approval; rosterers are told.
5. **Time off.** A person says when they are away (`away`, `myAway`, `back`); rosterers record
   others' (`awayFor`, `awayList`).
6. **Calendar feed.** Each rostered person has a private calendar address (`feed`), which they
   can rotate or revoke (`feedRotate`, `feedRevoke`).
7. **Checklists.** On a shift with a checklist, its person ticks the steps (`checklist`, `tick`,
   `checklistDone`); rosterers read how runs went and add corrections (`checklistRuns`,
   `checklistCorrect`).
8. **Pay periods.** A person with the pay permission sets who is counted (`payBasis`, `payBases`),
   reads the totals (`periods`, `periodTotals`), marks a shift not worked (`markNotWorked`), locks,
   reopens and exports a period (`lock`, `reopen`, `export`). Each rostered person reads only
   their own totals (`myPayPeriods`, `myPay`).
9. **Bring in an existing roster.** `cos rostering import <roster.csv>` loads duties and who works
   them, as a dry run unless `--apply`; the host checks every date for a clash first.

## What is built

All of stage 45's build steps, as the code has them:

- field-level exceptions in `recurring` and the `staffed` behaviour with the time claim and
  warnings;
- qualifications, time off, offers and takes, uncovered shifts, the notices and leaving
  (deactivating an account leaves its future shifts uncovered);
- restricted pack permissions, the team role and the pack's objects and tools;
- the private calendar feed and the shared calendar writer;
- pay periods: who is counted, totals with evidence, the not-worked mark, the lock, reopening and
  the export;
- checklists on duties, and the screens as web and native blocks, role clients with grants and
  `cos rostering import`.

Checklists without a roster (a daily check on its own) are the [Daily checklists](/packs/dailychecks/)
pack's.

Not in the code: pay rates, amounts and payroll, timesheets and clocking in, leave approval and
balances, connections to outside calendars, two coaches on one class, rules other than weekly,
and a native screen for rostering others.


## Reference

Generated from the code:

- [Data model](/packs/rostering/data-model/)
- [Operations and tools](/packs/rostering/tools/)
- [Permissions and roles](/packs/rostering/permissions/)
- [Screens](/packs/rostering/screens/)
- [Messages](/packs/rostering/messages/)
- [Settings](/packs/rostering/settings/)
- [Decisions](/packs/rostering/decisions/)

The specification is stage 45's, [45-rostering.md](https://github.com/timoconnellaus/composable-os/blob/main/docs/stages/45-rostering.md).

This page is [rostering/docs/overview.md](https://github.com/timoconnellaus/composable-os/blob/main/packs/rostering/docs/overview.md), written by hand beside the code.
