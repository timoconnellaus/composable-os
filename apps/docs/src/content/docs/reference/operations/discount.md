---
title: "discount.* operations"
description: "The core operations named discount.*"
sidebar:
  label: "discount"
editUrl: false
---

## discount.check

Check a promo code against a basket before an order is started: whether it applies to these lines for this caller, and what it would take off each. Nothing is held: the code's uses are kept only once an order is started (order.start, order.applyCode). A code that does not apply gets one answer, whatever the reason (unknown, ended, used up, not for this buyer, not for these items): valid false and the same message. `better` says that a price applying by itself (a member's) takes more off, so the code would not be the order's deal. A guest is nobody proved: a code for members, new customers or one per person is not valid for them. Amounts are in the currency's minor unit. Read-only.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `read` |
| Audiences | `staff`, `customer`, `public` |
| Actors | `human` |
| Also | host-internal (`hostInternal`); not offered to MCP clients (`mcp.expose: false`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `code` | string | yes | min length 1, max length 64 | A promo code the buyer typed. The host decides what it takes off, from the discount it names: the better for the buyer of it and any member's price applies. One answer for a code that does not apply, whatever the reason. |
| `lines` | array of object | yes | at least 1, at most 50 | What is in the basket. There is no price here: the host reads it from each record. |
| `lines[].object` | string | yes | min length 1, max length 80 | The object of the record to buy |
| `lines[].id` | string | yes | min length 1, max length 64 | The record to buy |
| `lines[].quantity` | integer |   | ≥ 1, ≤ 1000, default `1` |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `valid` | boolean | yes |   |   |
| `message` | string or null | yes |   | Why not, the same words for every reason |
| `title` | string or null | yes |   | The discount's name, when valid |
| `amount` | number | yes |   | What the code takes off these lines; 0 when not valid |
| `lines` | array of object | yes |   |   |
| `lines[].position` | number | yes |   |   |
| `lines[].discount` | number | yes |   | What it takes off this line |
| `better` | boolean | yes |   | A price that applies by itself takes more off: that would be the deal instead |
| `reason` | string |   |   | Staff only: why it does not apply |
