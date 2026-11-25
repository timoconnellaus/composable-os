# ADR 0574: An idempotency key on an email send

Status: accepted, 2026-11-23 (stage 31a step 9, the review of PR #256). Extends
[ADR 0114](0114-own-gatekeepers-pickers-and-host-modules.md) (email-send).

## Context
An automation sends a class's emails in one step (a step name is declared, and called once). A
step that fails part way (the connection drops on the fourth of twelve) is retried by the Workflow
from its start, and the gatekeeper queued the first three again: members got the same email twice.

## Decision
- **`send()` takes an optional `idempotencyKey`** (1 to 200 letters, digits or `. _ : -`). A
  second send with a key the sender's facet has seen answers with the first send's receipt and
  queues nothing; a send still being made with it is refused for a moment (a crash leaves that
  for at most five minutes). The facet remembers the last 2,000 keys. The key is not part of the
  stored message: the approver and the recipient never see it.
- **Bookings keys each email by the run and its place in it** (`<runId>:<n>`): a retry of the same
  run builds the same letters in the same order (its compose step's result is stored), so the
  retried step re-sends nothing it already sent.

## Proof
`packages/gatekeeper-email-send/test/calendar.test.ts` (the same key twice: one submission, the
same receipt; a malformed key refused), `packs/bookings/test/automations.test.ts` (a gatekeeper
failing on the second email, the run retried: each address once, keys `run:0` to `run:3`).

## Amended 2026-11-23, after the second review of PR #256: what is covered
- **Covered**: a send step retried within a run (the Workflow's own retries, and the waits of
  ADR 0573 while a queue is full); and a **retry** of a failed run, however many times, because a
  retry carries the run its chain began with (`event.originalRunId`) and Bookings keys each email
  by it (`<originalRunId ?? runId>:<n>`), with the compose step's letters replayed from the journal
  in the same order.
- **Not covered**: a **replay** (a fresh run on purpose: it sends again), and a key forgotten after
  the sender has seen 2,000 more. Keys are remembered per sender address (the connection's
  resource), not per extension: two extensions sending through one sender share the space, and
  their keys carry their own run ids.
- Bookings' coalescing turn (ADR 0572) is likewise held by the first run of the chain, and given up
  only after its send succeeds (its own step), so a compose or send step that fails and is retried
  still tells.

## Amended 2026-11-23 (ADR 0590)
Routine mail is keyed by the host, not the pack: each email's row by the run its chain began with,
the kind, the message, the record and the recipient, and its send by `routine:<row id>`.

## Amended 2026-11-24 (issue #286): keys per caller
Keys are no longer kept per sender address for every caller. The host's own mail had its own
spaces already (ADR 0645); now each ordinary caller has one too: the integration host's queue
names who is calling (`callerKeySpace`, from how it opened the queue, never from the message): a
person, the assistant or an agent job by actor and person; an MCP app by person and connected app;
an automation by its id (so its runs and their retries share it); extension code by its extension.
The gatekeeper keeps that caller's keys under a hash of the name, and prunes each caller's 2,000
most recent on its own, so one caller never answers, pre-claims or evicts another's key. Bookings'
and routine mail's keys are unchanged. A queue that names no caller (a host older than this) keeps
its callers in one space, as before.

Proof: `packages/gatekeeper-email-send/test/agreement.test.ts` (an ordinary caller's keys are its
own), `apps/runner/test/agreement-copy.test.ts` (through the real integration host: a person, two
MCP apps, the assistant and two automations under one key, each its own send and its own retry).
