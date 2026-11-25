---
title: "Bookings: decisions"
sidebar:
  label: "Decisions"
  order: 90
editUrl: false
---

The decisions this pack rests on, as recorded in the repository's ADRs.

| ADR | Decision |
| --- | --- |
| [ADR 0404](https://github.com/timoconnellaus/composable-os/blob/main/docs/adr/0404-behaviours-are-the-vocabulary.md) | Behaviours are the vocabulary products are composed from |
| [ADR 0500](https://github.com/timoconnellaus/composable-os/blob/main/docs/adr/0500-recurring-a-weekly-rule-in-local-time.md) | `recurring`: a weekly rule in local time, made ahead by the minute cron |
| [ADR 0501](https://github.com/timoconnellaus/composable-os/blob/main/docs/adr/0501-a-record-s-states-claim-its-place.md) | Capacity claimants: a record's states hold, take and give back its place |
| [ADR 0502](https://github.com/timoconnellaus/composable-os/blob/main/docs/adr/0502-declared-uniqueness.md) | Declared uniqueness, refused by a partial unique index |
| [ADR 0503](https://github.com/timoconnellaus/composable-os/blob/main/docs/adr/0503-time-windows-and-staff-only-on-the-transition-engine.md) | Time windows, staff-only rules and requested moves on the transition engine |
| [ADR 0504](https://github.com/timoconnellaus/composable-os/blob/main/docs/adr/0504-the-bookings-pack.md) | The Bookings pack (its spine) |
| [ADR 0505](https://github.com/timoconnellaus/composable-os/blob/main/docs/adr/0505-window-numbers-through-two-relations-and-settings.md) | Window numbers through two relations and over the extension's settings |
| [ADR 0506](https://github.com/timoconnellaus/composable-os/blob/main/docs/adr/0506-a-spender-paid-another-way.md) | A spender paid another way (`waived`) |
| [ADR 0507](https://github.com/timoconnellaus/composable-os/blob/main/docs/adr/0507-what-the-bookings-review-needed-of-the-platform.md) | What the Bookings review needed of the platform |
| [ADR 0520](https://github.com/timoconnellaus/composable-os/blob/main/docs/adr/0520-a-waitlist-on-a-claimant.md) | A waitlist on a capacity claimant: a freed place is held for it, the host promotes |
| [ADR 0550](https://github.com/timoconnellaus/composable-os/blob/main/docs/adr/0550-timed-moves-and-a-cancel-that-races-a-booking.md) | Timed moves (`states.after`), and a cancel that races a booking |
| [ADR 0551](https://github.com/timoconnellaus/composable-os/blob/main/docs/adr/0551-staff-bound-windows-and-a-move-only-by-its-new-record.md) | Windows on staff-only moves, and a move made only by its new record |
| [ADR 0552](https://github.com/timoconnellaus/composable-os/blob/main/docs/adr/0552-a-tool-a-person-approves.md) | A tool a person approves (`personApproves` on a tool) |
| [ADR 0553](https://github.com/timoconnellaus/composable-os/blob/main/docs/adr/0553-attendance-the-coach-role-moves-and-cancelling-a-class.md) | Bookings: attendance, the coach role, moving people and cancelling a class |
| [ADR 0560](https://github.com/timoconnellaus/composable-os/blob/main/docs/adr/0560-a-paid-line-moves-a-record-that-exists.md) | A paid line moves a record that exists (`sellable.moves`), and drop-ins |
| [ADR 0570](https://github.com/timoconnellaus/composable-os/blob/main/docs/adr/0570-date-relative-triggers-in-minutes.md) | Date-relative triggers in minutes |
| [ADR 0571](https://github.com/timoconnellaus/composable-os/blob/main/docs/adr/0571-a-calendar-file-made-by-the-email-gatekeeper.md) | A calendar file made by the email gatekeeper |
| [ADR 0572](https://github.com/timoconnellaus/composable-os/blob/main/docs/adr/0572-bookings-messages-the-dashboard-and-the-coachs-app-screen.md) | Bookings' messages, the dashboard and the coach's screen in the app |
| [ADR 0600](https://github.com/timoconnellaus/composable-os/blob/main/docs/adr/0600-a-pack-role-and-its-grants-add-up.md) | A pack role and its grants add up; the front desk's permission |
| [ADR 0620](https://github.com/timoconnellaus/composable-os/blob/main/docs/adr/0620-field-level-exceptions-in-recurring.md) | Field-level exceptions in `recurring` |
| [ADR 0621](https://github.com/timoconnellaus/composable-os/blob/main/docs/adr/0621-the-staffed-behaviour-and-the-time-claim.md) | The `staffed` behaviour and the time claim |
| [ADR 0760](https://github.com/timoconnellaus/composable-os/blob/main/docs/adr/0760-claim-margins-and-a-required-account-on-staffed.md) | Claim margins and a required account on `staffed` |
| [ADR 0761](https://github.com/timoconnellaus/composable-os/blob/main/docs/adr/0761-a-shift-that-names-a-client-kept-off-the-roster-and-the-feed.md) | A shift that names a client, kept off the roster and the feed |
| [ADR 0762](https://github.com/timoconnellaus/composable-os/blob/main/docs/adr/0762-open-hours-and-free-times.md) | Open hours and free times |
| [ADR 0763](https://github.com/timoconnellaus/composable-os/blob/main/docs/adr/0763-the-customers-check-on-a-free-time.md) | The customer's check on a free time, and staff warnings |
| [ADR 0764](https://github.com/timoconnellaus/composable-os/blob/main/docs/adr/0764-appointments-in-the-bookings-pack.md) | Appointments in the Bookings pack, booked by staff |
| [ADR 0765](https://github.com/timoconnellaus/composable-os/blob/main/docs/adr/0765-occupies-the-claim-on-a-thing.md) | `occupies`, the claim on a thing |

The specification is stage 31's, [31-bookings.md](https://github.com/timoconnellaus/composable-os/blob/main/docs/stages/31-bookings.md).
