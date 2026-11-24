---
title: "view.* operations"
description: "The core operations named view.*"
sidebar:
  label: "view"
editUrl: false
---

## view.create

Save a view of an object's records: a name and A view spec: { type: 'table', object, filter, sort, columns } | { type: 'board', object, filter, groupBy (single-select field), sumField?, cardFields } | { type: 'calendar', object, filter, dateField, mode: month|week|agenda, cardFields } | { type: 'gallery', object, filter, sort, imageField?, cardFields }. Fields are checked against the object's registry. Personal by default; shared: true shows it to everyone in the org (you and admins can change it). Returns the saved view.

|  |  |
| --- | --- |
| Permission | `records:write` |
| Risk | `write` |
| Audiences | `staff` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `name` | string | yes | min length 1, max length 200 |   |
| `spec` | object | yes |   |   |
| `shared` | boolean |   | default `false` |   |
| `position` | integer |   | ≥ 0, ≤ 10000 | Order in the view list |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `name` | string | yes |   |   |
| `object` | string | yes |   |   |
| `spec` | object | yes |   |   |
| `position` | number | yes |   |   |
| `shared` | boolean | yes |   |   |
| `ownerId` | string | yes |   |   |
| `canEdit` | boolean | yes |   |   |
| `createdAt` | string | yes |   |   |
| `updatedAt` | string | yes |   |   |

## view.delete

Delete a saved view you own (admins may also delete shared views). This removes only the saved configuration, never any records, and cannot be undone.

|  |  |
| --- | --- |
| Permission | `records:write` |
| Risk | `write` |
| Audiences | `staff` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string (starts_with) | yes | max length 64, pattern `^vw_.*` | Saved view id (vw_…) |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `deleted` | `true` | yes |   |   |

## view.get

Get one saved view you can see (your own or a shared one) with its spec. Read-only.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `read` |
| Audiences | `staff` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string (starts_with) | yes | max length 64, pattern `^vw_.*` | Saved view id (vw_…) |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `name` | string | yes |   |   |
| `object` | string | yes |   |   |
| `spec` | object | yes |   |   |
| `position` | number | yes |   |   |
| `shared` | boolean | yes |   |   |
| `ownerId` | string | yes |   |   |
| `canEdit` | boolean | yes |   |   |
| `createdAt` | string | yes |   |   |
| `updatedAt` | string | yes |   |   |

## view.list

List the saved views you can use, optionally for one object: your own, every shared view and the views installed extensions ship (e.g. Deals' My open deals), in their saved order, each with its full spec (table, board, calendar or gallery) and whether you can edit it. Filter values may be relative ({ $relative: 'me' | 'today' | 'startOfMonth' | … }), resolved when the list runs. Read-only.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `read` |
| Audiences | `staff` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `object` | string |   | min length 1, max length 80, pattern `^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)?$` | The object listed: person, organisation, activity, task or an extension object |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `items` | array of object | yes |   |   |
| `items[].id` | string | yes |   |   |
| `items[].name` | string | yes |   |   |
| `items[].object` | string | yes |   |   |
| `items[].spec` | object | yes |   |   |
| `items[].position` | number | yes |   |   |
| `items[].shared` | boolean | yes |   |   |
| `items[].ownerId` | string | yes |   |   |
| `items[].canEdit` | boolean | yes |   |   |
| `items[].createdAt` | string | yes |   |   |
| `items[].updatedAt` | string | yes |   |   |

## view.recordViews

List the tabs and side panels extensions add to an object's record page: each is a view spec (table, board, calendar or gallery) of another object, to be filtered to records whose `relation` field equals the record's id. Also lists the record actions (extension tools shown as buttons on the page, such as Convert to deal). Read-only.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `read` |
| Audiences | `staff` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `object` | string | yes | min length 1, max length 80, pattern `^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)?$` | The object listed: person, organisation, activity, task or an extension object |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `tabs` | array of object | yes |   |   |
| `tabs[].id` | string | yes |   | &lt;extension&gt;.&lt;name&gt;, unique on the page |
| `tabs[].extension` | string | yes |   |   |
| `tabs[].kind` | `"tab"`, `"panel"` | yes |   |   |
| `tabs[].label` | string | yes |   |   |
| `tabs[].order` | number | yes |   |   |
| `tabs[].relation` | string | yes |   |   |
| `tabs[].spec` | object or null | yes |   |   |
| `tabs[].error` | string or null | yes |   |   |
| `panels` | array of object | yes |   |   |
| `panels[].id` | string | yes |   | &lt;extension&gt;.&lt;name&gt;, unique on the page |
| `panels[].extension` | string | yes |   |   |
| `panels[].kind` | `"tab"`, `"panel"` | yes |   |   |
| `panels[].label` | string | yes |   |   |
| `panels[].order` | number | yes |   |   |
| `panels[].relation` | string | yes |   |   |
| `panels[].spec` | object or null | yes |   |   |
| `panels[].error` | string or null | yes |   |   |
| `actions` | array of object | yes |   |   |
| `actions[].id` | string | yes |   | &lt;extension&gt;.&lt;tool&gt; |
| `actions[].extension` | string | yes |   |   |
| `actions[].operation` | string | yes |   |   |
| `actions[].label` | string | yes |   |   |
| `actions[].idInput` | string | yes |   |   |
| `actions[].confirm` | string or null | yes |   |   |
| `actions[].ask` | object or null | yes |   |   |
| `actions[].ask.input` | string | yes |   |   |
| `actions[].ask.label` | string | yes |   |   |
| `actions[].ask.options` | array of object | yes |   |   |
| `actions[].ask.options[].value` | string | yes |   |   |
| `actions[].ask.options[].label` | string | yes |   |   |
| `actions[].hideWhen` | object or null | yes |   |   |
| `actions[].hideWhen.field` | string | yes |   |   |
| `actions[].hideWhen.values` | array of string | yes |   |   |

## view.update

Rename, reorder, share or change the spec of a saved view you own (admins may also change shared views). A new spec replaces the old one, may change its type (table → board) and is checked against the object's fields. Returns the updated view.

|  |  |
| --- | --- |
| Permission | `records:write` |
| Risk | `write` |
| Audiences | `staff` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string (starts_with) | yes | max length 64, pattern `^vw_.*` | Saved view id (vw_…) |
| `name` | string |   | min length 1, max length 200 |   |
| `spec` | object |   |   |   |
| `shared` | boolean |   |   |   |
| `position` | integer |   | ≥ 0, ≤ 10000 |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `name` | string | yes |   |   |
| `object` | string | yes |   |   |
| `spec` | object | yes |   |   |
| `position` | number | yes |   |   |
| `shared` | boolean | yes |   |   |
| `ownerId` | string | yes |   |   |
| `canEdit` | boolean | yes |   |   |
| `createdAt` | string | yes |   |   |
| `updatedAt` | string | yes |   |   |
