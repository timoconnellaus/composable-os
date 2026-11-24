# ADR 0680: The `stock` behaviour: a ledger on capacity's counter

Status: accepted, 2026-11-24 (stage 37, build step 1). Amends ADRs
[0431](0431-the-capacity-declaration-and-the-counter.md) and
[0433](0433-what-outsiders-are-told-about-places.md) with dated notes. Opens `stock.get` to
customers and the public (ADR 0402: a reviewed change, in `packages/core/open-operations.json`).

## Context
A shop sells things counted on a shelf: a hoodie in large, a bottle from the fridge. Capacity
(ADR 0430) already refuses an oversell in the database, holds while an order is unpaid and
confirms when it is paid, all in the order's batch. Its model does not fit goods: places are typed
by staff (a race with every sale), nothing says why a number changed, a refund puts the place back
on sale, and only orders and one-place claimants take from it. Stock needs a history, on hand that
nobody types, a refund that does not restock, and room for receipts, counts and write-offs later
(step 2's `stockMoves`), and for stock in several places later still.

## Decision
- **An object declares `stock: { reorderAt?, reorderQty?, show?, lowAt? }`** (SDK
  `packages/sdk/src/stock.ts`). `reorderAt` and `reorderQty` name the object's number fields
  holding a record's reorder level and how many to order; `show` and `lowAt` are as capacity's
  (`availability` by default: in stock or sold out). An object has stock or a capacity, never
  both; a thing in stock has no `sellable.deposit`, `recurring` or `moves` (it is sold whole, on an
  order). Fields named `onHand`, `held` or `available` are refused: they are the host's read-only
  values on every record. A runtime extension cannot declare `stock` (install refuses it, as
  `sellable`).
- **The counter is capacity's** (`core_capacity`, one row per record, made with the record and by
  the reconciler's backfill, with nothing on hand). For a stock record, `places` is every unit in
  less every unit out by a movement other than a sale, `taken` every unit sold, `held` what unpaid
  orders hold. **On hand is `places − taken`; available is on hand − held.** Migration 0440's
  trigger is unchanged and is the guarantee: a sale past available fails the order's batch, and a
  movement that would leave fewer on hand than is held fails its own.
- **The ledger is `core_stock_movement`** (migration 0930): the record, a **place** (always
  `default` in this stage), a signed quantity, a kind (`opening`, `received`, `sold`, `returned`,
  `written_off`, `counted`, `adjusted`, `used`), its source (an order line, a record, or a person's
  own correction as `user`), who (null for the host), when, a note and a unit cost for what was
  received. Triggers refuse an update, a delete and an insert over an existing id (so `INSERT OR
  REPLACE`, `REPLACE` and an upsert fail too, issue #269), and a second `opening` for a record. A
  dropped object's movements stay. `rec_stock_movement` reads it for `query.sql` and dashboards;
  it names order lines and staff, never a customer.
- **A movement other than a sale is three statements** with no read before them
  (`packages/core/src/stock/index.ts`, `movementStatements`): the counter made if missing, its
  places moved by the quantity, the ledger row. The ledger's sum for a record is its on hand.
- **Orders** (`orders/holds.ts`): a line whose object has stock claims its quantity in
  `createOrder`, as a capacity line does. When the order is paid (or a late payment is honoured)
  one statement writes a `sold` movement per held stock claim, named after the claim and sourced
  to its order line, before the claims are confirmed. Cancelled or expired from pending gives the
  units back (no movement: held is not on hand). **Confirmed stock is never given back by an
  order's move**: not on refund, and not on a cancel after a deposit. Only a return (step 4) puts
  goods back on the shelf.
- **Operations** (`packages/core/src/operations/stock.ts`): `stock.get` (staff, customer, public;
  `records:read`): staff get on hand, held, available, the reorder level and quantity and whether
  on hand is at or below it; outsiders get only what `show` allows, of a record they may read
  (`packages/core/src/visibility/stock.ts`, as capacity's); staff also get the last five
  movements. `stock.movements` (staff,
  `records:read`): the ledger of one record, newest first, paged. `stock.opening` (once per record)
  and `stock.adjust` (signed, with a reason) need **`stock:adjust`, a new core permission**, admins
  by default and grantable one by one (ADR 0449). Both are `alwaysReview` for an assistant and an
  MCP client, and the approval is a person's who holds `stock:adjust` (approval.ts), so an AI never
  changes stock alone.
- **Refusals read as stock:** the counter's refusal on a stock record is `invalid_input` with
  `rule: "stock"` (`asked`, `available` for a sale; `onHand`, `held` for a movement); a customer or
  the public is told "There are not enough in stock" and no numbers.

- **The declaration is fixed once an object has records.** The reconciler refuses adding `stock`
  to an object, or taking it off one, while the object has any record (Trash included) or counter
  (`stock_change`). Otherwise a counter would keep what it held before: a capacity's `places`, NULL
  being unlimited, so the database would sell any number; or units sold while stock was off, with
  no `sold` row, so on hand would no longer be the ledger's sum. Things a business counts are a new
  object, whose records start with nothing on hand.

## Consequences
- Everything that holds and confirms an order's places already holds and confirms its stock:
  the payment webhook, staff honouring a late payment, and later the till's paid orders.
- The paid confirm of an order costs the same number of statements for 2 lines as for 50
  (`test/stock.test.ts`).
- The spec names `shop:read` and `shop:stock` for these operations. Core operations cannot name a
  pack's permissions, so step 1 uses `records:read` for the reads and the core `stock:adjust` for
  the writes. A pack role never holds a core permission (ADR 0600), so the Shop pack's stockroom
  role moves stock through its records (receipts, counts, write-offs, by step 2's `stockMoves`); a
  direct correction stays with admins and accounts granted `stock:adjust`.
- Stock in several places (a later step) adds a place list and a counter per record per place; the
  ledger's place column means no history is rewritten.
- The declaration's rule that a stock object is sellable with `goods` or used by `stockMoves` lands
  with those declarations (steps 2 and 3); in step 1 any extension object may declare stock.
- The approval queue's dry run judges a sale as capacity does, with capacity's wording.
- `stock.movements` and `rec_stock_movement` are open to any staff account that reads records, so
  a received unit cost (from step 2) is too. The spec lets staff and an AI read stock and its
  movements; a cost hidden from some staff would be a permission of its own, not added here.
- Trash has no stock rule: a record whose units unpaid orders hold may go to Trash, and those
  orders confirm or release their claims as usual. Its counter and claims stay with it; nothing is
  sold that was not on hand.

## Amended 2026-11-24 (stage 37 step 2, ADR 0681)

`stockMoves` writes `received`, `written_off`, `used` and `counted` movements from a record's
state, and the rule above is now checked: an object with stock is sellable, or the target of a
`stockMoves` of its extension (step 3 narrows sellable to `sellable.goods`). `stock.notify` names
who is told of low stock. See [ADR 0681](0681-stock-moves-a-record-s-state-moves-stock.md).
