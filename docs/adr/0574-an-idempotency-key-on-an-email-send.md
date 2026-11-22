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
