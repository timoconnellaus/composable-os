# ADR 0022: Approval queue and simulation

Status: accepted, 2026-11-04 (stage 2 interview).

## Decision
- A gate `review` outcome records a **pending action** instead of failing. Pending actions group into **change sets**: per MCP session by default, or explicitly with `changeset.begin` and `changeset.commit`. They expire after 7 days by default.
- The caller gets `pending_approval` plus a **simulated** result. Only the originating session sees simulated state in its reads. Creates get **provisional IDs** that are bound to real IDs on approval. Everyone else, including the UI, reads real data, and the UI shows pending-change badges on affected records.
- Dependencies are tracked: rejecting an action rejects its dependents, and out-of-order approval is refused.
- Approval re-runs each action through the pipeline as the original actor, with decision `approved`. If the world has changed, the action fails cleanly and its dependents are skipped.
- **Balanced** for actor `mcp`: every `bulk-write`, `destructive` and merge operation goes to review, whatever its size. This amends the stage-1 thresholds in ADR 0018 for `mcp`.

## Why
This is the Cloudflare OS model. Agents finish whole tasks without stalling, and humans review one coherent change set later, in bulk. Being explicit about "pending" keeps Claude honest with the user.

## Amendment, 2026-11-04 (stage 2 build)
How sessions, simulation, dependencies and applying work is recorded in ADR 0032. In short: the
MCP session is the connected app (the stateless transport has no protocol sessions), simulation
is a dry run of the handler whose record changes are stored on the pending action, and approval
re-runs each action through the pipeline as its original actor.


## Amendment, 2026-11-22 (a queued extension tool had already run)
**What was wrong.** The dry run ran an extension tool's handler, and that handler runs the tool's
code in its sandbox. The tool's own operation calls go through the pipeline as new invocations by
the extension (actor `extension`, which may write without review), and its `storage` writes go
straight to the database. The dry run discarded only the tool call's own writes, and it has none.
So when a tool's risk sent it to review, its changes were made while the pending action waited,
and approving made them a second time. That applied to an AI assistant, an MCP client, an
automation, another extension or, under a review floor, a person: a `destructive` tool under
Balanced, a `write` tool under Cautious, a `bulk-write` tool from MCP under Balanced, and any tool
the deployment floor reviews. An automation's test mode (ADR 0133) ran tools for real the same way.

The same class of fault was open in the pipeline itself:
- an operation a dry-run handler ran through `pipeline.invoke` was a real nested invocation
  (committed, or queued separately);
- a handler that wrote without `ctx.write` wrote for real;
- a handler that reached another runtime acted for real. `automation.run`, `retry`, `replay` and
  `cancel` started or changed runs. `update.rollback` rolled back. `subscription.cancel` under a
  floor asked the provider to cancel. `order.refund` in test mode submitted a refund to the
  gatekeeper (held there as an outbound action).

The tool fault dates from stage 3a (2026-11-04), when tools were added, and test mode's from
stage 5. Both are in every release from v0.1.0-beta.1 to v0.1.0-beta.9.


**What the pipeline now does in a dry run** (`approvals/dry-run.ts`). This covers the queue's dry
run, an agent grant's dry run, test mode, and every operation those run through `pipeline.invoke`,
reads included:
- the database handle is read-only (`CrmDb.readOnly()`). A statement runs only if, with its
  comments and quoted text set aside, it is a single `SELECT`, `VALUES` or a `WITH` that prefixes
  no write. Anything else is refused when it runs, and `pipeline.crm.batch` refuses. Statements
  built for `ctx.write` are discarded as before, and `recordChange` and `recordHostChange` are
  collected for the preview;
- every key of the handler context is classified in `CONTEXT_KEYS` as database, runtime or plain
  data, checked against `HandlerContext` by the type checker: a new key that is not classified does
  not compile, and every runtime must have an entry in `RUNTIMES`. Each runtime answers only the
  read methods listed there; any other method is refused before it reaches the runtime. The
  dashboard cache's `put` is dropped instead. In `aiEnv` the settings and secrets are strings and
  read through, and the raw AI binding is refused whole. No guarded runtime answers `then`, so
  awaiting one (or an RPC stub behind it) calls nothing;
- per kind, what may run for real in a dry run or test mode: database reads, the extension
  host's workspace reads, connected apps' type and resource listings, stored blob and media
  reads, the search index's query, AI settings' status and usage, releases and manifests,
  thread search, the judge's "is it on". No model is run, not even `embed`: spend is not a read.
  No gatekeeper is called (`integrations.call` is a read operation but dispatches to the
  gatekeeper);
- a write that reaches a refusal stops its dry run. The call is queued with no preview and the
  note "Runs on approval: it uses …"; a refusal the handler catches is noted too. A read that
  reaches one (in test mode, or nested in a dry run) answers the placeholder
  `{ $notRunInTestMode: true, operation, note }` instead of failing. Test mode lists it under
  `notRun` and on the step's operation; a dry run notes it on the queued action;
- an operation run through `pipeline.invoke` is simulated (test mode's path) over its own overlay,
  layered on the session's. What it would do is visible to the rest of the dry run, joins the
  outer preview, and never lands in the session's overlay, so no dependency on an action that
  does not exist. A nested call refused in a dry run (forbidden, denied, failed) writes no audit
  row: it did not happen;
- an extension tool that may write is not run at all. It runs once, when a person approves it.
  In test mode its call answers the placeholder. A read tool runs in a read-only sandbox. Its
  operation calls run under a simulation of their own, as nested reads do, so it has no events,
  no audit, no read counts and no model. It is not recorded as a run, and nothing it does there
  counts towards quarantine. If its sandbox refused something, it counts as not run.

**Applying an approved action** (approval.ts, pipeline.ts):
- its own changes, and those of every call it makes, are checked against the preview the reviewer
  approved before each commits: a record changed since it was queued fails the action;
- its provisional ids bind to every record it creates, its own and those its calls create, in the
  order the dry run made them, so a follow-up naming one applies to the real record;
- whole or not at all. Before its first call commits, the dry run is run again. If a call it
  makes would need its own approval, nothing of it is applied. It stays pending with the reason
  "Waiting: … calls X, which needs its own approval", and no decision event is sent. What depends
  on it in the same approval stays pending too. It applies whole once X no longer needs approval
  (for example under another policy), or it is rejected. The note on the queued action says this
  in advance. If the check passes but a call still needs review when the action runs (what it read
  changed in between), the calls before it have committed and cannot be rolled back. The action
  then ends `failed` with reason "Partly applied: …" naming the pending call, what depends on it is
  skipped, and the pending call can be approved on its own.

**Read tools.** A tool declared `risk: "read"` runs with a read-only sandbox, in a dry run and
outside one (`RunState.readOnly` in the runner). Its `ops.call` is refused for anything but a
read operation, its storage answers only `get` and `list`, and it has no gatekeeper module. In a
dry run it has no model either. No shipped read tool writes, so none needed changing.

**Not covered**, so this is not "by construction" beyond the list above:
- code that runs outside a handler's context: the adapters' post-commit and post-queue hooks
  (never run for a simulated call), the integration host's own approval queue (it gates
  gatekeeper side effects as `outbound` for the calling actor), and the sandbox of a write tool
  run after approval. A write tool's own calls are separate invocations by the extension, each
  gated on its own, so a write tool is not applied whole: what it did before a call of its own was
  queued stays done;
- a runtime reached other than through the handler context: a module-level import that opens a
  binding, or a direct `fetch` with a secret read from `aiEnv`. None exists in core today; a new
  one would bypass the guard;
- a read method with a side effect inside the runtime that answers it. Each method on the read
  lists was checked as a read on 2026-11-22;
- the `ctx.simulation` checks handlers still make (media, erasure, email confirmation, extension
  installs) are there so their preview is useful, not to keep them safe.

**Upgrading.** The code that queues a tool now writes `simulated.notRun`. Migration 0600 marks every
`x.*` action that is still pending and has no `notRun` (`simulated.toolRanAtQueue`), so actions
queued by the fixed Workers are never caught, whatever order the Workers and the migration go
live in. The inbox says such a tool already ran when it was queued, so approving would repeat its
changes, and recommends rejecting. Nothing is rejected automatically.

**What a reviewer sees.** A queued tool has no diff preview, because nothing has run. The
Approvals inbox and the chat's card title it by the tool and its extension ("Convert (leads
tool)"), say nothing has run and that what it changes is decided when it runs, and list its
inputs. Any action with an empty preview, or notes from its dry run, shows its inputs the same way.
Its title carries how many records it touches ("Run automation (500 records)"). The dry run's
notes are shown under it, and the caller's `pending_approval` message says the same.
