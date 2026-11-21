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
| 27 | Ticketing, and Ghetto as the first client | The Ticketing pack (events, ticket types, tickets, check-in); web checkout, the app's ticket wallet and door scanning for Ghetto Movement; packages and paying by deposit | spec agreed |
| 28 | Content | The `publishable` behaviour, rich text as structured JSON, media, slugs, preview; the Content pack; Ghetto's blog off EmDash | spec agreed |

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
| 29 | Forms | Public writes as a primitive; a Forms pack: enquiry forms, sign-ups, waivers with a signature, surveys, reviews and feedback | not specced |
| 30 | Notifications | Email, SMS and push as one primitive: templates, a person's preferences, an SMS gatekeeper, push to client apps | not specced |
| 31 | Recurring schedules and Bookings | The `recurring` behaviour (a timetable generates sessions); a Bookings pack: classes, appointments, rooms, waitlists, late-cancel rules | not specced |
| 32 | Allowances, recurring billing and Memberships | The `allowance` behaviour (a pass or plan grants uses, a booking spends one); recurring charges through the payments gatekeeper with retries, pauses and cancellation; a Memberships pack; subscriptions to courses as a third source of stage 42's access (decided at stage 42's interview: a subscription covers every published course, later ones too; a card at the start of the trial, charged when it ends unless cancelled, one trial per person; today's subscribers stay on the hosted platform until this stage, then subscribe again, free until their paid-up date, the old one ending at its period end: [stage 42](stages/42-courses.md), "Decided for stage 32") | not specced |
| 33 | Leaving Mindbody | Import of clients, visit history, passes and schedules; a period where both run; what happens to stored payment details | not specced |
| 34 | Price adjustments and Offers | Adjustments on orders as a primitive; an Offers pack: promo codes, gift cards, referrals, loyalty | not specced |
| 35 | Invoices and quotes | Quote, accept, invoice, pay, chase; PDF output; built on orders | not specced |
| 36 | Shared inbox, Messaging and Help desk | One inbox for email, SMS and in-app chat; campaigns; support requests with replies and response targets | not specced |
| 37 | Shop | Products, stock (as `capacity`), shipping; built on `sellable` | not specced |
| 38 | Knowledge base | Staff procedures and customer help pages; built on Content | not specced |
| 39 | Jobs and projects | Work with stages, tasks and time spent; built on `stages` and Tasks | not specced |
| 40 | Rosters | Shifts, availability and timesheets; built on `recurring` | not specced |
| 41 | Programs | A bank of exercises and programs built from it in one layout (weeks, sessions, blocks, items with typed sets and levels); assigned to a person or a class type with dates; every set logged against its target ([spec](stages/41-programs.md)) | in build: steps 1 to 6 built (the spine; the Training dashboard, views and Person tab; hooks and twelve blocks; draft and text import); step 7 (Ghetto) next |
| 42 | Courses | Video lessons with levels and progress in Cloudflare Stream with signed playback, sold one at a time or as fixed bundles on the web; tax worked out by the provider at checkout on courses and tickets alike (built first, as it touches Ticketing); built on Programs and orders. Subscriptions wait for stage 32; today's subscribers stay on the hosted platform until then ([spec](stages/42-courses.md)) | spec agreed (interview 2026-11-23, follow-ups the same day) |

### How a module is built

- **A client pulls it.** Ghetto Movement sets the first order: 27, then 41 and 42 (its online
  program, agreed 2026-11-21), 28, then 29, 31, 32 and 33, which together replace Mindbody. Courses
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
