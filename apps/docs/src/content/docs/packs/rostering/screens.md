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

| Block | Skin | What it shows |
| --- | --- | --- |
| [rostering-away](/reference/blocks/rostering-away/) | web | Everyone's time off (stage 45 step 7), for someone who rosters: by week, who said they cannot work, with their notes, and adding or ending someone's time off for them. |
| [rostering-checklist](/reference/blocks/rostering-checklist/) | web | A shift's checklist (stage 45 step 4b, ADR 0650), for the `shiftExtra` slot under a shift (my shifts; a rosterer's week). |
| [rostering-checklists](/reference/blocks/rostering-checklists/) | web | How checklists went (stage 45 step 4b, ADR 0650), for whoever rosters: every checklist run in a range of dates, by checklist and then by date, each with its shift, its person, whether it is open, done, missed or cancelled, how many steps were ticked, how many were ticked for the person by someone else, and the steps nobody ticked when it was missed. |
| [rostering-my-availability](/reference/blocks/rostering-my-availability/) | web | My availability (stage 45 step 7), for every rostered person: the times I said I cannot work (leave and other one-off times, and regular time off such as every Wednesday afternoon), to add and to end. |
| [rostering-my-calendar](/reference/blocks/rostering-my-calendar/) | web | My calendar (stage 45 step 7, over step 5's feed, ADR 0628), for every rostered person: whether I have a private calendar address for my own shifts, making one (or a new one, which stops the old), and switching it off. |
| [rostering-my-shifts](/reference/blocks/rostering-my-shifts/) | web | My shifts (stage 45 step 7), for every rostered person: my shifts over the next weeks, day by day, each with its time in the business's zone, its place, and a button to offer it to everyone who could take it, or to withdraw my open offer. |
| [rostering-native-checklist](/reference/blocks/rostering-native-checklist/) | native | A shift's checklist in the app (stage 45 step 4b, ADR 0650), for the native my-shifts' `shiftExtra` slot: the same as the web's, over the native base. |
| [rostering-native-my-availability](/reference/blocks/rostering-native-my-availability/) | native | My availability in the app (stage 45 step 7): the times I said I cannot work, adding leave or another one-off time, or a regular time off (every week on chosen days), and ending one. |
| [rostering-native-my-calendar](/reference/blocks/rostering-native-my-calendar/) | native | My calendar in the app (stage 45 step 7, over step 5's feed, ADR 0628): whether I have a private calendar address for my own shifts, making one (or a new one, which stops the old), and switching it off. |
| [rostering-native-my-shifts](/reference/blocks/rostering-native-my-shifts/) | native | My shifts in the app (stage 45 step 7), for every rostered person: a cleaner with the `rostering.team` role (its role client), a coach whose role client was generated with the grant `rostering:roster`, or anyone else on the roster. |
| [rostering-native-offers](/reference/blocks/rostering-native-offers/) | native | Offered to me, in the app (stage 45 step 7): the shifts the host says I could take now, soonest first, and taking one. |
| [rostering-native-roster](/reference/blocks/rostering-native-roster/) | native | The roster in the app (stage 45 step 7), for every rostered person: the week as a day-by-day list on a phone, each day's shifts in order of start with the kind of work, the place and who is on it, shifts with nobody on them marked and my own marked as mine. |
| [rostering-offers](/reference/blocks/rostering-offers/) | web | Offered to me (stage 45 step 7), for every rostered person: the shifts others offered that the host says I could take now (I am qualified for the kind of work, free then, and it is before the cut-off), soonest first, and a button to take each. |
| [rostering-patterns](/reference/blocks/rostering-patterns/) | web | The regular week (stage 45 step 7), for someone who rosters: every class series' coach and duty series' regular person, day by day, and changing who works one from a date. |
| [rostering-pay](/reference/blocks/rostering-pay/) | web | Pay (stage 45 step 7), for someone who handles pay, a person only: the pay periods, who is counted and how, a period's hours and shifts per person and kind of work with each shift's evidence (its class list taken, by whom, flagged when not by its person), locking a period that has ended, reopening one with why, and its CSV for payroll. |
| [rostering-qualifications](/reference/blocks/rostering-qualifications/) | web | Qualifications (stage 45 step 7), for someone who rosters: people down, kinds of work across (each class type, each duty), a tick each. |
| [rostering-week](/reference/blocks/rostering-week/) | web | The roster week (stage 45 step 7): a week grid, days across on a wide screen and one under another on a phone, each day's shifts in order of start with the kind of work, the place and who is on it; shifts with nobody on them marked, my own highlighted, an open offer shown. |
