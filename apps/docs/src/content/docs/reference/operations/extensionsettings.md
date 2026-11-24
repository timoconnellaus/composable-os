---
title: "extensionSettings.* operations"
description: "The core operations named extensionSettings.*"
sidebar:
  label: "extensionSettings"
editUrl: false
---

## extensionSettings.list

List the typed settings every active extension declares, with their current values (defaults where unset). Read-only.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `read` |
| Audiences | `staff` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `extension` | string |   | max length 40 |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `items` | array of object | yes |   |   |
| `items[].extension` | string | yes |   |   |
| `items[].label` | string | yes |   |   |
| `items[].settings` | map of object | yes |   |   |
| `items[].values` | map of string or number or boolean or null | yes |   |   |
| `items[].updatedAt` | string or null | yes |   |   |

## extensionSettings.update

Change an extension's settings (admins). Values are checked against the types the extension declares; null resets one to its default. Returns the settings.

|  |  |
| --- | --- |
| Permission | `extensions:manage` |
| Risk | `write` |
| Audiences | `staff` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `extension` | string | yes | min length 1, max length 40 |   |
| `values` | map of string or number or boolean or null | yes |   |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `extension` | string | yes |   |   |
| `label` | string | yes |   |   |
| `settings` | map of object | yes |   |   |
| `values` | map of string or number or boolean or null | yes |   |   |
| `updatedAt` | string or null | yes |   |   |
