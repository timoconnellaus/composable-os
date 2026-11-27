# ADR 0756: The Jobs pack

Status: accepted, 2026-11-26 (stage 39, build step 5). Builds on
[ADR 0750](0750-stage-rules-on-host-facts.md) (stage rules on host facts),
[ADR 0751](0751-times-that-follow.md) (times that follow) and
[ADR 0755](0755-the-mine-reach-for-pack-roles.md) (the "mine" reach), and amends ADR 0755 (what
decides the reach) and [ADR 0017](0017-audit-and-change-tracking.md) (a read tool audited on
every call). The stage 39 spec numbered this ADR 0756; step 3 took 0755, so the number stands.

## Context
A trades or services business runs a job from the first call to what is owed: an enquiry becomes a
job, the customer accepts, the office books visits with a crew who must never be in two places at
once, the crew records materials and extra work on site, and the office knows what to invoice. A
business with no site visits uses the same record as a plain project. Steps 1 to 3 built the
platform pieces the pack needs; this step is the pack's spine (spec, Suggested build order, step
5). Its time tools, the customer's acceptance and link, the blocks and `billable` are later steps.

## Decision
**One record for jobs and projects.** `jobs.job` declares `stages`: seeded Trades (Enquiry … Paid,
Lost, Cancelled) and Projects (Planning … Done, Cancelled) pipelines, edited under Settings.
Accepted, Signed off and Invoiced require `acceptedAt`, `signedOffAt` and `invoicedAt`, read-only
host facts (ADR 0750). Before quotes are built, `recordAcceptance` (a person's own act,
`humanOnly`, `jobs:manage`) sets `acceptedAt` with `acceptedBy: office`, approves exactly the
estimate lines it names (what the customer was shown: a line replaced since is refused), and may
move the job in the same write. Nothing in this step sets `signedOffAt` or `invoicedAt`.

**A visit and its crew places.** `jobs.visit` is one booked time (`states`: booked, on the way, on
site, done, missed, cancelled). Every move is a tool's (`markOnTheWay`, `markOnSite`, `markDone`,
`markMissed`: a person's own act, by the crew or the office; `cancelVisit` and `bookVisit`'s own
clean-up: a person approves an AI's call), so a booked visit is out of the Trash but for those
tools' holders in person (ADR 0863). Its job is set only by `bookVisit` (read-only, required at
create). A crew place (`jobs.assignment`) is one person's shift on a visit: `staffed` with
`timesFrom: "visit"` (ADR 0751), `private` (its title names the customer's job), `states.follows`
the visit's cancel, the visit type's checklist, and one live place a person a visit (`unique`).
Crew places have two states, booked and cancelled, as Rostering's duty shifts do: the spec's
on-the-way and on-site are the visit's, and a crew place stays a shift (for pay, the roster and the
crew's reach) after its visit is done. Booking, moving and cancelling visits and putting crew on and
off them are `jobs:schedule`'s and `personApproves`; with Rostering installed the host lets only a
rosterer say who works a shift (ADR 0626, decision 7). A booking whose crew cannot all be on it is
cancelled by the tool and the clash, naming the person, is its answer.

**The crew role.** `jobs.crew` holds `jobs:crew` and reads jobs, visits, crew places and visit
types, each job, visit and place through `mine` (through its own booked crew places, a week either
side). It does not read sites, lines or rates: `myVisits` and `myJob` give it the site of a job the
host let it reach, and quantities, never prices. Sites are not in the reach because a job's `site`
would then decide it and be `personApproves`, which would make every AI enquiry that names a site
wait for a person (the spec's AI table has an enquiry applied).

**What decides the reach includes what the host copies onto it (amends ADR 0755).** ADR 0755 left
step 5 to treat the sources of a host copy or follow onto `through` as deciding. Now: (1) the
contract requires the datetimes of the record a `staffed.timesFrom` names, copied onto the window,
to be `personApproves`; (2) under the limit the host refuses a write of them as it refuses a write
of the window itself (`pack-role-mine.ts`, `timesFromSources`); (3) the contract refuses a
`through` whose `states.follows` could move a record from a state outside `live` into one in it.
Jobs' visits declare `starts` and `ends` `personApproves`, and a crew place's follow only cancels.

**Lines whose words and numbers never change.** `jobs.line` (estimate, variation, material,
labour) keeps its description, job, kind, variation, quantity, unit, price, cost, item and tax code
read-only: only the pack's tools write them, and only when a line is made. `editLine` corrects a
draft by voiding it (`from: "draft"`, one write) as replaced and making a corrected copy keyed on
the line it replaces, so an approved, billed or void line is never changed by any path, and a
re-pointed line cannot exist. Approving (`approveLine` for material and labour, `recordAcceptance`
for estimates, the variation's follow for its lines), voiding and billing (the host's, step 8) are
moves only tools or the host make. A variation is approved or declined by the office on the
customer's word (`humanOnly`, recorded as the office's) or withdrawn; its lines follow it.

**What is owed.** `unbilled` and `exportUnbilled` (`jobs:prices`, restricted and grantable) read the
approved lines that are owed in one statement with `maxRows` and `truncated`: a fixed-price job's
estimate and variation lines, a time and materials job's labour and material lines (decision 1),
each amount the quantity times the unit price in minor units rounded once per line, as integers.
The CSV is a person's (`humanOnly`) and audited on every call: **a read tool may declare
`auditReads: true`** (`ToolSpec`, the manifest, `extensions/tools.ts`), so its every successful call
writes an audit row holding the input and no value read; the contract refuses it on a tool that
writes. It only adds to the trail, so any extension may declare it. Its answer's `csv` is
`redactResult`.

## What this step does not build, and why
- **Time** (`clockIn`, `clockOut`, `draftLabour`, `workedOn` on the job, `partOf` on the crew
  place; spec decision 6) waits for stage 58 step 7, the Jobs seam. `workedOn` today requires
  `states` (its `live` are states), and the job is on `stages`; `partOf` must name the `workedOn`
  object directly, and a crew place names its visit. Both are that step's to decide.
- **Access notes** (a site's gate codes) are not kept. The spec makes them a field only
  `jobs:manage` and a crew member on the day of their visit read, never in a view, export, search
  or an AI's context. The platform's only such field (`restricted`, ADR 0811) is a text a record's
  customer writes; a staff-written restricted field with a day rule is new platform work, so the
  site holds hazards and no codes until it exists.
- **Prices for the office only** (decision 5) hold for the crew role (it reads no line or rate) and
  for every tool (only `jobs:prices` tools answer a price). A member who opens a line or a rate
  record reads its price: a field only holders of a permission read is new platform work.
- Opening tasks, notes, checklist ticks and clocking under the crew's reach (ADR 0755, fail closed):
  the crew's tools here read and write only Jobs' own records. With Rostering installed a crew
  member ticks a checklist with Rostering's tools.
- The acceptance of a record (step 4), the customer's link and anything open to customers (step
  6), screens, mail, photos and the My account section (step 7), `billable` and invoices (step 8).
- A job's lead (spec: "the lead it came from"): a relation to `leads.lead` would make Leads a
  requirement, which the spec rejects; it waits for a way to name an optional pack's record.
- Trashing a visit with a crew is left to a person holding its tools (ADR 0863); its crew places
  then stay booked. A record with live followers kept out of the Trash is platform work if a
  business needs it; `cancelVisit` is the way.

## Consequences
- `jobs:prices` is restricted (admins, and by grant); every other Jobs permission is every member's.
- Before stage 35 and step 4, a Trades job stops at Complete unless an admin, in person, changes the
  pipeline; Accepted is reached through `recordAcceptance`.
- Tests: `packs/jobs/test/jobs.test.ts` (the manifest, each tool, the contract's new refusals),
  `apps/runner/test/jobs.test.ts` (criteria 1, 2, 3, 6, 11, 14, 15 and 16 in the real host) and
  `apps/runner/test/jobs-rostering.test.ts` (criteria 4 and 5 beside Rostering).
