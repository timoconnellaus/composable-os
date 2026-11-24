---
title: "screens.* operations"
description: "The core operations named screens.*"
sidebar:
  label: "screens"
editUrl: false
---

## screens.mine

The staff screens of the installed packs the signed-in person may open in the admin: each one's pack, key, label, where it sits in the navigation, its route, and the object whose record page shows it as a tab. A screen is listed only when the person could call every tool that gates it. Empty for anyone but a person. Read-only.

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
| `screens` | array of object | yes |   |   |
| `screens[].pack` | string | yes |   |   |
| `screens[].key` | string | yes |   |   |
| `screens[].label` | string | yes |   |   |
| `screens[].nav` | object or null | yes |   |   |
| `screens[].nav.group` | string | yes |   |   |
| `screens[].nav.order` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |
| `screens[].route` | string | yes |   |   |
| `screens[].record` | object or null | yes |   |   |
| `screens[].record.object` | string | yes |   |   |
| `screens[].record.as` | string | yes |   |   |
