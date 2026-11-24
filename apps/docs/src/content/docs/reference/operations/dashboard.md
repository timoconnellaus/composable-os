---
title: "dashboard.* operations"
description: "The core operations named dashboard.*"
sidebar:
  label: "dashboard"
editUrl: false
---

## dashboard.create

Create a dashboard: a title, filters and widgets. Each data widget has read-only SQL over the rec_* views (checked like query.sql) using named params from the filters (:date_from, :date_to, :owner, …) and :now, :today, :me; a chart mapping; and optionally a click-through { object, filter } whose filter values may be { $row } or { $param } placeholders. Personal by default; shared: true makes it visible to every member. copyFrom copies another dashboard's filters and widgets (e.g. the Overview). Try widgets with widget.preview first. Returns the dashboard.

|  |  |
| --- | --- |
| Permission | `records:write` |
| Risk | `write` |
| Audiences | `staff` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `title` | string | yes | min length 1, max length 200 |   |
| `description` | string or null |   |   |   |
| `shared` | boolean |   | default `false` |   |
| `copyFrom` | string |   | min length 1, max length 64 | Copy this dashboard's filters and widgets |
| `filters` | array of object |   | at most 8 | Dashboard filters, each bound to named SQL params: dateRange `date` → :date_from/:date_to, user `owner` → :owner, select/field/text `x` → :x |
| `widgets` | array of object |   | at most 30 | Widgets in layout order |
| `widgets[].id` | string | yes | pattern `^[a-z0-9][a-z0-9_-]{0,40}$` | Stable id within the dashboard, e.g. people-added |
| `widgets[].type` | `"kpi"`, `"bar"`, `"line"`, `"donut"`, `"funnel"`, `"table"`, `"leaderboard"`, `"markdown"` | yes |   |   |
| `widgets[].title` | string | yes | min length 1, max length 200 |   |
| `widgets[].description` | string or null |   |   |   |
| `widgets[].sql` | string or null |   |   | Data widgets: one read-only SELECT over rec_* views. Use named params for filters (:date_from, :date_to, :owner, …) and the system params :now, :today and :me |
| `widgets[].markdown` | string or null |   |   | Markdown widgets: the text |
| `widgets[].mapping` | object |   | default `{}` |   |
| `widgets[].mapping.x` | string |   | max length 80 | Category or time column (bar, line, funnel) |
| `widgets[].mapping.y` | string or array of string |   |   | Value column(s) (bar, line) |
| `widgets[].mapping.series` | string |   | max length 80 | A column whose values split rows into series (long format, bar/line) |
| `widgets[].mapping.label` | string |   | max length 80 | Segment or row label column (donut, leaderboard) |
| `widgets[].mapping.value` | string |   | max length 80 | Value column (kpi, donut, funnel, leaderboard) |
| `widgets[].mapping.columns` | array of string |   | at most 20 | Columns shown (table) |
| `widgets[].options` | object |   | default `{}` |   |
| `widgets[].options.orientation` | `"vertical"`, `"horizontal"` |   |   | bar: columns or bars |
| `widgets[].options.stacked` | boolean |   |   |   |
| `widgets[].options.area` | boolean |   |   | line: fill as an area chart |
| `widgets[].options.pie` | boolean |   |   | donut: a full pie instead of a ring |
| `widgets[].options.format` | `"number"`, `"currency"`, `"percent"` |   |   |   |
| `widgets[].options.currency` | string |   | pattern `^[A-Z]{3}$` |   |
| `widgets[].options.compare` | boolean |   |   | kpi: compare with the previous period of the date filter (default true) |
| `widgets[].options.limit` | integer |   | ≥ 1, ≤ 100 | table/leaderboard: top N rows |
| `widgets[].clickThrough` | object or null |   |   |   |
| `widgets[].clickThrough.object` | string | yes | min length 1, max length 80 | The object whose list opens |
| `widgets[].clickThrough.objectColumn` | string or null |   |   | A result column naming the object per row, when rows mix objects |
| `widgets[].clickThrough.filter` | any or null |   |   |   |
| `widgets[].layout` | object |   | default `{"w":6,"h":2}` |   |
| `widgets[].layout.w` | integer |   | ≥ 1, ≤ 12, default `6` | Width in grid columns (of 12) |
| `widgets[].layout.h` | integer |   | ≥ 1, ≤ 8, default `2` | Height in grid rows (about 9rem each) |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `title` | string | yes |   |   |
| `description` | string or null | yes |   |   |
| `shared` | boolean | yes |   |   |
| `ownerId` | string or null | yes |   |   |
| `builtIn` | boolean | yes |   |   |
| `canEdit` | boolean | yes |   |   |
| `isHome` | boolean | yes |   |   |
| `filters` | array of object | yes |   |   |
| `widgets` | array of object | yes |   |   |
| `widgets[].id` | string | yes | pattern `^[a-z0-9][a-z0-9_-]{0,40}$` | Stable id within the dashboard, e.g. people-added |
| `widgets[].type` | `"kpi"`, `"bar"`, `"line"`, `"donut"`, `"funnel"`, `"table"`, `"leaderboard"`, `"markdown"` | yes |   |   |
| `widgets[].title` | string | yes | min length 1, max length 200 |   |
| `widgets[].description` | string or null |   |   |   |
| `widgets[].sql` | string or null |   |   | Data widgets: one read-only SELECT over rec_* views. Use named params for filters (:date_from, :date_to, :owner, …) and the system params :now, :today and :me |
| `widgets[].markdown` | string or null |   |   | Markdown widgets: the text |
| `widgets[].mapping` | object | yes | default `{}` |   |
| `widgets[].mapping.x` | string |   | max length 80 | Category or time column (bar, line, funnel) |
| `widgets[].mapping.y` | string or array of string |   |   | Value column(s) (bar, line) |
| `widgets[].mapping.series` | string |   | max length 80 | A column whose values split rows into series (long format, bar/line) |
| `widgets[].mapping.label` | string |   | max length 80 | Segment or row label column (donut, leaderboard) |
| `widgets[].mapping.value` | string |   | max length 80 | Value column (kpi, donut, funnel, leaderboard) |
| `widgets[].mapping.columns` | array of string |   | at most 20 | Columns shown (table) |
| `widgets[].options` | object | yes | default `{}` |   |
| `widgets[].options.orientation` | `"vertical"`, `"horizontal"` |   |   | bar: columns or bars |
| `widgets[].options.stacked` | boolean |   |   |   |
| `widgets[].options.area` | boolean |   |   | line: fill as an area chart |
| `widgets[].options.pie` | boolean |   |   | donut: a full pie instead of a ring |
| `widgets[].options.format` | `"number"`, `"currency"`, `"percent"` |   |   |   |
| `widgets[].options.currency` | string |   | pattern `^[A-Z]{3}$` |   |
| `widgets[].options.compare` | boolean |   |   | kpi: compare with the previous period of the date filter (default true) |
| `widgets[].options.limit` | integer |   | ≥ 1, ≤ 100 | table/leaderboard: top N rows |
| `widgets[].clickThrough` | object or null |   |   |   |
| `widgets[].clickThrough.object` | string | yes | min length 1, max length 80 | The object whose list opens |
| `widgets[].clickThrough.objectColumn` | string or null |   |   | A result column naming the object per row, when rows mix objects |
| `widgets[].clickThrough.filter` | any or null |   |   |   |
| `widgets[].layout` | object | yes | default `{"w":6,"h":2}` |   |
| `widgets[].layout.w` | integer | yes | ≥ 1, ≤ 12, default `6` | Width in grid columns (of 12) |
| `widgets[].layout.h` | integer | yes | ≥ 1, ≤ 8, default `2` | Height in grid rows (about 9rem each) |
| `createdAt` | string or null | yes |   |   |
| `updatedAt` | string or null | yes |   |   |

## dashboard.delete

Delete a dashboard you own (or, as an admin, a shared one). Only the dashboard goes; no records are touched. Anyone whose Home it was gets the Overview again. Cannot be undone.

|  |  |
| --- | --- |
| Permission | `records:write` |
| Risk | `write` |
| Audiences | `staff` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes | min length 1, max length 64 | Dashboard id (dsh_…) |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `deleted` | `true` | yes |   |   |

## dashboard.get

Get one dashboard you can open, with its filters and widgets (SQL, chart mapping, click-through and layout). Read-only.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `read` |
| Audiences | `staff` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes | min length 1, max length 64 | Dashboard id (dsh_…) |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `title` | string | yes |   |   |
| `description` | string or null | yes |   |   |
| `shared` | boolean | yes |   |   |
| `ownerId` | string or null | yes |   |   |
| `builtIn` | boolean | yes |   |   |
| `canEdit` | boolean | yes |   |   |
| `isHome` | boolean | yes |   |   |
| `filters` | array of object | yes |   |   |
| `widgets` | array of object | yes |   |   |
| `widgets[].id` | string | yes | pattern `^[a-z0-9][a-z0-9_-]{0,40}$` | Stable id within the dashboard, e.g. people-added |
| `widgets[].type` | `"kpi"`, `"bar"`, `"line"`, `"donut"`, `"funnel"`, `"table"`, `"leaderboard"`, `"markdown"` | yes |   |   |
| `widgets[].title` | string | yes | min length 1, max length 200 |   |
| `widgets[].description` | string or null |   |   |   |
| `widgets[].sql` | string or null |   |   | Data widgets: one read-only SELECT over rec_* views. Use named params for filters (:date_from, :date_to, :owner, …) and the system params :now, :today and :me |
| `widgets[].markdown` | string or null |   |   | Markdown widgets: the text |
| `widgets[].mapping` | object | yes | default `{}` |   |
| `widgets[].mapping.x` | string |   | max length 80 | Category or time column (bar, line, funnel) |
| `widgets[].mapping.y` | string or array of string |   |   | Value column(s) (bar, line) |
| `widgets[].mapping.series` | string |   | max length 80 | A column whose values split rows into series (long format, bar/line) |
| `widgets[].mapping.label` | string |   | max length 80 | Segment or row label column (donut, leaderboard) |
| `widgets[].mapping.value` | string |   | max length 80 | Value column (kpi, donut, funnel, leaderboard) |
| `widgets[].mapping.columns` | array of string |   | at most 20 | Columns shown (table) |
| `widgets[].options` | object | yes | default `{}` |   |
| `widgets[].options.orientation` | `"vertical"`, `"horizontal"` |   |   | bar: columns or bars |
| `widgets[].options.stacked` | boolean |   |   |   |
| `widgets[].options.area` | boolean |   |   | line: fill as an area chart |
| `widgets[].options.pie` | boolean |   |   | donut: a full pie instead of a ring |
| `widgets[].options.format` | `"number"`, `"currency"`, `"percent"` |   |   |   |
| `widgets[].options.currency` | string |   | pattern `^[A-Z]{3}$` |   |
| `widgets[].options.compare` | boolean |   |   | kpi: compare with the previous period of the date filter (default true) |
| `widgets[].options.limit` | integer |   | ≥ 1, ≤ 100 | table/leaderboard: top N rows |
| `widgets[].clickThrough` | object or null |   |   |   |
| `widgets[].clickThrough.object` | string | yes | min length 1, max length 80 | The object whose list opens |
| `widgets[].clickThrough.objectColumn` | string or null |   |   | A result column naming the object per row, when rows mix objects |
| `widgets[].clickThrough.filter` | any or null |   |   |   |
| `widgets[].layout` | object | yes | default `{"w":6,"h":2}` |   |
| `widgets[].layout.w` | integer | yes | ≥ 1, ≤ 12, default `6` | Width in grid columns (of 12) |
| `widgets[].layout.h` | integer | yes | ≥ 1, ≤ 8, default `2` | Height in grid rows (about 9rem each) |
| `createdAt` | string or null | yes |   |   |
| `updatedAt` | string or null | yes |   |   |

## dashboard.home

Get your Home dashboard (the one shown at /): the one you set with dashboard.setHome, or the default: an installed extension's home dashboard (Sales overview with Deals), else the shipped Overview. Read-only.

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
| `id` | string | yes |   |   |
| `title` | string | yes |   |   |
| `description` | string or null | yes |   |   |
| `shared` | boolean | yes |   |   |
| `ownerId` | string or null | yes |   |   |
| `builtIn` | boolean | yes |   |   |
| `canEdit` | boolean | yes |   |   |
| `isHome` | boolean | yes |   |   |
| `filters` | array of object | yes |   |   |
| `widgets` | array of object | yes |   |   |
| `widgets[].id` | string | yes | pattern `^[a-z0-9][a-z0-9_-]{0,40}$` | Stable id within the dashboard, e.g. people-added |
| `widgets[].type` | `"kpi"`, `"bar"`, `"line"`, `"donut"`, `"funnel"`, `"table"`, `"leaderboard"`, `"markdown"` | yes |   |   |
| `widgets[].title` | string | yes | min length 1, max length 200 |   |
| `widgets[].description` | string or null |   |   |   |
| `widgets[].sql` | string or null |   |   | Data widgets: one read-only SELECT over rec_* views. Use named params for filters (:date_from, :date_to, :owner, …) and the system params :now, :today and :me |
| `widgets[].markdown` | string or null |   |   | Markdown widgets: the text |
| `widgets[].mapping` | object | yes | default `{}` |   |
| `widgets[].mapping.x` | string |   | max length 80 | Category or time column (bar, line, funnel) |
| `widgets[].mapping.y` | string or array of string |   |   | Value column(s) (bar, line) |
| `widgets[].mapping.series` | string |   | max length 80 | A column whose values split rows into series (long format, bar/line) |
| `widgets[].mapping.label` | string |   | max length 80 | Segment or row label column (donut, leaderboard) |
| `widgets[].mapping.value` | string |   | max length 80 | Value column (kpi, donut, funnel, leaderboard) |
| `widgets[].mapping.columns` | array of string |   | at most 20 | Columns shown (table) |
| `widgets[].options` | object | yes | default `{}` |   |
| `widgets[].options.orientation` | `"vertical"`, `"horizontal"` |   |   | bar: columns or bars |
| `widgets[].options.stacked` | boolean |   |   |   |
| `widgets[].options.area` | boolean |   |   | line: fill as an area chart |
| `widgets[].options.pie` | boolean |   |   | donut: a full pie instead of a ring |
| `widgets[].options.format` | `"number"`, `"currency"`, `"percent"` |   |   |   |
| `widgets[].options.currency` | string |   | pattern `^[A-Z]{3}$` |   |
| `widgets[].options.compare` | boolean |   |   | kpi: compare with the previous period of the date filter (default true) |
| `widgets[].options.limit` | integer |   | ≥ 1, ≤ 100 | table/leaderboard: top N rows |
| `widgets[].clickThrough` | object or null |   |   |   |
| `widgets[].clickThrough.object` | string | yes | min length 1, max length 80 | The object whose list opens |
| `widgets[].clickThrough.objectColumn` | string or null |   |   | A result column naming the object per row, when rows mix objects |
| `widgets[].clickThrough.filter` | any or null |   |   |   |
| `widgets[].layout` | object | yes | default `{"w":6,"h":2}` |   |
| `widgets[].layout.w` | integer | yes | ≥ 1, ≤ 12, default `6` | Width in grid columns (of 12) |
| `widgets[].layout.h` | integer | yes | ≥ 1, ≤ 8, default `2` | Height in grid rows (about 9rem each) |
| `createdAt` | string or null | yes |   |   |
| `updatedAt` | string or null | yes |   |   |

## dashboard.list

List the dashboards you can open: the shipped ones (the Overview and those installed extensions ship, e.g. Deals' Sales overview), every shared dashboard and your own personal ones, with whether you can edit each and which is your Home. Read-only.

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
| `items` | array of object | yes |   |   |
| `items[].id` | string | yes |   |   |
| `items[].title` | string | yes |   |   |
| `items[].description` | string or null | yes |   |   |
| `items[].shared` | boolean | yes |   |   |
| `items[].ownerId` | string or null | yes |   |   |
| `items[].builtIn` | boolean | yes |   |   |
| `items[].canEdit` | boolean | yes |   |   |
| `items[].isHome` | boolean | yes |   |   |
| `items[].createdAt` | string or null | yes |   |   |
| `items[].updatedAt` | string or null | yes |   |   |
| `items[].widgetCount` | number | yes |   |   |
| `homeId` | string | yes |   |   |

## dashboard.setHome

Make a dashboard you can open your Home, shown at /. Pass null to go back to the default (see dashboard.home). Only changes your own Home.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `write` |
| Audiences | `staff` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string or null | yes |   |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `homeId` | string | yes |   |   |

## dashboard.update

Change a dashboard you own (or, as an admin, a shared one): title, description, sharing, filters or widgets. Filters and widgets replace the old lists whole, so send every widget you want to keep (dashboard.get returns them). Returns the dashboard.

|  |  |
| --- | --- |
| Permission | `records:write` |
| Risk | `write` |
| Audiences | `staff` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes | min length 1, max length 64 | Dashboard id (dsh_…) |
| `title` | string |   | min length 1, max length 200 |   |
| `description` | string or null |   |   |   |
| `shared` | boolean |   |   |   |
| `filters` | array of object |   | at most 8 | Dashboard filters, each bound to named SQL params: dateRange `date` → :date_from/:date_to, user `owner` → :owner, select/field/text `x` → :x |
| `widgets` | array of object |   | at most 30 | Widgets in layout order |
| `widgets[].id` | string | yes | pattern `^[a-z0-9][a-z0-9_-]{0,40}$` | Stable id within the dashboard, e.g. people-added |
| `widgets[].type` | `"kpi"`, `"bar"`, `"line"`, `"donut"`, `"funnel"`, `"table"`, `"leaderboard"`, `"markdown"` | yes |   |   |
| `widgets[].title` | string | yes | min length 1, max length 200 |   |
| `widgets[].description` | string or null |   |   |   |
| `widgets[].sql` | string or null |   |   | Data widgets: one read-only SELECT over rec_* views. Use named params for filters (:date_from, :date_to, :owner, …) and the system params :now, :today and :me |
| `widgets[].markdown` | string or null |   |   | Markdown widgets: the text |
| `widgets[].mapping` | object |   | default `{}` |   |
| `widgets[].mapping.x` | string |   | max length 80 | Category or time column (bar, line, funnel) |
| `widgets[].mapping.y` | string or array of string |   |   | Value column(s) (bar, line) |
| `widgets[].mapping.series` | string |   | max length 80 | A column whose values split rows into series (long format, bar/line) |
| `widgets[].mapping.label` | string |   | max length 80 | Segment or row label column (donut, leaderboard) |
| `widgets[].mapping.value` | string |   | max length 80 | Value column (kpi, donut, funnel, leaderboard) |
| `widgets[].mapping.columns` | array of string |   | at most 20 | Columns shown (table) |
| `widgets[].options` | object |   | default `{}` |   |
| `widgets[].options.orientation` | `"vertical"`, `"horizontal"` |   |   | bar: columns or bars |
| `widgets[].options.stacked` | boolean |   |   |   |
| `widgets[].options.area` | boolean |   |   | line: fill as an area chart |
| `widgets[].options.pie` | boolean |   |   | donut: a full pie instead of a ring |
| `widgets[].options.format` | `"number"`, `"currency"`, `"percent"` |   |   |   |
| `widgets[].options.currency` | string |   | pattern `^[A-Z]{3}$` |   |
| `widgets[].options.compare` | boolean |   |   | kpi: compare with the previous period of the date filter (default true) |
| `widgets[].options.limit` | integer |   | ≥ 1, ≤ 100 | table/leaderboard: top N rows |
| `widgets[].clickThrough` | object or null |   |   |   |
| `widgets[].clickThrough.object` | string | yes | min length 1, max length 80 | The object whose list opens |
| `widgets[].clickThrough.objectColumn` | string or null |   |   | A result column naming the object per row, when rows mix objects |
| `widgets[].clickThrough.filter` | any or null |   |   |   |
| `widgets[].layout` | object |   | default `{"w":6,"h":2}` |   |
| `widgets[].layout.w` | integer |   | ≥ 1, ≤ 12, default `6` | Width in grid columns (of 12) |
| `widgets[].layout.h` | integer |   | ≥ 1, ≤ 8, default `2` | Height in grid rows (about 9rem each) |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `title` | string | yes |   |   |
| `description` | string or null | yes |   |   |
| `shared` | boolean | yes |   |   |
| `ownerId` | string or null | yes |   |   |
| `builtIn` | boolean | yes |   |   |
| `canEdit` | boolean | yes |   |   |
| `isHome` | boolean | yes |   |   |
| `filters` | array of object | yes |   |   |
| `widgets` | array of object | yes |   |   |
| `widgets[].id` | string | yes | pattern `^[a-z0-9][a-z0-9_-]{0,40}$` | Stable id within the dashboard, e.g. people-added |
| `widgets[].type` | `"kpi"`, `"bar"`, `"line"`, `"donut"`, `"funnel"`, `"table"`, `"leaderboard"`, `"markdown"` | yes |   |   |
| `widgets[].title` | string | yes | min length 1, max length 200 |   |
| `widgets[].description` | string or null |   |   |   |
| `widgets[].sql` | string or null |   |   | Data widgets: one read-only SELECT over rec_* views. Use named params for filters (:date_from, :date_to, :owner, …) and the system params :now, :today and :me |
| `widgets[].markdown` | string or null |   |   | Markdown widgets: the text |
| `widgets[].mapping` | object | yes | default `{}` |   |
| `widgets[].mapping.x` | string |   | max length 80 | Category or time column (bar, line, funnel) |
| `widgets[].mapping.y` | string or array of string |   |   | Value column(s) (bar, line) |
| `widgets[].mapping.series` | string |   | max length 80 | A column whose values split rows into series (long format, bar/line) |
| `widgets[].mapping.label` | string |   | max length 80 | Segment or row label column (donut, leaderboard) |
| `widgets[].mapping.value` | string |   | max length 80 | Value column (kpi, donut, funnel, leaderboard) |
| `widgets[].mapping.columns` | array of string |   | at most 20 | Columns shown (table) |
| `widgets[].options` | object | yes | default `{}` |   |
| `widgets[].options.orientation` | `"vertical"`, `"horizontal"` |   |   | bar: columns or bars |
| `widgets[].options.stacked` | boolean |   |   |   |
| `widgets[].options.area` | boolean |   |   | line: fill as an area chart |
| `widgets[].options.pie` | boolean |   |   | donut: a full pie instead of a ring |
| `widgets[].options.format` | `"number"`, `"currency"`, `"percent"` |   |   |   |
| `widgets[].options.currency` | string |   | pattern `^[A-Z]{3}$` |   |
| `widgets[].options.compare` | boolean |   |   | kpi: compare with the previous period of the date filter (default true) |
| `widgets[].options.limit` | integer |   | ≥ 1, ≤ 100 | table/leaderboard: top N rows |
| `widgets[].clickThrough` | object or null |   |   |   |
| `widgets[].clickThrough.object` | string | yes | min length 1, max length 80 | The object whose list opens |
| `widgets[].clickThrough.objectColumn` | string or null |   |   | A result column naming the object per row, when rows mix objects |
| `widgets[].clickThrough.filter` | any or null |   |   |   |
| `widgets[].layout` | object | yes | default `{"w":6,"h":2}` |   |
| `widgets[].layout.w` | integer | yes | ≥ 1, ≤ 12, default `6` | Width in grid columns (of 12) |
| `widgets[].layout.h` | integer | yes | ≥ 1, ≤ 8, default `2` | Height in grid rows (about 9rem each) |
| `createdAt` | string or null | yes |   |   |
| `updatedAt` | string or null | yes |   |   |
