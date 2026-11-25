---
title: "invoice.* operations"
description: "The core operations named invoice.*"
sidebar:
  label: "invoice"
editUrl: false
---

## invoice.addLine

Add a line to a draft invoice: a record for sale (item: its object and id), priced by the host from the record, or a typed line (description, quantity, unit, unitPrice in minor units, as the invoice's amounts are typed). Each line has a tax rate (a key from the invoice settings; left out, the default; null, no tax) and an optional discount (an amount or a percentage, with why), taken off before the tax. The host works out the line's tax, rounded half up, and the invoice's totals by rate. At most 50 lines.

|  |  |
| --- | --- |
| Permission | `invoices:write` |
| Risk | `write` |
| Audiences | `staff` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes | min length 1, max length 64 | The invoice's id (inv_…) |
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
| `state` | `"draft"`, `"issued"`, `"sent"`, `"part_paid"`, `"paid"`, `"credited"`, `"void"` | yes |   |   |
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
| `kind` | `"standard"`, `"deposit"`, `"final"` | yes |   |   |
| `quoteId` | string or null | yes |   |   |
| `orderId` | string or null | yes |   |   |
| `paymentTermsDays` | number | yes |   |   |
| `issuedOn` | string or null | yes |   |   |
| `dueOn` | string or null | yes |   | Set on a draft, or worked out at issue from the terms |
| `allowPartPayments` | boolean | yes |   |   |
| `remindersPaused` | boolean | yes |   |   |
| `money` | object or null |   |   | Once issued (invoice.get): its order's money |
| `money.paid` | number | yes |   |   |
| `money.credited` | number | yes |   | What credit notes took off what was owed |
| `money.refunded` | number | yes |   | What has gone back, confirmed or recorded |
| `money.balance` | number | yes |   | What is still owed: total less paid less credited |
| `money.owedBack` | number | yes |   | What credit notes give back that has not gone back yet, nor waits for approval |
| `money.orderState` | string | yes |   |   |

## invoice.allowPartPayments

Allow (or stop) part payments online on an issued invoice. Without, the payment page asks for the whole balance; with, the payer may pay part of it, at least the minimum set for orders. A payment recorded by staff can be any amount up to the balance either way. Returns the invoice.

|  |  |
| --- | --- |
| Permission | `invoices:send` |
| Risk | `write` |
| Audiences | `staff` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes | min length 1, max length 64 | The invoice's id (inv_…) |
| `allow` | boolean | yes |   |   |
| `version` | integer | yes | ≥ 0, ≤ 9007199254740991 | The version you read (from get): required, so what is approved is what was asked; one changed since is refused |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `state` | `"draft"`, `"issued"`, `"sent"`, `"part_paid"`, `"paid"`, `"credited"`, `"void"` | yes |   |   |
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
| `kind` | `"standard"`, `"deposit"`, `"final"` | yes |   |   |
| `quoteId` | string or null | yes |   |   |
| `orderId` | string or null | yes |   |   |
| `paymentTermsDays` | number | yes |   |   |
| `issuedOn` | string or null | yes |   |   |
| `dueOn` | string or null | yes |   | Set on a draft, or worked out at issue from the terms |
| `allowPartPayments` | boolean | yes |   |   |
| `remindersPaused` | boolean | yes |   |   |
| `money` | object or null |   |   | Once issued (invoice.get): its order's money |
| `money.paid` | number | yes |   |   |
| `money.credited` | number | yes |   | What credit notes took off what was owed |
| `money.refunded` | number | yes |   | What has gone back, confirmed or recorded |
| `money.balance` | number | yes |   | What is still owed: total less paid less credited |
| `money.owedBack` | number | yes |   | What credit notes give back that has not gone back yet, nor waits for approval |
| `money.orderState` | string | yes |   |   |

## invoice.create

Start an invoice as a draft: whom it is for (a Person, or an Organisation with its contact Person), an optional site address, the record it is about, a title, notes for the customer, payment terms (the settings' by default) or a due date, and lines. A line is a record for sale (a pass type, a ticket type, a price-list item), priced by the host, or a typed line with a description, quantity, unit and unit price; each has a tax rate from the invoice settings and an optional discount. The host works out each line's tax and the totals. A draft has no number and changes freely: nothing is owed until a person issues it. Amounts are integers in the currency's minor unit.

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
| `paymentTermsDays` | integer |   | ≥ 0, ≤ 365 |   |
| `dueOn` | string or null |   |   | Left empty: worked out at issue from the payment terms |
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
| `state` | `"draft"`, `"issued"`, `"sent"`, `"part_paid"`, `"paid"`, `"credited"`, `"void"` | yes |   |   |
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
| `kind` | `"standard"`, `"deposit"`, `"final"` | yes |   |   |
| `quoteId` | string or null | yes |   |   |
| `orderId` | string or null | yes |   |   |
| `paymentTermsDays` | number | yes |   |   |
| `issuedOn` | string or null | yes |   |   |
| `dueOn` | string or null | yes |   | Set on a draft, or worked out at issue from the terms |
| `allowPartPayments` | boolean | yes |   |   |
| `remindersPaused` | boolean | yes |   |   |
| `money` | object or null |   |   | Once issued (invoice.get): its order's money |
| `money.paid` | number | yes |   |   |
| `money.credited` | number | yes |   | What credit notes took off what was owed |
| `money.refunded` | number | yes |   | What has gone back, confirmed or recorded |
| `money.balance` | number | yes |   | What is still owed: total less paid less credited |
| `money.owedBack` | number | yes |   | What credit notes give back that has not gone back yet, nor waits for approval |
| `money.orderState` | string | yes |   |   |

## invoice.delete

Delete a draft invoice and its lines, for good. Only a draft: a invoice that has a number is credited or voided instead.

|  |  |
| --- | --- |
| Permission | `invoices:write` |
| Risk | `write` |
| Audiences | `staff` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes | min length 1, max length 64 | The invoice's id (inv_…) |
| `version` | integer |   | ≥ 0, ≤ 9007199254740991 | The version you read: a draft changed since by someone else is refused |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `deleted` | `true` | yes |   |   |

## invoice.events

The document event log, oldest first after a cursor: one row per quote sent, invoice or credit note issued, payment applied or reversed (with its payment row and method), credit, refund confirmed, payment paid back and void, each with its amount and when. Rows are never changed or removed and seq only grows: pass the last seq you read as after. For the books and finance reports. Read-only.

|  |  |
| --- | --- |
| Permission | `invoices:payments` |
| Risk | `read` |
| Audiences | `staff` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `after` | integer |   | ≥ 0, ≤ 9007199254740991, default `0` | The last seq read; 0 from the start |
| `limit` | integer |   | ≥ 1, ≤ 500, default `100` |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `items` | array of object | yes |   |   |
| `items[].seq` | number | yes |   |   |
| `items[].documentKind` | `"quote"`, `"invoice"`, `"credit_note"` | yes |   |   |
| `items[].documentId` | string | yes |   |   |
| `items[].invoiceId` | string or null | yes |   |   |
| `items[].event` | `"issued"`, `"sent"`, `"payment_applied"`, `"payment_reversed"`, `"credited"`, `"refund_confirmed"`, `"paid_back"`, `"voided"` | yes |   |   |
| `items[].paymentId` | string or null | yes |   |   |
| `items[].method` | string or null | yes |   |   |
| `items[].amount` | number or null | yes |   |   |
| `items[].currency` | string or null | yes |   |   |
| `items[].at` | string | yes |   |   |
| `items[].byUser` | string or null | yes |   |   |
| `last` | number | yes |   | The last seq returned (after, when none): the next call's after |

## invoice.get

One invoice with its lines, totals by rate, whom it bills and (once issued) its number and the bill-to as printed. Amounts are integers in the currency's minor unit. Read-only.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `read` |
| Audiences | `staff` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes | min length 1, max length 64 | The invoice's id (inv_…) |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `state` | `"draft"`, `"issued"`, `"sent"`, `"part_paid"`, `"paid"`, `"credited"`, `"void"` | yes |   |   |
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
| `kind` | `"standard"`, `"deposit"`, `"final"` | yes |   |   |
| `quoteId` | string or null | yes |   |   |
| `orderId` | string or null | yes |   |   |
| `paymentTermsDays` | number | yes |   |   |
| `issuedOn` | string or null | yes |   |   |
| `dueOn` | string or null | yes |   | Set on a draft, or worked out at issue from the terms |
| `allowPartPayments` | boolean | yes |   |   |
| `remindersPaused` | boolean | yes |   |   |
| `money` | object or null |   |   | Once issued (invoice.get): its order's money |
| `money.paid` | number | yes |   |   |
| `money.credited` | number | yes |   | What credit notes took off what was owed |
| `money.refunded` | number | yes |   | What has gone back, confirmed or recorded |
| `money.balance` | number | yes |   | What is still owed: total less paid less credited |
| `money.owedBack` | number | yes |   | What credit notes give back that has not gone back yet, nor waits for approval |
| `money.orderState` | string | yes |   |   |

## invoice.issue

Issue a draft invoice: it takes the next number of the invoice series (INV-0042), its bill-to as printed, the business's details and bank details as they are now, its issue date and its due date (the draft's, or today plus its payment terms), and starts its order in the same step: the invoice's lines as the host priced them, its line discounts, and the tax worked out on it. From then on it is never changed: it is credited. Its order does not expire: it is due on the invoice's due date and shows among the overdue after it; places it holds are held until it is paid, credited or voided. A record's price that changed since its line was added, goods, and an agreement the bill-to still needs are refused with why. A line discount needs the discount permission, and over the limit an admin set it waits for approval. An AI assistant can ask; a person approves. Sending it is a separate step. Returns the invoice.

|  |  |
| --- | --- |
| Permission | `invoices:send` |
| Risk | `write` |
| Audiences | `staff` |
| Actors | `human`, `assistant`, `mcp` |
| Also | always reviewed when called by `assistant`, `mcp` (`alwaysReview`); reviewed by a person when its own rule says so for the input (`reviewWhen`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes | min length 1, max length 64 | The invoice's id (inv_…) |
| `version` | integer | yes | ≥ 0, ≤ 9007199254740991 | The version you read (from get): required, so what is approved is what was asked; one changed since is refused |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `state` | `"draft"`, `"issued"`, `"sent"`, `"part_paid"`, `"paid"`, `"credited"`, `"void"` | yes |   |   |
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
| `kind` | `"standard"`, `"deposit"`, `"final"` | yes |   |   |
| `quoteId` | string or null | yes |   |   |
| `orderId` | string or null | yes |   |   |
| `paymentTermsDays` | number | yes |   |   |
| `issuedOn` | string or null | yes |   |   |
| `dueOn` | string or null | yes |   | Set on a draft, or worked out at issue from the terms |
| `allowPartPayments` | boolean | yes |   |   |
| `remindersPaused` | boolean | yes |   |   |
| `money` | object or null |   |   | Once issued (invoice.get): its order's money |
| `money.paid` | number | yes |   |   |
| `money.credited` | number | yes |   | What credit notes took off what was owed |
| `money.refunded` | number | yes |   | What has gone back, confirmed or recorded |
| `money.balance` | number | yes |   | What is still owed: total less paid less credited |
| `money.owedBack` | number | yes |   | What credit notes give back that has not gone back yet, nor waits for approval |
| `money.orderState` | string | yes |   |   |

## invoice.list

A page of invoices, newest first unless sorted otherwise, without their lines (invoice.get has them). Filter and sort on state, number, personId, organisationId, total, createdAt, kind, issuedOn, dueOn. Pass nextCursor back as cursor for the next page. Read-only.

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

## invoice.recordPayment

Record a payment of an issued invoice taken another way than the payment page: a bank transfer, cash, a cheque, a card machine. Any amount up to the balance, never more. The invoice becomes part paid or paid, as its order does, and what it bought is given. The payment names you as the person who received it; it is in the invoice's log, on the timeline, and admins are told of one over the amount set in the invoice settings. A person only, with the permission to record invoice payments: AI assistants, MCP clients, automations and extensions are refused. Returns the payment's id and the invoice.

|  |  |
| --- | --- |
| Permission | `invoices:payments` |
| Risk | `write` |
| Audiences | `staff` |
| Actors | `human` |
| Also | not offered to MCP clients (`mcp.expose: false`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `invoiceId` | string | yes | min length 1, max length 64 | The invoice's id (inv_…) |
| `amount` | integer | yes | ≥ 1, ≤ 100000000 | What was received, in the currency's minor unit (cents) |
| `kind` | `"transfer"`, `"cash"`, `"cheque"`, `"card_machine"`, `"other"` | yes |   | How it was paid: transfer, cash, cheque, card_machine or other |
| `receivedOn` | string | yes | pattern `^\d{4}-\d{2}-\d{2}$` | The day it was received (YYYY-MM-DD) |
| `reference` | string |   | min length 1, max length 200 | The payer's reference: a bank reference, a cheque number |
| `version` | integer | yes | ≥ 0, ≤ 9007199254740991 | The version you read (from get): required, so what is approved is what was asked; one changed since is refused |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `paymentId` | string | yes |   | The payment row (opy_…): what a reversal names |
| `invoice` | object | yes |   |   |
| `invoice.id` | string | yes |   |   |
| `invoice.state` | `"draft"`, `"issued"`, `"sent"`, `"part_paid"`, `"paid"`, `"credited"`, `"void"` | yes |   |   |
| `invoice.number` | string or null | yes |   | Given when sent or issued; null on a draft |
| `invoice.currency` | string | yes |   |   |
| `invoice.taxMode` | `"exclusive"`, `"inclusive"` | yes |   |   |
| `invoice.billTo` | object | yes |   |   |
| `invoice.billTo.personId` | string or null | yes |   |   |
| `invoice.billTo.organisationId` | string or null | yes |   |   |
| `invoice.billTo.printed` | object or null | yes |   | As printed, fixed when sent or issued |
| `invoice.billTo.printed.name` | string or null | yes |   |   |
| `invoice.billTo.printed.address` | string or null | yes |   |   |
| `invoice.billTo.printed.taxNumber` | string or null | yes |   |   |
| `invoice.billTo.printed.email` | string or null | yes |   |   |
| `invoice.siteAddress` | string or null | yes |   |   |
| `invoice.about` | object or null | yes |   |   |
| `invoice.about.object` | string | yes |   |   |
| `invoice.about.id` | string | yes |   |   |
| `invoice.title` | string or null | yes |   |   |
| `invoice.notes` | string or null | yes |   |   |
| `invoice.lines` | array of object | yes |   |   |
| `invoice.lines[].id` | string | yes |   |   |
| `invoice.lines[].position` | number | yes |   |   |
| `invoice.lines[].description` | string | yes |   |   |
| `invoice.lines[].quantity` | number | yes |   |   |
| `invoice.lines[].unit` | string or null | yes |   |   |
| `invoice.lines[].unitPrice` | number | yes |   | For one, in minor units, as the document's amounts are typed |
| `invoice.lines[].taxRate` | object or null | yes |   |   |
| `invoice.lines[].taxRate.key` | string | yes |   |   |
| `invoice.lines[].taxRate.label` | string | yes |   |   |
| `invoice.lines[].taxRate.rate` | number | yes |   |   |
| `invoice.lines[].discount` | object or null | yes |   |   |
| `invoice.lines[].discount.kind` | `"amount"`, `"percent"` | yes |   |   |
| `invoice.lines[].discount.value` | number | yes |   |   |
| `invoice.lines[].discount.reason` | string | yes |   |   |
| `invoice.lines[].discount.amount` | number | yes |   | What it took off, in minor units |
| `invoice.lines[].net` | number | yes |   |   |
| `invoice.lines[].tax` | number | yes |   |   |
| `invoice.lines[].total` | number | yes |   |   |
| `invoice.lines[].source` | `"record"`, `"custom"`, `"deduction"` | yes |   |   |
| `invoice.lines[].item` | object or null | yes |   |   |
| `invoice.lines[].item.object` | string | yes |   |   |
| `invoice.lines[].item.id` | string | yes |   |   |
| `invoice.netTotal` | number | yes |   |   |
| `invoice.taxTotal` | number | yes |   |   |
| `invoice.total` | number | yes |   |   |
| `invoice.taxByRate` | array of object | yes |   |   |
| `invoice.taxByRate[].key` | string | yes |   |   |
| `invoice.taxByRate[].label` | string | yes |   |   |
| `invoice.taxByRate[].rate` | number | yes |   |   |
| `invoice.taxByRate[].net` | number | yes |   |   |
| `invoice.taxByRate[].tax` | number | yes |   |   |
| `invoice.taxByRate[].total` | number | yes |   |   |
| `invoice.version` | number | yes |   | Moves with every write |
| `invoice.createdAt` | string | yes |   |   |
| `invoice.updatedAt` | string | yes |   |   |
| `invoice.kind` | `"standard"`, `"deposit"`, `"final"` | yes |   |   |
| `invoice.quoteId` | string or null | yes |   |   |
| `invoice.orderId` | string or null | yes |   |   |
| `invoice.paymentTermsDays` | number | yes |   |   |
| `invoice.issuedOn` | string or null | yes |   |   |
| `invoice.dueOn` | string or null | yes |   | Set on a draft, or worked out at issue from the terms |
| `invoice.allowPartPayments` | boolean | yes |   |   |
| `invoice.remindersPaused` | boolean | yes |   |   |
| `invoice.money` | object or null |   |   | Once issued (invoice.get): its order's money |
| `invoice.money.paid` | number | yes |   |   |
| `invoice.money.credited` | number | yes |   | What credit notes took off what was owed |
| `invoice.money.refunded` | number | yes |   | What has gone back, confirmed or recorded |
| `invoice.money.balance` | number | yes |   | What is still owed: total less paid less credited |
| `invoice.money.owedBack` | number | yes |   | What credit notes give back that has not gone back yet, nor waits for approval |
| `invoice.money.orderState` | string | yes |   |   |

## invoice.removeLine

Remove a line from a draft invoice. The others close up, and the totals are worked out again.

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
| `state` | `"draft"`, `"issued"`, `"sent"`, `"part_paid"`, `"paid"`, `"credited"`, `"void"` | yes |   |   |
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
| `kind` | `"standard"`, `"deposit"`, `"final"` | yes |   |   |
| `quoteId` | string or null | yes |   |   |
| `orderId` | string or null | yes |   |   |
| `paymentTermsDays` | number | yes |   |   |
| `issuedOn` | string or null | yes |   |   |
| `dueOn` | string or null | yes |   | Set on a draft, or worked out at issue from the terms |
| `allowPartPayments` | boolean | yes |   |   |
| `remindersPaused` | boolean | yes |   |   |
| `money` | object or null |   |   | Once issued (invoice.get): its order's money |
| `money.paid` | number | yes |   |   |
| `money.credited` | number | yes |   | What credit notes took off what was owed |
| `money.refunded` | number | yes |   | What has gone back, confirmed or recorded |
| `money.balance` | number | yes |   | What is still owed: total less paid less credited |
| `money.owedBack` | number | yes |   | What credit notes give back that has not gone back yet, nor waits for approval |
| `money.orderState` | string | yes |   |   |

## invoice.reversePayment

Reverse a payment recorded on an invoice in error (invoice.recordPayment): a second entry takes it back off, nothing is deleted, and a paid invoice is part paid again with the amount owed. What it gave stays. Not for a payment made on the payment page (credit the invoice instead), nor one a credit note gives money back on. Admins are told. A person only, with the permission to record invoice payments. Returns the reversal's id and the invoice.

|  |  |
| --- | --- |
| Permission | `invoices:payments` |
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
| `paymentId` | string | yes |   | The payment row (opy_…): what a reversal names |
| `invoice` | object | yes |   |   |
| `invoice.id` | string | yes |   |   |
| `invoice.state` | `"draft"`, `"issued"`, `"sent"`, `"part_paid"`, `"paid"`, `"credited"`, `"void"` | yes |   |   |
| `invoice.number` | string or null | yes |   | Given when sent or issued; null on a draft |
| `invoice.currency` | string | yes |   |   |
| `invoice.taxMode` | `"exclusive"`, `"inclusive"` | yes |   |   |
| `invoice.billTo` | object | yes |   |   |
| `invoice.billTo.personId` | string or null | yes |   |   |
| `invoice.billTo.organisationId` | string or null | yes |   |   |
| `invoice.billTo.printed` | object or null | yes |   | As printed, fixed when sent or issued |
| `invoice.billTo.printed.name` | string or null | yes |   |   |
| `invoice.billTo.printed.address` | string or null | yes |   |   |
| `invoice.billTo.printed.taxNumber` | string or null | yes |   |   |
| `invoice.billTo.printed.email` | string or null | yes |   |   |
| `invoice.siteAddress` | string or null | yes |   |   |
| `invoice.about` | object or null | yes |   |   |
| `invoice.about.object` | string | yes |   |   |
| `invoice.about.id` | string | yes |   |   |
| `invoice.title` | string or null | yes |   |   |
| `invoice.notes` | string or null | yes |   |   |
| `invoice.lines` | array of object | yes |   |   |
| `invoice.lines[].id` | string | yes |   |   |
| `invoice.lines[].position` | number | yes |   |   |
| `invoice.lines[].description` | string | yes |   |   |
| `invoice.lines[].quantity` | number | yes |   |   |
| `invoice.lines[].unit` | string or null | yes |   |   |
| `invoice.lines[].unitPrice` | number | yes |   | For one, in minor units, as the document's amounts are typed |
| `invoice.lines[].taxRate` | object or null | yes |   |   |
| `invoice.lines[].taxRate.key` | string | yes |   |   |
| `invoice.lines[].taxRate.label` | string | yes |   |   |
| `invoice.lines[].taxRate.rate` | number | yes |   |   |
| `invoice.lines[].discount` | object or null | yes |   |   |
| `invoice.lines[].discount.kind` | `"amount"`, `"percent"` | yes |   |   |
| `invoice.lines[].discount.value` | number | yes |   |   |
| `invoice.lines[].discount.reason` | string | yes |   |   |
| `invoice.lines[].discount.amount` | number | yes |   | What it took off, in minor units |
| `invoice.lines[].net` | number | yes |   |   |
| `invoice.lines[].tax` | number | yes |   |   |
| `invoice.lines[].total` | number | yes |   |   |
| `invoice.lines[].source` | `"record"`, `"custom"`, `"deduction"` | yes |   |   |
| `invoice.lines[].item` | object or null | yes |   |   |
| `invoice.lines[].item.object` | string | yes |   |   |
| `invoice.lines[].item.id` | string | yes |   |   |
| `invoice.netTotal` | number | yes |   |   |
| `invoice.taxTotal` | number | yes |   |   |
| `invoice.total` | number | yes |   |   |
| `invoice.taxByRate` | array of object | yes |   |   |
| `invoice.taxByRate[].key` | string | yes |   |   |
| `invoice.taxByRate[].label` | string | yes |   |   |
| `invoice.taxByRate[].rate` | number | yes |   |   |
| `invoice.taxByRate[].net` | number | yes |   |   |
| `invoice.taxByRate[].tax` | number | yes |   |   |
| `invoice.taxByRate[].total` | number | yes |   |   |
| `invoice.version` | number | yes |   | Moves with every write |
| `invoice.createdAt` | string | yes |   |   |
| `invoice.updatedAt` | string | yes |   |   |
| `invoice.kind` | `"standard"`, `"deposit"`, `"final"` | yes |   |   |
| `invoice.quoteId` | string or null | yes |   |   |
| `invoice.orderId` | string or null | yes |   |   |
| `invoice.paymentTermsDays` | number | yes |   |   |
| `invoice.issuedOn` | string or null | yes |   |   |
| `invoice.dueOn` | string or null | yes |   | Set on a draft, or worked out at issue from the terms |
| `invoice.allowPartPayments` | boolean | yes |   |   |
| `invoice.remindersPaused` | boolean | yes |   |   |
| `invoice.money` | object or null |   |   | Once issued (invoice.get): its order's money |
| `invoice.money.paid` | number | yes |   |   |
| `invoice.money.credited` | number | yes |   | What credit notes took off what was owed |
| `invoice.money.refunded` | number | yes |   | What has gone back, confirmed or recorded |
| `invoice.money.balance` | number | yes |   | What is still owed: total less paid less credited |
| `invoice.money.owedBack` | number | yes |   | What credit notes give back that has not gone back yet, nor waits for approval |
| `invoice.money.orderState` | string | yes |   |   |

## invoice.settings.get

The invoice settings: the business's details and bank details as printed on documents, its tax rates (key, label, rate in hundredths of a percent, retired) and the default, whether amounts are typed with or without tax, payment terms, quote validity, deposit invoices' terms, the reminder schedule, the threshold over which a recorded payment tells the admins, the PDF footer, how long documents are kept, and each numbering series (prefix, next number, version). Read-only.

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
| `business` | object | yes |   |   |
| `business.legalName` | string or null | yes |   |   |
| `business.addressLines` | array of string | yes | at most 6 |   |
| `business.taxNumber` | string or null | yes |   |   |
| `business.taxNumberLabel` | string or null | yes |   | What the business's tax number is called on its documents |
| `bank` | array of object | yes | at most 8 |   |
| `bank[].label` | string | yes | min length 1, max length 60 |   |
| `bank[].value` | string | yes | min length 1, max length 120 |   |
| `taxRates` | array of object | yes | at most 20 |   |
| `taxRates[].key` | string | yes | pattern `^[a-z][a-z0-9_]{0,31}$` | Kept on every line that uses it; never reused for another rate |
| `taxRates[].label` | string | yes | min length 1, max length 60 | As printed: GST, VAT 20%, Exempt |
| `taxRates[].rate` | integer | yes | ≥ 0, ≤ 10000 | Hundredths of a percent: 1000 = 10% |
| `taxRates[].retired` | boolean | yes | default `false` | No new line may use it; documents keep it |
| `defaultTaxRate` | string or null | yes |   |   |
| `amountsIncludeTax` | boolean | yes |   | Whether staff type unit prices with tax (taken out) or without (added on top) |
| `paymentTermsDays` | integer | yes | ≥ 0, ≤ 365 |   |
| `quoteValidDays` | integer | yes | ≥ 1, ≤ 365 |   |
| `depositDueDays` | integer | yes | ≥ 0, ≤ 365 | 0: a deposit invoice is due on issue |
| `reminders` | object | yes |   |   |
| `reminders.on` | boolean | yes |   |   |
| `reminders.days` | array of integer | yes | at most 10 | Days from the due date: negative before it, 0 on it, positive after |
| `recordedPaymentNoticeOver` | integer | yes | ≥ 0, ≤ 10000000000 | A recorded payment over this (minor units) tells every admin; 0: every one |
| `pdfFooter` | string or null | yes |   |   |
| `retentionYears` | integer | yes | ≥ 1, ≤ 30 |   |
| `series` | array of object | yes |   |   |
| `series[].series` | `"quote"`, `"invoice"`, `"credit_note"` | yes |   |   |
| `series[].prefix` | string | yes |   |   |
| `series[].nextNumber` | number | yes |   |   |
| `series[].next` | string | yes |   | The next number as it will be printed |
| `series[].version` | number | yes |   | Pass it back to change the series |

## invoice.settings.update

Change the invoice settings: the business's details and bank details printed on documents, its tax rates (a rate never changes once saved: retire it and add a new key; a rate on any document is retired, never removed), the default rate, whether amounts are typed with or without tax, payment terms, quote validity, deposit invoices' terms, the reminder schedule (or reminders off), the threshold over which a recorded payment tells the admins, the PDF footer, how long documents are kept, and a numbering series' prefix and next number (only ever raised, naming the series' version). Only what is given changes. Documents already sent or issued keep what they were issued with. A change to the bank details is told to every admin. Admins only, and only a person: AI assistants, MCP clients, automations and extensions are refused.

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
| `business` | object |   |   |   |
| `business.legalName` | string or null | yes |   |   |
| `business.addressLines` | array of string | yes | at most 6 |   |
| `business.taxNumber` | string or null | yes |   |   |
| `business.taxNumberLabel` | string or null | yes |   | What the business's tax number is called on its documents |
| `bank` | array of object |   | at most 8 | Replaces the bank details |
| `bank[].label` | string | yes | min length 1, max length 60 |   |
| `bank[].value` | string | yes | min length 1, max length 120 |   |
| `taxRates` | array of object |   | at most 20 | Replaces the list of rates |
| `taxRates[].key` | string | yes | pattern `^[a-z][a-z0-9_]{0,31}$` | Kept on every line that uses it; never reused for another rate |
| `taxRates[].label` | string | yes | min length 1, max length 60 | As printed: GST, VAT 20%, Exempt |
| `taxRates[].rate` | integer | yes | ≥ 0, ≤ 10000 | Hundredths of a percent: 1000 = 10% |
| `taxRates[].retired` | boolean |   | default `false` | No new line may use it; documents keep it |
| `defaultTaxRate` | string or null |   |   |   |
| `amountsIncludeTax` | boolean |   |   |   |
| `paymentTermsDays` | integer |   | ≥ 0, ≤ 365 |   |
| `quoteValidDays` | integer |   | ≥ 1, ≤ 365 |   |
| `depositDueDays` | integer |   | ≥ 0, ≤ 365 | 0: a deposit invoice is due on issue |
| `reminders` | object |   |   |   |
| `reminders.on` | boolean | yes |   |   |
| `reminders.days` | array of integer | yes | at most 10 | Days from the due date: negative before it, 0 on it, positive after |
| `recordedPaymentNoticeOver` | integer |   | ≥ 0, ≤ 10000000000 | A recorded payment over this (minor units) tells every admin; 0: every one |
| `pdfFooter` | string or null |   |   |   |
| `retentionYears` | integer |   | ≥ 1, ≤ 30 |   |
| `series` | array of object |   | at most 3 |   |
| `series[].series` | `"quote"`, `"invoice"`, `"credit_note"` | yes |   |   |
| `series[].version` | integer | yes | ≥ 0, ≤ 9007199254740991 | The series' version from invoice.settings.get |
| `series[].prefix` | string |   | pattern `^[A-Za-z0-9\-/.]{0,12}$` | Printed before the number: INV-, Q-, CN- |
| `series[].nextNumber` | integer |   | ≥ 1, ≤ 99999999 | Only ever raised: to carry on from the numbers used before |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `business` | object | yes |   |   |
| `business.legalName` | string or null | yes |   |   |
| `business.addressLines` | array of string | yes | at most 6 |   |
| `business.taxNumber` | string or null | yes |   |   |
| `business.taxNumberLabel` | string or null | yes |   | What the business's tax number is called on its documents |
| `bank` | array of object | yes | at most 8 |   |
| `bank[].label` | string | yes | min length 1, max length 60 |   |
| `bank[].value` | string | yes | min length 1, max length 120 |   |
| `taxRates` | array of object | yes | at most 20 |   |
| `taxRates[].key` | string | yes | pattern `^[a-z][a-z0-9_]{0,31}$` | Kept on every line that uses it; never reused for another rate |
| `taxRates[].label` | string | yes | min length 1, max length 60 | As printed: GST, VAT 20%, Exempt |
| `taxRates[].rate` | integer | yes | ≥ 0, ≤ 10000 | Hundredths of a percent: 1000 = 10% |
| `taxRates[].retired` | boolean | yes | default `false` | No new line may use it; documents keep it |
| `defaultTaxRate` | string or null | yes |   |   |
| `amountsIncludeTax` | boolean | yes |   | Whether staff type unit prices with tax (taken out) or without (added on top) |
| `paymentTermsDays` | integer | yes | ≥ 0, ≤ 365 |   |
| `quoteValidDays` | integer | yes | ≥ 1, ≤ 365 |   |
| `depositDueDays` | integer | yes | ≥ 0, ≤ 365 | 0: a deposit invoice is due on issue |
| `reminders` | object | yes |   |   |
| `reminders.on` | boolean | yes |   |   |
| `reminders.days` | array of integer | yes | at most 10 | Days from the due date: negative before it, 0 on it, positive after |
| `recordedPaymentNoticeOver` | integer | yes | ≥ 0, ≤ 10000000000 | A recorded payment over this (minor units) tells every admin; 0: every one |
| `pdfFooter` | string or null | yes |   |   |
| `retentionYears` | integer | yes | ≥ 1, ≤ 30 |   |
| `series` | array of object | yes |   |   |
| `series[].series` | `"quote"`, `"invoice"`, `"credit_note"` | yes |   |   |
| `series[].prefix` | string | yes |   |   |
| `series[].nextNumber` | number | yes |   |   |
| `series[].next` | string | yes |   | The next number as it will be printed |
| `series[].version` | number | yes |   | Pass it back to change the series |

## invoice.update

Change a draft invoice: whom it is for, the site address, what it is about, title, notes, payment terms, the due date, or whether its amounts are typed with or without tax (its lines are priced again). Only what is given changes; null clears. An issued invoice is never changed: it is credited.

|  |  |
| --- | --- |
| Permission | `invoices:write` |
| Risk | `write` |
| Audiences | `staff` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes | min length 1, max length 64 | The invoice's id (inv_…) |
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
| `paymentTermsDays` | integer |   | ≥ 0, ≤ 365 |   |
| `dueOn` | string or null |   |   | Left empty: worked out at issue from the payment terms |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `state` | `"draft"`, `"issued"`, `"sent"`, `"part_paid"`, `"paid"`, `"credited"`, `"void"` | yes |   |   |
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
| `kind` | `"standard"`, `"deposit"`, `"final"` | yes |   |   |
| `quoteId` | string or null | yes |   |   |
| `orderId` | string or null | yes |   |   |
| `paymentTermsDays` | number | yes |   |   |
| `issuedOn` | string or null | yes |   |   |
| `dueOn` | string or null | yes |   | Set on a draft, or worked out at issue from the terms |
| `allowPartPayments` | boolean | yes |   |   |
| `remindersPaused` | boolean | yes |   |   |
| `money` | object or null |   |   | Once issued (invoice.get): its order's money |
| `money.paid` | number | yes |   |   |
| `money.credited` | number | yes |   | What credit notes took off what was owed |
| `money.refunded` | number | yes |   | What has gone back, confirmed or recorded |
| `money.balance` | number | yes |   | What is still owed: total less paid less credited |
| `money.owedBack` | number | yes |   | What credit notes give back that has not gone back yet, nor waits for approval |
| `money.orderState` | string | yes |   |   |

## invoice.updateLine

Change a line of a draft invoice: its description, quantity, unit, unit price (a typed line's only: a record's line keeps the host's price), tax rate, discount (null removes it) or position (the others move along). Only what is given changes. The host works out the line's tax and the invoice's totals again.

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
| `state` | `"draft"`, `"issued"`, `"sent"`, `"part_paid"`, `"paid"`, `"credited"`, `"void"` | yes |   |   |
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
| `kind` | `"standard"`, `"deposit"`, `"final"` | yes |   |   |
| `quoteId` | string or null | yes |   |   |
| `orderId` | string or null | yes |   |   |
| `paymentTermsDays` | number | yes |   |   |
| `issuedOn` | string or null | yes |   |   |
| `dueOn` | string or null | yes |   | Set on a draft, or worked out at issue from the terms |
| `allowPartPayments` | boolean | yes |   |   |
| `remindersPaused` | boolean | yes |   |   |
| `money` | object or null |   |   | Once issued (invoice.get): its order's money |
| `money.paid` | number | yes |   |   |
| `money.credited` | number | yes |   | What credit notes took off what was owed |
| `money.refunded` | number | yes |   | What has gone back, confirmed or recorded |
| `money.balance` | number | yes |   | What is still owed: total less paid less credited |
| `money.owedBack` | number | yes |   | What credit notes give back that has not gone back yet, nor waits for approval |
| `money.orderState` | string | yes |   |   |

## invoice.void

Void an issued invoice nothing has been paid on: a credit note for everything still owed on it, issued at once; the invoice is void, its order cancelled and its places given back. An invoice with something paid is credited instead (creditNote.create). A person only, with the permission to credit invoices: AI assistants are refused. Returns the credit note and the invoice.

|  |  |
| --- | --- |
| Permission | `invoices:credit` |
| Risk | `write` |
| Audiences | `staff` |
| Actors | `human` |
| Also | not offered to MCP clients (`mcp.expose: false`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes | min length 1, max length 64 | The invoice's id (inv_…) |
| `reason` | string | yes | min length 1, max length 500 | Why, as printed on the credit note |
| `version` | integer | yes | ≥ 0, ≤ 9007199254740991 | The version you read (from get): required, so what is approved is what was asked; one changed since is refused |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `number` | string or null | yes |   | Given when issued; null on a draft |
| `state` | `"draft"`, `"issued"` | yes |   |   |
| `invoiceId` | string | yes |   |   |
| `currency` | string | yes |   |   |
| `taxMode` | `"exclusive"`, `"inclusive"` | yes |   |   |
| `reason` | string or null | yes |   |   |
| `settle` | `"reduce"`, `"refund"`, `"both"` | yes |   | reduce: take it off what is still owed; refund: give it back from what was paid (nothing may be owed); both: take off what is owed first, then give back the rest |
| `lines` | array of object | yes |   |   |
| `lines[].id` | string | yes |   |   |
| `lines[].position` | number | yes |   |   |
| `lines[].description` | string | yes |   |   |
| `lines[].quantity` | number | yes |   |   |
| `lines[].unit` | string or null | yes |   |   |
| `lines[].unitPrice` | number | yes |   |   |
| `lines[].taxRate` | object or null | yes |   |   |
| `lines[].taxRate.key` | string | yes |   |   |
| `lines[].taxRate.label` | string | yes |   |   |
| `lines[].taxRate.rate` | number | yes |   |   |
| `lines[].net` | number | yes |   |   |
| `lines[].tax` | number | yes |   |   |
| `lines[].total` | number | yes |   |   |
| `lines[].creditsLineId` | string or null | yes |   | The invoice line it credits; null: an amount |
| `netTotal` | number | yes |   |   |
| `taxTotal` | number | yes |   |   |
| `total` | number | yes |   |   |
| `issuedOn` | string or null | yes |   |   |
| `refunds` | array of object | yes |   | What it gives back, per payment, and where each stands |
| `refunds[].paymentRef` | string | yes |   |   |
| `refunds[].method` | `"provider"`, `"recorded"` | yes |   |   |
| `refunds[].amount` | number | yes |   |   |
| `refunds[].refundId` | string or null | yes |   | The refund asked for (provider) or recorded (paid back); null: still owed |
| `refunds[].paidBackAt` | string or null | yes |   |   |
| `refunds[].attempt` | number | yes |   | 1, or how many times a provider's refund was asked for |
| `refunds[].why` | `"not_paid_back"`, `"rejected"`, `"expired"`, `"failed"`, `"unconfirmed"` or null | yes |   | Why an owed one is owed: not paid back yet (recorded), or the provider's refund was rejected, its approval expired, it failed when applied, or the provider has not confirmed it within five days |
| `refunds[].state` | `"given_back"`, `"asked"`, `"owed"` | yes |   | given_back: confirmed or recorded paid back; asked: waits for approval or the provider; owed: not given back (a person pays a recorded one back; a provider's rejected, expired or failed is asked for again with creditNote.askRefundAgain) |
| `owedBack` | number | yes |   | What it still owes back: not given back, nor waiting |
| `version` | number | yes |   |   |
| `createdAt` | string | yes |   |   |
| `invoice` | object | yes |   |   |
| `invoice.id` | string | yes |   |   |
| `invoice.state` | `"draft"`, `"issued"`, `"sent"`, `"part_paid"`, `"paid"`, `"credited"`, `"void"` | yes |   |   |
| `invoice.number` | string or null | yes |   | Given when sent or issued; null on a draft |
| `invoice.currency` | string | yes |   |   |
| `invoice.taxMode` | `"exclusive"`, `"inclusive"` | yes |   |   |
| `invoice.billTo` | object | yes |   |   |
| `invoice.billTo.personId` | string or null | yes |   |   |
| `invoice.billTo.organisationId` | string or null | yes |   |   |
| `invoice.billTo.printed` | object or null | yes |   | As printed, fixed when sent or issued |
| `invoice.billTo.printed.name` | string or null | yes |   |   |
| `invoice.billTo.printed.address` | string or null | yes |   |   |
| `invoice.billTo.printed.taxNumber` | string or null | yes |   |   |
| `invoice.billTo.printed.email` | string or null | yes |   |   |
| `invoice.siteAddress` | string or null | yes |   |   |
| `invoice.about` | object or null | yes |   |   |
| `invoice.about.object` | string | yes |   |   |
| `invoice.about.id` | string | yes |   |   |
| `invoice.title` | string or null | yes |   |   |
| `invoice.notes` | string or null | yes |   |   |
| `invoice.lines` | array of object | yes |   |   |
| `invoice.lines[].id` | string | yes |   |   |
| `invoice.lines[].position` | number | yes |   |   |
| `invoice.lines[].description` | string | yes |   |   |
| `invoice.lines[].quantity` | number | yes |   |   |
| `invoice.lines[].unit` | string or null | yes |   |   |
| `invoice.lines[].unitPrice` | number | yes |   | For one, in minor units, as the document's amounts are typed |
| `invoice.lines[].taxRate` | object or null | yes |   |   |
| `invoice.lines[].taxRate.key` | string | yes |   |   |
| `invoice.lines[].taxRate.label` | string | yes |   |   |
| `invoice.lines[].taxRate.rate` | number | yes |   |   |
| `invoice.lines[].discount` | object or null | yes |   |   |
| `invoice.lines[].discount.kind` | `"amount"`, `"percent"` | yes |   |   |
| `invoice.lines[].discount.value` | number | yes |   |   |
| `invoice.lines[].discount.reason` | string | yes |   |   |
| `invoice.lines[].discount.amount` | number | yes |   | What it took off, in minor units |
| `invoice.lines[].net` | number | yes |   |   |
| `invoice.lines[].tax` | number | yes |   |   |
| `invoice.lines[].total` | number | yes |   |   |
| `invoice.lines[].source` | `"record"`, `"custom"`, `"deduction"` | yes |   |   |
| `invoice.lines[].item` | object or null | yes |   |   |
| `invoice.lines[].item.object` | string | yes |   |   |
| `invoice.lines[].item.id` | string | yes |   |   |
| `invoice.netTotal` | number | yes |   |   |
| `invoice.taxTotal` | number | yes |   |   |
| `invoice.total` | number | yes |   |   |
| `invoice.taxByRate` | array of object | yes |   |   |
| `invoice.taxByRate[].key` | string | yes |   |   |
| `invoice.taxByRate[].label` | string | yes |   |   |
| `invoice.taxByRate[].rate` | number | yes |   |   |
| `invoice.taxByRate[].net` | number | yes |   |   |
| `invoice.taxByRate[].tax` | number | yes |   |   |
| `invoice.taxByRate[].total` | number | yes |   |   |
| `invoice.version` | number | yes |   | Moves with every write |
| `invoice.createdAt` | string | yes |   |   |
| `invoice.updatedAt` | string | yes |   |   |
| `invoice.kind` | `"standard"`, `"deposit"`, `"final"` | yes |   |   |
| `invoice.quoteId` | string or null | yes |   |   |
| `invoice.orderId` | string or null | yes |   |   |
| `invoice.paymentTermsDays` | number | yes |   |   |
| `invoice.issuedOn` | string or null | yes |   |   |
| `invoice.dueOn` | string or null | yes |   | Set on a draft, or worked out at issue from the terms |
| `invoice.allowPartPayments` | boolean | yes |   |   |
| `invoice.remindersPaused` | boolean | yes |   |   |
| `invoice.money` | object or null |   |   | Once issued (invoice.get): its order's money |
| `invoice.money.paid` | number | yes |   |   |
| `invoice.money.credited` | number | yes |   | What credit notes took off what was owed |
| `invoice.money.refunded` | number | yes |   | What has gone back, confirmed or recorded |
| `invoice.money.balance` | number | yes |   | What is still owed: total less paid less credited |
| `invoice.money.owedBack` | number | yes |   | What credit notes give back that has not gone back yet, nor waits for approval |
| `invoice.money.orderState` | string | yes |   |   |
| `pending` | array of string | yes |   | The refunds waiting in Approvals for a person with the refund permission |
