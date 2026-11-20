# Stage 26: Capacity and holds

Read first: [`AGENTS.md`](../../AGENTS.md), [`docs/architecture.md`](../architecture.md)
(Behaviours), [`CONTEXT.md`](../../CONTEXT.md) (Hold), ADR
[0404](../adr/0404-behaviours-are-the-vocabulary.md), [stage 25](25-states-orders-payments.md),
and ADRs 0002, 0018, 0024, 0100, `packages/core/src/invoke.ts`,
`packages/core/src/records/`, and
`docs/research/cloudflare-cost-audit.md`.

Status: spec proposed. Builds on stage 20. Independent of stages 22 to 24.

## Goal

A record can have a limited number of places, and the platform never gives out more than there
are, whoever asks and however many ask at once. Someone who starts paying has their places held
for a few minutes; if they do not finish, the places come back by themselves. This is the one rule
ticketing, class bookings and appointment slots all share, so it is built once, in the host.

## What exists today (from the code)

- Every operation's writes go out as **one D1 batch** with the audit row (`invoke()`, ADR 0018). A
  D1 batch is a transaction: if a statement fails, none of it is applied.
- Extension objects are written by the generic `record.*` operations. A tool's calls are separate
  operations, so a tool cannot check a count and then write safely.
- Nothing counts places. A number field on a record is just a number.
- The runner has a minute cron (used by the duplicate scan and others).

## Scope

### The `capacity` behaviour
- An object declares `capacity`: the number field holding how many places there are (empty means
  unlimited), and optionally `pool`, a relation to a parent record whose capacity is also drawn on.
  A ticket type has 50 places; its event has 200 across all types.
- For each record with a capacity the host keeps a counter row: places, held, taken. The record's
  own field stays the place staff edit; the counter is the host's.
- The contract exposes read-only values on the record: `available`, `held`, `taken`.

### Claims
- A **claim** is places taken from a capacity for a reason: a hold while paying, then a confirmed
  claim once paid. Claims are rows naming the record, the quantity, the state (`held`,
  `confirmed`, `released`), what they are for (an order line, later a booking) and, for a hold,
  when it expires.
- Taking a claim and changing the counter happen in the same batch as the write that needs them.
  The counter cannot exceed its places: the database refuses the statement, so the whole batch,
  including the order it belonged to, is not applied. There is no check-then-write.
- A claim on a record with a pool claims on the pool in the same batch. Either both succeed or
  neither does. One level of pool only.
- A refused claim is `invalid_input` with details `{ rule: "capacity", object, record, asked,
  available }`.

### Holds
- A hold has an expiry, set by the object's declaration (`holdFor`, default 10 minutes, bounded).
- An expired hold still counts as taken until it is swept. The minute cron releases expired holds
  through the operations pipeline (`capacity.sweep`, audited by count like other purges). So the
  platform may briefly under-sell after an expiry and can never over-sell.
- Confirming a hold after it expired but before it was swept succeeds. After it was swept it must
  claim again, and may be refused.

### With orders (stage 25)
- An order line for a record with a capacity takes a hold for its quantity in the batch that
  creates the order. If any line's hold is refused, no order is created.
- The order's `paid` move confirms its holds, in the same batch. `cancelled` and `expired` release
  them.
- A payment that arrives for an order whose holds were already released is the stage 25 "late
  payment" case: staff are told, and nothing is silently oversold.
- Whether a refund releases places is declared per object (`releaseOnRefund`, default true).
- If this stage is built before stage 25, it ships with the host-side functions and a fixture, and
  the order wiring lands with stage 25.

### Changing a capacity
- Staff may raise places at any time. Lowering them below `held + taken` is refused with the
  numbers. Emptying the field (unlimited) is allowed; setting one on a record that already has
  more claims than the new number is refused.
- Deleting a record with confirmed claims is refused. Trash releases nothing by itself.

### Seeing it
- `capacity.get { object, id }` (staff; and customer and public where the object allows) returns
  places, held, taken and available.
- `rec_capacity` and `rec_capacity_claim` views for `query.sql` and dashboards.
- The record page shows a capacity panel on objects that declare one.

### Cost
- A claim adds a fixed number of statements to the batch: one counter update per level and one
  claim row. No read is needed before the write.
- A sweep is bounded per run and indexed on expiry.

## Out of scope
- Waitlists, and offering a released place to the next person.
- A queue or waiting room for an on-sale rush.
- Seat maps or any place that has an identity. Places are a count.
- Limits per person ("at most 4 each"). That is a rule on what is sold (stage 27).
- Overbooking on purpose.
- Time slots and calendars (the `recurring` behaviour, later).

## Acceptance criteria
1. **Never oversold:** 500 claims of 1 made at once against 100 places yield exactly 100 held and
   400 refusals with the specified details. The same with a pool of 60 over two records of 50
   yields 60.
2. **All or nothing:** a batch whose second claim is refused leaves no trace of its first claim
   or of the record it was creating.
3. **Expiry:** a hold past its time is released by the next sweep and its places can be claimed
   again; before the sweep it still counts; confirming it before the sweep succeeds.
4. **Lowering:** setting places below `held + taken` is refused with the numbers, for every
   actor, including an import.
5. **Orders** (when stage 25 is present): creating an order holds; paying confirms; cancelling
   and expiring release; a refund releases when declared; a late payment after release notifies
   staff and claims nothing.
6. **Every actor:** the rule holds for people, MCP clients, extensions, imports and approved
   pending actions, and the approval queue's dry run reports a refusal without claiming.
7. **Cost:** a claim's statement count is fixed and asserted; a sweep's `rows_read` is within a
   budget.
8. `pnpm lint typecheck test` pass in CI. ADRs, `CONTEXT.md` (Hold, and Behaviour amended) and
   `docs/architecture.md` are updated.

## Dependencies
- Stage 20. Stage 25 for the order wiring; the two can be built in either order.

## Migrations and numbers
Migrations 0440 to 0449. ADRs 0430 to 0434.

## Suggested build order
1. The counter, the claim rows and the refusing constraint, with the concurrency test first.
2. The `capacity` declaration in the SDK and the reconciler; the read-only values.
3. Holds, expiry and the sweep.
4. Pools.
5. The order wiring.
6. The panel, the views and the operation.

## To settle at the interview
- **How the refusal is made in D1.** A constraint that fails the statement is proposed, because
  it needs no read and fits the one-batch pipeline. Confirm it against D1's behaviour under
  concurrency before building, with the test in criterion 1.
- **Whether D1's write rate is enough for an on-sale rush,** and if not, whether a Durable Object
  in front of a hot record is in scope later.
- **The default hold time** and its bounds.
- **One level of pool or more.** A festival with days, areas and ticket types wants more.
- **Does a dry run for approval see holds made since it was simulated.**
