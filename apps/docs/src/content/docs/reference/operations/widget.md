---
title: "widget.* operations"
description: "The core operations named widget.*"
sidebar:
  label: "widget"
editUrl: false
---

## widget.describe

Turn a plain-language description ("tasks by status as a bar chart") into a widget spec with the `build` model role, then validate and preview it. Nothing is saved. Says the AI is not configured when the deployment has no model.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `read` |
| Audiences | `staff` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `prompt` | string | yes | min length 3, max length 4000 |   |
| `dashboardFilters` | array of object |   | at most 8, default `[]` |   |
| `filters` | map of `"all_time"`, `"today"`, `"last_7_days"`, `"last_30_days"`, `"last_90_days"`, `"last_365_days"`, `"this_month"`, `"last_month"`, `"this_quarter"`, `"this_year"` or object or string or null |   | default `{}` | Dashboard filter values by filter id: a date preset or { from, to } (YYYY-MM-DD, inclusive) for dateRange filters, a user id / 'me' / null for user filters, a value or null otherwise |

### Output

No fields.

## widget.preview

Run a widget spec without saving it, to check its SQL and see its rows: the same guards, params, limits and cache as a saved widget. Pass the dashboard's filter definitions (`dashboardFilters`) so their params bind, and `filters` for their values. Read-only.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `read` |
| Audiences | `staff` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `widget` | object | yes |   |   |
| `widget.id` | string | yes | pattern `^[a-z0-9][a-z0-9_-]{0,40}$` | Stable id within the dashboard, e.g. people-added |
| `widget.type` | `"kpi"`, `"bar"`, `"line"`, `"donut"`, `"funnel"`, `"table"`, `"leaderboard"`, `"markdown"` | yes |   |   |
| `widget.title` | string | yes | min length 1, max length 200 |   |
| `widget.description` | string or null |   |   |   |
| `widget.sql` | string or null |   |   | Data widgets: one read-only SELECT over rec_* views. Use named params for filters (:date_from, :date_to, :owner, …) and the system params :now, :today and :me |
| `widget.markdown` | string or null |   |   | Markdown widgets: the text |
| `widget.mapping` | object |   | default `{}` |   |
| `widget.mapping.x` | string |   | max length 80 | Category or time column (bar, line, funnel) |
| `widget.mapping.y` | string or array of string |   |   | Value column(s) (bar, line) |
| `widget.mapping.series` | string |   | max length 80 | A column whose values split rows into series (long format, bar/line) |
| `widget.mapping.label` | string |   | max length 80 | Segment or row label column (donut, leaderboard) |
| `widget.mapping.value` | string |   | max length 80 | Value column (kpi, donut, funnel, leaderboard) |
| `widget.mapping.columns` | array of string |   | at most 20 | Columns shown (table) |
| `widget.options` | object |   | default `{}` |   |
| `widget.options.orientation` | `"vertical"`, `"horizontal"` |   |   | bar: columns or bars |
| `widget.options.stacked` | boolean |   |   |   |
| `widget.options.area` | boolean |   |   | line: fill as an area chart |
| `widget.options.pie` | boolean |   |   | donut: a full pie instead of a ring |
| `widget.options.format` | `"number"`, `"currency"`, `"percent"` |   |   |   |
| `widget.options.currency` | string |   | pattern `^[A-Z]{3}$` |   |
| `widget.options.compare` | boolean |   |   | kpi: compare with the previous period of the date filter (default true) |
| `widget.options.limit` | integer |   | ≥ 1, ≤ 100 | table/leaderboard: top N rows |
| `widget.clickThrough` | object or null |   |   |   |
| `widget.clickThrough.object` | string | yes | min length 1, max length 80 | The object whose list opens |
| `widget.clickThrough.objectColumn` | string or null |   |   | A result column naming the object per row, when rows mix objects |
| `widget.clickThrough.filter` | any or null |   |   |   |
| `widget.layout` | object |   | default `{"w":6,"h":2}` |   |
| `widget.layout.w` | integer |   | ≥ 1, ≤ 12, default `6` | Width in grid columns (of 12) |
| `widget.layout.h` | integer |   | ≥ 1, ≤ 8, default `2` | Height in grid rows (about 9rem each) |
| `dashboardFilters` | array of object |   | at most 8, default `[]` |   |
| `filters` | map of `"all_time"`, `"today"`, `"last_7_days"`, `"last_30_days"`, `"last_90_days"`, `"last_365_days"`, `"this_month"`, `"last_month"`, `"this_quarter"`, `"this_year"` or object or string or null |   | default `{}` | Dashboard filter values by filter id: a date preset or { from, to } (YYYY-MM-DD, inclusive) for dateRange filters, a user id / 'me' / null for user filters, a value or null otherwise |
| `recordId` | string or null |   |   | On a record tab: the record's id, bound to :record_id |
| `refresh` | boolean |   | default `false` |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `widgetId` | string | yes |   |   |
| `columns` | array of string | yes |   |   |
| `rows` | array of map of any | yes |   |   |
| `rowCount` | number | yes |   |   |
| `truncated` | boolean | yes |   |   |
| `cached` | boolean | yes |   | Served from the 60 s result cache |
| `cachedAt` | string | yes |   | When the rows were read |
| `params` | map of string or number or null | yes |   | The named parameters bound (for click-through $param placeholders) |
| `previous` | object or null | yes |   | KPI widgets: the same query over the previous period |
| `previous.rows` | array of map of any | yes |   |   |
| `previous.params` | map of string or number or null | yes |   |   |
| `views` | array of string | yes |   |   |

## widget.run

Run one widget of a dashboard you can open with its filters set to `filters` (defaults apply to filters left out) and return its rows. Results are cached for 60 seconds per query and params; refresh: true reads fresh data. KPI widgets also return the previous period. Read-only.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `read` |
| Audiences | `staff` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `dashboardId` | string | yes | min length 1, max length 64 | Dashboard id (dsh_…) |
| `widgetId` | string | yes | min length 1, max length 64 |   |
| `filters` | map of `"all_time"`, `"today"`, `"last_7_days"`, `"last_30_days"`, `"last_90_days"`, `"last_365_days"`, `"this_month"`, `"last_month"`, `"this_quarter"`, `"this_year"` or object or string or null |   | default `{}` | Dashboard filter values by filter id: a date preset or { from, to } (YYYY-MM-DD, inclusive) for dateRange filters, a user id / 'me' / null for user filters, a value or null otherwise |
| `recordId` | string or null |   |   | On a record tab: the record's id, bound to :record_id |
| `refresh` | boolean |   | default `false` |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `widgetId` | string | yes |   |   |
| `columns` | array of string | yes |   |   |
| `rows` | array of map of any | yes |   |   |
| `rowCount` | number | yes |   |   |
| `truncated` | boolean | yes |   |   |
| `cached` | boolean | yes |   | Served from the 60 s result cache |
| `cachedAt` | string | yes |   | When the rows were read |
| `params` | map of string or number or null | yes |   | The named parameters bound (for click-through $param placeholders) |
| `previous` | object or null | yes |   | KPI widgets: the same query over the previous period |
| `previous.rows` | array of map of any | yes |   |   |
| `previous.params` | map of string or number or null | yes |   |   |
| `views` | array of string | yes |   |   |
