---
title: "Shop: permissions and roles"
sidebar:
  label: "Permissions and roles"
  order: 3
editUrl: false
---

A tool with no permission of its own is held by admins and members as any tool is (a viewer only when its risk is `read`). A permission a tool names is held by the roles that list it; a **restricted** one is held by admins and by a staff account an admin granted it, and by nobody else; a **grantable** one can be granted to a staff account one by one.

## Permissions its tools declare

| Permission | Tools | Restricted | Grantable | Roles holding it | What a grant gives |
| --- | --- | --- | --- | --- | --- |
| `shop:read` | [stockLevels](/packs/shop/tools/#stocklevels) |   | yes |   | Shop stock: see every variant's stock, what is held by orders being paid and what is low. |
| `shop:stock` | [stockLevels](/packs/shop/tools/#stocklevels) |   |   | `shop.stockroom` |   |
| `shop:fulfil` | [shipmentsToSend](/packs/shop/tools/#shipmentstosend), [markPacked](/packs/shop/tools/#markpacked), [markSent](/packs/shop/tools/#marksent), [markReady](/packs/shop/tools/#markready), [markCollected](/packs/shop/tools/#markcollected) |   | yes |   | Shop orders: see what is to pack, send or hand over, and mark it packed, sent, ready or collected. |

## Roles

### Stockroom (`shop.stockroom`)

Sees the items, the variants and their stock levels, for someone who only receives and counts stock. Nothing else: no people, orders, prices to change or settings.

|  |  |
| --- | --- |
| Permissions | `shop:stock` |
| Reads | `shop.item`, `shop.variant` |
