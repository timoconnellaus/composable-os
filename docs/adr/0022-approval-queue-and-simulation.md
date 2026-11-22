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
straight to the database; the dry run discarded only the tool call's own writes, which are none.
So when an AI assistant, an MCP client, an automation, another extension or (under a review
floor) a person called a tool whose risk the gate sent to review (a `destructive` tool under
Balanced, a `write` tool under Cautious, a `bulk-write` tool from MCP under Balanced, any tool the
deployment floor reviews), the tool's changes were made while the pending action waited, and
approving made them a second time. An automation's test mode (ADR 0133) ran tools for real the
same way. The same class of fault was open in the pipeline itself: an operation a dry-run handler
ran through `pipeline.invoke` was a real nested invocation (committed, or queued separately), and
a handler that wrote without `ctx.write` wrote for real. It was there from stage 3a (2026-11-04,
when tools were added), so in every release from v0.1.0-beta.1 to v0.1.0-beta.9.

**What is guaranteed now.** A dry run causes no real effect, by construction in the pipeline
(`approvals/dry-run.ts`) rather than by each handler checking `ctx.simulation`:
- an extension tool is not run in a dry run at all (the pipeline does not call its handler, and
  the handler also returns at once when `ctx.simulation` is set). It runs once, when a person
  approves it, and its own calls then go through the gate as before;
- an operation a dry-run handler runs through `pipeline.invoke` is simulated (test mode's path over
  the dry run's overlay): its gate is evaluated, nothing is committed, queued or sent. If it would
  itself wait for review, the dry run ends there and only the outer call is queued;
- the database handle a dry-run handler gets is read-only (`CrmDb.readOnly()`): a statement that
  writes (insert, update, delete, replace, DDL) is refused when it runs, and `pipeline.crm.batch`
  refuses to commit, so a handler that writes directly fails instead of writing. Statements built
  for `ctx.write` are discarded, as before.

Not covered by the pipeline, and so not by this guarantee: a handler's own calls to other runtimes
in a dry run (the integration host, the extension host's other methods, models, mail). The ones
that act are guarded where they are made (`ctx.simulation` checks in media, erasure, email
confirmation, extension installs), and the gatekeepers gate their own side effects as `outbound`.

A queued tool has no diff preview, because nothing has run. The Approvals inbox and the chat's
card title it by the tool and its extension ("Convert (leads tool)"), say that nothing has run
and that what it changes is decided when it runs, and list the inputs it will run with; the
caller's `pending_approval` message says the tool has not run.
