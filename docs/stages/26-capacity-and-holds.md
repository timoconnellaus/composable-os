# Stage 26: Capacity and holds

Read first: [`AGENTS.md`](../../AGENTS.md), [`docs/architecture.md`](../architecture.md)
(Behaviours), [`CONTEXT.md`](../../CONTEXT.md) (Hold), ADR
[0404](../adr/0404-behaviours-are-the-vocabulary.md), [stage 25](25-states-orders-payments.md),
and ADRs 0002, 0018, 0024, 0100, `packages/core/src/invoke.ts`,
`packages/core/src/records/`, and
`docs/research/cloudflare-cost-audit.md`.

Status: **spec agreed** (interview 2026-11-20 and 2026-11-21). Builds on stage 20. Independent of
stages 22 to 24.

## Goal

A record can have a limited number of places, and the platform never gives out more than there
are, whoever asks and however many ask at once. Someone who starts paying has their places held
for a few minutes; if they do not finish, the places come back by themselves. This is the one rule
ticketing, class bookings and appointment slots all share, so it is built once, in the host.

## Decided at the interview (2026-11-21)

The owner answered the first question and then asked the coordinator to take the recommended
answer to the rest and keep moving. Any row but the first can still be overridden.

| Question | Decision |
| --- | --- |
| When a place is held | **When the order starts, for as long as the order is unpaid.** A hold has no clock of its own: the order's expiry (15 minutes by default, stage 25) is the only one |
| Places coming back | Within about a minute of the order expiring, when the minute cron expires the order. The platform may briefly show fewer places than there are and can never sell more |
| Levels of shared capacity | **One:** a record and one parent (ticket type → event) |
| What the public sees | **Each object chooses:** the exact count, a low-stock warning, or only available / sold out. Staff always see the real numbers |
| A refunded order | Its places go back on sale by default; an object can say no |
| Staff selling beyond the limit | **No.** Staff raise the capacity first, which is audited, and then sell |
| An on-sale rush | Prove it never oversells under 500 simultaneous buyers and measure the speed. No queue or waiting room, and no Durable Object in front of a record |
| Left out | Waitlists; seat maps or any place with an identity; a limit per person (stage 27); time slots and calendars (stage 31) |
| How the refusal is made | A constraint that fails the statement, so the batch is not applied. The build proves it with acceptance criterion 1 before anything else, and stops and reports if D1 does not behave that way |
| A dry run for approval | It reports against the counter as it is when simulated and claims nothing. The approved action claims when it runs and may be refused then |

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
- It also declares `show`, what customers and the public are told: `exact` (the number left),
  `low` (available, "only N left" at or below a declared threshold, or sold out) or
  `availability` (available or sold out). The default is `availability`.
- For each record with a capacity the host keeps a counter row: places, held, taken. The record's
  own field stays the place staff edit; the counter is the host's.
- The contract exposes read-only values on the record: `available`, `held`, `taken`.

### Claims
- A **claim** is places taken from a capacity for a reason: a hold while paying, then a confirmed
  claim once paid. Claims are rows naming the record, the quantity, the state (`held`,
  `confirmed`, `released`) and what they are for (an order line, later a booking).
- Taking a claim and changing the counter happen in the same batch as the write that needs them.
  The counter cannot exceed its places: the database refuses the statement, so the whole batch,
  including the order it belonged to, is not applied. There is no check-then-write.
- A claim on a record with a pool claims on the pool in the same batch. Either both succeed or
  neither does. One level of pool only.
- A refused claim is `invalid_input` with details `{ rule: "capacity", object, record, asked,
  available }`. `object` and `record` name the counter that refused: the pool's when the pool is
  full (decided at the spine review, 2026-11-21).

### Holds
- A hold belongs to what it was taken for and has no clock of its own. Whatever owns it confirms
  it or releases it, in the batch of its own write. There is no `holdFor` and no separate sweep of
  holds: two clocks could release a place under an order that is still allowed to be paid.
- For an order, the clock is the order's. Stage 25's minute cron moves an unpaid order to
  `expired`, and that move releases its holds. Until then the hold counts, so the platform may
  briefly under-sell after an expiry and can never over-sell.
- A payment verified while the order is still `pending`, even past its time, confirms the holds:
  they are still there.

### With orders (stage 25)
- An order line for a record with a capacity takes a hold for its quantity in the batch that
  creates the order. If any line's hold is refused, no order is created.
- The order's `paid` move confirms its holds, in the same batch. `cancelled` and `expired` release
  them.
- A payment that arrives for an order whose holds were already released is the stage 25 "late
  payment" case: staff are told, and nothing is silently oversold. If staff honour it, the
  `expired` → `paid` move claims again and is refused when the places have gone.
- Whether a refund releases places is declared per object (`releaseOnRefund`, default true).
- If this stage is built before stage 25, it ships with the host-side functions and a fixture, and
  the order wiring lands with stage 25.

### Changing a capacity
- Staff may raise places at any time, and that is the only way to let one more person in: no
  permission sells beyond the limit. Lowering them below `held + taken` is refused with the
  numbers. Emptying the field (unlimited) is allowed; setting one on a record that already has
  more claims than the new number is refused.
- Deleting a record with confirmed claims is refused. Trash releases nothing by itself.

### Seeing it
- `capacity.get { object, id }` returns places, held, taken and available to staff. To a customer
  or the public it returns only what the object's `show` allows, worked out in the host.
- `rec_capacity` and `rec_capacity_claim` views for `query.sql` and dashboards.
- The record page shows a capacity panel on objects that declare one.

### Cost
- A claim adds a fixed number of statements to the batch: one counter update per level and one
  claim row. No read is needed before the write.
- Releasing an order's holds is a fixed number of statements per line, like claiming them.

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
3. **Release:** releasing a hold returns its places, which can be claimed again; until it is
   released it counts; confirming it succeeds however old it is; releasing or confirming twice
   changes nothing.
4. **Lowering:** setting places below `held + taken` is refused with the numbers, for every
   actor, including an import.
5. **Orders** (when stage 25 is present): creating an order holds; paying confirms; cancelling
   and expiring release; a refund releases unless the object says no; a late payment after
   release notifies staff and claims nothing, and honouring it claims again or is refused.
6. **Every actor:** the rule holds for people, MCP clients, extensions, imports and approved
   pending actions, and the approval queue's dry run reports a refusal without claiming.
7. **Cost:** the statement counts of a claim, a confirm and a release are fixed and asserted. The
   time for the 500 claims in criterion 1 is measured and recorded in the PR.
8. **What the public sees:** for each `show` value, a customer's and the public's `capacity.get`
   returns only what it allows, and staff get the real numbers.
9. `pnpm lint typecheck test` pass in CI. ADRs, `CONTEXT.md` (Hold, and Behaviour amended) and
   `docs/architecture.md` are updated.

## Dependencies
- Stage 20. Stage 25 for the order wiring; the two can be built in either order.

## Migrations and numbers
Migrations 0440 to 0449. ADRs 0430 to 0434.

## Suggested build order
1. The counter, the claim rows and the refusing constraint, with the concurrency test first.
2. The `capacity` declaration in the SDK and the reconciler; the read-only values.
3. Holds: confirm and release, idempotent.
4. Pools.
5. The order wiring.
6. The panel, the views and the operation, with `show`.

The spine is steps 1 and 4: the constraint, the concurrency test and the pool claim in one batch.
The coordinating model reviews those before the rest is built.
