# Stage 39: Jobs and projects

Read first: [`AGENTS.md`](../../AGENTS.md), [`CONTEXT.md`](../../CONTEXT.md) (Stage behaviour,
State machine, Follows, Shift, Roster, Qualified, Checklist, Agreement point, Acceptance, Desk
signing session, Order, Pack role, Grant), [`docs/architecture.md`](../architecture.md) (Orders,
the visibility seam), the specs of stages [44](44-agreements.md) (Agreements, and its desk signing
session), [45](45-rostering.md) (Rostering), [47](47-pack-screens.md) (pack screens),
[34](34-offers.md) (the pricing seam `priceLines`), [37](37-shop.md) (`stockMoves`) and stage 48,
My account (PR #311, branch `docs/stage-48-my-account`); ADRs
[0100](../adr/0100-stage-behaviour-and-object-contract-additions.md) (stages),
[0425](../adr/0425-one-transition-engine-for-stages-and-states.md) (one transition engine),
[0427](../adr/0427-orders-are-priced-by-the-host-and-paid-only-by-a-verified-payment.md) and
[0428](../adr/0428-buying-without-an-account.md) (orders, buying without an account),
[0436](../adr/0436-pack-roles-and-the-door-role.md),
[0553](../adr/0553-attendance-the-coach-role-moves-and-cancelling-a-class.md) and
[0600](../adr/0600-a-pack-role-and-its-grants-add-up.md) (pack roles, the today limit, grants),
[0444](../adr/0444-media-the-editor-and-the-content-pack.md) (media),
[0507](../adr/0507-what-the-bookings-review-needed-of-the-platform.md) (`states.follows`),
[0590](../adr/0590-routine-mail.md) (routine mail),
[0621](../adr/0621-the-staffed-behaviour-and-the-time-claim.md) to
[0626](../adr/0626-the-rostering-pack-and-bookings-additions.md) (`staffed`, the time claim,
warnings, who rosters),
[0641](../adr/0641-agreement-points-a-pack-declares-documents-a-person-attaches.md) and
[0642](../adr/0642-acceptances-a-record-nobody-changes-and-who-may-agree-for-whom.md) (agreement
points, acceptances), [0650](../adr/0650-checklists-templates-runs-ticks-and-a-done-run-kept-unchanged.md)
(checklists).

Status: **spec agreed** (2026-11-24). Every question was decided as best practice under the
owner's standing rule (best-practice answers are decided, not asked), except what time on a job
means for pay, which the owner answered in the Timesheets and leave interview (stage 58). Nothing
waits for an interview. Roadmap stage 39, issue
[#107](https://github.com/timoconnellaus/composable-os/issues/107): "work with stages, tasks and
time spent; built on `stages` and Tasks". It carries the working core of the next vertical, trades
and services.

## Goal

A trades or services business runs its work from first call to invoice in one place. An enquiry
comes in and becomes a job; someone visits the site and writes an estimate; the customer accepts
the quote; the office books visits with a crew, and nobody is ever booked in two places at once; on
site, from a phone, the crew sees the address and access notes, records their time and the
materials they used, takes photos and notes, ticks a checklist and captures any extra work (a
variation), which the customer approves before it is done; at the end the customer signs the work
off on the worker's phone or by link; and the job's charges go to an invoice. A business with no
site visits (a studio, an agency) uses the same record as a plain project: tasks, time spent, and a
board of stages.

## Who it is for

- **Trades and services first** (electricians, plumbers, cleaners, landscapers, handymen,
  installers). They need: a site with access notes; estimates priced fixed or as time and
  materials; visits booked with one or several people; qualifications (only a licensed person on
  electrical work); phone-first recording on site, often with poor signal; photos as evidence;
  variations approved by the customer before the work; a customer sign-off; invoicing what was
  agreed or what was done; and customers who will not make an account.
- **Gyms and studios** get little from it, and it costs them nothing to leave it out: internal
  projects with tasks and time (opening a second room, a marketing push). Maintenance of the
  business's own equipment is the Equipment stage's (being specced), not this one's.
- **Other businesses** (agencies, consultants, bookkeepers) use plain projects: tasks, time spent
  per person and per task, and later invoicing of time.

What is specific to trades: sites, visits with crews, materials, variations, sign-off, a phone in a
customer's home. What is common: a job or project moving through stages, its tasks, time spent and
what is owed for it.

## What exists today (from the code, checked 2026-11-24)

| Piece | Where | What this stage uses |
| --- | --- | --- |
| The stage behaviour: stage records with types `open`, `won`, `lost`, stage rules (`requiredByType`), history | `packages/sdk/src/behaviour.ts`, `packs/deals/index.ts`, `packs/deals/README.md` | A job moves through a pipeline per kind of job, as a deal does. `requiredByType` accepts only **writable** fields (`behaviour.ts`, the `requiredByType` check), so a stage cannot yet require a fact only the host sets |
| The state machine and the one-lifecycle rule ("declare stages or states, not both") | `packages/sdk/src/states.ts` (the contract check at line 284), `packages/core/src/records/transitions.ts` | Visits, crew places, lines and variations use `states`; the job uses `stages` |
| `states.follows` (a record moves when the one it points to moves) | `packages/sdk/src/states.ts`, ADR 0507 | A crew place is cancelled when its visit is |
| Tasks: a base record with a due date, an assignee and links to any record; `task.list` by `linkedRecordId` | `packages/core/src/operations/task.ts`, `packages/core/src/records/links.ts` | A job's tasks are ordinary tasks linked to it |
| `staffed` and the time claim: one staff account per shift, overlaps refused by the database, warnings (away, not qualified, uncovered), qualifications per kind. `who`, `starts`, `ends`, `zone` and `kind` name the shift's **own** fields | `packages/sdk/src/staffed.ts`, `packages/core/src/staffing/`, migration `0811_staff_time.sql` | Each crew member's place on a visit is a shift; its times must be copied onto it |
| Who rosters: where a pack declares rosterers, only a rosterer says who works any shift | `packages/core/src/staffing/index.ts` (`assertRosterWrite`), `staffing/rosterers.ts` | Who may put a crew on a visit (decision 7) |
| Rostering: duties, the week grid, offers and takes, calendar feed, pay periods | `packs/rostering/`, stage 45 spec | Crew places appear on the same roster and feed |
| Checklists on a shift, ticked by its person, kept unchanged once done | `packages/sdk/src/checklists.ts`, `packages/core/src/checklists/` | A visit type may carry a checklist (a safety check, test readings) |
| Agreements: documents, versions, points, acceptances by a person, a guardian, a guest or from paper; the desk signing session (stage 44 step 6, specced, not built) | `packages/sdk/src/agreements.ts`, `packages/core/src/agreements/`, stage 44 spec | The business's own wording for a variation approval and a sign-off |
| Orders: priced by the host, integers in minor units, paid only by a verified payment; a guest's token link | `packages/core/src/orders/` (`guests.ts`), ADRs 0427, 0428 | The model for a customer's job link |
| The media library: every staff member sees every item | `packages/sdk/src/media.ts`, `packages/core/src/http/media.ts`, ADR 0444 | Not right for site photos |
| Pack roles with a today limit; grants adding up with a role | `packages/core/src/pack-roles.ts`, `packages/sdk/src/manifest.ts` (`today`), ADRs 0553, 0600 | A crew account that reaches only the jobs it works on |
| Leads (requires Deals) and conversion to a deal | `packs/leads/`, `packs/deals/` | An enquiry may point to a lead; Jobs requires neither |
| Offline writes queued on the device: not built | issue [#118](https://github.com/timoconnellaus/composable-os/issues/118) | Recording on site with no signal (Risks) |

Being specced in parallel, and owned there (this stage refers to them and does not redefine them):

- **Time entries**: Timesheets and leave (stage 58). One core record of time a person worked, at
  the business or on a job, with the `workedOn` declaration ("time can be recorded against this"),
  `partOf` on a staffed shift, approval by an approver, and a job's time read through
  `staffing.time.forRecord`. Hourly pay comes from approved recorded hours; a rostered shift with
  nothing recorded counts its rostered time and is flagged.
- **Files on a record**: the client notes stage (client records with notes and files). Private
  files attached to a note on a record, their own storage, never the media library, location
  metadata removed, shared with the customer by a person's act, and a pack's declared `team` on a
  record (who on the staff looks after it).
- **What a customer sees**: My account (stage 48, PR #311). A pack declares a section (`portal`);
  what needs the customer is an attention kind computed in core.
- **Quotes and invoices**: Invoices and quotes (stage 35, issue
  [#103](https://github.com/timoconnellaus/composable-os/issues/103)). Core quotes and invoices, an
  invoice's `about` naming the record it is for, quote acceptance through Agreements, deposits,
  recorded payments ("an order paid another way", ADR 0694 in stage 34's spec, built once).
- **Enquiry forms**: Forms (stage 29), the public-write door. **Texts and consent**: Notifications
  (stage 30).

## Decided on 2026-11-24

| # | Decision | By |
| --- | --- | --- |
| 1 | **Each job is charged one of two ways, chosen per job**: a fixed price (the accepted quote plus approved variations) or the hours and materials actually used | Best practice |
| 2 | **A customer sees their job by a private link sent by email**, with an account optional for those who want one (a landlord, a property manager). The link opens only that one job | Best practice |
| 3 | **A customer signs off finished work on the worker's phone**, handed to them on site (a typed name or a drawn signature), **or afterwards by the link or their account**. Recording a sign-off from paper or a phone call is not built now | Best practice |
| 4 | **Extra work (a variation) is approved before it is done**: by the customer on the worker's phone or by link; the office may approve on the customer's word, recorded as the office's, never as the customer's | Best practice |
| 5 | **Prices, costs and margins are for the office only** (owners and anyone they choose); the crew records hours and quantities without seeing prices | Best practice |
| 6 | **Time recorded on a job is the time entry of Timesheets and leave** (stage 58): the same record bills the customer and, once stage 58 is built, counts toward pay. Hourly pay comes from approved recorded hours; a rostered shift with nothing recorded counts its rostered time and is flagged. Until stage 58 is built, pay keeps using rostered hours | The owner (stage 58 interview) |
| 7 | **With the roster installed, whoever puts crews on jobs is a rosterer**, of every shift (classes, cleaning, visits alike). Separate rights per kind of work can come later if a business asks | Best practice |
| 8 | **A plain project is the same record as a trades job**, with the site and visit parts not used | Best practice |
| 9 | **Jobs ships before invoices**, with a download (CSV) of what is owed for the business's accounting system; invoices come with stage 35. A direct connection to an accounting system is not this stage's | Best practice |
| 10 | **How the first trades business works today** was not asked: the assumptions here stand, to be checked with the business during setup | Best practice |

## The design in one page

- **A job is the one record.** `jobs.job` declares `stages`: each kind of job is a pipeline, and the
  business edits its stages under Settings as Deals' are. Seeded Trades pipeline: Enquiry, Site
  visit, Quoting, Quote sent (open), Accepted, Scheduled, In progress, Complete, Signed off,
  Invoiced (open), Paid (won), Lost and Cancelled (lost). A plain project is a job on the seeded
  Projects pipeline (Planning, In progress, Review, Done (won), Cancelled (lost)) with no site and
  no visits (decision 8).
- **The facts on the way are the host's, not a drag on a board.** Accepted needs an accepted quote;
  Signed off needs the customer's sign-off; Invoiced needs an invoice. These are read-only fields
  the host sets in the batch of the act itself (`acceptedAt`, `signedOffAt`, `invoicedAt`), and the
  stage rules require them, so nobody, an AI included, moves a job into Accepted by hand.
- **A visit is a time at the site; each crew member's place on it is a shift.** `staffed` holds one
  person per shift, so a visit has one **crew place** per person, each declaring `staffed` and
  following its visit: cancelled with it, its times copied from it by the host in the same batch.
  Moving a visit that would put a crew member in two places fails whole, naming who. Crew places are
  on the roster, in the calendar feed and in the warnings exactly as classes and duties are.
- **Time is stage 58's time entry.** The job declares `workedOn`; a crew place declares `partOf`
  the job. A crew member clocks in against their crew place on a visit, or against the job itself
  (workshop time, a project's hours). Jobs keeps no hours of its own and reads a job's time through
  the host (decision 6).
- **On site, the crew writes only what they did.** A crew account (a new pack role, `jobs.crew`)
  reaches the jobs it has a place on, through Jobs' tools: today's visits, the site and its access
  notes, tasks and checklist; clocking in and out; materials by quantity; photos and notes;
  proposing a variation; capturing the sign-off. It sees no prices unless granted (decision 5).
- **What is owed is a list of lines.** Estimate lines (what was quoted), variation lines (what was
  added), material lines (what was used) and labour lines (approved time, at a rate). A **fixed
  price** job bills its accepted estimate plus approved variations; materials and time on it are
  cost only. A **time and materials** job bills its labour and material lines (decision 1). Amounts
  are integer minor units in the host.
- **Quotes and invoices are stage 35's.** Jobs owns the work and its lines; Invoices and quotes owns
  the documents (numbering, tax, PDF, the accept or pay link, deposits, chasing). A quote and an
  invoice name the job as their `about`. The seam is a small platform declaration, `billable`, so
  neither pack writes the other's records and no line is billed twice. Until stage 35, a CSV
  (decision 9).
- **Approvals and sign-off are acceptances of a record** in Agreements: the customer accepts a
  fingerprint of exactly what they were shown (the variation's lines, the job's work summary), on
  the worker's phone in a view that holds no staff sign-in, or by link, or in My account.
- **The customer's side is a My account section** (stage 48): their jobs, visit dates and arrival
  windows, the crew's first names, variations to approve, the sign-off, documents and photos shared
  with them, and stage 35's quotes and invoices. Two attention kinds: a change to approve and work to
  sign off. The job link opens the same section for that one job, with no account (decision 2).

### What was weighed and rejected

| Option | Why not |
| --- | --- |
| **The job on `states`** (a fixed lifecycle in code) | Businesses arrange their own steps (a renovation's Rough-in and Fit-off); `stages` is the behaviour the roadmap names and the board people know. The hard facts are kept by the host instead |
| **A job on `stages` and `states` together** | The contract allows one lifecycle per object (`states.ts`, line 284) |
| **A separate enquiry record converted into a job** (as a lead becomes a deal) | Two records for one piece of work, and copying. The job starts as an enquiry; a lead may point to it |
| **Requiring Leads and Deals** | The CRM's; a trades business would install a sales pipeline it does not use |
| **One shift per visit with a list of people** | `staffed` holds one person per shift; a many-person shift changes offers, takes, warnings, checklists and pay lines, all built for one |
| **Crew places whose times a Jobs tool keeps in step** | `record.update`, an import or the assistant changing the visit would leave them wrong; a pack must not hook writes. The host copies the times |
| **A `jobs.time` record of hours in the pack** (the draft's) | Two records of one person's hour that can disagree (the job says 3, the pay period 4), and colleagues' hours in `rec_*` views. Stage 58's entry is the one record |
| **Site photos in the media library** | Every staff member browses every item, and it is built for what the business publishes. Photos inside someone's home are private files on the job (the client notes stage) |
| **A file store of Jobs' own** ("record attachments", the draft's) | The client notes stage builds private files on records for every pack; two stores would differ in limits, metadata removal and erase |
| **Quotes owned by Jobs** | Stage 35 builds quotes for every business; two quote engines would drift. Jobs supplies the lines |
| **A price list of Jobs' own** (the draft's `jobs.item`) | A business would keep three lists (Shop's catalogue, the Invoicing pack's price list, this one). Materials name an item of the list that exists |
| **Signing on the worker's phone inside the staff app** | Stage 44 rejected handing over a device that holds a staff sign-in: the customer could reach staff screens. The phone opens the customer's one-job page in a view with no staff credential instead |
| **A customer area of Jobs' own** | Stage 48: everything a customer sees is a section and an attention kind in My account |

## Platform work and pack work

| Piece | Platform or pack | Size | Why |
| --- | --- | --- | --- |
| **Stage rules on host facts**: a stage may require a read-only field the host sets, refusing the move by every actor until it is set, naming the missing fact | Platform (amends ADR 0100; `behaviour.ts`, the transition engine) | Small | Otherwise anyone drags a job into Accepted |
| **Times that follow**: a staffed record's start, end, zone and kind copied by the host from the record a relation names (`staffed.timesFrom: "visit"`), in the same batch, the time claim checked for each | Platform (amends ADRs 0507 and 0621) | Medium | A crew of three moves with its visit; a pack cannot hook the visit's writes |
| **A "mine" reach for pack roles**: a role reaches records of an object only where a named relation leads to a live record naming the caller (jobs on which they have a crew place, within a window) | Platform (beside the today limit, ADR 0553; `pack-roles.ts`) | Small to medium | A crew account must not read every customer's job |
| **Acceptance of a record**: an agreement point that asks every time, for this record; an acceptance naming the record and a fingerprint of what was shown; the covered fields held once accepted; captured by the customer's link, their account, or on a staff phone in a credential-free view; or recorded by the office on the customer's word, marked so | Platform (amends ADRs 0641 and 0642; builds on stage 44 step 6's session model) | Medium | An acceptance today is of a document version, once per person |
| **A customer's record link**: a token link (only its hash stored) that lets a Person with no account open one job's My account section and make its customer moves, as an order's guest link does; sent as host mail | Platform (generalises ADR 0428; opens `customer` operations, a reviewed change, ADR 0402) | Medium | Trades customers rarely make accounts |
| **`billable`**: an object declares its records are lines (title, quantity, unit price in minor units, tax code, the record they belong to); an invoice takes a line exactly once (refused by the database) and releases it if voided; a labour line covers time entries, each covered once | Platform (with stage 35's invoice operations) | Medium | Neither pack writes the other's records; double billing must be impossible |
| **Two attention kinds** in My account: `approve_change` (a change waiting for your approval) and `sign_off` (work waiting for your sign-off), computed in core from pending record acceptances | Platform (amends stage 48's attention vocabulary) | Small | Attention is computed in core, never by a pack |
| The **Jobs pack**: jobs, pipelines and stages, sites, visit types, visits, crew places, lines, variations, rates; `workedOn` and `partOf`; the `jobs.crew` role; a declared `team` and `portal` section; tools, settings, views, dashboards, automations, routine mail, hooks, web and native blocks, stage 47 screens; the CSV | Pack (`packs/jobs`, new) | Large | Composition |

Not this stage's, used by it: time entries and their approval (stage 58); private files on a record
and sharing them (the client notes stage); quotes, invoices and deposits (stage 35); the shell of My
account (stage 48); stock (stage 37's `stockMoves`, a later step).

## The model

### Words

A **job** is a piece of work for a customer, or an internal project. A **site** is where the work
is. A **visit** is one booked time at the site. A **crew place** is one person's place on a visit
(a shift). A **line** is something owed or quoted: estimate, variation, material or labour. A
**variation** is a change to agreed work, approved before it is done. **Sign-off** is the customer
accepting the finished work. _Avoid_: ticket, work order (say job); appointment (stage 49's); time
spent as a record (it is stage 58's time entry).

### Records

| Object | What | Behaviour |
| --- | --- | --- |
| `jobs.pipeline`, `jobs.stage` | Kinds of job and their steps, as Deals' (seeded: Trades, Projects) | Settings |
| `jobs.job` | Title, customer (Person), organisation (optional), site, pipeline, stage, billing basis (`fixed` or `time_and_materials`), default rate, owner, the lead it came from (optional), description, lost reason; host facts: `acceptedAt`, `acceptedBy` (quote, or office on the customer's word), `signedOffAt`, `invoicedAt` | `stages`; `customer`; `workedOn` (live in its open stages, readers `jobs:manage`); `team` (the crew places' people, for notes and files); `timelineLinks: ["organisation"]` |
| `jobs.site` | Address lines, customer, **access notes** (gate or lockbox codes, pets, parking), hazards | `customer` reads the address only; access notes restricted (Privacy) |
| `jobs.visitType` | A kind of visit (Site visit, Electrical, Plumbing, Clean): default length, checklist (optional) | The `kind` qualifications are for |
| `jobs.visit` | A job, a visit type, starts, ends, zone, arrival window shown to the customer, notes for the crew | `states`: `booked`, `on_the_way`, `on_site`, `done`, `missed`, `cancelled` (final) |
| `jobs.assignment` (crew place) | The visit, the staff account, lead or not | `staffed` (who: the account; live: `booked`, `on_the_way`, `on_site`; `timesFrom: "visit"` copies start, end, zone and visit type); `states.follows` the visit; `checklists` from `visitType.checklist`; `partOf` the visit's job (stage 58) |
| `jobs.line` | The job, kind (`estimate`, `variation`, `material`, `labour`), description, quantity, unit, unit price, cost (optional), the item it names (optional: a Shop variant or an Invoicing price-list item), tax code, the variation it belongs to (for variation lines), the time entries it covers (labour lines) | `states`: `draft`, `approved`, `billed` (host), `void`; `billable` |
| `jobs.variation` | A change to agreed work: the job, why, who asked, its lines | `states`: `proposed`, `approved` (by the customer, or by the office on their word, recorded as which), `declined`, `withdrawn`; record acceptance |
| `jobs.rate` | A charge-out rate (Standard, After hours, Apprentice): price per hour | Settings |

Tasks are the base record linked to the job. Notes are timeline activities; photos and documents
are the client notes stage's private files on a note on the job, a visit or a variation, shared with
the customer by a person's act. Totals (quoted, variations approved, recorded, billed, unbilled)
are the host's answer through Jobs' `jobSummary` and `unbilled` tools, not formulas, because time
is not a Jobs record.

### Time (stage 58's entry)

- `jobs.job` declares `workedOn { live: [the open stages], title: "title", readers: "jobs:manage" }`
  and narrows who may record against it to the job's crew and holders of `jobs:manage`; the crew
  place declares `partOf` its visit's job. The exact shape is stage 58's; this stage agrees to it.
- Clocking in on a visit is against the crew place (a shift: stage 58 works out early, late and
  not recorded); in the workshop or on a project, against the job.
- Jobs' `clockIn` and `clockOut` tools call stage 58's operations for the caller; a job page reads
  its time through `staffing.time.forRecord`.
- **Approval is stage 58's**: approvers are rosterers when Rostering is installed (decision 7).
  Where it is not, an entry against a job is approved by a holder of `jobs:manage` (an amendment
  stage 58 must take: see Dependencies).
- **Billing time**: `draftLabour { jobId }` groups the job's approved entries not yet covered into
  draft labour lines, one per person and rate (the job's default rate; the office may change it,
  such as After hours). The amount is the rate times the minutes over 60, rounded once per line to
  the minor unit. When a labour line is approved the host records the entries it covers, each once.
  Time not to be charged is covered by a labour line priced at zero ("not charged"), so nothing is
  left unexplained.

### Operations and tools

All are Jobs' tools unless named as host operations. Staff audience unless said.

| Tool | Who may | Risk | Note |
| --- | --- | --- | --- |
| `enquire` (a job at Enquiry, with its customer and site) | `jobs:manage` | write | Later from stage 29's forms |
| `bookVisit`, `moveVisit`, `cancelVisit` | `jobs:schedule` | write; an AI's waits for a person | The warnings for each crew member; a clash refuses all |
| `assignCrew`, `removeCrew` | `jobs:schedule`; with Rostering installed, a rosterer (decision 7) | write; an AI's waits for a person | Writes the crew place; the host's rules decide |
| `myVisits`, `myJob` | the crew place's person | read | Today's and the week's visits; no prices without `jobs:prices` |
| `clockIn`, `clockOut` (against a crew place or the job) | a person, for themselves | write; a person's own act | Calls stage 58's operations |
| `markOnTheWay`, `markOnSite`, `markDone` | a person on the visit | write | `on_the_way` sends the customer's notice |
| `addMaterial` | a person with a place on the job, or `jobs:manage` | write | An item or free text; no price shown without `jobs:prices` |
| `proposeVariation` | a person with a place on the job, or `jobs:manage` | write | Asks the customer by link, account or on the phone |
| `approveVariation` (office, on the customer's word) | `jobs:manage`, a person only | write; `humanOnly` | Recorded as the office's, never the customer's |
| `recordAcceptance` (office, before stage 35: a paper estimate or the customer's word) | `jobs:manage`, a person only | write; `humanOnly` | Sets `acceptedAt` with `acceptedBy: office`; with stage 35, a quote's acceptance sets it |
| `startSignOff` (on the worker's phone) | the crew place's person, or `jobs:manage` | write | Opens a one-time, short-lived customer view (below) |
| `draftLabour`, `approveLine`, `voidLine` | `jobs:prices` | write | Labour lines from approved time |
| `unbilled { jobId }`, `jobSummary` | `jobs:prices` (totals); `jobs:manage` (the rest) | read | What stage 35 will invoice; the CSV |
| `exportUnbilled` (CSV) | `jobs:prices`, a person | read (audited) | Until stage 35 (decision 9) |
| `sendJobLink`, `revokeJobLink` | `jobs:manage` | write | Host mail; rotates on request |
| Customer: `me.jobs` section reads; `approve`, `decline` a variation; `signOff` | **customer**: the job's Person, by account or link | write | **Opens operations to customers** (reviewed, ADR 0402) |
| Host: `billable.claim`, `billable.release` | stage 35's invoice operations only | host | Never a tool |

Permissions: `jobs:manage` (members, admins), `jobs:schedule` (members, admins; with Rostering
installed, the rosterers' right, decision 7), `jobs:prices` (restricted: admins and by grant,
decision 5), `jobs:crew` (the `jobs.crew` role). A crew account holds no record reads; its reach is
the "mine" reach over jobs on which it has a crew place, from 7 days before to 7 days after the
visit.

### Signing off and approving, on the worker's phone

`startSignOff` (or a variation's "approve now") asks the host for a one-time customer token for
that job and that act, valid for 15 minutes and one use. The staff app opens it in the system
browser view, which holds no staff credential, so the customer sees only the job summary or the
variation and the signature or typed-name capture; going back to the staff app needs the app's own
unlock. The phone can instead show a QR for the customer's own phone. The acceptance records "on
the business's phone, started by" the crew member, as stage 44's desk session records its device.

### Screens

- **Web admin** (stage 47 screens): the jobs board (by pipeline, stages as columns); the schedule
  (visits by day and crew, with assign and the warnings); a job's record screen (lines, visits,
  time from stage 58, materials, variations, notes and files, tasks, totals, unbilled); rates in
  Settings; the projects list with time by person and task.
- **Native (crew)**: today; a visit (address with a map link, arrival window, access notes on the
  day only, the customer's phone, tasks, checklist, clock in and out, materials, photos and notes,
  propose a variation, sign-off); my time this week (stage 58's). Web blocks with the same hooks for
  crews who use a browser.
- **Customer (My account section, web and native)**: My jobs; a job's visits (date, arrival window,
  crew first names), variations to approve, the sign-off, documents and photos shared with them, and
  stage 35's quote and invoice blocks. The job link opens the same section for one job with no
  account. Declared as `portal: { jobs: { label: "Jobs", has: ["jobs.job"], … } }`.

### Notifications

Through host mail and routine mail (ADR 0590), each kind an admin's to turn off:

- To the customer: visit booked or moved, the day before, "on our way" (when the crew marks it),
  the sign-off copy (stage 44's copy): routine mail, no links. The job link, a variation to approve
  and work to sign off carry a link, so they go as host mail (as Agreements' and orders' do). Email
  now; texts wait for stage 30, whose consent rules govern them.
- To staff: put on or taken off a visit (the staffing notices), a variation approved or declined, a
  job signed off, jobs complete but not invoiced (daily).

### What an AI may do

| Action | Under `balanced` |
| --- | --- |
| Read jobs, visits, tasks, notes, totals (prices only with `jobs:prices` for the person it acts for) | applied |
| Draft an estimate's lines from notes; draft a variation's description | applied as drafts |
| Create an enquiry, add tasks, write notes | applied |
| Book, move or cancel visits; assign crew | waits for a person; the card shows the warnings |
| Clock in or out, enter or approve time; approve a variation or record acceptance on the customer's word | refused: a person's act |
| Accept a quote, approve a variation, sign off for the customer | refused: the customer's act, always |
| Read site access notes, time entries, private files | refused |
| Anything that sends a quote or invoice, or takes money | stage 35's rules: a person approves |

### Privacy and erase

- **Access notes** (codes, alarm details) are a restricted field: read by `jobs:manage`, and by a
  crew place's person on the day of their visit only; never in `rec_*` views, exports, dashboards,
  search, the audit's values or an AI's context; redacted in logs; never stored on the phone, never
  in a notice.
- **Photos and documents** follow the client notes stage: private, location metadata removed,
  read by whoever may read the record and its note, shown to the customer only when shared.
- **Prices and costs** are read only with `jobs:prices`.
- **Time** is stage 58's: a job's readers see person, date, minutes and state, never a note.
- **The customer** sees their jobs, sites, visits (arrival window, crew first names), shared files,
  variations and sign-offs: never time entries, costs, internal notes or other staff's details.
- **Audited**: every stage move, crew change, variation decision, acceptance, line approval,
  billing claim, CSV export and job link sent or revoked.
- **Erase of a Person**: removes their sites' access notes and replaces their name on jobs; files
  and notes go by the client notes stage's rules; acceptances by stage 44's (ADR 0646); jobs with
  billed lines keep the lines and amounts as the business's records, for the business to confirm
  with its accountant or lawyer how long. A staff member leaving keeps their name on past crew
  places and loses future ones through `user.deactivate`.

## Out of scope

- Writing, numbering, sending, taxing and chasing quotes and invoices, deposits and payments: stage
  35. Until then, the CSV.
- Pay, pay rates and payroll: stage 58 and stage 45. Jobs only links entries to jobs.
- A direct connection to an accounting system (stage 61, Accounting sync, which sends stage 52's
  figures).
- Recurring service contracts and maintenance plans; the business's own equipment (the Equipment
  stage).
- Purchase orders, suppliers, stock in a van, job costing beyond the cost on a line. Using stock on
  a job (`stockMoves: remove` on an approved material line naming a Shop variant) is a later step
  once stage 37's `stockMoves` is built.
- Retention money and progress claims beyond invoicing unbilled lines to date.
- GPS tracking, routing, travel time, dispatch maps; recording location.
- Texts (stage 30); online booking of a visit by the customer; enquiry forms (stage 29).
- Offline recording (issue #118): the native screens retry with idempotency keys, nothing more.
- Sign-off recorded from paper or a phone call (decision 3).
- Several branches with separate crews; subcontractors with their own sign-in.
- `cos jobs import` (open jobs, sites and customers from another system): a later step.

## Acceptance criteria

1. A job created at Enquiry moves through the seeded Trades pipeline; moving it into Accepted,
   Signed off or Invoiced by `record.update`, the board, an import or the assistant is refused until
   the host has set the fact, naming the missing one.
2. A visit with three crew members moved by `record.update` moves all three crew places in the same
   batch; if any would be on two overlapping shifts, the whole move is refused naming that person,
   and nothing changes.
3. Two people assigning the same person to two overlapping visits at once: exactly one succeeds.
4. Assigning someone not qualified for the visit type, or away, saves with the warning; with
   Rostering installed, a member who is not a rosterer cannot assign crew by any path.
5. Crew places appear in Rostering's week, in the person's calendar feed, and on Bookings' coaches'
   clash check: a coach's class and a visit cannot overlap.
6. A crew account sees only jobs it has a place on within the window; every other job's read is the
   not-found answer; it sees no price, cost or rate without `jobs:prices`; it reads access notes only
   on its visit's day.
7. A crew member clocks in on a visit; the entry is stage 58's, against the crew place, and counts
   to the job's time; no Jobs record holds hours; a second open entry is refused by stage 58.
8. A variation proposed on site is approved by the customer by link with no account; the acceptance
   names the variation's fingerprint; changing the variation or its lines afterwards is refused.
9. Sign-off started on the worker's phone opens a view with no staff credential (a staff operation
   called from it is refused), records the customer's typed name or drawn signature against the job
   summary's fingerprint, sets `signedOffAt`, and emails the customer a copy.
10. A line is claimed by one invoice only: a second claim is refused by the database; voiding the
    invoice releases it. A time entry is covered by one labour line only.
11. A fixed-price job's unbilled total is the accepted estimate plus approved variations; a time and
    materials job's is its approved labour and material lines; all in integer minor units.
12. A customer's link opens only that job's section; a revoked or rotated link opens nothing; no
    operation open to customers reads time, costs, notes, private files or access notes (the
    isolation suite gains every Jobs object).
13. `me.portal` shows the Jobs section to a customer with a job; `me.attention` lists a variation
    waiting (`approve_change`) and work to sign off (`sign_off`) until each is done.
14. A project on the Projects pipeline has linked tasks and time per person and per task, with no
    site or visit required.
15. An AI's attempt to clock in, approve a variation or sign off is refused; its assign waits for a
    person.
16. The CSV of unbilled lines downloads for `jobs:prices` only and is audited.
17. `cos ext check packs/jobs` and `cos ext test packs/jobs` pass; e2e, one per journey: enquiry to
    accepted, scheduling a crew, a day on site on the phone, variation and sign-off, a project's
    time.

## Dependencies

- **Built**: stages (ADR 0100), states and follows, Tasks, `staffed` and the time claim,
  qualifications and warnings, checklists, Agreements steps 1 to 5, orders and the guest link.
- **Not built, needed for a step**:
  - **Stage 58, Timesheets and leave** (time entries, `workedOn`, `partOf`, `forRecord`): step 5
    waits for its steps 1 and 7. Stage 58 must take two amendments, agreed here: Jobs' tools may
    call its clocking operations for the caller (its draft says Rostering's tools only), and where
    Rostering is not installed, entries against a `workedOn` record are approved by holders of the
    record's `readers` permission.
  - **The client notes stage** (private files on a record, `team`): photos in step 7.
  - **Stage 48, My account** (`portal`, `me.attention`): the customer section in step 7.
  - **Stage 47** (pack screens) for the office's web screens.
  - **Stage 44 step 6** (the desk session's model), which the phone hand-over follows.
  - **Stage 35, Invoices and quotes**: `billable` in step 8; Jobs ships without it (the CSV).
- **Optional**: Rostering (the shared roster; who assigns and approves time); Leads (an enquiry's
  source); Shop (materials from its catalogue, later stock); stage 29 (web enquiries); stage 30
  (texts).

## Migrations and numbers

Block **BJ** in [`parallel-work.md`](../parallel-work.md): migrations 1070–1089, ADRs 0750–0759.
Expected migrations: the host-copied times of a following staffed record, if the claim's triggers
change (step 2); record acceptances (the record and fingerprint columns, the hold on covered fields;
step 4, possibly a `core_write_guard` remake numbered after the latest); `core_record_link` (step 6);
`core_billable_claim` and the covered-entry index (step 8). New permissions: `jobs:manage`,
`jobs:schedule`, `jobs:prices` (restricted), `jobs:crew`, all the pack's. No `x_*` table is touched
by a migration.

ADRs the build writes:

1. **0750** Stage rules on host facts (amends 0100 and 0425).
2. **0751** Times that follow: `staffed.timesFrom` (amends 0507 and 0621).
3. **0752** The "mine" reach for pack roles (amends 0436, 0553 and 0600).
4. **0753** Acceptance of a record: a fingerprint, the hold, the office's record, signing on a staff
   phone without its credential (amends 0641 and 0642).
5. **0754** The customer's record link (amends 0428; a reviewed customer opening under 0402).
6. **0755** `billable`: lines taken once, released on void, time covered once (with stage 35).
7. **0756** The Jobs pack: one record for jobs and projects, crew places, lines and billing bases,
   the crew role, time as stage 58's entry.
8. **0757** Jobs in My account: the section and the `approve_change` and `sign_off` attention kinds
   (amends stage 48's ADR on attention when written).

## Suggested build order

| Step | What | Files or areas | Can be built beside |
| --- | --- | --- | --- |
| 1 | Stage rules on host facts | `packages/sdk/src/behaviour.ts`, `packages/core/src/records/transitions.ts` | Steps 2, 3, 6; **collides** with any work on the transition engine (stage 37's `stockMoves`) |
| 2 | Times that follow (`staffed.timesFrom`) | `packages/sdk/src/staffed.ts`, `packages/core/src/staffing/`, a migration if the claim's triggers change | Steps 1, 3; **collides** with stage 58 step 1 and Rostering follow-ups in `staffing/` |
| 3 | The "mine" reach for pack roles | `packages/core/src/pack-roles.ts`, `packages/sdk/src/manifest.ts`, the visibility seam | Steps 1, 2; **collides** with anything in `pack-roles.ts` (stage 47 step 1, stage 38 step 2) |
| 4 | Acceptance of a record (variation approval and sign-off; the phone view) | `packages/core/src/agreements/`, a migration | After stage 44 step 6; **collides** with other Agreements steps and any `core_write_guard` remake |
| 5 | The Jobs pack's spine: objects, pipelines, crew places, lines, variations (office approval), rates, `workedOn` and `partOf`, tools, settings, views, the CSV | `packs/jobs` (new) | After 1 to 3 merge (or stubbed in tests); time tools after stage 58 steps 1 and 7; beside any other pack |
| 6 | The customer's record link and customer scope | `packages/core` (visibility seam, HTTP surface, `open-operations.json`) | Step 4; **collides** with other customer-audience work (stage 48 steps 3 and 4) |
| 7 | Blocks and screens: office (stage 47), crew (native and web), the My account section and attention kinds, photos through the client notes stage, routine and host mail | `packs/jobs/blocks`, `packs/jobs/client`, `apps/app/e2e`, the site and `SITE.md` | After stage 47, stage 48 and the client notes stage's files; **collides** with stage 48's attention code |
| 8 | `billable` and the seam with stage 35 | `packages/sdk`, stage 35's `invoices/` area, a migration | With or after stage 35's invoice issuing; **collides** with `orders/` work (stage 34 step 1) |

## Size

**Large.** Seven platform pieces, each small or medium, and a large pack. Three sessions at once:
steps 1, 2 and 3 in parallel; then 5 beside 4; 6 beside 4; 7 when stages 47 and 48 are in; 8 with
stage 35.

## Decided by this spec, open to override

| Choice | Decision |
| --- | --- |
| One record for jobs and projects | On `stages`, with the host's facts gating Accepted, Signed off and Invoiced |
| Crew | One crew place per person per visit, its times copied from the visit by the host |
| Time | Stage 58's time entry, against the crew place on a visit or the job otherwise; Jobs keeps no hours |
| Approving time without Rostering | Holders of `jobs:manage`, for entries against a job |
| Billing time | Approved entries only, as labour lines one per person and rate; rounding once per line to the minor unit, half up; time not charged is a zero line |
| Fixed price | Bills the accepted estimate plus approved variations; time and materials on it are cost only |
| Accepted before stage 35 | Recorded by the office on the customer's word or a paper estimate, marked as the office's |
| Materials | No price list of Jobs' own: an item from Shop (stage 37) or the Invoicing pack (stage 35) when installed, or typed |
| Quotes and invoices | Stage 35's; Jobs holds lines, `billable` is the seam; the CSV until then |
| The customer | A link (one job, its hash stored, valid while the job is open and 90 days after it closes, rotated on request); an account optional; everything in My account |
| Signing on the phone | A one-time 15-minute view with no staff credential, or a QR for the customer's phone |
| Link emails | Host mail (they carry a link); other customer notices are routine mail |
| Prices | The crew sees none unless granted `jobs:prices` |
| Access notes | Shown to the crew on the visit's day only |
| Crew reach | 7 days before and after a visit |
| Photos | The client notes stage's private files, not the media library |
| Equipment | The business's own equipment is the Equipment stage's; customer-owned equipment on a site is later |

## Questions for the owner

None open. Every question was decided as best practice (decisions 1 to 5 and 7 to 10); the pay
question was the owner's own answer in the Timesheets and leave interview (decision 6). The owner
may override any of them.

## Risks

- **Security**: the job link opens customer operations with no account; it must be as narrow as the
  order guest link, rotate on request and expire. The phone hand-over must never expose the staff
  credential (acceptance criterion 9). Access codes on a staff phone: shown, never stored, never in
  notices.
- **Privacy**: photos inside homes; the customer's address on staff phones; who on the crew sees
  what.
- **Money**: double billing (held by the database in `billable`), rounding of time at a rate, fixed
  price against time and materials, tax on materials and labour for the business to confirm with
  its accountant.
- **Two specs, one seam**: stage 58's `workedOn` and `partOf` shapes and the two amendments above
  must be agreed before either build starts its time step.
- **Needs a real device**: the camera and photo formats, the signature pad on a phone handed to a
  customer, the browser hand-over, poor signal on site (retries with idempotency keys; no offline
  queue).
- **Needs a real client**: a trades business's real pipeline, rates and how its crews work; a real
  accounting system for the CSV.
- **Roster coupling**: one "rosterer" across gym classes and trade crews may be too broad for a
  business with both (decision 7 keeps it; revisit if asked).

## Status

- **Step 1, stage rules on host facts** (branch `feat/stage-39-host-set-date`, PR #350): built.
  `packages/sdk/src/behaviour.ts` lets a stage's `requiredFields` options and `requiredByType`
  name a read-only field (not a formula, the stage field or a field the behaviour keeps). Such a
  host fact (`packages/core/src/records/host-facts.ts`) is written only by the host or the pack's
  tool that only a person calls or approves (as a holder's terms), and the records of a stage
  object that gates one are created, changed, trashed and restored only by an admin in person or
  the host (`stage_settings_admin_only`), so the gate cannot be loosened by a member or an AI. The
  transition engine (`packages/core/src/records/transitions.ts`) names missing facts first in a
  required-fields refusal, lists them in `details.setByHost` and says the act sets them, not a
  move; what it refuses is unchanged. ADR 0750 (amends 0100 and 0425). No migration. Tests:
  `packages/core/test/stage-host-facts.test.ts` (criterion 1 on a fixture pipeline: person, MCP
  client applied and queued, the extension's code with and without a person's tool, CSV import,
  the host, and editing, adding, trashing and restoring the gated stages). Left for step 5: the
  Jobs pack declaring `acceptedAt`, `signedOffAt` and `invoicedAt` and its seeded pipelines; the
  board e2e of criterion 1 comes with the pack.
