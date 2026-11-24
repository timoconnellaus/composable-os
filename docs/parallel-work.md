# Parallel work

How several sessions build Composable OS at the same time without stepping on each other. Read
[`handoff.md`](handoff.md) first.

## Claim a range before you start
Every build that may add a migration or an ADR claims a block of numbers here, in its **first
commit**, by editing this table. Use the next free block. Unused numbers in a block are fine.

| Block | Migrations | ADRs | Claimed by | Status |
| --- | --- | --- | --- | --- |
| A | 0200–0219 | 0200–0209 | Stage 7b | merged |
| B | 0220–0239 | 0210–0219 | Stage 10 | merged |
| C | 0250–0259 | 0230–0239 | Stage 11 (Jev): #52, #55, #56, #58; migrations 0250–0252 and 0255–0256 used, ADRs 0230–0239 | merged |
| D | — | 0240–0249 | Specs, stages 12–16 (ADRs 0240–0247 used; the stages' ADRs) | in flight |
| E | 0260–0269 | 0250–0254 | Hosted platform AI | in flight |
| F | 0270–0279 | 0255–0259 | Core fixes (erase, automations) | merged |
| G | 0280–0289 | 0260–0269 (free) | Stage 12, Import (migrations only) | specced |
| H | 0290–0299 | 0270–0279 (free) | Stage 13, Email (migrations only) | specced |
| I | 0300–0309 | 0280–0289 (free) | Stage 14, Teams and permissions (migrations only) | specced |
| J | 0310–0319 | 0290–0299 (free) | Stage 15, Leads: the Leads and lifecycle extensions, assignment rules (migration 0310 used; no ADRs, ADR 0246 amended) | in flight |
| K | 0320–0329 | 0300–0309 (free) | Stage 16, Duplicates (migration 0320 used; ADR 0247 from block D) | in flight |
| L | 0330–0339 | 0320–0329 | Erase completeness (every store) | in flight |
| M | 0340–0349 | 0330–0339 | Self-hosted Workers AI over REST (no prompt logging); narrower organisation erase (ADR 0330 used; no migrations) | merged |
| N | 0350–0379 | 0340–0359 | Stage 17, One proactive assistant (ADRs 0340–0351 used by the spec; wave 1 used migrations 0350–0351, W2 wiring 0358–0360, W3 memory 0352, W9 voice 0361–0362 with 0363 reserved, W4 routines 0365–0369, W5 agents and approvals 0370–0374) | in flight |
| O | 0380–0389 | 0400–0409 | Stage 20, Move in (migration 0380 used: the view rename; ADRs 0400–0405 used by the design) | in flight |
| P | — | — | Stage 21, Extension skills (no migrations; ADR 0405 from block O) | specced |
| Q | 0400–0409 | 0410–0414 | Stage 22, Customers and audiences (ADR 0402 amended as built; ADRs 0410–0414 used; migrations 0400 on) | in flight |
| R | 0410–0419 | 0415–0419 | Stage 23, HTTP surface and typed client (migrations 0410–0411 used; ADRs 0415–0419 used, ADR 0403 amended as built) | in flight |
| S | — | 0420–0424 | Stage 24, Client apps (no migrations; ADR 0401 amended as built) | in flight |
| T | 0420–0439 | 0425–0429 | Stage 25, States, orders and payments (migrations 0420 to 0422 and ADRs 0425 to 0429 used) | in flight |
| U | 0440–0449 | 0430–0434 | Stage 26, Capacity and holds | in flight |
| V | 0450–0459 | 0435–0439 | Stage 27, Ticketing and the first client (step 1, `sellable`: migration 0450, ADR 0435; steps 2 and 3, the pack, the door role and public reads: migration 0451, ADRs 0436 to 0438; the first client's gaps, `fix/ticketing-client-gaps`: ADR 0439) | in flight |
| W | 0460–0469 | 0440–0444 | Stage 28, Content (`claude/stage-28-content-spine`, steps 1 to 3: `richText`, `publishable` completed, public reads; migration 0460, ADRs 0440 to 0443, merged as #179; `claude/stage-28-content-pack`, steps 4 to 6: media, the editor, the Content pack; migration 0461, ADR 0444) | in flight |
| X | 0470–0479 | 0445–0449 | Stage 41, Programs (steps 1 to 3: the document field, `publishable` without its public half, the signed-in scope, the pack's spine) | in flight |
| Y | — | 0450–0454 | Client releases and environments (every pack in a release, environments, customer auth on deploy, role clients, pack hooks over a client's operations, host modules on upgrade; ADRs 0450 to 0453 used; ADRs 0420 to 0423 and 0451 amended) | in flight |
| Z | 0490–0499 | 0455–0459 | Staff invites, native sign-in by tokens, the host behind Cloudflare Access (`fix/staff-invites-and-native-sign-in`; block Y went to client releases); the host's sign-in mail (`fix/host-sign-in-mail`: migration 0491, ADR 0456); confirming your email and the native sign-in's confirm step (`fix/import-sign-in-on-client-hosts`: migration 0492, ADR 0457); customer sign-in for buyers and the fake payment page's way back (`feat/customer-sign-in-for-buyers`: ADR 0458, no migration) | in flight |
| AA | — | 0460–0464 | The first client's gaps (`fix/ticketing-client-gaps`): ADR 0460, time zones; no migrations | in flight |
| AB | — | 0465–0469 | The site redone (`apps/marketing`): the build-and-maintain service angle and the new design language; ADR 0465 used, ADR 0191 amended; no migrations | in flight |
| AC | 0500–0509 | — | Content media for client sites (`fix/content-media-for-client-sites`, issue #181): migration 0500 (after 0470, which it reads); no ADRs, ADR 0444 amended. The content import (`feat/content-import`): migration 0501 | in flight |
| AD | — | 0470–0474 | The content import door (`feat/content-import`): ADR 0470; ADRs 0444 and 0455 amended | in flight |
| AE | 0510–0519 | 0475–0479 | Stage 42, Courses. The spine (`claude/stage-42-courses-spine`, steps 1 to 3: video and file media in Stream, signed playback, the access scope): migration 0510, ADRs 0475 to 0477. Tax at checkout (`feat/tax-at-checkout`, build step 1, merged as #205): migrations 0516 on, ADR 0479. The pack (`claude/stage-42-courses-pack`, steps 4, 6, 7 and the draft): migrations below 0516, ADR 0478 | in flight |
| AF | 0520–0529 | 0480–0484 | AI publish requests, stage 28 criterion 12 (`feat/ai-publish-requests`): migration 0520, ADR 0480; ADRs 0441 and 0446 amended | in flight |
| AG | 0530–0549 | 0485–0494 | Stage 32, Allowances, recurring billing and Memberships (32a the subscription, 32b allowances and the Memberships pack). Used: migrations 0530 to 0532, ADRs 0485 to 0492. 32b step 5, the `allowance` behaviour (`feat/stage-32b-allowance`): migration 0533, ADRs 0493 and 0494 (the block's ADRs are now all used) | 32a built; 32b step 5 built |
| AH | 0550–0559 | 0495–0499 | Stage 42, the courses import (`feat/courses-import`, build step 8: `cos courses import`, the shared import door, videos by upload or link with captions, enrolments and progress); ADR 0495; no migrations | in flight |
| AI | 0560–0579 | 0500–0509 | Stage 31, Recurring schedules and Bookings (31a the timetable and class bookings, the family link; 31b appointments). Steps 1 and 2 (`feat/stage-31a-recurring-claimants`: the wall-clock helper, `recurring`, capacity claimants, declared uniqueness, time windows and staff-only creates): migrations from 0560, ADRs from 0500. Step 3, the Bookings pack's spine (`feat/stage-31a-bookings-pack`): ADRs 0504 to 0507, no migration | in flight |
| AJ | 0580–0599 | 0510–0519 | Stage 32b step 6, `recurring.grants` and the Memberships pack with passes (`feat/stage-32b-memberships-pack`): migrations 0580 and 0581, ADRs 0510 to 0513 | in flight |
| AK | 0600–0609 | — | The dry run causes no real effect (`fix/tool-dry-run-executes`, ADR 0022 amended): migration 0600 marks tool actions queued before it; no ADRs | in flight |
| AL | 0610–0629 | 0520–0529 | Stage 31a steps 4 and 5, spending and the waitlist (`feat/stage-31a-spending-waitlist`) | in flight |
| AM | 0630–0649 | 0530–0539 | Stage 32b, plan changes, pauses and the Memberships dashboard, views and blocks (`feat/stage-32b-memberships-changes`, build steps 6 and 7): migration 0630, ADRs 0530 to 0532 | in flight |
| AO | 0670–0689 | 0550–0559 | Stage 31a step 7, attendance, the coach role, no-shows, moves and cancelling a class (`feat/stage-31a-attendance`): migration 0670, ADRs 0550 to 0553 (AM and AN are claimed on their branches) | in flight |
| AN | 0650–0669 | 0540–0549 | Stage 31a step 6, the family link (`feat/stage-31a-family-link`): `core_person_link`, the seam's guardian scope, booking for a dependant | in flight |
| AR | 0730–0749 | 0580–0589 | Stage 43, Outside practitioners. Step 1, the location hint for new installs (`feat/stage-43-oceania-hint`): ADR 0580, no migrations; the later steps take theirs from here | in flight |
| AP | 0690–0709 | 0560–0569 | Stage 31a step 8, drop-ins (`feat/stage-31a-drop-ins`): `sellable.moves`, a record held while its order is unpaid, drop-in refunds through approval (block AO, 0670–0689 / 0550–0559, is stage 31a step 7's, PR #253) | in flight |
| AQ | 0710–0729 | 0570–0579 | Stage 31a step 9, messages, the reminder, the calendar file and the dashboard (`feat/stage-31a-messages`) | in flight |
| AS | 0750–0769 | 0590–0599 | Routine mail (`feat/routine-mail`): a shipped pack's declared member email sent without approval, the switch per kind, the log; migration 0750, ADR 0590; ADRs 0051, 0456, 0572 and 0574 amended (AR is claimed on its branch) | in flight |
| AT | 0770–0789 | 0600–0609 | A coach who also works the desk (`feat/coach-desk-permissions`, issue #258): `bookings:desk`, grants on a pack-role account adding up with its role; migration 0770, ADR 0600 | in flight |
| AU | 0790–0809 | 0610–0619 | Stage 46, Hosted clients (spec and ADR 0610; no migrations yet) | specced |
| AV | 0810–0829 | 0620–0629 | Stage 45, Rostering. Step 1, field-level exceptions in `recurring` (`feat/stage-45-recurring-exceptions`): migration 0810, ADR 0620. Step 2, `staffed` and the time claim (`feat/stage-45-staffed`): migration 0811, ADRs 0621 and 0622 (no `core_write_guard` remake). Step 3, offers and takes (`feat/stage-45-offers`): migration 0812, ADRs 0623 and 0624 (no `core_write_guard` remake: the take's race is a trigger on the offer). Step 4, restricted permissions and the Rostering pack (`feat/stage-45-pack`): ADRs 0625 and 0626, no migration (no `core_write_guard` remake: 0852 stays free). Step 6, pay periods (`feat/stage-45-pay`): migration 0813, ADR 0627 (no `core_write_guard` remake). Step 5, the calendar feed and the shared calendar writer (`feat/stage-45-feed`): migration 0814, ADR 0628. Step 7, the screens, role clients with grants and `cos rostering import` (`feat/stage-45-blocks`): ADR 0629, no migration. Step 4b, checklists (`feat/stage-45-checklists`): migration 0815; its ADR is block AY's (this block's ADRs are all used); the later steps take their migrations from here (AS is claimed on its branch) | in flight |
| AW | 0830–0849 | 0630–0639 | CI on Namespace runners (`ci/namespace-runners`): the runner choice, the fork rule, the cache volume; ADR 0630, no migrations | in flight |
| AX | 0850–0869 | 0640–0649 | Stage 44, Agreements. Step 1, documents and versions (`feat/stage-44-documents`): migration 0850, ADRs 0640 and 0641. Step 2, acceptances and the one question (`feat/stage-44-acceptances`): migration 0851 (remakes `core_write_guard` with the `agreements` kind), ADRs 0642 and 0643. Step 3, enforcement (`feat/stage-44-enforcement`): migration 0853, ADR 0644 (0852 was reserved for stage 45 step 3's `core_write_guard` remake, which was not needed: 0852 is free again for this block). Step 4, the copy and the signed PDF (`feat/stage-44-copy`): migration 0854, ADR 0645; step 8, erase, merge and retention (`feat/stage-44-erase`): migration 0855, ADR 0646; a child's paper form copy to the guardian staff pick (`feat/stage-44-paper-copy-guardian`): migration 0857, ADR 0648 (0856 and ADR 0647 are claimed by the cooling-off branch); the later steps take theirs from here (next free: migration 0852 or 0858, ADR 0649). First claimed as AU, which stage 46 took on `main` first; AV is claimed on its branch (`feat/stage-45-recurring-exceptions`) | in flight |
| AY | — | 0650–0659 | Stage 45 step 4b, checklists (`feat/stage-45-checklists`): ADR 0650 (its migration, 0815, is block AV's) | in flight |
| BA | 0890–0909 | 0660–0669 | Stage 47, Pack screens in the admin (spec `docs/stages/47-pack-screens.md`; AY is claimed on the checklists branch, AZ left free for the next claim in flight): ADR 0660; no migrations expected | specced |
| BC | 0930–0949 | 0680–0689 | Stage 37, Shop (spec `docs/stages/37-shop.md`): the `stock` behaviour, `stockMoves`, goods and delivery on orders, `order.quote`, returns, the Shop pack; ADRs 0680 to 0688 named in the spec | specced |
| BD | 0950–0969 | 0690–0699 | Stage 34, Price adjustments and Offers (spec `docs/stages/34-offers.md`). ADR 0694, an order paid another way, is shared with stage 35 and the till: if one of them builds that step first it writes the ADR in its own block and 0694 stays free | specced |
| BE | 0970–0989 | 0700–0709 | Stage 38, Knowledge base (spec `docs/stages/38-knowledge-base.md`): ADRs 0700 to 0707 named by the spec; migrations for the published-text index, `core_publish_ack` and the checklist's "how to" expected | specced |
| BF | 0990–1009 | 0710–0719 | Stage 48, My account (spec `docs/stages/48-my-account.md`): `core_customer_email_change` (migration 0990), `me.portal`, `me.attention`, changing the sign-in address, deleting an account's consequences; ADRs 0710 to 0714 named in the spec (step 1 used ADR 0714 and no migration) | in flight |
| BB | 0910–0929 | 0670–0679 | Stage 30, Notifications (spec `docs/stages/30-notifications.md`) | specced |
| BG | 1010–1029 | 0720–0729 | Stage 29, Forms (spec `docs/stages/29-forms.md`) | specced |
| BH | 1030–1049 | 0730–0739 | Stage 35, Invoices and quotes (spec `docs/stages/35-invoices-quotes.md`). Step 1, the PDF writer generalised (`feat/stage-35-pdf-writer`): ADR 0737, no migrations | in flight |
| BI | 1050–1069 | 0740–0749 | Stage 36, Shared inbox (spec `docs/stages/36-inbox.md`) | specced |
| BJ | 1070–1089 | 0750–0759 | Stage 39, Jobs and projects (spec `docs/stages/39-jobs.md`) | specced |
| BK | 1090–1109 | 0760–0769 | Stage 49, Appointments (spec `docs/stages/49-appointments.md`). Step 3, open hours (`feat/stage-49-open-hours`): migration 1090, ADR 0762 (the spec's number for open hours and free times; step 4 amends it). Step 2 (`occupies`) takes migrations from 1095; the spec's 1091 for open hours was not used | in flight |
| BL | 1110–1129 | 0770–0779 | Stage 50, Till (spec `docs/stages/50-till.md`) | specced |
| BM | 1130–1149 | 0780–0789 | Stage 51, Kiosk check-in (spec `docs/stages/51-kiosk-check-in.md`) | specced |
| BN | 1150–1169 | 0790–0799 | Stage 52, Finance reports (spec `docs/stages/52-finance-reports.md`) | specced |
| BO | 1170–1189 | 0800–0809 | Stage 53, Journeys (spec `docs/stages/53-journeys.md`) | specced |
| BP | 1190–1209 | 0810–0819 | Stage 54, Reviews (spec `docs/stages/54-reviews.md`) | specced |
| BQ | 1210–1229 | 0820–0829 | Stage 55, Website builder (spec `docs/stages/55-website-builder.md`) | specced |
| BR | 1230–1249 | 0830–0839 | Stage 56, Client notes (spec `docs/stages/56-client-notes.md`) | specced |
| BS | 1250–1269 | 0840–0849 | Stage 57, Events and venue hire (spec `docs/stages/57-events-venue-hire.md`) | specced |
| BT | 1270–1289 | 0850–0859 | Stage 58, Timesheets and leave (spec `docs/stages/58-timesheets-leave.md`) | specced |
| BV | 1310–1329 | 0870–0879 | Stage 60, Owner's Today (spec `docs/stages/60-owners-today.md`) | step 1 built (ADR 0871 used; no migration) |
| BW | 1330–1349 | 0880–0889 | Stage 61, Accounting sync (spec `docs/stages/61-accounting-sync.md`) | specced |
| BY | 1370–1389 | 0900–0909 | Stage 63, App publishing (spec `docs/stages/63-app-publishing.md`) | specced |

**`core_write_guard` remakes come in order.** Each kind added drops and recreates the table and its
trigger, carrying every earlier kind. Stage 44 step 2's remake (migration 0851, kind `agreements`)
comes first. Stage 45 step 2 needed no guard kind (its time claim is a table and triggers of its
own, migration 0811). Stage 45 step 3 needed none either (its offers decide the take's race
with a trigger of their own, migration 0812), so **migration 0852, reserved for that remake, is
released** back to block AX. The next remake, whoever makes it, carries `agreements` and every
earlier kind forward and must sort after 0851 (a fresh database applies migrations in number
order, so a lower-numbered remake would be dropped by 0851's).

Migrations 0390–0399 and ADRs 0353–0399 are unclaimed. Add more blocks of ten as needed. `CORE_SCHEMA_VERSION` is the highest migration number on `main`;
when you merge `main`, keep the larger value.

**Extensions** (`extensions/<name>/`, like Deals) need no core migrations: their tables come from the
schema reconciler. They are the easiest work to run in parallel.

## Reserved areas
Avoid these unless your build is the one named, because another build is changing them:

| Area | Reserved for |
| --- | --- |
| `packages/core/src/ai/roles.ts`, `ai/client.ts`, hosted provisioning in `packages/release`, `products/crm/apps/control` AI metering | Hosted platform AI |
| `person.erase`, `organisation.erase`, `records/erase.ts`, `assistant/erase.ts`, sync ingest's suppression check | Erase completeness. Held by stage 44 step 8 (`feat/stage-44-erase`, agreements' erase, merge and retention) until it merges: stage 43 step 4 has not started, so nothing else is in it now |
| `packages/core/src/visibility/`, `audiences` on operations, `invoke()`'s audience check, customer and public principals | Stage 22 |
| Visibility and permissions anywhere | Stage 14, once it starts |
| `packages/core/src/http/`, `packages/client*`, `apps/app/src/server/http/`, `/api/v<n>/*`, `core_idempotency_*`, `core_device_session` | Stage 23 |
| `packages/core/src/capacity/`, `core_capacity*` tables | Stage 26 |
| `packs/`, the `ClientApp` entrypoint (`apps/app/src/server/http/bound.ts`), `packages/create-composable-os` (`cos`), the client template | Stage 24 |
| `packages/agent-*`, `apps/app/src/server/assistant/`, the assistant UI (sidebar, `/assistant`, settings pages for memory, routines, agents, plugins and voice) | Stage 17 |

Remove a row when its build merges.

## Shared files that always conflict
Resolve by keeping both sides, then regenerate where noted:
- the operations registry and `packages/core/package.json` exports;
- the Settings index and the route tree (`routeTree.gen.ts` is regenerated by `vite dev` or the app build);
- `worker-configuration.d.ts` (`wrangler types`);
- `CONTEXT.md`, `docs/architecture.md`, `docs/roadmap.md`;
- the release golden manifest: `UPDATE_GOLDEN=1 pnpm --filter @composable-os/release-scripts test`, then check the diff;
- `CORE_SCHEMA_VERSION`: the larger value.

## Local limits
- One shared Mac. Run only the Playwright specs you touched, against your own `vite dev` on your own
  port. CI runs the full suite.
- Never stop or kill a process you didn't start. The user's dev server is on :5173.
- Use `pnpm test --concurrency=2`.

## Finishing
Merge `origin/main` into your branch with a merge commit, keep both sides, run lint, typecheck and
the affected tests, push, wait for green CI, then hand back. Release your block here when you merge.
