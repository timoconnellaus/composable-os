---
title: "Jobs"
description: "Jobs and projects moving through pipelines of stages, with sites, visits booked with a crew who are never in two places at once, lines of what is quoted, added and used, variations, charge-out rates and a download of what is unbilled."
sidebar:
  label: "Overview"
  order: 0
editUrl: false
---

Jobs and projects moving through pipelines of stages, with sites, visits booked with a crew who are never in two places at once, lines of what is quoted, added and used, variations, charge-out rates and a download of what is unbilled.


## What it is for

Jobs runs the work of a trades or services business (an electrician, a plumber, a cleaner, an
installer) from the first call to what is owed. An enquiry becomes a job; the office records that
the customer accepted the work; visits are booked with a crew; on site the crew records the
materials they used and proposes extra work (a variation), which the office approves on the
customer's word; and the office downloads what is owed for its accounting system. A business with
no site visits (an agency, a studio) uses the same record as a plain project, with tasks and a
board of stages.

It requires no other pack. Beside Rostering, a crew member's place on a visit is on the same
roster as everyone's shifts.

## Concepts

- **Job** (`jobs.job`): a piece of work for a customer (a Person), or an internal project: its
  title, customer, organisation, site, pipeline and stage, how it is charged (**fixed price** or
  **time and materials**), default rate, owner, description and lost reason. It keeps three facts
  the host sets: **accepted** (when, and whether by a quote or by the office on the customer's
  word), **signed off** and **invoiced**.
- **Pipeline** and **job stage** (`jobs.pipeline`, `jobs.stage`): a kind of job and its steps,
  edited under Settings. Seeded: **Trades** (Enquiry, Site visit, Quoting, Quote sent, Accepted,
  Scheduled, In progress, Complete, Signed off, Invoiced, Paid, Lost, Cancelled) and **Projects**
  (Planning, In progress, Review, Done, Cancelled).
- **Site** (`jobs.site`): where the work is: an address, its customer and any hazards the crew
  should know of. It keeps no access codes.
- **Visit type** (`jobs.visittype`): a kind of visit (Site visit, Electrical, Plumbing, Clean): its
  usual length, the checklist each person on it ticks, and what someone must be qualified for.
- **Visit** (`jobs.visit`): one booked time at a job's site, with an arrival window for the customer
  and notes for the crew. Booked, on the way, on site, then done, missed or cancelled.
- **Crew place** (`jobs.assignment`): one person's place on a visit, a shift at the visit's time,
  booked or cancelled.
- **Line** (`jobs.line`): something quoted, added, used or owed: an **estimate**, **variation**,
  **material** or **labour** line, with a quantity, unit, unit price, cost and tax code. Draft,
  approved, billed or void.
- **Variation** (`jobs.variation`): a change to agreed work (why, who asked, its lines), proposed,
  then approved, declined or withdrawn.
- **Rate** (`jobs.rate`): a charge-out rate per hour (seeded Standard, After hours, Apprentice,
  with no price until the business sets one).

## How the pieces fit

- **The facts are the host's, not a drag on the board.** Accepted needs the accepted fact, Signed
  off the sign-off and Invoiced an invoice ([stages](/reference/behaviours/#stages)). A person, the
  assistant, an MCP client or an import moving a job into one of them is refused, naming the
  missing fact, and nobody writes a fact on a form. The stages that wait on a fact are changed only
  by an admin in person. Until quotes are built, the office records an acceptance with
  `recordAcceptance`: a person's own act, recorded as the office's, approving exactly the estimate
  lines the customer accepted.
- **A crew moves with its visit.** Each crew place takes its visit's start, end, time zone and type
  from the host, in the visit's own write ([staffed](/reference/behaviours/#staffed)): moving a
  visit, by any path, moves its whole crew, and a move that would put anyone in two places at once
  is refused whole, naming them. Two people putting one person on two overlapping visits at once:
  one succeeds. A crew place is saved with its warnings (the person away, or not qualified for the
  visit type), which never stop it. Cancelling a visit cancels its crew places. Crew places are on
  the roster and in each person's calendar feed as any shift is, shown to other staff as the visit
  type, since a job's title can name the customer.
- **Who books.** Booking, moving and cancelling visits and putting crew on and off them are a
  person's acts: the assistant and MCP clients ask, and a person approves. With Rostering
  installed, only someone who rosters says who works a shift, by any path.
- **A visit's moves are its tools'.** On the way, on site, done and missed are marked by someone on
  the visit or the office, a person's own act; cancelling is the office's. No record write moves a
  visit, and a booked visit goes to the Trash only by a person who may use those tools.
- **The crew sees only its own jobs.** A crew account (the **Crew** role) reaches the jobs, visits
  and crew places of its own booked crew places, from a week before the visit to a week after;
  any other job is not found. It reads no line, rate
  or site record; `myVisits` and `myJob` show it the site's address and hazards for its own jobs,
  and quantities, never prices. It marks its visits, records materials and proposes variations on
  its own jobs only.
- **A line never changes once written.** What a line is, for which job, how many and at what price
  are written only by the pack's tools, when the line is made. Correcting a draft (pricing a
  material the crew recorded) voids it as replaced and makes a corrected copy. Approving a line,
  voiding it and billing it are moves only the tools and the host make, so an approved line is
  never edited, moved to another job, or put in the Trash by a record write.
- **A variation is decided before the work.** The office approves or declines it on the
  customer's word (a person's own act, recorded as the office's, never as the customer's), or
  withdraws it; its lines are approved or voided with it, in the same write.
- **What is owed.** A fixed-price job owes its approved estimate and variation lines; a time and
  materials job its approved labour and material lines. Each line's amount is its quantity times its
  unit price in cents, rounded once, and every total is a whole number of cents.
- **Prices are the office's.** Pricing, approving and voiding lines and reading what is owed need
  `jobs:prices`, held by admins and whoever an admin grants it to. The download is a person's own
  and is in the audit log every time. `jobs:manage`, `jobs:schedule` and `jobs:crew` are every
  member's.

## Main flows

1. **Take an enquiry.** `enquire` with a title, the customer and a site (an existing one, or a new
   address), on Trades unless another pipeline is named. A project names the Projects pipeline and
   no site; its tasks are ordinary tasks linked to the job.
2. **Estimate and accept.** Someone with prices adds estimate lines with `addLine`; when the
   customer agrees, the office calls `recordAcceptance` with how they agreed and the lines they
   accepted, and the job may move to Accepted in the same call.
3. **Book the work.** `bookVisit` with the job, visit type, start (the end defaults to the type's
   usual length) and crew; `assignCrew` and `removeCrew` change the crew; `moveVisit` moves it all;
   `cancelVisit` cancels it.
4. **A day on site.** The crew reads `myVisits` and `myJob`, marks the visit with `markOnTheWay`,
   `markOnSite` and `markDone` (or `markMissed`), records materials with `addMaterial` and proposes
   extra work with `proposeVariation`.
5. **Decide a variation.** Someone with prices prices its lines with `editLine`; the office calls
   `approveVariation` or `declineVariation` with how the customer said so, or `withdrawVariation`.
6. **Approve what was used.** `approveLine` approves a material line; `voidLine` voids a line.
7. **What is owed.** `unbilled` lists it by job with totals; `exportUnbilled` downloads it as a CSV.
   `jobSummary` shows a job, its visits and crew, variations and lines without prices.

## What is built

Jobs, pipelines and stages (seeded Trades and Projects), sites, visit types, visits, crew places,
lines, variations and rates; the Crew role; `jobs:manage`, `jobs:schedule`, `jobs:crew` and
`jobs:prices`; the jobs board, open jobs, my jobs, the schedule, upcoming visits and variations
waiting views; tabs on a job, a visit, a site, a Person and an Organisation; the default pipeline
setting; and the tools `enquire`, `jobSummary`, `recordAcceptance`, `bookVisit`, `moveVisit`,
`cancelVisit`, `assignCrew`, `removeCrew`, `myVisits`, `myJob`, `markOnTheWay`, `markOnSite`,
`markDone`, `markMissed`, `addMaterial`, `addLine`, `editLine`, `approveLine`, `voidLine`,
`proposeVariation`, `approveVariation`, `declineVariation`, `withdrawVariation`, `unbilled` and
`exportUnbilled`.

Not in the code yet: clocking in and out, time on a job and labour lines from it; the customer's
acceptance, approval and sign-off and their private link; access notes; notices to the customer
and staff; photos and files; the office, crew and My account screens; and invoicing.


## Reference

Generated from the code:

- [Data model](/packs/jobs/data-model/)
- [Operations and tools](/packs/jobs/tools/)
- [Permissions and roles](/packs/jobs/permissions/)
- [Screens](/packs/jobs/screens/)
- [Messages](/packs/jobs/messages/)
- [Settings](/packs/jobs/settings/)
- [Decisions](/packs/jobs/decisions/)

The specification is stage 39's, [39-jobs.md](https://github.com/timoconnellaus/composable-os/blob/main/docs/stages/39-jobs.md).

This page is [jobs/docs/overview.md](https://github.com/timoconnellaus/composable-os/blob/main/packs/jobs/docs/overview.md), written by hand beside the code.
