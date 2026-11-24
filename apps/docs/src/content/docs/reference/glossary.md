---
title: "Glossary"
description: "The words Composable OS uses, from CONTEXT.md."
editUrl: false
---

The words used in the code, the docs and the UI, read from [CONTEXT.md](https://github.com/timoconnellaus/composable-os/blob/main/CONTEXT.md). _Avoid_ names words not to use for the term.

Use these words exactly, in code, docs and UI copy. Add to this file when a new term earns its place.

### Composable OS

(the **platform**)

The platform: a trusted host on Cloudflare that products are composed on (ADR 0400). It is the
host, the SDK and contract, the gatekeepers, the release and install machinery and, from stage 23,
the typed client. Packages and local development name Workers and resources with its local prefix
`cos` (`cos-app`, `cos-runner`, `cos-records`); packages are `@composable-os/*`, and the installer
is `create-composable-os` (its command is `cos`). Site: composableos.dev.
_Avoid_: framework, engine

### Product

A named composition: which packs are on, the org's own extensions, names and branding, and (from
stage 24) client apps. It is defined in a **product definition**, today `products/<id>/product.ts`
in this repository and, from stage 24, in the product's client repo. The CRM is a product sold to
many orgs; the first client (stage 27) is a product for one org. A product's id names its
deployment's Workers and resources (`crm-app`, `client-app`). Nothing in the data model knows about
products.

### CRM

The first product on Composable OS: an AI-native CRM that runs in your own Cloudflare account,
defined in `products/crm/product.ts`. Its name is "CRM", and "the CRM" is fine as the product's name
in prose and UI copy. A deployment of it is named for it (`crm-app`, `crm-runner`, database `crm`).
The operations API inside extension code is the platform's, not the CRM's: `codemode:ops`,
`ctx.ops` and the `rec_*` views.

### Deployment

One installed copy of a product (today, the CRM) in one organisation's Cloudflare account. It holds
one org's data and is the isolation boundary. There is no tenant id in the data model.
_Avoid_: tenant, instance (except "Cloudflare OS instance" when quoting upstream)

### Host

The trusted Workers of one deployment: the app Worker (staff UI, `/mcp`, the operations registry
and approval pipeline and, from stage 23, the HTTP surface), the runner Worker and the gatekeeper
Workers. Client apps and extension code reach it only through operations.

### Org

The organisation that owns a deployment. Its users, settings and policy live in that deployment.

### Core object

/ **base record**

A built-in record type with core tables and migrations: **Person**, **Organisation**, **Activity**,
**Task**. They were the CRM's core objects and are now every product's **base records** (ADR
0400): a record type every product has. "Core object" is the word in code and in the earlier
documents; "base record" is the word when talking about products. Stage 25 adds **Order**.
_Avoid_: Contact (use Person), Company/Account (use Organisation)

### Affiliation

A Person's link to an Organisation: title/role, start, end, `current`. One per person is primary.
Ending one and starting another is a **job change**.
_Avoid_: employment, membership

### Timeline-worthy field

A field flagged `track: "timeline"`, whose changes post a `system` Activity on the record.

### Saved view

A stored view of one object's records: a name and an object view spec (table, board, calendar or
gallery). Personal, or **shared** with the org (everyone sees it; its owner and admins change it).

### Board

A view that groups records into columns by a single-select field, with a count and an optional
sum per column. Moving a card runs the object's update operation.
_Avoid_: kanban (in code and copy; fine as a synonym in prose)

### Dashboard

A title, filters and widgets on a grid. Personal or shared; the shipped **Overview** lives in
code, and extensions can ship read-only dashboards (Deals' **Sales overview** and **Pipeline
health**). Any dashboard can be a user's **Home** (the page at `/`); the default is Sales overview
while Deals is installed, else the Overview.

### Widget

One tile on a dashboard: KPI, bar, line, donut, funnel, table, leaderboard or markdown. Data
widgets run read-only SQL over `rec_*` views with named params bound from the dashboard's filters. A
date range ("today", "this month") is the business's, from its midnight in the organisation's time
zone.

### Click-through

A widget's filter template: clicking a segment, KPI or row opens the matching records as a
filtered list, exactly the records the widget counted.

### Relative value

A filter value that resolves when the list runs: `{ "$relative": "me" }`, `"today"`,
`"startOfMonth"`, `"startOfQuarter"` and so on. Saved views such as "My open deals" use them so
they stay right for whoever opens them, whenever.

### Record tab / record panel

A tab or side-panel card that an extension declares on another object's record page: a view spec
filtered to the records related to the one shown.

### Trash

Soft-deleted records (people, organisations, activities and tasks), listed by `trash.list` and
restorable for 30 days before they are purged.

### Purge

The scheduled hard delete of records that have been in Trash for more than 30 days. It runs daily
as an `automation` (`trash.purge`) and is audited like any operation. It removes deleted people,
organisations, activities and tasks, with their links and search entries. Live activities and
tasks linked to a purged record stay and lose only that link.

### Read counts

Successful reads by non-human actors (MCP, assistant, extension, automation), counted per hour,
actor, user, caller and operation in `core_audit_read_counts` instead of one audit row each
(`audit.readCounts`). Failed or refused reads still get an audit row (ADR 0090).

### Audit retention

How long write audits are kept: forever by default, or 1, 2 or 7 years (human admins only,
`audit.setRetention`). The daily cron's `audit.purge` deletes older audit rows through **purge
markers** (`core_audit_purges`), the only way past the append-only triggers besides erase.

### Compaction

30 days after a pending action was decided or expired, its input, preview and simulated records
are replaced by a `summary` (records touched by action, sizes); who decided what, and when, stays.

### Merge

Folding a duplicate record into a **survivor**: chosen field values, combined emails/phones/domains
and tags, the duplicate's affiliations, activity and task links moved over, and every extension
relation field that pointed at the duplicate re-pointed at the survivor (ADR 0247). The merged-away
record goes to Trash with a `merged_into_id` pointer and can be restored.
_Avoid_: dedupe (that is finding duplicates), combine

### Duplicate rule

A plain rule in code that says two records may be the same, with a reason sentence ("Same name and
same organisation: Acme"). People: same email (creation and import only), same name and
organisation, same name and email domain, same phone number, same name only. Organisations: same
domain, same name. There is no score; a pair can match several rules and all are shown (ADR 0247).
_Avoid_: match score, similarity, confidence

### Name key

A person's or organisation's name normalised by fixed code (`name_key`): lower case, diacritics
gone, "Family, Given" reordered, middle initials and legal forms dropped. Every write that sets a
name writes it, so duplicate rules are indexed lookups. Two records with equal keys have the same
name for every duplicate rule.

### Duplicate pair

Two records the scan found by at least one duplicate rule (`core_duplicate_pair`), `open`,
`dismissed` ("Not duplicates", never suggested again) or `merged`. Pairs that share a record show
as one group on the Duplicates page, with a proposed survivor: more activities, then the older.

### Erase

An admin-only hard delete for GDPR requests (`person.erase`, `organisation.erase`). Unlike a purge
it also **redacts** the audit log: content that mentions the record becomes `"[erased]"` (ADR 0019).
Activities and tasks only about the record are deleted; shared ones are scrubbed of its emails,
phone numbers and id, and the search index is purged of it. Pending actions that touch or mention
it are redacted, and rejected if still waiting. In-app assistant threads that referenced it
are redacted too (ADR 0019 amendment). It also reaches sync, extension data, run history,
notifications, events and synced email bodies, and puts a person's addresses on the
**erased-address list** (ADR 0320).

### Erased-address list

`core_erased_address`: SHA-256 hashes of erased people's email addresses (never the addresses).
Sync drops a listed address from everything it ingests: participants, links, suggestions,
signatures and the sender's own words. An admin removes an entry with `erasure.allowAddress` when
the person comes back by consent.
_Avoid_: blocklist, suppression list (that is email sending)

### Erase log

One R2 object per erase (and per allowed address) holding only hashes of the erased ids and
addresses, outside the restorable database. `erasure.reapply` reads it after a D1 restore and erases
again whatever came back.
_Avoid_: purge (that is retention), delete (that is soft)

### Activity

One entry on a record's timeline: a note, email, call, meeting or system event.

### Note level

Who may read a note (stage 56, ADR 0830): `staff` (every staff account, the default and every
note before stage 56), `coaches` (its author, the staff who look after its one Person, admins and
holders of `notes:clients`) or `sensitive` (its author, admins and holders of `notes:sensitive`;
listed locked, each opening with `note.open` audited). Levels 2 and 3 are in no `rec_*` view, no
search, embedding or summary, and no AI actor reads them with any grant. Only a note has one.
_Avoid_: private (a synced email's `private_to`, its owner's only), confidential, clinical

### Note kind

The business's kinds of note (stage 56, ADR 0833): Note, Session note, Sensitive, From the client
and its own, kept in Settings → Notes by `notes:manage`. Each has a template (labelled sections a
person fills in, which make the note's body), the level a note of it starts at and the lowest it
may ever have, and later its files, retention and whether it is evidence. A retired kind is no
longer offered and keeps its notes. Every note has one; a note written without one is a Note,
which stays `staff`.
_Avoid_: type (an activity's type: note, email, call), category, template (a kind's part)

### Looks after

A staff account that looks after a Person (stage 56, ADR 0831): it reads their `coaches` notes
while the row is live. Set on the Person's page with `carer.set` by a person with `people:link`,
never worked out from bookings; ended with `carer.end`, effective on the next read.
_Avoid_: assigned, owner (a record's owner field), coach (the Bookings pack role)

### Operation

One thing a user or AI can do, defined once in the operations registry with zod input/output, a
model-facing description, a permission and a risk class. It is exposed as a server function, an MCP
tool and a host module and, from stage 23, over HTTP (each is a **surface**). From stage 22 it also
declares its **audiences**.
_Avoid_: endpoint, action (an "action" is a gatekeeper term, below)

### Permission

What an operation requires of the caller's role: `records:read`, `records:write`, `records:erase`,
`audit:read`, `users:manage`, `policy:manage`, `extensions:manage`, `settings:manage`. Viewers have read; members read and write; admins all.

### Field registry

Per-object field definitions (name, type, filterable, sortable, `track`). Filters, sorts and
timeline tracking are validated against it.

### Risk class

How dangerous an operation is: `read`, `write`, `bulk-write`, `destructive`, `schema`, `extension`,
`outbound`.

### Actor

Who initiated an operation: `human`, `assistant` (in-app AI), `mcp` (an external MCP client),
`automation`, `extension` (extension code through `codemode:ops`).

### Approval pipeline

Gate → policy adjudicator → human queue, configured per org. It decides whether an operation applies
automatically, is denied, or waits.

### Floor

Deploy-time (env `APPROVAL_FLOOR`) rules the per-org policy can never loosen.

### Preset

The org's approval policy: Cautious, Balanced (default) or Autonomous. Changed by human admins only.

### Pending action

One operation call the gate routed to review, recorded instead of applied: operation, input, the
agent's reason, actor, user, origin, risk class, a diff preview, the simulated result and its
dependencies. It is `pending` until a person approves it (`applied`, or `failed` if the record
changed or vanished meanwhile) or rejects it (`rejected`), or until it is `skipped` because
something it depends on did not apply, or `expired` (after 7 days by default).
_Avoid_: draft, proposal, request

### Change set

The pending actions a person reviews together. By default one per MCP session; Claude can open a
titled one with `changeset.begin` and finish it with `changeset.commit`. It is approved or
rejected whole or item by item in the **Approvals inbox** (`/approvals`).
_Avoid_: batch (that is a `*Many` operation), transaction

### Pending-change badge

The badge on a record's header and list row while a pending action would change it. Its popover
lists the actions and links to their change set. The record itself still shows real data.

### Provisional ID

The id a pending create gives its record (`per_pending_…`) so later pending actions in the same
session can refer to it, e.g. log an activity on a person not yet approved. Approval binds it to
the real id; it never reaches other sessions or the UI.

### Connected app

An MCP client (Claude Desktop, claude.ai, Claude Code, …) a user authorized over OAuth, with the
scopes they granted (`read`, `write`, `admin`). It is also the MCP session that pending actions
belong to. Users revoke their own in Settings → Connected apps; admins can revoke anyone's.
_Avoid_: integration (that is a gatekeeper), token, client (when you mean the authorization)

### Policy adjudicator

The optional AI reviewer (model role `review`) that judges each pending action the gate routed to
review against the org's **written policy**: `approve`, `deny` or `escalate`, with a confidence
and a reason (ADR 0031, ADR 0204). Its mode is `off`, `shadow` or `active`. In active mode an
`approve` at or above the confidence threshold is applied as the original actor and attributed to
the adjudicator (`decided_by = adjudicator`); everything else, a `deny` included, stays for a
person. It never approves what the **floor** or an always-reviewed operation (extension installs)
routed to review, nor outbound, schema or extension changes. Its **verdicts** are shown to human
approvers only, never to the actor, and every one is stored (`core_adjudication`) and audited
(`adjudicator.verdict`). Its **reviewer** is the LLM (model role `review`) or Jev through the
**Judge** (placement `adjudicator.policy`), Jev by default while the judge has a key (ADR 0204,
ADR 0230, ADR 0233).
_Avoid_: adjudicator alone in UI copy, AI approver

### Shadow mode

The adjudicator's first mode once switched on: it judges and records verdicts, and approvers see
them next to each item in the Approvals inbox, but it never acts. The **agreement rate** (how its
approve and deny verdicts match people's decisions, with a verdict × decision confusion matrix, by
day or week) shows whether to trust it. Only an admin switches it to active, and only from shadow.

### Written policy

The org's plain-language rules the policy adjudicator judges by: what may be approved, what must be
denied, what needs a person. Only human admins edit it (`adjudicator.setPolicy`, audited). Each
save is a new version with a SHA-256 hash; every verdict records the version it used. For the Jev
reviewer it is a list of **policy rules**: one per line, split and numbered by code (`policyRules`),
a section heading qualifying the rules beneath it ("Never: Delete any record"), at most 60. Jev
never sees the agent's reason, so a rule that allows a change only on what the reason says is
never met (ADR 0233).
_Avoid_: prompt, rules file

### Extension

A unit of customisation written as code against the SDK contract: one `defineExtension` manifest
and its files (objects, fields, views, automations, tools; `defineObject`, `defineDashboard`,
`defineAutomation`, `defineTool`). The unit of the contract (ADR 0023). A **shipped extension**
ships with the platform as part of a **pack** (`packs/<id>/`, stage 24; an org's
own extensions in its client repo are shipped extensions of its product). A **runtime extension**
is written by AI in a deployment, approved there and stored in the extension workspace.
_Avoid_: package (that means a pnpm workspace package), plugin, app

### Extension workspace

The `@cloudflare/computer` Workspace (Durable Object filesystem + git) that holds runtime extension
source and the build cache. A commit is a version, approval reviews a diff, and rollback is a
revert. It runs no code: the executor does.

### Executor

What runs extension code, from cos-runner's stateless entrypoint (and from Workflow steps in stage
5). Each run gets a Dynamic Worker from `LOADER.get` with a **stable loader id**, and its context
arrives as RPC arguments.
_Avoid_: sandbox host (for the DO)

### Stable loader id

The deterministic Worker Loader id of code that runs more than once. For a tool it hashes the
extension id, commit, host-module set, SDK and runtime hash, contract version and compatibility
settings. The same inputs always mean the same code. Only throwaway code (Code Mode scripts) runs
without one, through `load()`.

### Extension object

A record type declared by an extension. It is stored in `x_<extension>_*` tables, which the host
reconciles from the declaration.

### Extension principal

The identity an extension's code acts as: `extension:<id>`, a `core_user` row of kind `extension`
that never signs in. Its calls go through the gate as actor `extension`, limited to the extension's
declared permissions (objects it may read or write, operations, host modules). Those permissions
are approved like OAuth scopes: a version that asks for more (**widening**) is shown as such on its
proposal and always waits for an admin.

### Working copy

An extension's files in the extension workspace as they are now, including edits not yet
committed. `extension.write` changes it; `extension.check` checks it; `extension.propose` commits
it. Nothing in a working copy is live.
_Avoid_: draft (in the approval sense), branch

### Extension proposal

A committed version of an extension waiting for approval: one pending action (`extension.apply`)
in the proposer's change set, with the diff from the installed version, the host-computed impact
(schema changes, permissions requested or widened, host modules, tools, triggers), the check
result and an AI-written summary. Approving it installs that commit.

### Eject

Taking over a shipped extension as a runtime one: `extension.eject` copies its source into its
working copy, and once a proposal for it is approved it is a runtime extension that new releases no
longer update. Without ejecting, a shipped extension can only be **extended** (fields on its
objects, views and tools from another extension), never modified.
_Avoid_: fork

### Code Mode

The MCP `code` tool: a short ES module the client model writes runs in a throwaway sandbox as the
connected user (actor `mcp`), calling operations through `codemode:ops` under the same gate and
simulation as the other tools. It needs write permission, runs one script per user at a time, and
is rate limited.

### Extension tool

A function an extension declares with `defineTool`. It is an operation named `x.<extension>.<tool>`
and runs in the sandbox.

### Formula field

An extension field computed from other fields of the same record by a small typed expression
(`coalesce(budget, 0) - coalesce(spent, 0)`). It is parsed and type-checked by `extension.check`,
compiled to SQL in the `rec_*` view, so it can be filtered and sorted, and it is never written. No
cross-record rollups.

### Deal

A potential sale (`deals.deal`, from the shipped Deals extension) moving through a pipeline: value
in the base currency, stage, probability, owner, organisation, expected close, and a won/lost date
set automatically. **Deal participants** are the people on it, each with a role.
_Avoid_: opportunity

### Lead

Inbound interest (`leads.lead`, from the shipped Leads extension, which requires Deals): a
lightweight item linked to a real person, a real organisation or both, with a lead status, a source
and an owner. A lead never holds copies of the person's or organisation's details.
_Avoid_: prospect, a "lead" person record

### Lead status

Where a lead is: new, contacted, qualified, unqualified (with a reason) or converted. Admins can
add, rename and reorder statuses and sources under Settings → Extensions. Converted is set only by
conversion.

### Conversion

Turning a lead into a deal with `leads.convert`: a deal on the lead's organisation and owner, with
the lead's person as a participant and each record linked to the other. Nothing is copied. Safe to
run again after a failure; a converted lead cannot be converted again.

### Lifecycle stage

Where a person is in their relationship with you (subscriber, lead, marketing qualified, sales
qualified, opportunity, customer, evangelist, other), from the opt-in shipped `lifecycle` extension.
Conversion moves a person to opportunity; nothing else moves it automatically.

### Assignment rule

A core rule per object with an owner field (person, organisation, leads, deals): ordered conditions
on the record or a record it links to, and a method (round-robin among chosen users, or one user).
The first enabled rule that matches owns a record created without an owner. Rules run on create and
when someone chooses Assign by rules, never on update.

### Fallback owner

The owner an object's records get when no assignment rule matches. "No owner" is allowed.

### Pipeline

An ordered set of stages deals move through ("New business", "Renewals"). Pipelines and their
stages are records, edited under Settings or by AI through record operations.

### Pipeline stage

One step of a pipeline: its order, its type (`open`, `won` or `lost`), a default probability and
its **stage rules**. In code and UI copy "stage" means this when talking about deals; the build
roadmap's stages are a different word (see **Stage** below).

### Stage rule

A field a stage requires before a record may enter it (Proposal needs a value and an expected close
date; Lost needs a lost reason). The host enforces it in the record operations for every actor and
refuses a move with an error naming the missing fields. A stage rule may require a **host fact**: a
read-only field only the host (or a person's own tool of the declaring pack) sets, such as a job's
`acceptedAt`, so nobody moves a job into Accepted by hand; the stages it gates are an admin's to
change, in person (ADR 0750).

### Stage behaviour

The contract's declarative `stages` key (ADR 0100): it makes an extension object move through stage
records with stage rules, probability, status, a closed date, stage history and "Moved to" posts.
Deals uses it; AI-written extensions can too.

### Stage history

One row per stage a record has been in, with entered and left times (`rec_stage_history`). It powers
time in stage and velocity. State-driven objects have the same in `rec_state_history`; both are
the transition engine's one history table.

### State machine

(`states`)

The contract's declarative `states` key (ADR 0425): a select field whose options are the states,
an initial state, and the allowed **moves**. Each move says who may make it, the fields it
requires and whether it is final. The set is fixed in code, where stages are records an admin
edits.

### Move

One allowed change of state, from one state to another. A write that makes a move not declared, or
makes one as someone the move does not list, is refused.

### Mover

Who makes a move: `staff` (everyone who calls an operation today), `customer` (stage 22) or
`host`.

### Window

(on a move)

When a customer may make a move or a create, worked out from fields of the record or the record a
relation points to: from a moment until another, each a datetime less whole local days and then
minutes (booking opens 7 days before a class, closes at its start). Checked by the transition
engine against the host's clock; staff and the host are not bound (ADR 0503). A **staff-only**
rule is a boolean that, while true, refuses a customer the move or the create.

### Requested move

A move a caller asks for by name (`cancel`), which the host resolves to one of the states listed
for it by who is asking and the time: a member's cancel is on time or late by the host's clock
(ADR 0503). A request is never stored.

### Host move

A move only platform code can make (an order becomes paid when the payment provider confirms it).
No person, MCP client, extension or import can make one, because no operation passes on who is
moving.

### Transition engine

The one place in the host that decides whether a record's move is allowed, which fields it
requires and who may make it, and writes its history with the write (ADR 0425). `stages` and
`states` are two declarations it runs.
_Avoid_: workflow, state hook

### Base currency

The deployment's one currency (Settings → General). Currency fields without their own currency
show in it. Changing it relabels amounts; there is no FX.

### Seed record

A record an extension declares to be created once when its object is installed (the default
pipelines and stages), with a deterministic id.

### Quarantine

What happens to an extension after 3 consecutive failed runs: it is disabled (status
`quarantined`, with the reason), admins see it on Settings → Extensions, and its last-known-good
version is offered for rollback. Enabling it again resets the failure counter. Failures that are
the caller's (invalid input, unknown tool) do not count.

### Last-known-good

The most recent installed version (commit) of an extension that completed a run without failing.

### Automation

Extension code declared with `defineAutomation`: a **trigger**, optional declarative conditions,
declared **steps** (with intents: what they read, write, notify and wait for) and a `run` handler
shaped like a Cloudflare Workflow. The host renders its plain-English **summary** and **step
diagram** from the declarations, never from AI. Enabled, disabled (an admin's choice) or paused (a
safety rail tripped). Id `<extension>.<key>`, e.g. `deals.wonOnboarding`.
_Avoid_: workflow (that is the Cloudflare primitive a run executes on), rule, flow

### Trigger

What starts an automation's runs: a record event (`created`, `updated`, `deleted`, `restored`), a
field change (from / to), a `schedule` (cron in the automation timezone), `dateRelative` (N days
before or after a date field, daily; or some minutes before or after a datetime field, checked every
minute, ADR 0570), `manual` (a record button or bulk action) or
`approvalDecided`, a `webhook` (a verified delivery to an endpoint, optionally of given event types)
or a `syncEvent` (email/calendar sync wrote, changed or removed an activity linked to a known
person or organisation; the activity is the trigger record).

### Connection binding

A person's consent that an automation uses a connection: the automation declares named
connections it needs (`connections: [{ id, gatekeeper, purpose }]`) and someone binds each to a
connection they own (or, an admin, to an org connection). Steps then act through it as the
connection's owner. Recorded with who and when; revoking it, disconnecting or expiring the
connection, or deactivating its owner pauses the automation and tells the admins. An automation
with an unbound connection is "Waiting for connections".
_Avoid_: grant (that is a gatekeeper's resource access), run-as user

### Run

One execution of an automation, on a Cloudflare Workflow whose id derives from the run's
idempotency key, so a duplicate event never runs twice. Statuses: queued, running, waiting (a
sleep or wait), review (paused on a pending action), completed, failed, cancelled, expired,
skipped. Kept 30 days (failures 90). Each `step.do` runs in a Dynamic Worker as actor `automation`.

### Test mode

A dry run of an automation against a chosen record through the simulation overlay: nothing is
written, waits are skipped and shown, and it reports the writes, notifications and approvals the
real run would produce.

### Cascade

Automation-caused changes triggering further automations. Events carry the cascade depth and chain;
depth is capped at 3 (deeper events are dropped and logged) and an automation never retriggers
itself on the same record within one cascade (cycle detection).

### Kill switch

An org setting that pauses every automation at once: no new runs start and running ones stop at
their next step. Only a human admin can engage or release it.
_Avoid_: emergency stop, pause all

### Notification

A typed message to one user in the in-app notification centre (the bell and inbox), with a link
to a record, approval, automation or run, read or unread. Sent with `notification.send` by
automations, approvals and the system. Its type routes it to email or Slack per the recipient's
preferences (cos-runner's minute cron delivers them, ADR 0172).
_Avoid_: alert, message (when you mean the stored notification)

### Notification preference

A person's choice, per notification type, of whether a notice also reaches them by email or Slack
DM (in-app is always on), and whether they get the daily digest in the app (on by default) and by
email (off by default).

### Daily digest

Once a day, from the admin's digest hour in the automation timezone, one summary per person:
changes others (including the assistant and automations) made to records they own or are assigned
in the last 24 hours, their tasks due today or overdue, the approvals waiting (for people who can
approve) and their unread notices. It arrives as an in-app `digest` notification when there is
news, and by email when they asked for it, at most once a day, optionally opening with a labelled
AI overview (ADR 0206). Activities are never part of it.
_Avoid_: daily summary, newsletter

### Channel route

An admin rule that posts a short message with a link to a Slack channel when a record of an object
is created, updated, deleted or has a field change (e.g. deal won → #sales); activities are never
routed.

### Escalation

An unread "Approvals waiting" notice sent again by email or Slack after the admin's delay; an
escalation is never escalated.

### Host module

A `codemode:*` import that extension code can call, backed by trusted host code. Examples:
`codemode:ops` (operations), `codemode:ai` (model roles), `codemode:<gatekeeper>`.

### Gatekeeper

A Worker that mediates all access to one external service. It handles OAuth accounts, exposes a
capability API per resource, journals actions and simulates pending ones. The term and interface
come from Cloudflare OS.
_Avoid_: connector, integration (when you mean the Worker)

### Integration

The user-facing name for a connected gatekeeper ("Gmail integration").

### Connection

One connected gatekeeper account: **personal** (a user's own; only that user's actors may use it)
or **org** (set up by an admin, e.g. a shared inbox or the company Slack; everyone's actors use it).
It has an owner, a sharing level, a status (connecting, active, expired, error, disconnected) and
its bound **resources** (a mailbox, a calendar, a Drive folder, a Slack workspace, a webhook
endpoint), each served by one gatekeeper facet. Settings → Integrations manages them.
_Avoid_: connected app (that is an MCP client), account (the provider's side)

### Integration host

The Durable Object in cos-runner, one per connection, that implements the Workshop side of the
gatekeeper interface: it owns the connection's account, facets and hooks, runs the connect handoff,
decides outbound actions and observations, and runs sync. D1 only mirrors its state for the UI.

### Sharing level

How much a connection's synced mail and meetings disclose to the CRM, chosen by its owner: *full*
(subject, participants, time and content), *metadata* (subject, participants and time) or *none*
(don't sync). Writing into the shared CRM is the point of disclosure. A synced activity can also be
marked **private** afterwards (only its owner sees it).

### Outbound action

A side effect a gatekeeper submits (send an email, post to Slack, spend ZoomInfo credits). It is
gated as risk `outbound` by its **action kind** (`email.send`, `slack.post`); under Balanced it
waits in the Approvals inbox unless the gatekeeper marks the kind auto-approvable and an admin
enabled it. Approving it makes the gatekeeper apply it, in order per resource.
_Avoid_: operation (an outbound action is not in the registry)

### Accounting contract

The typed session every accounting gatekeeper serves (`AccountingSession`, in
`packages/gatekeeper-accounting`, ADR 0880): read the books' accounts, tax rates, lock date and
contacts; post a contact, a summary, a transfer, an invoice, a credit note, a payment or a refund,
each with the host's **reference** (`cos:…`) so it is found again and never written twice; void
only a document the host posted, always approved by a person. No delete, no edit of a posted
entry. Each accounting system is its own gatekeeper Worker that passes the contract's
**conformance suite**; the fake books (`accounting-fake`) are for development and tests only.
The connection is **the host's alone** (ADR 0881): only the host's own call (`callAsHost`,
purpose `accounting`) reaches it, never a person, an AI, Code Mode or an extension
(`accounting_host_only`).
_Avoid_: connector, sync adapter

### Booking system contract

The typed session every booking-system gatekeeper serves (`BookingSystemSession`, in
`packages/gatekeeper-booking-system`, ADR 0920): read the site, its people, membership types,
memberships and passes, class types, classes, bookings, staff, one person's past visits, and the
hints the system sent. Read only: no write of any kind and no outbound action, so nothing is
journalled or approved. Every answer is copied into the contract's shape, so nothing else about a
person leaves the gatekeeper. It is served from **loaded files** (the **file source**: a people
file and optionally a timetable a business exported, mapped by column and dry run first) or, for a
system read through its API, by a gatekeeper Worker; each passes the contract's **conformance
suite**. The fake booking system (`booking-system-fake`) is for development and tests only.
_Avoid_: connector, sync adapter, import

### Booking system

An outside system where a business's members book classes and hold memberships, kept beside the
new system for a while. Its data reaches the host only through the **booking system contract**,
read only. _Avoid_: provider (that is payments'), source

### List (booking system)

One loaded file of one kind from the booking system: `members` (people with their memberships and
passes) or `timetable` (classes, their bookings and their coaches), with the date it was exported.
A load **replaces** the list of its kind. A list is as old as its file: a `members` list past the
**largest age** (31 days by default) is "too old to count". _Avoid_: import, sync

### Outside person

, **outside membership**, **outside class**, **outside booking**, **outside staff**

The host's copies of what the booking system's current lists say (`core_outside_*`, ADR 0922), read
only through `outside.*` and in no `rec_*` view. Each carries the list it came from and so its age.
An outside person is kept only while they are a member, hold a live pass, are booked in the
timetable, or are staff-linked. _Avoid_: synced member, imported member (an import makes records
that stay)

### Linked (by address)

An outside person matched to exactly one live Person holding the same (folded) address, or an
outside coach to one staff account: not a merge, and not proof that the Person is them. Nothing on
the Person changes. Several candidates, or several outside people on one address, wait in **To
match** for a person with `bookingSystem:manage` to link by hand (`outside.link`, with why), which
is kept across loads by ref. _Avoid_: merged, synced

### Suggested contact

An external address the org has exchanged mail with at least twice that matches no person,
shown grouped by domain in the Suggested contacts inbox for one-click add. Nothing is created
automatically. The inbox also lists suggested **job changes** from mail (a bounce, a new signature,
a new domain), applied with `person.changeJob` on confirmation.

### Integration event

An inbound event for automations: a verified webhook delivery (typed, e.g. `invoice.paid`) or a sync
event (`email.received`, `meeting.updated`). Kept 90 days; cos-runner's minute cron turns them
into `webhook` and `syncEvent` triggers and marks them consumed.

### Outbox

(automation events)

Where an operation's automation events are written in the same batch as its change, sent to the
queue after commit and deleted; cos-runner's cron retries any that are left, so a failed send
never loses an event.

### Principal

The authenticated caller of a request: `{ userId, email, name, roles }`, resolved by the identity
adapter for every route and server function. In the operation layer the principal is one of three
kinds, one per audience: `staff` (a user and their role), `customer` (a customer account and its
Person) or `public` (no account). A handler reads it as `ctx.principal` (stage 22, ADR 0412).
_Avoid_: user (when you mean the caller of a request), session

### Identity adapter

The deploy-time choice of how a Principal is resolved: `better-auth` (default) or
`cloudflare-access`, selected by `IDENTITY_PROVIDER`. Implements `IdentityProvider`.

### Assistant

The in-app AI, named "Assistant" by default and renamed in Settings → General (`assistantName`;
never "Claude"). Each person has one, with one **thread**. Its front agent answers with the
`assistant.core` model role and acts as actor `assistant` for the signed-in person, as an MCP
client of our own MCP server (the same tools, gate, change sets and simulation as an external
client). It opens docked on any page, at `/assistant`, from "Ask AI" on records and "Ask about N
selected" on lists, and knows the page, record and selection (ADR 0030, ADR 0200, ADR 0340).
_Avoid_: Claude, chatbot, copilot

### Thread

A person's one chat with their assistant, which never resets: an `AssistantAgent` Durable Object
named `user:<userId>` plus one `core_assistant_thread` row. A **turn** is one message and
everything the assistant did to answer it. Older messages stay searchable (`thread.search`). "Your
chat" in the UI (ADR 0340).
_Avoid_: conversation (stage 7b had many per person; there is now one), session

### Prefix

and **tail**

What a turn sends the model, in two parts (ADR 0341). The prefix (instructions, tools, memory, the
"where we left off" note, then the messages since) is byte-stable across turns so the provider's
prompt cache keeps hitting; its hash is recorded per turn. The tail is what changes every turn
(pending memory lines, page context, display facts, the time), sent as a `<context>` block at the
start of the new user message and kept with that message afterwards. The person never sees it.

### Playout

What the person actually heard of a spoken reply: `spoken`, `partly_spoken` (with the words
`unsaid`) or `unspoken`, worked out from the milliseconds the browser played. The model is shown
only what was heard (ADR 0349).

### Dictation

The mic in the chat box: words stream into the box, a cleanup pass tidies them, and the message
is sent as if typed. Not **voice chat**, where the assistant talks back and messages show in
italics with a mic (ADR 0349).
_Avoid_: voice input

### Thread compaction

Folding a thread's older messages into a short "where we left off" note, keeping the last ~10
exchanges, when a cost model says it is cheaper, between 24k tokens and 80% of the model's window
(ADR 0341). The messages themselves stay, and stay searchable; the model just stops being sent
them. Different from **Compaction** of pending actions.

### Memory line

One thing the assistant remembers about the person, shown on "What your assistant remembers":
**personal**; a **shortcut** ("the pipeline" means …); the **writing style** section;
**conditional**, with a view-style filter, used only on matching records; or **team**, shared and
governed by a workspace setting (open, approval, restricted). A **pending** line was saved since the
last thread compaction and sits at the end of the context until it is folded in. A **proposed** line
waits to be read back and confirmed, or for a team line's approval. Written inline, checked by Jev,
never a fact about a customer: those go on the record as a proposed note (ADR 0342).
_Avoid_: note (that is on a record), fact

### Agent

Longer work the assistant hands off so the chat can carry on: an `AgentJob` Durable Object, a
**job** in code, with a brief, records by id, the memory read at start and a **grant**. **Awaited**:
the reply waits for it, with no card, until a time limit. **Background**: a progress card, results
later. It stages what needs review and never asks; a person can stop it, not chat with it (ADR
0344).
_Avoid_: job or subagent in the UI, task (that is a CRM task), worker

### Grant

What one agent may do: operations, a target set, count caps and an expiry, never more than its
starter may do. Inside it an agent fills empty fields and adds notes and tasks without review;
changing a value is **staged** in the job's change set; anything else comes back as its own card.
_Avoid_: permission (a role's), scope (an MCP token's)

### Agent profile

A named kind of agent (researcher, drafter, importer, analyst, or a plugin's): instructions, a
default grant, a budget and a model role.

### Second step

What a high-risk approval takes: the two-step button, or the exact phrase typed or said. Enforced
by the server. High risk is a destructive action, or an email to more than
`approvals.phraseThreshold.email` recipients (ADR 0345).

### Routine

A personal automation (`owner_user_id`, scope `personal`) that messages the person's thread: a
trigger, plain and Jev gates, and the step "message me in my chat". "My routines" in settings and
plugin pages; in chat the assistant offers the outcome and never says "routine" (ADR 0343). The
person turns it on from a **read-back** card with a **backtest** over the last 30 days. A delivered
message has an info dot with a **why panel**: what they asked, when, the trigger and the checks.
_Avoid_: reminder, alert, task

### Agent (UI) / job (code)

Longer work the assistant hands off: an `AgentJob` Durable Object named `job:<jobId>`, awaited or in
the background, with a brief, the records, read-only memory and a **grant**. It stages changes for
review and never chats. "Agents" in the UI; `job` in code and storage (ADR 0344). A CRM **Task** is
a to-do on a record, and a **job change** is a person's new employer: both unrelated.
_Avoid_: task, subagent (in UI copy), worker

### Agent profile

A named kind of agent (researcher, drafter, importer, analyst, or one from a plugin): instructions,
a default grant, a budget and a model role, never a model.
_Avoid_: job profile, persona

### Grant

What one agent may do: operations, a target set (ids or a filter), count caps and an expiry. Never
wider than its starter (a user, routine or plugin), and checked by Jev against the brief (ADR 0344).
Different from a **Support grant**.
_Avoid_: permission (that is a role's), scope

### A2UI producer

A saved Code Mode script, usually shipped in a plugin, that queries the CRM and returns an A2UI card
from the versioned catalogue with no model call, run on a stable loader id (ADR 0346). It reads as
the viewer and can change nothing. An A2UI card is a rich message from that catalogue, stored with
a text fallback. A button on a card the model or a producer wrote runs as the assistant, so the
approval policy applies.
_Avoid_: widget (that is on a dashboard), template

### Plugin

A bundle of assistant and CRM items (skills, saved code, A2UI producers, routines, agent profiles,
presets, dashboards, views, extensions, connection needs) described by `plugin.json`, installed at
personal, team or role (optionally **locked**), or org scope (ADR 0347).
_Avoid_: extension (that is code that changes the CRM; a plugin may contain one), app, add-on

### Plugin copy

What installing a plugin creates in the owning scope, stamped with the source version's
fingerprint. An unchanged copy updates by itself; an edited one is compared and merged; a detached
one ("Stop updates") no longer updates.

### Connected assistant

A colleague's assistant, in the same workspace, that yours may exchange messages with under a
**contract**: numbered rules in plain English tagged Automatic, Asks you or Never, agreed by both
people. Every message is checked by Jev and logged (ADR 0348).
_Avoid_: agent-to-agent (in UI copy), connection (that is a gatekeeper account)

### Model role

A named AI job (`build`, `assistant.core`, `assistant.subagent`, `summarise`, `extract`, `classify`,
`embed`, `vision`, `review`, `transcribe`, `speak`, `dictation.cleanup`; ADR 0351) mapped to a
provider + model in the model registry. Code asks for a role, never a model.

### Model role registry

The core table (`packages/core/src/ai/roles.ts`) that resolves each model role to
`{ provider, model, params, fallback }` through three layers: shipped defaults (every text role on
Workers AI, the speech roles on AssemblyAI), deploy config (`AI_MODEL_ROLES`) and admin overrides (Settings → AI, stored in
`core_settings`, settings only). Each role declares the capabilities it needs (tool use, JSON
output, context size, vision, embeddings); the registry rejects a model that lacks one. "JSON
output" is met by JSON mode (`json_object`) or a JSON schema; no role sends a schema yet
(ADR 0192). Calls run through the AI SDK and AI Gateway: Workers AI over the binding, other
providers through the unified endpoint as `provider/model`, custom providers as
`custom-<slug>/<model>` (ADR 0150, ADR 0203). Provider keys are AI Gateway BYOK or Workers
secrets, never D1 (ADR 0151). On a hosted deployment Workers AI roles run as **Platform AI**.
_Avoid_: model config, LLM settings

### Judge

The seam that asks typed questions about one piece of evidence (`state`) and gets answers with
probabilities, or "unavailable" with a reason: Choice (one label from a closed set), Noul (the
probability one condition holds) and Score (an ordered scale). Code holds every threshold and
decides what follows; an answer is a judgement, never permission, and each **placement** fails open
or closed by rule. Lives in `packages/core/src/judge/` and reaches operations as `ctx.judge`;
its provider is **Jev**. With no Jev key it is off, makes no network call, and nothing changes
(ADR 0230).
_Avoid_: reviewer (that is the adjudicator's), classifier, the `review` role

### Reviewer

Who gives the policy adjudicator its verdict, behind the `PolicyReviewer` seam: the LLM reviewer
(model role `review`, through the `Reviewer` interface in `adjudicator/reviewers.ts`) or the Jev
reviewer, which asks the judge which rule stops the change and which allows it
(`judge/questions/adjudicator-policy.ts`). Unset, it is Jev whenever the judge has a key; when
Jev cannot answer, a person decides, never the LLM (ADR 0232, ADR 0233).
_Avoid_: judge (that is the Jev seam)

### Jev

TypeSafe AI's decision model, the judge's provider, pinned to one version in code
(`JEV_MODEL`). It never writes text or acts. Reached through AI Gateway's custom provider
`custom-typesafe`; its key is BYOK or the Worker secret `TYPESAFE_API_KEY`, which an admin can
store from Settings → AI (on a hosted workspace through the control plane, ADR 0234). See
`docs/jev.md`.

### Placement

A named place in the code that asks the judge (`authoring.intent`, `adjudicator.policy`,
`summary.statements`, `outbound.message`, `sync.jobChange`, `widget.shape`, `eval.*`), with its own
questions, thresholds, timeout and fail mode (open: carry on and say it was not checked; closed:
the safe outcome, such as escalating). Code asks for a placement, never a model. A placement that
sends record content is off by default; a deployment turns it on with the `JUDGE_PLACEMENTS` var,
and admins switch placements in Settings → AI's Judge section (`judge.update`, human admins only;
ADR 0232), which also shows each placement's **judge spend**: calls and input tokens counted in
`core_judge_usage` by a statement in the batch the placement already writes (ADR 0234).
_Avoid_: check (too general), hook

### Labelled set

Hand-written cases for one judge question, each with the side of the threshold it should fall,
from which the threshold is set by `pnpm eval:calibrate` (three live runs per case, judged by the
median; `evals/judge/sets/`). A question cannot ship without a calibration record for its current
wording (`calibration.json`, ADR 0231), and CI replays the committed recordings.
_Avoid_: test set, golden set

### Model role preset

A named, ready deploy-config layer (`ROLE_PRESETS` in `roles.ts`) that one deployment chooses
with `create-composable-os --model-roles <name>` (or `COS_AI_MODEL_ROLES` for `pnpm run deploy`). It
becomes that deployment's `AI_MODEL_ROLES` and never changes the shipped defaults. The first is
`deepseek-flash`: every role but `embed` on DeepSeek V4.1 Flash with Workers AI fallbacks
(ADR 0192).
_Avoid_: profile, model pack

### AI summary

Text written by the `summarise` role about a record, a meeting (meeting prep), a long activity
(one-liner) or a change set, cached in `core_ai_summary` by a hash of its inputs and the model:
it is stale as soon as anything it was built from changes. Always labelled "AI-generated" and only
generated on request (ADR 0153).

### Semantic search

Search by meaning: records' text embedded by the `embed` role into Vectorize, re-embedded only
when the text's hash changes, merged with full-text results by rank (hybrid search). Powers Cmd-K's
"Related by meaning", Similar records and the assistant's retrieval (ADR 0154, ADR 0155).
_Avoid_: vector search (for the feature; Vectorize is the store)

### View spec

The JSON a view is made of, rendered by our components: a discriminated union of `table`, `board`,
`calendar`, `gallery` and `dashboard` (filters and widgets with read-only SQL over `rec_*` views
and a chart mapping). See ADR 0056 and ADR 0057.

### Release bundle

One versioned, reproducible `composable-os-crm-<version>.tar.gz` (for the CRM) holding every
Worker's modules, cos-app's static assets, the core migrations and the **release manifest**
(generated from the `wrangler.jsonc` files, with placeholders such as `$ACCOUNT_ID` and
`$D1_ID(crm)` for account-specific values). Published as a GitHub Release asset with SHA256SUMS
and a build attestation; `create-composable-os` installs it and the **self-updater** upgrades to it. See ADR 0053 and ADR 0160.
_Avoid_: build, artifact (for the bundle as a whole), package

### Channel

Which releases a deployment is offered: **stable** (`X.Y.Z` only) or **beta** (also `X.Y.Z-beta.N`).
Set in Settings → Updates. See ADR 0161.

### Location

(stage 64)

One place the business works from, inside the one organisation (ADR 0910): a gym's second studio,
in trades a branch or depot. A base record (`location`, `core_location`) with a name, a short name
for a badge, an address, its own time zone, whether the public is shown it, an optional drop-in
price, and `open` or `closed` (a person closes one; the last open one never). Never a tenant. The
public reads a public open location's name, short name, address and zone (ADR 0916).
_Avoid_: site (a site is a client app), branch (except in trades), the location hint

### Main location

The first location, made by migration 1390 from the organisation's name and zone. Its zone is the
organisation's (pay periods and the books) and changes only with it, in Settings → General.

### Location hint

Where a new install asks Cloudflare to create its D1 database and R2 buckets (`oc` is Oceania),
chosen at the first install (`--location`, or `location` in a client's `product.ts`) and kept in
the deployment state. A preference Cloudflare follows best effort, sent only on create: never a
guarantee of where data is kept, and an existing install is never moved. Not a **jurisdiction**
(Cloudflare's hard limit, `eu`, `us` or `fedramp`), which is not offered. See ADR 0580.
_Avoid_: region, data residency (for the hint)

### Preflight

The check before an update, computed from the installed and target manifests and the database: runtime
extensions against the new extension contract, pending core migrations, gatekeeper changes and new
secrets or inputs. A **blocker** refuses the update and says what to do. See ADR 0164.

### Self-updater

Settings → Updates: a deployment updating itself from GitHub Releases with an optional scoped API
token (`COS_UPDATE_TOKEN`). It runs the same procedure as `cos upgrade`: pause automations, take a D1
Time Travel bookmark, migrate, switch all Workers together, smoke-check, resume; **rollback**
redeploys the previous bundle and restores the bookmark. See ADR 0054 and ADR 0164.

### Setup wizard

The first-run steps an admin sees after install (`/setup`): account, organisation, AI, approval policy,
connect or import, sample data. Skippable and resumable. **Sample data** is removed in one click. See
ADR 0167.

### Stage

One unit of the build roadmap. Each stage has an interview, an agreed spec in `docs/stages/`, and a
separate build session.

### Hosted deployment

A deployment we run for a customer in our Cloudflare account (ADR 0210): user Workers in the
Workers for Platforms dispatch namespace, reached at `<org>.` on the hosted CRM's domain. Only the
**control plane** calls it an *instance* (`cp_instances`) and knows its **tenant id** (`t…`), which
prefixes its Worker and resource names and never appears in the deployment's data. The deployment
sees it only as a deploy var (`COS_TENANT_ID`), for the **tenant tag** on Platform AI calls and
for signing its calls back to the control plane.

### Hosted client

(stage 46, proposed; ADR 0610)

A client product's deployment in our Cloudflare account, in the Workers for Platforms namespace,
deployed by `cos deploy` from the client's repository. It keeps the names its `product.ts` gives
it and has no tenant id. Its **tier** is **standard** (settings only, on a standard product's
release, behind a shared web app), **bespoke** (its own repository, web app and extensions) or
**own account** (the same, in the client's Cloudflare account).
_Avoid_: tenant (for a client), multi-tenant

### Fleet

(stage 46, proposed)

Every hosted client's hosts together. We set its platform version; a **hold** keeps one client
on its version through a fleet update.

### Control plane

`crm-control` on the hosted CRM's `app.` host (`products/crm/apps/control`): sign-up, plans,
billing, provisioning, rollouts, support grants, export and delete. It never holds customer data.
The **dispatch Worker** (`crm-dispatch`) routes each verified hostname to its deployment and runs tenants' crons.

### Plan

Free, Team, Business or Enterprise (ADR 0211). Said alone, "plan" means this hosted plan; what a
company's customers subscribe to is a **subscription plan** (or, in the Memberships pack, a
membership plan). Its limits reach a hosted deployment as
**entitlements**: one `core_entitlements` row the control plane writes and the deployment enforces
(users, records, **Platform AI**: models we pay for, as opposed to the customer's own keys or MCP).
A self-hosted deployment has no entitlements and no limits.

### Platform AI

The AI a hosted deployment's plan pays for and we bill (ADR 0213 and its amendment): Workers AI's
models, as the registry provider `platform`, called through the **one shared platform gateway** in
our account. On a hosted deployment every Workers AI role is Platform AI. Each call carries the
**tenant tag** (`cf-aig-metadata`: role, tenant, plan), set only by host code in the model client,
never by extension code; the gateway keeps metadata, tokens and cost, never prompts or replies,
and caches nothing. Metering filters the gateway's logs by the tag. Self-hosted installs have no
Platform AI: Workers AI runs through their own gateway (ADR 0180).
_Avoid_: built-in AI, credits

### Own key (hosted BYOK)

On a hosted deployment, a provider key the customer adds in Settings → AI. The control plane sets
it as a secret on the tenant's Workers over the signed **deployment channel** (ADR 0250); calls
with it go directly to the provider (or through the customer's own AI Gateway, if connected),
never through the platform gateway. Shown in the workspace's usage, never billed, never in D1.
On a self-hosted install "BYOK" means keys stored in its own AI Gateway (ADR 0151, ADR 0180).

### Paused / suspended

Hosted lifecycle states. *Paused*: an idle Free deployment whose crons are stopped; the next visit
wakes it. *Suspended*: traffic stopped for billing or pending deletion; data kept.

### Support grant

Time-limited access for our staff to a hosted deployment, requested in the admin console and
approved by the customer's admin in Settings → Support access (ADR 0212). It acts through a
dedicated **support user**, never as the customer.
_Avoid_: impersonation

### Rollout

A new release reaching hosted deployments in **waves**: the **canary** cohort, 10%, then all
(ADR 0215).

## Products, customers and client apps (stages 20 to 28)

These terms come from the platform's design (ADRs 0400 to 0405). Most name things stages 21 to 28
build; the entries say which.

### Primitive

Something products are composed from, provided by the platform: an object with fields, a
behaviour, an automation, a view, a dashboard, a gatekeeper capability, or a base record type.

### Behaviour

A declarative rule set an object opts into in its manifest, enforced by the host in the same batch
as the write, for every actor (ADR 0404): `stages` (the **stage behaviour**) and `states` (the
**state machine**), which exist and share the **transition engine**; `capacity` (places, holds
and claims, ADRs 0430 to 0433) and `sellable` (prices, sale rules and what a paid line grants,
ADR 0435), which exist; `publishable` (a working copy and published versions, ADR 0446), whose
half without a public exists; `recurring` (a series that makes dated records, weekly or every N weeks, months or years, ADRs 0500 and 0860), capacity **claimants**
(ADR 0501, with waitlists, ADR 0520) and declared uniqueness (ADR 0502), which exist since stage
31; `allowance` (ADR 0493), which exists since stage 32b; `staffed` (a shift and its time claim,
ADR 0621), which exists since stage 45.
_Avoid_: hook, trigger (a trigger starts an automation), plugin

### Pack

A shipped extension plus its headless client hooks, versioned and released by the platform, turned
on per product: Deals, Leads, Ticketing, Content (stage 24, ADR 0401). One folder, `packs/<id>/`:
the extension (`index.ts` and its files), `client/` (headless hooks) and `blocks/` (screens). A
release carries every pack; a product lists the packs its deployments install (`packs` in its
`product.ts`, `COS_PACKS` on the host), and a deployment has none of a pack it does not install
(ADR 0420 as amended).
_Avoid_: module, plugin (a plugin is an assistant plugin, ADR 0347), app

### Block

A screen, or part of one, for a pack or the base layer, in a web skin or a native skin: a folder
with a `block.json` (its pack, skin, operations, files and the blocks it depends on). Shipped,
MIT, inside the release; copied into a client app with `cos add`, recorded in
`blocks.lock.json`, and the client's from then on (`cos diff` shows upstream changes). A block
holds no rules; the block lint refuses one that does (stage 24, ADRs 0401, 0424).
_Avoid_: component (too general), widget (a widget is a dashboard tile), template

### Docs site

The technical documentation at docs.composableos.dev, `apps/docs` (ADR 0930). Its **reference
pages** are generated from the code (packs' manifests, blocks, the core registry, behaviours,
gatekeepers, the `cos` help, products, this file) and never edited by hand; its **overviews**
(`packs/<id>/docs/overview.md`, a capability's `docs/overview.md`) and **guides**
(`docs/guides/`) are written beside the code. On the site a pack's pages and a **capability**'s (a
core piece any pack composes, documented as a unit: Agreements) are listed apart.
_Avoid_: module (for a pack), wiki

### Screen

A shipped pack's staff screen in the product's admin (stage 47, ADR 0660): one of its web blocks,
declared in its manifest (`screens`: a label, the block and export, where it sits in the
navigation, the tools that gate it, and optionally the record whose page shows it as a tab),
built into the admin and shown to whoever could call every tool in its gate (`screens.mine`).
Runtime extensions declare none. A fixed-role account's admin shows its screens and nothing else.
_Avoid_: page (an admin page is the host's own), view (a view is a saved spec), app screen (the
app's screens are native blocks, not declared screens)

### Today item

One number on the owner's Today (stage 60, ADR 0870): a key, a label, a value for the business's
local day, a comparison, whether it needs attention, and what a tap opens. A **host item**
(`host.takings`, `host.approvals`) is computed by the host; a **pack item** is declared by a
shipped pack in its manifest (`todayItems`: read-only SQL over `rec_*` views returning one
`value`, a count or a percent, never money, gated by the pack's own tools as a screen is). Runtime
extensions declare none.
_Avoid_: widget (a widget is a dashboard's tile), KPI (a dashboard's widget type), `today` (a pack
role's limit to today, ADR 0553)

### Client app

A company's own code that its customers or staff use, in the company's repository: a web app, a
mobile app, a TV app. It reaches the host only through the typed client (stage 24): a web app over
its service binding to the host's `ClientApp` entrypoint, as the signed-in customer or the public
and never as staff (ADR 0421); a phone over HTTPS.
_Avoid_: frontend, site (a site is one kind of client app)

### Client repo

The repository holding one product's client apps, its own extensions (`extensions/`), copied
blocks and its product definition (`product.ts`, `defineClientProduct`: the platform release the
host is deployed from, its packs, its apps). Started from the template (`cos create`) or adopted
in place (`cos init`), never a fork of the platform; it holds no platform code and no path to the
database (stage 24, ADR 0422).

### Environment

One deployment of a client product, named in its `product.ts` (`staging`, `live`): its own host
(Workers, database, secrets, addresses) beside the others in one Cloudflare account, deployed with
`cos deploy --env <name>`. `live` keeps the product's plain names (`<id>-app`); another is
`<id>-<env>-app`. One marked `live: false` may use test settings (ADR 0450).
_Avoid_: stage (a stage is a record's place in a pipeline), tenant

### Client kit

What a release carries for client repos, verified with the rest of the bundle: the template, the
skills as a client repo reads them, the blocks, the API contract per audience and the list of its
packs (`packs.json`, the only list `cos deploy` trusts). `cos create`, `init`, `add`, `diff` and `upgrade` read the kit of the release that matches
the repo's platform version (stage 24, ADR 0422).

### `ClientApp` (the client-app binding)

cos-app's entrypoint a company's web app binds to: customer sign-in and the HTTP surface for
customers and the public only, the caller decided from the customer's verified session cookie,
never staff (stage 24, ADR 0421).

### Audience

Who may call an operation: `staff`, `customer` or `public` (stage 22, ADR 0402). An operation
lists its audiences, staff only when it lists none. A caller outside them gets the answer an
unknown operation gets (ADR 0411).

### Open operation

An operation that lists `customer` or `public`. It is a `read` or a `write`, never more, and is
named in the generated `packages/core/open-operations.json` (ADR 0411).

### Visibility seam

`packages/core/src/visibility/`: the one place that decides which records, and which fields of
them, a caller may read or change. Every read of a record takes its source from it
(`visibleSource`). Staff see everything; a customer sees the rows whose customer field is their
own Person and the fields the object lists (ADRs 0244, 0410, 0412).
_Avoid_: row-level security (the database has none; the seam is in the host)

### Scope

What the visibility seam gives one caller of one object: `all`, `customer` (their own records,
and any the object shares with every signed-in customer), `public` (what the public, or every
signed-in customer, may read) or `none`.

### Staff

A signed-in user of the org with a role. Every user of the existing code is staff.

### Customer

A Person who can sign in to a client app (stage 22). Sees and changes only their own records,
through operations open to the `customer` audience. In the hosted entries above (Hosted
deployment, Own key, Support grant) "customer" still means the org a hosted deployment is run for;
where the two could be confused, say "the org" for that one.
_Avoid_: end user, member (a member is a gym's word for one kind of customer), client (in this
repo a client is the company a product is built for)

### Public

A caller with no account: a visitor reading a published page or starting a checkout (stage 22).

### Customer account

What a customer signs in to: a row of `core_customer` linked to exactly one Person, with sessions
of its own. Never a `core_user`, never a role. A human who is both staff and a customer has two
accounts and nothing links them (stage 22).
_Avoid_: user (a user is staff), login

### My account

The customer's own area on the business's website and in its app (stage 48): one shell copied
into the client app (`web-account`, `native-account`) with base sections (orders, agreements,
family, payment method, details, sign-in and devices) and each installed pack's section. What each
shows is the host's answer; in the app, money opens the website (ADR 0714). "Portal" is only the
name of the manifest key and the operation (`portal`, `me.portal`).
_Avoid_: customer portal, dashboard

### Needs your attention

The top of My account: what a customer, or a child they act for, has to do now, answered by the
host (`me.attention`, ADR 0711) as items of eight kinds worked out in core from agreements, orders,
subscriptions and allowances: a document to agree to, a card payment that failed, a payment to
confirm with the bank, a deposit's balance, an unfinished held order, a pass expiring or used up,
a free trial ending. How far ahead it looks is `account.attentionDays` (default 7).
_Avoid_: notifications, alerts, to-do

### Erase request

What deleting a customer account leaves for staff: the Person, when it was asked and when it is
due. Staff erase the person or decline with a reason; either closes it (stage 22). Deleting first
shows the member what will happen (the subscriptions they pay end at the period's end, their
unpaid orders are cancelled, the rest stays for staff), and the request's notice tells admins what
was left (ADR 0713).

### Host-internal operation

A core operation open to customers or the public whose handler keeps the raw database, for
account and session bookkeeping that is not a record. Marked `hostInternal`, shown in the
generated list (ADR 0413).

### Tool-only operation

An operation a customer reaches only from inside a pack's tool they called: `my.create`,
`my.update` and `my.delete` (the last only for an object whose `customer.delete` lets its
customer put their own in the Trash; ADR 0414).

### Surface

A way an operation is reached from its one definition: server function, MCP tool, host module,
HTTP (the last from stage 23). The HTTP surface is `POST /api/v1/op/<name>` for staff, customers
and the public, with the caller taken from the request's session (ADR 0415).

### Idempotency key

The `Idempotency-Key` header every write over the HTTP surface carries. The same key and input
returns the stored response without running the operation again; the key is the caller's own and
is kept 24 hours (ADR 0416).

### Typed client

A product's operations as types and TanStack Query option factories, generated from its own
registry by `cos client generate` into two entry points, `customer.ts` and `staff.ts`, over the
`@composable-os/client` runtime. Usable in TanStack Start, a Worker and React Native (stage 23,
ADRs 0403, 0418).

### API contract

What a client may call over the HTTP surface, per audience: each operation's kind, risk, JSON
Schema and what a mutation makes stale. Served as the manifest, committed as golden files, and the
generator's input. A change that would break a compiled client is a new API version (ADR 0417).

### Device session

A native app's sign-in on the HTTP surface: a short-lived access token and a refresh token that
rotates on every use, for one audience, named by the device. A reused refresh token ends it, and
so does a period without use (ADR 0419).
_Avoid_: token session, API key

### Staff invite

A human admin's invitation of a person to a staff account, by email address, with the role, pack
role and permission grants the account will hold from the start. Accepted once, before it expires,
by signing in with a code the host emails to that address, or under Cloudflare Access by the first
request. It never applies to an account that exists, and it holds no secret (ADR 0455).
_Avoid_: sign-up link, invitation token

### Host mail

Mail the host sends as itself (the system user) through the one email connection a human admin
chose: customer and staff sign-in codes, invite notices, a declined erase request (ADRs 0419,
0455). No staff member is its sender.

### Customer sign-up mode

Who may get a customer sign-in code, a human admin's choice: `invite_only` (the default),
`buyers` (also the buyer's address of an order a verified payment was applied to) or `open`; and,
on top of any of them, **anyone starting a subscription** (any address, while the host has a plan
on sale to the public, so a new visitor confirms their address and starts the plan with its trial;
in effect anyone can make an account while a plan is on sale, including people already in the
records, who then see their own records). The answer to a code request is
the same for every address whatever the mode (ADRs 0402, 0458, 0459).
_Avoid_: registration, membership

### Sign-in mail

The host's sign-in code email, its own outbound kind (`email.signin`): given only when the
integration host says the send is its own (`callAsHost`, purpose `sign-in`) and the message is the
fixed code template. A human admin lets it apply without review; until then sign-in by code is not
set up (ADR 0456).
_Avoid_: system email, transactional email

### Routine message

A declared message to the person a record belongs to (a booking's confirmation, a class change or
cancellation, a reminder), on email, text or push, sent by the host without a person's approval: a
shipped pack's kind its automation asks for, or a **host kind** host code asks for. The host chooses
the recipient from the record, fills the declaration's words from it, and holds for a person
anything that is not routine, anything an AI wrote or changed about what its words show included.
One row per recipient and channel. Off for each pack until a human admin turns it on (until then
each email waits for approval as before); each kind an admin can turn off, and its text and push
are off until an admin switches them on (ADRs 0590, 0670). Not a newsletter. Its former name,
**Routine mail**, stays in the code (`routineMail`, `core_routine_mail`).
_Avoid_: transactional email, notification, automated email

### Host kind

A routine message kind the host declares itself in core code (`core.<name>`, such as a membership
payment that failed), asked for by host code with an occasion, never by an automation, a tool or
an AI; off until a human admin turns it on (ADR 0670).

### Essential / optional

Whether a person can turn a routine message kind's email off: an essential one's always goes
(confirmations, a class cancelled, a payment failed); an optional one's (reminders, waiting list
news) they may stop. Text and push of any kind can be turned off (ADR 0670).

### Urgent

A routine message kind whose texts and pushes may go during quiet hours, only when waiting would
make them late: its moment (`until`) comes before quiet hours end (ADR 0676).

### Quiet hours

When texts and pushes wait: one business-wide window (9pm to 7am unless an admin chose), in the
time zone a human admin set for it; emails always go at once. A waiting one whose moment passed when they end is
dropped, `expired` (ADR 0676).
_Avoid_: do not disturb

### Value mark

Who stands behind one value of a record (`core_value_mark`: a person, a customer, the public, a
default, the host or an AI), with a hash of the value, written by the host in the batch that writes
it; a copy carries its source's mark. Routine mail reads marks only (ADR 0590).
_Avoid_: provenance, taint

### Routine mail kind

One declared kind of routine message (`bookings.reminder`, or a host kind `core.<name>`), with its
messages and the channels it may go on: what an admin turns on or off, and whose text and push they
switch on, in Settings → Routine email.

### Journey

A named set of steps the host takes for one Person at a time, because of what they did or stopped
doing: an entry rule, conditions, messages with waits between them, simple branches, staff tasks,
exit rules and a re-entry rule. **Service** (about something the member has or did) or
**promotional** (needs the Person's recorded yes; never about a child). Data the business edits,
run by the host; a person approves its wording once by publishing it (ADR 0800).
_Avoid_: sequence, campaign, drip, routine, enrolment

### Journey version

A published snapshot of a journey's steps and words, which nobody can change. Only a published
version runs; it was published by a person, or an AI asked and a person who may publish approved.

### Entry

(journey entry)

One Person on one journey: the version it started on, the step it is at, its state (active,
waiting, held, finished, stopped) and the standing of what put them on it.

### Signal

A moment about a Person that a shipped pack declares in its manifest (`journeySignals`) and a
journey can start or stop on: a record of one of its objects created, or entering one of its states
(`memberships.started`, `bookings.attended`). The host records, in the batch of the write that made
it, the last time each Person had each signal (`core_person_signal`), with who stood behind that
write and whether it was a bulk one; readable only as the Person is, in no view or export, gone
with an erase (stage 53, ADR 0802).
_Avoid_: event (Ticketing's), trigger (an automation's)

### Headless entry

A pack's functions and hooks over the typed client, with no markup (`<package>/headless`); the
base layer's are in the client runtime itself (`@composable-os/client`: agreements, My account). Blocks
render what it returns (ADR 0418).

### Capacity

A record's limited number of places (a ticket type's, a class's), declared by its object. The host
keeps a counter (places, held, taken) and the database refuses any claim past the places, for every
actor. A record may also draw on one parent's places, its **pool** (a ticket type within its
event). What customers and the public are told is the object's `show` (stage 26, ADRs 0430 to 0433).

### Claim

Places taken from a capacity for something: an order line, or a **claimant**'s record. `held`,
then `confirmed` once paid, or `released`. Made, confirmed and released in the batch of the
owner's own write.

### Claimant

A record whose own states hold, take and give back one place on the record its relation points to
(a booking on its class), declared `claims: { on, held, confirmed }`. The host makes the claim in
the batch of each move, refused by the database past the places, as an order's line is (stage 31,
ADR 0501). A claimant may declare a **waitlist** (`claims.waitlist`, below, ADR 0520).

### Stock

How many of a thing there are (a variant of an item in a shop), declared `stock` by its object.
Nobody types it: the host keeps it from the **stock ledger**, on capacity's counter, so an order's
line holds while unpaid and sells when paid, refused by the database past what is available. On
hand is what came in less what went out; available is on hand less what unpaid orders hold. A
refund changes nothing in stock; a return does. What customers and the public are told is the
object's `show` (stage 37, ADR 0680).

### Stock movement

One row of the stock ledger: a record, a place (one default place until stock is kept in several),
a signed quantity, a kind (opening, received, sold, returned, written off, counted, adjusted, used),
what made it (an order line, a record or a person), who and when. Never changed or deleted.

### Series

(of a recurring schedule)

A record that declares `recurring`: a rule in local wall-clock time (weekdays, a time, a
length, from and until dates, a zone) that makes dated records of another object ahead, up to its
horizon (a timetable line makes its classes). Weekly, or by its **interval rule** every N weeks
on its weekdays, every N months on a day (the month's last when shorter) or every N years on a
date, fixed on the calendar from its first date, never counted from when the last was done; a
length may be in days (ADR 0860). Each record made is its **occurrence**, keyed on the
series and its local date so it is made once. A copied field staff change on one occurrence (its
coach) is its **field exception**: the series never writes that field again and still writes the
rest; one whose time or state staff change is **detached** whole and the series' no more. **Follow
the series** clears exceptions (ADR 0620). 06:00 is 06:00 across a clock change (stage 31, ADR
0500).
_Avoid_: recurrence rule, RRULE, schedule (an automation's trigger); `sellable.recurring` (a
plan paid every period, below), which shares the word and nothing else

### Closure

A date range in which a series makes nothing, and whose records already made are cancelled (a
gym's holidays) (ADR 0500).

### Class type

(Bookings)

A kind of class (Strength, Yoga, Kids): Programs' `programs.classtype`, on which Bookings adds its
**booking rules** (when booking opens and closes, when a cancel is late, when the waitlist stops,
the reminder, and whether only staff book it). Each rule left empty is the organisation's setting
(Settings → Extensions → Bookings): 7 days, at the start, 60 minutes, 120 minutes, 180 minutes,
off (stage 31, ADRs 0504 and 0505).

### Class

(Bookings)

One dated occurrence of a series, or a one-off: a class type at a time in a zone, with a room, a
coach and its places. Members see how many places are left, never who has them.
_Avoid_: session (Programs' word for a dated workout), lesson, event

### Booking

One Person's place in one class: a claimant on its class, one live per Person per class, and a
spender of their membership's or pass's use when it is `booked`. A member's **cancel** is in time
until the class type's late-cancel time before the start (the use given back), **late** after it
until the start (the use kept), and not possible after; the host decides by its clock. Staff may
book anyone, into any class, and mark a walk-in **paid at the desk** (it spends nothing)
(stage 31, ADRs 0503 to 0506). A class the gym cancels cancels its live bookings with it, their
uses given back (**cancelled by the gym**, ADR 0507).
_Avoid_: reservation, appointment (31b's one-to-one), ticket

### Waitlist

(Bookings)

The bookings of a full class that are `waiting`: they hold no place and spend nothing. A member
joins only while every place is held or taken and before the class type's **cut-off** ("waitlist
stops", 2 hours before by default). Until the cut-off, a place given back while anyone waits is the
waitlist's at once, in the same batch: a hold nobody booking directly can take (stage 31,
ADR 0520). After it, a freed place goes to whoever books first.
_Avoid_: queue, standby

### Promotion

(Bookings)

The host moving the first waiter (by when they joined) into the place the waitlist holds, from a
current read, within about a minute (the minute cron): they are `booked`, their use spent then, and
the time recorded. A waiter whose spend is refused (nothing left, a pass ended, a membership
paused) is **passed over**: they stay waiting, first in line, with the reason recorded, and the
next is tried. A hold nobody can take goes back to everyone (ADR 0520).
_Avoid_: upgrade, moving up

### Class list

(Bookings)

A class's bookings as its coach sees them (`roster`): each person's name, booked, **ticked**
(attended), not come or waiting, and who marked it. A coach **ticks** a name from an hour before
the class; of two ticks at once one is made and the other is told who was first. Nothing on it says
what anyone paid with (stage 31, ADR 0553).
_Avoid_: roll call, register, check-in (Ticketing's word)

### No-show

(Bookings)

A booking still booked 30 minutes after its class ends, on a class whose list was taken (someone on
it ticked or marked as not come): the host moves it to `no_show`. It keeps its place and its use;
nothing else follows. A class whose list nobody took has no no-shows (stage 31, ADR 0550).
_Avoid_: absence, missed class

### Coach

(the Bookings role)

The pack role `bookings.coach`: the day's classes, a class list and ticking names, today's only;
nothing else (no money, no other people, no booking or cancelling). An account holds one pack role
(ADR 0436). A coach who also works the desk is granted the **Desk permission** on top (ADR 0600).

### Coach

(the Programs role)

The pack role `programs.coach` (ADR 0889): a coach's own clients in the app, the People an active
assignment names them coach of: their assignments and sessions, logging and marking for them, their
history and progress. Nobody else's, no class sessions, no programs, no assigning, no people. Who a
client's coach is, is the assignment's `coach`, the object's **team**.

### Team

(on an object)

A shipped pack's declaration of who on the staff looks after the Person a record is about (`team:
{ person, staff, live }`, stage 56's decision, built in ADR 0889): the accounts in its user fields
while the record is live. It gives nothing alone; a pack role's `looksAfter` reaches records only
for those People. Programs' assignment names the client's coach.
_Avoid_: stage 14a's teams (groups of staff), crew

### Desk permission

(Bookings)

`bookings:desk`, the front desk's tools: find people, book anyone (a walk-in too) into any class,
cancel and move bookings, give a use back, any day's classes and a class's full list. Every member
of staff holds them; a human admin grants them to a coach, whose role they add to (the coach's own
list and ticks stay today's). Not cancelling a class, refunds, or any record read.
_Avoid_: desk role (it is a permission, not a pack role), front-desk access

### Moved

(a booking)

A booking staff moved to another class: the new booking is made naming it (`movedFrom`), and in the
same batch the old one is `moved`, its place given back and its use spent again on the new one, or
nothing happens. Only before the old class starts (ADR 0551).

### Cancelled by the gym

(a class)

Staff cancel a class with a reason (`cancelClass`): every booked, waiting and held booking is
cancelled with it, places and uses given back. A person's act: an AI may ask, and a person approves
(ADR 0552).

### Timed move

(`states.after`)

A move the host makes by itself once a moment has passed (a booking after its class, a no-show),
found by the minute cron and made from where the record was read or not at all (ADR 0550).

### Guardian

and **Dependant** (the family link)

A **guardian** (a parent) is a Person a person on the staff linked, with `people:link`, to a
**dependant** (a child) they may act for: a **family link** (`core_person_link`, ADR 0540). While
it is live, the guardian, signed in, reads the dependant's records of every object that opens to
guardians (`customer.guardians`: a child's bookings, and what their memberships and passes have
left) and, where the object says so, makes and changes them (books, cancels and joins waitlists for
the child, under the same rules; the child's own membership or pass pays). One hop, one direction;
nothing on other objects. A dependant may have several guardians and no email or account. Ending a
link stops it at once; a merge re-points links, an erase deletes them. Decided at the visibility
seam alone.
_Avoid_: parent account, family account, sub-account, linked member

### Practitioner

(stage 43, proposed)

An outside person the business invited (a physiotherapist, a dietitian), with a **discipline** (a
label) and a **practice** (the outside business they work for). A fourth kind of caller beside
staff, customers and the public, with their own account and sign-in: they reach only their live
clients, and of those only what they wrote. Never a staff role or a grant on a Person. One human may
also hold a staff account and a customer account; the three never combine.
_Avoid_: external staff, partner, provider, therapist account

### Care link

and **Consent** (stage 43, proposed)

A client's agreement that one practitioner may work with them (`core_care_link`), asked by the
practitioner and agreed by the client themselves on the website or in the app; the consent records
the words shown, when and how. Live until the client, the practitioner or staff end it, and then it
stops at once. **Sharing** is the client's choice that one practitioner may read another's work for
them, one way, read only.
_Avoid_: referral, permission, access grant

### Practitioner work

(authored rows, stage 43, proposed)

Records a practitioner wrote, marked by the host with their **author**. Never in the `rec_*` views,
so never in SQL, dashboards, exports, search or the assistant; staff see on screen only what the
object says (restrictions, the rehab exercise list without notes) and cannot change it.

### Restriction

(Care, stage 43, proposed)

Something the coach must avoid or know about a client, from a practitioner: "no overhead pressing
for 6 weeks", or, as a **note for the coach**, "cutting weight for a competition". Coaches see it
and are told when one is added or lifted.

### Rehab program

and **Habits program** (Programs kinds, stage 43, proposed)

A practitioner's program for their clients, logged like training: exercises with sets, or habits and
check-ins ticked off or given an amount. Coaches see a rehab program's exercise list; a habits
program is the practitioner's and the client's only.

### Nutrition plan

(Care, stage 43, proposed)

A dietitian's targets, meals and guidance for one client, published for the client to read. Not seen
by staff.

### Practitioner note

(Care, stage 43, proposed)

A practitioner's own working note about a client. Read by its author only: not the client's screen,
not shared, never staff.

### Agreement document

(a **document**; stage 44, built in step 1)

Something a business asks people to agree to: its terms, a waiver, health questions, a parent's
consent. Its **kind** is a label fixed when it is made (`terms`, `waiver`, `health`, `guardian`,
`other`, and later the platform's `care`); only `health` changes how it works. Its **working copy**
(the draft the editor changes) holds the title, body, tick label, how a person agrees (tick and type
their name, or draw a signature), who agrees (the participant or the payer), for whom (everyone, or
dependants only) and a health form's questions, so none of them change until a person publishes. It
is a draft until first published, then live; **retired** is final. The business writes every word;
the platform ships no legal wording. Core tables, not records: in no `rec_*` view (ADR 0640).
_Avoid_: form (stage 29's), contract (what the law may make of it), template

### Version

(of an agreement document; stage 44, built in step 1)

One published wording of a document, numbered and kept for good: the database refuses any update or
deletion of it, by anyone. Published only by a person with `agreements:manage`, from the working
copy they reviewed (the hash of every term, and its rev), as a **small change** (earlier acceptances still count) or **agree
again** (they stop counting, so the next booking or purchase asks), now or from a date; the newest
one in effect is **current**. A published version is never withdrawn. An AI may draft the working
copy and can never publish, attach or retire, not even by asking. Every publish, attach, detach and
retire bumps one counter (`core_agreement_rev`) that the guard at commit reads. Not a record's
version (`core_publish_version`).

### Agreement point

(the `agreements` behaviour; stage 44: declared and attached in step 1,

`agreementsDue` and its guard in step 2, asked at checkout, subscription start and booking in
step 3)
A place a pack says agreement may be needed: buying a membership or a pass, making a booking,
buying a ticket or a course, a care link. A person with `agreements:manage` **attaches** published
documents to points; nothing is needed anywhere by default (ADR 0641). The host asks one question, `agreementsDue`, when an order or a
subscription starts and when a record enters a declared state, and the write's batch carries a guard
that fails if any document changed since. The host's own moves (a promotion, a paid drop-in booked)
are never checked. Shipped points: `membership` (a plan, a pass type, a pass given by hand),
`booking`, `event` (a ticket type, a ticket made by hand) and `course` (a course, a bundle, a
course plan, an enrolment staff give; the courses import's students are moving over and are not
asked).
_Avoid_: requirement (alone), gate (the approval gate)

### Acceptance

(stage 44: by a customer, a guardian and from paper built in step 2; a guest's

built in step 3, at the desk from step 6)
One record that a person agreed to one version of a document: by themselves, by a **guardian** for
a dependant, by a **guest** with their order (the Person's from the verified payment), or **recorded
from paper** by a person on the staff (shown as that, never as the member's own), or **at the desk**
on the business's tablet in a session a person on the staff started (the member's own, shown as
"agreed in person on the business's device"). It holds the version and the hash of what was shown,
who, how (typed, drawn, paper) and when; never the device or internet address. Nobody can change it:
the database refuses every statement but setting its Person (settlement, merge) and clearing who
it names (erase), ADR 0642. A drawn **signature** is kept as its strokes. It is
**current** while its version is at or after the document's last "agree again" (and, for health,
within its ask-again months); a document is **due** for a Person at a point where it is attached and
they have no current acceptance of it. The person is emailed a **copy** with the **signed PDF**,
built from the stored version, never kept as a file. A person agrees on the **Agree** block (web
and app, step 5): after sign-in on **Before you go on**, inline when the host refuses a purchase or
a booking with what is due (the **agreement step**), and from **My agreements**.
_Avoid_: consent (stage 43's care link word, which becomes an acceptance), signature (one way to
accept), sign-off

### Copy

and **signed PDF** (of an acceptance; stage 44, built in step 4)

The **copy** is the email the host sends, as its own mail, to whoever agreed, once per acceptance:
at once when a person agrees (to their sign-in address; a guardian gets the copy of what they
agreed for a child), when a guest's purchase settles (to the address it was bought with), and for
a paper form only when staff press "Email a copy" (to the Person's own address; for a child's
form, never to the child but to the linked parent or guardian staff pick, at the address the host
holds for them, ADR 0648). The address is
always the host's record, never a caller's, and no AI composes, sends, redirects or reads it
(ADR 0645). The **signed PDF** is the version's words and the record of the acceptance (who, how,
when, the name typed, the signature drawn), attached to the copy as `agreement.pdf` and downloaded
by the person, their guardian or staff; made on demand by one PDF writer, so a download and the
attachment are the same bytes for the same values. A health form's copy says the answers are in
the app (decision 21); a download shows them only to the person, their guardian and staff with
`agreements:health`. The **blank PDF** of a version is the form staff print for paper.
_Avoid_: receipt, certificate, attachment (alone)

### Kept acceptance

and **retention** (stage 44, built in step 8)

When a Person is erased, their health answers and minor mark go at once; each of their acceptances
is **kept**, detached from them (no Person, no account, `erased_at` set), as the business's
evidence, until the **retention** period ends (`agreement_retention`, years from the erase, default
7, a human admin's setting), when the daily **purge** deletes it. A guardian's erase clears their
name, signature and account from a child's acceptance, which is kept the same way, and the child
is due again. Only staff with `agreements:manage` find a kept one (by the address or the name it
holds) and open it, and they may put it **on hold** for a dispute or a claim, which the purge
passes by. The email gatekeeper's record of its copy is **scrubbed** (ADR 0646).
_Avoid_: archived, anonymised (the name typed and the signature are kept), deleted (until the
purge)

### Health form

and **health answers** (stage 44, built in step 2)

A `health` document's yes or no questions, a note if yes, and a person's answers. Health
information: kept apart from every staff bulk path and every AI actor, read on screen only by
staff with `agreements:health` (each read audited), by the person and by their guardian (ADR 0643).
A coach's class list shows only a **health note** mark beside a name whose current health form has
a yes.

### Agreement step

and **Before you go on** (stage 44, built in step 5)

The **agreement step** is what a block that buys or books shows when the host refuses the call with
`agreements_due`: each document it named, in turn, before "Pay", "Book", "Buy", "Join" or
"Subscribe" is tried again (in Bookings, Memberships, Ticketing and Courses). A member's are recorded as they agree (for a child, by their parent); a visitor's are kept
in the screen's memory only until the buying call, which carries them. **Before you go on** is the
screen after sign-in that walks through everything due for the member and each child; "Not now"
goes on. Neither decides anything: what is due, for whom, and whether the purchase may go ahead are
the host's answers.
_Avoid_: checkout gate, consent screen

### Minor

(for agreements; stage 44, built in step 2)

A Person who is a dependant of a live family link, or whom staff have marked as a minor (the host
holds no date of birth; `agreement.setMinor`, a person with `people:link`). Only a guardian's
acceptance or a paper form counts for them, never their own, and the database refuses their own.

### Desk signing session

(stage 44, built in step 6: ADR 0649)

A short session a person on the staff (`agreements:desk`: admins, and anyone granted it, a coach
with a fixed role included) starts, from their own signed-in account, for one named Person (and
the live children they sign for) on the enrolled tablet they choose: a one-time 8-character code,
good for 2 minutes, opens it only on that device. The tablet is signed in as nobody, uses the desk
origin, shows only that Person's due documents, and is refused on limits the host keeps (3 minutes
idle, 20 in all). An acceptance made in it is the member's own (`channel: "desk"`), naming the
session; the record says "Agreed at the desk on the device enrolled as [name] by [admin] on
[date]; session started by [staff] at [time]", never "in person".
_Avoid_: kiosk (a standing sign-in on a shared device, which this is not)

### Enrolled device

(stage 51 step 1, built with stage 44 step 6: ADR 0780)

A tablet or other browser a human admin enrolled as the business's own (`core_device`), for one
**use**: desk signing, a **device role** a pack declares (stage 51's check-in tablet, not built
yet), or a till (stage 50, not built yet). It holds one credential, a cookie on the desk origin
that alone opens almost nothing, rotated at least daily (and on every signing claim): the next
one is issued and the current one stays good until the device presents it, then the old one is
accepted 60 seconds more; a credential rotated away and used later revokes it as a clone, and 30
days unused lapse it. Every admin is told when one is enrolled, changed or revoked (Settings, Devices).
Not a **Device session**, which is a person's own app sign-in.
_Avoid_: kiosk, terminal, registered device

### Desk origin

(stage 44 step 6: ADR 0649)

The host's second hostname, `desk.` before its name (`DESK_HOSTNAME`, set by `cos deploy` on a
custom domain), served by the same Worker: the enrolled tablet's two pages (`/desk`, `/enrol`) and
its calls (`/api/desk/*`), and nothing else, while the staff origin serves none of them. Its
cookies are its own, every call checks `Origin`, and a call with a staff session is refused. A
deployment without the hostname has no desk signing and no enrolled devices.
_Avoid_: kiosk mode, desk mode on the staff origin

### Cooling off

(stage 44, built in step 7: ADR 0647)

The days (a Memberships setting, `coolingOffDays`; 0, the default, turns it off; a person's to
change) in which a **new member** (a membership started here, not one moving over with a
continuation offer, not a pass) may end their membership at once for a full refund of every period
they paid for the period, whatever they used. The window runs from the provider-confirmed start to
the end of the last day in the business's time zone; the days are those in force when they joined,
for good; once per member. An ask made inside the window opens it until a **deadline** seven days
later; while it is open any end of the membership is the cooling off's, and what is **owed** is
every order paid up to the window's end or after the ask and up to the end, each waiting for a
person with `orders:refund`. At the deadline an open one that has not ended **lapses** (owing
nothing as cooled off; the ordinary cancel works again; staff may **finish** it, for the window's
payments only, once the payment provider confirms the membership ended). The bookings ahead it paid for are cancelled as the business's. Nothing is offered in a free trial (nothing
paid: the ordinary cancel ends it). What the law asks is the business's to confirm.
_Avoid_: trial (a plan's free first days), grace period, cancellation (which ends it at the
period's end, with no refund)

### Shift

(the `staffed` behaviour; stage 45, built in step 2: ADR 0621)

A time someone works: a class (its coach works it) or a **duty shift** (cleaning, opening up), with
at most one staff account on it. **Covered** when it has a person, **uncovered** when it has none.
A record declares `staffed` to be one. One person's shifts never overlap: a **double-booking** is
refused by the database, for every actor. Each live, covered shift whose person has an account
holds a **time claim** (its own time, never preparation or pack-down, widened by its **buffer**
when its kind keeps one). A write of a shift answers its **warnings** (away, not qualified,
uncovered), which never refuse it (ADR 0622).
_Avoid_: session, slot, booking

### Thing

and **`occupies`** (stage 49, built in step 2: ADR 0765)

A **thing** is what a record takes for its time: a room, a chair, a hall. A record that declares
`occupies` takes its thing while it is live, and the database refuses a second live record on the
same thing at an overlapping time, whatever kind of record (a class and, later, an appointment in
one private room): the room is **taken** (`room_taken`), and the refusal never says by what. Only
things marked **one booking at a time** (Bookings' room's `exclusive`) are claimed; a shared floor
never is. A **buffer** (minutes kept free before or after) enters the claim. One occupant at a
time: not a capacity.
_Avoid_: reservation, slot

### Room calendar

and **provisional** (stage 57, built in step 1: ADR 0844)

The **room calendar** is every claim on the business's rooms in a range, whatever takes them (a
class, an appointment, a hire, an event, a block), read from the one claim by a pack's tool
(`rooms.week`, and `rooms.check` for one room at one time). Each shows its kind, a **title** its
object declares (an appointment's service, never its client), its times with set-up and
pack-down, and whether it is **provisional**: held, not yet firm (a hire before its deposit). A
provisional claim refuses a clash as a firm one does. Someone on a fixed role sees only that a
room is taken, and when. Nobody's name and no money are on it.
_Avoid_: availability (Venue hire's tool over it), schedule, timetable (the classes')

### Buffer

(stage 49, built in step 1: ADR 0760)

The gap a kind of session keeps before or after itself (15 minutes after a personal training
session). It is part of the provider's time claim, so nothing else of theirs is booked in it, but
never part of the session's own times or of pay. Classes keep none: two classes back to back are
fine. A session's provider must have an account; a profile with none is never booked for one.
_Avoid_: margin (the code's word), padding, slot

### Roster

(stage 45, built in step 4: ADR 0626)

Every shift in a range, with who works each (`staffing.week`, through Rostering's `week` and
`mine`): never a class's bookings, places or members. A **rosterer** may roster others: an admin,
or an account granted `rostering:manage` (restricted, ADR 0625); a rosterer is told what changes the
roster (takes, lapses, leave over shifts, a shift just left uncovered, the daily list of uncovered
shifts; ADR 0624) and sees each shift's warnings. With Rostering installed, only a rosterer says who
works a shift, by any path; anyone else offers their own. The **pattern** is its regular week (a class
series' coach, a duty series' person); an **exception** is one date changed from it, and only that
field leaves the series (a field exception, built: ADR 0620). Not Bookings' tool `roster`, which is
a class's list. Its screens (step 7, ADR 0629) are Rostering's blocks: the **week grid** (read only
for the team; a rosterer's shift opens **assign**: who could take it first, from the host's
`candidates`), the regular week (**patterns**), **qualifications**, everyone's time off and **pay**
on the web; **my shifts**, **offered to me**, **my availability**, **my calendar** and the roster day by day on the
web and in the app. A screen asks the host who is reading (`me`: whether they roster, whether they
handle pay) and shows only what that allows. A **role client with grants** is a mobile app's
client for a pack role that also holds the tools a grant opens (a coach with `rostering:roster`).
_Avoid_: rota, schedule (an automation's trigger), timetable (the members' classes)

### Duty

(Rostering; stage 45, built in step 4: ADR 0626)

A kind of work that is not a class (Cleaning, Open up), done in **duty shifts** made by a **duty
series** (`recurring`, as far ahead as the duty horizon setting) with its regular person. The
**team role** (`rostering.team`) is for someone rostered with no other access, such as a cleaner:
the roster, their own shifts, offers and takes, their time off, nothing else. Duties and who works
them move in with `cos rostering import` (a dry run unless `--apply`; the host's clash check names
every date that would put someone on two shifts at once).
_Avoid_: task (a base record), job

### Qualified

and **Unavailable** (stage 45, built in step 3: ADRs 0622 and 0623)

A staff member is **qualified** for a kind of shift (a class type, a duty) when a rosterer says they
may do it (`staffing.qualify`); only the qualified may take an offered shift, and rostering anyone
else is a warning. **Unavailable** (away) is a time they said they cannot work (`staffing.away`,
`staffing.back`): one-off (leave) or **regular** (every Wednesday afternoon). Both are host tables
keyed by the staff account, in no `rec_*` view; whether someone is away is known only to them and
to rosterers. A person is **eligible** for a shift when they are qualified, free and not away.
Once the business has a leave type, leave is asked for (below) and a person says other or regular
time off here; approved leave is written here as unavailability.
_Avoid_: skill, certification, availability (say when they are away)

### Leave

and **Leave balance** (stage 58, built in step 4: ADR 0853)

**Leave** is approved time off of a **leave type** the business sets (annual, personal, unpaid:
none ship), counted in hours or days. A **leave request** asks for it, for whole days or part of
one day; the host proposes each date's amount from the person's roster, they or the approver may
change it, and an approver (whoever rosters, never for their own) approves or declines it. Approved,
the person is unavailable then, is taken off the shifts it covers that have not started, and each
is offered; cancelling it gives the balance back and puts nobody back on a shift. A **balance** is
what the business says a person has of a type: the sum of a ledger of entries a pay holder sets or
adjusts and the leave approved; the host never accrues. A person sees their own requests and
balances, approvers and pay holders everyone's, other staff nothing; never an assistant.
_Avoid_: entitlement, accrual, time-off request (say leave request), holiday (say the type's name)

### Open hours

(stage 49, built in step 3: ADR 0762)

When someone takes appointments: **weekly** (every Monday 09:00 to 12:00, in local time, from a
date and until one; 22:00 to 06:00 runs overnight) or **extra** hours on a date, each for every
kind of session or for some only (assessments on Saturdays). Set by the person or a rosterer
(`staffing.hours.set`), kept by the host in no `rec_*` view, removed when they leave. A time they
are not open is time off (unavailable), never a "closed" entry.
_Avoid_: availability, slot, schedule (say open hours)

### Offer

and **Take** (stage 45, built in step 3: ADR 0623)

A shift's person **offers** it (or a rosterer offers an uncovered one), to everyone eligible or to
one named person; a qualified, free person **takes** it, with nobody approving, and rosterers are
told. Exactly one take succeeds, decided by the database. Until it is taken the shift is the
offerer's; at the **cut-off** (1 hour before by default, Rostering's setting) the offer **lapses**. An offer
is **withdrawn** by its offerer or a rosterer, and **cancelled** by the host when the shift goes to
someone else, is cancelled, removed, or its person leaves. A person's own act: never an assistant's.
_Avoid_: swap request, trade, bid

### Calendar feed

(stage 45, built in step 5: ADR 0628)

A private address, made of a revocable token, that a staff member's phone calendar subscribes to:
their own shifts only (each its kind of work, place and times), nothing of members or other staff.
The address is a secret shown once to the person who makes it, and kept only as a hash; it stops
working when they rotate or revoke it, an admin revokes it, they are deactivated, or they lose the
pack's permission. The format is the **calendar writer** (`@composable-os/calendar-file`), which
the booking email's calendar file shares.
_Avoid_: calendar sync, invite (the booking email's calendar file)

### Counted for pay

and **Pay period** (stage 45, built in step 6: ADR 0627)

A staff member is counted **by time**, **by class** or not at all, from a date (no basis: not
counted). A **pay period** (weekly, fortnightly by default, or monthly; Rostering's setting) totals,
per counted person and kind of work, the shifts and the minutes of the live shifts whose local start
date is in it, with a kind's set-up and pack-down minutes, and a shift **marked not worked**
counting nothing; each line shows its **evidence** (the class list taken, and by whom). A **locked**
period's lines never change, and neither do the shifts inside it, until it is **reopened** (with
why); locking again makes a new version. It is exported as CSV for payroll. No rates or amounts.
Read only with `rostering:pay` (admins and by grant), by a person, never an assistant. Each staff
member also sees **their own** totals and lines for a period (Rostering's `myPay`, the owner's
decision of 2026-11-24): the same figures, nothing about anyone else, never through an assistant.
_Avoid_: payroll, wages; timesheet (a person's time entries in a period, below, not the period)

### Time entry

, **Timesheet** and **Worked on** (stage 58, built in step 1: ADR 0850)

A **time entry** is one stretch of time a staff member worked: a start and a finish, unpaid break
minutes they entered, against one of their own shifts, a job (a record whose object declares
**`workedOn`**: time can be recorded against it) or nothing (**other work**). **Clocked** when they
start and finish it (the host's clock, never the phone's); **entered** when typed afterwards (up to
14 days back, never in a locked pay period). It is **open** while clocked in, then **waiting** for
an approver (approval is step 2), **approved** or **rejected**. Left open long after its shift
ends, it is marked **finish missing** and its person told; no finish is invented. Two entries of
one person never overlap, refused by the database. A person's **timesheet** for a pay period is
their time entries in it: a view, not a record. A job keeps no hours of its own: its time is the
entries against it. Personal: in no `rec_*` view, read and changed by the person, never an AI.
_Avoid_: shift (the plan, not what was worked), clock-in record, time spent

### Checklist

(stage 45, built in step 4b: ADR 0650)

A list of steps a business writes once (a close-down clean, opening up): a **template**, in
Settings → Checklists, each step required or not and maybe asking for a note. A duty picks one
(`checklist`). Each shift of it gets a **run**: the template's steps as they were when the run was
made, ticked off by the shift's person from its start until 2 hours after its end. A **tick** is
done (with a note where asked) or not done (with why). Someone who rosters may tick **on someone's
behalf**, with why: shown as "ticked by X for Y", never as the person's own. Marked **done**, a run
never changes; one not done by then is **missed**, and the rosterers are told. A **correction** is a
note someone who rosters adds beside a closed run. Read only by the run's person and people who
roster, never by other staff or an AI; templates are read by everyone.
A checklist may also be **done on its own** (ADR 0651): a **schedule** on the template (the days of
the week it is due in the business's time zone, a time it is due by, and who may do it: everyone on
staff, a role or pack role, or a grant). Each due day gets one **day's run**, open for that local
day, ticked by anyone who may do it; whoever ticks the last step **finishes** it; not finished by
the end of the day, it is missed. Those who **manage checklists** (`checklists:write`) see how each
day went and may tick for someone. Its screens are the Daily checklists pack's.
_Avoid_: task list, to-do (a task is something else), inspection, daily task

### Finance period

, **Close**, **Book entry** and **Day summary** (stage 52, steps 1 and 3 built:

ADRs 0790, 0791 and 0796)
A **finance period** is a calendar month of the business's days (local, in the organisation's
zone: a day across a clock change is 23 or 25 hours). The business **closes** each month once it has
ended and the month before is closed: its **book entries** and report rows are kept exactly as they
were (a **version**), and **reopening** it (a person, with why) keeps that version; closing again
writes the next. A book entry is one business day's summary, one payout, what is held for customers
at the month's end, or what arrived **late** for a closed month (counted in the first open month,
marked as belonging to the closed one): lines with headings in the host's words, debits equal to
credits, a key the same in every version and a fingerprint of its lines. Money is counted on the
day the host recorded it. A **day summary** is the `day` entry of one business day money moved:
money in and out through the provider against sales and refunds by kind of sale and tax by code
and country, each payment and refund shared over its order's lines in proportion; the Sales, Tax and
Refunds reports are made from the same shares. Seen with `finance:read`, closed and reopened with `finance:close`
(admins, and by grant); closing and reopening are a person's, never an AI's.
_Avoid_: ledger, journal, accounting period (accounting is stage 61's), lock (the pay period's word)

### Follows

(a state cascade)

An object whose records move when the record a relation points to moves (`states.follows`): a
class cancelled moves its bookings to `cancelled_by_us`, as the host, in the same batch (ADR 0507).
The parent is in the follower's extension or one it requires (an event's crew shifts and room uses);
a child that draws places from a pool never follows it (ADR 0841).

### Approved by a person

(a `personApproves` field or setting)

A field or extension setting only a person changes: the assistant's, an MCP client's, an
automation's or extension code's write of it waits for a person's approval (ADR 0507). A gym's
booking rules.

### Paid another way

(a spender's `waived`)

A spender created marked as paid outside the allowance (a walk-in at the desk, or a drop-in paid
by its own order): it enters its spend states spending nothing, and the mark cannot change while
it is in one (ADR 0506).

### Drop-in

(a booking paid for on its own)

One class paid for on the website by a visitor, or a member with nothing to spend (decision 8,
ADR 0560): the host makes the booking `pending`, holding a place, with its order; the verified
payment books it, the order expiring releases it. A guest's held booking is nobody's until they
pay: their address is matched to a Person only then. Cancelled in time, or by the gym, the money goes
back to the card once a person with `orders:refund` approves the refund; cancelled late or not
come, it is kept. Not the Memberships pack's drop-in pass (a pass of one, bought first and spent
by booking).

### Refund owed

What the host writes when a record an order paid for (a drop-in) is cancelled in a way that gives
the money back (`core_sellable_refund_due`): the minute cron then asks the payments gatekeeper for
the refund, which waits for a person's approval (ADR 0560). Never asked twice.

### Hold

A held claim: places taken out of a capacity while an order is unpaid. It has no clock of its own:
it lasts as long as the order is unpaid, which may be weeks for a deposit, and is released when the
order is cancelled or expires (stage 26, ADR 0432).
_Avoid_: reservation (a reservation is a booking a customer keeps), lock

### Order

What someone is buying and its state: `pending`, `part_paid`, `paid`, `cancelled`, `expired`,
`refunded`. One order has lines, each a record that is for sale with the price the host read from
it when the order started. Amounts are integers in the currency's minor unit, and every order is
in the deployment's one currency. Only a payment the provider confirmed and the gatekeeper
verified makes an order paid or part paid (ADR 0427); no operation does. A paid line grants
something (a ticket, later a pass). A base record from stage 25, with its own `order.*`
operations. With tax at checkout on, its amounts include tax: it keeps the provider's tax per
payment, per line and in total, and what is owed does not change (ADR 0479). Each paid period of a
subscription is an order too, born paid from the provider's verified invoice, with the period's
dates (ADR 0486). Its total is what is owed after its adjustments (ADR 0690).
_Avoid_: purchase, sale, booking (a booking is a place in a class), invoice (stage 35)

### Adjustment

An amount taken off an order, on one line or spread over its lines in proportion, with its kind
(`staff` today; `code`, `automatic` and `referral` with later steps of stage 34), its source (a
discount, or the person who gave it) and why (`core_order_adjustment`, ADR 0690). Each line keeps
its price and its share of the adjustments; the order's total is what is owed after them, and
the checkout, the tax shares, the deposit rule and refunds all read that net. Never changed once
given: one taken off a pending order is marked removed.
_Avoid_: coupon, rebate, discount line (it is not a line with a negative price)

### Staff discount

An adjustment a person with `orders:discount` gives on a pending order at the desk, with a
reason (`order.adjust`). Within the limit a human admin sets it applies at once; above it, and
always when an AI asks, it waits in Approvals for a human admin, and the order cannot be paid
until it is decided (ADR 0691).
_Avoid_: comp, override, markdown

### Sellable

The behaviour of an object whose records can be put on an order (stage 27, ADR 0435): its price
field, and optionally its currency, sale window, most per order, deposit and what a paid line
grants, or what a paid line moves (`sellable.moves`, ADR 0560: a record made held with its
order, moved when it is paid or expires). Only an object that declares it can be bought. The host reads every price and rule from
the record, so a caller sends none. It may also say what kind of sale it is in the finance reports
and when its money is earned (`sellable.finance`, ADR 0792: a category and `at_sale`,
`over_period`, `per_use` or `at_date`; left out, `other` and `at_sale`).
_Avoid_: product (a product is what the platform is composed into, ADR 0400), SKU

### Subscription plan

A record of a sellable object that recurs (`sellable.recurring`: every week, month or year, with
an optional trial): subscribed to, never put on an order (stage 32a, ADR 0485). Courses' plan
(`courses.plan`, a **course plan**) is the first: it gives every course (ADR 0490). A
**membership plan** (`memberships.plan`) is the second: its subscription grants a membership
(`sellable.recurring.grants`, ADR 0510).
_Avoid_: plan alone (a hosted plan), product; "recurring" for it alone (the `recurring` behaviour
is a timetable's rule, ADRs 0500 and 0860)

### Free trial

(of a subscription plan)

The free first days of a subscription, the card taken at the start and charged when it ends
unless cancelled. One per Person (the holder) per plan object, and only for a holder who proved
who they are (a signed-in customer, or staff with `subscriptions:manage` starting it for them): a
guest is charged from the start. It is used when the provider confirms a subscription opened with
the plan's trial days, not when its page is opened; a continuation's free time is not a trial
(ADR 0489). "Per Person" counts every Person sharing a **folded address** (ADR 0692).
_Avoid_: trial offer (the provider's newer feature, not used), continuation (stage 32a step 4's
free period until a paid-up date)

### Continuation offer

A person subscribed on another platform continuing here: an address (and the one Person who has
it), a subscription plan and the date they have paid up to there, imported by staff
(`cos subscriptions offers import`, a person with `subscriptions:manage`; people come in first).
Only the customer signed in as that address takes it; the subscription is then free until the
date and charged from it, with no free trial on top, and none while that subscription runs; the
continuation is not the trial, so after it has ended the one-trial rule applies. Taken once, it expires on its date (with under 48 hours left it is taken charged at
once), and staff can withdraw it. The report says who has taken theirs, so the company ends exactly
those old subscriptions (stage 32a, ADRs 0491 and 0492).
_Avoid_: trial, coupon, migration (moving card data between processors is stage 32b's option 1)

### Subscription

Something a Person pays for every period (stage 32a, ADR 0485): a base record that mirrors the
payment provider's subscription, which keeps the card and charges each period. Its states are
the provider's (`incomplete`, `trialing`, `active`, `past_due`, `unpaid`, `paused`, and the final
`expired` and `ended`), every move the host's, from a verified event. Ending at the period's end
is a flag on it, not a state. It has a **payer** (who pays, and cancels or resumes it) and a
**holder** (who what it grants is for), the same Person unless staff name another holder (a
parent paying for a child, stage 32b; ADR 0487).
_Avoid_: membership (the record a subscription grants), recurring order

### Membership

What a subscription to a membership plan grants its holder (stage 32b, ADR 0510): a record the
host makes when the provider first reports the subscription running, and moves with it, in each
verified event's batch: on trial, active, past due (for at most 30 days of failing), unpaid,
paused, ended. Its `until` is when it stops giving (the end of its last period when it is set to
end). What it allows is its plan's as it was at the start, and the new plan's once a **plan
change** takes effect. An allowance holder: unlimited, or N a week or a month, of the class types
and times its plan allows. A **pause** stops it giving anything.
_Avoid_: subscription (what is paid for; the membership is what it gives), member (a Person)

### Plan change

Moving a subscription to another plan of the same object (stage 32b, ADR 0530): dearer is an
**upgrade**, which takes effect at once, the rest of the period charged prorated and the new plan
applied only once that is paid; the same or cheaper is a **downgrade**, from the next period, with
nothing refunded. The host asks the provider and follows its verified reads; what the subscription
grants follows the plan when the change takes effect. One open change at a time.
_Avoid_: switch, swap, migration

### Pause

Staff stopping a subscription for a set time (stage 32b, ADR 0531): the provider's own pause (no
invoices, status `paused`), within the shortest and longest pause its plan allows
(`sellable.recurring.pause`); what it grants gives and spends nothing meanwhile; the provider
resumes it on its date and charges a new period. Members ask staff. Never Stripe's
`pause_collection`, which keeps a subscription active.
_Avoid_: freeze (the gym's word for it; say pause), suspend, hold (a hold is capacity's)

### Pass

(and **pass type**)

What a paid order line of a pass type grants (stage 32b, ADR 0511): a number of uses in all, of
the class types and times its type allows, valid from when it is bought for the type's days. A
**drop-in** is a pass of one. A full refund of its order voids it; uses spent stay spent. Staff
give one by hand, a person with `memberships:passes` only, with a reason.
_Avoid_: ticket (a ticket is a place at an event), credit

### Intro offer

A pass type a Person buys once, across every pass type marked so (`sellable.onePerPerson`, ADR
0512): only when they proved who they are (signed in, or staff for them), held from the order's
start so two orders at once give one, used when it is paid, given back only when the unpaid order
expires or is cancelled. "A Person" counts every Person sharing a **folded address** (ADR 0692).
_Avoid_: trial (a subscription plan's free first days), coupon, discount

### Folded address

An address with its `+tag` dropped, on every domain (`a+1@x` and `a+2@x` are both `a@x`); dots
are not folded (`a.b@x` and `ab@x` stay two). Used only to decide "the same person" for the
one-per-Person rules (a free trial, an intro offer; later a per-person code, a new-customer check
and a referral): every Person with an address folding to one of a Person's counts as them, one in
the Trash too (ADR 0692, `foldedSql` and its index, `samePeople`). Never an identity: the Person, the account
and the address mailed stay as typed.
_Avoid_: mailbox key (the sign-in code limit's and routine mail's `mailboxKey`, which also folds
Gmail's dots, for counting sends only), normalised address (trimmed and lower-cased only)

### Grant

A record the host creates when an order is first paid, one per unit of a line whose object
declares what it grants (a ticket per place), in the batch that marks the order paid or part
paid, with its fields set from the line, the item and the order and, when declared, a code. Kept
in `core_order_grant`. Refunding the order in full, or cancelling it after a deposit, moves what
it granted to its void state (stage 27, ADR 0435). A grant may be valid from when it is granted
for days its item names (`grants.valid`, a pass, ADR 0511). A subscription's grant (a membership)
is made and moved by its subscription's verified events instead, kept in
`core_subscription_grant` (ADR 0510).
_Avoid_: entitlement (a hosted plan's limits, ADR 0211), allowance (a pass's uses), fulfilment

### Code

(of a grant)

The long, random, unguessable value the host gives a granted record that asks for one (a
ticket's): read-only, unique across every grant. A QR shows only the code.
_Avoid_: ticket number, PIN

### Person's code

What identifies a Person at a check-in tablet, kept in the host: an **app code**, a rotating
8-digit code (changing every 30 seconds, good for 60) made for one sign-in of the member's app or
browser and ended with it, with one for each live dependant shown on a guardian's app; or a
**card**, a fixed long code on a card or key tag staff issue and revoke (`people:cards`), kept
only as an HMAC. Only a device tool identifies by it, and every miss answers the same "not found"
(stage 51, ADR 0783).
_Avoid_: member number, barcode (a card's code is one), ticket code (a grant's **Code**)

### Check-in PIN

Four digits a member chooses in their app to check in by their full name and the PIN when they
have no phone; kept as a slow hash, the most common ones refused, disabled after ten wrong tries in
a day until they set it again. Never set by staff or a guardian (stage 51, ADR 0783).
_Avoid_: password, passcode

### Deposit

Paying part of an order now and the balance by a date, when what is bought offers it. The amount
and the date come from the records, never from the buyer. A part-paid order keeps its place and
does not expire; past the date staff decide (stage 25, ADR 0427). With tax on, each payment (the
deposit and each part of the balance) is taxed by the provider on its own amount (ADR 0479).
_Avoid_: payment plan, instalments (nothing is scheduled or charged automatically)

### Tax at checkout

The payment provider (Stripe Tax) working out the tax inside a payment, at each line's product
tax code, from the buyer's billing address or, for an in-person event, where it is held. On only
when a human admin turns it on and the object bought declares a tax code (`sellable.tax`).
Prices include it, so what a buyer pays does not change. The host stores the provider's figure
and never calculates one (stage 42, ADR 0479).
_Avoid_: VAT, GST, sales tax (names of particular taxes), surcharge (nothing is added)

### Tax code

(of an object for sale)

The provider's product tax code an object declares (`txcd_…`, from Stripe's list), which a human
admin may override per object in Settings → Orders. Which code fits is the company's call with
its accountant.
_Avoid_: tax rate (the provider sets rates), tax class

### Guest

Someone buying without an account. Their order is placed with an email address, belongs to the
Person that address matches or creates, and is reached again with the order's token. A guest
never reads a Person (ADR 0428).
_Avoid_: anonymous buyer (the order always has an address)

### Checkout

The provider's own page a buyer pays one payment on, opened by the host for what the order may
be charged now. Card details are typed there and never reach the platform. Coming back from it
tells the host nothing: only the provider's verified event does (stage 25, ADR 0429).
_Avoid_: payment form, cart (there is no cart: an order is what is bought)

### Card reader

A device on the business's own payment account that takes a card in person: registered to the
account at its address by a person approving the action, and driven from the server (the host
puts an order's amount on it; the buyer taps or inserts their card; the provider's verified event
says it was paid, as for a checkout). Nothing of the provider's runs on the tablet, and card
details never reach the platform (stage 50, ADR 0774).
_Avoid_: terminal (Stripe's product name), card machine, POS (the till is the whole desk)

### Paid late

A payment the provider confirmed for an order that had already expired or been cancelled. It
never makes the order paid by itself: staff honour it or refund it (ADR 0429).

### Refund

Money sent back to the buyer on one of an order's payments. Staff with the refund permission ask;
a person approves it in the Approvals inbox (never an AI); the order shows it once the provider
confirms (ADR 0429).

### Event

(Ticketing)

Something tickets are sold for: a camp, a workshop, a night, with its times, its own time zone,
venue and status (draft, on sale, ended, cancelled). Its places, when set, are shared by all its ticket types (the
pool). A record of the Ticketing pack (`ticketing.event`, stage 27).
_Avoid_: class, session (a class is booked, not ticketed)

### Ticket type

(Ticketing)

One kind of ticket for an event, with its own price, places, sale window, most per order and
deposit: a package, a room type. It is what is sellable; one ticket is one person
(`ticketing.tickettype`).
_Avoid_: tier, package (as a word for the object), product

### Ticket

(Ticketing)

One person's right to attend: granted by the host, one per place, when the order is first paid,
with a code. It is its holder's (a Person): they see its event, type, code and state, and through
it their event's name, dates, zone and venue and their ticket type's name, whatever the event's
state. Valid, used
or void (`ticketing.ticket`).
_Avoid_: booking, pass (a pass grants an allowance), seat

### Check-in

Marking a ticket used at the door by its code. Accepted once: a second scan says who checked it
in and when, a void ticket and an unknown code are refused for their own reasons, and of two
scanners at the same moment one is let in (ADR 0437). A ticket whose order still has a balance
owing is let in and the balance is shown. Undone by staff.
_Avoid_: scan (the act at the scanner), redeem

### Public scope

What an object declares the public may read (ADR 0438): fields, of the records meeting a
condition on a state of the record or of the record it points to (an event while on sale; a
ticket type while its event is). Nothing is public by default, and a record that does not meet
the condition is not found. A signed-in customer reads it too. The public reaches it only through
a pack's tool (`public.list`, `public.get`), and buys only what it may read. Stage 28's
`publishable` adds being published as another condition.
_Avoid_: published (stage 28's word for a version), visible (the seam's word for any scope)

### Pack role

A fixed staff role a pack declares (ADR 0436): the permissions of its own tools and the objects of
its own an account given it may read. A human admin gives at most one to a staff account; while
it is held, it and the pack permissions granted to the account (ADR 0600) are all that account may
do, on every operation; the role's limits bind only the calls the role allows (today only, ADR
0553; only the People its holder looks after, through a pack's team, ADR 0889). It also reaches a
shipped pack's tools open to every staff account (`anyStaff`, ADR 0652: Daily checklists' today
and tick), whose host operation decides what it may do. The door role is Ticketing's.
Stage 14a's roles and teams will extend it.
_Avoid_: role (alone, it means admin, member or viewer), team, scope

### Owner's client

(stage 60, step 6 built: ADR 0872)

A client the company's mobile app may hold beside its role clients (`mobile.owner: true`,
`roles/owner.ts`): only the operations the owner's Today needs (Today, the approvals, the notice
inbox, who is signed in). Not a pack role: any staff account may sign in with it and the host
decides every call, so a coach sees only what their rights allow. A change to how the system is set
up is never approved from the app: the host refuses it on a device session ("review on a
computer"). Its hooks and words are `@composable-os/client`'s `createOwnerHooks`, shared by the
native block and the web Today.
_Avoid_: admin app, staff app, owner role

### Door role

Ticketing's pack role (`ticketing.door`): check tickets in, and read events, ticket types and
tickets. No people, orders, leads or settings.
_Avoid_: scanner role, coach role

### Permission grant

A named permission a human admin grants one staff account on top of its role (ADR 0449):
`records:publish` (a coach who is a member publishes programs), `orders:refund`, `finance:read`
(a bookkeeper), `bookingSystem:manage` (a manager who loads the booking system's lists), or a pack
tool's
permission the pack declares grantable. Read from the account on every call; it adds up with the
account's role, and with a pack role too when it is a pack's permission (a core one is refused to a
fixed role's account, ADR 0600); it never lets an AI actor do what only a person may.
_Avoid_: role (a role is admin, member or viewer), scope (an MCP token's)

### Restricted permission

A pack tool permission held by admins and by a permission grant only (ADR 0625): a member or
viewer does not hold its tools through their role, no pack role holds it, no automation or other
extension's code calls them, and nobody grants it to themselves. Rostering's `rostering:manage`.
Since stage 56 (ADR 0832) core permissions can be restricted too: `notes:clients`,
`notes:sensitive` and `notes:manage` are never granted to oneself or to a fixed role's account,
and give an AI actor nothing.
_Avoid_: admin-only (it can be granted), private

### Restricted field

A pack's text field only those holding one of its restricted permissions read (ADR 0811),
`restricted: "<pack>:<word>"`: its value is kept by the host apart from the record
(`core_restricted_value`), so it is in no `rec_*` view, list, search, export, dashboard, summary
or audit row. The record's customer, its author, writes it and reads their own; staff read it
only through the pack's own person-only tool that names the permission, every read audited.
Reviews' private feedback.
_Avoid_: private field (a document's `private` parts are another thing), hidden field (a removed
field kept for 30 days)

### Through their own records

(`customerVia`)

What a customer reads of a record one of their own records points to (ADR 0439): the fields an
object declares, of the records a record of theirs points to (a ticket's event, whatever its
state), live. Nothing of a record no record of theirs points to. Read with `my.list` and
`my.get`. Not a way to buy: a customer buys only what they read as their own or as the public.
_Avoid_: related, linked (any relation), shared (the signed-in scope's word)

### Sign-in address

The address a customer's account signs in with: the one the emailed code was sent to and
verified on (`me.get`'s `signInEmail`). The only address a company may trust to link its own
records to a customer. Not the Person's contact email, which staff can change.
_Avoid_: primary email (the Person's contact address), login

### Time zone

(field)

A `timezone` field (ADR 0460): an IANA zone name the runtime knows, the deployment's zone when a
new record leaves it empty. A record's datetimes are shown, and a date trigger with `zoneField`
counts its days, in it.
_Avoid_: offset (an offset changes with daylight saving), locale

### Signed-in scope

(`signedIn`)

What an object declares every signed-in customer may read, whoever's record it is (ADR 0447):
fields, of the records meeting a condition (a class's sessions), or of every live record (the
exercise bank). Beside a `customer` declaration it shares those records next to each customer's
own, which they still alone change; alone it opens records to read. Never the public. Read with
`my.list` and `my.get`.
_Avoid_: members (a gym's word), shared (alone, it says nothing about who)

### Document field

A field whose value is one JSON document checked against a schema its object declares, on every
write by every actor (stage 41, ADR 0445): objects, lists, text, numbers, choices, refs to records,
tagged unions. A fault is refused with its path (`layout.weeks.1.sessions.0.day`). Declared paths
are columns of the `rec_*` view; `private` parts are not read by customers or the public. Stage
28's rich text is one fixed schema of it.
_Avoid_: JSON field (any column can hold JSON), blob

### Version

(of a record)

A snapshot of a publishable record's content fields, taken when a person with `records:publish`
publishes it (ADR 0446), kept in `core_publish_version`. At most one is current: what readers are
given. The record itself is its **working copy**, which staff edit without changing any version;
restoring copies a version back into it. (An extension's working copy is its files in the
workspace: a different thing.)
_Avoid_: revision (the audit log's diffs are history, not versions), draft

### Publish

(a record)

Make a snapshot of a publishable record's working copy its current version: what readers are
given (ADR 0446). Only a person with `records:publish` publishes. An AI actor may **ask for a
publish**: its request always waits for a person who holds `records:publish` to approve it, and is
refused if the record changed since it was asked for (ADR 0480). Stage 28 adds
**scheduling** (the snapshot is taken when a person schedules, and the minute cron makes it
current at the set time) and **unpublishing** (no version is current; the versions are kept). A
record's **publish state** is read from its versions and its schedule: `draft` (never
published), `scheduled`, `published`, `unpublished` (ADR 0441). An object may publish only in
some of its states (`publishIn`, ADR 0810): leaving them unpublishes the record.
_Avoid_: go live (as a verb in code), release (a release is the platform's)

### Author

(of a publishable record)

The Person a publishable record belongs to, declared as its `customer` (ADR 0810): a review's
writer. The author reads and writes the working copy; the public reads only the published
version. The fields the author writes are **author-only**: no one on the staff side, and no AI,
changes them, so what is published is the author's words; staff publish, unpublish and move it.
_Avoid_: owner (a record's owner is a staff user), submitter

### Content

(stage 28)

Records of a publishable object the public reads: a blog post, an event page. The public reads
only the current version, by the record's **slug**, with `content.get` and `content.list` (an
object with no slug, such as reviews, is listed only, ADR 0810); a
draft, an unpublished record and an unknown slug are one not-found (ADR 0442). Its prose is
**rich text**.
_Avoid_: page (pages are code), CMS entry

### Rich text

A `richText` field: a document with the platform's one schema of blocks (paragraph, heading,
list, quote, image, divider, embed, callout, button) and inline runs with marks (bold, italic,
code, a link). Never HTML: markup and unsafe links are refused on every write (ADR 0440). Each
client renders it block by block with its own components.
_Avoid_: HTML, markdown, body (a field's name, not a type)

### Section

and **anchor** (of rich text; stage 38, ADR 0700)

A heading starts a section, which runs to the next heading; the blocks before the first heading
are a section without one. A heading's **anchor** is made from its words and its place among the
document's headings (`summer-at-the-hall`, then `summer-at-the-hall-2`; `section` for one with no
letters), by one function (`headingAnchors`, `@composable-os/sdk/rich-text`) that the host's
index and both renderers call; it is never stored. A link to `#<anchor>` lands on the heading.
_Avoid_: slug (a record's address), id (records have ids)

### Published-text index

(stage 38, ADR 0700)

The words of each record's current published version, one row per section, for
`content.search`: only content fields the public reads, of objects the public reads, written in
the batch of every publish and unpublish and caught up by the minute cron when a declaration
changes. Never the working copy. Not a `rec_*` view.
_Avoid_: search index (that is `core_search`, over working copies, for staff), FTS table

### Confirmation

(read and understood; stage 38, ADR 0702)

A staff account saying, with one tap, that it has read and understood one published version of a
record of an **acknowledged** object (one whose `publishable` declares `acknowledge`, such as a
procedure). Only the person makes it, for the current version, once; a row nobody changes
(`core_publish_ack`). Who is asked is the record's **must read**: everyone, or staff roles, pack
roles and granted pack permissions, checked on the day. A record is **to read** for a person it
asks who has no confirmation that counts.
_Avoid_: acceptance (an agreement's, a customer's), acknowledgement in prose (the declaration's
name), sign-off

### Read again

and **small fix** (stage 38, ADR 0702)

The choice a person makes when publishing a later version of an acknowledged record: **read
again** asks everyone it names to confirm this version; a **small fix** keeps their earlier
confirmations counting. The first version always asks. A confirmation counts when it is of a
version at or after the latest that asked again. An AI's publish request carries a suggestion;
the person who approves chooses.
_Avoid_: major and minor (no version numbering scheme), re-acknowledge

### Question schema

(stage 29)

The platform's one schema of a form's questions (`QUESTIONS_SCHEMA`, a document field): up to 60
items, each with a stable key, of the kinds text, email, phone, number, choice, date, rating,
yes/no and consent line, and the non-questions heading and paragraph. An item may be shown only if
one earlier choice or yes/no has a value (one level), and a question may map to the Person's name,
email or phone or to a field of the form's destination. Answers are checked against one version
(`checkAnswers`) and stored in the platform's answers schema; a fault names the question's key and
never the value. No health, signature, payment or (yet) file kind.
_Avoid_: form fields (a form's questions are not fields of an object), survey schema

### Intake

(stage 29)

The behaviour by which an object accepts records made by the public or customers through the
host's one door, `intake.submit`: a **form** (what is answered: published questions, who may
answer, when it is open), its **submission** (one set of answers to one version of a form, made only
by the host, read only by staff) and a **destination** (another pack's record a form may also make,
a Lead). Declared only by shipped packs. The one public write that is not a purchase.
_Avoid_: public create, form post

### Submitter

(stage 29)

Who sent a submission, with how sure the host is of it, its **certainty**: `account` (signed in),
`link` (a personal link), `staff` (entered by staff), `address` (an address a visitor typed,
unconfirmed, shown to staff as such). The host fills only a Person's empty fields from the answers.
An anonymous form's submission has no submitter at all.
_Avoid_: sender, respondent, lead (only for `leads.lead`)

### Form

(stage 29, the Forms pack)

Questions a business asks (`forms.form`), published as versions a person publishes: an enquiry, a
sign-up, a survey, feedback or a **staff form** (answered by staff only, an incident report). Found
by its address (slug) while it is open to the caller. Its "who may answer", anonymity and
destination count from the version published.
_Avoid_: waiver, agreement (stage 44's), survey (one kind of form, not the record)

### Submission

(stage 29, the Forms pack)

One set of answers to one version of a form (`forms.submission`), made only by the host's door, in
the Forms **inbox** with the states new, in hand, done and spam. Read by staff accounts only: never
by its submitter, a customer, the public or a pack-role account. A spam submission is moved out
only by a person (`notSpam`); an AI may only suggest spam.
_Avoid_: response, entry, lead (only for `leads.lead`), ticket (Ticketing's)

### Consent line

(stage 29)

A tick box on a form whose exact words are kept with the version. A ticked `marketing` line ("keep
me updated") marks the submission (`marketing`), set only by the host and never by staff or an AI;
the Forms pack lists them in "Asked to hear from us" until Notifications keeps a consent register.
_Avoid_: opt-in flag, subscription (a paid plan's)

### Slug

A record's address in its object (`summer-launch`): lowercase words joined by hyphens, unique
among the object's live records, made from the title when left empty. When a published record's
slug changes, the old one **redirects**: `content.get` answers with the slug it has now (ADR
0442). A deleted record's slug can be taken again.
_Avoid_: permalink, path, handle

### Import key

The name a record has in the system it was imported from (an old post's file name), kept by the
host with what the import last wrote (`record.import`, ADR 0470). A re-run of the import finds the
record by it: it updates only what the source changed, and reports a record someone changed since
as a conflict instead of overwriting it. What the import writes starts no automation and sends no
notification. (`x.programs.importText` keeps a key of its own on the program, to the same rule.)
_Avoid_: external id (a synced email's), source id

### Media

(a media item; the **media library**)

A picture staff uploaded (JPEG, PNG, GIF, WebP or AVIF, at most 10 MB, its type read from its
bytes), kept as one original in R2 with its size, dimensions and alt text (stage 28, ADR 0444).
Since stage 42 an item has a **kind**: `image`, `file` (a PDF for downloads, at most 50 MB, in R2
and served as a picture is) or `video` (below) (ADR 0475). A rich text picture and an `image`
field name one by id, and a document's ref may say which kind it takes. Staff are served any; a
customer or the public only one that published content they may read shows, in a part they may
read. Deleting one is to the Trash; the purge deletes its file, or the video from Stream.
_Avoid_: asset, upload (the act, not the thing), attachment (an email's)

### Video

(stage 42)

A media item held in Cloudflare Stream on the deployment's own account (ADR 0475): uploaded from
the staff browser straight to Stream with a one-time address (`media.videoUpload`), `uploading`,
then `processing`, then `ready` or `failed` as Stream says (`media.videoRefresh`), with caption
tracks in WebVTT. A record may name one only once it is ready (a `video` field, or a document's
ref with `media: "video"`). Nothing of it is in R2, and it plays only with a playback token.
_Avoid_: clip, stream (Stream is the service)

### Playback token

What `media.play` gives a caller the host has decided may watch one video (ADR 0476): signed by
the host with the deployment's Stream signing key, for that video only, expiring within the hour,
never allowing a download. Staff get one for any ready video; anyone else only for a video that a
published record they may read shows, in a part they may read. Every other answer is the one
not-found. The video's id alone plays nothing.
_Avoid_: signed URL (the token goes in the address; it is not the address), key

### Access

(to a record; a **holder**)

What a customer holds when one of the sources an object declares is live for them (ADR 0477): an
enrolment of theirs pointing at the course, in a state that gives access and before its `until`,
or one pointing at a bundle whose published version lists the course. "Does this customer hold
access to this record" is one question the seam asks (`holdsAccess`), for every read and for
`media.play`. The host's `subscription` kind (stage 32a, ADR 0488) was added without changing it:
a running subscription to a plan the object names gives its **holder** every live record, while
it is on trial, active or past due, and until its period's end when it is set to end. A refund in
full voids a granted enrolment, so access ends in the refund's batch. Staff hold everything; the
public nothing.
_Avoid_: entitlement (a hosted plan's limits, ADR 0211), purchase (access can be given or
imported), licence

### Course

(Courses, stage 42)

A publishable record a studio sells: a title, theme, level, description, cover, trailer, price
and its **outline**, one document of sections of **lessons**. Bought one at a time or in a
**bundle**; read by holders of access to it.
_Avoid_: class (a class is the timetable's), program (a program is Programs')

### Lesson

(Courses)

One part of a course's outline: a video and notes, a page of text, a training session from
Programs to follow, or a download. Its key names it for good (progress is kept by it); its title,
minutes and whether it is a free preview are for everyone, its material for holders only. Its
`sourceId` is the id it had on the old course platform. `cos courses import` matches a progress
row to the lesson by it (ADR 0495). It is not an import key, which names a whole record.
_Avoid_: unit, module, activity

### Bundle

(Courses)

A fixed set of courses staff choose, sold at one price. A buyer holds access to each course its
published version lists, including one added later.
_Avoid_: package, plan (a plan is a subscription's, stage 32)

### Enrolment

(Courses)

A student's access to a course or a bundle: granted by a paid order line, given by staff with a
reason, or imported; active, ended, or void (only a full refund voids one). An `until` ends it.
_Avoid_: entitlement (a hosted plan's limits), assignment (Programs'), purchase (it may be given)

### Progress

(Courses)

One student's progress on one lesson: started or done, when, and where its video was left. Written
by the student only while they hold access to the course. A course is complete when every lesson
that is not a download is done, or when it was imported as completed.
_Avoid_: completion (a course's state, read from progress), log (Programs' sets)

### Holders' part

(of a document)

A part of a document field its schema marks `holders` (ADR 0477): an object, or some keys of one
(a lesson's video and notes, while its title stays), removed from what an outsider without access
to the record reads, unless the object's `unless` key is true (a free preview). A `private` part
is removed for every outsider, holder or not. What a published version shows is kept with its
reach (all, holders, private), so a holders' video is played only to a holder.
_Avoid_: paywalled, premium, locked

### Preview

(link)

A token that lets whoever holds it read one record's working copy (the fields the public would
read) with `content.preview`, until it expires (at most 7 days). Made by staff with
`content.previewLink`; only its hash is kept; for any other record, or after its expiry, it is
not found (ADR 0443). Staff list a record's links and stop them (ADR 0444).
_Avoid_: share link, draft link

### Exercise

(Programs)

One exercise of a gym's bank: a name, a demo video, cues, theme, level, equipment, body areas,
how a set of it is measured (weight and reps, reps, time, hold), and easier and harder versions.
Every program is built from the bank; every signed-in member reads it.

### Program

(Programs)

A plan of weeks of sessions of blocks of items, stored as one layout document: a class program
(items with up to five levels), a client's own (typed sets) or an online course's sessions, all
the same object and the same schema. Publishable: coaches edit the working copy, people are given
a version.
_Avoid_: programme, plan (alone), workout

### Assignment

(Programs)

A published version of a program given to a person or to a class type from a start date. It pins
the version and has one dated session per session of the layout. Repeating a cycle is a new
assignment. A person's are theirs; a class type's are read by every signed-in member.
_Avoid_: enrolment (stage 42), subscription

### Session

(Programs)

One dated session of an assignment, carrying its plan as the assigned version had it (blocks,
items, levels, typed targets) and whether it was done or skipped. A person's **past sessions** are their
own sessions dated today or before, newest first, each with its sets done of planned. An **imported session** is one
done before the platform, brought in by `cos programs import`: done, with no assignment and no
plan, `source: import`.
_Avoid_: workout, class (a class is the timetable's, stage 31)

### Log

(Programs; a **logged set**)

One set someone did: the exercise, the item and level taken, the target from the plan and what
was done (load, reps, seconds), effort (RPE), and who recorded it (the person, or a coach for
them). One row per set: the table a gym's training data comes from. A set saved again (a retry,
a second device) changes its row; a set **taken back** (un-ticked) goes to the Trash. An imported
set (`source: import`) is one done before the platform, on an imported session.
_Avoid_: entry, result

### Session log

(Programs)

What a session screen logs through: the person's ticks and numbers, shown at once and sent to
the host by one queue per session and person, in order, retried until they land. A set nobody has
ticked or edited shows a **suggestion** (last time's numbers, or the set before's), greyed.
_Avoid_: draft, cache

### Allowance

What a pass or membership grants: a number of uses in all, a week or a month, or unlimited, for
what it may be spent on (a class type, a time of day), between its dates. Its record is a
**holder**; a record that spends one (a booking) is a **spender**. The host keeps the count and the
database refuses a use past it (ADRs 0493 and 0494). Unused uses do not carry over.
_Avoid_: entitlement (a hosted plan's limits, ADR 0211), credit (account credit is money)

### Use

(of an allowance)

One spend by a spender from a holder, counted in the holder's period containing the spender's own
time (a class's start), and given back when the spender enters a state its object declares (a
cancel in time). A late cancel or a no-show keeps it. An unlimited holder still writes one, so
attendance counts. Only the spender's own Person's holder pays; a payer who is not the holder
pays for the subscription, not the use.
_Avoid_: credit, visit (a visit is what a use may pay for)

### Skill

Instructions for an agent building on the platform: a folder in `skills/` with a `SKILL.md` (plain
Markdown, linked into `.claude/skills/` and pointed at from `AGENTS.md`), in four parts: when to
use it, the steps, the rules, the check command. It points at code and at Deals and does not copy
them. The two there are `write-extension` and `add-automations-tools-dashboards`. Skills carry the
contract version they describe (`skills/CONTRACT_VERSION`), and `pnpm lint` fails when the SDK's
differs (stage 21, ADR 0405). Not the skills a plugin bundles for the in-app assistant (ADR 0347).

### Extension check (`cos ext check`)

`cos ext check <dir>` runs on a directory, outside a deployment, what `extension.check` runs
inside one: allowed imports, the type check against the SDK, the contract, formulas, automations
and a dry-run reconcile, here against an empty local database with the core schema. Both call the
same code (`@composable-os/extension-check` for source, `checkEvaluated` in core for the
manifest), so the same source gives the same issues. `cos ext test <dir>` runs the extension's
tests and first refuses an extension with a tool or automation that no test names. In the
repository: `pnpm cos ext check packs/<id>`.
