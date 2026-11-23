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
state field not set. Each of these is a way the paid batch could otherwise fail. So is the granted
object's own rules, which the checks also hold to what the grant always fills: it declares no
`owner` (assignment rules would run in the paid batch), each `requireOneOf` group has a field the
grant always fills, and a choice a granted record can be created holding (the initial state, a
default, or any choice of a select set from the item) requires only fields the grant always
fills. "Always fills" is a field set from a source that always has a value, or a field with a
default.

**Only a shipped pack or the org's own extension may declare it.** Selling opens `order.start`
to the object's records for customers and the public, so, as with `customer` and an operation's
audiences (ADR 0402), a runtime extension (written in the workspace, by AI or by hand, and
approved in the app) that declares `sellable` is refused by `extension.check` and by
`extension.install` (`outside_audience`, `objects.<name>.sellable`). `cos ext check` lists what
can be bought among the lines it asks a reviewer to read.

**The paid batch has a size, so the host caps the units a granting line may hold.** A line of an
object that grants is limited to the record's `maxPerOrder`, or the host's default of 10 when the
record sets none, and an order to `GRANTS_PER_ORDER_CEILING` = 100 granted records across its
lines; more is refused with `{ rule: "max_per_order", line, max, asked }` (and `ceiling` when the
order's total is what is over). Measured in workerd's D1 (`test/sellable.test.ts`): a paid batch
is 15 statements for the payment itself plus **5 per grant** (the record, its history row, its
search document's delete and insert, the grant row), so 100 grants is 515 statements, which commit
in workerd in well under a second (500 grants, 2,515 statements, also committed, in about 70 ms).
The ceiling is set by D1's limit of 1,000 queries per Worker invocation, not by workerd: 515 is
about half, which leaves room for several lines' holds, the audit and the confirmation email.

**`order.setPerson` reaches the grants.** When an order that belonged to no one is given its
Person, each record it granted with a field set from `order.person` (a ticket's holder) gets that
Person, as the host, in the same batch.

**Fields named with an SQL keyword work.** The reconciler and the record code splice column names
bare. A field whose column would be one of the 65 words D1 refuses bare somewhere the platform
writes a column (`order`, `group`, `select`, `currentDate`, `true`; `RESERVED_COLUMN_WORDS`,
`extensions/naming.ts`) gets the column `<word>_`, which no field name can produce. The field's
name is unchanged everywhere a caller sees it; only `query.sql` sees the column. A test probes
every SQLite keyword against D1 and fails if the list and D1 disagree. Quoting every identifier
was the alternative: column names are also object keys in rows read back, so quoting would have
touched every place a column is spliced or read, where the suffix is one function.

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
  (`packages/core/test/fixtures/boxoffice`). `scripts/dev-setup.mjs` delivers it as the org's own
  extension, the way `cos deploy` does (ADR 0422): its files in local BLOBS, pinned by the
  runner's `COS_ORG_EXTENSIONS`, marked optional so an admin installs it
  (`extension.install { id: "boxoffice", shipped: true }`). Deals is not sellable.
- An org's own extension may now be `optional`, as a pack may.
- A deployment with a field whose column was one of the words that D1 takes in DDL but not in a
  bare read (`cast`, `raise`, `constraint`, `current_date`, `current_time`, `current_timestamp`,
  `true`, `false`) keeps its stored column, and its view now names it `<word>_`. Such a field could
  not be read before. The other reserved words never had a column: their DDL failed.
- Free records given by staff, transfers and per-person limits are not part of this.

## Amendment, 2026-11-21 (stage 27, ADR 0438)
A customer or the public buys only what they may read: `priceLines` refuses a line whose record
the buyer's scope does not show (their own, or a public one) with the same answer as a record
that does not exist (`not_for_sale`). Staff may still start an order for anything sellable. An
object sold to people outside the org therefore declares `public`. See
[ADR 0438](0438-the-public-scope.md).

## Amended 2026-11-21 (the first client: prices come with their currency)
A client showing a sellable record's price had to state the currency itself: the record holds a
number, and the deployment's one currency (stage 25, `order.settings`) was readable only by
staff. Now **wherever the seam returns a sellable object's records, it says the currency their
prices are in**: `listVisible` and `getVisible` (`ctx.records.list` and `get`, so `public.list`,
`public.get`, `my.list` and `my.get`) add `currency` (the setting, or null until an admin sets
one) beside the records of an object that declares `sellable`, and nothing on any other object.
It is the value every order of the deployment is priced in, and it is not secret: it is on every
order a buyer sees. No operation was opened for it. Ticketing's `eventsOnSale` passes it on beside
each ticket type's price, `salesSummary` (staff) reads `order.settings.get`, and the pack's hooks
and blocks take the currency from the data: the web blocks no longer take a `currency` prop, and
`formatMoney`, `formatPrice`, `estimate` and `minorFromInput` scale by the currency's own decimal
places. Tests: `packages/core/test/isolation-suite.ts` ("a sellable object's records come with
the currency"), `apps/runner/test/ticketing.test.ts` (criterion 9 and the sales summary),
`packs/ticketing/test/client.test.ts`.

## Amended 2026-11-23: a sellable object's agreement point is asked when it is bought (stage 44 step 3, [ADR 0644](0644-enforcement-nobody-pays-or-books-without-what-is-due.md))
A `sellable` object that declares an agreement point (`agreements`, ADR 0641) is asked at it by
`createOrder` (every order) and `startSubscription` (a plan): what is due for whom it is for and for
who pays refuses the purchase (`agreements_due`), and the batch carries the `agreements` guard.
Nothing is attached by default, so a sellable with a point sells as before until a business
attaches a document. What a paid line grants is the host's and is not asked again.
