# ADR 0689: The Shop pack, and public reads through a public record

Status: accepted, 2026-11-25 (stage 37, build step 5). Builds on ADRs
[0680](0680-the-stock-behaviour.md) (`stock`), [0681](0681-stock-moves-a-record-s-state-moves-stock.md)
(low stock), [0682](0682-goods-on-an-order-where-sold-the-channel-and-the-delivery.md) (goods,
delivery and the channel), [0683](0683-order-quote-a-public-dry-run-of-the-host-s-prices.md)
(`order.quote`) and [0685](0685-postage-priced-by-the-host.md) (postage). Amends
[ADR 0438](0438-the-public-scope.md) (the public scope) with a dated note. The last number of
block BC that the spec left unnamed.

## Context
Steps 1 to 3 built the host's side of a shop: stock on a ledger, where goods are sold worked out
from the order's channel, delivery options priced by the host, and the public's dry run. Step 5 is
the pack that composes them for a business: its items and their variants, the ways an order
reaches its buyer, the shipments staff pack, the supplier's details, who may do what.

One thing the manifest could not say. The spec has only published items public, and a variant is
what is bought. Its public reads must hold while the variant is active (a retired size is not
sold) **and** its item is published (a draft hoodie being set up, its price not final, is neither
shown nor sold). The public scope took one condition, on a state (a select field) of the record or
of the record a relation points to; being published is not a select, and one condition cannot be
two. A filter in the pack's tool or a block would not stop `order.start` (buying reads the scope,
ADR 0438), so this is the host's to say.

## Decision

**A read declaration's `when` may be a list** of up to three conditions that all hold
(`[{ field: "state", in: ["active"] }, { via: "item" }]`). One condition, as before, still reads
the same. Each condition is one of:
- `{ field, in }`: a state of the record (unchanged);
- `{ via, field, in }`: a state of the record `via` points to (unchanged);
- **`{ via }` alone**: the record `via` points to is one the public reads: a row of its object's
  public source (the published versions, if it is publishable: its live view, ADR 0442) meeting
  its own `when`. `public` only (a `signedIn` declaration names a state); the object pointed to
  must declare `public`; its own `when` may not use `via` alone (one step, no chains).

The seam builds it as one `AND` of the conditions over the object's view, a bare `via` as
`<relation> IN (SELECT id FROM <its public source> WHERE <its conditions>)`. Every reader of the
public scope (public reads, a customer reading a public object, `order.start`, `order.quote`,
`stock.get`, `capacity.get`) holds to it, since they all read the same source. `cos ext check`
lists each condition in its summary of what is opened to outsiders.

**The Shop pack** (`packs/shop`, `@composable-os/pack-shop`):
- **Items** (`shop.item`) are `publishable` with a slug; the public reads published ones: name,
  address, description, pictures, category, where sold, the three option names, when published.
  **Where sold** (`whereSold`: both, online, in person; required, default both) is not content:
  a change takes effect at once, published or not, because the host reads it on every order.
- **Variants** (`shop.variant`) are `sellable` goods sold where their item is
  (`goods.soldIn: "item.whereSold"`), with `stock` (reorder level and quantity; outsiders told
  only "in stock" or "sold out", the default `show`), told to `shop:stock`'s holders when low, a
  state (active, retired), and the agreement point `shop.buy`. The public reads an active variant
  of a published item: its item, name, three option values, price and most per order. Cost price,
  usual supplier, SKU, barcode and the reorder numbers stay staff-only. The variant's name is the
  order line's title, so it is the whole name the buyer sees ("Club hoodie, Large / Black").
- **Delivery options** (`shop.delivery`) are `sellable.delivery`, taxed with the provider's
  shipping code, granting a **shipment** for post and collect. The public reads every option's
  name, kind, price, free over, countries, where to collect and whether it is on: **take it now is
  public**, because a member buys at the gym on their own phone through the website, signed in or
  as a guest (decision 13, follow-up 2); the host refuses one that is off. A new shop is seeded with
  "Collect at the gym" and "Take it now" at 0, on, and "Standard post" and "International post"
  (`*`), both off and with no price until the business sets one (a post option with no price is
  refused, `no_price`).
- **The business's country is a pack setting** (`country`). The host keeps no home country (ADR
  0682) and the organisation's settings have none (its name, logo and time zone). A seed is fixed
  at install, before anyone can set the setting, so the seeded Standard post has no countries until
  the business gives it its own; a post option made afterwards takes the setting
  (`defaultSetting`). Deriving a country from the organisation's time zone was rejected: a guess
  about where a business posts from is not the host's to make.
- **Shipments** (`shop.shipment`) are made only by the host's grant: the order, the buyer
  (`order.person`, not required, so erasing the buyer clears it and the shipment stays), the
  option, its kind and where to collect, all read-only. States: to pack, packed, sent (final),
  ready, collected (final), and void, the host's only, before it went (an order refunded in full).
  The buyer reads their own (`customer`). Staff move them through the record page or the tools.
- **Prices are a person's to change**: the variant's price and the option's price, free over,
  countries and on/off are `personApproves`, so an AI's, an automation's or extension code's
  write waits for a person (spec, What an AI may do).
- **Suppliers are Organisations** with the Shop's fields (supplier, account number, email for
  orders, lead time, notes).
- **Permissions are tools'.** `shop:read` and `shop:stock` open the stock levels; `shop:fulfil`
  the shipment tools. The **stockroom role** (`shop.stockroom`) holds `shop:stock` and reads items
  and variants. `shop:read` and `shop:fulfil` are grantable, to a coach or desk account (ADR
  0600); `shop:stock` is not, as a role holds it (ADR 0600's rule). `shop:manage` and
  `shop:purchase` come with the tools that need them (purchase orders, step 6): items, variants
  and options are edited on the record pages, with `records:write`.
- Every tool is the staff's in this step.

## Consequences
- A catalogue's child record can follow its parent's publishing without a state copied onto it.
  Ticketing's and Content's declarations are unchanged.
- A shipment's states do not know its kind: nothing in the host stops a posted shipment being
  marked ready to collect. The record page hides the wrong button (`hideWhen` on the kind), and a
  move conditioned on a field's value would be platform work if it is needed (step 7's routine mail
  can read the kind).
- The cost price is declared, read-only, and written by nothing yet: step 6 decides how a receipt
  writes it.
- The seeded Standard post posts nowhere until the business sets its country on it.
- Tested in the real host: `apps/runner/test/shop.test.ts` (a visitor's posted order, a member's
  take-it-now drink, the channel refused on every path, stock held and sold, the shipment granted,
  packed and sent by a desk account granted `shop:fulfil`, collect, erase, the stockroom role)
  and `packages/core/test/public-when-all.test.ts` (the declaration and the seam).

## Amended at review (2026-11-25, PR #455)

- **Three more fields wait for a person when an AI or an automation changes them:** the item's
  "where sold", the variant's item, and a delivery option's kind. None is a price, but each
  changes what is sold, where, or what the public sees.
- **Known and left for later steps:** a shipment's moves do not depend on its kind (a posted
  shipment can be marked ready to collect by a record update; a move conditioned on a field's
  value is platform work, wanted before step 7's mail); "Take it now" cannot be kept to signed-in
  members; reactivating a retired variant, `maxPerOrder` and the `country` setting do not wait
  for a person; the stockroom role holds `shop:stock`, while the core's stock writes need
  `stock:adjust` (step 6 settles it); a guest's shipment has no buyer, so no customer reads it.
