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
