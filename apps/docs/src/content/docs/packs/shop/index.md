---
title: "Shop"
description: "One list of what a business sells, in its versions, sold online, in person or both, with stock the host keeps, ways to get an order to its buyer, and the shipments staff pack and send."
sidebar:
  label: "Overview"
  order: 0
editUrl: false
---

One list of what a business sells, in its versions, sold online, in person or both, with stock the host keeps, ways to get an order to its buyer, and the shipments staff pack and send.


## What it is for

The Shop keeps one list of the things a business sells: drinks from a fridge, branded clothing in
sizes, supplements, spare parts. Each thing is marked for where it is sold (online, in person or
both), has its prices and pictures, and the host keeps how many there are. Buyers order online and
have it posted or collect it, or buy at the gym on their own phone and take it now. A paid order to
post or collect gives staff a shipment to pack and send or hand over.

It requires no other pack.

## Concepts

- **Item** (`shop.item`): a thing in the shop (a club hoodie), with its description, up to three
  pictures, a category, where it is sold and the names of its options (size, colour). Published as
  versions: only a published item is public.
- **Variant** (`shop.variant`): one version of an item that is bought and counted (the large black
  hoodie), with its option values, SKU, barcode, price, most per order, weight, reorder level and
  quantity, and usual supplier. Active or retired. An item with one version has one variant. Its
  name is what the buyer's order shows, so it is the whole name ("Club hoodie, Large / Black").
- **Stock**: on hand, held by orders being paid for, and available, kept by the host from a ledger
  nobody edits.
- **Delivery option** (`shop.delivery`): a way an order reaches its buyer, of a kind: post (to an
  address in its countries, or `*` for everywhere else), collect (where to collect it), or take it
  now (bought in person). Each has a price, which may be 0, and may be free over an amount.
- **Shipment** (`shop.shipment`): what a paid post or collect order gives staff to do: to pack,
  packed, then sent (with a tracking reference) or ready to collect, then collected.
- **Supplier**: an Organisation with the Shop's fields: marked a supplier, an account number, an
  email for orders, a lead time in days and notes.

## How the pieces fit

- **Where something is sold is the host's.** A variant is [sellable](/reference/behaviours/#sellable)
  goods sold where its item says. The host works out an order's channel from its delivery (online
  for post and collect, in person for take it now) and refuses a line not sold there, from the
  website, the app, MCP or staff alike. A fridge drink cannot be posted; an online-only hoodie
  cannot be taken now.
- **Stock is the host's.** A variant has [stock](/reference/behaviours/#stock): an order holds its
  units while it is unpaid, sells them when the verified payment arrives, and gives them back if it
  expires or is cancelled; a refund alone leaves stock as it is. The database refuses a sale past
  what is available. Staff enter opening stock and corrections with `stock.opening` and
  `stock.adjust`. When on hand falls to the reorder level, the staff who hold `shop:stock` are told
  once.
- **Postage is the host's.** The buyer chooses a delivery option in `order.start`; the host adds it
  to the order, needs an address for post in one of its countries, and prices it, nothing at or
  over its free over. `order.quote` gives the same numbers for a basket without holding anything.
- **What outsiders read.** The public reads published items, the active variants of published
  items (never a draft's or a retired one), and the delivery options. Buyers are told "In stock" or
  "Sold out", never a count. Cost price, supplier, SKU, barcode and reorder numbers are for staff.
  A buyer reads their own shipments.
- **A shipment is made by the host** when a post or collect order is paid, with its order, buyer,
  option, kind and where to collect; take it now makes none. A full refund before it is sent voids
  it. Erasing the buyer clears the shipment's buyer and keeps the shipment.
- **Prices are a person's to change.** A variant's price, and an option's price, free over,
  countries and whether it is on, wait for a person when the assistant, an automation or code
  changes them. Publishing an item is a person's too.
- **Who may do what.** Ordinary staff do all of it. The **stockroom** role reads items, variants
  and stock levels and nothing else. A coach or desk account may be granted `shop:read` (stock
  levels) or `shop:fulfil` (shipments).

## Main flows

1. **Set up the shop.** A new shop has "Collect at the gym" and "Take it now" at no charge, and
   "Standard post" and "International post", off until the business gives them a price (and
   Standard post its country, also the `country` setting new post options start with) and turns
   them on.
2. **Add an item.** Staff create an item, mark where it is sold, add its variants with prices,
   enter opening stock with `stock.opening`, and publish the item.
3. **Sell online.** A buyer's basket is priced with `order.quote`; `order.start` with a post or
   collect delivery holds the stock; paying on the provider's page sells it and makes the shipment.
4. **Sell at the gym.** A member, or a visitor as a guest, picks an in-person item on their phone
   and pays with take it now; the stock goes down and nothing is shipped.
5. **Send and hand over.** Staff list what is left with `shipmentsToSend`, then `markPacked`,
   `markSent` (with the tracking reference), `markReady` and `markCollected`.
6. **Watch the stock.** `stockLevels` lists every active variant's numbers, lowest first, or only
   the low ones, by category or supplier; the Shop dashboard shows what is low by supplier, what is
   waiting to be packed or collected, and what sold.

## What is built

Items, variants, delivery options with their seeds, shipments, the supplier fields, the stockroom
role and the two grantable permissions, the `country` setting, the views (sold online, sold in
person, stock, to pack and send, ready to collect), the variants, shipments and supplies tabs, the
Shop dashboard, and the tools `stockLevels`, `shipmentsToSend`, `markPacked`, `markSent`,
`markReady` and `markCollected`.

Not in the code yet: purchase orders, receipts, quick stock-in, counts and write-offs; returns
recorded by staff and the buyer's emails; the customer blocks and staff screens; the import from
a spreadsheet; postage by weight; a tax setting per item; carriers.


## Reference

Generated from the code:

- [Data model](/packs/shop/data-model/)
- [Operations and tools](/packs/shop/tools/)
- [Permissions and roles](/packs/shop/permissions/)
- [Screens](/packs/shop/screens/)
- [Messages](/packs/shop/messages/)
- [Settings](/packs/shop/settings/)
- [Decisions](/packs/shop/decisions/)

The specification is stage 37's, [37-shop.md](https://github.com/timoconnellaus/composable-os/blob/main/docs/stages/37-shop.md).

This page is [shop/docs/overview.md](https://github.com/timoconnellaus/composable-os/blob/main/packs/shop/docs/overview.md), written by hand beside the code.
