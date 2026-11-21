# ADR 0435: `sellable`: what may be bought, and what a paid line grants

Status: accepted, 2026-11-21 (stage 27, build step 1). Builds on ADRs
[0404](0404-behaviours-are-the-vocabulary.md),
[0426](0426-who-moves-a-record-and-what-follows-a-move.md),
[0427](0427-orders-are-priced-by-the-host-and-paid-only-by-a-verified-payment.md) and
[0431](0431-the-capacity-declaration-and-the-counter.md).

## Context
Stage 25 built orders and left what may be bought to an interim list platform code filled by
hand (`registerSellable`), with a local-only switch (`ORDERS_DEV_SELLABLE`) so the dev buy page
could sell Deals. Ticketing needs the rest of ADR 0404's `sellable`: an extension saying in its
manifest that an object is for sale, the host holding a line to the record's own rules (when it
is on sale, how many one order may hold), and the host creating what was bought (a ticket per
place) when the order is paid, in the batch that marks it paid, so a paid order and its tickets
exist together or not at all. A tool cannot do that: its calls are separate operations, and no
extension code may hook a write.

## Decision

**An object declares `sellable`** (`SellableSpec`, `packages/sdk/src/sellable.ts`):
- `price`, a currency or number field, in the currency's major unit; `currency` (ISO 4217),
  optional, defaulting to the price field's own and then the deployment's;
- `saleWindow: { from?, until? }`, date or datetime fields (a date covers its whole day, UTC);
- `maxPerOrder`, a number field;
- `deposit: { amount, balanceDue }`, the stage 25 deposit, both fields required;
- `grants: { object, set, void }`, what a paid line grants.

It is additive and optional, so the contract version does not change. The reconciler stores it
with the object's definition and the field registry carries it (`ObjectDefinition.sellable`, with
registry field names). **An order line may point only at a record of an object that declares
it**; there is no other way to make something sellable. `registerSellable` and
`ORDERS_DEV_SELLABLE` are gone.

**The host holds a line to the record's rules,** in `priceLines`, which every way of starting an
order goes through, for every actor and in the approval queue's dry run, before anything is
written. Outside the window: `invalid_input` with `{ rule: "sale_window", line, from, until }`.
Over the most per order: `{ rule: "max_per_order", line, max, asked }`. An empty value leaves
that rule open. Not enough places stays stage 26's `{ rule: "capacity" }`. A refused line leaves
no order.

**Granting is declarative and the host's.** A move hook on the order (`orders/grants.ts`, ADR
0426) runs when the order is first paid: the move to `paid` or `part_paid` from `pending`, or from
`expired` when staff honour a late payment. For each line whose object grants something, it
creates one record of the granted object per unit, through the record code, as the host
(`by: "host"`), in that batch: a failed grant fails the payment's batch, and the payment is
applied again later. `part_paid` → `paid` grants nothing more: the place was the buyer's from the
deposit. No extension code runs.
- `object` is another of the extension's objects, and declares `states`. A granted record starts
  in the initial state.
- `set` says where each field's value comes from: `item` (the record bought), `item.<field>`,
  `order`, `order.person`, `order.email`, `line`, `line.title`, `line.unitPrice` (major unit), or
  `code`.
- **`code`** is the host's: 26 characters of Crockford base32 from 130 random bits, in a
  read-only text field, so only the host writes it.
- Each granted record gets a row in **`core_order_grant`** (migration 0450): the record, its order
  and line, and its code, which is `UNIQUE` across every granted record (a collision fails the
  batch rather than issuing a duplicate). It is how the host finds what an order granted, and
  how a code is found again (check-in, step 3).

**Voiding.** When an order moves to `refunded` (refunded in full) or `cancelled` (staff cancelling
a part-paid order; a pending order has granted nothing), the same hook moves each record it
granted to `void`, as the host, in that batch. A record already void, in a final state or in the
Trash is left alone. Places go back by stage 26's rules (`releaseOnRefund`), in the same batch.

**The declaration's checks** (`checkObjectSellable`, run by `extension.check` and `cos ext
check`, in the style of `capacity`'s): field types; the currency agreeing with the price field's;
a deposit naming both fields; the granted object being another of the extension's objects,
declaring `states` with the void state, not its initial one, and a move into it the host may make
from every state that is not void or final; each `set` source agreeing with the field it fills
(a relation to the item's object, the same type and target as the item's field, a relation to a
person, an email, text, a number); a required field set only from a source that always has a
value (so `order.person` never fills a required field: an order may belong to no one yet); at
most one code, in a read-only text field; every required field of the granted object set; and the
state field not set. Each of these is a way the paid batch could otherwise fail.

## Why
- A behaviour, not a tool or an automation: the tickets and the payment are one fact, and only
  the host's batch can make them one.
- One table of grants, not a convention on the granted object's fields: the host must find what
  an order granted to void it whatever the extension called its fields, and a code must be
  unique across extensions, which only the database can promise.
- The checks are strict because a grant runs inside a verified payment: a declaration that could
  fail at that moment would leave a buyer charged and an order unpaid until someone fixes it.
- Reading the rules from the record keeps them where staff edit them (a ticket type's window and
  limit), and keeps every price and limit away from callers.

## Consequences
- Local development and the orders end-to-end spec sell the box office fixture extension
  (`packages/core/test/fixtures/boxoffice`), installed over MCP or by `extension.install`; Deals
  is not sellable.
- A grant creates records through `createRecord`: assignment rules, `requireOneOf` and choice
  requirements on the granted object still apply and could still fail a paid batch. The checks
  do not refuse them yet; a pack's granted object should not declare them.
- `order.setPerson` (an order whose address matched several people) does not update the holder
  of what the order already granted.
- A field named with an SQL keyword (`order`) breaks the reconciler's DDL, and `cos ext check`
  does not catch it (found while building this; the fixture uses `orderId`).
- Free records given by staff, transfers and per-person limits are not part of this.
