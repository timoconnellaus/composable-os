# ADR 0412: The customer scope and the outside principals, as built

Status: accepted, 2026-11-20 (stage 22 build, step 3). Builds part of
[ADR 0402](0402-staff-and-customers.md) on the seam of
[ADR 0410](0410-the-seams-first-door-as-built.md).

## Context
ADR 0402 decided that a customer sees only records whose declared customer field is their own
Person, field by field, and that this is enforced at the visibility seam and not in each
operation. The stage 22 spec named the principals and the audit actor. It did not say how a call
with no staff user runs through a pipeline written around one, how the field limit is applied, or
what "writes are checked the same way" means for a handler that queues its own SQL.

## Decision

### Principals
- `Principal` is `staff` (`userId`, `role`), `customer` (`customerId`, `personId`) or `public`.
  The seam and the audience check read nothing else about a caller.
- **A call from outside the org has its own context type,** `OutsideInvocationContext`: a
  principal and a database, with no `user` and no `actor`. `invoke()` takes either context. A
  context that carries both a user and a principal is refused, and so is a principal that is not
  a whole customer or public principal. Which one a call is comes from the adapter, from the
  session it verified, and from nothing in the input.
- **`customer` and `public` are audit actors, not gate actors.** `ACTORS` (what the approval
  policy, the queue and an operation's `actors` are about) is unchanged. Migration 0400 lets
  `core_audit` and `core_audit_read_counts` hold the two new actors, with the customer account's
  id in `user_id`.

### The pipeline for an outside call
`audience → validate → gate → handler → write check at the seam → audit`, in `invokeOutside`.
- There is no role or permission check. The audience is the permission, and the seam decides
  which records.
- **The gate allows or refuses** (`evaluateOutsideGate`): reads and writes are allowed and
  nothing else, in code, whatever the preset. The deploy-time floor's `*` rows can only refuse,
  and one that asks for review refuses, because nothing is ever queued.
- **The handler gets no staff capability.** Reading `ctx.user`, `ctx.actor` or `ctx.pipeline`
  throws. Models, integrations, the extension host and nested invocation are absent.
- **Errors are cleaned.** An error an operation raised on purpose goes out as it is. Anything
  else, and any `internal` error, goes out as its code with no message of its own and no
  details: no SQL, no column or constraint name.
- **Audit:** a write is audited with its field diffs. A successful read is counted per account
  and operation (ADR 0090). A failed read writes nothing, because a caller with no account could
  make any number. A refused or failed write is audited.
- A customer's change becomes a record event and an embedding like any change, with actor
  `customer`.

### The customer scope in `visibleSource`
- An object declares `customer: { field, read, write }` on its definition in the field registry.
  `field` is a relation to one person (`id` on a person). `customerProblems` checks it.
- **Rows and fields are limited in the source itself.** For a customer `visibleSource` returns
  `(SELECT id, <listed columns> FROM rec_x WHERE <customer column> = ?) AS rec_x`. A column that
  is not listed is not in the source, so no filter, sort, select or handler can reach it, by
  design or by mistake.
- **`visibleObject(ctx, object)` is the object as the caller may see it:** for a customer, `id`
  and the readable fields only. `runListQuery` validates filters and sorts against it, so one on
  an unlisted field fails with the words an unknown field gets.
- **Nothing by default.** A customer on an object that declares no customer, and the public on
  any object, get the unknown-object answer. `visibleTable` (the table, with the Trash) is
  refused to both.
- `listVisible` and `getVisible` are the generic reads `my.list` and `my.get` will wrap.

### Writes
- **The pipeline checks every recorded change at the seam before the batch commits**
  (`assertVisibleWrites`). For a customer each change must be a create or an update, on a record
  the seam shows them (one read per object, through `visibleSource`), touching only fields in
  `write`. A create must name the caller as the customer; an update may not change it. The
  public change no record.
- A record the caller may not see is answered as a record that is not there. A field they may not
  see is answered as a field that does not exist. A field they can read but not write is named.

## Why
- A separate context type means staff code is never handed a customer by accident: the compiler
  refuses, and at run time `ctx.user` throws. Widening `actor` everywhere was tried and touched
  25 staff handlers for no gain.
- Limiting columns in the source, not in each mapper, is what makes "never appears in a
  response, filter, sort or error" a property of one function.
- The write check runs on recorded changes because that is the one description of a write the
  pipeline has: handlers queue SQL of their own.

## Consequences
- **A write that is not recorded is not checked.** A handler that queues SQL and calls no
  `recordChange` passes the seam. Operations open to customers are reviewed code, and the
  generated list names them, but this is the limit of the check.
- **`write` lists what a customer may set, on every path.** A pack's tool that must set a field
  the customer cannot (a cancel that sets `status`) is refused today. Step 6 has to decide how
  a tool's own writes are authorised: see the open questions in the stage 22 report.
- A customer may not delete, restore, merge or erase a record through any operation.
- Migration 0400 rebuilds `core_audit` (as migration 0020 did). On a deployment with a large
  audit log this copies every row once.
- A deployment whose floor sends all writes to review (`{"*":{"write":"review"}}`) refuses every
  customer write.
- The SDK's `customer` key, accounts, sign-in and `me.*` and `my.*` are later steps. Until then
  only test fixtures declare a customer.
