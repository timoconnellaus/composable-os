---
title: "Rostering: screens"
sidebar:
  label: "Screens"
  order: 4
editUrl: false
---

Screens a shipped pack declares are built into the admin and shown to whoever could call every tool in `opens`. Blocks are the pack's screens for client apps, copied with `cos add`.

## Staff screens

| Screen | Label | Block | Navigation | Opens | On a record |
| --- | --- | --- | --- | --- | --- |
| `roster` | Roster | [rostering-week](/reference/blocks/rostering-week/) (`RosterWeek`) | Rostering, 10 | [week](/packs/rostering/tools/#week) |   |
| `myShifts` | My shifts | [rostering-checklist](/reference/blocks/rostering-checklist/) (`MyShiftsWithChecklist`) | Rostering, 20 | [mine](/packs/rostering/tools/#mine), [offer](/packs/rostering/tools/#offer) |   |
| `offers` | Offers | [rostering-offers](/reference/blocks/rostering-offers/) (`OffersToMe`) | Rostering, 30 | [offers](/packs/rostering/tools/#offers), [take](/packs/rostering/tools/#take) |   |
| `myTimeOff` | My time off | [rostering-my-availability](/reference/blocks/rostering-my-availability/) (`MyAvailability`) | Rostering, 40 | [myAway](/packs/rostering/tools/#myaway), [away](/packs/rostering/tools/#away) |   |
| `myCalendar` | My calendar | [rostering-my-calendar](/reference/blocks/rostering-my-calendar/) (`MyCalendar`) | Rostering, 50 | [feed](/packs/rostering/tools/#feed), [feedRotate](/packs/rostering/tools/#feedrotate) |   |
| `patterns` | Patterns | [rostering-patterns](/reference/blocks/rostering-patterns/) (`Patterns`) | Rostering, 60 | [patterns](/packs/rostering/tools/#patterns), [setPattern](/packs/rostering/tools/#setpattern) |   |
| `qualifications` | Who may do what | [rostering-qualifications](/reference/blocks/rostering-qualifications/) (`Qualifications`) | Rostering, 70 | [qualifications](/packs/rostering/tools/#qualifications), [qualify](/packs/rostering/tools/#qualify) |   |
| `timeOff` | Time off | [rostering-away](/reference/blocks/rostering-away/) (`TimeOff`) | Rostering, 80 | [awayList](/packs/rostering/tools/#awaylist), [awayFor](/packs/rostering/tools/#awayfor) |   |
| `pay` | Pay | [rostering-pay](/reference/blocks/rostering-pay/) (`Pay`) | Rostering, 90 | [periods](/packs/rostering/tools/#periods), [lock](/packs/rostering/tools/#lock) |   |
| `checklists` | Checklists | [rostering-checklists](/reference/blocks/rostering-checklists/) (`ChecklistRuns`) | Rostering, 85 | [checklistRuns](/packs/rostering/tools/#checklistruns), [checklistCorrect](/packs/rostering/tools/#checklistcorrect) |   |

## Blocks

Each drawn with dummy data.

### rostering-away

Web. Everyone's time off (stage 45 step 7), for someone who rosters: by week, who said they cannot work, with their notes, and adding or ending someone's time off for them. [The block](/reference/blocks/rostering-away/).

<img class="cos-screen" src="/screens/rostering-away.png" alt="rostering-away, drawn with dummy data" width="800" height="1037" loading="lazy" decoding="async" />

### rostering-checklist

Web. A shift's checklist (stage 45 step 4b, ADR 0650), for the `shiftExtra` slot under a shift (my shifts; a rosterer's week). [The block](/reference/blocks/rostering-checklist/).

<img class="cos-screen" src="/screens/rostering-checklist.png" alt="rostering-checklist, drawn with dummy data" width="720" height="954" loading="lazy" decoding="async" />

### rostering-checklists

Web. How checklists went (stage 45 step 4b, ADR 0650), for whoever rosters: every checklist run in a range of dates, by checklist and then by date, each with its shift, its person, whether it is open, done, missed or cancelled, how many steps were ticked, how many were ticked for the person by someone else, and the steps nobody ticked when it was missed. [The block](/reference/blocks/rostering-checklists/).

<img class="cos-screen" src="/screens/rostering-checklists.png" alt="rostering-checklists, drawn with dummy data" width="800" height="1602" loading="lazy" decoding="async" />

### rostering-my-availability

Web. My availability (stage 45 step 7), for every rostered person: the times I said I cannot work (leave and other one-off times, and regular time off such as every Wednesday afternoon), to add and to end. [The block](/reference/blocks/rostering-my-availability/).

<img class="cos-screen" src="/screens/rostering-my-availability.png" alt="rostering-my-availability, drawn with dummy data" width="800" height="777" loading="lazy" decoding="async" />

### rostering-my-calendar

Web. My calendar (stage 45 step 7, over step 5's feed, ADR 0628), for every rostered person: whether I have a private calendar address for my own shifts, making one (or a new one, which stops the old), and switching it off. [The block](/reference/blocks/rostering-my-calendar/).

<img class="cos-screen" src="/screens/rostering-my-calendar.png" alt="rostering-my-calendar, drawn with dummy data" width="720" height="356" loading="lazy" decoding="async" />

### rostering-my-shifts

Web. My shifts (stage 45 step 7), for every rostered person: my shifts over the next weeks, day by day, each with its time in the business's zone, its place, and a button to offer it to everyone who could take it, or to withdraw my open offer. [The block](/reference/blocks/rostering-my-shifts/).

<img class="cos-screen" src="/screens/rostering-my-shifts.png" alt="rostering-my-shifts, drawn with dummy data" width="800" height="1106" loading="lazy" decoding="async" />

### rostering-native-checklist

Native. A shift's checklist in the app (stage 45 step 4b, ADR 0650), for the native my-shifts' `shiftExtra` slot: the same as the web's, over the native base. [The block](/reference/blocks/rostering-native-checklist/).

<img class="cos-screen cos-screen-native" src="/screens/rostering-native-checklist.png" alt="rostering-native-checklist, drawn with dummy data" width="390" height="844" loading="lazy" decoding="async" />

### rostering-native-my-availability

Native. My availability in the app (stage 45 step 7): the times I said I cannot work, adding leave or another one-off time, or a regular time off (every week on chosen days), and ending one. [The block](/reference/blocks/rostering-native-my-availability/).

<img class="cos-screen cos-screen-native" src="/screens/rostering-native-my-availability.png" alt="rostering-native-my-availability, drawn with dummy data" width="390" height="844" loading="lazy" decoding="async" />

### rostering-native-my-calendar

Native. My calendar in the app (stage 45 step 7, over step 5's feed, ADR 0628): whether I have a private calendar address for my own shifts, making one (or a new one, which stops the old), and switching it off. [The block](/reference/blocks/rostering-native-my-calendar/).

<img class="cos-screen cos-screen-native" src="/screens/rostering-native-my-calendar.png" alt="rostering-native-my-calendar, drawn with dummy data" width="390" height="844" loading="lazy" decoding="async" />

### rostering-native-my-shifts

Native. My shifts in the app (stage 45 step 7), for every rostered person: a cleaner with the `rostering.team` role (its role client), a coach whose role client was generated with the grant `rostering:roster`, or anyone else on the roster. [The block](/reference/blocks/rostering-native-my-shifts/).

<img class="cos-screen cos-screen-native" src="/screens/rostering-native-my-shifts.png" alt="rostering-native-my-shifts, drawn with dummy data" width="390" height="844" loading="lazy" decoding="async" />

### rostering-native-offers

Native. Offered to me, in the app (stage 45 step 7): the shifts the host says I could take now, soonest first, and taking one. [The block](/reference/blocks/rostering-native-offers/).

<img class="cos-screen cos-screen-native" src="/screens/rostering-native-offers.png" alt="rostering-native-offers, drawn with dummy data" width="390" height="844" loading="lazy" decoding="async" />

### rostering-native-roster

Native. The roster in the app (stage 45 step 7), for every rostered person: the week as a day-by-day list on a phone, each day's shifts in order of start with the kind of work, the place and who is on it, shifts with nobody on them marked and my own marked as mine. [The block](/reference/blocks/rostering-native-roster/).

<img class="cos-screen cos-screen-native" src="/screens/rostering-native-roster.png" alt="rostering-native-roster, drawn with dummy data" width="390" height="844" loading="lazy" decoding="async" />

### rostering-offers

Web. Offered to me (stage 45 step 7), for every rostered person: the shifts others offered that the host says I could take now (I am qualified for the kind of work, free then, and it is before the cut-off), soonest first, and a button to take each. [The block](/reference/blocks/rostering-offers/).

<img class="cos-screen" src="/screens/rostering-offers.png" alt="rostering-offers, drawn with dummy data" width="720" height="472" loading="lazy" decoding="async" />

### rostering-patterns

Web. The regular week (stage 45 step 7), for someone who rosters: every class series' coach and duty series' regular person, day by day, and changing who works one from a date. [The block](/reference/blocks/rostering-patterns/).

<img class="cos-screen" src="/screens/rostering-patterns.png" alt="rostering-patterns, drawn with dummy data" width="1280" height="598" loading="lazy" decoding="async" />

### rostering-pay

Web. Pay (stage 45 step 7), for someone who handles pay, a person only: the pay periods, who is counted and how, a period's hours and shifts per person and kind of work with each shift's evidence (its class list taken, by whom, flagged when not by its person), locking a period that has ended, reopening one with why, and its CSV for payroll. [The block](/reference/blocks/rostering-pay/).

<img class="cos-screen" src="/screens/rostering-pay.png" alt="rostering-pay, drawn with dummy data" width="900" height="1210" loading="lazy" decoding="async" />

### rostering-qualifications

Web. Qualifications (stage 45 step 7), for someone who rosters: people down, kinds of work across (each class type, each duty), a tick each. [The block](/reference/blocks/rostering-qualifications/).

<img class="cos-screen" src="/screens/rostering-qualifications.png" alt="rostering-qualifications, drawn with dummy data" width="900" height="468" loading="lazy" decoding="async" />

### rostering-week

Web. The roster week (stage 45 step 7): a week grid, days across on a wide screen and one under another on a phone, each day's shifts in order of start with the kind of work, the place and who is on it; shifts with nobody on them marked, my own highlighted, an open offer shown. [The block](/reference/blocks/rostering-week/).

<img class="cos-screen" src="/screens/rostering-week.png" alt="rostering-week, drawn with dummy data" width="1440" height="908" loading="lazy" decoding="async" />
