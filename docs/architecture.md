# Architecture

**Composable OS** is a platform for composing products on a trusted host on Cloudflare. Its first
product is the **CRM** (`products/crm/product.ts`): an AI-native CRM that each organisation deploys
to its own Cloudflare account. An AI client over MCP (such as Claude) or the in-app assistant can do
anything a user can, including reshaping the CRM itself: new objects and fields, dashboards,
automations and custom tools are **code**, written by AI, approved, versioned and run safely. The
code is FSL-1.1-ALv2 (ADR 0190; `LICENSE`, `NOTICE`), and the Composable OS site
(composableos.dev) is `apps/marketing`.

Terms are defined in [`CONTEXT.md`](../CONTEXT.md). Decisions and their reasons are in
[`docs/adr/`](adr/). Build order is in [`docs/roadmap.md`](roadmap.md). The sections below describe
what is built; what stages 21 to 28 add (customers, an HTTP surface and typed client, client apps,
behaviours, packs and blocks, skills) is designed and not built, and is in
[The platform: what stages 21 to 28 add](#the-platform-what-stages-21-to-28-add) at the end.

## Shape at a glance

```
                         ┌──────────────── one Cloudflare account = one org ────────────────┐
 Browser ── UI ────────► │  app Worker (TanStack Start + shadcn)                             │
 Claude ── MCP/OAuth ──► │   • UI routes + server functions                                  │
                         │   • /mcp  (OAuth 2.1 server → active identity adapter)            │
                         │   • operations registry  ──► approval pipeline ──► D1             │
                         │            │ service binding                                      │
                         │            ▼                                                      │
                         │  runner Worker                                                    │
                         │   • Extension workspace DO (@cloudflare/computer: files + git)    │
                         │   • Executor: Worker Loader dynamic workers, LOADER.get(stableId) │
                         │   • Workflows (long automations), Queues (record-change events)   │
                         │            │ service bindings (GATEKEEPER_*)                      │
                         │            ▼                                                      │
                         │  gatekeeper Workers (Google, Microsoft, email, Slack, MCP, …)     │
                         │   • OAuth accounts, capability APIs, actions + simulation         │
                         └─────────────────────────────┬─────────────────────────────────────┘
                                                       ▼
                                             external services
 D1 (one database) · R2 (files) · Vectorize (record embeddings) · AI Gateway → Workers AI by default / other providers optional (per model role)
```

## Layers

### 1. Deployment (trusted, changes with releases)

Everything in this repo. Each org runs its own copy ([ADR 0001](adr/0001-self-hosted-single-org.md)),
installed from a release bundle or a fork ([ADR 0012](adr/0012-distribution.md)). The deployment
owns the root of trust: identity, the approval pipeline's floor, the operations registry and the
gatekeepers.

- **`app` Worker**: TanStack Start (SSR + server functions) with shadcn/ui, plus `/mcp`.
- **`runner` Worker**: runs extension code, automations and Workflows.
- **Gatekeeper Workers**: one per external service, vendored from Cloudflare OS
  ([ADR 0007](adr/0007-integrations-are-gatekeepers.md)).

#### Distribution and updates (stage 8)

```
 tag vX.Y.Z ─► release.yml: build-release (twice, hashes compared) ─► attest ─► draft ─► smoke ─► publish
                    │ manifest generated from every wrangler.jsonc (placeholders, golden-tested)
                    ▼
 GitHub Release: composable-os-crm-X.Y.Z.tar.gz · composable-os-crm-X.Y.Z.manifest.json · SHA256SUMS · build attestation
                    │ downloaded + verified (sha256, attestation, every file vs manifest)
        ┌───────────┴─────────────┐
 npx @composable-os/cli install / cos upgrade    Settings → Updates (self-updater, optional COS_UPDATE_TOKEN)
        └───────────┬─────────────┘
          packages/release: Cloudflare REST API (no wrangler) — provision, migrate, stage versions,
          switch all Workers, smoke-check; bookmark + restore for rollback
```

- **Release bundle** ([ADR 0160](adr/0160-release-manifest-and-bundle.md)): `scripts/release`
  builds every Worker with wrangler's dry run, cos-app's assets and the migrations into one
  reproducible tar.gz; the manifest is generated from the wrangler configs, with `$ACCOUNT_ID`,
  `$HOSTNAME`, `$SECRET(…)`, `$WORKER_NAME(…)` and resource placeholders.
- **Versions and channels** ([ADR 0161](adr/0161-versions-channels-and-release-workflow.md)):
  semver, stable and beta; the changelog is generated from PR titles.
- **Verification** ([ADR 0162](adr/0162-release-verification.md)): SHA256SUMS plus GitHub's
  attestation store; `gh attestation verify` in the CLI when available.
- **Deploy engine** ([ADR 0163](adr/0163-deploy-engine-over-the-cloudflare-api.md)) and the
  **create-composable-os** CLI ([ADR 0165](adr/0165-installer-cli-and-deployment-state.md)); installer choices
  live in D1 (`core_install`) so every later deploy matches. One of them is an optional
  **location hint** ([ADR 0580](adr/0580-a-location-hint-on-new-installs.md); `--location`, or
  `location` in a client's `product.ts`), sent only when the D1 database and R2 buckets are
  created: a preference Cloudflare follows best effort, never applied to a store that exists.
- **Self-updater** ([ADR 0054](adr/0054-self-updater.md), [ADR 0164](adr/0164-update-procedure-preflight-and-rollback.md)):
  `update.*` operations (human admins) behind an `UpdaterRuntime` port; preflight blocks an
  update that would break a runtime extension; history and bookmarks in `core_update_runs`.
- **Setup wizard** ([ADR 0167](adr/0167-first-run-setup-wizard.md)): `/setup` on the first admin
  visit; `setup.*` and `sample.*` operations.
- **No telemetry** ([ADR 0166](adr/0166-no-telemetry.md)). Real-account CI:
  [ADR 0168](adr/0168-real-account-install-test.md).

### 2. Operations registry (the one API)

Every thing a user or AI can do is an **operation** defined once in `packages/core`: name, zod input
and output, description (written for a model), required permission, and **risk class**
([ADR 0003](adr/0003-operations-registry.md)). Each operation is exposed three ways from that single
definition:

| Surface | Consumer |
| --- | --- |
| TanStack Start server function | the UI |
| MCP tool | Claude and other MCP clients |
| host module (`codemode:ops`) | extension code in dynamic workers |

Every call passes through the **approval pipeline** before it takes effect. In code that is
`invoke()` in `packages/core` (ADR 0018): validate → gate → role check → handler → one D1 batch
holding the handler's writes, timeline activities and the audit row with field diffs. Handlers
read with Kysely and queue writes; list operations take filter JSON validated against the **field
registry** and compiled to parameterised SQL. `packages/core/README.md` shows how to add one.

### 3. Data

One **D1** database per deployment, with real tables ([ADR 0002](adr/0002-d1-real-tables.md)).

- **Core schema** (`core_*` tables): our versioned migrations, applied on deploy or upgrade. It covers
  the minimal core objects (People, Organisations, Activities, Tasks), users, settings, the approval
  queue and the audit log. Deletes are soft (Trash); a daily cron trigger on `cos-app` purges
  people, organisations, activities and tasks after 30 days through the operations pipeline
  (`trash.purge`), and admin erase redacts the append-only audit log through a sanctioned path
  ([ADR 0019](adr/0019-audit-redaction-for-erasure.md)).
- **Duplicates** ([ADR 0247](adr/0247-duplicate-rules-and-scan.md)): plain rules in code with a
  stated reason, no score. Every write that sets a name writes `name_key`, so `duplicate.check` at
  creation and the scan are indexed lookups. cos-runner's minute cron runs a bounded
  `duplicate.scan`: the one-off name-key backfill, a full scan in progress, the nightly incremental
  scan (records changed since a cursor) and the scan after an import. Pairs live in
  `core_duplicate_pair`; dismissals are kept. `duplicate.mergeMany` calls `person.merge` or
  `organisation.merge` once per duplicate, and merge re-points extension relation fields
  generically.
- **Erase reaches every store** ([ADR 0320](adr/0320-erase-reaches-every-store.md)): besides the
  record and the audit log, an erase scrubs or deletes shared activities, pending actions, AI
  summaries and vectors, assistant threads, sync's suggestions and signatures, extension
  data (generically, through relation metadata), automation run history, notifications,
  integration events and the outbox, duplicate pairs, and the R2 bodies of synced email (through
  `core_blob_deletion`, drained after the commit and by the 10-minute cron). Erased people's
  addresses go on the **erased-address list** (`core_erased_address`, SHA-256 hashes only), which
  `sync.ingest` checks so they are not collected again. Each erase writes an **erase log** entry
  (hashes) to R2, outside D1, and `erasure.reapply` re-applies erasures after a restore. AI
  Gateway calls turn payload logging off (self-hosted Workers AI too, over REST, ADR 0330), and
  errors reach Workers Logs masked (`errorForLog`). An organisation erase drops a shared email's
  body only when no person is left linked to it; otherwise it scrubs the organisation's terms
  from it (ADR 0320 amendment). A person erase ends every subscription the Person pays for or
  holds as a member's own deletion does ([ADR 0649](adr/0649-erase-ends-a-subscription-at-the-end-of-the-period-paid-for.md),
  issue #293, `subscriptions/erase.ts`): before its batch commits it asks the provider to end one
  still running when the period already paid for ends, and one paused, unpaid or waiting for its
  first payment at once; nothing is refunded or charged, and the record moves with the provider's
  events. The admins are told of one it could not ask and of one another live Person is on. A
  checkout the provider confirms after the erase makes nothing and is asked to end the same way.
- **Storage retention** ([ADR 0090](adr/0090-storage-retention.md)): D1 stops at 10 GB, so the same
  cron keeps growth bounded. Successful reads by AI, extensions and automations are counted per
  hour (`core_audit_read_counts`) rather than audited row by row. Write audits are kept forever by
  default; an admin can choose 1, 2 or 7 years, and `audit.purge` then deletes older rows through
  a second sanctioned path (purge markers). Run history goes after 30 days (failures 90), decided
  pending actions are compacted to a summary after 30 days, and Settings → Storage shows the
  database size against the cap.
- **Extension schema** (`x_<extension>_*` tables): declared in extension code (`defineObject`) and
  reconciled into D1 by the host, additive-first. Core migrations never touch `x_` tables.
- **`rec_*` views**: generated read views, one per object (`rec_person`, `rec_organisation`, …;
  ADR 0015 amendment). They are what list operations, dashboard SQL and AI queries run against. Since migration 0020 the person,
  organisation, activity and task views are owned by the schema reconciler: core migrations change
  their `core_base_*` views, and the reconciler regenerates `rec_*` over them with extension side
  tables and formulas joined in. Extension objects read through `rec_x_<ext>_<object>`.
- **R2** holds attachments (and, later, large imports: stage-1 CSV imports arrive inline,
  [ADR 0020](adr/0020-query-sql-validator-and-csv-import.md)).

Core migrations are plain SQL in `packages/db/migrations`. Both Workers point their `DB` binding's
`migrations_dir` there, so `wrangler d1 migrations apply` and the in-code runner (`applyMigrations`,
used by tests and upgrades) share one bookkeeping table, `core_migrations`. Each migration also
bumps `core_meta.schema_version`, which `/api/health` compares with the version the code expects.
Typed access to core tables uses Kysely ([ADR 0014](adr/0014-kysely-for-core-schema.md)).

### 4. Extensions (the AI-built layer)

An **extension** is code against one contract (`packages/sdk`): `defineObject`, `defineView` /
`defineDashboard`, `defineAutomation`, `defineTool` ([ADR 0005](adr/0005-extensions.md)).

- **Shipped extensions** are packs: they live in `packs/` and ship with the releases of the products
  that list them (stage 24). Deals/Pipelines is the first;
  Leads is the second business extension and depends on it. `lifecycle` is shipped but opt-in
  (`composableOs.optional` in its `package.json`): an admin installs it from Settings → Extensions.
- **Runtime extensions** are written by Claude in-app or via MCP. They are stored in an
  `@cloudflare/computer` Workspace (a Durable Object filesystem with git), approved as a diff, and
  rolled back by reverting ([ADR 0006](adr/0006-dynamic-runtime-cloudflare-computer.md)).

Extension code runs in Worker Loader dynamic workers with **no network** (`globalOutbound: null`).
It can reach only the host modules it is given: CRM operations, the AI model roles, and enabled
gatekeepers.

How stage 3a built it ([ADR 0040](adr/0040-extension-runtime-build.md)):

- **Contract**: `defineExtension({ id, version, contractVersion, permissions, objects, fields,
  views, tools, automations })` in `packages/sdk`, with every field type and a typed formula
  language compiled to SQLite (`@composable-os/sdk/formula`). See `packages/sdk/README.md`.
- **Reconciler** (`packages/core/src/extensions/reconciler.ts`): manifest → ordered DDL over
  `x_<ext>_<object>` tables and 1:1 side tables `x_<ext>_<target>`, plus regenerated `rec_*` views,
  dry-run by `extension.check` and applied atomically by `extension.install`.
- **Registry**: extension objects and fields join the field registry (refreshed per invocation), so
  `record.*` operations, filters, saved views, search, CSV export and history work for them. Tools
  are operations `x.<ext>.<tool>`.
- **Runtime** (`apps/runner/src/extensions/`, `apps/runner/src/executor/`,
  [ADR 0043](adr/0043-extension-executor-and-stable-loader-ids.md)):
  - **The workspace.** The `ExtensionWorkspace` DO holds each extension's source in its own git
    repo, plus the build cache. It runs no code.
  - **Builds.** A build is a transpile, an import check and a TypeScript type check against
    `@composable-os/sdk`'s declarations. The type check runs in its own Dynamic Worker. Builds are cached by
    a content hash of the source.
  - **The executor.** It runs from cos-runner's stateless entrypoint, so runs execute in parallel.
    Tool and manifest workers come from `LOADER.get(stableId)`: the id hashes the extension,
    commit, host modules, SDK and runtime. Only Code Mode uses `load()`.
  - **Per-run context.** Each call gets its context as RPC arguments, including a per-run host
    `RpcTarget` serving the declared `codemode:ops`, `codemode:storage`, `codemode:log` and
    `codemode:ai` modules.
  - **Principal.** Code acts as `extension:<id>` (actor `extension`) within its declared
    permissions.
  - **Failures.** Runs are recorded. 3 consecutive failures quarantine an extension. Rollback
    reinstalls an earlier commit.
- **Shipped extensions** (`packs/<id>/`; Deals is the first) are bundled as source at build time,
  the packs the product lists and only those, and installed through the same `extension.install`
  path at boot. A pack's `client/` and `blocks/` are client code and are not bundled.
- **Leads** ([ADR 0246](adr/0246-leads-as-an-extension-and-assignment-rules-in-core.md)) is built on
  the public contract like Deals. A relation to `deals.deal` refuses the install where Deals is
  missing. Conversion is a tool making several CRM calls, written to be run again. The contract
  keys it added are general: `owner`, `navigationOrder`, `requireOneOf`, `titleDefault`, field
  `default`, `defaultSetting` and `editableOptions`, tool `recordAction`, automation `enabled`.
- **Assignment rules** (`packages/core/src/assignment`, ADR 0246) are core, because they apply to
  people and organisations too and must set the owner in the create's own insert. Every create path
  calls `assignOwner` in its handler. A round-robin rule's state is read there and advanced in the
  same batch by a guarded write; if another create moved it, the batch fails and the pipeline runs
  the call again, so rotation is exact.
- **Stage behaviour** ([ADR 0100](adr/0100-stage-behaviour-and-object-contract-additions.md)):
  an object's declarative `stages` key is enforced by the host inside `record.create`,
  `record.update` and `import.records.commit` (`packages/core/src/records/stages.ts`): stage rules
  (a `StageRuleError` naming the missing fields), default stage and pipeline, probability,
  status and won/lost date, `core_transition_history` rows (read as `rec_stage_history`) and
  "Moved to <stage>" timeline posts on the record and its `timelineLinks`. Since stage 25 it runs
  on the transition engine it shares with `states` (see Behaviours,
  [ADR 0425](adr/0425-one-transition-engine-for-stages-and-states.md)). The reconciler also
  creates declared `indexes` (partial, live rows) and inserts `seed` records once.
- **UI**: generic list and record pages at `/x/<ext>.<object>` (with CSV import and export),
  field widgets for every type, extension fields on core record pages, Settings → Extensions, set-up
  objects (`navigation: "settings"`, e.g. pipelines) under Settings, and Settings → General (the
  base currency, [ADR 0101](adr/0101-base-currency.md)).
- **Shipped views and dashboards** ([ADR 0103](adr/0103-shipped-views-dashboards-and-relative-filters.md)):
  `view.list` adds active extensions' `views` (read-only, `vw_x_…`) and `dashboard.*` their
  `dashboards` (read-only, `dsh_x_…`); an extension dashboard marked `home` is the default Home.
  Filter values `{ $relative }` resolve in the pipeline per call. Boards group by a select or by a
  relation (a deal's stage, columns in stage order).

How stage 3b added authoring ([ADR 0041](adr/0041-extension-authoring-and-proposals.md)):

```
 MCP client ── extension.write ──► working copy (/extensions/<id>/, uncommitted)
            ── extension.check ──► evaluate + typecheck + contract + formulas + dry-run reconcile
            ── extension.propose ─► commit ─► check ─► diff + host-computed impact (+ build-role
                                    summary) ─► pending action `extension.apply` (risk extension)
 Approvals inbox ── approve ──► approval.approve re-runs extension.apply as the proposer
                                 └─► installExtension: DDL + state + audit + pending status, one batch
```

- `extension.apply` is `alwaysReview`: whatever the actor or preset, it is queued, so a version
  that widens permissions never auto-applies. Approving one needs an admin (`extensions:manage`).
  `extension.approve` / `extension.reject` are the same decision as the inbox, for one proposal.
- The review detail (diff, impact, check, AI summary) is stored by proposal in
  `core_extension_proposals` (migration 0030) and shown on the approval screen.
- Shipped extensions can be extended from another extension but not written in place;
  `extension.eject` copies one into the working copy, and its approved proposal turns it into a
  runtime extension that releases no longer update.
- **Code Mode** ([ADR 0042](adr/0042-code-mode.md)): the MCP `code` tool (operation `code.run`)
  runs a client model's script in a throwaway Dynamic Worker as the connected user's `mcp` actor.
  - **Calls.** Each `ops.call` goes through the pipeline with that user's role, scopes and
    session, so gates, pending actions and simulated reads behave exactly as for tool calls.
  - **Limits.** It needs `records:write`. It runs one script per user at a time and is rate
    limited per user (ADR 0043).

How stage 5 runs automations ([ADR 0130](adr/0130-automation-runtime.md), test mode
[ADR 0133](adr/0133-automation-test-mode.md)):

```
 operation batch (change + outbox row, ADR 0171) ─► after commit: EventSink (≤100 changes/message,
   one sendBatch per operation, origin-tagged), outbox row deleted on success
   ─► Queue cos-automation-events ─► cos-runner queue() ─► dispatchAutomationMessages
        TriggerSource per message kind (record, approval, integration)
        ─► rails: kill switch, depth ≤ 3, cycle, bulk, debounce, conditions, fan-out, rate limits
        ─► run row (INSERT … ON CONFLICT DO NOTHING on the Workflow id) ─► createBatch
 cos-runner cron (* * * * *) ─► schedules in the automation timezone, daily date-relative scan
                                (and every minute, date-relative triggers in minutes, ADR 0570;
                                runs held back by the runs-per-minute rail, ADR 0573),
        outbox retry (rows left by failed sends, dispatched directly), integration events
        (unconsumed core_integration_event rows → webhook / syncEvent triggers, ADR 0173)
 AutomationWorkflow: start ─► advance:<n> (executor.runAutomation via LOADER.get) ─► sleep / wait
        ─► review pause (waitForEvent approval-<actionId>) ─► finish (counters, history)
```

- **Registry.** `extension.install` syncs `core_automations` from the manifest; the consumer and
  cron load enabled automations through `core_automations_trigger_idx`.
- **Replay.** Each advance replays the extension's `run` with the journal of finished steps in the
  extension's tool worker; one new `step.do` runs per advance, sleeps and waits are Workflow
  sleeps and waits. Steps act as actor `automation` under the extension principal, with cascade
  tags on their origin.
- **Review pause.** A gated write becomes a pending action in one change set per run; the
  Workflow waits for the decision (approval resumes, rejection follows `onRejected`, expiry ends
  the run `expired`).
- **Test mode.** One executor call with `InvocationContext.simulate`: gates recorded, writes
  dry-run into an in-memory overlay, nothing written, no events. A proposed automation is tested
  at its proposed commit with `proposal { actionId, key }` (stage 7b; report not stored).
- **Operations.** `automation.list/get/test/enable/disable/runs/run/retry/replay/cancel/explain/
  killSwitch/settings/updateSettings` (`packages/core/src/operations/automation.ts`); cos-app
  reaches the runner's `AutomationHost` RPC for test, run, retry, replay and cancel.
- **History.** `core_automation_runs` and `core_automation_run_records`, purged by the daily cron
  (30 days, failed 90).
- **Run-as** ([ADR 0170](adr/0170-automation-run-as-bindings.md)). Automations that declare
  `connections` wait until a person binds each to a connection (`automation.bindConnection`,
  `core_automation_binding`, the consent). In a run, `codemode:<gatekeeper>` resolves the slot to the
  bound connection and calls it as the connection's owner; a pending outbound action pauses the run
  like a gated write. Disconnecting, expired credentials or `user.deactivate` revoke the bindings,
  pause the automations and notify the admins.

### 5. Integrations

All external access goes through **gatekeepers**: reviewed Workers in the repo that own OAuth, expose
a capability API per resource, journal actions and simulate pending ones. We adopt Cloudflare OS's
gatekeeper interface and `gatekeeper-kit` rather than inventing our own. Extension code never reaches
the network directly. `gatekeeper-mcp` lets an admin connect any MCP server at runtime.

Stage 6a ([ADR 0110](adr/0110-integration-host-per-connection.md) to
[ADR 0114](adr/0114-own-gatekeepers-pickers-and-host-modules.md)):

- **Integration host**: one Durable Object per **connection** in `cos-runner`
  (`INTEGRATION_HOST.getByName(connectionId)`). It holds the gatekeeper account, one facet per bound
  resource (recreated from its stored class stub after a restart), hook controllers and sync state.
  D1 (`core_integration_connection`) mirrors connections for the UI. Operations reach it through the
  `IntegrationRuntime` port (`packages/core/src/integrations/runtime.ts`), over RPC from `cos-app`.
- **Connect flow**: `connection.create` → provider popup → `/gatekeeper/<vendor>/*` (proxied by
  `cos-app` to the gatekeeper through `cos-runner`) → `/connect/handoff#ticket` →
  `connection.completeConnect`, which activates the account only for the user who started the flow
  and the popup's nonce.
- **Outbound actions**: a gatekeeper's `submitAction` is gated as risk `outbound` by action kind and
  mirrored into the approval queue; approval calls `applyAction` on the facet, in order per facet.
- **Sync**: hook-driven, alarm-chunked mail and calendar sync per connection (90 days by default),
  written by `sync.ingest` with an indexed external key, bodies in R2 (`cos-blobs`), sharing level per
  connection, private activities, suggested contacts and job-change suggestions.
- **Code**: `integration.call` (MCP), and `codemode:<gatekeeper>` host modules for extension tools and
  Code Mode.
- **Routine mail** ([ADR 0590](adr/0590-routine-mail.md)): a shipped pack declares fixed member
  emails (`routineMail` in its manifest: kinds about its records, words with slots the host fills);
  its automations ask for one with `codemode:routine-mail` naming a kind and a record. The host
  (`packages/core/src/routine-mail/`) checks the caller is a shipped extension's automation run,
  chooses the recipients from the record (its customer Person, their live guardians, a paid
  order's own address), fills and checks every value, holds anything unusual for a person (a link
  in a name, over 20 a day to one address, an AI's unapproved change, a replay), and
  writes one `core_routine_mail` row per recipient; the integration host's `sendRoutineMail` sends
  a row's own words through the automation's bound email-send connection, whose `email.routine`
  kind the gate applies without review under Balanced and Autonomous (Cautious and the deploy floor
  still hold it). Off for each pack until a human admin turns it on (until then its emails are
  ordinary sends). Default deny: every write the pipeline records also writes, in its batch, a
  mark per field (`core_value_mark`: who stands behind that value, with its hash; a Person's
  addresses one by one, and which is primary), a copy carrying its sources' marks; an email is
  routine only when every value its own words and calendar file show, every relation followed to
  them (an `each` slot's lines included), the record, and its own address have a person's (or a
  default's) mark for the value they have now, and approving a held email marks exactly what that
  email showed. A shipped pack's tool a person runs writes as the host except the values they gave
  it; a runtime extension's tool or automation, a run that used a model or read outside text, and a
  tool called by such a run write as an AI. The daily caps (20 per mailbox, 2,000 for the
  organisation) are counted where a row is claimed. Each kind has a human admin's switch (Settings →
  Routine email), with the log, kept 12 months by default.
- **Gatekeepers we wrote**: `gatekeeper-email-send`, `gatekeeper-slack-post`, `gatekeeper-webhook`.
  `gatekeeper-accounting` (stage 61, ADR 0880) is the **accounting contract** every accounting
  gatekeeper serves, not a gatekeeper of its own: the session's types and input checks, the shared
  facet (`AccountingGatekeeper`, which applies each write once by the host's reference, refuses
  another currency and a locked day, and voids only the host's own documents), the fake books and
  the conformance suite. The fake books run as `cos-gatekeeper-accounting-fake` in development and
  cos-runner's tests only (`wrangler.fake.jsonc`, never released); the catalogue marks an
  accounting gatekeeper `implements: "accounting"`.
  Inbound webhooks and sync events land in `core_integration_event`; cos-runner's cron turns them
  into `webhook` and `syncEvent` automation triggers (ADR 0173), dropping private activities.
- **Notification delivery** ([ADR 0172](adr/0172-notification-delivery.md)): cos-runner's minute
  cron reads new `core_notifications` rows behind a 30 s lag through a keyset cursor and sends each
  to the email/Slack channels its recipient chose, escalates unread approval notices and sends the
  daily digest ([ADR 0206](adr/0206-daily-digest.md)): changes others made to my records (read once
  a tick through `core_audit_at_idx`), tasks due, approvals waiting and unread notices, as an
  in-app `digest` notification (on by default) and by email when asked for. Every send is claimed in `core_notification_delivery` first and goes through the
  integration host as a system outbound action on the admin-chosen org email-send / Slack
  connection, gated like any outbound action. The automation consumer also posts admin channel
  routes for record events, once per event, route and record.

### 6. Approval pipeline

Configurable per org ([ADR 0011](adr/0011-approval-pipeline.md)):

1. **Deterministic gate** (code): actor × risk class → `auto` / `deny` / `review`, never below the
   deploy-time floor.
2. **Policy adjudicator** (optional): a second LLM (the `review` model role) or Jev (the judge) judges the
   simulated change against the org's written policy → approve / deny / escalate.
3. **Human queue**: escalations, with the adjudicator's reasoning attached.

Only human admins can change the policy. Every decision is audited.

The human queue is built (stage 2, [ADR 0022](adr/0022-approval-queue-and-simulation.md),
[ADR 0032](adr/0032-mcp-sessions-and-approval-mechanics.md)); the policy adjudicator in stage 7b
([ADR 0204](adr/0204-policy-adjudicator.md)), described at the end of this section.
A `review` decision dry-runs the operation and records a **pending action** (diff preview,
simulated result, dependencies, the agent's reason) in a **change set**, then returns
`pending_approval`. The dry run causes no real effect (`approvals/dry-run.ts`, ADR 0022 amendment
of 2026-11-22, which lists exactly what is and is not covered): the handler's database handle runs
only single reads, every other runtime on its context answers only its read methods (anything else
queues the call as "runs on approval"), an operation it runs through `pipeline.invoke` is
simulated over its own overlay and joins the preview, and an extension tool that may write is not
run at all until it is approved (the inbox shows the tool and its inputs instead of a diff). A
read tool's sandbox can only read. The originating MCP session's reads (`get`, `list`, `search.global`,
`activity.listForRecord`) see its pending actions applied, with **provisional IDs** for creates;
everyone else reads real data. A person approves or rejects (`approval.approve` / `reject`):
approval re-runs each action through the pipeline as the original actor, binding provisional to
real ids, and fails an action cleanly if its record changed or was deleted meanwhile. Rejection
cascades to dependents; pending actions expire after `APPROVAL_EXPIRY_DAYS` (default 7).
People review in the **Approvals inbox** (`/approvals`: change sets with readable diffs, approve or
reject whole or per item), with a count in the sidebar and **pending-change badges** on record
headers and list rows (`approval.pendingForRecord`). An erase also scrubs pending actions that
mention the erased record (ADR 0032 amendment).

**Policy adjudicator** (stage 7b, [ADR 0031](adr/0031-policy-adjudicator.md),
[ADR 0204](adr/0204-policy-adjudicator.md)). Admins set its mode (`off` / `shadow` / `active`,
core_settings `adjudicator`), a confidence threshold and the **written policy**
(`core_written_policy`, versioned and hashed) under Settings → Policy adjudicator, all through
human-only `adjudicator.*` operations. The pipeline records on each pending action *why* it went to
review (`review_source`: the preset, the floor, `alwaysReview`, or a pending dependency) and, after
the review batch commits, calls the context's `onQueued` hook; cos-app's runs the adjudicator in
the background (`waitUntil`), so the caller gets `pending_approval` exactly as before, and the
10-minute cron sweeps up anything missed (cos-runner's queued actions included). With the mode off
that is one settings read and no writes. Its reviewer is Jev while the judge has a key (below,
[ADR 0233](adr/0233-jev-policy-reviewer.md)), else the LLM. The LLM reviewer asks the `review` role in JSON mode, with
the policy and instructions as the system message and the change as fenced, escaped data
(`reviewPendingItem`, through the `Reviewer` interface), validates the reply with zod (one repair round; invalid, empty or cut off →
`escalate`, confidence 0), and stores one verdict per action in `core_adjudication` with an
`adjudicator.verdict` audit row. In shadow mode that is all. In active mode a valid `approve` at or
above the threshold, for an action the preset (or a dependency) routed to review, whose risk is not
outbound, schema or extension and whose dependencies are applied, is applied through the approval
machinery as the original actor with `decided_by = adjudicator`; every other verdict, `deny`
included, stays pending for a person with the reason shown. Verdicts appear beside each item in the
Approvals inbox for people who may approve, and never in what `approval.*` or `audit.list` return
to the assistant, MCP clients, automations or extensions. `adjudicator.agreement` (Settings) reports
the agreement rate against people's decisions.

### MCP

`/mcp` on `cos-app` ([ADR 0021](adr/0021-mcp-surface.md), ADR 0032): `workers-oauth-provider`
wraps the Worker (OAuth 2.1, dynamic client registration, PKCE, one-hour access tokens and
30-day refresh tokens in the `OAUTH_KV` namespace). `/oauth/consent` signs the user in through
the identity adapter and grants scopes `read`, `write` and (admins only) `admin`; effective
permission is role ∩ scopes. Each authorization is a **connected app** (`core_connected_app`),
which is also the MCP session; revoking it stops its tokens at once. `/mcp` is the Agents SDK's
stateless Streamable HTTP handler with an MCP SDK v2 server per request
(`apps/app/src/server/mcp/`): curated tools (operations flagged `mcp: { curated: true }`),
`describe_operations` / `call_operation` for every other MCP-exposed operation, the
`crm://schema` resource and server instructions. Calls run as actor `mcp` with origin
`{ surface: "mcp", clientId, clientName, sessionId }`, rate-limited per connected app. See
[`docs/mcp.md`](mcp.md).

### 7. Identity

A deploy-time **identity adapter** ([ADR 0008](adr/0008-identity-adapters.md)): Better Auth (the
default) or Cloudflare Access, selected by env var. The MCP OAuth 2.1 server sits on top and delegates
login to the active adapter. Identity is never runtime-pluggable.

In `cos-app`, one TanStack Start request middleware resolves the **Principal** for every page
route, server route and server function call. Everything is private by default: only `/sign-in`,
`/api/health`, the adapter's own routes (`/api/auth/*`) and server functions in `*.public.ts` files
are reachable without one. The OAuth routes (`/oauth/*`, `/.well-known/oauth-*`) and `/mcp`
are handled before TanStack Start by the OAuth provider, which checks Bearer tokens itself. A request without a Principal is redirected to sign-in (pages, Better
Auth) or gets a 401 (APIs, server functions, and any request under Cloudflare Access).

**Staff accounts and invites** ([ADR 0455](adr/0455-staff-invites-and-native-sign-in-by-tokens.md)).
Sign-up stays closed after the first user (`AUTH_ALLOW_SIGNUP=false`). A human admin invites a
person by address on Settings → Users (`user.invite`, not on MCP), with the role, pack role and
grants the account will hold. With Better Auth, they accept by signing in with a code the host
emails to that address (Better Auth's email OTP plugin, two of its routes served); the account is
made in one insert with what the invite says, and an invite never applies to an account that
exists. Under Cloudflare Access, Access decides who gets in and the invite is accepted on the
person's first request. The host sends staff mail itself, on the one connection chosen for the
host's mail. A code goes only to a verified address; a staff member confirms their own (the first
admin's password sign-up leaves it unconfirmed) with a code sent to it (`user.confirmEmail`,
ADR 0457). A native app's or a command-line tool's browser sign-in (`/native/staff-sign-in`) shows
a confirm page and hands its code over only on the confirmed, same-origin POST. Deactivating an
account ends its cookie and device sessions. Which paths a host
behind Access keeps behind it and which it bypasses is `apps/app/src/server/access-layout.ts`,
held to the route table by `apps/app/test-node/access-layout.test.ts` (`docs/deploying.md`,
"Cloudflare Access").

### 8. AI

**Model roles** (`build`, `assistant.core`, `assistant.subagent`, `summarise`, `extract`,
`classify`, `embed`, `vision`, `review`, `transcribe`, `speak`, `dictation.cleanup`; the
assistant, speech and dictation roles from stage 17, [ADR 0351](adr/0351-assistant-model-roles.md)) map to a provider and model in the core **model role registry**
(`packages/core/src/ai/roles.ts`, [ADR 0009](adr/0009-model-roles.md),
[ADR 0150](adr/0150-model-role-registry-and-ai-sdk.md)). Code asks for a role, never a model.

```
 operation ── ctx.models.run("summarise", …) ──► registry: shipped (Workers AI) → AI_MODEL_ROLES → Settings → AI
                                                    │ capability check (tools, JSON, context, vision, embeddings)
                                                    ▼
                                AI SDK ── @ai-sdk/openai-compatible ── api.cloudflare.com/…/ai/v1 + cf-aig-gateway-id ──► AI Gateway ─► Workers AI
                                            (AI_GATEWAY_REST: cf-aig-metadata: role; cf-aig-collect-log-payload: false; token: AI Gateway Run + Workers AI Read)
                                       └─ without AI_GATEWAY_REST: workers-ai-provider ── AI binding, gateway: { id, metadata: { role } } ──► AI Gateway ─► Workers AI
                                       └─ @ai-sdk/openai-compatible ── …/{gateway}/compat, model "provider/model" ─► AI Gateway ─► provider
                                            (cf-aig-metadata: role, cf-aig-authorization; BYOK: no Authorization)
                                          no gateway (--ai-gateway off): binding without the option; provider's own URL
 hosted (AI_PLATFORM_GATEWAY_ID set):
   Workers AI roles = Platform AI ── @ai-sdk/openai-compatible ── api.cloudflare.com/…/ai/v1 + cf-aig-gateway-id ─► shared platform gateway ─► Workers AI
                                       (cf-aig-metadata: role, tenant, plan; cf-aig-collect-log-payload: false; cf-aig-skip-cache)
   own keys (AI_KEY_<P> secrets) ─────── provider's own URL, or the customer's own gateway (AI_CUSTOMER_GATEWAY)
```

- **The registry** resolves each role through shipped defaults (every role on Workers AI),
  deploy config (`AI_MODEL_ROLES`) and admin overrides (`core_settings.ai_settings`), rejecting
  models without the role's capabilities, with one fallback per role. cos-app passes the runner to
  operations as `ctx.models`; cos-runner uses the same registry for `codemode:ai` and proposal
  summaries. Every call goes through AI Gateway when `AI_GATEWAY_ID` is set, tagged with its role;
  the installer and the updater create a gateway per deployment and set it
  ([ADR 0180](adr/0180-ai-gateway-provisioned-per-deployment.md)).
- **Providers** (gateway-first, [ADR 0203](adr/0203-gateway-first-model-registry.md)):
  Workers AI (over REST through the gateway with payload logging off when the installer set
  `AI_GATEWAY_REST`, [ADR 0330](adr/0330-self-hosted-workers-ai-over-rest.md); otherwise the
  binding, with its `gateway` option) and, optionally, OpenAI, Google AI Studio,
  OpenRouter, DeepSeek, Anthropic and AI Gateway **custom providers**, called through the
  gateway's unified endpoint (`…/{gateway}/compat`) with `provider/model` ids
  (`deepseek/deepseek-flash`, `custom-<slug>/<model>`). Embeddings use the provider-native path.
  Other OpenAI-compatible endpoints are called directly. With no gateway every provider
  is called at its own URL. A deployment can pick a **model role preset**
  (`create-composable-os --model-roles deepseek-flash`), stored as its `AI_MODEL_ROLES` in the deployment
  state, and `AI_GATEWAY_BYOK` says which providers' keys the gateway holds
  ([ADR 0192](adr/0192-deepseek-provider-and-model-role-presets.md)). The shipped defaults stay
  on Workers AI.
- **Settings → AI** (`ai.*` operations, admins): per role provider, model, fallback, capability
  badges, a Test button and a warning when `review` shares the assistant's model (ADR 0031);
  provider keys stored as AI Gateway BYOK (the default with a gateway, through
  `CloudflareClient.setGatewayProviderKey`) or as Workers secrets, **never in D1** ([ADR 0151](adr/0151-provider-keys-as-workers-secrets-or-byok.md));
  usage and spend per role from AI Gateway's logs, cached 10 minutes
  ([ADR 0152](adr/0152-usage-and-spend-per-role.md)).
- **Stage 17 additions** ([ADR 0351](adr/0351-assistant-model-roles.md)): `assistant.core` (the
  front agent) replaces `assistant`, whose old config maps to it; `assistant.subagent` is the
  default for agents, and an agent profile may name another role, never a model. Every role has
  settings for thinking, max output tokens and temperature. The registry carries prices for
  uncached input, cache writes, cached reads and output, and a published cache lifetime where
  known, for the compaction planner ([ADR 0341](adr/0341-compaction-cost-model-and-cache-lifetime-learner.md)).
  `transcribe` (AssemblyAI streaming) and `speak` (AssemblyAI-TTS-1) share one key,
  `AI_KEY_ASSEMBLYAI` (a Workers secret; voice is off until it is set). AI Gateway cannot carry
  their streaming sockets, so they are the one direct call, with usage logged by us in
  `core_voice_usage` ([ADR 0349](adr/0349-voice-on-agents-voice.md)). `dictation.cleanup` runs with
  thinking off.
  Within a config layer, `assistant.subagent` and `dictation.cleanup` follow `assistant.core` unless
  set themselves, and `AI_MODEL_ROLES` still reads `assistant` as `assistant.core` with a
  deprecation warning (migration 0351 rewrote stored admin settings).
- **Hosted placement** ([ADR 0213 amendment](adr/0213-ai-usage-billing.md),
  `packages/core/src/ai/platform.ts`): the same code, switched by deploy vars the control plane
  sets. Every Workers AI role becomes **Platform AI** (registry provider `platform`), called over
  Workers AI's REST endpoint through the one shared platform gateway; the model client forces the
  tenant tag, payload-logging off and cache-skip onto every such request at the fetch, so nothing
  a caller passes (extension code through `codemode:ai` included) can re-tag it. `platformAi`
  entitlements gate it. The customer's own keys are Workers secrets on the tenant Workers, set
  through the control plane over the signed deployment channel
  ([ADR 0250](adr/0250-deployment-to-control-plane-channel.md)), called directly (or through
  their own connected gateway), never billed. Usage is counted in `core_ai_usage` and shown in
  Settings → AI, split into billed and own-key.
- **Summaries** (`summary.*`, [ADR 0153](adr/0153-ai-summaries.md)): record summaries (people,
  organisations, deals), meeting prep, one-liners for long emails and notes, and change-set
  summaries for approvers. Cached in `core_ai_summary` by a SHA-256 of their facts and the model,
  so any change makes them stale; generated only on request; labelled AI-generated. The daily
  digest ([ADR 0206](adr/0206-daily-digest.md)) opens with a one or two sentence AI overview (one
  `summarise` call per digest, in cos-runner's cron, labelled AI-generated; the plain digest
  without AI or on any error).
- **Semantic search** ([ADR 0154](adr/0154-embeddings-queue-and-vectorize.md),
  [ADR 0155](adr/0155-hybrid-search-similar-records-and-retrieval.md)):

```
 write ─► pipeline commit ─► stage 5 record events (Queue) ─► cos-runner consumer ─► embedRecordEvents
         (no Vectorize, erase, sync: core_embedding_queue rows in the batch ─► onCommitted ─► drain)
                                       10-minute cron (cos-app) ─► backfill + drain retries
 drain: text per record ─► SHA-256 unchanged? skip : embed role (≤100 per call) ─► Vectorize (cos-records)
 search.hybrid: FTS5 (all words, any word) + Vectorize nearest ─► reciprocal rank fusion ─► Cmd-K, retrieval
 record.similar: the record's stored vector ─► Vectorize nearest ─► "Similar records"
```

  Private and metadata-only synced activities are never embedded; an erase deletes vectors and
  summaries. Changed records are embedded from stage 5's record events by cos-runner's queue
  consumer; the D1 queue is only the fallback (ADR 0154 amendment).
- **Bindings are optional** ([ADR 0156](adr/0156-optional-ai-bindings-and-local-stand-ins.md)):
  `pnpm run deploy` adds `ai` (both Workers) and `vectorize` (cos-app). Without them AI features
  say AI is not configured and search is full-text only. Locally `AI_FAKE_MODEL=true` answers
  every role with deterministic stand-ins and keeps vectors in memory.
- **The in-app assistant** (stage 17, [spec](stages/17-assistant.md); ADRs
  [0340](adr/0340-one-assistant-thread-per-user.md) to [0351](adr/0351-assistant-model-roles.md);
  earlier [ADR 0030](adr/0030-in-app-assistant.md), [ADR 0200](adr/0200-in-app-assistant-build.md),
  [ADR 0201](adr/0201-assistant-reasoning-content.md)):

```
 Browser (sidebar · /assistant · voice) ──WebSocket (Agents SDK: chat frames + binary audio)──┐
                                                                                               ▼
 cos-app: AssistantAgent DO  name user:<userId>   (agent-core Thread + CRM binding)
   SQLite: messages, turns, compactions, when memory last folded, search index (FTS5), unread, jobs
   ├─ turn engine ─ context assembly ─ chatModels("assistant.core") ─ tools = in-process MCP client
   │     └─ approvals (tap · typed · spoken, Jev-checked) ─ change sets ─ adjudicator
   ├─ compaction planner (pure cost model, alarm before cache expiry)
   ├─ memory writer (inline, Jev-gated) ──► D1 core_memory
   ├─ voice (agent-voice: withVoice, own socket per call) ─ AssemblyAI STT + TTS, direct
   └─ spawns ──► AgentJob DO  name job:<jobId>   (assistant.subagent; brief, grant, budget)
                    └─ stages change sets; reports progress to the parent; never chats
 cos-runner: AutomationWorkflow ─ personal routine ─ gates (plain, Jev) ─ step "message me"
   ─► Queue cos-routine-delivery ─► cos-app queue() ─► AssistantAgent
 Connected assistants: AssistantAgent ⇄ AssistantAgent via core.agentMessage (Jev-adjudicated, logged)
 Plugins: core_plugin_* ─ install = copy into the owning scope; saved code on LOADER.get(stableId)
 Marketplace: crm-control hosts listings (reviewed); workspaces read it with a workspace token
```

  Each person has **one thread** that never resets, in one `AssistantAgent` Durable Object on the
  Cloudflare Agents SDK; the docked sidebar and `/assistant` show the same thread (ADR 0340). What
  still holds from stage 7b: the assistant is an MCP client of the same server `/mcp` builds per
  request, connected in process, so its tools, descriptions and results are an external client's;
  it acts as actor `assistant` for the signed-in person with origin `{ surface: "assistant",
  sessionId }`, its pending actions group in the session's change set, and it keeps and replays
  reasoning content (ADR 0201). D1 holds one `core_assistant_thread` row per user, written once
  per finished turn, and the people, organisations and hashed emails each turn referenced, so an
  erase finds the thread and asks its object to scrub it before it commits (ADR 0019 amendment,
  ADR 0320). `EVAL_VIA=assistant` runs the eval sets through it.

  The context keeps a byte-stable cached prefix (instructions, tools, memory, a "where we left
  off" note, messages since the compaction) and puts pending memory lines, page context and
  display facts in the tail. **Compaction** is decided by a pure cost model between rails (never
  below 24k tokens, always before 80% of the window), with a cache lifetime published per model or
  learned from cache hits (ADR 0341). **Memory** lives in D1 (`core_memory`), is read live each
  turn, is written inline by `memory.propose` and checked by Jev (`memory.write`,
  `memory.condition`), and never holds customer facts: those become a note the person approves
  (`activity.proposeNote`). With the judge off, every save is read back for the person to confirm.
  The thread keeps only when the block last folded; lines active since then ride in the tail
  until compaction calls `foldPendingLines()`, and conditional lines join the tail only on a
  matching record. Deleting a line's source message deletes it, an erase reaches it through
  `core_memory_refs`, and only the chat can write it, never an agent (ADR 0342). **Routines** are personal automations on the existing engine
  (`core_automations` with `scope = 'personal'`, plus `core_routine`) that message the thread. Their
  Workflow runs plain then Jev gates and queues ids on `cos-routine-delivery`, which cos-app consumes
  to post the message, since cos-runner cannot bind back to cos-app (ADR 0343). Longer work runs as **agents**, child `AgentJob` objects
  (`job:<id>`, `apps/app/src/server/assistant/job.ts`) that stage changes for review and never block
  (ADR 0344). `agent.start` checks a **grant** in code against what its starter may do, the judge's
  `grant.leastPrivilege` checks it against the brief (off: the person confirms it first), and a job
  queues behind the limits in `core_agent_job`. It works in slices on its alarm, as actor `assistant`
  with session `job:<id>`, and a guard in the pipeline routes every write: an empty field, a note or
  a task applies at once, anything else goes into the job's change set, and something outside the
  grant comes back as its own card. Its report joins the thread, and it deletes its storage, keeping
  only a reminder alarm while changes wait. Approvals can be tapped, typed or spoken
  (`approval.decide`), with a Jev intent check on the person's own words and a second step for high
  risk that the server enforces, the two-step button or the exact phrase (ADR 0345). Rich messages are
  **A2UI** from a versioned catalogue (ADR 0346); **plugins** install as copies (ADR 0347);
  **connected assistants** in the same workspace exchange Jev-checked messages under a contract
  (ADR 0348); **voice** runs on `agents/voice` (ADR 0349): a spoken message is a normal turn in the
  thread (`via: voice`), the browser reports played milliseconds and the thread stores what was
  heard (`playout`), and the model is shown only that. The general machinery lives in
  MIT-licensed `packages/agent-*`, which never import CRM code; the CRM binding is in
  `packages/core/src/assistant/` and `apps/app/src/server/assistant/` (ADR 0350).

  As built in wave 1 (W1, W10): `agent-core` holds the thread model (`ThreadMessage` with `seq`,
  `turn`, `role`, `via`, `parts`, `playout`, `deletedAt`), the SQLite message store with an FTS5
  index, context assembly (`assembleContext`, `prefixHash`), pending-line slots, the unread count,
  the turn loop (`runTurn`) and the channel seam. `AssistantAgent`
  (`apps/app/src/server/assistant/agent.ts`) keeps the thread in its SQLite, stores each user
  message with its tail block so history replays byte for byte, and streams a turn's events to
  every WebSocket (`/api/assistant/socket`, routed in `src/server.ts` before TanStack Start) and to
  the HTTP turn route. The browser keeps one socket per tab (`ThreadProvider`): both views show the
  same items, and a reply that arrives while the chat is on screen on any device is already seen.
  `thread.search`, `thread.deleteMessage`, `thread.markSeen` and `thread.status` are operations
  over the `assistantThreads` port; `thread.open` and `thread.finishTurn` are the object's own
  bookkeeping. `pnpm lint` runs `scripts/check-agent-imports.mjs` and its test.

  Compaction (W2) is in `apps/app/src/server/assistant/compaction.ts`, behind a few hook points in
  the object, over agent-core's maths. The model is sent the messages after the last compaction;
  there is no other trim. Each response's usage becomes cache observations and per-user usage
  stats in one `thread_meta` row, then the planner runs at the turn's end. It either compacts or
  sets the object's one idle alarm (an Agents SDK schedule) just before the estimated cache expiry,
  and the alarm runs the planner again. A compaction makes one summary call on `assistant.core`
  over the last turn's exact prefix and history, then commits the note and the seq it covers in
  one transaction. Messages are never touched, so everything stays searchable, and a turn arriving
  during the call runs on the old context and simply falls after the seq. The review data rides on
  `thread.finishTurn` into `core_ai_cache_observation`, `core_ai_compaction_decision` and
  `core_ai_cache_estimate` (migrations 0358 to 0360; observations and decisions kept 180 days by
  the daily cron); an idle alarm or a compaction writes through `ai.recordCacheReview`.
  `ai.cacheReport` exports it for `pnpm ai:replay-cache`. Settings → AI shows the lifetimes
  read-only and the admin rails (`ai.cacheSettings`, `ai.updateCacheRails`).
  In the app (ADR 0030 amendment) the panel is docked on the right of the shell on tablets and
  desktops, beside the page, and stays mounted across page changes; on phones it is a sheet.
- **Cards** ([ADR 0346](adr/0346-a2ui-catalogue-and-saved-producers.md)): rich messages are A2UI from
  the versioned catalogue in `agent-a2ui`, drawn by the app's component map
  (`apps/app/src/components/assistant/cards/`, charts through the dashboard widget renderers). A
  card is an `a2ui` message part stored with its text fallback, which is all the model reads. The
  model sends one with `show_card` (`a2ui.show`); a saved producer makes one with `a2ui.produce` and
  no model, on a stable `LOADER.get` worker that can only read, as the viewer. Invalid cards show
  their fallback. A button on a host card calls its operation as the viewer; a button on a model's or
  producer's card calls `a2ui.act`, which runs it as actor `assistant` so the gate applies. The
  approval card (`cards/approval.tsx`) asks a second tap for high-risk items (ADR 0345).

- **The judge** ([ADR 0230](adr/0230-jev-as-the-typed-judge.md),
  [ADR 0232](adr/0232-judge-defaults-and-user-decisions.md), [`docs/jev.md`](jev.md); stage 11,
  complete: the seam, every placement and the settings): a seam beside the
  registry, not a model role (`packages/core/src/judge/`, `ctx.judge` built by `judgeFor`).
  Code asks it typed questions (Choice, Noul, Score) at a named **placement** and gets
  probabilities; code holds the thresholds and decides. Its provider is **Jev**, pinned in code,
  reached through AI Gateway's custom provider `custom-typesafe`, with its key as BYOK or the
  `TYPESAFE_API_KEY` secret. Placements: does a proposed automation or extension do what the
  person asked (advice), the adjudicator's Jev reviewer (fails closed), each summary statement
  against its facts, model-written outbound messages (fails closed), job changes from signatures
  and the shape of a described widget. Without a key the judge is off and nothing changes.
  Each placement is on or off by layers: shipped default (on unless it sends record content;
  `approval.intent` is the exception, on when self-hosted and forced off on hosted),
  the `JUDGE_PLACEMENTS` deploy var, then human admins (`judge.update`). Built so far:
  `authoring.intent` asks five Choices per added or changed automation in `extension.check`
  (given a request) and `extension.propose`, adds `intent/*` warnings, stores the verdicts on
  the proposal row (`intent_check`) and shows them on the approval screen; the assistant passes
  the person's own words (`personsWords`, set by its Durable Object). Thresholds come from
  labelled sets (`pnpm eval:calibrate`, `evals/judge`), and tests and CI only replay committed
  recordings ([ADR 0231](adr/0231-judge-calibration-and-replay.md)). The automations eval grades
  intent with the same questions. `summary.generate` checks each statement of a new summary and
  removes what the facts do not say, storing the verdicts with the cached row (`checks`); a
  change-set summary the judge could not read is withheld, and a change-set summary describes only
  the change, never why: the approval screen shows the "Agent's reason" on its own
  ([ADR 0237](adr/0237-summary-statements-placement.md)).
  `submitOutbound` (cos-runner's integration queue) reads a message an AI actor wrote: a finding
  or no answer turns an automatic send into a review, with the findings on the pending action
  (`outbound_check`) for human approvers; the person's words reach it from `integration.call`
  and from Code Mode's gatekeeper calls ([ADR 0238](adr/0238-outbound-message-placement.md)).
  `sync.ingest` asks whether a known person's changed signature (from a mailbox that shares full
  content) means a different employer, and suggests a job change only then; if the judge fails,
  the old string compare decides ([ADR 0236](adr/0236-sync-job-change-placement.md)).
  `widget.describe` asks which shape the prompt wants before generation and sends a widget of a
  type that cannot show it back once ([ADR 0239](adr/0239-widget-shape-placement.md)). On a hosted
  deployment the placements that send record content stay off in code.
  `adjudicator.policy` ([ADR 0233](adr/0233-jev-policy-reviewer.md))
  is the adjudicator's default reviewer while the judge has a key: two Choices over the written
  policy's rules (which rule stops the change, which allows it), never the agent's reason, with
  the user the agent acts for (name and role) in its state; approve only where nothing stops it
  and a rule allows it; if Jev cannot answer, a person decides
  ([ADR 0235](adr/0235-adjudicator-acting-user-and-change-based-policy.md)). Its raw
  answer is on the verdict row. Settings → AI's Judge section ([ADR 0234](adr/0234-judge-settings-spend-and-key.md))
  holds the key (a Workers secret, or on a hosted workspace one set through the control plane), a
  Test call, the placement switches, the reviewer, and spend per placement, counted in
  `core_judge_usage` by an upsert in the batch each placement already writes (`widget.shape` and
  `extension.check` store nothing, so their calls are in the Workers log only).

```
 placement ── ctx.judge.ask({ placement, state, questions }) ──► off? JudgeUnavailable("off")
                                                                    │ on: key via BYOK or TYPESAFE_API_KEY
                                                                    ▼
                    jevJudge (fetch) ─► AI Gateway custom-typesafe ─► api.typesafe.ai/v1/systemone (JEV_MODEL)
                                                                    │
 typed answers (validated) or JudgeUnavailable { reason } ◄────────┘  ─► code: thresholds, fail open or closed
```

### 9. Dashboards and views

A view spec rendered by our own shadcn/chart components. Widgets query with read-only SQL over the
`rec_*` views: the SQL is checked by a SQLite-faithful tokenizer validator (one SELECT/WITH,
`rec_*` views only), takes bound params, and runs with row and time limits
([ADR 0020](adr/0020-query-sql-validator-and-csv-import.md); `validateReadOnlySql` in `@composable-os/core`,
used by `query.sql`). Computed widgets are extension code. Extensions never ship UI
([ADR 0010](adr/0010-dashboards-sql-views.md)).

How stage 4a built it:

- **View types** ([ADR 0056](adr/0056-view-spec-union-and-shared-views.md)): the view spec is a
  union (`table | board | calendar | gallery | dashboard`, `packages/core/src/views/spec.ts`).
  Saved views (`view.*`) store any object view and can be shared. List pages switch type with
  `vt`/`layout` search params; boards move cards through each object's update operation (stage
  rules apply), with `record.groups` for column counts and sums.
- **Dashboards** ([ADR 0057](adr/0057-dashboards-params-cache-and-click-through.md)):
  `core_dashboards` plus the code-defined Overview, Home per user (`core_user_home`). Widget SQL
  uses named params (`:date_from`, `:owner`, `:now`, …) rewritten to `?N` and run through
  `runReadOnlySql`; results are cached 60 s in the Workers Cache API by a hash of SQL, params,
  visibility scope and time zone; click-through templates resolve to list filters. Date presets
  and `:today` are the business's day, in the organisation's time zone (`localDay` in
  `time/local.ts`, [ADR 0871](adr/0871-day-windows-in-the-business-zone.md)).
- **Record tabs and panels, settings** ([ADR 0058](adr/0058-record-tabs-panels-and-extension-settings.md)):
  extensions declare `recordTabs`, `recordPanels` and typed `settings`; `view.recordViews` and
  `extensionSettings.*` serve them to the UI.
- **Describe a widget** ([ADR 0059](adr/0059-describe-a-widget.md)): `widget.describe` asks the
  `build` role (Workers AI through the optional `AI` binding on cos-app) for a widget, validates
  and previews it; without AI it says so.

### 10. Hosted SaaS (stage 10)

Besides self-hosting, we run deployments for customers (ADR 0191). Each is still one isolated
deployment with its own D1, R2, KV, queues and Vectorize index: no shared database and no tenant id
in its data. The one shared piece is the Platform AI gateway (below). Built and tested against
fakes; switched on by `docs/saas-go-live.md`. Below, `<crm-domain>` is the hosted CRM's domain.

```
 browser ─► <org>.<crm-domain> ──────────► crm-dispatch ─(KV host:<hostname>, verified only)─► <tenant>-crm-app
                                              │ minute cron: runs active tenants' crons     (user Workers in the
                                              │ (paused / suspended tenants: none)           WfP dispatch namespace
                                              ▼                                              crm-customers)
 browser ─► app.<crm-domain> ──────────► crm-control: sign-up, plans, Stripe, admin console, jobs queue
                                              │ Stage 8 engine (installRelease, runUpdate, runRollback)
                                              ▼ writes: core_entitlements, core_support_grants (customer D1)
 <tenant>-crm-app ─(signed: x-cos-tenant/timestamp/signature)─► crm-control /api/deployment/ai-secret
                                              └─► WfP script secrets AI_KEY_<P> / AI_CUSTOMER_GATEWAY on the tenant's AI Workers
```

- **Control plane** (`products/crm/apps/control`, [ADR 0210](adr/0210-hosted-deployments-on-workers-for-platforms.md)):
  `crm-control` with its own D1 (accounts, instances, rollouts, usage, audit; never customer data)
  and `crm-dispatch`. Provisioning uses Stage 8 bundles and the deploy engine, which can target a
  dispatch namespace (`dispatchNamespace` in the deployment state; per-tenant names and tags).
  States: active, paused (idle Free, woken by the next visit), suspended (billing). Placements:
  namespace, account (fallback), customer-account (managed enterprise, by runbook).
- **Plans and entitlements** ([ADR 0211](adr/0211-plans-and-entitlements.md)): Free / Team /
  Business / Enterprise. The control plane writes one `core_entitlements` row; the deployment
  enforces users, records and platform AI (`PlanLimitError`). Self-hosted: no row, no limits.
- **Support grants** ([ADR 0212](adr/0212-customer-approved-support-grants.md)): requested by
  staff, approved by the customer's admin in Settings → Support access, time-limited, a dedicated
  support user, audited on both sides; entry by an Ed25519-signed token (`/support/enter`).
- **AI billing** ([ADR 0213](adr/0213-ai-usage-billing.md) and its amendment) from the shared
  platform gateway's logs, filtered by tenant tag (`crm-platform`, created by provisioning with
  caching off and logs on, checked on every provision): cost + 20%, allowance per plan, overage as
  Stripe meter events, Free credit in dollars; the customer's own keys and MCP free. Hosted
  deployments get no gateway or gateway token of their own (`aiGateway: false`), only
  `AI_PLATFORM_GATEWAY_ID`, `AI_PLATFORM_ACCOUNT_ID`, `COS_TENANT_ID`, the shared
  `AI_PLATFORM_TOKEN` and, on crm-app, `COS_CONTROL_URL` and `COS_CONTROL_KEY`.
  **Stripe and lifecycle** ([ADR 0214](adr/0214-stripe-billing-and-account-lifecycle.md)):
  webhooks drive suspend and resume; export and delete. **Rollouts**
  ([ADR 0215](adr/0215-staged-rollouts.md)): canary → 10% → all, pause on failures, bookmark rollback.

## Repository layout

```
apps/
  app/                 TanStack Start + shadcn UI, server functions, /mcp       → Worker "cos-app"
  runner/              extension runtime, automations, Workflows, Queues         → Worker "cos-runner"
  marketing/           the Composable OS site, composableos.dev                  → Worker "cos-site"
packages/
  core/                operations registry, risk classes, policy types, model role registry (ai/), the judge (judge/), schema reconciler
  db/                  core D1 migrations (incl. core_base_* views), typed core schema
  auth/                IdentityProvider interface; better-auth and cloudflare-access adapters
  sdk/                 the extension contract (defineExtension, defineTool), formula language, test harness
  extension-check/     the source checks of an extension (imports, type check), shared by cos-runner
                       and `cos ext check`; and the Node side of `cos ext check` / `cos ext test`
  ui/                  shared shadcn/ui components and the view-spec renderer
  config/              shared tsconfig, biome and vitest presets
  pdf/                 the PDF writer, no dependencies: a safe core (standard fonts, every text a hex
                       string), a table layout, the agreement, invoice and receipt renderers (ADRs 0645, 0737)
  agent-core/, agent-a2ui/, agent-voice/, agent-plugins/
                       the assistant's general machinery, MIT, no CRM imports (ADR 0350; agent-core is
                       real since stage 17 W1, the others are placeholders for later waves)
  release/             release bundles, manifest types, verification, the Cloudflare API deploy
                       engine, preflight and the update procedure (Node and Workers)
  create-composable-os/ `cos` (published as @composable-os/cli): the client-repo commands (create, init,
                       deploy, upgrade, add, diff) and the installer: cos install, upgrade / rollback / status,
                       and cos ext check / test in a checkout
  gatekeeper-interface/ the gatekeeper RPC interface (vendored from cloudflare-os, see UPSTREAMS.md)
  gatekeeper-kit/      gatekeeper building blocks (vendored)
  gatekeeper-observability/, gatekeeper-configurator-ui/, mcp-shared/
                       what the vendored gatekeepers depend on (vendored subsets)
  gatekeeper-<name>/   gatekeeper Workers `cos-gatekeeper-<name>`: vendored (google, microsoft, slack, mcp,
                       email, zoominfo, websearch) and ours (email-send, slack-post, webhook); bound to
                       cos-runner as GATEKEEPER_<NAME> per deployment (docs/integrations.md)
products/
  crm/                 the CRM: its definition (product.ts) and its apps
    apps/control/      hosted SaaS control plane and dispatch Worker (stage 10)  → "crm-control", "crm-dispatch"
skills/                agent skills for building on the platform (stage 21, ADR 0405) and in client repos (stage 24)
templates/client/      the client repo `cos create` writes (stage 24): apps/web, apps/mobile, product.ts
blocks/                the platform's blocks (stage 24, MIT): ui-* (web base layer), native-base, sign-in
packs/                 shipped extensions with their client parts (stage 24): <id>/index.ts and its
                       files (the extension), client/ (headless hooks), blocks/ (screens)
  deals/               (stage 4) Deals: pipelines, stages, deals, participants (ADR 0026, 0100)
  leads/               (stage 15) Leads: inbox, conversion to deals (ADR 0246)
  lifecycle/           (stage 15) opt-in lifecycle stage on people (ADR 0246)
docs/
  architecture.md      this file
  roadmap.md           stage order and status
  adr/                 one record per significant decision
  stages/              per-stage agreed spec + acceptance criteria
  spikes/              time-boxed experiments and their findings
  deploying.md         install, secrets, Deploy button, upgrades
scripts/
  deploy.mjs           deploy both Workers and apply migrations (`pnpm run deploy`)
  dev-setup.mjs        local .dev.vars + local migrations (runs before `pnpm dev`)
  vendor-gatekeepers.mjs  re-copy the vendored cloudflare-os packages from an upstream checkout
  gatekeeper-worker-types.mjs  `wrangler types` for the gatekeeper Workers (`pnpm types`)
  release/             release build, manifest generator (golden test), changelog
  setup-ci-cloudflare.sh  wizard: the CI test account and its GitHub secrets
AGENTS.md              conventions every build session follows (CLAUDE.md points here)
CONTEXT.md             glossary
UPSTREAMS.md           vendored upstream code and the commit each copy tracks
```

## Prior art

- [`cloudflare/cloudflare-os`](https://github.com/cloudflare/cloudflare-os): gatekeepers,
  `gatekeeper-kit`, approval queue with simulation, release bundles and deploy page.
- [`cloudflare/computer`](https://github.com/cloudflare/computer): the Workspace filesystem and
  git. Its `worker-javascript` backend ran extension code until ADR 0043.

## The platform: what stages 21 to 28 add

Apart from what stage 20 built (noted under Products), nothing in this section is built yet. It
is the design for stages 21 to 28 ([`docs/roadmap.md`](roadmap.md)), and each part names its stage
and ADR. Each company's product
runs in its own Cloudflare account as one deployment. The host holds the data and the rules; packs
add kinds of record and behaviour; the company's customer-facing screens are its own code, written
by an agent with a person. Everything above stands, and the core objects become every product's
**base records** (ADR 0400).

```
            client repo (the company's own code)                 platform (releases)
 ┌──────────────────────────────────────────────────┐   ┌──────────────────────────────────────┐
 │ apps/web     TanStack Start   public + customer  │   │ packages  core, db, auth, sdk,        │
 │ apps/mobile  Expo             customer + staff   │   │           client, gatekeepers         │
 │ extensions/  the org's own objects and rules     │   │ packs     deals, leads, ticketing,    │
 │ blocks       copied in, then owned               │   │           content                     │
 │ product      packs on, platform version, names   │   │ blocks    registry (web + native)     │
 └───────────────┬──────────────────────────────────┘   │ skills    for agents building on it   │
                 │ typed client                          └───────────────────┬──────────────────┘
                 │ (service binding from apps/web, HTTPS from phones and TVs)│ verified release
                 ▼                                                           ▼
            the host: one Cloudflare account = one org = one deployment (Shape at a glance above),
            with an HTTP surface for client apps beside the UI, /mcp and the host modules
```

### Products

Stage 20 and stage 24; [ADR 0400](adr/0400-a-general-host-and-products.md).

A **product definition** names what one composition is: the packs that are on, the org's own
extensions, Worker and resource names, branding strings, and which core features show. The release
build and the deploy engine take a product, so the same platform release yields the CRM
for one install and Ghetto Movement for another. A deployment's Workers and resources are named for
its product (`crm-app`, `ghetto-app`). Nothing in the data model knows about products.

Stage 20 built the first of these, `products/crm/product.ts` (names, the shipped extensions it
includes, the update repository and the product's name in the UI); stage 24 moves a product's
definition into its client repo.

### Audiences and customers

Stage 22; [ADR 0402](adr/0402-staff-and-customers.md).

Every operation declares its audiences: `staff` (the default), `customer`, `public`.

- **Staff** are today's users, with roles.
- A **customer** is a Person with a sign-in. An object says which relation field is its customer;
  the visibility seam limits a customer to their own records. Customers never reach the admin, MCP,
  Code Mode, `query.sql`, dashboards or exports.
- **Public** callers have no account. Public operations are few, low risk and rate limited.

As built (stage 22; ADRs [0410](adr/0410-the-seams-first-door-as-built.md),
[0411](adr/0411-audiences-on-operations-as-built.md),
[0412](adr/0412-customer-scope-and-principals-as-built.md),
[0413](adr/0413-outside-handlers-have-no-raw-database.md),
[0414](adr/0414-pack-tools-run-as-the-customer.md)):

- **The visibility seam** (`packages/core/src/visibility/`). `visibleSource(ctx, object)` is the
  source every read of a record takes. Staff get the plain view. A customer gets a source holding
  only their rows and only the columns the object lists, and the public get none.
- **The audience check** is the pipeline's first step. A caller outside an operation's audiences
  gets the answer an unknown operation gets. `packages/core/open-operations.json` lists what is
  open, and a test keeps it equal to the registry.
- **A call for a customer or the public** carries a principal and no staff user. It takes a
  short path of its own in the pipeline: no role, no approval queue, a write check at the seam
  before the batch commits, and an audit row with actor `customer` or `public`.
- **Its handler has no raw database.** It reads and writes records through `ctx.records`. A core
  operation marked `hostInternal` keeps the database for account and session bookkeeping.
- **Customer accounts** are `core_customer` and its sessions, apart from `core_user`. A second
  Better Auth configuration in `packages/auth` signs customers in by a one-time emailed code,
  with its own cookie and secret, and resolves a request to a customer or the public, never to
  staff. Who may sign up is a human admin's setting: invite only, also buyers (ADR 0458), or
  anyone; and, on top, anyone starting a subscription while a plan is on sale (ADR 0459).
- **Open operations:** `me.get`, `me.update`, `me.family`, `me.signOut`, `me.sessions.*`,
  `me.deleteAccount`, `my.list`, `my.get`, and for tools only `my.create`, `my.update`.
- **A pack's tool called by a customer runs as that customer.** Its operation calls take the same
  outside path with the same principal. It may set an object's writable fields and the fields
  the tool lists in its manifest. A runtime extension can open nothing.
- **Deleting an account** disables it, ends its sessions and creates an erase request with a due
  date for staff, who erase the person or decline with a reason.
  (`core_erase_request`, migration 0402; due after `customer.settings` `eraseDueDays`, default
  30; `eraseRequest.list` / `eraseRequest.decline`, shown under Settings → Storage; the daily
  maintenance cron reminds admins once a day about an overdue one.)
- **Erase and merge:** `person.erase` deletes the person's customer account, its sessions and
  sign-in codes, invites for their addresses and their erase requests, and lists the account's
  address as erased. `person.merge` moves the account to the survivor, is refused while both
  people have an active one, and links a `needs_merge` account the merge resolves.
- **Limits:** a customer's calls per account and operation, and code requests per address asked
  for (`customers/limits.ts`, Workers Rate Limiting). Per client address only at the edge, and no
  address is stored.

The HTTP routes that mount customer sign-in and carry these calls are stage 23's.

### The HTTP surface and the typed client

Stage 23; [ADR 0403](adr/0403-http-surface-and-typed-client.md).

A fourth surface beside server functions, MCP tools and the host module. Client apps call
operations over HTTP through one generated package of types and TanStack Query option factories,
the same package in TanStack Start and in React Native. Calls go through `invoke()` like any other.
Writes carry idempotency keys.

As built (stage 23; ADRs [0415](adr/0415-the-http-surface-as-built.md),
[0416](adr/0416-idempotency-keys-as-built.md), [0417](adr/0417-the-api-contract-and-versions.md),
[0418](adr/0418-the-typed-client-as-built.md),
[0419](adr/0419-native-sessions-and-customer-sign-in.md)):

- **The surface** is `packages/core/src/http/`: `POST /api/v1/op/<name>` and
  `GET /api/v1/manifest`, over an invoker, framework-free. cos-app serves it from
  `src/server/http/api.ts`, before TanStack Start, and decides only who the caller is: a staff
  session is staff (the context the UI's server functions build, origin `client`), a customer
  session is that customer, anything else is the public, and both sessions at once are refused.
- **One answer for closed and missing:** the operation is looked up for the caller before the body
  is read, so a customer's session on a staff operation gets exactly what no session gets.
- **One envelope:** `{ "data": … }`, or `{ "error": { code, message, details } }` with a status
  from the code. The manifest lists only what the caller may call.
- **Idempotency keys:** every write needs one. The key row commits in the write's own batch
  (the pipeline's `inBatch` hook), a claim makes a second call with the same key wait for the
  first, and the daily cron purges keys after 24 hours.
  Erasing a person deletes the stored replies that name them. A key costs a write one round trip.
- Cross-origin calls only from `API_ALLOWED_ORIGINS`, and only for customers and the public: a
  staff cookie (Better Auth's, Access's, hosted support's) is used only from the host's own pages,
  on every route that reads one (`staffCookieAllowed`, `apps/app/src/server/staff-origin.ts`,
  ADR 0660); customers are limited per account and
  operation by `CUSTOMER_RATE_LIMIT`. Public calls need a Cloudflare rate limiting rule at the
  edge (`docs/deploying.md`).
- **The contract** (`packages/core/src/http/contract.ts`) is the manifest per audience, committed
  as `packages/core/api/v1/<audience>.json`; a test fails while it and the registry differ. A
  version below the oldest served answers `upgrade_required`.
- **The typed client:** `@composable-os/client` is the runtime (no DOM, Node or Workers types).
  `cos client generate` (`packages/client-gen`) writes a product's `customer.ts` and `staff.ts`
  from its registry: core operations, its packs' tools and the org's own extensions. A pack may
  ship a headless entry over it (Deals: `packs/deals/client/index.ts`).
- **Native apps** sign in for tokens with no cookie (ADR 0455): `/api/v1/auth/customer/code` and
  `/customer/sign-in`, `/api/v1/auth/staff/code` and `/staff/sign-in`, and for staff whose sign-in
  is browser-based, `/native/staff-sign-in` in the system browser then `/api/v1/auth/staff/exchange`.
  They rotate tokens at `/api/v1/auth/refresh` and end their own session at `/api/v1/auth/sign-out`
  (`core_device_session`). `/api/v1/auth/token` still exchanges a cookie session. Customer sign-in, `/api/customer-auth/*`, is
  served by cos-app; codes go out through the email connection `customer.settings` names, sent by
  the host as the system user.

### Behaviours

Stages 25 to 28; [ADR 0404](adr/0404-behaviours-are-the-vocabulary.md).

The rules products share, declared in a manifest and enforced by the host in the write's own batch.
`stages`, `states`, `capacity`, `sellable` and `publishable` exist (the last with its public
half, and the media library beside it, since stage 28). `allowance` exists since stage 32b;
`recurring`, capacity claimants and declared uniqueness since stage 31 (below); `staffed` since
stage 45 (below). Behaviours stack:
an event is publishable, sellable and has a capacity.

`stages` and `states` are two declarations on one **transition engine**
([ADR 0425](adr/0425-one-transition-engine-for-stages-and-states.md),
`packages/core/src/records/transitions.ts`). For a write to a record with a lifecycle the engine
decides whether the move is allowed, which fields it requires and who may make it, and puts the
history row in the write's batch. `stages` is data: pipelines and stages are records an admin
edits, with every rule of ADR 0100. `states` is declared in code: a select field, an initial
state, and moves that each say who may make them (`staff`, `customer`, `host`), the fields they
require and whether they are final. A `host` move is made only by platform code calling the
engine from its own handler (`updateRecordAsHost`); every caller of an operation is staff, so no
person, MCP client, extension or import can make one. A stage move is for staff and the host;
a customer never makes one. Both forms write `core_transition_history`
(migration 0420), read as `rec_stage_history` and `rec_state_history`. An object has one
lifecycle. A move is made from a current read or not at all
([ADR 0437](adr/0437-a-move-is-made-from-a-current-read.md)): the history close is conditioned on
the record still holding the position the write was judged from, so of two writes racing to move
one record, one commits and the other fails as a conflict. `record.update { from }` makes the
move the point of the write (checking a ticket in).

A signed-in customer moves a record as `customer`, whether their own handler writes or the host
writes for them at the seam, and the public move nothing
([ADR 0426](adr/0426-who-moves-a-record-and-what-follows-a-move.md)). Platform code can register
a hook on an object's moves (`onRecordMove`): it runs in the batch of the write that makes the
move, which is how `capacity` and `sellable` act when an order is paid. Extensions cannot.

**Windows, staff-only rules and requested moves**
([ADR 0503](adr/0503-time-windows-and-staff-only-on-the-transition-engine.md),
`packages/core/src/records/windows.ts`). A move may declare a `window` and a `staffOnly` flag, and
`states.create` the same for every create: a customer makes the move only from one moment until
another, each worked out from a datetime of the record or of the record a relation points to
(`klass.startsAt`), less whole local days in a zone and then minutes, by the host's clock in the
write; while the flag (a boolean, named the same way) is true, only staff and the host may.
Staff and the host are not bound. `states.requests` names moves a caller asks for by name
(`cancel`), resolved by the host to the first listed state it may enter now (`cancelled` in
time, `late_cancelled` after); `resolveStateRequest` is the dry run a tool shows first, through
the tool-only operation `state.resolve`. Since step 3 ([ADR 0505](adr/0505-window-numbers-through-two-relations-and-settings.md))
a path may pass through two relations, every field on the way the declaring extension's (a field
it adds to another pack's object counts: Bookings' rules on Programs' class type), a number may
be `{ field, setting }` (the field, else the extension's setting), read in the write; and
`staffOnly` may list several booleans, a boolean formula among them.
`states.create.in` lists states a record may be created in, with who may (a booking created
`waiting` by a member, `pending` only by the host), not judged as moves from `initial`.

**Capacity claimants** ([ADR 0501](adr/0501-a-record-s-states-claim-its-place.md),
`packages/core/src/capacity/claimants.ts`). An object declares `claims: { on, held, confirmed }`:
its records' states hold, take and give back one place on the record `on` points to, which
declares a capacity. The transition engine queues the claim, confirm or release in each move's
batch (`for: { type: <object>, id }`), refused by the database past the places as an order's
line is (migration 0440). A claimant holding a place keeps its `on` and stays out of Trash.
Orders claim through their own move hook, unchanged.

**Waitlists** ([ADR 0520](adr/0520-a-waitlist-on-a-claimant.md),
`packages/core/src/capacity/waitlist.ts`, `operations/waitlist.ts`). A claimant may declare
`claims.waitlist: { state, promote, until, promotedAt?, passedOverAt?, passedOverReason? }`. A
record in `state` holds nothing; it is made only while the claimed record is full (a
`core_write_guard` of kind `full` in its batch, migration 0610) and before `until` (a moment named
as a window's end). A place given back before `until` while anyone waits is handed to the
waitlist by two conditional statements in the same batch (the counter's `held` and a claim
`for_type 'waitlist'`), so a direct claim finds the record full. `runWaitlistDue`, the runner's
minute step, promotes the first waiter (by creation) as the host, one batch each
(`waitlist.promote`: from `state` or not at all, a waitlist hold given back and the waiter's own
claim made, whatever the move spends spent), passes over a waiter whose spend is refused
(`waitlist.passOver`) and gives back holds nobody took or that the cut-off reached
(`waitlist.release`). Those three refuse any origin but `system`, and are host steps
(`hostStep`): from it the gate never queues them. The last waiter leaving gives the holds back in
its batch; an erase hands on the places it gives back; a waiter cannot change its record, and may
take a free place itself where its object declares that customer move (never a hold). `waitlist.position` reads a waiter's place (a customer's own only).

**Timed moves** ([ADR 0550](adr/0550-timed-moves-and-a-cancel-that-races-a-booking.md),
`packages/core/src/operations/timed-moves.ts`). `states.after: [{ from, to, at, minutesAfter?,
ifAnyIn? }]`: once `at` (a datetime of the record or one relation away) plus `minutesAfter` has
passed, the minute cron's `runTimedMovesDue` moves each record still in `from` to `to` as the host,
one batch each, through `state.after` (system origin only, a host step), within a 14-day look-back;
`ifAnyIn` requires another record on the same related record in one of those states. Bookings'
no-shows. The cascade (`states.follows`) guards the parent's counter at commit, and a create judged
against `create.closed` guards that the record it reads has not moved (migration 0670), so a class
cancel and a booking racing it never leave a booking on a cancelled class. A window may sit on a move
staff alone make when it binds staff, and a spender's `movedFrom.state` is entered only inside the
new record's create ([ADR 0551](adr/0551-staff-bound-windows-and-a-move-only-by-its-new-record.md)).
A tool may declare `personApproves`: anyone but a person is queued for one, whatever the preset, and
such a tool may be named in a move's `tools` ([ADR 0552](adr/0552-a-tool-a-person-approves.md)).

**Declared uniqueness** ([ADR 0502](adr/0502-declared-uniqueness.md),
`packages/core/src/records/unique.ts`). `unique: [{ fields, states? }]` is a partial unique index
the reconciler builds on the extension's table: no two live records in those states share the
fields (one active booking per Person per class), whoever writes and however many at once. A
read before the write gives the clear message and the dry run's answer.

**`recurring`** ([ADR 0500](adr/0500-recurring-a-weekly-rule-in-local-time.md),
`packages/core/src/recurring/`, `packages/core/src/time/local.ts`). A series (a timetable line)
declares a weekly rule in local wall-clock time and the fields it fills on the records it makes:
`recurring: { generates, link, rule, into, copy, cancel, ended?, closures?, horizonDays? }`. The
minute cron (`runRecurringDue` → `recurring.generate`, as the host) makes each due series'
records up to its horizon (56 days by default): a series is due when written, and daily at 00:05
in its zone. `core_recurrence_occurrence` (migration 0560) keys each record on the series and
its local date in the batch that creates it, so nothing is made twice. 06:00 stays 06:00 across a
clock change; a time in a change's gap moves forward by the gap, one that happens twice is the
first. A copied field staff change on one record (a coach swapped) is that record's own field
exception (`core_recurrence_exception`, migration 0810, with who and when; [ADR
0620](adr/0620-field-level-exceptions-in-recurring.md)): the series never writes it again and
still writes the rest; set back by hand to the series' value, or `recurring.follow`, it follows
again (`recurring.exceptions` reads them). A record whose time or state staff change is detached
whole and left alone, as are those detached before ADR 0620. A change to the series reaches its
future records at once, field by field, in its batch, and moving or cancelling records with places
taken needs `recurring.change` with the count confirmed. A hand edit and a series change guard
each other per occurrence (migration 0810's `core_recurrence_guard`), so racing they cannot
overwrite each other, while edits of different records of one series do not contend. Closures cancel the records
they cover and nothing is made in them (`recurring.close` with the count when they cover booked
records). Runs and changes are planned from a read and guarded at commit (`core_write_guard`: the
series' version, each planned record's places), so a race fails as a conflict instead of leaving
stale or orphaned records. A tick makes at most 100 records, 25 per series run, sized from D1's
1000 queries per invocation (ADR 0500). `horizonAtLeast` keeps the horizon at least the longest
booking window; a series in Trash is handled as ended. The wall-clock helper is shared with
subscriptions' `paidUpMoment` and stage 32b's allowances.

**`staffed`** ([ADR 0621](adr/0621-the-staffed-behaviour-and-the-time-claim.md),
[ADR 0622](adr/0622-warnings-in-a-writes-answer.md), `packages/core/src/staffing/`; stage 45
step 2). A record that declares `staffed: { who, starts, ends, zone?, kind, live, … }` is a
**shift**: a time, a kind of work, and at most one staff account (a `user` field, or a relation
whose record's user field holds it: a class's coach profile). Every live, covered shift whose
person has an account holds a **time claim** in `core_staff_time` (migration 0811), and the
database refuses two overlapping claims of one account (`conflict`, `rule: "double_booked"`), for
every writer and under races. The claims are derived by triggers the reconciler builds on the
staffed object's own table and on the account holder's table (`staffing/sql.ts`), so every
statement that writes a shift writes its claim: create, edit, move, cancel, the Trash, a restore,
erase, merge, imports, a series' generation and changes; the checks hold for `INSERT OR REPLACE`,
upserts, `UPDATE OR REPLACE` and id updates. A read before the write names the other shift; the
series' generation makes a clashing date uncovered (kept as a field exception) rather than fail; a
series change that would double-book on any date is refused naming the dates; a reconcile over
shifts that clash and have not ended is refused (`staffed_conflict`; past clashes are skipped and reported, and admins are told of a refused shipped upgrade). A live shift must end after it starts, and a coach profile on shifts not yet ended cannot go to the Trash. Writes answer **warnings** they are
made with (`unavailable`, `not_qualified`, `uncovered` within 14 days), which the audit row
records; `staffing.check` (tool-only) is the same answer first. Qualifications and unavailability
are core tables in no `rec_*` view (`core_staff_qualification`, `core_staff_away`). Bookings' class
declares it.

**Offers, takes and the roster's notices** ([ADR 0623](adr/0623-offers-and-takes-the-race-and-the-cut-off.md),
[ADR 0624](adr/0624-the-rosters-notices-uncovered-shifts-and-leaving.md), stage 45 step 3). The
host's tool-only staffing operations (`packages/core/src/operations/staffing.ts`) write who may do
which kind of work (`staffing.qualify`), unavailability (`staffing.away`, `staffing.back`,
`staffing.awayList`: the person's own and rosterers'), and offers (`core_staff_offer`, migration
0812): `staffing.offer` (the shift's person, or a rosterer for anyone's and an uncovered one; the
eligible are told: qualified, free, not away), `staffing.take`, `staffing.withdraw`,
`staffing.offers`; and a rosterer's `staffing.assign` and `staffing.uncovered`. An offer leaves
`open` once: a trigger refuses every later move, so of twenty takes at once one commits and the
rest are told who took it (an operation's `explainFailure` reads again after a failed batch). A
take writes the person through the record operations, so it is a field exception of its series
and its time claim moves, in the take's batch. Offers close an hour before the shift (the cut-off)
and lapse there (the minute cron's `staffing.due`, which also sends the rosterers the daily list of
uncovered shifts; offers lapse in order of their shift's start, kept on the offer). Every write of
a shift, by any path, cancels its open offer (by the shift, at commit) when it goes to someone else
or ends, and so does a coach profile given another account; a take refuses an offer whose shift
changed hands. Each write tells the people put on or taken off it, the person whose shift moved or
was cancelled, and the rosterers when it is left uncovered (`staffing/changes.ts`), gathered over
the call and sent before it commits (the handler context's `beforeCommit`): one notice per person
per call, a summary for a change of a series or an import. A series' generation tells nobody per
record. A take, an offer, a withdrawal and saying someone is away are a
person's own act (the calling tool must be `humanOnly`); `assign` and `qualify` are applied by a
person (`personApproves`). `user.deactivate` takes a leaver off every future shift and pattern,
confirmed by count, cancels their offers and tells the rosterers (`staffing/leaving.ts`). Who may
roster is decided in one place (`staffing/rosterers.ts`, stage 45 step 4,
[ADR 0626](adr/0626-the-rostering-pack-and-bookings-additions.md)): admins, and accounts granted the
restricted permission a shipped pack declares as its `staffing.rosters` (Rostering's
`rostering:manage`). The same declaration names the pack's number settings the host reads (the
offer cut-off, the uncovered window; 60 minutes and 14 days otherwise). The operations act for the
tool's verified caller (`ctx.extension.tool.calledBy`, never the input or the extension's own
account). `staffing.week` is the roster read across every staffed object: times, kinds, places,
who is on each and its open offer, and for a rosterer its warnings; never a booking, a place count
or a Person. A leave note reaches only a person, never an assistant or the audit log. Where a pack
declares who rosters, a caller's write of who works a shift (a shift's person, a pattern's person,
a coach profile's account), by any path, is a rosterer's (`assertRosterWrite`); an AI's such change,
or its call of a restricted tool, is approved only by someone who could make it.

**Open hours** (stage 49 step 3, [ADR 0762](adr/0762-open-hours-and-free-times.md),
`packages/core/src/staffing/hours.ts`, `operations/staffing-hours.ts`, migration 1090): when
someone takes appointments, in `core_staff_hours` beside `core_staff_away` and in no `rec_*` view:
weekly entries in local time (overnight when the end is at or before the start) and one-off extra
hours, each for every kind of work or for some kinds only (a service). Read by wall clock on the
fly (`openRanges`, `openCovers`), merged where they touch; "not open" is time off, never an entry.
Set, changed and removed by the person or a rosterer through the tool-only `staffing.hours.set`,
`.clear` and `.list`; an AI's change waits for a person; at most 50 entries a person;
`user.deactivate` removes a leaver's. Free times (step 4) subtract time off, claims and rooms.

**Pay periods** (stage 45 step 6, [ADR 0627](adr/0627-pay-periods-the-basis-the-totals-the-lock-and-the-export.md),
`packages/core/src/staffing/pay.ts`, `operations/staffing-pay.ts`, migration 0813): who is counted
(`core_staff_pay_basis`, by time or by class from a date), the not-worked mark
(`core_staff_not_worked`) and each locked version of a period (`core_pay_period`, `core_pay_line`),
all core tables in no `rec_*` view, with no rates or money. The period is the pack's setting
(`staffing.settings.payPeriod*`); a period's lines are every live shift of a counted person whose
local start date is in it, in whole minutes (instants, so a clock change counts the real time) plus
the kind's set-up and pack-down minutes (`staffed.payBefore`, `payAfter`), with the evidence a
`staffed.evidence` object gives (the class list's ticks). The lock writes the lines in one batch
guarded on what they were read from; after it, triggers on each staffed table (built by the
reconciler beside the time claim's), the holder's, the marks and the basis refuse any change that
would alter the period, for every statement shape. Who handles pay is the pack's `staffing.pays`
(Rostering's restricted `rostering:pay`): admins and by grant, a person only, never an AI; reads
of totals and exports are audited without their figures. Each staff member also reads **their own**
totals for a period (`staffing.myPay` and `staffing.myPay.periods`, Rostering's team tools
`myPay` and `myPayPeriods`; the owner's decision of 2026-11-24): the same lines, read for the
verified caller only (`periodLines` narrowed to one account, or the locked lines of that account),
through the pack that declares the pay periods, a person only, never an AI, with no one else's
lines, who took a class's list or why a shift was not worked; audited as which period.

The roster's screens (step 7,
[ADR 0629](adr/0629-the-rosters-screens-role-clients-with-grants-and-the-roster-import.md)) are
Rostering's blocks over its headless entry, and ask the host what a screen needs through more
tool-only operations: `staffing.me` (whether the reader rosters or handles pay, so no block decides
it), `staffing.candidates` (who could be put on a shift, from the write's own dry run),
`staffing.people`, `staffing.patterns` and `staffing.setPattern` (a pattern's person from a date),
`staffing.follow` (back to the pattern) and `staffing.planCheck` (`cos rostering import`'s dry
run, the same clash check the writes and the reconcile make). `staffing.week` answers each day's
hours in the zone, so a clock-change week is drawn from the host's times.

**The staff calendar feed** (stage 45 step 5, [ADR 0628](adr/0628-the-staff-calendar-feed-and-the-shared-calendar-writer.md),
`packages/core/src/staffing/feed.ts`, `operations/staffing-feed.ts`,
`apps/app/src/server/http/staffing-feed.ts`, migration 0814): `GET /api/v1/staffing/feed/<token>.ics`,
served by cos-app before the HTTP surface and bypassing Access (a calendar app cannot sign in). The
token (32 random bytes) is the credential: made by the person's own `staffing.feed.rotate` (Rostering's
`feedRotate`, `humanOnly`), shown once, kept only as its SHA-256 in `core_staff_feed` with the tool that
made it. A fetch answers while the account is active and may still call that tool, reading the
account's time claims from 14 days back to 120 days ahead (bounded, never the history); every other
token gets the surface's own 404. Deactivation and a role, pack role or grant change that takes the
tool away delete the row in their batch. Limited per address and per token; private, unindexed,
no Referer. The file is written by `packages/calendar-file`, the zero-dependency iCalendar writer the
email gatekeeper's calendar file (ADR 0571) shares. A tool may declare `redactResult`: answer keys
never kept in the audit log, an approval or a stored idempotent reply.

**Checklists** (stage 45 step 4b, [ADR 0650](adr/0650-checklists-templates-runs-ticks-and-a-done-run-kept-unchanged.md),
`packages/core/src/checklists/`, `operations/checklist.ts`, migration 0815): a platform piece any
pack composes. Templates (`core_checklist`, `core_checklist_step`) are read by every staff account
and written with `checklists:write` (a grantable core permission; an AI's save waits for a person
who holds it); Settings → Checklists is their admin screen. A `checklist` field names an active
template; an object declares `checklists: { template, who, opens, closes, live }` (shipped packs and
the org's own only), as Rostering's duty shift does through `duty.checklist`. Each live record with a
template gets one **run** (`core_checklist_run`), its steps copied as they were, made by the minute
cron's `checklist.due` a day before it opens (or by the first tick); the cron keeps an open run's
person and times with its record and closes it after its end and 2 hours' grace, as missed (the
rosterers told in one person-only notice) or cancelled. Ticks (`core_checklist_tick`) keep who
ticked and for whom: the record's person, or someone who rosters on their behalf with why. A done
run never changes: triggers refuse every change of it, its ticks and its corrections
(`core_checklist_note`) for every statement shape, and no host step writes what they refuse. The
tool-only operations (`checklist.forRecord`, `.tick`, `.complete`, `.correct`, `.runs`) answer only the
run's person and people who roster, at the screen, never an AI; the tables are in no `rec_*` view.
`staffing.week` gives everyone a shift's checklist name and its state only to its person and
rosterers. Notes and reasons are redacted from the audit log and never answered by a write.

`sellable.moves` ([ADR 0560](adr/0560-a-paid-line-moves-a-record-that-exists.md),
`packages/core/src/orders/moves.ts` and `refund-due.ts`) is a paid line that moves a record that
already exists: `order.startHeld` (a tool's only) makes the record in its `held` state (a drop-in
booking holding its place) and its order in one batch, as the host, after judging the caller's
input with the record's own create rules and guards, priced from a declared path or the
extension's setting; a guest's record (`guest`) has no Person until the verified payment matches
their address, and unpaid guest holds are capped per record (`holdCap`, migration 0690's guard) and
per address; the order's
move hook moves it to `paid` or `expired`; a record leaving `held` another way cancels its unpaid
order; entering a `refund` state with its order paid writes a refund owed
(`core_sellable_refund_due`, migration 0690), which the minute cron asks the payments gatekeeper
for, as `payments.refund`, approved only by a person with `orders:refund` (a rejected or expired
approval is reported to staff, never dropped).

`sellable` ([ADR 0435](adr/0435-sellable-what-may-be-bought-and-what-a-paid-line-grants.md),
`packages/sdk/src/sellable.ts`, `packages/core/src/orders/sellable.ts` and `grants.ts`) is what
makes an object's records something an order line may point at: its price field and currency,
and optionally a sale window, a most per order and a deposit, all read from the record by the
host when the order starts (a line outside them is refused, and no order exists). It may also
declare what a paid line grants: one record of another of the extension's objects per unit,
which the order's move hook creates as the host when the order is first paid (`paid`, or
`part_paid` for a deposit), in that batch, with fields set from the line, the item and the order
and an unguessable code, and moves to its declared void state when the order is refunded in full
or cancelled after a deposit. `core_order_grant` (migration 0450) records each grant and keeps
codes unique.

**The public scope** ([ADR 0438](adr/0438-the-public-scope.md),
`packages/core/src/visibility/public.ts`). An object may declare what the public may read:
`public: { read, when? }`, fields of the records meeting a condition on a state of the record or
of one record it points to. The seam limits rows and columns in the source itself, as for
customers; a record that does not meet it is not found. A customer reads it too, on an object
with no customer of its own. The public reach it only through a pack's tool, which calls the
tool-only `public.list` and `public.get`. `capacity.get` and `order.start` answer outsiders only
for records their scope shows them. On a publishable object the public's source is the object's
live view, so the public reads only published versions (below).

**The signed-in scope** ([ADR 0447](adr/0447-the-signed-in-scope.md)). `signedIn: { read, when? }`
has the public scope's shape and is read by every signed-in customer, never the public. Beside a
`customer` declaration it shares records (`WHERE <customer> = :me OR <when>`, fields only the
customer reads of their own empty on a shared row); alone it opens records to read. `my.list` and
`my.get` read it. A customer changes only their own records (`ownedSource`), and a relation their
write sets must point at a record they can see. `my.update` takes `from`.

**Through their own records** ([ADR 0439](adr/0439-what-a-customer-reads-through-their-own-records.md),
`packages/core/src/visibility/via.ts`). `customerVia: { from, field, read }` on an object: a
customer reads the fields in `read` of the records one of their own records of `from` (an object
of the same extension that declares a customer) points to through `field`, whatever their state
(a ticket's event after it ended): `WHERE id IN (SELECT <field> FROM rec_<from> WHERE <customer> =
:me)`. Beside `public` or `signedIn` the customer reads both, a column only one lists empty on the
other's records. `my.list` and `my.get` read it. Buying reads `buyableSource`, the scope without
it: reading is not buying. The seam also adds `currency` (the deployment's) beside a sellable
object's records, and `me.get` returns the account's verified sign-in address (`signInEmail`).

**For a dependant** ([ADR 0540](adr/0540-the-family-link.md), `packages/core/src/visibility/guardians.ts`,
`core_person_link`, migration 0650). Staff with `people:link`, a person only (`person.link.add`,
`person.link.end`), link a guardian (a parent) to a dependant (a child). On an object whose
`customer` declares `guardians: { write?, madeBy? }` a customer's scope is `WHERE <customer> = :me
OR <customer> IN (<the live dependants of :me>)`, read in the statement, so every read through
`visibleSource` (and `customerVia` from such an object) sees it; with `write`, `ownedSource` does
too, and `my.create` takes `forPersonId` (a live dependant, or not found as a Person that does not
exist). A write for a dependant carries a guard in its own batch (`core_person_link_guard`): a link
ended before it commits fails it. `madeBy` is set by the host to who made the record. `me.family`
answers the caller's own links. The database refuses a two-way link. A merge re-points links
(ending one that would be a duplicate or two-way) and, when either Person has a live link, waits
for a person's approval from any other actor; an erase deletes them and says which children have
no guardian left.

**Time zones** ([ADR 0460](adr/0460-time-zones-on-records.md)). A `timezone` field type (an IANA
name the runtime knows; the deployment's zone when left empty on create), and date-relative
triggers that count days in a record's own zone (`zoneField`), scanned hourly by cos-runner's cron.

**The document field** ([ADR 0445](adr/0445-the-document-field.md),
`packages/sdk/src/document.ts`). A field type whose value is one JSON document checked against a
schema the field declares (objects, lists, text, numbers, choices, refs, tagged unions, named
definitions), in the field type's own validation, so for every actor, the import and the dry run;
a fault is refused with its path, a size limit is checked first, refs must name live records.
Declared paths are read-only columns of the `rec_*` view. `private` object nodes are removed at the
seam from what customers and the public read, and `holders` nodes (or keys) from what they read
without access to the record (stage 42, ADR 0477).

**Rich text and slugs** ([ADR 0440](adr/0440-rich-text-is-data.md),
[ADR 0442](adr/0442-what-the-public-reads-of-content.md), `packages/sdk/src/rich-text.ts`,
`packages/core/src/records/slug.ts`). `richText` is a document field with the platform's one
schema, `RICH_TEXT_SCHEMA`: blocks (paragraph, heading, list, quote, image, divider, embed,
callout, button) of inline runs (text with bold, italic, code and a link; a line break). Text nodes
are `noMarkup` (no tag, comment or character reference) and links are checked by scheme
(`href: "web" | "link"`), so no HTML or script is stored by any actor. A picture names a `media`
record, which stage 28's step 4 adds. `slug` is a field type: unique among an object's live records
by a partial unique index the reconciler makes on its own table, made from the title when left
empty, its old value kept in `core_slug_redirect` when a published record's slug changes.

**The question schema** (stage 29, step 1, `packages/sdk/src/questions.ts`). A form's questions are
a document field with the platform's one schema, `QUESTIONS_SCHEMA`: `{ items }`, at most 60, told
apart by `kind` (text, email, phone, number, choice, date, rating, yesNo, consent, heading,
paragraph), unique by `key`. Labels are `noMarkup` and a paragraph is rich text's inline runs.
`checkQuestions` adds what the schema cannot say: camelCase keys, a `showIf` that names an earlier
choice or yes/no with no `showIf` of its own and one of its values, a `map` to the Person (name,
email, phone, each from the matching kind) or to a field the destination's intake lists, each
filled once, none on an anonymous form, and no required marketing consent. `checkAnswers` checks
`{ [key]: value }` against one version (types, required when shown, lengths, at most 3 links in a
text, 20 KB in all, nothing for a hidden or unknown question) and gives the answers document a
submission stores (`ANSWERS_SCHEMA`, private: no customer or public read). Its faults carry the
question's key and a fault code, never the value. Wiring these checks into writes (the form's
record, `intake.submit`) is stage 29's later steps.

**`publishable`** ([ADR 0446](adr/0446-publishable-without-its-public-half.md),
[ADR 0441](adr/0441-publishable-states-schedules-and-versions.md),
`packages/core/src/operations/record-versions.ts`, `packages/core/src/records/publish.ts`).
`publishable: { content, slug?, date? }`: the record is the working copy; `record.publish`
(`records:publish`, admins by default; an AI actor's call is always queued for a person holding
`records:publish`, `alwaysReview`, ADR 0480, and refused on approval if the working copy changed
since) snapshots the content
fields as the next version in `core_publish_version` (migration 0470; who approved and, for a
request, who asked and how, migration 0520) and makes it current;
`record.schedulePublish` takes the snapshot now and the minute cron (cos-runner,
`record.publishDue` through the pipeline) makes it current at the set time
(`core_publish_schedule`, migration 0460); `record.unpublish` leaves no version current and keeps
them all; `record.versions`, `record.version`, `record.compareVersions` and
`record.restoreVersion` read, compare and restore. Records get read-only `publishedVersion`,
`publishedAt`, `publishState` (draft, scheduled, published, unpublished: read from the versions
and the schedule, never stored) and `publishAt`. `record.createMany` writes up to 50 records of
one object in one batch, at 4 statements a record for an object with states (ADR 0448).

**What the public reads of content** ([ADR 0442](adr/0442-what-the-public-reads-of-content.md),
[ADR 0443](adr/0443-preview-links.md), `packages/core/src/operations/content.ts`). A publishable
object that declares `public` gets a live view (`pub_x_<ext>_<object>`): one row per live record
with a current version, its content columns that version's values, its other own columns the
record's (its slug, a state `when` tests). The public scope's source is that view, so a draft, an
unpublished record and a deleted one are not in it. `content.get { object, slug }` (a record, or a
`redirect` for an old slug), `content.list` and `content.preview` (with a preview link's token,
the working copy's declared fields) are open to the public, read as the public whoever calls, and
give one not-found for everything they do not show. Their answers are cached in the Worker's cache
keyed by the object's generation (`core_content_generation`), which every committed change to a
record of the object bumps in its own batch (`content/cache.ts`).

**Search over published words** (stage 38, [ADR 0700](adr/0700-the-published-text-index-and-content-search.md),
`packages/core/src/content/published-text.ts`). The published-text index (`core_published_text`
and its FTS5 table, migration 0970) holds each current version's words, one row per section of a
rich text field (split at its headings, each with its anchor: `headingAnchors` in
`@composable-os/sdk/rich-text`, which both content renderers use for the heading's `id` and
`nativeID`), for the content fields the public reads of objects the public reads. It is written in
the publish batch (`publishWrites`: two statements whatever the length, the sections as one JSON
parameter) and cleared in the unpublish one; erase remakes it from a scrubbed version; the minute
cron's `content.reindex` catches it up when a declaration changes and fills it for what was
published before it. `content.search { object, q, cursor? }` (public, customer and staff, read as
the public, cached by the generation) matches every word as a prefix, keeps the best section of
each record, reads the records through the public's seam, and answers slug, title, section
(field, heading, anchor) and a snippet as plain and matching segments.

**Read and understood** (stage 38, [ADR 0702](adr/0702-acknowledgements-read-again-and-a-confirmation-nobody-changes.md),
`packages/core/src/records/acknowledge.ts`, `packages/core/src/operations/ack.ts`). A publishable
object may declare `acknowledge: { who, manage }`: `who` a "must read" document field
(`MUST_READ_SCHEMA`: everyone, or staff roles, pack roles and granted pack permissions), `manage`
a restricted, grantable pack permission. Each version keeps its publisher's choice, read again or
small fix (`read_again`, migration 0971; the first always asks; `record.publish` and
`record.schedulePublish` take `readAgain`, an AI's request carries a suggestion and
`approval.approve`/`approval.decide` take the approver's choice). `ack.confirm` writes a row of
`core_publish_ack` (the person's own, the current version only, once; triggers refuse anything
else and every update and delete); `ack.mine` lists what is to read and what was confirmed; both
reach every pack role (`PACK_ROLE_OWN`). `ack.status` and `ack.overview` are for a person who is an
admin or holds the object's `manage` grant. Who must read is a person's to change, and once a
record is published a manager's. The confirmations are in no `rec_*` view.

**Media** ([ADR 0444](adr/0444-media-the-editor-and-the-content-pack.md),
`packages/core/src/operations/media.ts`, `packages/core/src/http/media.ts`). A base record,
`media` (`core_media`, migration 0461): one original in R2 (`BLOBS`, `media/<id>`), its type read
from its bytes, its size and dimensions. Uploads go to `POST /api/media` (cos-app, staff), which
hands the body to `media.upload` as `ctx.upload`, never in an operation's input. `GET
/api/media/<id>?w=` (cos-app and the client-app binding; `/api/v1/media/<id>` on the host's own
hostname for a phone) streams what `media.serve` allows: staff any live item, outsiders only one
the current version of a record they may read shows in a field they may read
(`core_published_media`, written with the version). A company's site forwards its own
`/api/media/<id>` over the binding (the client template's `mediaRoute`). Widths come from Cloudflare Images when
`IMAGES` is bound. The `image` field type is `{ media, alt, focal? }`. The Trash purge deletes a
picture's row, and a trigger queues its R2 key on the blob deletion path (ADR 0320).

**Video and files** (stage 42, [ADR 0475](adr/0475-video-and-file-media-in-stream.md),
`packages/core/src/operations/media-video.ts`, `packages/core/src/records/stream.ts`). A media
item has a kind (`image`, `file`, `video`; migration 0510). A `file` is a PDF in R2, served as a
picture is, as an attachment. A `video` is held in Cloudflare Stream on the deployment's own
account, reached by the host itself over Stream's REST API with an API token and a signing key
that are cos-app's own secrets (no gatekeeper; the ADR says why): `media.videoUpload` (a person
only) gets a one-time direct upload address (one form post up to 200 MB, tus above), the staff
browser sends the file there, and `media.videoRefresh` keeps Stream's state on the row
(`uploading`, `processing`, `ready`, `failed`). Every video is made to require a signed token,
and is made so again if anything loosened it. Captions are WebVTT tracks
(`POST /api/media/<id>/captions`, `media.captionUpload`), or generated by Stream once an admin
turns that on (`media.settings.update`). A `video` field (`{ media, poster? }`) and a document ref
with `media: "video"` name only a ready video. The purge queues `stream/<uid>` on the blob
deletion path, whose drain deletes it from Stream. `records/stream-fake.ts` is a fake Stream for
tests and local development (`STREAM_FAKE=true`), served at `/api/v1/media/fake-stream/*`.

**Signed playback** ([ADR 0476](adr/0476-signed-playback.md)). `media.play` (staff, customer,
public; `read`) decides as `media.serve` does (staff any ready video; an outsider only one a
published record they may read shows, in a field and a part of it they may read) and answers
with a token the host signs (RS256, the video's id as `sub`, at most an hour, no download) and
where it plays (HLS, DASH, Stream's player, a poster frame), or the one not-found. A token is in
no audit row (`redactResult`).

**Access** ([ADR 0477](adr/0477-the-access-scope.md), `packages/core/src/visibility/access.ts`).
`access: { sources }` on an object: a customer holds access to a record when one of its sources
is live for them; a record source is one of their own records of another of the extension's
objects (an enrolment), in a named state, before its `until`, pointing at the record or at a
record whose published list names it (a bundle). `holdsAccess` is the seam's one question, asked
once per page by `my.list`, `my.get` and `public.*` before a document's `holders` parts are
shown (`redactDocument(schema, value, { holder })`), and by `media.play` and `media.serve` for an
item a published version shows only in a holders' part (`core_published_media.reach`). Other
kinds of source are the host's to add (`registerAccessSource`), with no change to the seam: the
`subscription` kind (stage 32a, [ADR 0488](adr/0488-the-subscription-access-source.md),
`subscriptions/access.ts`) gives a subscription's holder every live record of the object while
the host's record is on trial, active or past due, and until its period's end when it is set to
end; `options: { plans, covers: "all" }` name a plan object of the same extension.

**The import door** ([ADR 0470](adr/0470-the-import-door.md), `packages/core/src/operations/
record-import.ts`, `packages/create-composable-os/src/content-import/`). `cos content import
<folder>` signs a staff member in for the run (native sign-in by code or the system browser, a
loopback redirect), uploads the folder's pictures over `POST /api/v1/media` (a staff device token
only; de-duplicated by SHA-256) and writes the posts with `record.import`: each named by an import
key (`core_import_key`, migration 0501), checked in a dry run first, created once, updated only
while it holds what the import last wrote, a person's edit reported as a conflict. `--publish`
publishes or schedules them with their own dates. The door's generic half (the session, the
sign-in, `record.import` in batches, media by hash) is `src/import-door/`.

`cos courses import <folder>` ([ADR 0495](adr/0495-the-courses-import.md),
`src/courses-import/`) is the same door for a course platform. It uploads videos to Stream
(`media.videoUpload`, tus chunks resumed from Stream's offset) or has Stream copy them from a
link (`media.videoFromUrl`), each kept with a SHA-256 so a re-run finds it. Captions go over
`POST /api/v1/media/<id>/captions` (a staff device token only). The command waits for Stream and
writes only the courses whose videos are ready. It writes access as `courses.enrolment` records
with source `import` (never orders), finding each student by email, and progress by the lesson's
`sourceId`. A student's own progress is reported as a conflict and kept.

**The editor** (`apps/app/src/components/fields/rich-text-editor.tsx`). Rich text fields are
edited with Tiptap, whose schema is the platform's blocks and marks; `toRichText`
(`apps/app/src/lib/rich-text-map.ts`) maps its document to `RICH_TEXT_SCHEMA` at its edge and is
the only thing saved. Publishable records' pages carry the publish controls
(`components/record/publish-card.tsx`).

**Programs** (`packs/programs`, stage 41, steps 1 to 6; [ADR 0448](adr/0448-programs-the-layout-assignments-and-the-log.md)):
an exercise bank, programs whose layout is one document (weeks, sessions, blocks, items, levels,
typed sets, notes for coaches or members), versions, class types, assignments to a person or a
class type that pin a version and make dated sessions carrying their own plans, and a log of every
set against its target. Its tools compose the host's operations: `assign`, `today`, `sessionGet`,
`classToday`, `logAdd`, `logUpdate`, `sessionComplete`, `history`, `progress`, and, for staff,
`draft` (a working copy from a brief, with the `extract` model role) and `importText` (coaches'
shorthand into structured targets, unread lines listed). The staff side is declarations: the
Training dashboard, saved views, the Person page's Training tab and panels. Its headless entry
(`@composable-os/pack-programs/client`) holds the layout's pure edits and a self-saving working
copy; twelve blocks (the program builder, the exercise bank, today and session, class today,
history and progress, the coach's client view; web and native) are built on it. In development
`apps/app` mounts any pack's web block at `/blocks` (ADR 0424, amended); the bank, the builder and
the client view are its screens in the admin (stage 47, ADR 0660).

**Bookings** (`packs/bookings`, stage 31a, step 3 the spine, steps 4 and 5 spending and the
waitlist; [ADRs 0504](adr/0504-the-bookings-pack.md) and [0520](adr/0520-a-waitlist-on-a-claimant.md)):
rooms, coaches, series (`recurring`, making classes in local time, the horizon at least the
longest window a class type opens), classes (places shown exactly, public while scheduled),
closures, and bookings: a claimant on its class, one live per Person per class, windows on its
create and its cancels worked out from the class type's own rule (Bookings' fields on Programs'
`programs.classtype`) or the organisation's setting, a staff-only rule (the class type's, or a
class not scheduled), the requested `cancel` the host resolves to in time or late, and an
allowance spender (`paidBy` the Memberships pack's `membership` and `pass`, the class's start as
its time, its class type and local weekday and minute copied; `waived` for a walk-in paid at the
desk, [ADR 0506](adr/0506-a-spender-paid-another-way.md); `released: "cancelled_by_us"` for its
bookings ahead when a membership ends by cooling off, ADR 0647). It requires Programs. Its tools:
`timetable`, `classGet` (public), `book` (joins a full class's waitlist unless asked not to),
`cancel` (with `state.resolve`'s preview), `leaveWaitlist`, `mine` (with a waiter's position)
(customers), `bookFor`, `cancelFor`, `day`, `classList` (staff). Hooks, web blocks (the timetable,
the desk) and a native timetable marked `noPurchase`. The booking declares its waitlist
(`claims.waitlist`, ADR 0520): joined by a member or staff, promoted by the host. Step 7
([ADR 0553](adr/0553-attendance-the-coach-role-moves-and-cancelling-a-class.md)): the coach role
(`bookings.coach`: `day`, `roster`, `markAttended`, `undoAttended`, `markNoShow`, `markAll`, and
reading classes), ticking from an hour before the class, no-shows by `states.after` 30 minutes
after the end where the list was taken, `move` (the new booking's create with `movedFrom`) and
`cancelClass` (a tool a person approves, the class's only staff way into `cancelled`), and a web
`bookings-class-list` block. Drop-ins (step 8, [ADR 0560](adr/0560-a-paid-line-moves-a-record-that-exists.md)):
the booking declares `sellable.moves`, `buy` (customers and the public) has the host make it
`pending` with its order (`order.startHeld`), and a web `bookings-drop-in` block opens the
provider's page. Messages (step 9, [ADR 0572](adr/0572-bookings-messages-the-dashboard-and-the-coachs-app-screen.md)):
automations through `email-send` to a booking's Person and their live guardians, one recipient an
email (booked, paid, moved in or moved; passed over; a place free after the cut-off; a class's new
time or room; a class cancelled by the gym; the reminder `minutesBefore` its start, [ADR 0570](adr/0570-date-relative-triggers-in-minutes.md);
a drop-in's refund made), with the calendar file email-send makes ([ADR 0571](adr/0571-a-calendar-file-made-by-the-email-gatekeeper.md)),
and admins told in the app of a class whose list was not taken. The Bookings dashboard, saved views
of this month's no-shows and late cancels, and a native `bookings-native-class-list` for the coach
role. After the review ([ADR 0507](adr/0507-what-the-bookings-review-needed-of-the-platform.md)):
a class the host cancels moves its live bookings to `cancelled_by_us` in its batch
(`states.follows`, the state cascade), a closed class binds staff (`create.closed`), a member's
class and holder are create-only (`customer.createOnly`), the booking rules are a person's
(`personApproves`: other actors' writes wait for a person's approval), walk-ins are made with their booking in one
batch (`person.createWith`), an extension tool is not run by the approval queue's dry run, and
the runner carries the packs' sources as a Text module.

**Courses** (`packs/courses`, stage 42; [ADR 0478](adr/0478-the-courses-pack.md)): themes,
courses and bundles (publishable, sellable with a tax code, granting an enrolment), enrolments and
progress, an outline of sections of lessons (video, text, a Programs session, a download) whose
material is for holders. It requires Programs (`requires`, checked at install); progress is
written only with access (`customer.requireAccess`); a session lesson's program is assigned on the
student's first open by an automation calling `x.programs.assign` (a tool's writes start
automations, and a tool or an automation may call another extension's tool). Its tools ask the
host (`access.check`, `public.*`, `my.*`, `order.start`); a lesson names its video and the app asks
`media.play`, so the signing key stays in cos-app. Hooks, web blocks (catalogue, course page,
player, my courses, the course builder) and native blocks marked `noPurchase` (no price, no buy).
Its course plan (`courses.plan`, stage 32a, [ADR 0490](adr/0490-the-course-plan-self-service-and-the-staff-side.md))
is a sellable that recurs; `courses.course` declares the `subscription` access source on it, so a
subscription to it gives every course. Web blocks subscribe (`courses-subscribe`, which shows a
signed-in member's continuation offer in place of the trial) and manage the member's own
(`courses-subscription`: cancel, resume, the provider's portal); the native one
(`courses-native-subscription`) only reads (the offer too, in words), and the block lint refuses a
subscription's billing operations in every native block.

**Memberships** (`packs/memberships`, stage 32b step 6; ADRs
[0510](adr/0510-what-a-subscription-grants.md), [0511](adr/0511-the-memberships-pack-and-passes.md)
and [0512](adr/0512-one-per-person-and-tools-only-a-person-may-call.md)): membership plans
(`memberships.plan`, a sellable that recurs, whose subscription grants a `memberships.membership`
through `sellable.recurring.grants`), pass types (`memberships.passtype`, sellable once, granting a
`memberships.pass` valid for the type's days through `grants.valid`, and an intro offer one per
Person through `sellable.onePerPerson`). Memberships and passes are allowance holders with every
term read-only (the host and the pack's own tools write them), spent by stage 31's
`bookings.booking` by class type (Programs' `programs.classtype`, so it requires Programs) and the
local weekday and minute; only the membership declares `emptyIsUnlimited`. Its tools read the
plans and pass types (public), start a pass's order (`buy`), give a member their holdings with
`allowance.get`'s count (`mine`) and staff a Person's (`holdings`), and give or void a pass by hand
(`givePass`, `voidPass`: `humanOnly`, permission `memberships:passes`, grantable; voiding is a
move only `voidPass` and the host make, `states.moves[].tools`, and a holder's terms are written only
by the host or such a tool, ADR [0513](adr/0513-a-granted-holder-keeps-what-it-was-granted.md)). Web blocks
(plans with the trial and the code sign-in, passes, the member's holdings with their
subscription's cancel, resume, plan change and portal, a Person's holdings for staff with pausing
their membership) and a native block that only reads.

**Plan changes and pauses** (stage 32b; ADRs
[0530](adr/0530-plan-changes-upgrade-now-downgrade-next-period.md) and
[0531](adr/0531-staff-pause-a-membership-for-a-set-time.md); `subscriptions/changes.ts`,
`core_subscription_change`, migration 0630). `subscription.change` (staff; a customer, their own)
moves a subscription to another plan of the same object: dearer is an upgrade, asked of the
provider now (a pending update, prorated, applied only once paid), the same or cheaper a downgrade
from the next period (`proration_behavior=none`). `subscription.pause` and `.unpause` (staff only)
use the provider's pause through a pause schedule, within the plan's
`sellable.recurring.pause` bounds. The row is written in the operation's batch and the gatekeeper
is called after the commit (`afterCommit`), so a refused batch or a dry run asks nothing; the
gatekeeper's actions `payments.subscription.change`, `.pause` and `.unpause` are never
auto-approvable. The host moves nothing until a verified read shows the change: then the
subscription's plan, and what it grants (`followSubscriptionGrant`'s `planChanged`), follow. The
Memberships dashboard ([ADR 0532](adr/0532-the-memberships-dashboard-and-staff-side.md)) reads
`rec_x_memberships_membership`, `rec_subscription`, `rec_order` and `rec_allowance_use`.

**Ticketing** (`packs/ticketing`, stage 27) is the first pack that is not about a CRM: events,
ticket types and tickets, built from these behaviours alone, with tools that compose the host's
operations (`eventsOnSale`, `orderStart`, `myTickets`, `salesSummary`, `checkIn`, `undoCheckIn`)
and hold no rule.
A product turns it on by listing it in `packs`; the CRM does not.

**Pack roles** ([ADR 0436](adr/0436-pack-roles-and-the-door-role.md),
`packages/core/src/pack-roles.ts`). A pack may declare fixed staff roles: the permissions its own
tools declare (`permission: "<pack>:<word>"` on a tool) and the objects of its own a holder may
read. A human admin gives one to a staff account (`user.setPackRole`, `core_user.pack_role`,
migration 0451). While it is held it is all the account may do: the pipeline reads the column on
every staff call and refuses any other operation before its input is parsed, and the account's
own role grants nothing. Ticketing's door role checks tickets in and reads events, ticket types
and tickets. Stage 14a's roles and teams extend this check rather than add another. Tools learn
who started them from the host (`ctx.caller`), to record who checked a ticket in. A role and the
pack permissions granted to its account add up
([ADR 0600](adr/0600-a-pack-role-and-its-grants-add-up.md)): `staffAuthority` decides per call
whether a grant (a tool naming a granted, grantable permission; judged first) or the role allows
it, and the role's limits (Bookings' coach: today only, ADR 0553) travel only on the role's calls
and the runs they start. A tool may name several permissions, any one of which opens it.
A pack may declare a tool permission **restricted**
([ADR 0625](adr/0625-restricted-pack-permissions.md)): a tool naming only restricted permissions is
held by admins and by a grant of it, never by a member's or viewer's own role or by a pack role,
and is never called by an automation or another extension's code (Rostering's `rostering:manage`;
pay in step 6). A human admin grants it, never to their own account.

**Permission grants** ([ADR 0449](adr/0449-permissions-granted-one-by-one.md)). A human admin
grants a staff account named permissions on top of its role (`user.setPermissions`,
`core_user.granted_permissions`, migration 0471): `records:publish`, `orders:refund`, and pack
tool permissions a pack declares `grantable` (Bookings' `bookings:desk`, with plain words for the
admin in `grantableLabels`). Read in the pack role's statement on every call; additive to the role,
and to a pack role for pack permissions only (core ones are refused to such an account, and a
permission a role holds cannot be grantable, ADR 0600); judged beside an operation's `actors`, so a
grant never lets an AI actor publish.

### Orders

An **Order** is a base record in core
([ADR 0427](adr/0427-orders-are-priced-by-the-host-and-paid-only-by-a-verified-payment.md),
`packages/core/src/orders/`). `order.start` takes records and quantities; the host reads each
price from the record, in the deployment's one currency, and stores amounts as integers in the
minor unit. The order's state machine is fixed in core and held by the transition engine. Its
moves to `paid`, `part_paid`, `expired` and `refunded` are `host` moves: the only code that makes
an order paid is `applyVerifiedPayment`, a function the payments gatekeeper's verified webhook
calls, never an operation. It is idempotent by the provider's event id, records a payment that
does not match or arrives late without moving the order, and tells staff. An order may be paid by
a deposit and a balance due by a date; nothing is scheduled or charged automatically.

Buying needs no account ([ADR 0428](adr/0428-buying-without-an-account.md)): a guest gives an
email address, the order belongs to the Person it matches or creates, and the guest reaches that
one order again with a token of which only the hash is stored. `order.start`, `order.view` and
`order.checkout` are the only operations open to the public.

Payments ([ADR 0429](adr/0429-payments-gatekeeper-verified-events-and-refunds.md)) go through
`gatekeeper-payments`, one gatekeeper with Stripe and a fake provider behind a provider-neutral
interface, on the org's own account; its keys are its own Worker secrets. `order.checkout` opens
the provider's hosted page for what `chargeFor` says and sends the buyer back to a listed origin;
coming back changes nothing. The gatekeeper verifies the provider's webhook and delivers a typed
event to the integration host's `PaymentSink`, which stores it in `core_payment_event` and applies
it with `order.applyPaymentEvent { provider, eventId }`: the operation reads the event the host
stored, so no input can describe a payment, and retries on `order_stale`. The minute cron expires
unpaid orders and applies anything left; the daily maintenance tells admins about late payments
and overdue balances. A refund is the gatekeeper's outbound action `payments.refund`, always
reviewed and approved only by a person with `orders:refund`; the order is `refunded` when the
provider confirms. The host's own calls (a checkout, the confirmation email) use
`IntegrationRuntime.callAsHost`. An order's move hook confirms and releases its places
(`orders/holds.ts`), and each move posts on its Person's timeline.

**Tax at checkout** ([ADR 0479](adr/0479-tax-at-checkout.md), `orders/tax.ts`). Prices are
tax-inclusive. When a human admin has turned it on and the lines' objects declare a product tax
code (`sellable.tax`, overridable per object in Settings → Orders), `openCheckout` splits the
payment over the lines in proportion and sends each share with its code, and an event's place,
to the gatekeeper, which asks Stripe for automatic tax (a performance location for an event).
The verified payment carries the provider's tax; `applyVerifiedPayment` stores it on the payment,
the lines and the order, after checking it fits what was asked, and never works one out. The
amount charged is unchanged, so the match rule above holds. Otherwise the checkout is exactly as
before.

**Subscriptions** (stage 32a, ADRs [0485](adr/0485-recurring-billing-the-provider-runs-the-schedule.md)
to [0487](adr/0487-the-payer-and-the-holder.md), `packages/core/src/subscriptions/`). The provider
runs the schedule: it keeps the card, charges each period, retries and ends the subscription; the
host stores no card and schedules no charge. A plan is a sellable object that declares
`recurring`. `subscription.start` records a `core_subscription_checkout` and opens the provider's
page through the gatekeeper (`createSubscriptionCheckout`). For each subscription webhook the
gatekeeper verifies the signature, then reads the subscription (and the invoice) from Stripe now,
with a pinned API version, and delivers that read (`kind: "subscription"`); a subscription the read
shows it did not start, or cannot read, is answered 200 and counted, never retried. The host
applies it in `order.applyPaymentEvent`: the first read makes `core_subscription` from the checkout
it names; later ones move it, as the host, unless the record moved from a later read already or has
ended (events arrive in any order). A read whose price, currency or interval was changed at the
provider applies only what reduces what the member holds. A paid invoice with money on it is an
order born paid, one per invoice, with the period's dates and the provider's tax, flagged when not
paid as agreed (`subscriptions/periods.ts`); its refund is
`order.refund`, and the gatekeeper credits the invoice with a credit note linked to the refund, so
the tax given back is known. Cancel at the period's end and resume are the gatekeeper's actions
`payments.subscription.cancel` and `.resume`, which the host's own call applies at once and an
agent's waits on a person; the record changes only when the provider's event says so. The portal
(`subscription.portal`) is the provider's, for the card and invoices only, and the gatekeeper opens
it only for the host's own call. Staff ending or keeping going someone else's need
`subscriptions:manage`. A subscription keeps its
payer and its holder apart: billing follows the payer, what it grants the holder; staff may start
one held by another Person (`holderPersonId`, a parent paying for a child; a customer may not until
stage 31's family link). A plan whose `recurring` declares `grants` gets one record of the granted
object for the holder, made by the host in the verified event's batch that first reports the
subscription running and moved with every later read, its `until` the moment it stops giving
(`subscriptions/grants.ts`, `core_subscription_grant`, migration 0580, ADR 0510). One free trial
per holder per plan object ([ADR 0489](adr/0489-one-free-trial-per-person-per-plan.md),
`subscriptions/trial.ts`, migration 0531): only for a proved holder (a signed-in customer, or
staff with `subscriptions:manage` for a Person; a guest pays from the start, or confirms their
address with a code on the plan when "anyone starting a subscription" is on, ADR 0459), held by the
checkout (`core_subscription_trial`, a trigger refusing a second unreleased hold, so two starts at
once give one trial), released only when the gatekeeper says its page expired uncompleted
(`getSubscriptionCheckout`), and used when the provider's verified event confirms it. A person
merge moves subscriptions and trials to the survivor. With no event, past due gives access for 30
days of failing, and an active one past its period keeps access while staff are told the events
are not arriving (the minute cron, `subscriptions/sweep.ts`). Staff end one at once
(`subscription.cancel` with `now`) and see subscriptions in the admin's Subscriptions section
(all, trials, failing, ending) and on a Person's page. A new member may end a membership in the
business's **cooling-off period** for a full refund, each refund approved by a person (stage 44 step
7, ADR 0647, below under Agreements). **Continuation offers**
([ADR 0491](adr/0491-continuation-offers.md), [ADR 0492](adr/0492-a-continuation-replaces-the-trial.md),
`subscriptions/offers.ts`, migration 0532) move subscribers from another platform:
`subscription.offer.import` (a person with `subscriptions:manage`, `cos subscriptions offers
import` on the import door) writes `core_subscription_offer` rows (an address matched to its one
live Person, a plan, the paid-up date) with a dry run, the address as the key and conflicts kept;
`subscription.start { offerId }` takes one only for the customer signed in as that address, opening
the provider's page free until the date (`trialEnd`) and never with the plan's trial; the offer
holds that page (a trigger refusing a second, so two takes open one) until the provider says it
expired, and the verified event that makes the subscription marks it taken. Every change to an
offer is made from a current read (its `version`, refused by a trigger otherwise), so a take, an
import or a withdrawal that raced another fails whole; an offer whose plan record is gone follows
to the object's only live plan, or the member is told to ask and staff are told. A holder with an
open offer on a plan object, or a subscription from one that has not ended, gets no trial on it
(`noTrial: "continuation"`); after that the one-trial rule applies. The report
(`subscription.offer.list`, `.export`; the Subscriptions section's Continuation offers) lists who
took theirs and when they are charged from.

**`capacity`** (stage 26, ADRs 0430 to 0433). An object names its places field and, optionally, a
pool (a relation to a parent object with a capacity, one level). The host keeps a counter per record
in `core_capacity`, created and updated by `record.create`, `record.update` and the import in the
record's own batch, and backfilled by the reconciler. A claim (`core_capacity_claim`) is three
statements queued in the owner's batch with no read first: `held + n` on the record's counter and on
its pool's, and the claim row. A CHECK and a trigger refuse a counter past its places, so the whole
batch, order included, is not applied; the refusal is `invalid_input` with the numbers, naming the
counter that refused. Confirm and release are three statements each, idempotent, with no clock: the
owner (an order, from stage 25) calls them. Records carry read-only `held`, `taken` and `available`;
`capacity.get` gives staff the numbers and outsiders only what `show` allows;
`rec_capacity` and `rec_capacity_claim` are queryable.

**`allowance`** (stage 32b, ADRs [0493](adr/0493-the-allowance-behaviour.md) and
[0494](adr/0494-which-holder-pays-and-what-happens-to-uses.md), `packages/sdk/src/allowance.ts`,
`packages/core/src/allowance/`). An object `holds` uses (a pass, a membership: its Person, uses per
total, week or month or unlimited, its dates, live states, zone, and `spendsOn` with conditions) or
`spends` them (a booking: its Person, the holder field, the states that spend and give back, its
time `at` one relation away, fields the host copies onto it and the local weekday and minute).
record.create, record.update and the import spend in the spender's batch when it moves into a spend
state and give back on a return state, and spend again when what the spender points at changes (a
class rescheduled); the holder's terms (`core_allowance`) are derived in SQL from its stored record
in each write's batch and by the reconciler. Another pack's holder pays only where the spender's
`paidBy` lets it. A
spend is three statements with no read of the count: a counter per holder per period
(`core_allowance_period`, the limit copied from the terms), `used + 1` on it, and the use
(`core_allowance_use`); a CHECK and triggers refuse past the limit, or a holder not the Person's,
not live or not valid at the spender's time, so the whole batch fails (`invalid_input`, `rule:
"allowance"`). Periods are named by their local start in the holder's zone (`time/local.ts`).
Holders carry read-only `used` and `left`; `allowance.get` reads a period; `rec_allowance`,
`rec_allowance_period` and `rec_allowance_use` are queryable.

**Agreements** (stage 44, ADRs [0640](adr/0640-agreement-documents-versions-nobody-changes-published-by-a-person.md)
and [0641](adr/0641-agreement-points-a-pack-declares-documents-a-person-attaches.md),
and [0642](adr/0642-acceptances-a-record-nobody-changes-and-who-may-agree-for-whom.md) and
[0643](adr/0643-health-answers-read-by-a-person-with-the-permission-every-read-audited.md),
`packages/core/src/agreements/`, `operations/agreement.ts`, `operations/agreement-acceptance.ts`,
`operations/agreement-retention.ts`, `packages/sdk/src/agreements.ts`; steps 1 to 5 and 8 built,
[0644](adr/0644-enforcement-nobody-pays-or-books-without-what-is-due.md) for step 3). The documents a business asks people to agree to are core tables, not records
(migration 0850), in no `rec_*` view: `core_agreement_document` (its kind, state and working copy),
`core_agreement_version` (each published wording and its terms, with the SHA-256 of everything it
holds, recomputed on read; triggers refuse every update and delete, an insert over an existing id
(so `INSERT OR REPLACE`) and an insert that does not match the working copy at its rev),
`core_agreement_point` and `core_agreement_rev`. Staff with `agreements:manage` (and the assistant
for them, through the gate) write the working copy; publishing it (small change or agree again, now
or from a date the minute cron honours), attaching it to points and retiring it are
`actors: ["human"]`, so no AI actor can do or queue them. An object marks where agreement may be
needed with the `agreements` behaviour (`point`, `label`, `suggests`, and `enter` and `person` for a
record a caller makes); in step 1 it is inert. Every publish, attach, detach, retire and scheduled
version taking effect bumps `core_agreement_rev`. Step 2 (migration 0851) adds
`core_agreement_acceptance` (one record that a person agreed to one version; triggers refuse
every change but settlement, merge and erase, for every statement shape, and check at insert
that the version is open, its hash was shown, a minor is not agreeing for themselves and a
guardian's link is live), `core_agreement_signature` (strokes), `core_agreement_answer` (health
answers: read only by `agreement.answers.get`, `agreements:health`, a person, every read audited
through the pipeline's `auditReads`), `core_agreement_minor`, and the `agreements` kind of
`core_write_guard`. `agreementsDue` (`agreements/due.ts`) is the one place that answers what a
Person must still agree to at a point; a batch that relied on it carries the guard on the
counter, so a change committed between the read and the commit fails it. Every acceptance goes
through `agreements/accept.ts`: `me.agreements.accept` (a customer, for themselves or a live
dependant) and `agreement.recordPaper` (staff, a person). Step 3 enforces it
(`agreements/enforce.ts`): `createOrder` (every order, `order.startHeld` included) and
`startSubscription` (a continuation offer included) ask at the points the bought objects declare,
and `applyTransition` asks when a caller's record enters a state its point lists (`enter`, for its
`person`), never for the host's own moves; something due is `agreements_due`, and the batch carries
the guard (`agreements_changed` when the counter moved). A guest carries their acceptances in the
buying call (`agreements`), recorded with the order or the subscription checkout and no Person;
migration 0853's triggers give them the Person when the order is paid (or the checkout confirmed)
and delete them when an order closes unpaid. Step 4 (migration 0854,
[ADR 0645](adr/0645-the-copy-and-the-signed-pdf-host-mail-and-a-second-attachment.md)) sends the
**copy**: `core_agreement_copy` keeps, beside each acceptance, whether its copy went (the
acceptance never changes); triggers make the row when a person agrees (to the acceptance's own
address) and when a guest's acceptance settles to its purchase (to the address it was bought
with), and `agreement.copy.send` makes one for a paper form (an adult's to the Person's own address; a child's to the live parent or guardian staff pick, recorded as `guardian_id`, at that guardian's own address, ADR 0648, migration 0857; shown first by `agreement.copy.preview` and confirmed; a person
with `agreements:paper`); no caller names an address and none can be changed. Erasing that guardian clears their address from the child's copy and owes its scrub; erasing the child never takes the guardian's address. Idempotency keys are kept apart by the class of queue sending (`hostPurpose`), the copy's refused to any other, and a caller's `listSent` never shows the host's agreements, sign-in or orders mail.
`agreements/copy.ts` sends it after the commit, and the minute cron sends what did not go, through
`callAsHost` with purpose `agreements`: the host's own mail, applied unless the deploy-time floor
denies it, with a system origin so no AI's outbound check reads it, and the idempotency key
`agreement-copy:<id>` (a crashed send is retried with the same key; a new key only after a try
the gatekeeper proved was not sent; an unknown outcome is never retried). The email gatekeeper
attaches `agreement.pdf`, made by the PDF writer (`packages/pdf`, a package of its own: standard fonts, every
text a hex string, deterministic; shared since stage 35 with the invoice and receipt renderers, ADR 0737) from checked values (`validate.ts`), only for the host's
agreements queue (`isHostAgreementMail`) and only in the copy's shape; health answers have no
field there (the copy says they are in the app). The same writer draws the downloads
(`apps/app/src/server/http/agreement-pdf.ts`): `me.agreements.pdf` (a customer, their own and a
linked child's, also over the client-app binding), `agreement.acceptance.pdf` (staff, a person,
answers only with `agreements:health`, every download audited) and `agreement.version.pdf` (a
version's blank form for paper. Step 5 is the screens: base-layer blocks over a headless entry
in the typed client's runtime (`packages/client/src/agreements.ts`: `createAgreementsHooks`,
`agreementRefusal` and `withAgreements`, which read a buying or booking call's refusal and try
once more on `agreements_changed`, the form's checks and input, and `StrokeRecorder`, which records
a drawn signature in the host's stroke format within its limits). `web-agree` and `native-agree`
(the Agree form, the signature pad on pointer events or React Native's touch responder, and the
inline step), `web-agreements-due` and `native-agreements-due` ("Before you go on") and
`web-my-agreements` and `native-my-agreements`. Bookings' drop-in and timetable blocks (web and
native) and Memberships' passes and plans blocks show the step inline when the host refuses "Pay",
"Book", "Buy" or "Join" with what is due; a visitor reads the words through
`agreement.guestVersions` (open to the public: only the versions in effect a guest is asked) and their
acceptances travel in the buying call.
Step 8 (migration 0855,
[ADR 0646](adr/0646-erase-merge-and-retention-for-agreements.md)) is **erase, merge and
retention**: erase (`agreements/people.ts`) deletes an erased Person's health answers, minor mark,
health notices and a buyer's acceptances on an unpaid order or unconfirmed checkout at once,
turns down and redacts a waiting copy's approval, and keeps the rest of each acceptance detached
(`erased_at`) for `agreement_retention` years (default 7, a human admin's setting); only staff with
`agreements:manage` find (`agreement.kept.find`, by address or name, audited) and open a kept one,
and may hold it (`core_agreement_hold`). The daily cron's `agreement.purgeKept` (a host step,
bounded, silent when nothing is due) deletes what is past the period with its copy row, signature
and answers; migration 0855's triggers refuse every other delete. A copy that ever reached the
email gatekeeper owes a **scrub** (`scrub_due_at`): the host asks each email-send gatekeeper the copy
reached (`via`), through its own agreements queue only (`callAsHost`, method `scrubAgreementCopy`), to drop the copy's journal
records, refuse any later send under its key and blank its history lines; a send in flight during
the erase is scrubbed after it. Merge moves acceptances unchanged (`agreement.mergePlan` counts
them for the preview). Signing at the desk is a later step (`docs/stages/44-agreements.md`).

**Cooling off** (stage 44 step 7, [ADR 0647](adr/0647-cooling-off-a-new-member-ends-it-for-a-full-refund-a-person-approves.md)):
a plan's pack names a number setting of its own as the plan's cooling-off days
(`sellable.recurring.coolingOff`, a person's to change, 0 to at most 90, off by default; the
Memberships pack's `coolingOffDays`). `subscriptions/cooling-off.ts` is the one definition of who
may: a subscription started here without a continuation offer, inside the window (from the host's
record of the provider's confirmation to the end of the last local day, in the business's zone),
with something paid, once per holder (migration 0856's trigger), the days those kept on its
checkout at the start, for good. `subscription.coolingOff` (customer, their own as payer; staff)
answers it for up to 20 subscriptions in a fixed number of statements; the blocks show the button
only when it says so. `subscription.coolOff` (the payer, or staff with `subscriptions:manage`; a
person only) writes `core_subscription_cool_off` in its batch and, after the commit, asks the
payments gatekeeper to end the subscription now. A valid ask is made inside the window and fixes
a deadline seven days later (the gatekeeper's approval expiry, `DEFAULT_APPROVAL_EXPIRY_DAYS`);
asking again (the member inside the window, staff before the deadline) is a new request to the
provider (`askKey`) and never moves the deadline; while a cancel of it waits for a person at the
gatekeeper nobody may ask again, and every such cancel is kept
(`core_subscription_cool_off_action`). While it is open, any end the provider reports
(whatever its reason) is the cooling off's, bounded by the ask less a five-minute tolerance and the
deadline; one statement owes back each order paid up to the window's end or after the ask and up
to the end (`core_sellable_refund_due`, `entered: "cooled_off"`), the same bounds as the figure
shown; "paid" is the provider's time for a period's payment (`core_order.provider_paid_at`), not
when the host processed it. At the deadline the minute cron's `subscription.coolOffSweep` (a host
step; an idle tick invokes nothing) lapses an open one, rejecting every cancel of it still waiting
at the gatekeeper (one the provider shows ended waits a day at most for its event), and the
ordinary cancel works again; staff may finish a lapsed one (the window's payments only): the
provider is asked to end it (retried with the same key, admins told once if it cannot be done),
and the row is `ended` only in the batch of the provider's event that shows it ended. Once per
holder: the ask, the finish and the end check it before writing, and an end is always recorded
(one for a holder who used theirs lapses the row as not counted). The end's batch releases
nothing: `subscription.coolOffRelease`, run by the minute cron in its own batch, moves the bookings
ahead the membership paid for, and the member's own waiting places it would pay for, into their
spender's `released` state (`allowance.spends.released`: Bookings' `cancelled_by_us`), 15 a step
and one step a minute tick (so the scheduled invocation stays under D1's 1,000 statements),
then one summary email goes to the member, claimed before it is sent. The minute cron
asks the gatekeeper for each refund, which waits for a person with `orders:refund` (ADR 0429).
Nothing refunds a card on its own.

Two reasons this is the centre of the design. Extension tools cannot run several writes as one
transaction, so anything that must be atomic (take the last place and create the order) has to be
the host's. And a rule in the host holds for a person, an MCP client, an import and a client app
alike, and can be simulated for approval.

### Packs and blocks

Stages 24, 27 and 28; [ADR 0401](adr/0401-platform-packs-screens.md).

A **pack** is a shipped extension plus headless hooks over the typed client, released with the
platform. A **block** is a screen for a pack in a web skin (Radix or Base UI under shadcn-style
components) or a native skin (React Native), copied into the client repo from a registry and owned
there. Blocks hold no rules.

As built (stage 24; ADRs [0420](adr/0420-packs-as-packages-as-built.md),
[0424](adr/0424-blocks-as-built.md)): a pack is `packs/<id>/` (the extension, `client/` hooks,
`blocks/`), published as `@composable-os/pack-<id>`; a release carries every pack in the repository
(its runner bundles them, its client kit lists them in `packs.json`), and a deployment installs the
ones `COS_PACKS` names (`*`: the release product's own). A named pack the release does not carry is
a loud failure, never dropped (ADR 0420 as amended). The API contract files are the union over the
carried packs, each tool named with its `pack`; a deployment serves `forPacks(file, installed)`. A block is a folder with a `block.json` (pack,
skin, operations, files, dependsOn, packages) in `blocks/` or `packs/<id>/blocks/`, MIT, shipped
in the release's client kit and copied with `cos add`. The web base layer (`blocks/ui-*`) is
generated from `packages/ui` (Radix underneath); the native base layer is `blocks/native-base`;
sign-in ships in both skins. `scripts/check-blocks.mjs` (in `pnpm lint`) refuses a block that
calculates a price, checks a capacity or checks a permission.

**Screens in the admin** (stage 47, [ADR 0660](adr/0660-pack-screens-in-the-admin.md)): a shipped
pack declares its staff screens (`screens` in its manifest: label, web block and export, `nav`,
the tools in `opens` that gate it, and `record` for a tab on a record page); a runtime extension
declaring any is refused. `apps/app/screens-plugin.ts` reads every pack's declaration at build
time and emits `virtual:cos-screens`, one lazy chunk per screen (a missing block or export fails
the build; the server's build holds none), so the admin's source names no pack. The core read
`screens.mine` answers which screens the caller may open (the pack active and shipped, and the
pipeline's `staffAuthority` for every gate tool, as a person; empty for any other actor; the one
core read every pack role reaches). The admin's navigation, `/s/<pack>/<screen>` (client-only,
"not found" when not listed) and the record tabs render that answer; each screen sits in an error
boundary, with its pack's hooks over the staff client on the app's own origin
(`src/lib/staff-client.ts`), and its data is forgotten when it closes. An account with a pack role
gets a small shell (its screens, its account, sign out) that makes no call its role is refused;
every other server function and `/api/*` route refuses it, and MCP holds it to its role
(ADR 0436).

**My account** (stage 48, [spec](stages/48-my-account.md)) is base-layer blocks over a base
headless entry in the typed client's runtime (`packages/client/src/account.ts`:
`createAccountHooks`, `accountSections`, `loadOrders`, the words for orders, subscriptions and
sessions). Step 1 is built: the shells `web-account` and `native-account` with their base sections
(`*-account-details`, `*-account-devices`, `*-account-family`, `*-account-orders`,
`*-account-payment`, and the agreements blocks), and the subscriptions part
(`web-account-subscriptions`, `native-account-subscriptions`) for the packs' sections to use, all
over operations that already existed (`me.*`, `my.list` on `order` and `orderLine`,
`subscription.*`). Orders is the one list of a customer's orders: a page of 20, then their lines in
one `my.list` naming the page's orders. Payment method shows for a customer who pays a
subscription that has not ended. The packs' sections are passed to the shell in `sections` for
now; `me.portal`, the `portal` declaration, `me.attention` and the generated wiring are later
steps. In the app, money opens the website ([ADR 0714](adr/0714-the-app-shows-money-and-opens-the-website.md)):
the native shell shows orders and subscriptions, and "Manage on the website" opens the business's
website account page; no native block calls a billing operation. The template's `/account` route
and the mobile Account tab are plain pages over the same entry.

| Pack | Built from | Status |
| --- | --- | --- |
| Deals | `stages` | exists |
| Leads, lifecycle | fields, tools | exists |
| Ticketing | `states`, `capacity`, `sellable`, `customer`, `public`, `customerVia`, a `timezone` field, a pack role, payments | stage 27: objects, tools, check-in and the door role built |
| Programs | `document`, `publishable` (no public half), `states`, `customer`, `signedIn` | stage 41: steps 1 to 6 built (the spine, the dashboard, views and Person tab, hooks and blocks, draft and import); Ghetto's app is step 7 |
| Content | `publishable`, rich text, slugs, media | stage 28: steps 1 to 6 built (rich text, `publishable` completed, public reads, media, the editor, the pack: posts and categories, hooks, web and native renderers); the first client's import and blog routes are its own repository's |
| Courses | `publishable`, `sellable` (grants and a tax code), `access` and holders' parts, `states`, `customer` with `requireAccess`, `requires: ["programs"]`, video media and `media.play` | stage 42: steps 1 to 4, 6, 7 and the draft built ([ADR 0478](adr/0478-the-courses-pack.md)); the import and the first client to come |
| Bookings | `recurring`, `capacity` and `claims` with a waitlist, `unique`, `staffed` (a class is its coach's shift, stage 45), `states` with windows, staff-only rules and a requested cancel, `allowance` (spender, `waived`), `public`, `customer` with `guardians`, `customerVia`, `requires: ["programs"]` | stage 31a: steps 1 to 6 built (the behaviours, the pack's spine, [ADR 0504](adr/0504-the-bookings-pack.md); spending with the Memberships pack's memberships and passes, and the waitlist with promotion, [ADR 0520](adr/0520-a-waitlist-on-a-claimant.md); parents booking for their children, [ADR 0540](adr/0540-the-family-link.md)); step 7, attendance, moves and cancelling a class; step 8, drop-ins with `sellable.moves`, [ADR 0560](adr/0560-a-paid-line-moves-a-record-that-exists.md)); step 9, messages, the reminder, the dashboard and the coach's app screen, [ADR 0572](adr/0572-bookings-messages-the-dashboard-and-the-coachs-app-screen.md); step 10 to come |
| Rostering | `recurring` (duty series, a horizon from its setting), `staffed` (a duty shift is its person's shift), `states`, a pack role (`rostering.team`), grantable and restricted permissions, the roster's rules (`staffing`), the host's tool-only `staffing.*` operations | stage 45: step 4 built (duties, duty series and shifts, the team role, the roster's tools, settings, [ADR 0626](adr/0626-the-rostering-pack-and-bookings-additions.md)); step 6 built (pay periods: `rostering:pay`, restricted and a person's only, who is counted, totals, the not-worked mark, lock, reopen and export, [ADR 0627](adr/0627-pay-periods-the-basis-the-totals-the-lock-and-the-export.md)); step 5 built (each person's private calendar feed: `feed`, `feedRotate`, `feedRevoke`, [ADR 0628](adr/0628-the-staff-calendar-feed-and-the-shared-calendar-writer.md)); step 7 built (the screens as blocks over `@composable-os/pack-rostering/client`, my calendar among them, role clients with grants, `cos rostering import`, [ADR 0629](adr/0629-the-rosters-screens-role-clients-with-grants-and-the-roster-import.md)); checklists (4b) to come |
| Memberships | `allowance` (holders), recurring billing with `recurring.grants` and `recurring.pause`, `sellable.onePerPerson`, `humanOnly` tools, `requires: ["programs"]` | stage 32b: steps 5 to 7 built (the behaviour, the pack, plan changes and pauses, the dashboard, views and blocks); the import (step 8) to come |

### Client repos

Stage 24; [ADR 0401](adr/0401-platform-packs-screens.md).

One repository per company, started from a template: `apps/web` (TanStack Start), `apps/mobile`
(Expo) where needed, `extensions/` for the org's own objects, copied blocks, and the product
definition. The web app is its own Worker with a service binding to the host. It never opens D1.
The staff admin and the MCP surface are the host's and are not rebuilt per client.

As built so far (stage 24; ADRs [0420](adr/0420-packs-as-packages-as-built.md),
[0421](adr/0421-the-client-app-binding-and-customer-sign-in.md)):

- **`cos`** ([ADR 0422](adr/0422-client-repos-and-one-command-as-built.md)) is the one command:
  `create` (also `npm create composable-os`), `init`, `deploy`, `upgrade`, `add`, `diff`,
  `client generate`, `ext`, and `install` for a product with no client repo. Everything a client
  repo takes from the platform (the template, the skills, the blocks, the API contract) comes from
  the **client kit** inside the verified release its `product.ts` names
  (`defineClientProduct({ platform: { version, release, repository }, packs, web, mobile })`).
- **Deploying** (`cos deploy`): `cos ext check` on `extensions/` and a type check of the apps
  first; then the host from the release, with `COS_PACKS` from the product and the org's own
  extensions in BLOBS pinned by `COS_ORG_EXTENSIONS` (installed by the runner as shipped, with
  no approval); then the built web app with its one binding. A first install names the host
  for the client's product through the deployment state's name maps and sets its label
  (`COS_PRODUCT_LABEL`), with the verified release unchanged (ADR 0422 amended, issue #155).
  It checks the product's packs against the release's `packs.json` only, sets
  `CUSTOMER_AUTH_URL` to the web app's origin and makes `CUSTOMER_AUTH_SECRET` once, and installs
  the gatekeepers `product.ts` names with their settings
  ([ADR 0452](adr/0452-gatekeeper-settings-in-product-ts.md)).
- **Role clients and browser calls** ([ADR 0451](adr/0451-role-clients-staff-in-the-mobile-app-and-browser-calls.md)):
  a mobile app that lists a pack role gets a client with only that role's operations (from the
  release's `api/v1/roles.json`); staff sign in in it apart from customers. A role listed with
  grants (`{ role: "bookings.coach", grants: ["rostering:roster"] }`) gets the tools those grants
  open too, from `roles.json`'s `grants`
  ([ADR 0629](adr/0629-the-rosters-screens-role-clients-with-grants-and-the-roster-import.md)). A pack's hooks give
  any client the hooks it holds the operations of, and a block takes only the hooks it calls
  ([ADR 0453](adr/0453-pack-hooks-over-the-clients-operations.md)). A web app's
  `operationRoute` passes the browser's allowed calls to `HOST`, same origin only.
- **Environments** ([ADR 0450](adr/0450-client-environments.md)): `product.ts` may declare
  several deployments (`staging`, `live`), each its own host in the same account (`<id>-staging-app`;
  `live` keeps `<id>-app`), deployed with `cos deploy --env <name>`.
- **The template** (`templates/client`): `apps/web` (TanStack Start, `src/host.ts` framework-free)
  and `apps/mobile` (Expo, `--with-mobile`; its `src/host.ts` signs in and keeps a device session).
- **npm** ([ADR 0423](adr/0423-npm-packages-from-the-release-commit.md)): client, sdk, product,
  cli, each pack and `create-composable-os`, built from the release commit, dry-run on every
  release, published only when turned on.
- **The binding.** The web app binds to cos-app's `ClientApp` entrypoint
  (`apps/app/src/server/http/bound.ts`). It serves customer sign-in (`/api/customer-auth/*`) and
  the HTTP surface, through `invoke()`, and nothing else. The caller is the customer whose session
  cookie the web app forwards, verified by the host, or the public: never staff (no staff session
  is read, and a bearer token is refused), and never a caller the web app names.
- **Sign-in on the company's hostname.** The web app forwards the address and the code; the host
  answers with a host-only customer cookie, which the web app passes through, so the browser keeps
  it for the web app's hostname. `CUSTOMER_AUTH_URL` is the web app's origin. Staff cookies stay on
  the host's address. `customerSession` in `@composable-os/client` forwards the customer cookie
  and no other.

### Skills

Stage 21; [ADR 0405](adr/0405-skills-ship-with-the-platform.md).

Instructions for agents, in `skills/`: `write-extension` and `add-automations-tools-dashboards`
(stage 21), and `start-client-app` and `add-block` (stage 24), which are for client repos. A
release's client kit carries them all as a client repo reads them: a paragraph between
`<!-- platform-repo -->` markers is swapped for its `<!-- client-repo -->` text (in a client repo
a gap is reported, not closed). `cos create`, `cos init` and `cos upgrade` write them to `skills/`.
Each is one `SKILL.md` in four parts (when to use it, the steps, the rules, the check command),
plain Markdown that points at the SDK and at Deals. `.claude/skills/` links to them and
`AGENTS.md` points other agents at the folder. `skills/CONTRACT_VERSION` holds the contract
version they describe; `scripts/check-skills-version.mjs`, part of `pnpm lint`, fails when the
SDK's `CONTRACT_VERSION` differs. There is no eval of the skills.

Every skill ends in the same checker:

```
cos ext check <dir>                      extension.check (in a deployment)
  read the directory's .ts/.js files       host.evaluate: the workspace's files or a commit
  buildExtension      ─┐ @composable-os/   ─ the same functions, in cos-runner
  typecheck           ─┘ extension-check     (the type check in its own Dynamic Worker)
  evaluate in Node (no host modules)       evaluate in a Dynamic Worker (no host modules)
  checkEvaluated(db, id, evaluated) ────── checkEvaluated(db, id, evaluated)   packages/core
    contract, formulas, automations          the same
    dry-run reconcile: an empty local        dry-run reconcile: the deployment's D1
    SQLite with packages/db/migrations
```

The command evaluates the extension in the caller's Node process, with the caller's authority, as
its tests do; the sandbox is the host's. Extensions the one under check names (`deals.deal`) are
read from the directories beside it and reconciled into the local database first. Issues print
with a file and line, the path into the manifest, the message and the fix where the check has
one; the exit code is 0 only with none. `apps/runner/test/same-issues.test.ts` and
`packages/extension-check/test/check.test.ts` hold the host and the command to one list of issues
for the same broken fixtures. `cos ext test <dir>` runs the extension's Vitest tests, after
refusing an extension with a tool or automation named in no test file. `cos ext` runs in a
checkout of the repository (`pnpm cos ext ...`); how a client repo gets it is stage 24.

### Trust boundaries

| Code | Runs where | May |
| --- | --- | --- |
| Platform | Host Workers | Everything, by release only |
| Shipped extension (pack) | Runner, as `extension:<id>` | What its manifest's permissions grant |
| Runtime extension | Runner, as `extension:<id>` | The same, after approval as a diff |
| Client app, server side | The client's Worker | Call operations as the signed-in customer, or the public, over the `ClientApp` binding; never as staff |
| Client app, on a device | Phone, browser, TV | The same, with the user's session |

No row of this table can loosen identity or approval policy. Only a human admin can.

### What is not decided

- Realtime: live records shared between two people, and counts that update as a door is scanned.
- Push notifications to client apps.
- Whether the hosted control plane (stage 10, now `products/crm/apps/control`) serves products
  other than the CRM.
- The licence for blocks.
