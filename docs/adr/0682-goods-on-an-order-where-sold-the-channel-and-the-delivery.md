# ADR 0682: Goods on an order: where sold, the order's channel, the delivery and its address

Status: accepted, 2026-11-25 (stage 37, build step 3). Builds on
[ADR 0435](0435-sellable-what-may-be-bought-and-what-a-paid-line-grants.md) (`sellable`),
[ADR 0428](0428-buying-without-an-account.md) (buying without an account) and
[ADR 0680](0680-the-stock-behaviour.md) (`stock`); amends ADRs 0428, 0435 and
[0479](0479-tax-at-checkout.md) with dated notes. Opens `order.delivery.get` to customers and the
public (ADR 0402: a reviewed change, in `packages/core/open-operations.json`).

## Context
A shop sells some things online only, some in person only (a drink from the fridge) and most both
ways (decision 3). Goods bought online are posted or collected; bought at the gym, they are taken
now (decision 4, 13). A block that hides the fridge drink from the online shop does not stop an
API call posting one (ADR 0404): where something is sold must be the host's rule, and so must
whether an order needs an address, which delivery it has and what that costs. A post delivery's
address is new personal data on the host.

## Decision
- **`sellable.goods: { soldIn? }`** marks an object's records as goods. `soldIn` names a select
  field whose values are among `online`, `in_person` and `both`, of the object or through up to two
  relations (`item.whereSold`: a variant is sold where its item is). Empty is `both`. A sold object
  with `stock` must declare `goods` (ADR 0680's open point). Not with `deposit`, `recurring` or
  `moves`.
- **`sellable.delivery: { kind, freeOver?, countries?, active? }`** marks an object's records as
  delivery options: `kind` a select of `post`, `collect` and `here`; `freeOver` a currency or number
  field (ADR 0685); `countries` a text field of two-letter codes, or `*` for every country no other
  live post option of the object names ("everywhere else"); `active` a boolean (off: not offered).
  An option is sellable, so it has a price (which may be 0), a tax code and a grant (a shipment).
  Not with `goods`, `deposit`, `recurring`, `moves`, `onePerPerson`, `maxPerOrder` or `stock`.
- **One delivery per goods order, chosen in `delivery`, never a line.** `order.start` takes
  `delivery: { object, id, address? }`; the host adds it as the order's last line, quantity 1.
  Refused: goods with no delivery (`delivery_needed`), a delivery record among the lines
  (`delivery_line`), a delivery with no goods (`delivery_without_goods`), a record that is not a
  delivery option (`not_delivery`), one switched off (`not_for_sale`).
- **The channel is the host's.** `post` and `collect` make the order `online`, `here` makes it
  `in_person`. It is written on `core_order.channel` when the order starts and a trigger keeps it
  (migration 0932); no caller supplies it. A goods line whose `soldIn` does not include the channel
  is refused (`not_sold_here`, with the channel), on every path: a customer, a guest, staff, a
  pack's tool. Records that are not goods (a pass) are sold in every channel. The till's desk
  orders (stage 50) will be in person by this same rule, with no delivery line.
- **The address.** A post delivery needs one (`address_needed`) in one of the option's countries
  (`address_country`); collect and here take none (`address_not_taken`). It is kept in
  `core_order_delivery` with the delivery's kind and line: in no `rec_*` view, export, dashboard or
  search, never in the audit log (`order.start` and `order.quote` redact `address`), never changed
  (triggers refuse update, delete and a second insert, so `INSERT OR REPLACE` too). It is read one
  order at a time with `order.delivery.get`: staff with `records:read` (each read audited, MCP not
  exposed), a signed-in customer their own order, a guest with the order's token.
- **Tax.** With tax at checkout on, a post delivery's address is the place of the order's goods
  lines and its delivery line (a line whose object declares its own place keeps it), so the
  provider taxes the sale where the goods go. The copy of what was sent that the host keeps
  (`core_order_checkout.tax_lines`) leaves the address out.
- **Grants.** A paid delivery line grants what its object declares (a shipment) for `post` and
  `collect`; a `here` delivery grants nothing (the kind as the order started, from
  `core_order_delivery`).
- **Erase.** Erasing a Person blanks the address of their orders' deliveries at once and marks the
  row erased; the order stays, detached, as before (ADR 0646). Clearing a shipment's customer
  field is the Shop pack's records' erase, as any record's.

## Consequences
- An order of goods costs one extra line and one row; a paid one with a here delivery writes no
  grant. Orders without goods are exactly as before.
- The business's own country is not a host setting: an option with no countries posts nowhere.
  The Shop pack seeds its post option with the business's country (step 5).
- `core_order.channel` is not in `rec_order`: a view remade in a migration numbered below 0950
  would be dropped by 0950's on a fresh database. It is read by platform code (and
  `order.delivery.get`); a later migration after 0950 may add it to the view.
- Postage by weight, carriers and stock in several places are later steps of stage 37.
- **"Take it now" is the buyer's word.** Choosing a `here` delivery proves nothing about where
  the buyer is: a guest on the website can pick it and buy an item sold in person only. That is
  the design (a member pays on their own phone at the fridge). A business that minds does not
  publish its `here` option on the public shop.
