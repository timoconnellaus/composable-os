---
title: "finance.* operations"
description: "The core operations named finance.*"
sidebar:
  label: "finance"
editUrl: false
---

## finance.close

Close a month's finance figures: its book entries and report rows are written as the host's figures stand now and never change. A month is closed once it has ended and the month before it is closed; closing a reopened month writes its next version and keeps the old. Payments and refunds that arrive later are never refused: they are counted in the first open month, marked as belonging to this one. A person only, with finance:close. Refused when anything it read changed meanwhile (try again).

|  |  |
| --- | --- |
| Permission | `finance:close` |
| Risk | `write` |
| Audiences | `staff` |
| Actors | `human` |
| Also | not offered to MCP clients (`mcp.expose: false`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `month` | string | yes | pattern `^\d{4}-(0[1-9]\|1[0-2])$` | The month, YYYY-MM |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `month` | string | yes |   |   |
| `version` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |
| `entries` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |

## finance.entries

A closed month's book entries and their lines, the figures for the books (what Accounting sync reads): one day summary per business day money moved, and late entries for what arrived for a closed month. Each entry has a key that is the same in every version, a fingerprint of its lines, and lines with a heading, a side (debit or credit) and an amount in minor units; its debits equal its credits. Only closed versions (a preview has none). Paged: pass `next` as `after`. Needs finance:read.

|  |  |
| --- | --- |
| Permission | `finance:read` |
| Risk | `read` |
| Audiences | `staff` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `month` | string | yes | pattern `^\d{4}-(0[1-9]\|1[0-2])$` | The month, YYYY-MM |
| `version` | integer |   | ≥ 1, ≤ 9007199254740991 | Left out: the latest closed version |
| `after` | integer |   | ≥ 0, ≤ 9007199254740991 | The `next` of the page before |
| `limit` | integer |   | ≥ 1, ≤ 200 |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `month` | string | yes |   |   |
| `version` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |
| `state` | `"closed"`, `"reopened"` | yes |   |   |
| `closedAt` | string | yes |   |   |
| `entries` | array of object | yes |   |   |
| `entries[].n` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |
| `entries[].key` | string | yes |   |   |
| `entries[].kind` | string | yes |   |   |
| `entries[].date` | string | yes |   |   |
| `entries[].period` | string | yes |   |   |
| `entries[].version` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |
| `entries[].belongsTo` | string or null | yes |   |   |
| `entries[].fingerprint` | string | yes |   |   |
| `entries[].lines` | array of object | yes |   |   |
| `entries[].lines[].heading` | string | yes |   |   |
| `entries[].lines[].side` | string | yes |   |   |
| `entries[].lines[].amount` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |
| `entries[].lines[].taxCode` | string or null | yes |   |   |
| `entries[].lines[].taxCountry` | string or null | yes |   |   |
| `entries[].lines[].method` | string or null | yes |   |   |
| `entries[].lines[].category` | string or null | yes |   |   |
| `next` | integer or null | yes |   |   |

## finance.export

Download one finance report as a CSV file for the business's accountant: a closed version's (the same every time), or a preview of an open month or a span of days, marked so on its first row. Amounts in minor units with a decimal column beside them. A person only, with finance:read; audited without its figures.

|  |  |
| --- | --- |
| Permission | `finance:read` |
| Risk | `read` |
| Audiences | `staff` |
| Actors | `human` |
| Also | not offered to MCP clients (`mcp.expose: false`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `report` | `"sales"`, `"tax"`, `"refunds"` | yes |   | sales (by kind of sale and item, and by day), tax (by code and country) or refunds |
| `month` | string |   | pattern `^\d{4}-(0[1-9]\|1[0-2])$` | A month: its closed version, or a preview while it is open |
| `version` | integer |   | ≥ 1, ≤ 9007199254740991 | A month's closed (or since reopened) version; left out, its latest closed one |
| `start` | string |   | pattern `^\d{4}-\d{2}-\d{2}$` | A span of days to preview instead of a month: its first |
| `end` | string |   | pattern `^\d{4}-\d{2}-\d{2}$` | The span's last day, included (at most 366 days) |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `filename` | string | yes |   |   |
| `contentType` | `"text/csv"` | yes |   |   |
| `csv` | string | yes |   |   |
| `preview` | boolean | yes |   |   |
| `version` | integer or null | yes |   |   |

## finance.periods

List the business's finance months: the current month and up to 24 before it (none before the first month finance counts), each with its local dates and zone, whether it is open or closed, whether it has ended and can be closed now, and its versions (who closed it and when; who reopened it). States and versions only, no figures. Needs finance:read.

|  |  |
| --- | --- |
| Permission | `finance:read` |
| Risk | `read` |
| Audiences | `staff` |

### Input

No fields.

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `zone` | string | yes |   |   |
| `firstMonth` | string | yes |   |   |
| `currentMonth` | string | yes |   |   |
| `periods` | array of object | yes |   |   |
| `periods[].month` | string | yes |   |   |
| `periods[].start` | string | yes |   |   |
| `periods[].end` | string | yes |   |   |
| `periods[].zone` | string | yes |   |   |
| `periods[].state` | `"open"`, `"closed"` | yes |   | closed: its latest version is closed |
| `periods[].ended` | boolean | yes |   |   |
| `periods[].closable` | boolean | yes |   | It has ended, is open, and the month before it is closed |
| `periods[].versions` | array of object | yes |   |   |
| `periods[].versions[].id` | string | yes |   |   |
| `periods[].versions[].version` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |
| `periods[].versions[].state` | `"closed"`, `"reopened"` | yes |   |   |
| `periods[].versions[].closedBy` | string | yes |   |   |
| `periods[].versions[].closedByName` | string or null | yes |   |   |
| `periods[].versions[].closedAt` | string | yes |   |   |
| `periods[].versions[].entries` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |
| `periods[].versions[].reopenedBy` | string or null | yes |   |   |
| `periods[].versions[].reopenedByName` | string or null | yes |   |   |
| `periods[].versions[].reopenedAt` | string or null | yes |   |   |

## finance.reopen

Reopen a closed month, with why: its closed version and files are kept as they were, and closing it again writes the next version. Every later closed month must be reopened first. A person only, with finance:close.

|  |  |
| --- | --- |
| Permission | `finance:close` |
| Risk | `write` |
| Audiences | `staff` |
| Actors | `human` |
| Also | not offered to MCP clients (`mcp.expose: false`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `month` | string | yes | pattern `^\d{4}-(0[1-9]\|1[0-2])$` | The month, YYYY-MM |
| `reason` | string | yes | min length 1, max length 500 |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `month` | string | yes |   |   |
| `version` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |

## finance.report

One finance report for a month (its closed version as it was closed, or a preview while it is open) or a preview of any span of days: sales (per kind of sale and item, and by day: sold, discounts, refunded, net, the tax inside and net of tax), tax (per tax code and country, refunds' tax as reported or estimated, untaxed sales beside) or refunds (each refund confirmed: date, order, items, amount, tax given back, who asked and approved, the customer's name). Amounts are integers in the currency's minor units, on the business's days in its own time zone. Each row lists the orders it came from. Needs finance:read.

|  |  |
| --- | --- |
| Permission | `finance:read` |
| Risk | `read` |
| Audiences | `staff` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `report` | `"sales"`, `"tax"`, `"refunds"` | yes |   | sales (by kind of sale and item, and by day), tax (by code and country) or refunds |
| `month` | string |   | pattern `^\d{4}-(0[1-9]\|1[0-2])$` | A month: its closed version, or a preview while it is open |
| `version` | integer |   | ≥ 1, ≤ 9007199254740991 | A month's closed (or since reopened) version; left out, its latest closed one |
| `start` | string |   | pattern `^\d{4}-\d{2}-\d{2}$` | A span of days to preview instead of a month: its first |
| `end` | string |   | pattern `^\d{4}-\d{2}-\d{2}$` | The span's last day, included (at most 366 days) |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `report` | `"sales"`, `"tax"`, `"refunds"` | yes |   |   |
| `month` | string or null | yes |   |   |
| `start` | string | yes |   |   |
| `end` | string | yes |   |   |
| `zone` | string | yes |   |   |
| `preview` | boolean | yes |   | Worked out now, not closed: it may still change |
| `version` | integer or null | yes |   |   |
| `reopened` | boolean | yes |   |   |
| `closedAt` | string or null | yes |   |   |
| `closedByName` | string or null | yes |   |   |
| `currency` | string or null | yes |   |   |
| `notes` | array of string | yes |   |   |
| `rows` | array of map of any | yes |   |   |
| `totals` | map of number | yes |   |   |

## finance.settings.get

Read the finance settings: the financial year's first month (1 to 12, used only to add months into a year), the first month finance counts (the month it was installed unless an admin picked an earlier one), and the labels given to sales categories. Needs finance:read.

|  |  |
| --- | --- |
| Permission | `finance:read` |
| Risk | `read` |
| Audiences | `staff` |

### Input

No fields.

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `yearStartMonth` | integer | yes | ≥ 1, ≤ 12 |   |
| `firstPeriod` | string or null | yes |   |   |
| `categoryLabels` | map of string | yes |   |   |
| `firstMonth` | string | yes |   |   |

## finance.settings.update

Change the finance settings: the financial year's first month, an earlier first month to count from (only before any month is closed), and labels for sales categories (a category key to its label; an empty label removes it). Leave a setting out to keep it. A human admin in the app only.

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
| `yearStartMonth` | integer |   | ≥ 1, ≤ 12 |   |
| `firstPeriod` | string or null |   |   | Null: the month finance was installed |
| `categoryLabels` | map of string |   |   |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `yearStartMonth` | integer | yes | ≥ 1, ≤ 12 |   |
| `firstPeriod` | string or null | yes |   |   |
| `categoryLabels` | map of string | yes |   |   |
