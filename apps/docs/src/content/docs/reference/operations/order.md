---
title: "order.* operations"
description: "The core operations named order.*"
sidebar:
  label: "order"
editUrl: false
---

## order.adjust

Give a discount on a pending order whose payment page has not opened: a percentage or an amount, off one line or the whole order, with a reason. Within the limit an admin set it applies at once and the order's total drops; above it, the discount waits in the Approvals inbox for an admin, and the order cannot be paid until it is decided. An AI's request always waits. A discount cannot take an order to nothing. Returns the order.

|  |  |
| --- | --- |
| Permission | `orders:discount` |
| Risk | `write` |
| Audiences | `staff` |
| Actors | `human`, `assistant`, `mcp` |
| Also | always reviewed when called by `assistant`, `mcp` (`alwaysReview`); reviewed by a person when its own rule says so for the input (`reviewWhen`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes | min length 1, max length 64 | Order id (ord_…) |
| `lineId` | string |   | min length 1, max length 64 | The line to take it off (orl_…). Left out: the whole order, spread over its lines |
| `percent` | number |   | &gt; 0, ≤ 100 | A percentage off what is left to pay, rounded down on each line. Or pass amount |
| `amount` | integer |   | ≥ 1, ≤ 100000000 | An amount off, in the currency's minor unit (cents). Or pass percent |
| `reason` | string | yes | min length 1, max length 500 | Why: shown to staff on the order |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `state` | `"pending"`, `"part_paid"`, `"paid"`, `"cancelled"`, `"expired"`, `"refunded"` | yes |   |   |
| `currency` | string | yes |   |   |
| `total` | number | yes |   |   |
| `paid` | number | yes |   |   |
| `balance` | number | yes |   |   |
| `refunded` | number | yes |   | What has gone back to the buyer, confirmed by the provider |
| `pay` | `"full"`, `"deposit"` | yes |   |   |
| `deposit` | number or null | yes |   |   |
| `balanceDueAt` | string or null | yes |   |   |
| `expiresAt` | string or null | yes |   |   |
| `paidAt` | string or null | yes |   |   |
| `createdAt` | string | yes |   |   |
| `taxAmount` | number | yes |   | The tax inside what has been paid, as the payment provider calculated it. Prices include it, so it does not add to the total. Zero when tax is off or none was charged. |
| `taxRefunded` | number | yes |   | The tax the provider said went back with refunds |
| `taxCountry` | string or null | yes |   | The country the latest taxed payment was for |
| `discount` | number | yes |   | Money taken off the order (its discounts), already out of the total |
| `lines` | array of object | yes |   |   |
| `lines[].id` | string | yes |   |   |
| `lines[].position` | number | yes |   |   |
| `lines[].object` | string | yes |   |   |
| `lines[].recordId` | string | yes |   |   |
| `lines[].title` | string | yes |   |   |
| `lines[].quantity` | number | yes |   |   |
| `lines[].unitPrice` | number | yes |   |   |
| `lines[].total` | number | yes |   |   |
| `lines[].taxAmount` | number | yes |   | The tax inside this line's payments, as the payment provider calculated it |
| `lines[].discount` | number | yes |   | The line's share of the order's discounts: it costs total less this |
| `adjustments` | array of object |   |   | Staff only: the discounts on the order, in the order they were given |
| `adjustments[].id` | string | yes |   |   |
| `adjustments[].lineId` | string or null | yes |   | The line it is on; null: spread over the order |
| `adjustments[].kind` | `"code"`, `"automatic"`, `"staff"`, `"referral"` | yes |   |   |
| `adjustments[].amount` | number | yes |   | What it took off, in the currency's minor unit |
| `adjustments[].percent` | number or null | yes |   | The percentage asked for, when it was one |
| `adjustments[].reason` | string or null | yes |   |   |
| `adjustments[].givenBy` | string or null | yes |   | The staff account that gave it |
| `adjustments[].approval` | string or null | yes |   | The approval it waited in, when it did |
| `adjustments[].createdAt` | string | yes |   |   |
| `personId` | string or null |   |   |   |
| `email` | string or null |   |   |   |
| `placedAs` | `"customer"`, `"public"`, `"staff"` |   |   |   |

## order.applyPaymentEvent

Platform use only: apply a payment or refund event the payments gatekeeper verified and the host stored. Takes only the event's key: the event itself is read from what the host stored, so nothing passed here can describe a payment. Applying an event twice changes nothing. Run by the host's payments adapter and the minute cron.

|  |  |
| --- | --- |
| Permission | `records:write` |
| Risk | `write` |
| Audiences | `staff` |
| Actors | `automation` |
| Also | not offered to MCP clients (`mcp.expose: false`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `provider` | string | yes | min length 1, max length 40 |   |
| `eventId` | string | yes | min length 1, max length 200 |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `outcome` | string | yes |   |   |
| `orderId` | string or null | yes |   |   |
| `state` | `"pending"`, `"part_paid"`, `"paid"`, `"cancelled"`, `"expired"`, `"refunded"` or null | yes |   |   |
| `confirmation` | object or null | yes |   |   |
| `confirmation.orderId` | string | yes |   |   |
| `confirmation.token` | string | yes |   |   |

## order.cancel

Cancel an order. A signed-in customer can cancel their own order while nothing has been paid on it. Staff can also cancel an order that is part paid (a deposit was paid): that gives up its places, and refunding what was paid is a separate step. A paid order is refunded, not cancelled. Returns the order.

|  |  |
| --- | --- |
| Permission | `records:write` |
| Risk | `write` |
| Audiences | `staff`, `customer` |
| Also | host-internal (`hostInternal`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes | min length 1, max length 64 | Order id (ord_…) |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `state` | `"pending"`, `"part_paid"`, `"paid"`, `"cancelled"`, `"expired"`, `"refunded"` | yes |   |   |
| `currency` | string | yes |   |   |
| `total` | number | yes |   |   |
| `paid` | number | yes |   |   |
| `balance` | number | yes |   |   |
| `refunded` | number | yes |   | What has gone back to the buyer, confirmed by the provider |
| `pay` | `"full"`, `"deposit"` | yes |   |   |
| `deposit` | number or null | yes |   |   |
| `balanceDueAt` | string or null | yes |   |   |
| `expiresAt` | string or null | yes |   |   |
| `paidAt` | string or null | yes |   |   |
| `createdAt` | string | yes |   |   |
| `taxAmount` | number | yes |   | The tax inside what has been paid, as the payment provider calculated it. Prices include it, so it does not add to the total. Zero when tax is off or none was charged. |
| `taxRefunded` | number | yes |   | The tax the provider said went back with refunds |
| `taxCountry` | string or null | yes |   | The country the latest taxed payment was for |
| `discount` | number | yes |   | Money taken off the order (its discounts), already out of the total |
| `lines` | array of object | yes |   |   |
| `lines[].id` | string | yes |   |   |
| `lines[].position` | number | yes |   |   |
| `lines[].object` | string | yes |   |   |
| `lines[].recordId` | string | yes |   |   |
| `lines[].title` | string | yes |   |   |
| `lines[].quantity` | number | yes |   |   |
| `lines[].unitPrice` | number | yes |   |   |
| `lines[].total` | number | yes |   |   |
| `lines[].taxAmount` | number | yes |   | The tax inside this line's payments, as the payment provider calculated it |
| `lines[].discount` | number | yes |   | The line's share of the order's discounts: it costs total less this |
| `adjustments` | array of object |   |   | Staff only: the discounts on the order, in the order they were given |
| `adjustments[].id` | string | yes |   |   |
| `adjustments[].lineId` | string or null | yes |   | The line it is on; null: spread over the order |
| `adjustments[].kind` | `"code"`, `"automatic"`, `"staff"`, `"referral"` | yes |   |   |
| `adjustments[].amount` | number | yes |   | What it took off, in the currency's minor unit |
| `adjustments[].percent` | number or null | yes |   | The percentage asked for, when it was one |
| `adjustments[].reason` | string or null | yes |   |   |
| `adjustments[].givenBy` | string or null | yes |   | The staff account that gave it |
| `adjustments[].approval` | string or null | yes |   | The approval it waited in, when it did |
| `adjustments[].createdAt` | string | yes |   |   |
| `personId` | string or null |   |   |   |
| `email` | string or null |   |   |   |
| `placedAs` | `"customer"`, `"public"`, `"staff"` |   |   |   |

## order.checkout

Open the payment provider's own page to pay for an order, and get its address to send the buyer to. The host says what is charged: the whole price or the deposit for an order with nothing paid (no amount may be given), or, for a part-paid order, the balance or a part of it of at least the set minimum (`amount`, in the currency's minor unit). The buyer comes back to `returnUrl`, which must be on one of the deployment's listed sites; coming back does not mark anything paid. Only the provider's confirmation does. A guest passes the order's token; a signed-in customer pays their own orders.

|  |  |
| --- | --- |
| Permission | `records:write` |
| Risk | `write` |
| Audiences | `staff`, `customer`, `public` |
| Also | host-internal (`hostInternal`); not offered to MCP clients (`mcp.expose: false`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes | min length 1, max length 64 | Order id (ord_…) |
| `token` | string |   | min length 1, max length 128 | A guest's token for the order |
| `returnUrl` | string | yes | min length 1, max length 2000 | Where the buyer comes back to |
| `amount` | integer |   | &gt; 0, ≤ 9007199254740991 | Part-paid orders only: how much to pay towards the balance, in minor units |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `url` | string | yes |   | The provider's payment page |
| `amount` | number | yes |   |   |
| `currency` | string | yes |   |   |
| `kind` | `"full"`, `"deposit"`, `"balance"`, `"part"` | yes |   |   |
| `expiresAt` | string or null | yes |   |   |

## order.delivery.get

How one order's goods get to the buyer: the delivery option chosen, its kind (post, collect, or here: taken now in person), whether the order is online or in person, and for a post delivery the address. One order at a time: addresses are in no list, view, export or search. Staff read any order's (each read is on record in the audit log); a signed-in customer their own; a guest with the order's token. An order without goods has none (not found). Read-only.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `read` |
| Audiences | `staff`, `customer`, `public` |
| Also | host-internal (`hostInternal`); not offered to MCP clients (`mcp.expose: false`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes | min length 1, max length 64 | Order id (ord_…) |
| `token` | string |   | min length 1, max length 128 | A guest's token for the order |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `orderId` | string | yes |   |   |
| `channel` | `"online"`, `"in_person"` or null | yes |   |   |
| `kind` | `"post"`, `"collect"`, `"here"` | yes |   |   |
| `lineId` | string | yes |   | The order's delivery line |
| `option` | object | yes |   |   |
| `option.object` | string | yes |   |   |
| `option.recordId` | string | yes |   |   |
| `option.title` | string | yes |   |   |
| `address` | object or null | yes |   | A post delivery's; null otherwise |
| `address.name` | string | yes |   |   |
| `address.line1` | string | yes |   |   |
| `address.line2` | string or null | yes |   |   |
| `address.city` | string or null | yes |   |   |
| `address.region` | string or null | yes |   |   |
| `address.postcode` | string or null | yes |   |   |
| `address.country` | string | yes |   |   |
| `erased` | boolean | yes |   | The buyer's erase removed the address |

## order.expireDue

Platform use only: expire pending orders whose time to pay has run out (the minute cron). Their held places go back. Part-paid orders never expire. Returns the orders expired.

|  |  |
| --- | --- |
| Permission | `records:write` |
| Risk | `write` |
| Audiences | `staff` |
| Actors | `automation` |
| Also | not offered to MCP clients (`mcp.expose: false`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `limit` | integer |   | ≥ 1, ≤ 50, default `50` |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `expired` | array of string | yes |   |   |

## order.extendBalanceDue

Give a part-paid order (a deposit was paid) more time: set the date its balance is due. The new date must be in the future. Nothing else changes: the order keeps its places, and the buyer pays the rest from their order link. Returns the order.

|  |  |
| --- | --- |
| Permission | `records:write` |
| Risk | `write` |
| Audiences | `staff` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes | min length 1, max length 64 | Order id (ord_…) |
| `balanceDueAt` | string (date-time) | yes | pattern `^(?:(?:\d\d[2468][048]\|\d\d[13579][26]\|\d\d0[48]\|[02468][048]00\|[13579][26]00)-02-29\|\d{4}-(?:(?:0[13578]\|1[02])-(?:0[1-9]\|[12]\d\|3[01])\|(?:0[469]\|11)-(?:0[1-9]\|[12]\d\|30)\|(?:02)-(?:0[1-9]\|1\d\|2[0-8])))T(?:(?:[01]\d\|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z\|([+-](?:[01]\d\|2[0-3]):[0-5]\d)))$` | When the balance is now due (ISO 8601, with a time zone) |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `state` | `"pending"`, `"part_paid"`, `"paid"`, `"cancelled"`, `"expired"`, `"refunded"` | yes |   |   |
| `currency` | string | yes |   |   |
| `total` | number | yes |   |   |
| `paid` | number | yes |   |   |
| `balance` | number | yes |   |   |
| `refunded` | number | yes |   | What has gone back to the buyer, confirmed by the provider |
| `pay` | `"full"`, `"deposit"` | yes |   |   |
| `deposit` | number or null | yes |   |   |
| `balanceDueAt` | string or null | yes |   |   |
| `expiresAt` | string or null | yes |   |   |
| `paidAt` | string or null | yes |   |   |
| `createdAt` | string | yes |   |   |
| `taxAmount` | number | yes |   | The tax inside what has been paid, as the payment provider calculated it. Prices include it, so it does not add to the total. Zero when tax is off or none was charged. |
| `taxRefunded` | number | yes |   | The tax the provider said went back with refunds |
| `taxCountry` | string or null | yes |   | The country the latest taxed payment was for |
| `discount` | number | yes |   | Money taken off the order (its discounts), already out of the total |
| `lines` | array of object | yes |   |   |
| `lines[].id` | string | yes |   |   |
| `lines[].position` | number | yes |   |   |
| `lines[].object` | string | yes |   |   |
| `lines[].recordId` | string | yes |   |   |
| `lines[].title` | string | yes |   |   |
| `lines[].quantity` | number | yes |   |   |
| `lines[].unitPrice` | number | yes |   |   |
| `lines[].total` | number | yes |   |   |
| `lines[].taxAmount` | number | yes |   | The tax inside this line's payments, as the payment provider calculated it |
| `lines[].discount` | number | yes |   | The line's share of the order's discounts: it costs total less this |
| `adjustments` | array of object |   |   | Staff only: the discounts on the order, in the order they were given |
| `adjustments[].id` | string | yes |   |   |
| `adjustments[].lineId` | string or null | yes |   | The line it is on; null: spread over the order |
| `adjustments[].kind` | `"code"`, `"automatic"`, `"staff"`, `"referral"` | yes |   |   |
| `adjustments[].amount` | number | yes |   | What it took off, in the currency's minor unit |
| `adjustments[].percent` | number or null | yes |   | The percentage asked for, when it was one |
| `adjustments[].reason` | string or null | yes |   |   |
| `adjustments[].givenBy` | string or null | yes |   | The staff account that gave it |
| `adjustments[].approval` | string or null | yes |   | The approval it waited in, when it did |
| `adjustments[].createdAt` | string | yes |   |   |
| `personId` | string or null |   |   |   |
| `email` | string or null |   |   |   |
| `placedAs` | `"customer"`, `"public"`, `"staff"` |   |   |   |

## order.get

Get one order with its lines: its state, amounts (in the currency's minor unit), what has been paid, the balance and when it is due. A signed-in customer gets their own orders only; anyone else's is not found. Read-only.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `read` |
| Audiences | `staff`, `customer` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes | min length 1, max length 64 | Order id (ord_…) |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `state` | `"pending"`, `"part_paid"`, `"paid"`, `"cancelled"`, `"expired"`, `"refunded"` | yes |   |   |
| `currency` | string | yes |   |   |
| `total` | number | yes |   |   |
| `paid` | number | yes |   |   |
| `balance` | number | yes |   |   |
| `refunded` | number | yes |   | What has gone back to the buyer, confirmed by the provider |
| `pay` | `"full"`, `"deposit"` | yes |   |   |
| `deposit` | number or null | yes |   |   |
| `balanceDueAt` | string or null | yes |   |   |
| `expiresAt` | string or null | yes |   |   |
| `paidAt` | string or null | yes |   |   |
| `createdAt` | string | yes |   |   |
| `taxAmount` | number | yes |   | The tax inside what has been paid, as the payment provider calculated it. Prices include it, so it does not add to the total. Zero when tax is off or none was charged. |
| `taxRefunded` | number | yes |   | The tax the provider said went back with refunds |
| `taxCountry` | string or null | yes |   | The country the latest taxed payment was for |
| `discount` | number | yes |   | Money taken off the order (its discounts), already out of the total |
| `lines` | array of object | yes |   |   |
| `lines[].id` | string | yes |   |   |
| `lines[].position` | number | yes |   |   |
| `lines[].object` | string | yes |   |   |
| `lines[].recordId` | string | yes |   |   |
| `lines[].title` | string | yes |   |   |
| `lines[].quantity` | number | yes |   |   |
| `lines[].unitPrice` | number | yes |   |   |
| `lines[].total` | number | yes |   |   |
| `lines[].taxAmount` | number | yes |   | The tax inside this line's payments, as the payment provider calculated it |
| `lines[].discount` | number | yes |   | The line's share of the order's discounts: it costs total less this |
| `adjustments` | array of object |   |   | Staff only: the discounts on the order, in the order they were given |
| `adjustments[].id` | string | yes |   |   |
| `adjustments[].lineId` | string or null | yes |   | The line it is on; null: spread over the order |
| `adjustments[].kind` | `"code"`, `"automatic"`, `"staff"`, `"referral"` | yes |   |   |
| `adjustments[].amount` | number | yes |   | What it took off, in the currency's minor unit |
| `adjustments[].percent` | number or null | yes |   | The percentage asked for, when it was one |
| `adjustments[].reason` | string or null | yes |   |   |
| `adjustments[].givenBy` | string or null | yes |   | The staff account that gave it |
| `adjustments[].approval` | string or null | yes |   | The approval it waited in, when it did |
| `adjustments[].createdAt` | string | yes |   |   |
| `personId` | string or null |   |   |   |
| `email` | string or null |   |   |   |
| `placedAs` | `"customer"`, `"public"`, `"staff"` |   |   |   |

## order.honourLate

Keep a payment that arrived after the order expired: the order becomes paid (part paid for a late deposit). When what it bought has limited places they are taken again, and this is refused when they have gone: refund the payment instead. A person with the refund permission decides, not an AI assistant. Returns the order.

|  |  |
| --- | --- |
| Permission | `orders:refund` |
| Risk | `write` |
| Audiences | `staff` |
| Actors | `human` |
| Also | not offered to MCP clients (`mcp.expose: false`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes | min length 1, max length 64 | Order id (ord_…) |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `state` | `"pending"`, `"part_paid"`, `"paid"`, `"cancelled"`, `"expired"`, `"refunded"` | yes |   |   |
| `currency` | string | yes |   |   |
| `total` | number | yes |   |   |
| `paid` | number | yes |   |   |
| `balance` | number | yes |   |   |
| `refunded` | number | yes |   | What has gone back to the buyer, confirmed by the provider |
| `pay` | `"full"`, `"deposit"` | yes |   |   |
| `deposit` | number or null | yes |   |   |
| `balanceDueAt` | string or null | yes |   |   |
| `expiresAt` | string or null | yes |   |   |
| `paidAt` | string or null | yes |   |   |
| `createdAt` | string | yes |   |   |
| `taxAmount` | number | yes |   | The tax inside what has been paid, as the payment provider calculated it. Prices include it, so it does not add to the total. Zero when tax is off or none was charged. |
| `taxRefunded` | number | yes |   | The tax the provider said went back with refunds |
| `taxCountry` | string or null | yes |   | The country the latest taxed payment was for |
| `discount` | number | yes |   | Money taken off the order (its discounts), already out of the total |
| `lines` | array of object | yes |   |   |
| `lines[].id` | string | yes |   |   |
| `lines[].position` | number | yes |   |   |
| `lines[].object` | string | yes |   |   |
| `lines[].recordId` | string | yes |   |   |
| `lines[].title` | string | yes |   |   |
| `lines[].quantity` | number | yes |   |   |
| `lines[].unitPrice` | number | yes |   |   |
| `lines[].total` | number | yes |   |   |
| `lines[].taxAmount` | number | yes |   | The tax inside this line's payments, as the payment provider calculated it |
| `lines[].discount` | number | yes |   | The line's share of the order's discounts: it costs total less this |
| `adjustments` | array of object |   |   | Staff only: the discounts on the order, in the order they were given |
| `adjustments[].id` | string | yes |   |   |
| `adjustments[].lineId` | string or null | yes |   | The line it is on; null: spread over the order |
| `adjustments[].kind` | `"code"`, `"automatic"`, `"staff"`, `"referral"` | yes |   |   |
| `adjustments[].amount` | number | yes |   | What it took off, in the currency's minor unit |
| `adjustments[].percent` | number or null | yes |   | The percentage asked for, when it was one |
| `adjustments[].reason` | string or null | yes |   |   |
| `adjustments[].givenBy` | string or null | yes |   | The staff account that gave it |
| `adjustments[].approval` | string or null | yes |   | The approval it waited in, when it did |
| `adjustments[].createdAt` | string | yes |   |   |
| `personId` | string or null |   |   |   |
| `email` | string or null |   |   |   |
| `placedAs` | `"customer"`, `"public"`, `"staff"` |   |   |   |

## order.list

A page of orders, newest first unless sorted otherwise, without their lines (order.get has them). Filter and sort on an order's fields: state, total, paid, balance, pay, personId, email, createdAt, balanceDueAt. Amounts are in the currency's minor unit. Pass nextCursor back as cursor for the next page. Read-only.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `read` |
| Audiences | `staff` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `filter` | any |   |   |   |
| `sort` | object |   |   |   |
| `sort.field` | string | yes | min length 1, max length 64 |   |
| `sort.direction` | `"asc"`, `"desc"` |   | default `"asc"` |   |
| `cursor` | string |   | max length 1000 |   |
| `limit` | integer |   | ≥ 1, ≤ 200, default `50` |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `items` | array of object | yes |   |   |
| `items[].id` | string | yes |   |   |
| `items[].state` | `"pending"`, `"part_paid"`, `"paid"`, `"cancelled"`, `"expired"`, `"refunded"` | yes |   |   |
| `items[].currency` | string | yes |   |   |
| `items[].total` | number | yes |   |   |
| `items[].paid` | number | yes |   |   |
| `items[].balance` | number | yes |   |   |
| `items[].refunded` | number | yes |   | What has gone back to the buyer, confirmed by the provider |
| `items[].pay` | `"full"`, `"deposit"` | yes |   |   |
| `items[].deposit` | number or null | yes |   |   |
| `items[].balanceDueAt` | string or null | yes |   |   |
| `items[].expiresAt` | string or null | yes |   |   |
| `items[].paidAt` | string or null | yes |   |   |
| `items[].createdAt` | string | yes |   |   |
| `items[].taxAmount` | number | yes |   | The tax inside what has been paid, as the payment provider calculated it. Prices include it, so it does not add to the total. Zero when tax is off or none was charged. |
| `items[].taxRefunded` | number | yes |   | The tax the provider said went back with refunds |
| `items[].taxCountry` | string or null | yes |   | The country the latest taxed payment was for |
| `items[].discount` | number | yes |   | Money taken off the order (its discounts), already out of the total |
| `items[].adjustments` | array of object |   |   | Staff only: the discounts on the order, in the order they were given |
| `items[].adjustments[].id` | string | yes |   |   |
| `items[].adjustments[].lineId` | string or null | yes |   | The line it is on; null: spread over the order |
| `items[].adjustments[].kind` | `"code"`, `"automatic"`, `"staff"`, `"referral"` | yes |   |   |
| `items[].adjustments[].amount` | number | yes |   | What it took off, in the currency's minor unit |
| `items[].adjustments[].percent` | number or null | yes |   | The percentage asked for, when it was one |
| `items[].adjustments[].reason` | string or null | yes |   |   |
| `items[].adjustments[].givenBy` | string or null | yes |   | The staff account that gave it |
| `items[].adjustments[].approval` | string or null | yes |   | The approval it waited in, when it did |
| `items[].adjustments[].createdAt` | string | yes |   |   |
| `items[].personId` | string or null |   |   |   |
| `items[].email` | string or null |   |   |   |
| `items[].placedAs` | `"customer"`, `"public"`, `"staff"` |   |   |   |
| `nextCursor` | string or null | yes |   |   |

## order.overdue

List part-paid orders whose balance is past its due date, oldest first. Nothing happens to them by itself: extend the date (order.extendBalanceDue), cancel (order.cancel), or the buyer pays. Read-only.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `read` |
| Audiences | `staff` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `limit` | integer |   | ≥ 1, ≤ 200, default `50` |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `items` | array of object | yes |   |   |
| `items[].id` | string | yes |   |   |
| `items[].state` | `"pending"`, `"part_paid"`, `"paid"`, `"cancelled"`, `"expired"`, `"refunded"` | yes |   |   |
| `items[].currency` | string | yes |   |   |
| `items[].total` | number | yes |   |   |
| `items[].paid` | number | yes |   |   |
| `items[].balance` | number | yes |   |   |
| `items[].refunded` | number | yes |   | What has gone back to the buyer, confirmed by the provider |
| `items[].pay` | `"full"`, `"deposit"` | yes |   |   |
| `items[].deposit` | number or null | yes |   |   |
| `items[].balanceDueAt` | string or null | yes |   |   |
| `items[].expiresAt` | string or null | yes |   |   |
| `items[].paidAt` | string or null | yes |   |   |
| `items[].createdAt` | string | yes |   |   |
| `items[].taxAmount` | number | yes |   | The tax inside what has been paid, as the payment provider calculated it. Prices include it, so it does not add to the total. Zero when tax is off or none was charged. |
| `items[].taxRefunded` | number | yes |   | The tax the provider said went back with refunds |
| `items[].taxCountry` | string or null | yes |   | The country the latest taxed payment was for |
| `items[].discount` | number | yes |   | Money taken off the order (its discounts), already out of the total |
| `items[].adjustments` | array of object |   |   | Staff only: the discounts on the order, in the order they were given |
| `items[].adjustments[].id` | string | yes |   |   |
| `items[].adjustments[].lineId` | string or null | yes |   | The line it is on; null: spread over the order |
| `items[].adjustments[].kind` | `"code"`, `"automatic"`, `"staff"`, `"referral"` | yes |   |   |
| `items[].adjustments[].amount` | number | yes |   | What it took off, in the currency's minor unit |
| `items[].adjustments[].percent` | number or null | yes |   | The percentage asked for, when it was one |
| `items[].adjustments[].reason` | string or null | yes |   |   |
| `items[].adjustments[].givenBy` | string or null | yes |   | The staff account that gave it |
| `items[].adjustments[].approval` | string or null | yes |   | The approval it waited in, when it did |
| `items[].adjustments[].createdAt` | string | yes |   |   |
| `items[].personId` | string or null |   |   |   |
| `items[].email` | string or null |   |   |   |
| `items[].placedAs` | `"customer"`, `"public"`, `"staff"` |   |   |   |

## order.paidLate

List payments that arrived after their order had closed (expired or cancelled), oldest first, that staff have not decided on: honour one (order.honourLate) or refund it (order.refund). Amounts are in the currency's minor unit. Read-only.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `read` |
| Audiences | `staff` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `limit` | integer |   | ≥ 1, ≤ 200, default `50` |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `items` | array of object | yes |   |   |
| `items[].orderId` | string | yes |   |   |
| `items[].provider` | string | yes |   |   |
| `items[].eventId` | string | yes |   |   |
| `items[].amount` | number | yes |   |   |
| `items[].currency` | string | yes |   |   |
| `items[].receivedAt` | string | yes |   |   |
| `items[].orderState` | `"pending"`, `"part_paid"`, `"paid"`, `"cancelled"`, `"expired"`, `"refunded"` | yes |   |   |
| `items[].orderTotal` | number | yes |   |   |

## order.payments

An order's money in detail, for staff: each checkout opened, each payment (the provider's, applied, late or not matching; or one a person recorded, and its reversal) and each refund (asked for or confirmed), with what can still be refunded per payment. Amounts are in the currency's minor unit. Read-only.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `read` |
| Audiences | `staff` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes | min length 1, max length 64 | Order id (ord_…) |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `checkouts` | array of object | yes |   |   |
| `checkouts[].provider` | string | yes |   |   |
| `checkouts[].ref` | string | yes |   |   |
| `checkouts[].amount` | number | yes |   |   |
| `checkouts[].kind` | string | yes |   |   |
| `checkouts[].createdAt` | string | yes |   |   |
| `checkouts[].taxed` | boolean | yes |   | Whether tax was asked of the provider for this payment |
| `payments` | array of object | yes |   |   |
| `payments[].provider` | string | yes |   |   |
| `payments[].eventId` | string | yes |   |   |
| `payments[].amount` | number | yes |   |   |
| `payments[].currency` | string | yes |   |   |
| `payments[].outcome` | string | yes |   |   |
| `payments[].paymentRef` | string or null | yes |   |   |
| `payments[].resolved` | string or null | yes |   |   |
| `payments[].receivedAt` | string | yes |   |   |
| `payments[].taxAmount` | number or null | yes |   | The provider's tax on it; null: not taxed |
| `payments[].taxCountry` | string or null | yes |   |   |
| `payments[].method` | string | yes |   | provider (the payment page), or recorded (taken another way by a person) |
| `payments[].recordedKind` | string or null | yes |   | A recorded one: transfer, cash, … |
| `payments[].recordedBy` | string or null | yes |   | A recorded one: who received it |
| `payments[].receivedOn` | string or null | yes |   |   |
| `payments[].reference` | string or null | yes |   |   |
| `payments[].reverses` | string or null | yes |   | A reversal: the payment it takes back off (its amount is negative) |
| `payments[].reason` | string or null | yes |   | A reversal's reason |
| `refunds` | array of object | yes |   |   |
| `refunds[].id` | string | yes |   |   |
| `refunds[].amount` | number | yes |   |   |
| `refunds[].status` | string | yes |   |   |
| `refunds[].paymentRef` | string or null | yes |   |   |
| `refunds[].reason` | string or null | yes |   |   |
| `refunds[].pendingActionId` | string or null | yes |   |   |
| `refunds[].createdAt` | string | yes |   |   |
| `refunds[].confirmedAt` | string or null | yes |   |   |
| `refunds[].taxAmount` | number or null | yes |   | The tax it gave back, when the provider said; null: not said |
| `refunds[].method` | string | yes |   | provider, or recorded (paid back by a person) |
| `refunds[].recordedKind` | string or null | yes |   |   |
| `refundable` | array of object | yes |   |   |
| `refundable[].paymentRef` | string | yes |   |   |
| `refundable[].method` | string | yes |   |   |
| `refundable[].paid` | number | yes |   |   |
| `refundable[].refundable` | number | yes |   |   |

## order.quote

Price a basket without starting an order: the host's price of each line, the delivery (its postage, nothing when the goods reach the option's free-over amount), the total and what is available, exactly as order.start would charge. Holds nothing and writes nothing: stock is held only once an order is started. Refuses what order.start refuses (not for sale, not sold that way, an address outside the option's countries) and reports, in `problems`, what the buyer still has to do (choose a delivery, give an address) and what is sold out or short; `ready` is true when none is left. Amounts are in the currency's minor unit. Read-only.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `read` |
| Audiences | `staff`, `customer`, `public` |
| Also | host-internal (`hostInternal`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `lines` | array of object | yes | at least 1, at most 50 | What is in the basket. There is no price here: the host reads it from each record. |
| `lines[].object` | string | yes | min length 1, max length 80 | The object of the record to buy |
| `lines[].id` | string | yes | min length 1, max length 64 | The record to buy |
| `lines[].quantity` | integer |   | ≥ 1, ≤ 1000, default `1` |   |
| `delivery` | object |   |   | The delivery option chosen, and to post, the address (its country decides whether the option posts there). Left out, the quote says one is needed when there are goods. |
| `delivery.object` | string | yes | min length 1, max length 80 | The delivery option's object |
| `delivery.id` | string | yes | min length 1, max length 64 | The delivery option chosen |
| `delivery.address` | object |   |   | Where to post the goods: needed for a post option, refused for any other |
| `delivery.address.name` | string | yes | min length 1, max length 200 | Who it is for |
| `delivery.address.line1` | string | yes | min length 1, max length 200 |   |
| `delivery.address.line2` | string |   | max length 200 |   |
| `delivery.address.city` | string |   | max length 100 |   |
| `delivery.address.region` | string |   | max length 100 | State, county or province |
| `delivery.address.postcode` | string |   | max length 20 |   |
| `delivery.address.country` | string | yes | pattern `^[A-Za-z]{2}$` |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `currency` | string | yes |   |   |
| `channel` | `"online"`, `"in_person"` or null | yes |   | online (posted or collected) or in_person (taken now); null without goods or delivery |
| `lines` | array of object | yes |   |   |
| `lines[].position` | number | yes |   |   |
| `lines[].object` | string | yes |   |   |
| `lines[].recordId` | string | yes |   |   |
| `lines[].title` | string | yes |   |   |
| `lines[].quantity` | number | yes |   |   |
| `lines[].unitPrice` | number | yes |   |   |
| `lines[].total` | number | yes |   |   |
| `lines[].goods` | boolean | yes |   | Goods: posted, collected or taken now |
| `lines[].availability` | object or null | yes |   |   |
| `lines[].availability.status` | `"in_stock"`, `"low"`, `"sold_out"` | yes |   |   |
| `lines[].availability.available` | number |   |   | How many can be bought now: for staff, and for others when the item shows it |
| `lines[].availability.onHand` | number |   |   | Staff only |
| `lines[].availability.held` | number |   |   | Staff only |
| `delivery` | object or null | yes |   |   |
| `delivery.object` | string | yes |   |   |
| `delivery.recordId` | string | yes |   |   |
| `delivery.title` | string | yes |   |   |
| `delivery.kind` | `"post"`, `"collect"`, `"here"` | yes |   |   |
| `delivery.price` | number | yes |   | The option's own price |
| `delivery.freeOver` | number or null | yes |   | Goods at or above this post free |
| `delivery.free` | boolean | yes |   |   |
| `delivery.charged` | number | yes |   | What the delivery costs on this order: 0 when free |
| `goodsTotal` | number | yes |   | What the goods cost, before the delivery |
| `total` | number | yes |   | What order.start would charge for this basket |
| `ready` | boolean | yes |   | Nothing in `problems`: the order can be started as it is |
| `problems` | array of object | yes |   |   |
| `problems[].rule` | `"delivery_needed"`, `"address_needed"`, `"sold_out"`, `"not_enough"` | yes |   |   |
| `problems[].message` | string | yes |   |   |
| `problems[].line` | number |   |   | The position of the line it is about |

## order.recordPayment

Record a payment taken another way than the payment page (a bank transfer, cash, a cheque, a card machine) on an order still owed money: any amount up to what is owed, never more (a drop-in that books a place is paid in full). The order becomes paid (or part paid) as if the provider had been paid, and what it bought is given. The payment names you as the person who received it. Admins are told of one over the amount an admin set, or when the buyer had opened a payment page (a payment made there now is refunded). A person only, with the permission to record payments: AI assistants, MCP clients, automations and extensions are refused. Returns the payment's id and the order.

|  |  |
| --- | --- |
| Permission | `orders:payments` |
| Risk | `write` |
| Audiences | `staff` |
| Actors | `human` |
| Also | not offered to MCP clients (`mcp.expose: false`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes | min length 1, max length 64 | Order id (ord_…) |
| `amount` | integer | yes | ≥ 1, ≤ 100000000 | What was received, in the currency's minor unit (cents) |
| `kind` | `"transfer"`, `"cash"`, `"cheque"`, `"card_machine"`, `"other"` | yes |   | How it was paid: transfer, cash, cheque, card_machine or other |
| `receivedOn` | string | yes | pattern `^\d{4}-\d{2}-\d{2}$` | The day it was received (YYYY-MM-DD) |
| `reference` | string |   | min length 1, max length 200 | The payer's reference: a bank reference, a cheque number |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `paymentId` | string | yes |   |   |
| `order` | object | yes |   |   |
| `order.id` | string | yes |   |   |
| `order.state` | `"pending"`, `"part_paid"`, `"paid"`, `"cancelled"`, `"expired"`, `"refunded"` | yes |   |   |
| `order.currency` | string | yes |   |   |
| `order.total` | number | yes |   |   |
| `order.paid` | number | yes |   |   |
| `order.balance` | number | yes |   |   |
| `order.refunded` | number | yes |   | What has gone back to the buyer, confirmed by the provider |
| `order.pay` | `"full"`, `"deposit"` | yes |   |   |
| `order.deposit` | number or null | yes |   |   |
| `order.balanceDueAt` | string or null | yes |   |   |
| `order.expiresAt` | string or null | yes |   |   |
| `order.paidAt` | string or null | yes |   |   |
| `order.createdAt` | string | yes |   |   |
| `order.taxAmount` | number | yes |   | The tax inside what has been paid, as the payment provider calculated it. Prices include it, so it does not add to the total. Zero when tax is off or none was charged. |
| `order.taxRefunded` | number | yes |   | The tax the provider said went back with refunds |
| `order.taxCountry` | string or null | yes |   | The country the latest taxed payment was for |
| `order.discount` | number | yes |   | Money taken off the order (its discounts), already out of the total |
| `order.lines` | array of object | yes |   |   |
| `order.lines[].id` | string | yes |   |   |
| `order.lines[].position` | number | yes |   |   |
| `order.lines[].object` | string | yes |   |   |
| `order.lines[].recordId` | string | yes |   |   |
| `order.lines[].title` | string | yes |   |   |
| `order.lines[].quantity` | number | yes |   |   |
| `order.lines[].unitPrice` | number | yes |   |   |
| `order.lines[].total` | number | yes |   |   |
| `order.lines[].taxAmount` | number | yes |   | The tax inside this line's payments, as the payment provider calculated it |
| `order.lines[].discount` | number | yes |   | The line's share of the order's discounts: it costs total less this |
| `order.adjustments` | array of object |   |   | Staff only: the discounts on the order, in the order they were given |
| `order.adjustments[].id` | string | yes |   |   |
| `order.adjustments[].lineId` | string or null | yes |   | The line it is on; null: spread over the order |
| `order.adjustments[].kind` | `"code"`, `"automatic"`, `"staff"`, `"referral"` | yes |   |   |
| `order.adjustments[].amount` | number | yes |   | What it took off, in the currency's minor unit |
| `order.adjustments[].percent` | number or null | yes |   | The percentage asked for, when it was one |
| `order.adjustments[].reason` | string or null | yes |   |   |
| `order.adjustments[].givenBy` | string or null | yes |   | The staff account that gave it |
| `order.adjustments[].approval` | string or null | yes |   | The approval it waited in, when it did |
| `order.adjustments[].createdAt` | string | yes |   |   |
| `order.personId` | string or null |   |   |   |
| `order.email` | string or null |   |   |   |
| `order.placedAs` | `"customer"`, `"public"`, `"staff"` |   |   |   |

## order.recordRefund

Record money paid back by hand on a payment that was recorded (taken by transfer, cash and so on): how it went back, how much (default: all that is left on that payment) and why. Nothing is sent: you say you paid it. The order is refunded once everything paid has gone back. Payments made on the payment page are refunded with order.refund instead. A person only, with the refund permission. Returns the refund and the order.

|  |  |
| --- | --- |
| Permission | `orders:refund` |
| Risk | `write` |
| Audiences | `staff` |
| Actors | `human` |
| Also | not offered to MCP clients (`mcp.expose: false`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes | min length 1, max length 64 | Order id (ord_…) |
| `paymentId` | string | yes | min length 1, max length 64 | The recorded payment it went back on (opy_…) |
| `amount` | integer |   | &gt; 0, ≤ 9007199254740991 | Minor units; default all |
| `kind` | `"transfer"`, `"cash"`, `"cheque"`, `"card_machine"`, `"other"` | yes |   | How it was paid back: transfer, cash, cheque, card_machine or other |
| `reference` | string |   | min length 1, max length 200 | Its reference, if any |
| `reason` | string | yes | min length 1, max length 500 | Why, in staff's words |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `refundId` | string | yes |   |   |
| `amount` | number | yes |   |   |
| `order` | object | yes |   |   |
| `order.id` | string | yes |   |   |
| `order.state` | `"pending"`, `"part_paid"`, `"paid"`, `"cancelled"`, `"expired"`, `"refunded"` | yes |   |   |
| `order.currency` | string | yes |   |   |
| `order.total` | number | yes |   |   |
| `order.paid` | number | yes |   |   |
| `order.balance` | number | yes |   |   |
| `order.refunded` | number | yes |   | What has gone back to the buyer, confirmed by the provider |
| `order.pay` | `"full"`, `"deposit"` | yes |   |   |
| `order.deposit` | number or null | yes |   |   |
| `order.balanceDueAt` | string or null | yes |   |   |
| `order.expiresAt` | string or null | yes |   |   |
| `order.paidAt` | string or null | yes |   |   |
| `order.createdAt` | string | yes |   |   |
| `order.taxAmount` | number | yes |   | The tax inside what has been paid, as the payment provider calculated it. Prices include it, so it does not add to the total. Zero when tax is off or none was charged. |
| `order.taxRefunded` | number | yes |   | The tax the provider said went back with refunds |
| `order.taxCountry` | string or null | yes |   | The country the latest taxed payment was for |
| `order.discount` | number | yes |   | Money taken off the order (its discounts), already out of the total |
| `order.lines` | array of object | yes |   |   |
| `order.lines[].id` | string | yes |   |   |
| `order.lines[].position` | number | yes |   |   |
| `order.lines[].object` | string | yes |   |   |
| `order.lines[].recordId` | string | yes |   |   |
| `order.lines[].title` | string | yes |   |   |
| `order.lines[].quantity` | number | yes |   |   |
| `order.lines[].unitPrice` | number | yes |   |   |
| `order.lines[].total` | number | yes |   |   |
| `order.lines[].taxAmount` | number | yes |   | The tax inside this line's payments, as the payment provider calculated it |
| `order.lines[].discount` | number | yes |   | The line's share of the order's discounts: it costs total less this |
| `order.adjustments` | array of object |   |   | Staff only: the discounts on the order, in the order they were given |
| `order.adjustments[].id` | string | yes |   |   |
| `order.adjustments[].lineId` | string or null | yes |   | The line it is on; null: spread over the order |
| `order.adjustments[].kind` | `"code"`, `"automatic"`, `"staff"`, `"referral"` | yes |   |   |
| `order.adjustments[].amount` | number | yes |   | What it took off, in the currency's minor unit |
| `order.adjustments[].percent` | number or null | yes |   | The percentage asked for, when it was one |
| `order.adjustments[].reason` | string or null | yes |   |   |
| `order.adjustments[].givenBy` | string or null | yes |   | The staff account that gave it |
| `order.adjustments[].approval` | string or null | yes |   | The approval it waited in, when it did |
| `order.adjustments[].createdAt` | string | yes |   |   |
| `order.personId` | string or null |   |   |   |
| `order.email` | string or null |   |   |   |
| `order.placedAs` | `"customer"`, `"public"`, `"staff"` |   |   |   |

## order.refund

Ask for a refund of an order's payments: all that can be refunded, or `amount` (in the currency's minor unit). Nothing is sent yet: each refund goes to the Approvals inbox, with what will be sent back and to which payment, and a person with the refund permission approves it (an AI assistant can ask, never approve). The order is marked refunded only when the payment provider confirms everything paid has gone back; a part refund is recorded as an amount. A part-paid order is cancelled first. Returns the refunds asked for and the pending approvals.

|  |  |
| --- | --- |
| Permission | `orders:refund` |
| Risk | `outbound` |
| Audiences | `staff` |
| Also | bookkeeping, never queued for review |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes | min length 1, max length 64 | Order id (ord_…) |
| `amount` | integer |   | &gt; 0, ≤ 9007199254740991 | Minor units; default all |
| `reason` | string | yes | min length 1, max length 500 | Why, in staff's words |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `refunds` | array of object | yes |   |   |
| `refunds[].id` | string | yes |   |   |
| `refunds[].paymentRef` | string | yes |   |   |
| `refunds[].amount` | number | yes |   |   |
| `refunds[].pendingActionId` | string or null | yes |   |   |
| `pending` | array of map of any | yes |   |   |

## order.refundDue

Platform use only (the minute cron): ask for a refund the host owes, recorded when a record bought with its order (a drop-in booking) was cancelled in time or by the gym. Asks as order.refund does: nothing is sent; each refund waits in the Approvals inbox for a person with the refund permission (an AI can never approve one).

|  |  |
| --- | --- |
| Permission | `orders:refund` |
| Risk | `outbound` |
| Audiences | `staff` |
| Actors | `automation` |
| Also | bookkeeping, never queued for review; not offered to MCP clients (`mcp.expose: false`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes | min length 1, max length 64 |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `state` | `"asked"`, `"skipped"` | yes |   |   |
| `refunds` | array of object | yes |   |   |
| `refunds[].id` | string | yes |   |   |
| `refunds[].paymentRef` | string | yes |   |   |
| `refunds[].amount` | number | yes |   |   |
| `refunds[].pendingActionId` | string or null | yes |   |   |
| `note` | string or null | yes |   |   |

## order.releaseUnsettled

Platform use only (the minute cron): release one paid guest drop-in still held for no one (an address several People share, not settled by staff) once booking for it has closed: its place goes back and its refund is owed, for a person to approve. One record per call.

|  |  |
| --- | --- |
| Permission | `records:write` |
| Risk | `write` |
| Audiences | `staff` |
| Actors | `automation` |
| Also | not offered to MCP clients (`mcp.expose: false`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `object` | string | yes | min length 1, max length 80 |   |
| `recordId` | string | yes | min length 1, max length 64 |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `released` | boolean | yes |   |   |

## order.reversePayment

Reverse a payment recorded in error (order.recordPayment): a second entry takes it back off, nothing is deleted, and an order it had paid is part paid again with the amount owed. What the order gave stays: take the right payment or cancel the order. A drop-in's booking is cancelled first. Not for the payment provider's payments (refund those). Admins are told. A person only, with the permission to record payments. Get the payment's id from order.payments. Returns the reversal's id and the order.

|  |  |
| --- | --- |
| Permission | `orders:payments` |
| Risk | `write` |
| Audiences | `staff` |
| Actors | `human` |
| Also | not offered to MCP clients (`mcp.expose: false`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `paymentId` | string | yes | min length 1, max length 64 | The recorded payment (opy_…) |
| `reason` | string | yes | min length 1, max length 500 | Why it was entered in error |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `paymentId` | string | yes |   |   |
| `order` | object | yes |   |   |
| `order.id` | string | yes |   |   |
| `order.state` | `"pending"`, `"part_paid"`, `"paid"`, `"cancelled"`, `"expired"`, `"refunded"` | yes |   |   |
| `order.currency` | string | yes |   |   |
| `order.total` | number | yes |   |   |
| `order.paid` | number | yes |   |   |
| `order.balance` | number | yes |   |   |
| `order.refunded` | number | yes |   | What has gone back to the buyer, confirmed by the provider |
| `order.pay` | `"full"`, `"deposit"` | yes |   |   |
| `order.deposit` | number or null | yes |   |   |
| `order.balanceDueAt` | string or null | yes |   |   |
| `order.expiresAt` | string or null | yes |   |   |
| `order.paidAt` | string or null | yes |   |   |
| `order.createdAt` | string | yes |   |   |
| `order.taxAmount` | number | yes |   | The tax inside what has been paid, as the payment provider calculated it. Prices include it, so it does not add to the total. Zero when tax is off or none was charged. |
| `order.taxRefunded` | number | yes |   | The tax the provider said went back with refunds |
| `order.taxCountry` | string or null | yes |   | The country the latest taxed payment was for |
| `order.discount` | number | yes |   | Money taken off the order (its discounts), already out of the total |
| `order.lines` | array of object | yes |   |   |
| `order.lines[].id` | string | yes |   |   |
| `order.lines[].position` | number | yes |   |   |
| `order.lines[].object` | string | yes |   |   |
| `order.lines[].recordId` | string | yes |   |   |
| `order.lines[].title` | string | yes |   |   |
| `order.lines[].quantity` | number | yes |   |   |
| `order.lines[].unitPrice` | number | yes |   |   |
| `order.lines[].total` | number | yes |   |   |
| `order.lines[].taxAmount` | number | yes |   | The tax inside this line's payments, as the payment provider calculated it |
| `order.lines[].discount` | number | yes |   | The line's share of the order's discounts: it costs total less this |
| `order.adjustments` | array of object |   |   | Staff only: the discounts on the order, in the order they were given |
| `order.adjustments[].id` | string | yes |   |   |
| `order.adjustments[].lineId` | string or null | yes |   | The line it is on; null: spread over the order |
| `order.adjustments[].kind` | `"code"`, `"automatic"`, `"staff"`, `"referral"` | yes |   |   |
| `order.adjustments[].amount` | number | yes |   | What it took off, in the currency's minor unit |
| `order.adjustments[].percent` | number or null | yes |   | The percentage asked for, when it was one |
| `order.adjustments[].reason` | string or null | yes |   |   |
| `order.adjustments[].givenBy` | string or null | yes |   | The staff account that gave it |
| `order.adjustments[].approval` | string or null | yes |   | The approval it waited in, when it did |
| `order.adjustments[].createdAt` | string | yes |   |   |
| `order.personId` | string or null |   |   |   |
| `order.email` | string or null |   |   |   |
| `order.placedAs` | `"customer"`, `"public"`, `"staff"` |   |   |   |

## order.setPerson

Say whose order it is, for an order that belongs to no one yet because the address it was placed with matched several people. Merge those people first, then pass the one that remains. An order that already has a person is refused. Returns the order.

|  |  |
| --- | --- |
| Permission | `records:write` |
| Risk | `write` |
| Audiences | `staff` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes | min length 1, max length 64 | Order id (ord_…) |
| `personId` | string | yes | min length 1, max length 64 |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `state` | `"pending"`, `"part_paid"`, `"paid"`, `"cancelled"`, `"expired"`, `"refunded"` | yes |   |   |
| `currency` | string | yes |   |   |
| `total` | number | yes |   |   |
| `paid` | number | yes |   |   |
| `balance` | number | yes |   |   |
| `refunded` | number | yes |   | What has gone back to the buyer, confirmed by the provider |
| `pay` | `"full"`, `"deposit"` | yes |   |   |
| `deposit` | number or null | yes |   |   |
| `balanceDueAt` | string or null | yes |   |   |
| `expiresAt` | string or null | yes |   |   |
| `paidAt` | string or null | yes |   |   |
| `createdAt` | string | yes |   |   |
| `taxAmount` | number | yes |   | The tax inside what has been paid, as the payment provider calculated it. Prices include it, so it does not add to the total. Zero when tax is off or none was charged. |
| `taxRefunded` | number | yes |   | The tax the provider said went back with refunds |
| `taxCountry` | string or null | yes |   | The country the latest taxed payment was for |
| `discount` | number | yes |   | Money taken off the order (its discounts), already out of the total |
| `lines` | array of object | yes |   |   |
| `lines[].id` | string | yes |   |   |
| `lines[].position` | number | yes |   |   |
| `lines[].object` | string | yes |   |   |
| `lines[].recordId` | string | yes |   |   |
| `lines[].title` | string | yes |   |   |
| `lines[].quantity` | number | yes |   |   |
| `lines[].unitPrice` | number | yes |   |   |
| `lines[].total` | number | yes |   |   |
| `lines[].taxAmount` | number | yes |   | The tax inside this line's payments, as the payment provider calculated it |
| `lines[].discount` | number | yes |   | The line's share of the order's discounts: it costs total less this |
| `adjustments` | array of object |   |   | Staff only: the discounts on the order, in the order they were given |
| `adjustments[].id` | string | yes |   |   |
| `adjustments[].lineId` | string or null | yes |   | The line it is on; null: spread over the order |
| `adjustments[].kind` | `"code"`, `"automatic"`, `"staff"`, `"referral"` | yes |   |   |
| `adjustments[].amount` | number | yes |   | What it took off, in the currency's minor unit |
| `adjustments[].percent` | number or null | yes |   | The percentage asked for, when it was one |
| `adjustments[].reason` | string or null | yes |   |   |
| `adjustments[].givenBy` | string or null | yes |   | The staff account that gave it |
| `adjustments[].approval` | string or null | yes |   | The approval it waited in, when it did |
| `adjustments[].createdAt` | string | yes |   |   |
| `personId` | string or null |   |   |   |
| `email` | string or null |   |   |   |
| `placedAs` | `"customer"`, `"public"`, `"staff"` |   |   |   |

## order.settings.get

Get the order settings: the deployment's currency, how long an unpaid order lasts, the least a buyer may pay towards a balance, and tax at checkout: whether it is on, and each object for sale that declares a product tax code with the code it is taxed at. Read-only.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `read` |
| Audiences | `staff` |

### Input

No fields.

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `currency` | string or null | yes |   | The one currency every order is in (ISO 4217). Null: not set, nothing can be sold. |
| `expiryMinutes` | number | yes |   | Minutes an order nothing has been paid on lasts. |
| `minPartPayment` | number | yes |   | The least a buyer may pay towards a balance, in the currency's minor unit. |
| `returnOrigins` | array of string | yes |   | The sites a buyer may be sent back to after paying (https origins). |
| `tax` | boolean | yes |   | Whether the payment provider calculates tax at checkout (Stripe Tax). Off until a human admin turns it on. Prices include tax, so what a buyer pays does not change. |
| `taxCodes` | map of string | yes |   | A human admin's product tax code per object, over the one its pack declares. |
| `discountLimit` | object | yes |   | How much staff may take off one order on their own (order.adjust). Above it, a discount waits for an admin. Nothing (0) until a human admin sets it. |
| `discountLimit.percent` | number | yes | ≥ 0, ≤ 100 | At most this percentage of the order |
| `discountLimit.amount` | integer | yes | ≥ 0, ≤ 100000000 | And at most this much, in the currency's minor unit |
| `recordedPaymentNotice` | number | yes |   | Admins are told of a payment recorded by hand (order.recordPayment) for more than this, in minor units. 0 until a human admin sets it: every one is told. |
| `taxObjects` | array of object | yes |   |   |
| `taxObjects[].object` | string | yes |   |   |
| `taxObjects[].label` | string | yes |   |   |
| `taxObjects[].declared` | string | yes |   | The code its pack declares |
| `taxObjects[].code` | string | yes |   | The code it is taxed at: an admin's, else the pack's |
| `taxObjects[].place` | boolean | yes |   | Taxed where it takes place (an in-person event) |

## order.settings.update

Change the order settings: the currency every order is in, the minutes an unpaid order lasts, the least part payment, the sites a buyer may come back to after paying, whether the payment provider calculates tax at checkout, the product tax code of an object for sale, how much staff may take off an order on their own, or above what a payment recorded by hand tells admins. Only what you pass changes. Orders already started keep the currency they were started in; turning tax on or off changes only payments made from then on. Admins only, and only a human can call it: AI assistants, MCP clients, automations and extensions are refused.

|  |  |
| --- | --- |
| Permission | `settings:manage` |
| Risk | `write` |
| Audiences | `staff` |
| Actors | `human` |
| Also | not offered to MCP clients (`mcp.expose: false`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `currency` | string |   |   |   |
| `expiryMinutes` | integer |   | ≥ 5, ≤ 1440 |   |
| `minPartPayment` | integer |   | ≥ 1, ≤ 100000000 |   |
| `returnOrigins` | array of string |   | at most 20 | Replaces the list of sites a buyer may come back to, e.g. https://shop.example.com |
| `tax` | boolean |   |   | Turn tax at checkout on or off. On, the provider taxes each line whose object declares a tax code, inside the price, where the org has a tax registration in its account. |
| `taxCodes` | map of string |   |   | Replaces the admin's product tax codes, by object (e.g. ticketing.tickettype → txcd_50010001). Only objects that declare a tax code may be given one; an object left out is taxed at its pack's code. |
| `discountLimit` | object |   |   | How much staff may take off one order without an admin's approval: at most this percentage of the order and at most this amount (minor units), both at once. |
| `discountLimit.percent` | number | yes | ≥ 0, ≤ 100 | At most this percentage of the order |
| `discountLimit.amount` | integer | yes | ≥ 0, ≤ 100000000 | And at most this much, in the currency's minor unit |
| `recordedPaymentNotice` | integer |   | ≥ 0, ≤ 100000000 | Tell admins of a payment recorded by hand for more than this (minor units) |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `currency` | string or null | yes |   | The one currency every order is in (ISO 4217). Null: not set, nothing can be sold. |
| `expiryMinutes` | number | yes |   | Minutes an order nothing has been paid on lasts. |
| `minPartPayment` | number | yes |   | The least a buyer may pay towards a balance, in the currency's minor unit. |
| `returnOrigins` | array of string | yes |   | The sites a buyer may be sent back to after paying (https origins). |
| `tax` | boolean | yes |   | Whether the payment provider calculates tax at checkout (Stripe Tax). Off until a human admin turns it on. Prices include tax, so what a buyer pays does not change. |
| `taxCodes` | map of string | yes |   | A human admin's product tax code per object, over the one its pack declares. |
| `discountLimit` | object | yes |   | How much staff may take off one order on their own (order.adjust). Above it, a discount waits for an admin. Nothing (0) until a human admin sets it. |
| `discountLimit.percent` | number | yes | ≥ 0, ≤ 100 | At most this percentage of the order |
| `discountLimit.amount` | integer | yes | ≥ 0, ≤ 100000000 | And at most this much, in the currency's minor unit |
| `recordedPaymentNotice` | number | yes |   | Admins are told of a payment recorded by hand (order.recordPayment) for more than this, in minor units. 0 until a human admin sets it: every one is told. |
| `previous` | object | yes |   |   |
| `previous.currency` | string or null | yes |   | The one currency every order is in (ISO 4217). Null: not set, nothing can be sold. |
| `previous.expiryMinutes` | number | yes |   | Minutes an order nothing has been paid on lasts. |
| `previous.minPartPayment` | number | yes |   | The least a buyer may pay towards a balance, in the currency's minor unit. |
| `previous.returnOrigins` | array of string | yes |   | The sites a buyer may be sent back to after paying (https origins). |
| `previous.tax` | boolean | yes |   | Whether the payment provider calculates tax at checkout (Stripe Tax). Off until a human admin turns it on. Prices include tax, so what a buyer pays does not change. |
| `previous.taxCodes` | map of string | yes |   | A human admin's product tax code per object, over the one its pack declares. |
| `previous.discountLimit` | object | yes |   | How much staff may take off one order on their own (order.adjust). Above it, a discount waits for an admin. Nothing (0) until a human admin sets it. |
| `previous.discountLimit.percent` | number | yes | ≥ 0, ≤ 100 | At most this percentage of the order |
| `previous.discountLimit.amount` | integer | yes | ≥ 0, ≤ 100000000 | And at most this much, in the currency's minor unit |
| `previous.recordedPaymentNotice` | number | yes |   | Admins are told of a payment recorded by hand (order.recordPayment) for more than this, in minor units. 0 until a human admin sets it: every one is told. |

## order.start

Start an order for one or more records that are for sale, as a signed-in customer, a guest (with an email address) or staff. The host prices it from the records: a caller never sends a price or a total. The order starts pending and is not paid: paying happens on the payment provider's page (order.checkout), and only the provider's confirmation marks it paid. An unpaid order expires after a few minutes. Nobody buys without the agreements the business needs for what is bought: refused with rule agreements_due and the documents while any is due (a guest passes their acceptances in `agreements`; a signed-in customer agrees first; staff send a link, sign at the desk or record paper). Goods (things posted, collected or taken now) need a `delivery`: the host adds it as the last line, priced by the host, and refuses goods not sold that way (rule not_sold_here), a post delivery with no address or one outside the option's countries, and what is sold out. order.quote gives the same prices without starting anything. Returns the order with its lines and amounts in the currency's minor unit; a guest also gets `token`, shown once, which is the only way back to the order (order.view).

|  |  |
| --- | --- |
| Permission | `records:write` |
| Risk | `write` |
| Audiences | `staff`, `customer`, `public` |
| Also | host-internal (`hostInternal`); not offered to MCP clients (`mcp.expose: false`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `lines` | array of object | yes | at least 1, at most 50 | What to buy. There is no price here: the host reads it from each record, and a price or total sent anyway is ignored. |
| `lines[].object` | string | yes | min length 1, max length 80 | The object of the record to buy |
| `lines[].id` | string | yes | min length 1, max length 64 | The record to buy |
| `lines[].quantity` | integer |   | ≥ 1, ≤ 1000, default `1` |   |
| `pay` | `"full"`, `"deposit"` |   | default `"full"` | full: pay the whole price now. deposit: pay the deposit now and the balance by its due date, when every line offers a deposit. |
| `email` | string |   | max length 320 | The buyer's email address. Required when the caller is not a signed-in customer; a signed-in customer's order uses their account's address and must not pass one. |
| `agreements` | array of object |   | at most 20 | A visitor without an account only: what they agreed to on the way to paying, one entry per document the host says is due (each document's current version, the name they typed, a signature for a document agreed to by drawing, every answer for a health form). A signed-in customer agrees first (me.agreements.accept); staff never agree for anyone. |
| `agreements[].versionId` | string | yes | min length 1, max length 64 | The version's id (agv_…) the visitor read |
| `agreements[].typedName` | string | yes | min length 1, max length 200 | The name the person typed beside the box: personal data, never shown to an AI |
| `agreements[].signature` | object |   |   | A drawn signature as strokes in a 1000 by 400 box: personal data |
| `agreements[].signature.width` | `1000` | yes |   |   |
| `agreements[].signature.height` | `400` | yes |   |   |
| `agreements[].signature.strokes` | array of array of array of any | yes | at least 1, at most 30 |   |
| `agreements[].answers` | array of object |   | at least 1, at most 40 | A health form's answers: health information, never shown to an AI or logged |
| `agreements[].answers[].key` | string | yes | min length 1, max length 40 |   |
| `agreements[].answers[].yes` | boolean | yes |   |   |
| `agreements[].answers[].note` | string |   | max length 1000 |   |
| `delivery` | object |   |   | How the goods get to the buyer, when the order has goods (records sold as goods): one delivery option (posted, collected, or taken now in person) and, to post, the address. Required with goods, refused without. The host prices it (free over an amount when the option says so) and works out from it whether the order is online or in person; each goods line must be sold there. |
| `delivery.object` | string | yes | min length 1, max length 80 | The delivery option's object |
| `delivery.id` | string | yes | min length 1, max length 64 | The delivery option chosen |
| `delivery.address` | object |   |   | Where to post the goods: needed for a post option, refused for any other |
| `delivery.address.name` | string | yes | min length 1, max length 200 | Who it is for |
| `delivery.address.line1` | string | yes | min length 1, max length 200 |   |
| `delivery.address.line2` | string |   | max length 200 |   |
| `delivery.address.city` | string |   | max length 100 |   |
| `delivery.address.region` | string |   | max length 100 | State, county or province |
| `delivery.address.postcode` | string |   | max length 20 |   |
| `delivery.address.country` | string | yes | pattern `^[A-Za-z]{2}$` |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `state` | `"pending"`, `"part_paid"`, `"paid"`, `"cancelled"`, `"expired"`, `"refunded"` | yes |   |   |
| `currency` | string | yes |   |   |
| `total` | number | yes |   |   |
| `paid` | number | yes |   |   |
| `balance` | number | yes |   |   |
| `refunded` | number | yes |   | What has gone back to the buyer, confirmed by the provider |
| `pay` | `"full"`, `"deposit"` | yes |   |   |
| `deposit` | number or null | yes |   |   |
| `balanceDueAt` | string or null | yes |   |   |
| `expiresAt` | string or null | yes |   |   |
| `paidAt` | string or null | yes |   |   |
| `createdAt` | string | yes |   |   |
| `taxAmount` | number | yes |   | The tax inside what has been paid, as the payment provider calculated it. Prices include it, so it does not add to the total. Zero when tax is off or none was charged. |
| `taxRefunded` | number | yes |   | The tax the provider said went back with refunds |
| `taxCountry` | string or null | yes |   | The country the latest taxed payment was for |
| `discount` | number | yes |   | Money taken off the order (its discounts), already out of the total |
| `lines` | array of object | yes |   |   |
| `lines[].id` | string | yes |   |   |
| `lines[].position` | number | yes |   |   |
| `lines[].object` | string | yes |   |   |
| `lines[].recordId` | string | yes |   |   |
| `lines[].title` | string | yes |   |   |
| `lines[].quantity` | number | yes |   |   |
| `lines[].unitPrice` | number | yes |   |   |
| `lines[].total` | number | yes |   |   |
| `lines[].taxAmount` | number | yes |   | The tax inside this line's payments, as the payment provider calculated it |
| `lines[].discount` | number | yes |   | The line's share of the order's discounts: it costs total less this |
| `adjustments` | array of object |   |   | Staff only: the discounts on the order, in the order they were given |
| `adjustments[].id` | string | yes |   |   |
| `adjustments[].lineId` | string or null | yes |   | The line it is on; null: spread over the order |
| `adjustments[].kind` | `"code"`, `"automatic"`, `"staff"`, `"referral"` | yes |   |   |
| `adjustments[].amount` | number | yes |   | What it took off, in the currency's minor unit |
| `adjustments[].percent` | number or null | yes |   | The percentage asked for, when it was one |
| `adjustments[].reason` | string or null | yes |   |   |
| `adjustments[].givenBy` | string or null | yes |   | The staff account that gave it |
| `adjustments[].approval` | string or null | yes |   | The approval it waited in, when it did |
| `adjustments[].createdAt` | string | yes |   |   |
| `personId` | string or null |   |   |   |
| `email` | string or null |   |   |   |
| `placedAs` | `"customer"`, `"public"`, `"staff"` |   |   |   |
| `token` | string or null | yes |   | A guest's key to this order. Null for everyone else. |

## order.startHeld

From a pack's tool: make a record that is bought when it is made (a drop-in booking for a class) and start its order, in one step. The record is held for the order (a place in the class) while it is unpaid, and the host prices it: a caller never sends a price. Paying on the provider's page (order.checkout) moves it on; the order expiring unpaid releases it. `values` are the record's fields a customer may set (its class); whose it is is the caller, or with forPersonId a child staff linked to them. A guest gives their email address and is matched to no one until the payment is verified (the answer is the same whatever it matches). The record's own rules apply as for the caller's own booking (when booking opens and closes, booked by staff only, places left, one per person). Returns the order; a guest also gets `token`, shown once.

|  |  |
| --- | --- |
| Permission | `records:write` |
| Risk | `write` |
| Audiences | `staff`, `customer`, `public` |
| Also | called only from a tool's run (`toolOnly`); host-internal (`hostInternal`); not offered to MCP clients (`mcp.expose: false`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `object` | string | yes | min length 1, max length 80 | The object to make a record of, e.g. bookings.booking |
| `values` | map of any |   | default `{}` | The record's fields a customer may set, e.g. { class: &lt;id&gt; } |
| `forPersonId` | string |   | min length 1, max length 64 | A child linked to the signed-in customer to make it for (ADR 0540) |
| `email` | string |   | max length 320 | The buyer's address: required for a guest; a signed-in customer passes none |
| `agreements` | array of object |   | at most 20 | A visitor without an account only: what they agreed to on the way to paying, one entry per document the host says is due (each document's current version, the name they typed, a signature for a document agreed to by drawing, every answer for a health form). A signed-in customer agrees first (me.agreements.accept); staff never agree for anyone. |
| `agreements[].versionId` | string | yes | min length 1, max length 64 | The version's id (agv_…) the visitor read |
| `agreements[].typedName` | string | yes | min length 1, max length 200 | The name the person typed beside the box: personal data, never shown to an AI |
| `agreements[].signature` | object |   |   | A drawn signature as strokes in a 1000 by 400 box: personal data |
| `agreements[].signature.width` | `1000` | yes |   |   |
| `agreements[].signature.height` | `400` | yes |   |   |
| `agreements[].signature.strokes` | array of array of array of any | yes | at least 1, at most 30 |   |
| `agreements[].answers` | array of object |   | at least 1, at most 40 | A health form's answers: health information, never shown to an AI or logged |
| `agreements[].answers[].key` | string | yes | min length 1, max length 40 |   |
| `agreements[].answers[].yes` | boolean | yes |   |   |
| `agreements[].answers[].note` | string |   | max length 1000 |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `state` | `"pending"`, `"part_paid"`, `"paid"`, `"cancelled"`, `"expired"`, `"refunded"` | yes |   |   |
| `currency` | string | yes |   |   |
| `total` | number | yes |   |   |
| `paid` | number | yes |   |   |
| `balance` | number | yes |   |   |
| `refunded` | number | yes |   | What has gone back to the buyer, confirmed by the provider |
| `pay` | `"full"`, `"deposit"` | yes |   |   |
| `deposit` | number or null | yes |   |   |
| `balanceDueAt` | string or null | yes |   |   |
| `expiresAt` | string or null | yes |   |   |
| `paidAt` | string or null | yes |   |   |
| `createdAt` | string | yes |   |   |
| `taxAmount` | number | yes |   | The tax inside what has been paid, as the payment provider calculated it. Prices include it, so it does not add to the total. Zero when tax is off or none was charged. |
| `taxRefunded` | number | yes |   | The tax the provider said went back with refunds |
| `taxCountry` | string or null | yes |   | The country the latest taxed payment was for |
| `discount` | number | yes |   | Money taken off the order (its discounts), already out of the total |
| `lines` | array of object | yes |   |   |
| `lines[].id` | string | yes |   |   |
| `lines[].position` | number | yes |   |   |
| `lines[].object` | string | yes |   |   |
| `lines[].recordId` | string | yes |   |   |
| `lines[].title` | string | yes |   |   |
| `lines[].quantity` | number | yes |   |   |
| `lines[].unitPrice` | number | yes |   |   |
| `lines[].total` | number | yes |   |   |
| `lines[].taxAmount` | number | yes |   | The tax inside this line's payments, as the payment provider calculated it |
| `lines[].discount` | number | yes |   | The line's share of the order's discounts: it costs total less this |
| `adjustments` | array of object |   |   | Staff only: the discounts on the order, in the order they were given |
| `adjustments[].id` | string | yes |   |   |
| `adjustments[].lineId` | string or null | yes |   | The line it is on; null: spread over the order |
| `adjustments[].kind` | `"code"`, `"automatic"`, `"staff"`, `"referral"` | yes |   |   |
| `adjustments[].amount` | number | yes |   | What it took off, in the currency's minor unit |
| `adjustments[].percent` | number or null | yes |   | The percentage asked for, when it was one |
| `adjustments[].reason` | string or null | yes |   |   |
| `adjustments[].givenBy` | string or null | yes |   | The staff account that gave it |
| `adjustments[].approval` | string or null | yes |   | The approval it waited in, when it did |
| `adjustments[].createdAt` | string | yes |   |   |
| `personId` | string or null |   |   |   |
| `email` | string or null |   |   |   |
| `placedAs` | `"customer"`, `"public"`, `"staff"` |   |   |   |
| `recordId` | string | yes |   | The record made and held for the order |
| `token` | string or null | yes |   | A guest's key to this order. Null for everyone else. |

## order.unadjust

Take a discount off a pending order whose payment page has not opened: the order's total goes back up by what it took off. Get the discount's id from order.get. An AI's request always waits for an admin. Returns the order.

|  |  |
| --- | --- |
| Permission | `orders:discount` |
| Risk | `write` |
| Audiences | `staff` |
| Actors | `human`, `assistant`, `mcp` |
| Also | always reviewed when called by `assistant`, `mcp` (`alwaysReview`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes | min length 1, max length 64 | Order id (ord_…) |
| `adjustmentId` | string | yes | min length 1, max length 64 | The discount to take off (oad_…) |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `state` | `"pending"`, `"part_paid"`, `"paid"`, `"cancelled"`, `"expired"`, `"refunded"` | yes |   |   |
| `currency` | string | yes |   |   |
| `total` | number | yes |   |   |
| `paid` | number | yes |   |   |
| `balance` | number | yes |   |   |
| `refunded` | number | yes |   | What has gone back to the buyer, confirmed by the provider |
| `pay` | `"full"`, `"deposit"` | yes |   |   |
| `deposit` | number or null | yes |   |   |
| `balanceDueAt` | string or null | yes |   |   |
| `expiresAt` | string or null | yes |   |   |
| `paidAt` | string or null | yes |   |   |
| `createdAt` | string | yes |   |   |
| `taxAmount` | number | yes |   | The tax inside what has been paid, as the payment provider calculated it. Prices include it, so it does not add to the total. Zero when tax is off or none was charged. |
| `taxRefunded` | number | yes |   | The tax the provider said went back with refunds |
| `taxCountry` | string or null | yes |   | The country the latest taxed payment was for |
| `discount` | number | yes |   | Money taken off the order (its discounts), already out of the total |
| `lines` | array of object | yes |   |   |
| `lines[].id` | string | yes |   |   |
| `lines[].position` | number | yes |   |   |
| `lines[].object` | string | yes |   |   |
| `lines[].recordId` | string | yes |   |   |
| `lines[].title` | string | yes |   |   |
| `lines[].quantity` | number | yes |   |   |
| `lines[].unitPrice` | number | yes |   |   |
| `lines[].total` | number | yes |   |   |
| `lines[].taxAmount` | number | yes |   | The tax inside this line's payments, as the payment provider calculated it |
| `lines[].discount` | number | yes |   | The line's share of the order's discounts: it costs total less this |
| `adjustments` | array of object |   |   | Staff only: the discounts on the order, in the order they were given |
| `adjustments[].id` | string | yes |   |   |
| `adjustments[].lineId` | string or null | yes |   | The line it is on; null: spread over the order |
| `adjustments[].kind` | `"code"`, `"automatic"`, `"staff"`, `"referral"` | yes |   |   |
| `adjustments[].amount` | number | yes |   | What it took off, in the currency's minor unit |
| `adjustments[].percent` | number or null | yes |   | The percentage asked for, when it was one |
| `adjustments[].reason` | string or null | yes |   |   |
| `adjustments[].givenBy` | string or null | yes |   | The staff account that gave it |
| `adjustments[].approval` | string or null | yes |   | The approval it waited in, when it did |
| `adjustments[].createdAt` | string | yes |   |   |
| `personId` | string or null |   |   |   |
| `email` | string or null |   |   |   |
| `placedAs` | `"customer"`, `"public"`, `"staff"` |   |   |   |

## order.view

See one order with the token it was started with (a guest's link from order.start or the confirmation email). The token opens that order only, while it is open and for 30 days after it closes. A wrong id, a wrong token and an old link are all not found. Read-only.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `read` |
| Audiences | `staff`, `customer`, `public` |
| Also | host-internal (`hostInternal`); not offered to MCP clients (`mcp.expose: false`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes | min length 1, max length 64 | Order id (ord_…) |
| `token` | string | yes | min length 1, max length 128 | The order's token |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `state` | `"pending"`, `"part_paid"`, `"paid"`, `"cancelled"`, `"expired"`, `"refunded"` | yes |   |   |
| `currency` | string | yes |   |   |
| `total` | number | yes |   |   |
| `paid` | number | yes |   |   |
| `balance` | number | yes |   |   |
| `refunded` | number | yes |   | What has gone back to the buyer, confirmed by the provider |
| `pay` | `"full"`, `"deposit"` | yes |   |   |
| `deposit` | number or null | yes |   |   |
| `balanceDueAt` | string or null | yes |   |   |
| `expiresAt` | string or null | yes |   |   |
| `paidAt` | string or null | yes |   |   |
| `createdAt` | string | yes |   |   |
| `taxAmount` | number | yes |   | The tax inside what has been paid, as the payment provider calculated it. Prices include it, so it does not add to the total. Zero when tax is off or none was charged. |
| `taxRefunded` | number | yes |   | The tax the provider said went back with refunds |
| `taxCountry` | string or null | yes |   | The country the latest taxed payment was for |
| `discount` | number | yes |   | Money taken off the order (its discounts), already out of the total |
| `lines` | array of object | yes |   |   |
| `lines[].id` | string | yes |   |   |
| `lines[].position` | number | yes |   |   |
| `lines[].object` | string | yes |   |   |
| `lines[].recordId` | string | yes |   |   |
| `lines[].title` | string | yes |   |   |
| `lines[].quantity` | number | yes |   |   |
| `lines[].unitPrice` | number | yes |   |   |
| `lines[].total` | number | yes |   |   |
| `lines[].taxAmount` | number | yes |   | The tax inside this line's payments, as the payment provider calculated it |
| `lines[].discount` | number | yes |   | The line's share of the order's discounts: it costs total less this |
| `adjustments` | array of object |   |   | Staff only: the discounts on the order, in the order they were given |
| `adjustments[].id` | string | yes |   |   |
| `adjustments[].lineId` | string or null | yes |   | The line it is on; null: spread over the order |
| `adjustments[].kind` | `"code"`, `"automatic"`, `"staff"`, `"referral"` | yes |   |   |
| `adjustments[].amount` | number | yes |   | What it took off, in the currency's minor unit |
| `adjustments[].percent` | number or null | yes |   | The percentage asked for, when it was one |
| `adjustments[].reason` | string or null | yes |   |   |
| `adjustments[].givenBy` | string or null | yes |   | The staff account that gave it |
| `adjustments[].approval` | string or null | yes |   | The approval it waited in, when it did |
| `adjustments[].createdAt` | string | yes |   |   |
| `personId` | string or null |   |   |   |
| `email` | string or null |   |   |   |
| `placedAs` | `"customer"`, `"public"`, `"staff"` |   |   |   |
