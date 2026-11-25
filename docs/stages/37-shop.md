# Stage 37: Shop, with stock and suppliers

Read first: [`AGENTS.md`](../../AGENTS.md), [`docs/architecture.md`](../architecture.md) (Behaviours,
Orders, Packs and blocks), [`CONTEXT.md`](../../CONTEXT.md) (Order, Sellable, Capacity, Claim,
Claimant, Grant, Guest, Routine mail, Pack role), ADRs
[0400](../adr/0400-a-general-host-and-products.md) (why "product" is not used here),
[0402](../adr/0402-staff-and-customers.md) (audiences),
[0404](../adr/0404-behaviours-are-the-vocabulary.md) and
[0405](../adr/0405-skills-ship-with-the-platform.md) (behaviours are the vocabulary; no workaround
in pack code), [0427](../adr/0427-orders-are-priced-by-the-host-and-paid-only-by-a-verified-payment.md)
to [0429](../adr/0429-payments-gatekeeper-verified-events-and-refunds.md) (orders, guests,
payments and refunds), [0430](../adr/0430-capacity-is-refused-by-the-database.md) to
[0433](../adr/0433-what-outsiders-are-told-about-places.md) (capacity and holds),
[0435](../adr/0435-sellable-what-may-be-bought-and-what-a-paid-line-grants.md) (`sellable`),
[0446](../adr/0446-publishable-without-its-public-half.md) and
[0480](../adr/0480-an-ai-asks-to-publish-a-person-approves.md) (publishing),
[0479](../adr/0479-tax-at-checkout.md) (tax at checkout),
[0501](../adr/0501-a-record-s-states-claim-its-place.md) (claimants),
[0560](../adr/0560-a-paid-line-moves-a-record-that-exists.md) (a paid line moves a record),
[0590](../adr/0590-routine-mail.md) (routine mail),
[0624](../adr/0624-the-rosters-notices-uncovered-shifts-and-leaving.md) (the host's notices),
[0644](../adr/0644-enforcement-nobody-pays-or-books-without-what-is-due.md) (agreements at
checkout), [0646](../adr/0646-erase-merge-and-retention-for-agreements.md) (erase); stages
[25](25-states-orders-payments.md), [26](26-capacity-and-holds.md), [28](28-content.md),
[44](44-agreements.md) and [47](47-pack-screens.md); issues
[#198](https://github.com/timoconnellaus/composable-os/issues/198) (a tax code per record),
[#237](https://github.com/timoconnellaus/composable-os/issues/237) (paying in the app),
[#269](https://github.com/timoconnellaus/composable-os/issues/269) (append-only tables and
`INSERT OR REPLACE`) and [#126](https://github.com/timoconnellaus/composable-os/issues/126)
(payments taken in person); `packages/core/src/orders/` (`orders.ts`, `holds.ts`, `refunds.ts`,
`tax.ts`, `settings.ts`), `packages/core/src/capacity/`, `packages/sdk/src/sellable.ts` and
`capacity.ts`. The point of sale (the till) is drafted separately and not yet in this repository:
[the seam with it](#the-seam-with-the-till) is defined here.

Status: **spec agreed** (owner interviewed 2026-11-24: decisions 1 to 13). Build may start. The
questions at the end refine later steps and block none of the first ones.

## Status

- **Step 1** — built — PR #370 — The `stock` behaviour (`feat/stage-37-shop-step-1`; migration 0930, ADR 0680, which
  amends ADRs 0431 and 0433): the SDK declaration `stock: { reorderAt?, reorderQty?, show?, lowAt? }`
  and its checks (not beside a capacity; no `sellable.deposit`, `recurring` or `moves`; refused in a
  runtime extension); the ledger `core_stock_movement` with a place on every row (`default`),
  append-only by triggers, one opening per record, and `rec_stock_movement`; the count on
  capacity's counter (a counter for every record, on hand `places − taken`, read-only `onHand`,
  `held`, `available`); `stock.opening` and `stock.adjust` (a new core permission, `stock:adjust`,
  grantable; an AI's call waits for a person who holds it), `stock.get` (staff numbers, reorder
  level; outsiders by `show`, opened to customers and the public) and `stock.movements`; an order's
  stock lines held on start, `sold` movements written in the paid batch (one statement), given back
  on cancel or expiry, never on a refund. Deviations: the reads use `records:read` and the writes
  `stock:adjust` instead of `shop:read` and `shop:stock` (a core operation cannot name a pack's
  permission, and a pack role never holds a core one: the stockroom role moves stock through the
  pack's records, by step 2's `stockMoves`; a direct correction is for admins and accounts granted
  `stock:adjust`); "sellable with `goods` or
  used by `stockMoves`" is checked when steps 2 and 3 add those. After review: the reconciler
  refuses adding `stock` to an object with records, or taking it off one (`stock_change`), and
  `stock.get` gives staff the last five movements.

- **Step 2** — built — PR #422 — `stockMoves` and low stock (`feat/stage-37-stock-moves`; migration 0931, ADR 0681,
  which amends ADR 0680): the SDK declaration `stockMoves: { move: add | remove | set, on,
  quantity, when, through?, kind?, unitCost?, note? }` and its checks (a target with stock in the
  same extension, a state no move leaves, `through` a relation to an object with states; refused
  in a runtime extension), run by the transition engine for every actor in the move's batch
  (`stock/moves.ts`): add (`received`, with unit cost and note), remove (`written_off` or `used`),
  set (`counted`, the difference from on hand at the commit; refused below what unpaid orders hold
  with the numbers); `through` moves all of a record's lines at once (a count applied, up to 500
  lines, three statements whatever the number); what moved stock cannot change, and a moved
  record's lines cannot be added or changed. Low stock (`stock/low.ts`, `core_stock_low`): the
  holders of the pack's `stock.notify` permission (else the admins) told once per crossing of the
  reorder level, by opening, adjust, `stockMoves`, a paid order's sale or a changed level, in the
  write's batch. Deviations: who is told is the permission the pack names in `stock.notify`
  (core cannot name `shop:stock`); a stock object is "sellable, or moved by a `stockMoves`" until
  step 3 adds `goods`; a `stockMoves` target must be in the same extension (stage 39 widens it for
  Jobs). The over-receipt warning and notice, and a count's "differences over a threshold" notice,
  are the pack's step 6 (they need the purchase line). After review: a move into a stock-moving
  state is the host's through the pack's person tools (`humanOnly`/`personApproves`), never a
  plain staff, customer or `create.in` move, so an AI's waits for a person; guards close the race
  of a count's apply with its lines both ways; a line cannot be restored under an applied count; a
  crossing is marked told (it outlives the notices' purge); a fixed role is told only of objects
  it reads. Left: steps 3 to 14.

- **Step 3** — in progress — branch `feat/stage-37-goods-delivery` — Goods and delivery, and
  `order.quote` (migration 0932,
  ADRs 0682, 0683 and 0685, which amend ADRs 0428, 0435 and 0479): the SDK declarations
  `sellable.goods: { soldIn? }` (a select of `online`, `in_person`, `both`, through the item's
  relation; empty is both) and `sellable.delivery: { kind, freeOver?, countries?, active? }` and
  their checks (a sold object with `stock` must be goods; no deposit, recurring or moves; a delivery
  has no stock, `maxPerOrder` or `onePerPerson`; refused in a runtime extension, as `sellable` is);
  `priceOrder` and the goods rules (`orders/goods.ts`) on every path: one delivery per goods order,
  chosen in `order.start`'s new `delivery` and added by the host as the last line, never a line of
  `lines`; the channel worked out by the host (`core_order.channel`, written once) and a goods line
  not sold there refused (`not_sold_here`); post needs an address in the option's countries (`*`:
  every country no other post option names), collect and here take none; postage the option's
  price or nothing at or over its free over; `core_order_delivery` with the address (in no view,
  never in the audit log, fixed by triggers, blanked by the buyer's erase); `order.delivery.get`
  (staff audited, the buyer, a guest's token); a paid `here` delivery grants nothing; at checkout
  with tax on, the address is the goods' and the postage's place and the host's copy leaves it
  out; `order.quote` (staff, customer, public; holds and writes nothing; the same refusals, with
  `delivery_needed`, `address_needed`, `sold_out` and `not_enough` reported; availability by
  `show`). Opened to customers and the public: `order.quote` and `order.delivery.get`. Deviations:
  the delivery is `order.start`'s `delivery: { object, id, address? }`, not a line the caller puts
  in `lines`; the business's own country is not a host setting, so an option with no countries
  posts nowhere (the pack seeds its country, step 5); `soldIn` is not built as the till's
  `placedAs: "desk"` channel (the till's step 1 adds desk orders, in person by this rule);
  `orders:read` is `records:read` (no such core permission, as step 1); `channel` is not in
  `rec_order` (a view remade below 0950 would be dropped by 0950 on a fresh database);
  `order.quote`'s statements are bounded by `priceLines`' per-line reads (at most three a line,
  under 250 at 50 lines), not constant. Not tried for real: the provider's tax by the delivery
  address (only the gatekeeper's test double), a basket block. Left: steps 4 to 14.

- **Step 4** — not built — needs: step 1, step 3 — Returns and line refunds (`order.return`)

- **Step 5** — in progress — branch `feat/stage-37-shop-pack` — The Shop pack's spine: items, variants,
  delivery options, shipments, supplier fields, the stockroom role

- **Step 6** — not built — needs: step 5 — Purchase orders, receipts, quick stock-in, counts,
  write-offs, `draftReorder`, `sendPo`

- **Step 7** — not built — needs: step 4, step 5 — Returns recorded by staff (`recordReturn`),
  routine mail kinds, notices' wording

- **Step 8** — not built — needs: step 5, stage 47 — Blocks: customer web and native, staff
  screens for stage 47, e2e (the Deliveries section's `portal` declaration after stage 48 step 5)

- **Step 9** — not built — needs: step 5 — `cos shop import`, the site and `SITE.md`

- **Step 10** — not built — needs: step 9, the first client — The first client: the gym's drinks
  and clothing, a test-mode sale online and at the gym

- **Step 11** — not built — needs: step 3, a later decision to build it — Later: postage by weight

- **Step 12** — not built — needs: step 3, a later decision to build it — Later: a tax setting per
  record (#198)

- **Step 13** — not built — needs: step 3, a later decision to build it — Later: the shipping
  gatekeeper, live rates, labels, tracking

- **Step 14** — not built — needs: a trades client who needs it — Later: stock in several places

Vocabulary: "product" is the platform's word for a composition (ADR 0400) and is avoided for what
a business sells. This spec says **item** (a thing in the shop: "Club hoodie") and **variant** (one
version of it that is bought and counted: "Club hoodie, large, black").

## Goal

A business keeps one list of the things it sells (drinks, clothing, supplements, spare parts),
each with its sizes or flavours, prices and photos, marked for where it is sold, and knows how many
of each it has. Members serve themselves at the gym: they take a drink from the fridge and pay for
it on their own phone, or a member of staff helps them. Customers buy online, on the business's
website and in its app: a basket of several things (a hoodie, a shaker and a ten-class pass
together), collected at the gym or posted, paid once. Staff pack and send or hand over what was
bought, and record what comes back. Stock goes down when something is sold, up when a delivery
from a supplier is received (against a purchase order or by a quick entry), and is corrected by a
count. Staff are told when an item runs low and can order more with a purchase order. The till at
the desk (drafted separately) sells from the same list and the same stock: one catalogue and one
count.

## Who it is for

- **Gyms and studios (first).** A fridge of drinks and a rail of branded clothing in sizes, maybe
  supplements and equipment. Members serve themselves or a staff member helps. No online shop today;
  the owner wants one. Few suppliers, one stockroom. The basket mixes shop items with the gym's
  passes (already sellable). Plans (subscribed to) and drop-ins (bought when booked) stay outside
  the basket, as orders refuse them today.
- **Trades and services (next).** A part leaves stock because it was fitted on a job and is billed
  on the job's invoice (stages 35 and 39, not specced). They buy from several wholesalers with
  purchase orders and may carry stock in vans. What they need from this stage is the catalogue,
  stock, suppliers, purchase orders, counts and a way for a job to use stock (`stockMoves`); stock
  in several places is designed here and built when they need it (decision 11).

## What exists today (from the code)

- **Orders take many lines of different kinds.** `createOrder` (`packages/core/src/orders/orders.ts`)
  accepts up to 50 lines (`ORDER_MAX_LINES`), each a record of a sellable object, priced by the host
  (`priceLines`). Refused on the same order: a plan, a record bought by `sellable.moves` (a
  drop-in), the same record twice. Grants are capped at 100 per order. Unpaid orders expire after
  the order expiry setting (`orders/settings.ts`). An order records who placed it
  (`placedAs`: `customer`, `public` or `staff`, `fields/order.ts`).
- **Capacity holds and confirms per line** (`orders/holds.ts`, `packages/core/src/capacity/`): a
  line whose object declares `capacity` holds its quantity in the order's batch, refused by the
  database past the places; paid confirms; cancelled or expired releases; refunded releases unless
  `releaseOnRefund: false`. `show` says what outsiders see (`exact`, `low` with `lowAt`,
  `availability`, `packages/sdk/src/capacity.ts`).
- **Sellable** (`packages/sdk/src/sellable.ts`): price, sale window, most per order, deposit,
  grants, tax code per object (`sellable.tax`), one per Person, `moves`, `recurring`. There is **no
  delivery, no address and no notion of goods** on an order.
- **Refunds** (`orders/refunds.ts`, `order.refund`): by amount, all or part, always approved by a
  person with `orders:refund`. Not tied to lines or quantities. Nothing records goods coming back.
- **Tax** (`orders/tax.ts`, ADR 0479): prices include tax; when a human admin turns tax on, the
  payment provider works it out at checkout from each line's object's tax code (overridable per
  object in Settings → Orders). A tax code per record is not built (issue #198).
- **Currency**: one per deployment (`order_currency`, `orders/settings.ts`).
- **A customer's own orders can already be listed**: the order object declares a customer, so
  `my.list` with `object: "order"` and `order.get` return a signed-in customer's own orders and
  nobody else's (`operations/my.ts`, `operations/order.ts`). `order.list` is staff only. No new
  operation is needed for "My orders" (the draft assumed one).
- **Publishable, rich text and media** (stage 28): drafts, publishing (an AI asks, a person
  approves), public reads, images.
- **Notices** (`notifications/send.ts`) with dedupe keys; the host's own notices worked out for
  every write (ADR 0624). **Routine mail** (ADR 0590) for a pack's fixed emails to the person a
  record belongs to.
- **Agreements at checkout** (stage 44): a sellable object may declare an agreement point.
- **Pack screens in the admin** (stage 47): spec agreed, being built (PR #303).
- **Nothing** knows stock, suppliers, purchase orders, counts or deliveries. No pack is called
  `shop`. Organisations are a base record and can be suppliers.
- **In-person payment does not exist**: only a verified payment from the provider marks an order
  paid (ADR 0427; issue #126). The till module owns that gap.

## Decided at the interview (2026-11-24)

| # | Decision |
| --- | --- |
| 1 | The gym sells **clothing and other merchandise, and drinks from a fridge**. Members **serve themselves or a staff member helps**. There is no online shop today and the owner wants one |
| 2 | Things are sold **online and in person, from one list** with one stock count |
| 3 | **Each item is marked for where it is sold: online, in person, or both.** Fridge drinks are in person only; some items are online only |
| 4 | Online buyers **collect at the gym or have it posted** |
| 5 | **Posting: a fixed price for each way of sending first** (for example standard and express). **Free postage over an amount and prices by weight are wanted** too. **Connecting to carriers for prices and labels is the intended end state**: a named later step, through a gatekeeper |
| 6 | **Sold out shows as sold out** until more arrives. No back-orders |
| 7 | **No return requests online.** A return is made at the desk or by contacting the business, and staff record it |
| 8 | **Tax**: the owner believes everything is taxed the same, posting included; for the business to confirm with its accountant. A product may carry its own tax setting (issue #198) |
| 9 | **Buyers in other countries are possible.** The spec says what that needs (delivery zones, tax, currency); it stays out of the first build unless cheap |
| 10 | **Deliveries from suppliers: both** purchase orders for regular suppliers and a quick stock-in entry for the rest |
| 11 | **Stock in several places** (a storeroom and vans): designed for now, **built later**, when a trades client needs it |
| 12 | **Each device keeps its own basket** |
| 13 | A member buying for themselves in person is covered by this stage (on their own phone); the till at the desk, and a tablet at the fridge, are the till module's (coordinator's reading of decision 1, below) |

## The design in one page

**One Shop pack holds the catalogue and the stock.** Items, variants, delivery options, shipments,
suppliers' details, purchase orders, receipts, counts and write-offs are its objects. The till pack
`requires: ["shop"]` for goods and sells the same variants; a Jobs pack later uses them as parts.

**Where an item is sold is the host's rule.** An item is sold **online**, **in person**, or
**both** (decision 3). Every order of goods has a **channel**, which the host works out and never
takes from the caller: an order with a post or collect delivery is online; an order with the
"take it now" delivery, or started at the till, is in person. A line whose item is not sold in the
order's channel is refused in `createOrder`, on every path. A fridge drink cannot be posted; an
online-only hoodie cannot be bought as "take it now".

**A member buys for themselves at the gym, on their own phone.** A code on the fridge and on the
counter opens the shop's **At the gym** list on the website (or the app's shop, on its "At the gym"
tab): the items sold in person, with what is available. The member picks, pays on the provider's
hosted page as for any web order, and the order's delivery is **Take it now** (kind `here`: no
address, nothing to pack, no shipment). Stock is held while they pay and sold when the verified
payment arrives. A signed-in member's order is theirs; a visitor buys as a guest with an email
address (ADR 0428), as on the website. A member of staff who helps uses the till once it is built;
until then staff can start the order for the member (`order.start` for a Person) and the member pays
on their phone. **A tablet at the fridge** is not this stage's: it is a shared device on which the
buyer must be identified and must pay, which is the till's card reader and an enrolled device
(stage 44 step 6's desk device, the check-in tablet being drafted). The Shop gives it the catalogue
and the stock.

**Stock is a new behaviour, `stock`, built on capacity's counter.** Capacity's engine fits (a hold
while an order is unpaid, refused by the database past what is there, confirmed when paid,
released on expiry, all in the order's batch). Its model does not: places typed by staff, no
history, a refund that puts the place back on sale, only orders and one-place claimants take from
it. Stock needs a **ledger** (every change has a kind, a quantity, who and why), on hand the host
keeps from that ledger and no one types, a refund that does **not** restock, quantities taken by
records other than orders, and a reorder level. So `stock` reuses `core_capacity` and
`core_capacity_claim` and their statements and adds `core_stock_movement`. On hand is
`places − taken`; available is `on hand − held`. Every movement carries a **place**, always the one
default place in this stage, so places can be added later without rewriting the ledger (decision
11).

**Records move stock by declaration.** An object may declare `stockMoves`: when its record enters
a named state, the host writes a movement of its quantity on the variant it points to, in that
write's batch (a receipt received adds, a count applied sets, a write-off removes, later a job part
fitted removes). Purchase orders, quick stock-in, counts and jobs change stock without a pack
hooking a write.

**The order learns about goods.** A variant declares `sellable.goods`. An online order with goods
needs exactly one **delivery option** line (a Shop record declaring `sellable.delivery`): **post**
(an address, kept by the host on the order and erased with the person), **collect** at a place, or
**take it now** (in person). Postage is priced by the host from the option: a fixed price first;
then free over an amount of goods, and by weight (decision 5). A paid post or collect line grants a
**shipment** record that staff move from "to pack" to "sent" or "ready to collect" to "collected";
the buyer is emailed as routine mail.

**A basket is the device's, priced by the host** (decision 12). The basket lives on the device; its
totals come from a new public dry run, `order.quote`, that prices lines and delivery and says what
is available, holding nothing. Paying starts an ordinary order.

**Sold out is sold out** (decision 6). Available 0 shows "Sold out"; `order.quote` says so and
`order.start` refuses. No back-orders, no pre-orders.

**Returns are recorded by staff** (decision 7). Staff record a return against an order's lines:
the quantity, and for each unit "back in stock" or "written off". The host writes the movements and
asks for the refund of those lines' share of what was paid, through approval as every refund is.
There is no customer return request.

**Low stock is the host's notice.** When a write takes a variant's on hand to or below its reorder
level, the people with `shop:stock` are told once (until it rises above again); the Shop dashboard
lists everything at or below its level, by supplier, ready to become a draft purchase order.

**Carriers are a later step, through a gatekeeper** (decision 5). A shipping gatekeeper with one
carrier interface (live rates for a parcel, buy a label, tracking events), as the payments
gatekeeper has one payment interface. No carrier is chosen here.

### The seam with the till

The till (point of sale) module is drafted separately. What each side owns:

| The Shop owns | The till owns |
| --- | --- |
| Items, variants, prices, photos; where each is sold (`sellable.goods.soldIn`) | Desk orders (`placedAs: "desk"`, a walk-in with no name or address) |
| Stock: the `stock` behaviour, the ledger, holds and `sold` on paid, counts, receipts, write-offs, low stock | Card on a reader, cash into a till session, a member's tab, the cash-up |
| Delivery options and shipments; the address | The desk receipt (how it was paid) |
| `order.quote`, the channel rule in `createOrder` | The till screen and its catalogue read across every object sold in person (Shop variants, passes, drop-ins) |
| Returns of goods (`order.return`): restock or write off, and asking the refund of those lines | How that refund goes back (to the card, in cash from an open till, to a tab) |
| The member's own "At the gym" purchase on their phone | A shared tablet at the fridge or desk where members serve themselves and pay on a reader |

Rules both sides keep:

- **One mark for "sold in person".** The till's draft proposes `sellable.desk`; it is replaced by
  this stage's `sellable.goods.soldIn` for goods. Records that are not goods (a pass, a drop-in) are
  sold in every channel unless their object says otherwise; the till may add a mark for those, read
  by the same channel rule.
- **A desk order is in person.** It needs no delivery line (the goods are handed over); its goods
  lines must be sold in person. A desk order with a post delivery (staff selling online for a
  member) is an online order and needs the address.
- **Stock is `stock`, not `capacity`.** The till's draft says the Shop's items hold "stock as
  `capacity`"; they declare `stock`. A desk order holds and sells through the same order hook, so a
  cash or reader payment that the till makes a paid order writes `sold` in the paid batch with no
  extra work.
- **Refunds and returns.** `order.return` computes the lines' share and calls the core refund; the
  till amends the core refund with its methods. A return never decides how money goes back.
- **Order of building.** Both change `orders/`. Shop steps 1 and 3 land first (the channel rule and
  the order hook); the till's step 1 builds on them. If the till goes first, it takes the
  `sellable.goods.soldIn` part of step 3 with it, as this spec defines it.

### Buyers in other countries (decision 9)

What selling abroad needs, and what the first build does:

| Need | First build | Later |
| --- | --- | --- |
| **Delivery zones**: which countries an option posts to, at what price | **Yes** (cheap): a post option lists its countries; the address must be in one. A post option may instead cover "everywhere else" at its own price. A new shop starts with the business's own country only | Zone tables by region within a country |
| **Tax** on a sale to another country (whether home tax applies, whether the buyer's does) | Step 3 passes a post order's delivery address to the provider as the line's place, as an event's place is passed today (ADR 0479), so with tax at checkout on the provider works tax out for where the goods go. Nothing else. Whether to post abroad at all, and how it is taxed, is for the business to confirm with its accountant | A tax setting per item (issue #198, step 9) |
| **Currency** | One currency per deployment; prices are shown and charged in it | A second currency is platform work, out of scope |
| **Customs and duties** (a customs description and country of origin per item, who pays duties) | Not handled | With the carrier step |

So the first build can post abroad at a fixed price: an option lists countries, or covers
"everywhere else". It does nothing about tax, currency or customs beyond what exists. The first
client posts anywhere at one international price (follow-up answer 1).

### What was weighed and rejected

| Option | Why not |
| --- | --- |
| **Stock as plain `capacity`** (the roadmap's line) | No history of why stock changed; places typed by staff race sales; a refund puts goods back on sale; only orders and one-place claimants take from it; no reorder level. The counter and holds are reused; the model is new |
| **A stock pack with its own counter fields** | A pack cannot hold stock in the order's batch or refuse an oversell for every path (ADR 0404) |
| **Three packs: catalogue, online shop, point of sale** | More to install and explain; the "where sold" mark does the same. Revisit if a business wants stock without a catalogue |
| **Where sold as a block's filter** | A block hiding a fridge drink from the online shop does not stop an API call posting one. The rule lives in the host (ADR 0404) |
| **A tablet at the fridge in this stage** | The buyer must be identified and must pay on a shared device: an enrolled device and a card reader, which are the till's and stage 44's. A code to the member's own phone needs neither |
| **A basket kept on the host** | A record per visitor, abandoned baskets to clean up and erase, holds that block stock for browsers. The owner chose a basket per device |
| **Holding stock while it sits in a basket** | Browsers would block real buyers; the order's hold during payment is the guarantee |
| **Delivery as a core setting list** | Delivery options are things with prices, tax codes and grants: a sellable object already is |
| **Free postage over an amount as a price adjustment** (stage 34) | Stage 34 is not specced, and "free over an amount" is a rule of the delivery option, priced by the host in `priceLines`. Promo codes and discounts stay stage 34's |
| **A carrier in the first build** | Flat prices and a typed tracking reference work at once; a carrier needs a gatekeeper, an account and every item weighed. The end state, as a named step |
| **Back-orders and pre-orders** | Promised dates and partial shipments; the owner chose sold out |
| **Customer return requests** | The owner chose no; staff record returns |
| **Stock in several places now** | Changes every sale, receipt and count; no client needs it yet. Designed (the place on every movement) and built later |
| **Average or first-in costing** | Accounting choices for the business's accountant. The ledger records the cost on each receipt; a stock value at last cost is shown, nothing more |

## Platform work and pack work

| Piece | Platform or pack | Why |
| --- | --- | --- |
| The `stock` behaviour: counter on `core_capacity`, `core_stock_movement` (append-only, with a place), opening stock, adjustments, `stock.get`, what outsiders see, reorder level | **Platform, new behaviour** (`packages/sdk/src/stock.ts`, `packages/core/src/stock/`, a migration) | Oversell must be refused for every actor in the write's batch |
| `stockMoves`: a record's state moves stock by its quantity (add, remove, set) | **Platform, new declaration** (SDK, `records/transitions.ts`) | Receipts, counts, write-offs and job parts are pack records; the movement must be in their batch |
| An order's `sold` movements, no restock on refund; holds via the existing order hook | **Platform** (`orders/holds.ts`) | The order is core |
| `sellable.goods` (with `soldIn` and later `weight`) and `sellable.delivery`; the channel rule and the delivery rule in `createOrder`; the address on the order (`core_order_delivery`), shown to staff and the buyer, erased | **Platform** (`orders/`, erase) | Prices, where things are sold and what an order needs are the host's (ADR 0404) |
| Postage priced by the host: fixed; free over an amount; by weight | **Platform** (`orders/orders.ts` `priceLines`, the delivery declaration) | Blocks must not calculate prices (`scripts/check-blocks.mjs`) |
| `order.quote`: a public dry run that prices lines and delivery and says what is available, holding nothing | **Platform, opened to the public: a reviewed change** (ADR 0402) | The basket's totals |
| Returns and line refunds: `order.return` (lines, quantities, restock or write off) and the refund of their share, through approval | **Platform** (`orders/refunds.ts`, a new `orders/returns.ts`) | Money and stock in one batch; refunds are core |
| A tax setting per record (issue #198) | **Platform** (`orders/tax.ts`), a later step | One variant object may hold things taxed differently; not needed by the first client (decision 8) |
| Low-stock notices worked out for every write | **Platform** (`stock/`, the ADR 0624 pattern) | A notice sent by a tool would miss sales, imports and counts |
| The shipping gatekeeper (carriers: rates, labels, tracking) | **Platform, a gatekeeper**, a later step | External access goes only through gatekeepers |
| Stock in several places | **Platform**, a later step | Designed here |
| The Shop pack: items, variants, delivery options, shipments, supplier fields, purchase orders and lines, receipts, counts and lines, write-offs; permissions, the stockroom role, settings, views, dashboard, tools, routine mail | **Pack** (`packs/shop`) | Composition |
| Staff screens (stock, receive, count, pack and send, returns, purchase orders) | **Pack blocks, declared as screens** (stage 47) | Staff screens are pack screens in the admin |
| Customer screens: shop, At the gym, item, basket, checkout, my orders | **Pack blocks, web and native**, over headless hooks | Web and native share logic, not screens |
| Suppliers | **Base Organisations**, with the pack's fields | No second address book |

## The model

### Records (Shop pack, `shop.*`)

- **Item** (`shop.item`): name, description (rich text), images, category (text), **where sold**
  (`online`, `in_person`, `both`; default `both`), `publishable` (draft, published; only published
  items are public, and the online list shows only items sold online, the At the gym list only items
  sold in person), the agreement point `shop.buy` (optional), weight (grams, optional, for postage by
  weight), and later its own tax setting (issue #198).
- **Variant** (`shop.variant`): its item, name ("Large / Black"), option values (up to three text
  fields, labelled by the item's option names), SKU, barcode, price (`sellable.price`), cost price
  (last received, read-only, written by the host from receipts), most per order, weight (grams,
  overrides the item's), a state (`active`, `retired`), `sellable` with `goods: { soldIn }` read
  through its item, and `stock` with its reorder level and reorder quantity, and its usual supplier
  (an Organisation). An item with one version still has one variant: the variant is always what is
  bought and counted.
- **Delivery option** (`shop.delivery`): name (the business names its own: "Standard post",
  "Express post", "Collect at the gym", "Take it now"), kind (`post`, `collect`, `here`), where to
  collect (text), price (may be 0), **free over** (an amount of goods, optional), countries it posts
  to (post only; default the business's own), active, and later its weight bands. `sellable.delivery`,
  `maxPerOrder` 1, grants one shipment for `post` and `collect`, nothing for `here`. A new shop is
  seeded with "Collect at the gym" and "Take it now" (price 0) and one post option with no price
  (inactive until a price is set).
- **Weight band** (`shop.weightband`, a later step): a post option's band, "up to N grams", its
  price. An option with bands prices by the order's total weight; a goods line with no weight on
  such an order is refused with which variant.
- **Shipment** (`shop.shipment`, granted by a paid post or collect line): the order, the buyer
  (customer field), the delivery option, a tracking reference (text), states `to_pack` → `packed` →
  `sent` (post) or `ready` → `collected` (collect), and `void` (the order refunded in full). Staff
  move it; the customer reads their own.
- **Supplier details**: fields the pack adds to Organisation (`supplier`, account number, email for
  orders, lead time in days, notes).
- **Purchase order** (`shop.po`) and **purchase line** (`shop.poline`): supplier, reference,
  expected date, states `draft` → `sent` → `part_received` → `received` / `cancelled`; a line has a
  variant, quantity ordered, unit cost (minor units), quantity received so far (read-only, kept by
  the host from receipts).
- **Receipt** (`shop.receipt`): a purchase line, **or none** (the quick stock-in entry, decision
  10: "six bottles bought at the shop down the road"), a variant, quantity, unit cost (optional for
  a quick entry), received by, a note, `stockMoves: add` on entering `received`. Over-receipt
  against a line is allowed with a warning and a notice.
- **Count** (`shop.count`) and **count line** (`shop.countline`): a count (all, a category, a
  supplier's) and its lines, each a variant with the number on hand when the sheet was made
  (shown), the number counted, and `stockMoves: set` on the count's `applied` move. A count is
  applied by a person.
- **Write-off** (`shop.writeoff`): variant, quantity, reason (`damaged`, `expired`, `lost`,
  `used in the business`, `other`), `stockMoves: remove`.

There is no return request record (decision 7): a return is `order.return`, made by staff.

### The `stock` behaviour

- Declared on an object: `stock: { reorderAt?, reorderQty?, show?, lowAt? }`. With it the object
  must be `sellable` with `goods`, or be used by `stockMoves` (a part nobody sells still has stock).
- The host keeps the counter and the ledger. Nobody writes on hand: it changes only by movements.
  Kinds: `opening`, `received`, `sold`, `returned`, `written_off`, `counted`, `adjusted`, `used`.
  Each row: the record, the **place** (one default place in this stage), signed quantity, kind,
  source (order line, a record, a person), who, when, a note, unit cost for `received`. Triggers
  refuse update, delete and `INSERT OR REPLACE` (issue #269's lesson).
- An order line holds on start, confirms as `sold` when paid, releases on cancel or expiry. A
  refund changes nothing in stock; a return does.
- A `set` (count) writes the difference from on hand at the commit; a count below what unpaid
  orders hold is refused with the numbers ("count again in a few minutes").
- Read-only values on the record: `onHand`, `held`, `available`. `stock.get` gives staff the
  numbers and the last movements; customers and the public see only what `show` allows
  (`availability` by default: "In stock" or "Sold out"; or `low`, "only N left" at or below
  `lowAt`).

### Stock in several places (designed, built later)

When a trades client needs it: a place list (the storeroom, each van, a second site), the counter
kept per variant per place (a `core_capacity` row per pair, so the database still refuses a sale
past what that place has), a transfer as two movements in one batch (out of one place, into
another), counts per place, a sale or a job taking from a named place (the till's place, the van of
the person on the job), and `stock.get` summing places for the online shop. The ledger's place
column from the first migration means no history is rewritten. Several locations for one business
(drafted separately) would reuse the same place list.

### Postage (decision 5)

The host prices the delivery line in `priceLines`, never the block:

1. **Fixed** (first build): the option's price.
2. **Free over an amount** (first build, cheap): 0 when the goods' total on the order (before
   postage) is at least the option's "free over". Promo codes and discounts stay stage 34's; when
   stage 34 adds them, whether "free over" counts the goods before or after a discount is its
   decision.
3. **By weight** (a later step): the band for the order's total weight (each goods line's weight
   times its quantity). The variant's weight, else its item's.
4. **A carrier's live rate** (a later step, through the shipping gatekeeper): the gatekeeper asks
   the carrier for the parcel's price to the address; `order.quote` shows it; `order.start` fixes it
   on the order. A label is bought when staff pack the shipment: an outbound action that spends
   money, so it follows the business's approval policy and an AI's request waits for a person. The
   tracking reference and the carrier's events move the shipment. Customs details per item go with
   this step. The gatekeeper is new (`packages/gatekeeper-shipping`, its name the build's) and names
   no carrier in this spec; each carrier is an adapter, as Stripe and the fake are for payments,
   with a fake carrier for tests.

Whether postage is taxed is for the business to confirm with its accountant; the delivery option
is sellable and takes a tax code like any other line.

### Operations (new, platform)

| Operation | Audience | Who may | Risk |
| --- | --- | --- | --- |
| `stock.get` | staff (customer and public through the record's `show`) | `shop:read` | read |
| `stock.movements` | staff | `shop:stock` | read |
| `stock.adjust` (a correction with a reason) | staff | `shop:stock`, a person approves an AI's | write |
| `stock.opening` (first stock, also by import) | staff | `shop:stock` | write |
| `order.quote` | staff, customer, **public** (reviewed) | anyone | read |
| `order.start` gains `delivery` (option, address) | unchanged | unchanged | unchanged |
| `order.return` | staff | `orders:refund` to ask the refund; `shop:stock` to restock | outbound (the refund waits for a person) |
| `order.delivery.get` (the address) | staff, the buyer | `orders:read`, the order's own customer | read |

"My orders" uses `my.list` and `order.get` as they are; the buyer's shipments are read with
`my.list` on `shop.shipment`.

### Tools (Shop pack)

`receive` (against a purchase line), `stockIn` (the quick entry, no purchase order), `startCount`,
`applyCount` (`personApproves`), `writeOff`, `draftReorder` (a draft purchase order from everything
at or below its level for one supplier), `sendPo` (emails the supplier through the email
gatekeeper: outbound, a person approves an AI's), `markPacked`, `markSent` (tracking reference),
`markReady`, `markCollected`, `recordReturn` (calls `order.return`).

### Permissions and roles

`shop:read`, `shop:manage` (items, variants, prices, delivery options), `shop:stock` (receive,
stock in, count, write off, adjust), `shop:purchase` (suppliers and purchase orders), `shop:fulfil`
(pack, send, hand over). Grantable to a coach or desk account (ADR 0600). An optional pack role
`shop.stockroom` for someone who only receives and counts.

### Screens

- **Staff (declared screens, stage 47)**: Stock (every variant, on hand, held, reorder level,
  filters by category and supplier, low first); Receive (scan or pick, against a purchase order, or
  a quick stock-in); Count (a sheet, counted numbers, apply); Orders to send (shipments to pack,
  send, ready, collected); Returns (find an order, record what came back); Purchase orders; a
  variant's history as a record screen. Items and variants are edited on the generic record pages.
- **Customer web**: the shop (published items sold online), **At the gym** (published items sold in
  person, reached from the code on the fridge), item page (variant picker, availability, "Sold
  out"), basket (on the device), checkout (delivery choice, address for post, agreements step if
  any, the provider's page), my orders with shipment state.
- **Native**: shop, At the gym, item, basket, my orders. Checkout opens the provider's hosted page
  as the website does; whether the app may take payment for goods this way is for the business to
  confirm against the app stores' rules (issue #237 asks the same of drop-ins).
- **Not here**: the till's screen, and a shared tablet at the fridge (the till module).

### Notifications and mail

- **Host notices** to people with `shop:stock`: a variant reached its reorder level (once per
  crossing); a count applied with differences over a threshold; a receipt over what was ordered.
  To `shop:fulfil`: a new paid order to pack or prepare (one per order; none for "take it now").
- **Routine mail** to the buyer (ADR 0590, each kind an admin turns off): order sent (with the
  tracking reference), ready to collect (where), collected, a return recorded and its refund sent.
  The order's confirmation is the host's existing mail.
- A purchase order to a supplier is **not** routine mail: it is outbound to an organisation, sent
  by a person or approved.

### What an AI may do

May: read the catalogue, stock and movements; draft item descriptions (publishing waits for a
person, ADR 0480); draft purchase orders and counts; suggest reorder levels from sales; answer
"what's low?". May not: publish an item, apply a count, adjust stock or change a price without a
person approving; send a purchase order without a person approving; approve a refund (never); read
delivery addresses in bulk (addresses are in no `rec_*` view; `order.delivery.get` is per order and
audited). Whether a price field can be marked "an AI's write waits for a person" today must be
checked in the build; if not, that is platform work.

### Privacy and erase

- Delivery addresses live in `core_order_delivery`, in no `rec_*` view, export, dashboard or
  search; read per order by staff with `orders:read` and the buyer; each staff read audited.
- Erasing a Person deletes their delivery addresses at once, clears the customer field on their
  shipments, and detaches their orders as today. How long the business keeps order records is for
  the business to confirm with its accountant.
- Stock movements name staff, not customers (an order's line id only).
- A carrier (later) receives the name and address of one shipment, through the gatekeeper, when a
  label is bought.

## Out of scope

Deferred, each a later step or another stage: a tablet at the fridge and the till (the till
module); stock in several places and transfers (designed above); postage by weight and carriers
(later steps of this stage); tax per item (issue #198, a later step); a second currency, customs
and duties; back-orders, pre-orders and "tell me when it is back"; customer return requests;
promo codes, discounts and gift cards (stage 34); bundles sold as one; selling by weight or length;
serial numbers and expiry dates per unit; average or first-in costing; supplier price lists;
receiving from a supplier's emailed invoice; the job's use of parts (stage 39, on `stockMoves`); a
basket across devices; subscriptions to goods.

## Acceptance criteria

1. With Shop installed, staff create an item with three variants, set prices and opening stock;
   `stock.get` shows on hand per variant, and the ledger shows the opening movements, each at the
   default place.
2. A visitor on the website puts two variants and a ten-class pass in a basket; `order.quote`
   returns the host's prices, the delivery price and availability; the block calculates nothing.
3. Paying holds the stock for the order's life; a second buyer taking the last unit at the same
   time is refused by the database, whatever path (web, app, MCP, staff).
4. An expired or cancelled order gives the units back; a paid one writes `sold` movements; a
   refund alone leaves stock unchanged.
5. A goods order with no delivery line, or post with no address or an address outside the option's
   countries, is refused; a collect or take-it-now order needs no address.
6. **Where sold**: an in-person-only drink on a post or collect order is refused; an online-only
   item on a take-it-now order is refused; the online shop and the At the gym list show only what
   is sold there; the same refusals on MCP and staff paths.
7. **At the gym**: a signed-in member opens the At the gym list from its link, buys a drink with
   "take it now", pays on the fake provider's page; the order is theirs, stock is one lower, and no
   shipment is made. A visitor does the same as a guest with an email address.
8. A paid post order grants one shipment; staff move it to sent with a tracking reference and the
   buyer gets the routine email; collect goes ready, then collected.
9. **Postage**: a fixed price is charged; with "free over" set, an order whose goods reach it pays
   no postage and one below pays the price; `order.quote` and the order agree.
10. A sold-out variant shows "Sold out"; `order.quote` says so; `order.start` refuses it.
11. Staff record a return of one of two units, one back in stock: the ledger shows `returned` +1,
    and a refund of that line's share waits in Approvals for a person with `orders:refund`. A
    customer has no way to start a return.
12. Receiving a purchase line of 24 adds 24, updates the line's received quantity, moves the
    purchase order to part or fully received, and records the unit cost; all in one batch. A quick
    stock-in with no purchase order adds its quantity with kind `received`.
13. Applying a count sets each variant to its counted number with `counted` movements of the
    difference; a count below what unpaid orders hold is refused with the numbers.
14. A sale that takes a variant to its reorder level tells `shop:stock` holders once; another sale
    below it does not tell them again; a receipt above and a later fall tells them again.
15. `draftReorder` builds a draft purchase order for one supplier from the variants at or below
    their level; `sendPo` by an AI waits for a person; by a person it sends.
16. No movement can be changed or deleted, by any statement shape.
17. An AI cannot apply a count, adjust stock, publish an item or approve a refund; its tries are
    queued for a person or refused.
18. Erasing a buyer deletes their addresses and clears their shipments' customer field; the order
    remains, detached.
19. `cos ext check packs/shop` and `cos ext test packs/shop` pass; a runtime extension declaring
    `stock`, `stockMoves`, `sellable.goods` or `sellable.delivery` is refused, as `sellable` is.
20. Cost: `order.quote`, a paid order's confirm and a count's apply each run a bounded number of
    statements (statement-count tests), whatever the number of lines up to the limits.
21. E2E, one test per journey: a web order posted and sent; an At the gym purchase; a return
    recorded at the desk; a purchase order received.
22. The site and `SITE.md` list the Shop pack and its pieces as built, once built, and nothing
    before.

Later steps add theirs: postage by weight (an unweighed line refused on a banded option; the band
priced by total weight); the shipping gatekeeper (a fake carrier's rate in `order.quote`, a label
bought only by a person or an approved request, its events moving the shipment); tax per item (an
item's own code overriding its object's at checkout); stock in several places (a sale past one
place's stock refused while another place has some; a transfer in one batch).

## Dependencies

- Built: 22 and 23 (audiences, the typed client), 24 (client apps, blocks), 25 (orders, payments,
  refunds), 26 (capacity and holds), 28 (publishable, media), 44 (agreements at checkout), routine
  mail (ADR 0590).
- Agreed, being built: **47** (pack screens in the admin, PR #303): the staff screens need it;
  without it they run only in the app.
- Not specced: **34** (promo codes, discounts), **35** (invoices: parts billed on a job), **39**
  (jobs: parts used), **30** (notifications: SMS and push for "ready to collect"), the **till**
  (drafted: in-person payment, the fridge tablet; it requires Shop for goods), several locations
  (drafted: would reuse the place list).
- Issue **#198** (a tax setting per record): a later step; the first client does not need it
  (decision 8).

## Migrations and numbers

Block **BC** in [`parallel-work.md`](../parallel-work.md): migrations 0930 to 0949, ADRs 0680 to
0689. Expected: one migration for `core_stock_movement` (with the place column and its no-update,
no-delete, no-replace triggers); one for `core_order_delivery` and the order's channel and delivery
columns; one for returns (`core_order_return` and its lines); a `core_write_guard` remake only if
`stockMoves` needs a guard kind, numbered after 0851 and carrying every earlier kind (the rule in
`parallel-work.md`); one each later for places and the shipping gatekeeper's references. No `x_*`
table is touched. ADRs the build writes:

1. **0680** The `stock` behaviour: a ledger on capacity's counter, a place on every movement, no
   restock on refund (amends ADRs 0431 and 0433 with dated notes).
2. **0681** `stockMoves`: a record's state moves stock in its batch.
3. **0682** Goods on an order: `sellable.goods`, where sold and the order's channel, delivery
   options, the address and its erase (amends ADRs 0428 and 0435).
4. **0683** `order.quote`: a public dry run of the host's prices (the reviewed opening, ADR 0402).
5. **0684** Returns and line refunds: a return asks the refund of its lines' share (amends ADR
   0429).
6. **0685** Postage priced by the host: fixed, free over an amount, by weight.
7. **0686** A tax setting per record (issue #198, when built; amends ADR 0479).
8. **0687** The shipping gatekeeper: one carrier interface, labels as outbound actions (when
   built).
9. **0688** Stock in several places (when built).

## Suggested build order

| Step | What | Touches | Beside what it can run |
| --- | --- | --- | --- |
| 1 | The `stock` behaviour: SDK declaration and checks, the ledger with its place, counter reuse, opening and adjust, `stock.get`, show rules, the order's `sold` movement and no restock on refund | `packages/sdk` (`stock.ts`, manifest, contract), `packages/core/src/stock/`, `capacity/` (stage 26's reserved area), `orders/holds.ts`, one migration | Beside step 5 on paper and other packs' work; **collides** with anything in `orders/` or `capacity/` (the till, stage 34) and with SDK manifest edits in flight (stage 47's `screens`, PR #303) |
| 2 | `stockMoves` on the transition engine (add, remove, set), low-stock notices | SDK, `records/transitions.ts`, `stock/`, maybe a `core_write_guard` kind | After 1; **collides** with work on the transition engine or `core_write_guard` |
| 3 | Goods and delivery: `sellable.goods` with `soldIn`, `sellable.delivery`, the channel rule, `core_order_delivery`, the address, erase; fixed and free-over postage; `order.quote` (public) | `orders/` (`orders.ts`, `priceLines`), `operations/order.ts`, the HTTP contract, erase (`records/erase.ts`, a reserved area), the typed client regeneration | After 1; **collides** with step 4, the till's step 1, stage 34, anything in erase |
| 4 | Returns and line refunds (`order.return`) | `orders/refunds.ts`, a new `orders/returns.ts` | After 1 and 3; **collides** with any `orders/` work (the till's refunds) |
| 5 | The Shop pack's spine: items (where sold), variants, delivery options (seeded), shipments, supplier fields, permissions, the stockroom role, settings, views, dashboard | `packs/shop`, `pack-roles.ts` (one line, **collides** with other packs' roles) | On paper beside 1 to 4; lands after 1 and 3 |
| 6 | Purchase orders, receipts, quick stock-in, counts, write-offs, `draftReorder`, `sendPo` | `packs/shop`, the email gatekeeper (an organisation recipient; **collides** with email-send work) | Beside 7 and 8 |
| 7 | Returns recorded by staff (`recordReturn`), routine mail kinds, notices' wording | `packs/shop`, routine mail declarations | Beside 6 and 8 |
| 8 | Blocks: customer web and native (shop, At the gym, item, basket, checkout, my orders); staff screens declared for stage 47; e2e | `packs/shop/blocks`, `packs/shop/client`, `apps/app/e2e` | Beside 6 and 7; staff screens need stage 47 merged |
| 9 | `cos shop import` (items, variants, opening stock from a spreadsheet), the site and `SITE.md` | `packages/create-composable-os`, `apps/marketing` | Beside 8 |
| 10 | The first client: the gym's drinks and clothing, the fridge code, a test-mode sale online and at the gym | client repo | After 1 to 9 |
| 11 | Later: postage by weight (weights, bands) | `orders/` `priceLines`, `packs/shop` | **Collides** with `orders/` work |
| 12 | Later: a tax setting per record (#198) | `orders/tax.ts`, `packs/shop` | **Collides** with `orders/` and tax work |
| 13 | Later: the shipping gatekeeper, a fake carrier, live rates in `order.quote`, labels, tracking; customs details | a new `packages/gatekeeper-shipping`, `orders/`, `packs/shop` | Beside pack work; **collides** with `orders/` |
| 14 | Later, when a trades client needs it: stock in several places | `stock/`, `capacity/`, a migration, `packs/shop` | **Collides** with `stock/`, `capacity/` and several-locations work |

**Note (2026-11-24): "my orders" moves to My account (stage 48).** Stage 48's spec
([`48-my-account.md`](48-my-account.md)) makes the base Orders section of My account the one list
of a customer's orders, read through `my.list` and `order.get` as above. Shop ships no customer
"my orders" block (web or native). Instead it declares a **Deliveries** section in its manifest's
`portal` key (`has: ["shop.shipment"]`): the buyer's shipments, with each one's state and the order
it belongs to, read with `my.list` on `shop.shipment`. Build step 8 changes to match: its customer
blocks are shop, At the gym, item, basket, checkout and the Deliveries section (web and native).
The `portal` declaration is stage 48's (build step 5). If Shop's step 8 lands first, it ships the
Deliveries blocks and adds the declaration once stage 48's step 5 is merged. Where "my orders"
appears above (Platform work, Screens, step 8), read this note.

## Size

**Large.** Three platform pieces (a new behaviour with a ledger, a new declaration on the
transition engine, goods, delivery and returns on orders) and a pack the size of Bookings. Up to
**three build sessions at once** for steps 1 to 9: one on steps 1, 2 and 4 in turn, one on step 3
after 1 merges (both touch `orders/`), and one on the pack (5 to 8) from the start against the
manifest on paper. Platform steps in `orders/` run one at a time, and one at a time with the till's.

## Decided by this spec, open to override

- One Shop pack holds catalogue, stock, suppliers and online selling; the till requires it for
  goods.
- Where an item is sold is one field on the item (`online`, `in_person`, `both`), enforced by the
  host from the order's channel, which the host works out.
- A member buying for themselves in person does it on their own phone, from a code at the fridge,
  with a "take it now" delivery; a shared tablet at the fridge is the till module's.
- Stock is a new `stock` behaviour on capacity's counter, with a ledger; not plain capacity.
- Every movement carries a place; one place per business until a trades client needs more.
- Every item has at least one variant; the variant is bought and counted. Up to three options.
- The basket is kept on the device; prices come from `order.quote`; stock is held only while
  paying.
- Delivery options are records priced by the host: fixed and free over an amount first; one
  delivery per order; collect and take it now need no address.
- Posting abroad is a list of countries on a post option, and nothing more, in the first build.
- Customers see "In stock", "Sold out" or "only N left", never the exact count, by default.
- A refund does not restock; a return does, unit by unit, restock or write off.
- Suppliers are Organisations with Shop's fields.
- Cost price is the last received; no costing method.
- Counts and stock adjustments by an AI wait for a person; purchase orders to suppliers are sent by
  a person or approved; a carrier's label (later) is an outbound action under the approval policy.

## Risks

- **Money**: line refunds must never exceed what those lines were paid, tax share included, and
  must still match ADR 0479's rule that a payment matches its order. Whether postage is refunded on
  a part return is follow-up answer 3.
- **Oversell under load**: the database refusal is the guarantee; test with racing buyers on the
  last unit across web, app and staff.
- **Stock drift**: a count racing sales; the "difference at commit" rule must be tested with sales
  during a count.
- **Self-service at the fridge** is on trust: a member who takes a drink and does not pay is not
  something the host can see. Counts show the difference as written off at the next count.
- **Privacy**: delivery addresses are new personal data on the host; keep them out of every bulk
  path and erase them.
- **Tax**: whether goods, postage and sales abroad are taxed alike is for the business to confirm
  with its accountant.
- **App stores**: paying for goods from the app through the provider's page needs checking against
  the stores' rules before release; needs a real device and a store review.
- **Real provider**: nothing in orders has yet run against real Stripe; a shop sale in test mode
  and then live is part of step 10.
- **Consumer rules on returns and refunds** (how long, what must be accepted): for the business to
  confirm with its lawyer; the platform ships no return policy wording.
- **The till**: drafted in parallel; it touches `orders/` too. The seam above is the line; agree
  the order of building before either starts its `orders/` work.

## Follow-up answers

Answered by the owner on 2026-11-24. None changes the build order.

1. **The shop posts to other countries from the start: anywhere, at one fixed international postage
   price.** A post option's list of countries may be "everywhere else", with its own price, so a
   new shop has two options: the business's own country, and everywhere else. Tax, currency and
   customs stay as in "Buyers in other countries" above: tax through the provider by the delivery
   address, one currency, customs not handled. How sales abroad are taxed is still for the business
   to confirm with its accountant before it turns the international option on.
2. **A fridge drink bought on the buyer's own phone needs no sign-in.** A visitor buys as a guest
   with an email address, as on the website (ADR 0428).
3. **A return of part of a posted order refunds the goods only.** Staff can refund postage
   separately.
4. **Members use their own phones at the fridge first.** A shared tablet comes later, with the
   till's card reader. (Decided by the coordinator as the conventional order of building.)
