---
title: "today.* operations"
description: "The core operations named today.*"
sidebar:
  label: "today"
editUrl: false
---

## today.get

Today at a glance, for the business's current local day in its own time zone: the items you may see, attention first, each with its key, label, value (a count, a percent, or money in the currency's minor unit), a comparison with the same time yesterday or last week, whether it needs attention, and what it opens. Items include takings (for those who may read the finance reports), the changes waiting for your approval, shifts with nobody on them and checklists missed (for those who roster), unread notices, and the numbers installed packs add (such as classes today and who came). An assistant or MCP client gets only the packs' items and the money its user may see. today.rows gives an item's rows. Read-only.

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
| `day` | string | yes |   | The business's local date, YYYY-MM-DD |
| `zone` | string | yes |   | The business's time zone |
| `items` | array of object | yes |   |   |
| `items[].key` | string | yes |   | host.&lt;item&gt; for the host's own, &lt;pack&gt;.&lt;item&gt; for a pack's; pass to today.rows |
| `items[].label` | string | yes |   |   |
| `items[].format` | `"count"`, `"percent"`, `"money"` | yes |   | money only for the host's own figures, in the currency's minor unit |
| `items[].value` | number | yes |   |   |
| `items[].currency` | string or null | yes |   |   |
| `items[].detail` | string or null | yes |   | A second line, such as how many payments |
| `items[].compare` | object or null | yes |   | The same figure at the same local time yesterday or a week ago |
| `items[].compare.against` | `"yesterday"`, `"lastWeek"` | yes |   |   |
| `items[].compare.value` | number | yes |   |   |
| `items[].state` | `"ok"`, `"attention"` | yes |   |   |
| `items[].target` | object | yes |   |   |

## today.rows

The rows behind one item of today.get (its key), at most 50: for each a name, a second line and the record it opens, if any. Only an item today.get gives you: any other key is not found. Names and record ids only, never notes, health answers, pay or leave. A look at a money item's rows is audited. Read-only.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `read` |
| Audiences | `staff` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `key` | string | yes | min length 1, max length 120 |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `items` | array of object | yes |   |   |
| `items[].label` | string | yes |   |   |
| `items[].detail` | string or null | yes |   |   |
| `items[].record` | object or null | yes |   |   |
| `items[].record.object` | string | yes |   |   |
| `items[].record.id` | string | yes |   |   |
