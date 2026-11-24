---
title: "quote.* operations"
description: "The core operations named quote.*"
sidebar:
  label: "quote"
editUrl: false
---

## quote.addLine

Add a line to a draft quote: a record for sale (item: its object and id), priced by the host from the record, or a typed line (description, quantity, unit, unitPrice in minor units, as the quote's amounts are typed). Each line has a tax rate (a key from the invoice settings; left out, the default; null, no tax) and an optional discount (an amount or a percentage, with why), taken off before the tax. The host works out the line's tax, rounded half up, and the quote's totals by rate. At most 50 lines.

|  |  |
| --- | --- |
| Permission | `invoices:write` |
| Risk | `write` |
| Audiences | `staff` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes | min length 1, max length 64 | The quote's id (qt_…) |
| `version` | integer |   | ≥ 0, ≤ 9007199254740991 | The version you read: a draft changed since by someone else is refused |
| `line` | object | yes |   |   |
| `line.item` | object |   |   | A record for sale: the host reads its price. Left out: a typed line |
| `line.item.object` | string | yes | min length 1, max length 80 | A sellable object: a pass type, a ticket type |
| `line.item.id` | string | yes | min length 1, max length 64 |   |
| `line.description` | string |   | min length 1, max length 500 | What it is, as printed. A record's line defaults to its title |
| `line.quantity` | number |   | &gt; 0, ≤ 10000, default `1` | How many: up to three decimals, for hours and metres |
| `line.unit` | string or null |   |   | hours, m, each |
| `line.unitPrice` | integer |   | ≥ 0, ≤ 100000000 | A typed line's price for one, in minor units, as amounts are typed on this document (with or without tax) |
| `line.taxRate` | string or null |   |   | A tax rate's key from the invoice settings; null for no tax; left out: the default |
| `line.discount` | object or null |   |   | Money off this line, before its tax |
| `line.discount.kind` | `"amount"`, `"percent"` | yes |   |   |
| `line.discount.value` | integer | yes | ≥ 1, ≤ 10000000000 | An amount in minor units, or hundredths of a percent (1000 = 10%) |
| `line.discount.reason` | string | yes | min length 1, max length 200 | Why: printed for staff, kept in the audit |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `state` | `"draft"`, `"sent"`, `"accepted"`, `"declined"`, `"expired"`, `"withdrawn"` | yes |   |   |
| `number` | string or null | yes |   | Given when sent or issued; null on a draft |
| `currency` | string | yes |   |   |
| `taxMode` | `"exclusive"`, `"inclusive"` | yes |   |   |
| `billTo` | object | yes |   |   |
| `billTo.personId` | string or null | yes |   |   |
| `billTo.organisationId` | string or null | yes |   |   |
| `billTo.printed` | object or null | yes |   | As printed, fixed when sent or issued |
| `billTo.printed.name` | string or null | yes |   |   |
| `billTo.printed.address` | string or null | yes |   |   |
| `billTo.printed.taxNumber` | string or null | yes |   |   |
| `billTo.printed.email` | string or null | yes |   |   |
| `siteAddress` | string or null | yes |   |   |
| `about` | object or null | yes |   |   |
| `about.object` | string | yes |   |   |
| `about.id` | string | yes |   |   |
| `title` | string or null | yes |   |   |
| `notes` | string or null | yes |   |   |
| `lines` | array of object | yes |   |   |
| `lines[].id` | string | yes |   |   |
| `lines[].position` | number | yes |   |   |
| `lines[].description` | string | yes |   |   |
| `lines[].quantity` | number | yes |   |   |
| `lines[].unit` | string or null | yes |   |   |
| `lines[].unitPrice` | number | yes |   | For one, in minor units, as the document's amounts are typed |
| `lines[].taxRate` | object or null | yes |   |   |
| `lines[].taxRate.key` | string | yes |   |   |
| `lines[].taxRate.label` | string | yes |   |   |
| `lines[].taxRate.rate` | number | yes |   |   |
| `lines[].discount` | object or null | yes |   |   |
| `lines[].discount.kind` | `"amount"`, `"percent"` | yes |   |   |
| `lines[].discount.value` | number | yes |   |   |
| `lines[].discount.reason` | string | yes |   |   |
| `lines[].discount.amount` | number | yes |   | What it took off, in minor units |
| `lines[].net` | number | yes |   |   |
| `lines[].tax` | number | yes |   |   |
| `lines[].total` | number | yes |   |   |
| `lines[].source` | `"record"`, `"custom"`, `"deduction"` | yes |   |   |
| `lines[].item` | object or null | yes |   |   |
| `lines[].item.object` | string | yes |   |   |
| `lines[].item.id` | string | yes |   |   |
| `netTotal` | number | yes |   |   |
| `taxTotal` | number | yes |   |   |
| `total` | number | yes |   |   |
| `taxByRate` | array of object | yes |   |   |
| `taxByRate[].key` | string | yes |   |   |
| `taxByRate[].label` | string | yes |   |   |
| `taxByRate[].rate` | number | yes |   |   |
| `taxByRate[].net` | number | yes |   |   |
| `taxByRate[].tax` | number | yes |   |   |
| `taxByRate[].total` | number | yes |   |   |
| `version` | number | yes |   | Moves with every write |
| `createdAt` | string | yes |   |   |
| `updatedAt` | string | yes |   |   |
| `validUntil` | string or null | yes |   |   |
| `deposit` | object | yes |   |   |
| `deposit.kind` | `"none"`, `"amount"`, `"percent"` | yes |   |   |
| `deposit.value` | number or null | yes |   |   |
| `replacesQuoteId` | string or null | yes |   |   |
| `sentAt` | string or null | yes |   |   |

## quote.create

Start a quote as a draft: whom it is for (a Person, or an Organisation with its contact Person), an optional site address, the record it is about, a title, notes for the customer, valid-until, a deposit, and lines. A line is a record for sale (a pass type, a ticket type, a price-list item), priced by the host, or a typed line with a description, quantity, unit and unit price; each has a tax rate from the invoice settings and an optional discount. The host works out each line's tax and the totals. A draft has no number and changes freely: nothing is sent until a person sends it. Amounts are integers in the currency's minor unit.

|  |  |
| --- | --- |
| Permission | `invoices:write` |
| Risk | `write` |
| Audiences | `staff` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `billTo` | object or null |   |   |   |
| `billTo.personId` | string | yes | min length 1, max length 64 | The Person billed, or the organisation's contact Person |
| `billTo.organisationId` | string or null |   |   | The Organisation billed, with personId as its contact |
| `siteAddress` | string or null |   |   | Where the work is, when not the bill-to's address |
| `about` | object or null |   |   |   |
| `about.object` | string | yes | min length 1, max length 80 |   |
| `about.id` | string | yes | min length 1, max length 64 |   |
| `title` | string or null |   |   |   |
| `notes` | string or null |   |   | For the customer, printed on the document |
| `taxMode` | `"exclusive"`, `"inclusive"` |   |   | Whether unit prices are typed without tax (added on top) or with it (inside) |
| `validUntil` | string or null |   |   | Left empty: the settings' validity from the day it is sent |
| `deposit` | object |   |   | What the customer pays when they accept: none, an amount, or a percentage |
| `deposit.kind` | `"none"`, `"amount"`, `"percent"` | yes |   |   |
| `deposit.value` | integer or null |   | default `null` | An amount in minor units, or hundredths of a percent (2500 = 25%) |
| `lines` | array of object |   | at most 50 | Lines to start with (each as quote.addLine / invoice.addLine takes one) |
| `lines[].item` | object |   |   | A record for sale: the host reads its price. Left out: a typed line |
| `lines[].item.object` | string | yes | min length 1, max length 80 | A sellable object: a pass type, a ticket type |
| `lines[].item.id` | string | yes | min length 1, max length 64 |   |
| `lines[].description` | string |   | min length 1, max length 500 | What it is, as printed. A record's line defaults to its title |
| `lines[].quantity` | number |   | &gt; 0, ≤ 10000, default `1` | How many: up to three decimals, for hours and metres |
| `lines[].unit` | string or null |   |   | hours, m, each |
| `lines[].unitPrice` | integer |   | ≥ 0, ≤ 100000000 | A typed line's price for one, in minor units, as amounts are typed on this document (with or without tax) |
| `lines[].taxRate` | string or null |   |   | A tax rate's key from the invoice settings; null for no tax; left out: the default |
| `lines[].discount` | object or null |   |   | Money off this line, before its tax |
| `lines[].discount.kind` | `"amount"`, `"percent"` | yes |   |   |
| `lines[].discount.value` | integer | yes | ≥ 1, ≤ 10000000000 | An amount in minor units, or hundredths of a percent (1000 = 10%) |
| `lines[].discount.reason` | string | yes | min length 1, max length 200 | Why: printed for staff, kept in the audit |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `state` | `"draft"`, `"sent"`, `"accepted"`, `"declined"`, `"expired"`, `"withdrawn"` | yes |   |   |
| `number` | string or null | yes |   | Given when sent or issued; null on a draft |
| `currency` | string | yes |   |   |
| `taxMode` | `"exclusive"`, `"inclusive"` | yes |   |   |
| `billTo` | object | yes |   |   |
| `billTo.personId` | string or null | yes |   |   |
| `billTo.organisationId` | string or null | yes |   |   |
| `billTo.printed` | object or null | yes |   | As printed, fixed when sent or issued |
| `billTo.printed.name` | string or null | yes |   |   |
| `billTo.printed.address` | string or null | yes |   |   |
| `billTo.printed.taxNumber` | string or null | yes |   |   |
| `billTo.printed.email` | string or null | yes |   |   |
| `siteAddress` | string or null | yes |   |   |
| `about` | object or null | yes |   |   |
| `about.object` | string | yes |   |   |
| `about.id` | string | yes |   |   |
| `title` | string or null | yes |   |   |
| `notes` | string or null | yes |   |   |
| `lines` | array of object | yes |   |   |
| `lines[].id` | string | yes |   |   |
| `lines[].position` | number | yes |   |   |
| `lines[].description` | string | yes |   |   |
| `lines[].quantity` | number | yes |   |   |
| `lines[].unit` | string or null | yes |   |   |
| `lines[].unitPrice` | number | yes |   | For one, in minor units, as the document's amounts are typed |
| `lines[].taxRate` | object or null | yes |   |   |
| `lines[].taxRate.key` | string | yes |   |   |
| `lines[].taxRate.label` | string | yes |   |   |
| `lines[].taxRate.rate` | number | yes |   |   |
| `lines[].discount` | object or null | yes |   |   |
| `lines[].discount.kind` | `"amount"`, `"percent"` | yes |   |   |
| `lines[].discount.value` | number | yes |   |   |
| `lines[].discount.reason` | string | yes |   |   |
| `lines[].discount.amount` | number | yes |   | What it took off, in minor units |
| `lines[].net` | number | yes |   |   |
| `lines[].tax` | number | yes |   |   |
| `lines[].total` | number | yes |   |   |
| `lines[].source` | `"record"`, `"custom"`, `"deduction"` | yes |   |   |
| `lines[].item` | object or null | yes |   |   |
| `lines[].item.object` | string | yes |   |   |
| `lines[].item.id` | string | yes |   |   |
| `netTotal` | number | yes |   |   |
| `taxTotal` | number | yes |   |   |
| `total` | number | yes |   |   |
| `taxByRate` | array of object | yes |   |   |
| `taxByRate[].key` | string | yes |   |   |
| `taxByRate[].label` | string | yes |   |   |
| `taxByRate[].rate` | number | yes |   |   |
| `taxByRate[].net` | number | yes |   |   |
| `taxByRate[].tax` | number | yes |   |   |
| `taxByRate[].total` | number | yes |   |   |
| `version` | number | yes |   | Moves with every write |
| `createdAt` | string | yes |   |   |
| `updatedAt` | string | yes |   |   |
| `validUntil` | string or null | yes |   |   |
| `deposit` | object | yes |   |   |
| `deposit.kind` | `"none"`, `"amount"`, `"percent"` | yes |   |   |
| `deposit.value` | number or null | yes |   |   |
| `replacesQuoteId` | string or null | yes |   |   |
| `sentAt` | string or null | yes |   |   |

## quote.delete

Delete a draft quote and its lines, for good. Only a draft: a quote that has a number is withdrawn instead.

|  |  |
| --- | --- |
| Permission | `invoices:write` |
| Risk | `write` |
| Audiences | `staff` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes | min length 1, max length 64 | The quote's id (qt_…) |
| `version` | integer |   | ≥ 0, ≤ 9007199254740991 | The version you read: a draft changed since by someone else is refused |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `deleted` | `true` | yes |   |   |

## quote.get

One quote with its lines, totals by rate, whom it bills and (once sent) its number and the bill-to as printed. Amounts are integers in the currency's minor unit. Read-only.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `read` |
| Audiences | `staff` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes | min length 1, max length 64 | The quote's id (qt_…) |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `state` | `"draft"`, `"sent"`, `"accepted"`, `"declined"`, `"expired"`, `"withdrawn"` | yes |   |   |
| `number` | string or null | yes |   | Given when sent or issued; null on a draft |
| `currency` | string | yes |   |   |
| `taxMode` | `"exclusive"`, `"inclusive"` | yes |   |   |
| `billTo` | object | yes |   |   |
| `billTo.personId` | string or null | yes |   |   |
| `billTo.organisationId` | string or null | yes |   |   |
| `billTo.printed` | object or null | yes |   | As printed, fixed when sent or issued |
| `billTo.printed.name` | string or null | yes |   |   |
| `billTo.printed.address` | string or null | yes |   |   |
| `billTo.printed.taxNumber` | string or null | yes |   |   |
| `billTo.printed.email` | string or null | yes |   |   |
| `siteAddress` | string or null | yes |   |   |
| `about` | object or null | yes |   |   |
| `about.object` | string | yes |   |   |
| `about.id` | string | yes |   |   |
| `title` | string or null | yes |   |   |
| `notes` | string or null | yes |   |   |
| `lines` | array of object | yes |   |   |
| `lines[].id` | string | yes |   |   |
| `lines[].position` | number | yes |   |   |
| `lines[].description` | string | yes |   |   |
| `lines[].quantity` | number | yes |   |   |
| `lines[].unit` | string or null | yes |   |   |
| `lines[].unitPrice` | number | yes |   | For one, in minor units, as the document's amounts are typed |
| `lines[].taxRate` | object or null | yes |   |   |
| `lines[].taxRate.key` | string | yes |   |   |
| `lines[].taxRate.label` | string | yes |   |   |
| `lines[].taxRate.rate` | number | yes |   |   |
| `lines[].discount` | object or null | yes |   |   |
| `lines[].discount.kind` | `"amount"`, `"percent"` | yes |   |   |
| `lines[].discount.value` | number | yes |   |   |
| `lines[].discount.reason` | string | yes |   |   |
| `lines[].discount.amount` | number | yes |   | What it took off, in minor units |
| `lines[].net` | number | yes |   |   |
| `lines[].tax` | number | yes |   |   |
| `lines[].total` | number | yes |   |   |
| `lines[].source` | `"record"`, `"custom"`, `"deduction"` | yes |   |   |
| `lines[].item` | object or null | yes |   |   |
| `lines[].item.object` | string | yes |   |   |
| `lines[].item.id` | string | yes |   |   |
| `netTotal` | number | yes |   |   |
| `taxTotal` | number | yes |   |   |
| `total` | number | yes |   |   |
| `taxByRate` | array of object | yes |   |   |
| `taxByRate[].key` | string | yes |   |   |
| `taxByRate[].label` | string | yes |   |   |
| `taxByRate[].rate` | number | yes |   |   |
| `taxByRate[].net` | number | yes |   |   |
| `taxByRate[].tax` | number | yes |   |   |
| `taxByRate[].total` | number | yes |   |   |
| `version` | number | yes |   | Moves with every write |
| `createdAt` | string | yes |   |   |
| `updatedAt` | string | yes |   |   |
| `validUntil` | string or null | yes |   |   |
| `deposit` | object | yes |   |   |
| `deposit.kind` | `"none"`, `"amount"`, `"percent"` | yes |   |   |
| `deposit.value` | number or null | yes |   |   |
| `replacesQuoteId` | string or null | yes |   |   |
| `sentAt` | string or null | yes |   |   |

## quote.list

A page of quotes, newest first unless sorted otherwise, without their lines (quote.get has them). Filter and sort on state, number, personId, organisationId, total, createdAt, validUntil. Pass nextCursor back as cursor for the next page. Read-only.

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
| `items[].number` | string or null | yes |   |   |
| `items[].state` | string | yes |   |   |
| `items[].currency` | string | yes |   |   |
| `items[].personId` | string or null | yes |   |   |
| `items[].organisationId` | string or null | yes |   |   |
| `items[].netTotal` | number | yes |   |   |
| `items[].taxTotal` | number | yes |   |   |
| `items[].total` | number | yes |   |   |
| `items[].createdAt` | string | yes |   |   |
| `items[].updatedAt` | string | yes |   |   |
| `items[].validUntil` | string or null |   |   |   |
| `items[].kind` | `"standard"`, `"deposit"`, `"final"` |   |   |   |
| `items[].issuedOn` | string or null |   |   |   |
| `items[].dueOn` | string or null |   |   |   |
| `nextCursor` | string or null | yes |   |   |

## quote.removeLine

Remove a line from a draft quote. The others close up, and the totals are worked out again.

|  |  |
| --- | --- |
| Permission | `invoices:write` |
| Risk | `write` |
| Audiences | `staff` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `lineId` | string | yes | min length 1, max length 64 | The line's id |
| `version` | integer |   | ≥ 0, ≤ 9007199254740991 | The version you read: a draft changed since by someone else is refused |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `state` | `"draft"`, `"sent"`, `"accepted"`, `"declined"`, `"expired"`, `"withdrawn"` | yes |   |   |
| `number` | string or null | yes |   | Given when sent or issued; null on a draft |
| `currency` | string | yes |   |   |
| `taxMode` | `"exclusive"`, `"inclusive"` | yes |   |   |
| `billTo` | object | yes |   |   |
| `billTo.personId` | string or null | yes |   |   |
| `billTo.organisationId` | string or null | yes |   |   |
| `billTo.printed` | object or null | yes |   | As printed, fixed when sent or issued |
| `billTo.printed.name` | string or null | yes |   |   |
| `billTo.printed.address` | string or null | yes |   |   |
| `billTo.printed.taxNumber` | string or null | yes |   |   |
| `billTo.printed.email` | string or null | yes |   |   |
| `siteAddress` | string or null | yes |   |   |
| `about` | object or null | yes |   |   |
| `about.object` | string | yes |   |   |
| `about.id` | string | yes |   |   |
| `title` | string or null | yes |   |   |
| `notes` | string or null | yes |   |   |
| `lines` | array of object | yes |   |   |
| `lines[].id` | string | yes |   |   |
| `lines[].position` | number | yes |   |   |
| `lines[].description` | string | yes |   |   |
| `lines[].quantity` | number | yes |   |   |
| `lines[].unit` | string or null | yes |   |   |
| `lines[].unitPrice` | number | yes |   | For one, in minor units, as the document's amounts are typed |
| `lines[].taxRate` | object or null | yes |   |   |
| `lines[].taxRate.key` | string | yes |   |   |
| `lines[].taxRate.label` | string | yes |   |   |
| `lines[].taxRate.rate` | number | yes |   |   |
| `lines[].discount` | object or null | yes |   |   |
| `lines[].discount.kind` | `"amount"`, `"percent"` | yes |   |   |
| `lines[].discount.value` | number | yes |   |   |
| `lines[].discount.reason` | string | yes |   |   |
| `lines[].discount.amount` | number | yes |   | What it took off, in minor units |
| `lines[].net` | number | yes |   |   |
| `lines[].tax` | number | yes |   |   |
| `lines[].total` | number | yes |   |   |
| `lines[].source` | `"record"`, `"custom"`, `"deduction"` | yes |   |   |
| `lines[].item` | object or null | yes |   |   |
| `lines[].item.object` | string | yes |   |   |
| `lines[].item.id` | string | yes |   |   |
| `netTotal` | number | yes |   |   |
| `taxTotal` | number | yes |   |   |
| `total` | number | yes |   |   |
| `taxByRate` | array of object | yes |   |   |
| `taxByRate[].key` | string | yes |   |   |
| `taxByRate[].label` | string | yes |   |   |
| `taxByRate[].rate` | number | yes |   |   |
| `taxByRate[].net` | number | yes |   |   |
| `taxByRate[].tax` | number | yes |   |   |
| `taxByRate[].total` | number | yes |   |   |
| `version` | number | yes |   | Moves with every write |
| `createdAt` | string | yes |   |   |
| `updatedAt` | string | yes |   |   |
| `validUntil` | string or null | yes |   |   |
| `deposit` | object | yes |   |   |
| `deposit.kind` | `"none"`, `"amount"`, `"percent"` | yes |   |   |
| `deposit.value` | number or null | yes |   |   |
| `replacesQuoteId` | string or null | yes |   |   |
| `sentAt` | string or null | yes |   |   |

## quote.update

Change a draft quote: whom it is for, the site address, what it is about, title, notes, valid-until, the deposit, or whether its amounts are typed with or without tax (its lines are priced again). Only what is given changes; null clears. A sent quote is never changed: it is withdrawn and a new one sent.

|  |  |
| --- | --- |
| Permission | `invoices:write` |
| Risk | `write` |
| Audiences | `staff` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes | min length 1, max length 64 | The quote's id (qt_…) |
| `version` | integer |   | ≥ 0, ≤ 9007199254740991 | The version you read: a draft changed since by someone else is refused |
| `billTo` | object or null |   |   |   |
| `billTo.personId` | string | yes | min length 1, max length 64 | The Person billed, or the organisation's contact Person |
| `billTo.organisationId` | string or null |   |   | The Organisation billed, with personId as its contact |
| `siteAddress` | string or null |   |   | Where the work is, when not the bill-to's address |
| `about` | object or null |   |   |   |
| `about.object` | string | yes | min length 1, max length 80 |   |
| `about.id` | string | yes | min length 1, max length 64 |   |
| `title` | string or null |   |   |   |
| `notes` | string or null |   |   | For the customer, printed on the document |
| `taxMode` | `"exclusive"`, `"inclusive"` |   |   | Whether unit prices are typed without tax (added on top) or with it (inside) |
| `validUntil` | string or null |   |   | Left empty: the settings' validity from the day it is sent |
| `deposit` | object |   |   | What the customer pays when they accept: none, an amount, or a percentage |
| `deposit.kind` | `"none"`, `"amount"`, `"percent"` | yes |   |   |
| `deposit.value` | integer or null |   | default `null` | An amount in minor units, or hundredths of a percent (2500 = 25%) |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `state` | `"draft"`, `"sent"`, `"accepted"`, `"declined"`, `"expired"`, `"withdrawn"` | yes |   |   |
| `number` | string or null | yes |   | Given when sent or issued; null on a draft |
| `currency` | string | yes |   |   |
| `taxMode` | `"exclusive"`, `"inclusive"` | yes |   |   |
| `billTo` | object | yes |   |   |
| `billTo.personId` | string or null | yes |   |   |
| `billTo.organisationId` | string or null | yes |   |   |
| `billTo.printed` | object or null | yes |   | As printed, fixed when sent or issued |
| `billTo.printed.name` | string or null | yes |   |   |
| `billTo.printed.address` | string or null | yes |   |   |
| `billTo.printed.taxNumber` | string or null | yes |   |   |
| `billTo.printed.email` | string or null | yes |   |   |
| `siteAddress` | string or null | yes |   |   |
| `about` | object or null | yes |   |   |
| `about.object` | string | yes |   |   |
| `about.id` | string | yes |   |   |
| `title` | string or null | yes |   |   |
| `notes` | string or null | yes |   |   |
| `lines` | array of object | yes |   |   |
| `lines[].id` | string | yes |   |   |
| `lines[].position` | number | yes |   |   |
| `lines[].description` | string | yes |   |   |
| `lines[].quantity` | number | yes |   |   |
| `lines[].unit` | string or null | yes |   |   |
| `lines[].unitPrice` | number | yes |   | For one, in minor units, as the document's amounts are typed |
| `lines[].taxRate` | object or null | yes |   |   |
| `lines[].taxRate.key` | string | yes |   |   |
| `lines[].taxRate.label` | string | yes |   |   |
| `lines[].taxRate.rate` | number | yes |   |   |
| `lines[].discount` | object or null | yes |   |   |
| `lines[].discount.kind` | `"amount"`, `"percent"` | yes |   |   |
| `lines[].discount.value` | number | yes |   |   |
| `lines[].discount.reason` | string | yes |   |   |
| `lines[].discount.amount` | number | yes |   | What it took off, in minor units |
| `lines[].net` | number | yes |   |   |
| `lines[].tax` | number | yes |   |   |
| `lines[].total` | number | yes |   |   |
| `lines[].source` | `"record"`, `"custom"`, `"deduction"` | yes |   |   |
| `lines[].item` | object or null | yes |   |   |
| `lines[].item.object` | string | yes |   |   |
| `lines[].item.id` | string | yes |   |   |
| `netTotal` | number | yes |   |   |
| `taxTotal` | number | yes |   |   |
| `total` | number | yes |   |   |
| `taxByRate` | array of object | yes |   |   |
| `taxByRate[].key` | string | yes |   |   |
| `taxByRate[].label` | string | yes |   |   |
| `taxByRate[].rate` | number | yes |   |   |
| `taxByRate[].net` | number | yes |   |   |
| `taxByRate[].tax` | number | yes |   |   |
| `taxByRate[].total` | number | yes |   |   |
| `version` | number | yes |   | Moves with every write |
| `createdAt` | string | yes |   |   |
| `updatedAt` | string | yes |   |   |
| `validUntil` | string or null | yes |   |   |
| `deposit` | object | yes |   |   |
| `deposit.kind` | `"none"`, `"amount"`, `"percent"` | yes |   |   |
| `deposit.value` | number or null | yes |   |   |
| `replacesQuoteId` | string or null | yes |   |   |
| `sentAt` | string or null | yes |   |   |

## quote.updateLine

Change a line of a draft quote: its description, quantity, unit, unit price (a typed line's only: a record's line keeps the host's price), tax rate, discount (null removes it) or position (the others move along). Only what is given changes. The host works out the line's tax and the quote's totals again.

|  |  |
| --- | --- |
| Permission | `invoices:write` |
| Risk | `write` |
| Audiences | `staff` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `lineId` | string | yes | min length 1, max length 64 | The line's id |
| `version` | integer |   | ≥ 0, ≤ 9007199254740991 | The version you read: a draft changed since by someone else is refused |
| `change` | object | yes |   |   |
| `change.description` | string |   | min length 1, max length 500 |   |
| `change.quantity` | number |   | &gt; 0, ≤ 10000 | How many: up to three decimals, for hours and metres |
| `change.unit` | string or null |   |   |   |
| `change.unitPrice` | integer |   | ≥ 0, ≤ 100000000 |   |
| `change.taxRate` | string or null |   |   | A tax rate's key from the invoice settings; null for no tax; left out: the default |
| `change.discount` | object or null |   |   |   |
| `change.discount.kind` | `"amount"`, `"percent"` | yes |   |   |
| `change.discount.value` | integer | yes | ≥ 1, ≤ 10000000000 | An amount in minor units, or hundredths of a percent (1000 = 10%) |
| `change.discount.reason` | string | yes | min length 1, max length 200 | Why: printed for staff, kept in the audit |
| `change.position` | integer |   | ≥ 0, ≤ 50 |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `state` | `"draft"`, `"sent"`, `"accepted"`, `"declined"`, `"expired"`, `"withdrawn"` | yes |   |   |
| `number` | string or null | yes |   | Given when sent or issued; null on a draft |
| `currency` | string | yes |   |   |
| `taxMode` | `"exclusive"`, `"inclusive"` | yes |   |   |
| `billTo` | object | yes |   |   |
| `billTo.personId` | string or null | yes |   |   |
| `billTo.organisationId` | string or null | yes |   |   |
| `billTo.printed` | object or null | yes |   | As printed, fixed when sent or issued |
| `billTo.printed.name` | string or null | yes |   |   |
| `billTo.printed.address` | string or null | yes |   |   |
| `billTo.printed.taxNumber` | string or null | yes |   |   |
| `billTo.printed.email` | string or null | yes |   |   |
| `siteAddress` | string or null | yes |   |   |
| `about` | object or null | yes |   |   |
| `about.object` | string | yes |   |   |
| `about.id` | string | yes |   |   |
| `title` | string or null | yes |   |   |
| `notes` | string or null | yes |   |   |
| `lines` | array of object | yes |   |   |
| `lines[].id` | string | yes |   |   |
| `lines[].position` | number | yes |   |   |
| `lines[].description` | string | yes |   |   |
| `lines[].quantity` | number | yes |   |   |
| `lines[].unit` | string or null | yes |   |   |
| `lines[].unitPrice` | number | yes |   | For one, in minor units, as the document's amounts are typed |
| `lines[].taxRate` | object or null | yes |   |   |
| `lines[].taxRate.key` | string | yes |   |   |
| `lines[].taxRate.label` | string | yes |   |   |
| `lines[].taxRate.rate` | number | yes |   |   |
| `lines[].discount` | object or null | yes |   |   |
| `lines[].discount.kind` | `"amount"`, `"percent"` | yes |   |   |
| `lines[].discount.value` | number | yes |   |   |
| `lines[].discount.reason` | string | yes |   |   |
| `lines[].discount.amount` | number | yes |   | What it took off, in minor units |
| `lines[].net` | number | yes |   |   |
| `lines[].tax` | number | yes |   |   |
| `lines[].total` | number | yes |   |   |
| `lines[].source` | `"record"`, `"custom"`, `"deduction"` | yes |   |   |
| `lines[].item` | object or null | yes |   |   |
| `lines[].item.object` | string | yes |   |   |
| `lines[].item.id` | string | yes |   |   |
| `netTotal` | number | yes |   |   |
| `taxTotal` | number | yes |   |   |
| `total` | number | yes |   |   |
| `taxByRate` | array of object | yes |   |   |
| `taxByRate[].key` | string | yes |   |   |
| `taxByRate[].label` | string | yes |   |   |
| `taxByRate[].rate` | number | yes |   |   |
| `taxByRate[].net` | number | yes |   |   |
| `taxByRate[].tax` | number | yes |   |   |
| `taxByRate[].total` | number | yes |   |   |
| `version` | number | yes |   | Moves with every write |
| `createdAt` | string | yes |   |   |
| `updatedAt` | string | yes |   |   |
| `validUntil` | string or null | yes |   |   |
| `deposit` | object | yes |   |   |
| `deposit.kind` | `"none"`, `"amount"`, `"percent"` | yes |   |   |
| `deposit.value` | number or null | yes |   |   |
| `replacesQuoteId` | string or null | yes |   |   |
| `sentAt` | string or null | yes |   |   |
