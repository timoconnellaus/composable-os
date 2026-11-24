# Roadmap

Each stage runs as: **interview** (agree how it works) → **spec** in `docs/stages/NN-name.md` → a
**build session** in its own worktree → review → merge. Stages are usable on their own and reduce
risk for the next.

| # | Stage | Scope | Status |
| --- | --- | --- | --- |
| 0 | Scaffold | Monorepo, `cos-app` + `cos-runner`, D1 + migrations, identity adapters, CI, Deploy button; spike of `@cloudflare/computer` + Worker Loader | done (PR #2) |
| 1 | Core data | Core objects (People, Organisations, Affiliations, Activities, Tasks), operations registry, gate + audit log, UI shell, search, import/export/merge, saved views | done (PR #9) |
| 2 | MCP | `/mcp` with the OAuth 2.1 server on the identity adapter, tools generated from the registry, approval queue + simulation for MCP actors | spec agreed |
| 3 | Extension runtime | SDK contract, extension workspace (`@cloudflare/computer`), host modules, schema reconciler + `rec_*` views, approve-as-diff, rollback | Built (3a: SDK, reconciler, runtime, install; 3b: authoring over approvals, approval screen, Code Mode, type checking, authoring eval harness) |
| 4 | Deals + views | Deals/Pipelines as the first shipped extension; view specs, dashboards with read-only SQL | spec agreed |
| 5 | Automations | Triggers (record events via Queues, schedules), Workflows for long runs, run history | spec agreed |
| 6 | Integrations | Vendor `gatekeeper-kit` + gatekeepers (Google, Microsoft, email, Slack, MCP); Workshop-side interface in the runner; email/calendar sync onto the timeline | spec agreed (groundwork merged, PR #10) |
| 7 | In-app AI | Model-role registry UI, assistant chat, summaries, embeddings search, policy adjudicator (`review` role) | 7a built (registry, Settings → AI, summaries, semantic search); 7b built (assistant, adjudicator, daily digest, gateway-first registry; PR "Stage 7b") |
| 8 | Distribution | Release bundles, `create-composable-os` CLI, self-updater, setup wizard, real-account install test | Built (needs a human: CI test account, manual run) |
| 9 | Rename, licence, landing page | First rename of the project (packages, Workers, CLI, repo), FSL-1.1-ALv2 + NOTICE + CLA, `apps/marketing` landing page | spec agreed |
| 10 | SaaS & enterprise | Control plane on Workers for Platforms: sign-up, Stripe + usage AI billing, staged rollouts, admin console, export/delete; built ready, deployed on first sign-up | spec agreed |
| 11 | Jev as the typed judge | The judge seam beside the model registry, Jev through AI Gateway, labelled sets and `eval:calibrate` with replay; placements: authoring intent, the adjudicator's Jev reviewer, summary statements, outbound messages, job-change signatures, widget shape, eval graders (`docs/jev.md`) | done (PRs #52, #55, #56, #58) |
| 12 | Import and migration | One generic AI importer for CSV, XLSX and multi-file CRM exports (file roles, links by source ids, owner, pipeline, stage, picklist and currency mapping, new custom fields through schema approval); mapping screen; skip / update empty / overwrite matching; up to 100k rows as a Workflow job; one approval and one undo; activity history; fixtures for plain CSV, HubSpot, Pipedrive, Salesforce | spec proposed |
| 13 | Email from the CRM | Compose and reply from the timeline through the person's own Gmail or Outlook; templates and merge fields; scheduled send; sequences that stop on reply, with approval of each new sequence version and provider send limits; AI drafts; opt-in approximate open and click tracking | spec proposed |
| 14 | Teams and permissions | Roles (Admin, Manager, Member, Read-only), teams, invites; owner-based visibility per object (everyone, own, own team) enforced at one seam across lists, search, SQL, dashboards, exports, summaries, MCP and the assistant (14a); SSO and SCIM (14b) | spec proposed |
| 15 | Leads | Leads as a shipped extension (inbox, statuses, sources, convert to deal with nothing copied); optional lifecycle stage extension; core assignment rules (round-robin, field values with lists and ranges, fallback owner) | built |
| 16 | Duplicates | Warnings at creation and import, and a nightly scan by plain rules (email, domain, normalised name) with reasons; review page and bulk merge through the existing merge operations; merge re-points extension relations | built |
| 17 | One proactive assistant | One thread per user that never resets (Agents SDK Durable Object), cost-based compaction with a learned cache lifetime, inline Jev-checked memory, personal routines, background agents that stage changes, approvals by tap, typing or voice, A2UI cards, plugins with a reviewed marketplace, connected assistants under a contract, voice and dictation; `packages/agent-*` under MIT ([spec](stages/17-assistant.md), ADRs 0340–0351) | spec agreed |
| 20 | Move in | The repository renamed `composable-os`, scope `@composable-os/*`; the earlier brand retired; the CRM as the first product in `products/crm`, Workers named by product; the contract renamed to `codemode:ops`, `ctx.ops` and `rec_*` views; legacy-install code deleted; the Composable OS site | built (needs a human: the repository rename, the site's deploy and the real-account install) |
| 21 | Extension skills | Two installable skills (`write-extension`, `add-automations-tools-dashboards`) in a plain `skills/` folder; `cos ext check` and `cos ext test` sharing the host's checks; a version guard; no eval | built |
| 22 | Customers and audiences | The `staff`, `customer` and `public` audiences on every operation; the visibility seam's first door; customer accounts linked to a Person, signed in by email code; the `customer` key on objects with field-by-field reads; account deletion as an erase request | built |
| 23 | HTTP surface and typed client | Operations over HTTP through `invoke()`, one route each, for staff, customers and the public together; a typed client generated per product for TanStack Start and React Native, split by audience; idempotency keys required on writes; rotating tokens for phones; current and previous API version served | built (in review) |
| 24 | Client apps | One `cos` command; a template for new client repos (TanStack Start web, Expo mobile) and an adopt path for existing ones; platform packages on npm; the service binding to the host, with customers signing in on the company's domain; packs as packages with headless hooks; MIT blocks shipped inside the release | built, in review |
| 25 | States, orders and payments | One transition engine under `states` and `stages`; the Order base record, priced by the host, in one currency per deployment; guest checkout; a payments gatekeeper for Stripe on the org's own account, with a hosted page, webhooks and refunds through approval | built, in review |
| 26 | Capacity and holds | The `capacity` behaviour: places that never go below zero, holds that last as long as their unpaid order, in the write's own batch | built, in review |
| 27 | Ticketing, and Ghetto as the first client | The Ticketing pack (events, ticket types, tickets, check-in); web checkout, the app's ticket wallet and door scanning for Ghetto Movement; packages and paying by deposit | built: steps 1 to 5 (PRs #156, #158, #159, #164) and tax at checkout (PR #205); steps 6 and 7 (the first client's deployment, a test-mode sale, the live sale) not yet run, and nothing yet run against real Stripe |
| 28 | Content | The `publishable` behaviour, rich text as structured JSON, media, slugs, preview; the Content pack; Ghetto's blog off its current CMS | built: steps 1 to 6 (PRs #179, #180, #182), `cos content import` (PR #185) and criterion 12, an AI asks to publish (PR #191); step 7, the first client's blog moved, not yet run |

The approval pipeline is built up over several stages: the gate in 1, the queue and simulation in 2,
extension diffs in 3, the adjudicator in 7.

There are no stages 18 and 19: numbering carries on from 20, the first stage of the platform's
design (ADR 0400).

## Stages 12 to 16: standard CRM features

These are features mainstream CRMs ship. AI is a convenience on top (proposing a mapping, drafting
an email); there are no invented metrics or scores, and matching and assignment are plain rules.

### Dependencies

| Stage | Needs on `main` | Affects |
| --- | --- | --- |
| 12 Import | 1, 3, 4, 5, 7a; 11 only for the `import.mapping` placement | 14 adds `records:import` and visibility of imported records; 15's leads import with no change; 16 adds name flags to the dry run |
| 13 Email | 6a (6b for automations that send templates); 11 only for the `outbound.message` feeds | 14 (templates, enrolment and compose respect visibility); 16 (merge moves enrolments) |
| 14 Teams and permissions | everything on `main`, including 7b | every read path; 12, 13, 15 and 16 as listed in its spec |
| 15 Leads | 3, 4 | 14 (leads declare an owner field) |
| 16 Duplicates | 1, 3 | 12 (name keys and flags) |

### Suggested order

1. **14a** (roles, teams, invites, the visibility seam) first. It changes every read path, so the
   stages after it are built visibility-aware instead of retrofitted. Run it while little else is in
   flight.
2. **16** in parallel with 14a: small, mostly disjoint (normalisation, name keys, the merge fix).
   Coordinate on `person.create` and `organisation.create`, which both touch.
3. **12** and **15** in parallel after 14a. 12 picks up 16's name keys.
4. **13** after 6b is merged, and after 14a.
5. **14b** (SSO and SCIM) whenever an enterprise customer needs it.

Migration ranges are claimed in [`parallel-work.md`](parallel-work.md) so parallel sessions do not
collide: 12 uses 0280–0289 (block G), 13 0290–0299 (H), 14 0300–0309 (I), 15 0310–0319 (J), 16
0320–0329 (K). ADRs 0240–0247 are taken by these specs (block D); 0248–0249 are free.

### Which suit an extension and parallel sessions

- **15 Leads** is extension code (`extensions/leads`, `extensions/lifecycle`) with no core
  migration, apart from assignment rules, which are core and a separate PR. The extension half can
  run in its own session at any time after stage 4.
- **16 Duplicates** is core but small and self-contained; it runs in parallel with 14a or 12.
- **12 Import** is core (Workflow, R2, ledger) but touches few shared files once 14a is in; it runs
  in parallel with 15.
- **13 Email** and **14** are core and touch shared paths (the gate, sync ingest, every read): give
  each its own window rather than running them beside each other.

## Later, for the CRM

Standard features deferred until after stages 12 to 16, in no particular order:

- Products (what a company sells, not products in the platform's sense), quotes and forecasts.
- Standard sales reports (pipeline by stage, won and lost by period, activity by user).
- Deal hygiene: last activity date, days in stage, and no-activity highlighting with thresholds the
  user sets.
- Web forms and booking links (creating leads and meetings).
- Comments and @mentions on records.
- Files on records.
- Mobile web.
- Calling and SMS.
- Accounting integration.

## Stages 20 to 28: the platform

Stage 20 moved the CRM's repository to Composable OS (ADR 0400). Stages 21 to 28 make the host a
platform that products other than the CRM are composed on. Their ADRs carry on from 0400. Stage 20
used migrations 0380 to 0389; the later stages' migrations carry on from 0400. Blocks are claimed
in [`parallel-work.md`](parallel-work.md) as usual.

### Dependencies

| Stage | Needs | Notes |
| --- | --- | --- |
| 20 | Nothing | Cut-over is `main` as it stands (agreed 2026-11-20) |
| 21 | 20 | Written against the renamed contract |
| 22 | 20 | Builds the visibility seam's first door itself; stage 14a extends it later |
| 23 | 22 | Ships for all three audiences together, so it waits for 22 |
| 24 | 23 | A person claims the `@composable-os` organisation on npm first |
| 25 | 22 | Payments webhooks need no client app |
| 26 | 20 | Independent of 22 to 25 |
| 27 | 24, 25, 26 | |
| 28 | 22, 23 | Independent of 25 to 27 |

### Suggested order

1. **20**, alone. It moves every file, so nothing else runs beside it.
2. **21**: two skills and a CLI.
3. **22**, then **23**. These two change what the host exposes and are reviewed with most care.
4. **26** can run beside 22 and 23: it touches record writes, not read paths.
5. **24** and **25** in parallel after 23.
6. **27**: the first product that is not a CRM. Expect it to send changes back to 22 to 26.
7. **28** whenever Ghetto's site moves to TanStack Start; it only needs 22 and 23.

## Stages 29 onward: common modules

Modules most businesses need, in the order their primitives unlock them. None is specced. Each
gets its interview and spec when a client needs it, and not before.

| # | Stage | Scope | Status |
| --- | --- | --- | --- |
| 29 | Forms | Public writes as a primitive; a Forms pack: enquiry forms, sign-ups, surveys, reviews and feedback (waivers with a signature moved to stage 44, Agreements) ([spec](stages/29-forms.md)) | spec agreed (2026-11-24) |
| 30 | Notifications | Email, SMS and push as one primitive: templates, a person's preferences, an SMS gatekeeper, push to client apps ([spec](stages/30-notifications.md)) | spec agreed (2026-11-24) |
| 31 | Recurring schedules and Bookings | The `recurring` behaviour (a timetable generates classes); a Bookings pack: classes, appointments, rooms, waitlists, late-cancel rules; the spender of 32b's allowances; the import door stage 33 uses for schedules, future bookings and visit history (decided at the interview of 2026-11-22: booking rules per class type, some booked only by staff; late from 1 hour before; the first on the waitlist booked in automatically, until 2 hours before; parents book for their children; drop-ins paid on the website; the coach ticks who came; no standing bookings; members see only places left. Split in two: 31a, the timetable and class bookings, then 31b, appointments booked by staff: [spec](stages/31-bookings.md)) | spec agreed (interview 2026-11-22); 31a steps 1 and 2 built (`feat/stage-31a-recurring-claimants`: the shared wall-clock helper, the `recurring` behaviour, capacity claimants, declared uniqueness, time windows and staff-only creates on the transition engine; ADRs 0500 to 0503, migration 0560); step 3 built (`feat/stage-31a-bookings-pack`: the Bookings pack's spine, `packs/bookings` on Programs' class type with its booking rules over the organisation's settings, rooms, coaches, series, classes, closures, bookings booked and cancelled by members on the web and in the app inside their windows, staff booking anyone and walk-ins paid at the desk, the timetable, the day view and a class's list, the booking declared the spender of the Memberships pack's holders; window numbers two relations away and over settings, a spender paid another way, `state.resolve`; ADRs 0504 to 0506, no migration); steps 4 and 5 built (`feat/stage-31a-spending-waitlist`: spending proved with the Memberships pack's memberships and passes, by the class's week, time of day and class type; the waitlist on capacity claimants, a freed place held for it in the release's batch until the cut-off, promotion by the host within a minute with the use spent then and a waiter who cannot pay passed over; ADR 0520, migration 0610); step 6 built (`feat/stage-31a-family-link`: the family link, `core_person_link` made and ended by a person on the staff with `people:link`, the visibility seam's guardian scope, a parent booking, cancelling and joining waitlists for a linked child with the child's own pass, reading the child's bookings and passes, merge and erase; ADR 0540, migration 0650); step 7 built (`feat/stage-31a-attendance`: attendance on the class list, the coach role, no-shows by a timed host move only where the list was taken, staff moving a member with their use in one batch, staff cancelling a class (a person approves an AI's request) with its bookings and waiters, and the guards a cancel racing a booking needs; ADRs 0550 to 0553, migration 0670); step 8 built (`feat/stage-31a-drop-ins`: a visitor or a member with nothing to spend pays for one class on the website, the booking held while the order is unpaid and booked by the verified payment, priced by the class type or the organisation, a refund through a person's approval when cancelled in time or by the gym; `sellable.moves`, `order.startHeld`, refunds owed asked for by the minute cron; ADR 0560, migration 0690; fake provider only); step 9 built (`feat/stage-31a-messages`: the members' emails through email-send, to the booking's Person and their live guardians, on booking (with an add-to-calendar file), promotion, being passed over, a place free after the cut-off, a change or cancellation by the gym and a drop-in's refund, the reminder before each class, staff told of classes whose list was not taken, the Bookings dashboard and views, the coach's list in the app; date-relative triggers in minutes, the calendar file made by email-send; ADRs 0570 to 0572, no migration); routine mail built (`feat/routine-mail`, the owner's decision of 2026-11-23: the members' emails are a shipped pack's declared routine mail, sent by the host without approval under Balanced, each kind an admin's to turn off, Ticketing's too; ADR 0590, migration 0750); step 10 not yet |
| 32 | Allowances, recurring billing and Memberships | The `allowance` behaviour (a pass or plan grants uses, a booking spends one); recurring charges through the payments gatekeeper with retries, pauses and cancellation; a Memberships pack; subscriptions to courses as a third source of stage 42's access (decided at stage 42's interview: a subscription covers every published course, later ones too; a card at the start of the trial, charged when it ends unless cancelled, one trial per person; today's subscribers stay on the hosted platform until this stage, then subscribe again, free until their paid-up date, the old one ending at its period end: [stage 42](stages/42-courses.md), "Decided for stage 32"). Split in two: 32a, the subscription (the course subscription ships on it), then 32b, allowances and Memberships, with stage 31 ([spec](stages/32-memberships.md)) | 32a built: steps 1 and 2 (PR #218: subscriptions at the payments gatekeeper, the subscription record, an order per paid period); step 3 (PR #223: the `subscription` access source, the course plan with one free trial per person, members' self-service on the web, the staff side; and a new visitor's trial by confirming their email with a code first, the customer sign-in setting "anyone starting a subscription", ADR 0459); step 4 (continuation offers for subscribers moving from another platform, `cos subscriptions offers import` and the report; the test-mode runbook, `docs/subscriptions-stripe-runbook.md`, not yet run); never run on real Stripe; a client's own subscribers' move is its own setup, not this repository's; 32b spec agreed; 32b step 5 built (the `allowance` behaviour: holders and spenders declared by a pack, the limit kept by the database, periods in the holder's zone, stage 31's amendments; ADRs 0493 and 0494, migration 0533); 32b step 6 built (`feat/stage-32b-memberships-pack`: `sellable.recurring.grants`, the Memberships pack with plans, memberships, pass types and passes, a pass valid for its days, the intro offer one per person, payer and holder for staff, tools only a person may call; ADRs 0510 to 0512, migrations 0580 and 0581); the rest of step 6 and step 7 built (`feat/stage-32b-memberships-changes`: plan changes, an upgrade now and prorated, applied once paid, a downgrade from the next period; staff pauses for a set time within the plan's bounds; the Memberships dashboard, views, hooks and blocks; ADRs 0530 to 0532, migration 0630); never run on real Stripe; step 8 (`cos memberships import`) not yet |
| 33 | Leaving an existing booking system | Import of clients, visit history, passes and schedules; a period where both run; what happens to stored payment details | not specced |
| 34 | Price adjustments and Offers | Adjustments on orders as a primitive; an Offers pack: promo codes, members' prices, staff discounts up to a limit, gift vouchers and gift cards, referrals, loyalty later; and the shared platform step "an order paid another way" (with stage 35 and the till) ([spec](stages/34-offers.md)) | spec agreed (owner interviewed 2026-11-24); loyalty (step 11) waits for its own interview |
| 35 | Invoices and quotes | Quote, accept, invoice, pay, chase; PDF output; built on orders ([spec](stages/35-invoices-quotes.md)) | spec agreed (2026-11-24) |
| 36 | Shared inbox, Messaging and Help desk | One inbox for email, SMS and in-app chat; campaigns; support requests with replies and response targets ([spec](stages/36-inbox.md)) | spec agreed (2026-11-24) |
| 37 | Shop | One catalogue of items and their variants, each marked sold online, in person or both, enforced by the host; a `stock` behaviour on capacity's counter with a ledger (a hold while paying, sold when paid, a refund never restocks), purchase orders and a quick stock-in, counts, write-offs and low-stock notices; online orders collected or posted (fixed postage, free over an amount, by weight later, carriers later through a gatekeeper), members buying at the gym on their own phone; returns recorded by staff; the till sells from the same list and stock; stock in several places designed and built later ([spec](stages/37-shop.md)) | spec agreed (owner interviewed 2026-11-24) |
| 38 | Knowledge base | Staff procedures and customer help pages; built on Content. Procedures read by every staff account (pack roles included) in their published wording; read and understood with one tap, asked per procedure of everyone or some roles, "read again" or "small fix" chosen at each publish; a warning on the roster, never a block, for someone not yet confirmed; a review reminder per procedure (12 months by default); public help pages with search and no AI answer box; the assistant answers staff only from published procedures, linking the one it used; any staff member writes, a person allowed publishes; later, training: a procedure may require a course for staff in Courses ([spec](stages/38-knowledge-base.md)) | spec agreed (owner interviewed 2026-11-24; the spec's six open questions decided by the coordinator the same day) |
| 39 | Jobs and projects | Work with stages, tasks and time spent; built on `stages` and Tasks ([spec](stages/39-jobs.md)) | spec agreed (2026-11-24) |
| 40 | Rosters | Replaced by stage 45, Rostering | see 45 |
| 41 | Programs | A bank of exercises and programs built from it in one layout (weeks, sessions, blocks, items with typed sets and levels); assigned to a person or a class type with dates; every set logged against its target ([spec](stages/41-programs.md)) | built: steps 1 to 6 (the spine; the Training dashboard, views and Person tab; hooks and twelve blocks; draft and text import; PRs #162, #170) and AI publish requests (PR #191); step 7, the first client, not yet run |
| 42 | Courses | Video lessons with levels and progress in Cloudflare Stream with signed playback, sold one at a time or as fixed bundles on the web; tax worked out by the provider at checkout on courses and tickets alike (built first, as it touches Ticketing); built on Programs and orders. Subscriptions wait for stage 32; today's subscribers stay on the hosted platform until then ([spec](stages/42-courses.md)) | built: steps 1 to 8 (tax at checkout, PR #205; the spine, PR #204; the pack, PR #206; `cos courses import`, PR #216), with the outline not yet checked against two real programs; step 9, the first client's import, not yet run; nothing yet run against real Stripe or Stream (spec agreed at the interview of 2026-11-23, follow-ups the same day) |
| 43 | Outside practitioners | Practitioners the business invites (a physiotherapist, a dietitian) as a fourth kind of caller with their own sign-in; a client's consent (a care link) before anything is seen, ended at once; each practitioner sees only their own work and whether the client did it; coaches see restrictions and the exercise list, never notes; rehab and habits as Programs' programs, logged like training; restrictions, nutrition plans and private notes in a Care pack; sharing between practitioners only by the client; one person as practitioner, coach and member kept apart; the Oceania location hint for new installs ([spec](stages/43-practitioners.md)) | spec agreed (owner answered the open questions 2026-11-23); step 1, the location hint for new installs, built (ADR 0580) |
| 44 | Agreements | Documents a person accepts or signs, as a platform piece any pack can require: drafts and versions kept for good, published only by a person (an AI drafts, never publishes), a small change or "agree again"; packs declare agreement points (buying a membership or pass, a booking; tickets and courses available) and the business attaches its documents; one check in the host when an order or subscription starts and when a booking is made, guarded at commit; acceptance by a member, a parent for a child, a visitor with their order, a member in person on the business's tablet, or staff from paper, tick and typed name or a drawn signature, never changed; health questions with answers kept from bulk paths and AI; a copy by email and a signed PDF built from the stored version; cooling off as a setting; members moving over agree at first sign-in; stage 43's consent as an acceptance. No legal wording ships ([spec](stages/44-agreements.md)) | spec agreed (owner interviewed 2026-11-23, the eight questions answered the same day, a desk-tablet signing mode added); step 1, documents and versions, built (`feat/stage-44-documents`); step 2, acceptances and the one question, built (`feat/stage-44-acceptances`); step 3, enforcement at checkout, subscription start and booking, built (`feat/stage-44-enforcement`); step 4, the copy and the signed PDF, built (`feat/stage-44-copy`); step 5, the blocks (Agree, Before you go on, My agreements, the inline step in Bookings and Memberships, the signature pads), built (`feat/stage-44-blocks`); step 7, cooling off (the business's days, a new member ends it for a full refund that a person approves), built (`feat/stage-44-cooling-off`); step 8, erase, merge and retention, built (`feat/stage-44-erase`); a child's paper form copy to the guardian staff pick (the owner's decision of 2026-11-24, ADR 0648), built (`feat/stage-44-paper-copy-guardian`) |
| 45 | Rostering | Who works each shift: a coach on each class (the class's own coach, the series' coach as the regular week) and duties that are not classes (cleaning), for staff who need not be coaches; a `staffed` behaviour in the host (one person never on two overlapping shifts, refused by the database; warnings for someone away, not qualified, or a shift with no one; offers taken by a qualified, free person with nobody approving and the manager told, exactly one take under a race); a Rostering pack that works with or without Bookings, with a team role for staff who are not coaches and a grant for coaches; staff's own shifts, unavailability and a private calendar feed; hours and classes totalled per pay period for staff counted for pay, locked and exported as CSV, with no rates, each person seeing their own; members see only the coach's name, and are not emailed on a swap; an optional checklist on a duty shift, ticked off by its person, as a reusable platform piece ([spec](stages/45-rostering.md)) | spec agreed (owner answered the open questions 2026-11-23: no pay rates, checklists, admins roster, 8 weeks ahead, fortnightly pay periods); step 1, field-level exceptions in `recurring`, built (ADR 0620); step 2, `staffed` and the time claim, built (one person never on two overlapping shifts, refused by the database; warnings in the write's answer; `staffing.check`; Bookings' class declares it; ADRs 0621 and 0622, migration 0811); step 3, qualifications, unavailability, offers and takes, uncovered shifts, the host's notices and leaving, built (exactly one take, decided by the database; the cut-off and lapsing; `user.deactivate` takes a leaver off future shifts and patterns; ADRs 0623 and 0624, migration 0812); step 4, restricted pack permissions, the `rostering.team` role and the Rostering pack's spine (duties, duty series and duty shifts, the roster's tools, settings; who rosters is `rostering:manage`, admins and by grant; Bookings' coach fields a person's to change), built (ADRs 0625 and 0626, no migration); step 6, pay periods, built (who is counted from a date, totals in whole minutes with the class list as evidence, the not-worked mark, the lock kept by the database, reopening with versions, the CSV export; `rostering:pay`, restricted and a person's only; ADR 0627, migration 0813); step 5, each person's private calendar feed and the shared calendar writer, built (a token shown once and kept as a hash, their own shifts only, revoked on leaving or losing the permission; ADR 0628, migration 0814); step 7, the screens, built (the week grid with assign, patterns, qualifications, everyone's time off and pay on the web (not yet shown in the product's admin); my shifts, offers, my availability, my calendar and the roster on the web and in the app, the app's not yet tried on phones; role clients with grants; `cos rostering import`; ADR 0629, no migration); step 4b, checklists, built (a duty's checklist ticked off by the person on each shift, or by someone who rosters for them with why; a done run kept unchanged by the database; missed runs told to the rosterers; read only by the person and people who roster; Settings → Checklists; ADR 0650, migration 0815); a staff member's own pay-period totals, built (the owner's decision of 2026-11-24: `myPay`, their own hours only, a person only; ADR 0627 amended, no migration) |
| 46 | Hosted clients | A client's product in our Cloudflare account by default, in a Workers for Platforms namespace: a hosted target for `cos deploy`, one update for the whole fleet with a hold per client, a move between accounts with all of a host's data, usage measured per client; the first client's first deploys. Three tiers: standard, bespoke, own account ([ADR 0610](adr/0610-three-homes-for-a-client-hosted-by-default.md), [spec](stages/46-hosted-clients.md)) | spec agreed 2026-11-23; step 1 (the checks on a real namespace) part done: Worker Loader, scheduled calls and bindings to ordinary Workers pass; queue consumers, Workflows and namespace-to-namespace bindings wait for an API token |
| 47 | Pack screens in the admin | A shipped pack declares its staff screens (label, block, where in the navigation, the tools that decide who may open it); the admin builds them in, routes to them and lists for each person only the screens they may open; fixed-role accounts (a coach, a cleaner, the door) get a small shell with just their screens. Runtime extensions still never ship UI | spec agreed ([spec](stages/47-pack-screens.md)) |
| 48 | My account | The customer's own account area on the business's website and in its app: one shell copied with `cos add web-account`, with "Needs your attention" first (eight kinds worked out by the host: a document to agree to, a failed card, a payment to confirm, a deposit's balance, an unfinished payment, a pass expiring within 7 days or used up, a trial ending), then the sections of every installed pack (declared in its manifest, shown by the host only to a customer who has records there) and base sections: details, sign-in and devices, family, orders (the one list of a customer's orders), payment method and agreements; changing the sign-in address by a code to the new address after a recent sign-in, the old address told, staff able to start it; deleting the account with a preview, a membership ending at the period already paid for and nothing refunded; money in the app opens the website; a parent sees and books for a child; receipts wait for stage 35 ([spec](stages/48-my-account.md)) | spec agreed (owner interviewed 2026-11-24) |
| 49 | Appointments | One-to-one sessions with a coach or an outside practitioner: services, open hours, free times, online booking, late-cancel rule; the `occupies` claim on a room ([spec](stages/49-appointments.md)) | spec agreed (owner interviewed 2026-11-24) |
| 50 | Till | Selling at the desk: desk orders over the Shop catalogue, a card reader, cash with a float and a count, member tabs ([spec](stages/50-till.md)) | spec agreed (owner interviewed 2026-11-24) |
| 51 | Kiosk check-in | Members check themselves in on a shared tablet; the enrolled shared device that the till and desk signing also use ([spec](stages/51-kiosk-check-in.md)) | spec agreed (2026-11-24) |
| 52 | Finance reports | The figures for the books: a summary per business day by kind of sale and tax, payouts, refunds, balances owed to customers; monthly close ([spec](stages/52-finance-reports.md)) | spec agreed (2026-11-24) |
| 53 | Journeys | Automatic sequences of messages and tasks (welcome, not seen, win-back), approved by a person once ([spec](stages/53-journeys.md)) | spec agreed (2026-11-24) |
| 54 | Reviews | Asking for reviews after a number of classes; private feedback; published reviews on the site ([spec](stages/54-reviews.md)) | spec agreed (2026-11-24) |
| 55 | Website builder | A business edits its own pages, menus and colours from the admin; a hosted site for businesses with no code of their own ([spec](stages/55-website-builder.md)) | spec agreed (owner interviewed 2026-11-24); built after the first client is live, with the first standard product |
| 56 | Client notes | Notes and files on a client with levels of access, read auditing, retention and erase ([spec](stages/56-client-notes.md)) | spec agreed (2026-11-24) |
| 57 | Events and venue hire | Hiring out a space without double booking; run sheets and crew shifts for the business's own events ([spec](stages/57-events-venue-hire.md)) | spec agreed (2026-11-24); not on the first client's day-one list |
| 58 | Timesheets and leave | One time-entry record for hours worked at the business or on a job; approval; leave types and balances; pay from approved recorded hours ([spec](stages/58-timesheets-leave.md)) | spec agreed (owner interviewed 2026-11-24) |
| 60 | Owner's Today | The owner's day at a glance on phone and web, with alerts; money figures from stage 52 ([spec](stages/60-owners-today.md)) | spec agreed (2026-11-24) |
| 61 | Accounting sync | Daily summaries, payouts and invoices sent to an accounting system through a gatekeeper; a person approves at first ([spec](stages/61-accounting-sync.md)) | spec agreed (owner interviewed 2026-11-24) |
| 63 | App publishing | A client's iPhone and Android apps in the stores under the client's own accounts, and keeping them updated ([spec](stages/63-app-publishing.md)) | spec agreed (owner interviewed 2026-11-24) |
| 59, 62, 64 | Equipment, Calendar sync, More than one location | Drafted; specs not yet written | not specced |

### How a module is built

- **A client pulls it.** Ghetto Movement sets the first order: 27, then 41 and 42 (its online
  program, agreed 2026-11-21), 28, then 29, 31, 32 and 33, which together replace its current booking system. Courses
  sold by subscription need 32's recurring billing first: stage 42 ships without them.
- **The manifest is written on paper first.** Whatever it cannot express is the platform work.
- **Two halves.** A primitive half adds behaviours to the host, one at a time, because it touches
  core. A pack half builds the extension, hooks and blocks, and several packs can be built at once.
- **The pack holds the common core.** What only one client needs goes in that client's own
  extension. A second client tests where the line is.
- **Done means:** the extension passes `cos ext check` and its tests; staff screens, dashboards
  and MCP access come from the host; it has hooks and blocks in web and native skins; one real
  client uses it; and what the skills got wrong on the way is fixed in the skills.

### What each primitive unlocks

| Primitive | Modules |
| --- | --- |
| Public writes | Forms, reviews and feedback, lead capture |
| Notifications | Messaging, and reminders for every other module |
| `recurring` | Bookings, rosters |
| `allowance` and recurring billing | Memberships |
| Price adjustments on orders | Offers, invoices and quotes |
| Shared inbox | Help desk, messaging |

Shop, knowledge base and jobs need almost nothing new.

## Later, for the platform

Named so they are not forgotten, not staged:

- **Realtime:** live records shared between people.
- **Ghetto's existing app data** (programmes, workouts, chat) onto the platform.
- **Skills** for starting a client app, adding a pack, building a screen and migrating a system
  (the first two arrive with stage 24).
- **The Composable OS site's own content** beyond what stage 20 writes.
