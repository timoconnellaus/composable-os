# ADR 0416: Idempotency keys, as built

Status: accepted, 2026-11-21 (stage 23 build, step 2). Builds part of
[ADR 0403](0403-http-surface-and-typed-client.md).

## Context
ADR 0403 and the stage 23 spec decided that every write over HTTP carries an `Idempotency-Key`,
that the host stores the key with the principal, the operation, a hash of the input and the
response in the same batch as the write, that the same key and input returns the stored response
without running the handler, that a different input is refused, and that keys are purged after
24 hours. They did not say what happens to two calls with one key at once, to a response an
operation computes after its commit, or to a call that fails.

## Decision
- **Migration 0410** adds `core_idempotency_key` (a write that committed: scope, key, operation,
  input hash, the claim that committed it, status and response) and `core_idempotency_claim` (a
  call with that key is running). Both are keyed by `(scope, idempotency_key)`.
- **The scope is the principal:** `staff:<user id>`, `customer:<account id>`, or `public`. A key
  is 16 to 128 characters of letters, digits and `. _ : -` (a UUID will do), so a key is not
  guessable even in the public's shared scope. A key sent with a read is ignored.
- **The key row is inserted in the write's own batch.** The pipeline gains `inBatch` on its
  invocation contexts: statements an adapter commits with the call's writes, called once per
  batch (the applied batch, or the batch that queues a staff write for review), never for a read
  and never inherited by a nested call. So the key and the write commit together or not at all,
  and a second batch for a key that committed fails on the primary key and applies nothing.
- **The same key twice:** a key that committed returns its stored response, byte for byte, with
  `Idempotent-Replayed: true`, without running the handler. **The same key at once:** before it
  runs, a call takes a claim; a second call with the same key and input waits (up to ten
  seconds) for the first's response and returns it, so the handler runs once. A claim older than
  a minute was left by a call that died and is taken over; if the old call still commits, the
  key's primary key keeps the write from applying twice.
- **The same key with another input or another operation** is refused: `invalid_input`, 422,
  `details.reason` `idempotency_key_reused`. **A write without a key** is refused: 400,
  `idempotency_key_required`. A malformed key: 400, `idempotency_key_invalid`. These answers come
  after the operation is looked up, so a closed operation still answers as unknown.
- **A call that fails before it commits stores nothing**, and its claim is released: a retry
  runs again. A response computed after the commit (an operation that reads its output back) is
  filled in just after it, under the claim; a failure after the commit is stored as what the
  caller was sent. A key whose response was never filled in (the Worker died between) answers
  `conflict`, `idempotency_response_lost`.
- **A staff write queued for review** stores its `pending_approval` reply in the batch that
  queues it, so a retry does not queue it twice.
- **The daily maintenance cron purges** keys and claims older than 24 hours
  (`purgeIdempotencyKeys`), in chunks.

## Why
- Inserting the key in the write's batch is what makes "applied once" a property of the
  database, not of timing: two batches cannot both commit one key.
- The claim is what makes "runs the handler once" true for two calls at once. Without it both
  handlers would run and one batch would fail, which is safe but not what the spec says.

## Consequences
- A write over HTTP costs more D1 work than the same write elsewhere: the claim and its release
  (two writes), the key row in the write's batch, and three small reads by primary key. Reads
  cost nothing more.
- Other surfaces are unchanged: server functions, MCP and host modules take no key.
- The typed client (step 3) creates a key per mutation and keeps it across retries.
