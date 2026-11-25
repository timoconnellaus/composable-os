# ADR 0950: Two targets: Cloudflare and AWS

Status: accepted, 2026-11-26 (the owner's interview on a second target). Nothing here is built.
Designed in stages [67](../stages/67-postgres.md) to [74](../stages/74-live-screens.md), which are
proposals until each has its interview. Extends [ADR 0001](0001-self-hosted-single-org.md),
[ADR 0002](0002-d1-real-tables.md), [ADR 0006](0006-dynamic-runtime-cloudflare-computer.md),
[ADR 0014](0014-kysely-for-core-schema.md), [ADR 0163](0163-deploy-engine-over-the-cloudflare-api.md)
and [ADR 0611](0611-one-host-a-database-per-client.md). None of them is reversed: what each says
about Cloudflare stands for the Cloudflare target.

## Context
The host runs only on Cloudflare: Workers, D1, Durable Objects, Queues, Workflows, R2, the Worker
Loader. Some products cannot be put there. The case that raised it is a health product that must
keep its data at rest in Australia, on a managed relational database its operators already run.
We have not established that Cloudflare's stores can be held to Australia, and the product's own
rule keeps its data off them.

Three ways to reach AWS were weighed.

- **The same runtime on AWS** (workerd in containers, or a third-party runtime that implements the
  Workers APIs over a bucket). No code changes, and SQLite stays the only dialect. Refused: the
  first is a runtime we would operate without its maker's support for doing so; the second, when
  looked at, was a young project with one maintainer, a sandbox its own documents say is not for
  code from parties that distrust each other, and no Postgres.
- **Postgres everywhere,** including on Cloudflare. One dialect. Refused: it reverses stage 66's
  database per client, and takes D1 from the installs and clients that are well served by it.
- **A second target, written for AWS as AWS is used:** Node, Postgres, S3, a Lambda sandbox. Chosen.

A survey of the code on 2026-11-26 found what makes the third way affordable and what makes it
dear.

- `packages/core/src` imports nothing from the Workers runtime. An operation gets its database,
  files, queue, models and mail from its context (`HandlerContext`, `packages/core/src/operation.ts`).
- Core's queries are written with Kysely. Outside tests there are about 110 raw statements.
- Building a release and pushing it to Cloudflare are separate steps already.
- **Rules live in database triggers:** 360 of them in the migrations, raising about 140 named rule
  codes, which `packages/core/src/errors.ts` reads from SQLite's message text.
- **Every pack runs as sandboxed code** through the Worker Loader. With no sandbox, no pack runs.
- **Connections and the assistant are built on Durable Objects** and on RPC that passes live
  objects between Workers.
- **Core's tests seed data with SQLite statements** and run inside workerd.

## Decision
**A target is where a deployment runs.** There are two: Cloudflare, as built, and AWS. A product's
definition names its target once. Code above the target's seam is the same on both; nothing in an
operation, a pack or an extension knows which it is on.

**AWS, as AWS is used.** Node in containers, a Postgres database, S3 for files, in one region the
deployment chooses. No Workers runtime on AWS.

**Two databases, one query layer.**
- Kysely, with a Postgres dialect beside the D1 one. Statements that need a database's own
  functions (JSON, dates, upsert) go through one small module with an implementation for each.
- A Postgres set of migrations beside the SQLite set, starting from one squashed baseline. CI
  checks that the two describe the same schema.
- The rules in triggers are ported to Postgres triggers that raise the same rule codes. Each
  database has an error mapper; nothing else reads a database's message text.
- On Postgres a unit of work is one transaction that holds a lock for its client, so a client's
  writes run one at a time, as on D1. The write guards (ADRs 0550, 0623) rest on that.
- Core's test suite runs against both databases in CI.

**A schema per client in one Postgres database.** ADR 0611's rule is kept as written: no table
gains a client column, and the client exists only in the registry, in names and in key prefixes.
A client that needs a database server of its own can be given one without a code change.

**One SQL subset for dashboards and the assistant.** Pack authors and the assistant write one
query that runs on both databases. The host supplies the date helpers the subset lacks, and the
validator refuses anything outside it.

**Search by words is the database's own:** FTS5 on SQLite, Postgres full-text search on Postgres,
behind the same search operations.

**Queues, schedules and workflows on AWS are stored in Postgres,** behind interfaces of the
platform's own. On Cloudflare they stay Queues, cron triggers and Workflows.

**Files, mail, models and search by meaning on AWS:** S3, SES, Bedrock in the deployment's region,
and pgvector. Code still asks for a model role, never a model id.

**Pack and extension code on AWS runs in a Lambda function with no network access, one call per
run.** The rule that extension code has no ambient authority and reaches the world only through
host modules holds on both targets. The time a cold function adds is measured in a spike before
anything is built on it.

**AWS infrastructure is an OpenTofu module that ships with the product.** We deploy with it, and
so can anyone in an AWS account of their own. OpenTofu creates and changes the infrastructure;
`cos deploy` runs the migrations and puts a release on it, as it does on Cloudflare.

**Live updates are a host feature on both targets, for named screens only:** the ones several
people watch at once. The host tells a screen that something it shows has changed and the screen
reads again through the ordinary operation. No sync product is used.

**The whole host is to run on AWS,** in stages: records, packs and the staff app first; then the
sandbox and the deploy; then models and mail, the assistant, connections and live screens. Each
stage has its own interview.

**The build starts after stage 66 lands.** Stage 66 changes how the host opens a client's
database, which is the code stage 67 changes.

## Consequences
- **Every later stage is written and tested for two databases.** A migration is two files. A new
  trigger is two triggers. This is the standing cost of the decision, and it is why the dialect
  module, the error mappers and the two-database test run come first.
- **A pack is written once.** Its objects, tools, automations and dashboards run on both targets
  unchanged. A pack that cannot is a defect in the platform, not something the pack works around
  (ADR 0405).
- **Something built for one target only is said to be so.** Until stage 73, connections exist on
  Cloudflare only; until stage 72, the assistant does. Documents and the site describe AWS only as
  far as it is built.
- **Cloudflare installs are not changed by this.** D1, the Durable Object per client of stage 66
  and the deploy engine of ADR 0163 stay as they are.
- **The sandbox boundary differs by target and is stated for each:** a V8 isolate with no outbound
  network on Cloudflare; a Lambda function with no network on AWS.
- **"No network access" has one open reading.** Stage 69 proposes that the function may reach one
  address, the host task that called it, and nothing else, because a function with no path at all
  would need every tool to be replayable. That is stage 69's question for the owner.
- **A client's own web app has no home on AWS yet.** On Cloudflare it reaches the host through a
  binding. No stage here gives it an AWS counterpart; stage 70 asks whether the first product
  needs one.
- **Sign-in by emailed code on AWS waits for stage 73,** because the host's mail goes out through
  a gatekeeper.
- **Not yet proved:** the time a Lambda sandbox adds to a tool call and to an automation; whether
  the tests can reach Postgres from where they run today; the size of porting 360 triggers; how
  connections move, which is the hardest part and is stage 73's first question.
- **Video is undecided.** It is on Cloudflare Stream. Whether Stream can keep video at rest in a
  chosen country has not been checked. Stage 71 lays out the options.
