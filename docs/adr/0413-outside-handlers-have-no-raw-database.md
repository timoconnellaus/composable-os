# ADR 0413: A handler called from outside the org has no raw database

Status: accepted, 2026-11-20 (stage 22 review of steps 1 to 3). Tightens
[ADR 0410](0410-the-seams-first-door-as-built.md) and
[ADR 0412](0412-customer-scope-and-principals-as-built.md).

## Context
The one-seam test is a ratchet: 180 reads of record views and tables are still outside the seam,
in helpers that take a database or a `Reader`. They are safe only while no operation open to
customers or the public calls one. ADR 0412 also left a gap: the write check saw only changes a
handler chose to record, so a handler that queued SQL and recorded nothing passed.

## Decision
- **On a customer's or the public's call, the operation's handler gets no database and no write
  queue.** `ctx.db`, `ctx.write`, `ctx.recordChange` and `ctx.postActivity` throw, as `ctx.user`,
  `ctx.actor` and `ctx.pipeline` do. A helper that needs a database cannot be handed one.
- **Records are reached through `ctx.records`,** bound by the pipeline to its own reader:
  `list`, `get`, `count` (what the caller may see) and `create`, `update` (what they may change).
- **A write helper builds the statements and records the change together.** It checks the
  caller's fields and that the record is theirs, then runs the same code `record.create` and
  `record.update` run (validation, the stage behaviour, search, history), in a host context the
  handler never sees. An unrecorded write cannot exist. On create the customer field is the
  caller, and it is never accepted from the input.
- **`assertVisibleWrites` still runs on every recorded change before the batch.** For a change
  made through a helper it re-checks the record and the customer field. What the host set beside
  the caller's fields (a stage's status) is the host's doing.
- **One escape, `hostInternal: true`,** on a core operation that is open outside the org, for
  account and session bookkeeping that is not a record: sign-in, sign-out, sessions, deleting the
  account. It keeps `ctx.db` and `ctx.write`. The registry refuses it on an `x.*` operation and
  on an operation that is not open. `open-operations.json` shows it per operation, so every use
  is a line in a diff. A change such an operation records itself is checked in full.
- **Staff handlers are unchanged.** They also have `ctx.records` for reads; its writes are for
  customers and throw for staff.
- **A core object's update goes through a registered writer** (`setCoreWriter`), so `me.update`
  changes a Person with the Person code and still passes the seam's field and row checks.

## Also decided at the review
- A deploy-time floor that asks for review does not apply to outside callers, who are never
  queued. A floor that denies still denies.
- Migration 0400 drops the CHECK on `core_audit.actor` and `core_audit_read_counts.actor`. The
  pipeline refuses an actor it does not know before anything is written.
- An audience refusal has no audit row and no counter. A failed read by an outside caller writes
  nothing. `customer.write` stays a subset of `customer.read`. A customer deletes no record in
  this stage.

## Why
"Only staff can reach the unmoved reads" is now true by construction, not by nothing being open
yet: the only code that runs for a customer with a database in hand is the pipeline, the seam and
the operations named `hostInternal` in a generated, reviewed file.

## Consequences
- An operation for customers is written against `ctx.records`. Anything else it needs from the
  host is a new seam helper or a `hostInternal` operation, and both are visible changes.
- The seam's writes cover extension objects, and core objects that register a writer. A customer
  cannot create a core record through them.
- A pack's tool called by a customer runs through this same path (ADR 0414).
