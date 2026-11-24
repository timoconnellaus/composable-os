# ADR 0682: The stock behaviour: a ledger on capacity's counter, a place on every movement, no restock on refund

Status: accepted, 2026-11-24 (stage 37 build, step 1). Amends ADRs
[0431](0431-the-capacity-declaration-and-the-counter.md) and
[0433](0433-what-outsiders-are-told-about-places.md) with dated notes. Builds on ADRs
[0404](0404-behaviours-are-the-vocabulary.md), [0427](0427-orders-are-priced-by-the-host-and-paid-only-by-a-verified-payment.md),
[0429](0429-payments-gatekeeper-verified-events-and-refunds.md),
[0430](0430-capacity-is-refused-by-the-database.md) to
[0433](0433-what-outsiders-are-told-about-places.md) and
[0435](0435-sellable-what-may-be-bought-and-what-a-paid-line-grants.md). Spec:
[stage 37](../stages/37-shop.md). The spec lists this decision as ADR 0680; the build session was
given ADRs 0682 and 0683 of block BC, so it is 0682.

## Context
A shop sells things it counts: drinks from a fridge, hoodies in sizes. Capacity's engine already
does what stock needs at the moment of sale: a hold while an order is unpaid, refused by the
database past what is there, confirmed when paid, released on expiry, all in the order's batch, so
no path oversells. Its model does not fit: places are typed by staff (racing sales), there is no
history of why the number changed, a refund puts the place back on sale, and there is no reorder
level. A pack keeping its own counter fields could neither hold in the order's batch nor refuse an
oversell for every path (ADR 0404).

## Decision

**A new behaviour, `stock`, on an object** (`packages/sdk/src/stock.ts`): `stock: { reorderAt?,
reorderQty?, show?, lowAt? }`. `reorderAt` and `reorderQty` name the object's number fields
holding the reorder level and how many to order; `show` and `lowAt` say what outsiders are told
(as capacity's). In this step the object must be `sellable` (not `recurring`, not `moves`) and may
not also declare `capacity`. Step 3 tightens "sellable" to `sellable.goods`; step 2 lets an object
used by `stockMoves` have stock without being sold. A runtime extension may not declare `stock`
(selling goods to customers and the public is a reviewed change, as `sellable` is).

**The counter is capacity's, read another way.** Each record gets a `core_capacity` row in the
batch that creates it, with `places` 0 (the reconciler backfills records made before their object
declared stock). For a stock record:

- `places` is every unit that came in, less every unit that went out other than by a sale;
- `taken` is every unit sold;
- `held` is what unpaid orders hold.

So **on hand is `places - taken`** and **available is `on hand - held`**. Capacity's statements
and trigger (migration 0440) run unchanged: a hold past what is available, or a removal that would
leave less on hand than is held, fails the batch with the numbers. The refusal is reworded for
stock (`rule: "stock"`): staff are told `asked` and `available` (or `onHand`, `held`, `removing`
for a removal); a customer or the public is told only "Sold out" or "Not enough in stock".

**Nobody types on hand: it moves only by a movement.** `core_stock_movement` (migration 0935) is
the ledger: kind (`opening`, `received`, `sold`, `returned`, `written_off`, `counted`, `adjusted`,
`used`), signed quantity, the **place** (`place_id`, always `default` in this stage), the source
(an order line, a record), who (a staff account, or the host) and a note; a unit cost on
`received` only. A movement and its counter change are written together (the ledger row is
inserted from the counter's row, so a record without a counter gets neither), and the ledger's sum
is on hand. Triggers refuse every update and delete, and an insert of an id that already exists,
so `INSERT OR REPLACE`, `REPLACE`, `UPDATE OR REPLACE` and `ON CONFLICT DO UPDATE` cannot get round
them (issue #269's lesson). One `opening` per record and place (a unique index).

**Orders hold and sell through the existing order hook** (`orders/holds.ts`). A line whose object
declares stock claims like a capacity line in `createOrder`. When the order is paid (or part
paid, or paid late and honoured) the host writes one `sold` movement per stock line in the paid
batch, in one statement whatever the number of lines, before the claims are confirmed; each takes
its claim's ULID as its id, so a claim is sold once. **A refund changes nothing in stock**, and
neither does cancelling a part-paid order: the stock claims stay confirmed and no movement is
written. Goods come back only by a return (step 4), which writes its own movement.

**Operations.** `stock.get` (staff, customer and public; `records:read`): staff get on hand, held,
available, the reorder level and quantity, whether on hand is at or below the level, and the last
ten movements; a customer or the public get only what `show` allows (`availability` by default:
`in_stock` or `sold_out`; `low`: "only N left" at or below `lowAt`; `exact`: the number
available), and only for a record they may read. `stock.movements` (staff, `records:read`): the
ledger, newest first, paged. `stock.opening` and `stock.adjust` (staff, `records:write`, risk
`write`, `alwaysReview` for the assistant and MCP): an opening movement once per record, and a
signed correction with a reason. Their dry run refuses a removal past what is held before it is
queued. The record carries `onHand`, `held` and `available` as read-only values, and
`rec_stock_movement` is the ledger for `query.sql` and dashboards.

**Every movement has a place from the first migration.** Stock in several places (decision 11) is
a counter per record per place later, and the ledger's history is not rewritten.

## Consequences
- The paid batch grows by one statement and the move hook by one read of the order's lines,
  whatever the number of lines (`test/stock.test.ts`, criterion 20).
- `taken` only grows on a stock record: it is units sold, ever. Moving a stock record to the Trash
  is not refused for having sold units (capacity refuses a record with places taken; goods sold
  are gone), and its held claims stay held until their orders release them.
- The spec gives `stock.get` to `shop:read` and the writes to `shop:stock`. Those are the Shop
  pack's tool permissions, which do not exist until step 5, and a behaviour any pack declares
  cannot name one pack's permission. The core operations are held to `records:read` and
  `records:write` (an AI's write always waits for a person); the pack's tools gate their callers
  with `shop:stock`. If a business needs the core writes narrower than a member's
  `records:write`, that is a declared permission on `stock`, platform work for a later step.
- Dropping an object's table for good drops its counters and claims (as for capacity); its ledger
  stays, as history nobody can change.
- Removing `stock` from an object leaves its counters and ledger in place, unused. Switching an
  object between `capacity` and `stock` is not supported: the counters would be read the other way.
