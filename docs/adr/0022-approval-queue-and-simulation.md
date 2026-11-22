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
run, an agent grant's dry run, test mode, and every operation those run through `pipeline.invoke`:
- the database handle is read-only (`CrmDb.readOnly()`): a statement is run only if, after its
  comments and quoted text are set aside, it is a single `SELECT`, `VALUES` or a `WITH` that
  prefixes no write. Anything else is refused when it runs, and `pipeline.crm.batch` refuses.
  Statements built for `ctx.write` are discarded, as before;
- every runtime on the handler's context (the extension host, the integration and gatekeeper host,
  stored blobs, media, models, the judge, the updater, the search index, AI settings, the events
  queue, the automation host, assistant threads, voice, agents, the host's mail, the dashboard
  cache) answers only the read methods listed in `RUNTIMES`. Any other method is refused before
  it reaches the runtime. The dashboard cache's `put` is dropped instead. Model calls are refused
  except `embed`;
- a refusal stops the dry run: the call is queued with no preview and a note, "Runs on approval:
  it uses …". A refusal the handler catches is still noted;
- an operation run through `pipeline.invoke` is simulated (test mode's path) over its own overlay,
  layered on the session's. What it would do is visible to the rest of the dry run, joins the
  outer preview, and never lands in the session's overlay, so the queued action depends on no
  action that does not exist. If the nested call would itself need review, only the outer call
  is queued, with a note. When the outer is approved and the nested call is queued for real, the
  outer ends `failed` with reason "Waiting: it calls …" and error code `pending_approval` naming
  the nested action. It is not applied and not re-queued. Its dependency on the outer is dropped,
  so approving the nested action finishes the job. Anything else the outer would have done is not
  done; it is asked for again;
- an extension tool that may write is not run at all (the pipeline does not call its handler, and
  the handler returns at once under `ctx.simulation`). It runs once, when a person approves it.
  In test mode its call answers `{ $notRunInTestMode: true, operation, note }`, and the report
  lists it under `notRun` and on the step's operation. A step that reads a field of the tool's
  output gets `undefined`.

**Read tools.** A tool declared `risk: "read"` runs with a read-only sandbox, in a dry run and
outside one (`RunState.readOnly` in the runner). Its `ops.call` is refused for anything but a
read operation, its storage answers only `get` and `list`, and it has no gatekeeper module. In a
dry run it has no model either. No shipped read tool writes, so none needed changing; the shipped
packs' tests pass under this.

**Not covered**, so this is not "by construction" beyond the list above:
- code that runs outside a handler's context: the adapters' post-commit and post-queue hooks
  (never run for a simulated call), the integration host's own approval queue (it gates
  gatekeeper side effects as `outbound` for the calling actor), and the sandbox of a write tool
  run after approval;
- a runtime reached other than through the handler context, such as a module-level import that
  opens a binding. None exists in core today; a new one would bypass the guard;
- a read method that has a side effect inside the runtime that answers it. Each method on the
  read lists was checked as a read on 2026-11-22.
- `ctx.simulation` checks that handlers still make (media, erasure, email confirmation, extension
  installs) are there so their preview is useful, not to keep them safe.

**Upgrading.** Migration 0600 marks every `x.*` action still pending when it runs:
`simulated.toolRanAtQueue`. The inbox says such a tool already ran when it was queued, so
approving would repeat its changes, and it recommends rejecting. Nothing is rejected
automatically.

**What a reviewer sees.** A queued tool has no diff preview, because nothing has run. The
Approvals inbox and the chat's card title it by the tool and its extension ("Convert (leads
tool)"), say nothing has run and that what it changes is decided when it runs, and list its
inputs. Notes from the dry run are shown under the action. The caller's `pending_approval`
message says the same.
