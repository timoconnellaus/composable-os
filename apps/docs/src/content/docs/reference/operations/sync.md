---
title: "sync.* operations"
description: "The core operations named sync.*"
sidebar:
  label: "sync"
editUrl: false
---

## sync.getSettings

The org's mail and calendar sync settings: internal domains (colleagues' addresses, never matched to people or suggested; when empty, the domains of the CRM users' own addresses are used). Read-only.

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
| `internalDomains` | array of string | yes |   |   |
| `effectiveInternalDomains` | array of string | yes |   |   |
| `backfillDays` | number | yes |   |   |
| `suggestionThreshold` | number | yes |   |   |

## sync.ingest

Internal to the sync service: writes one batch of normalised mail and calendar items from one connection onto CRM timelines (matching, dedupe across mailboxes, threading, deletes and updates, suggestions and sync events) in one transaction with one audit row.

|  |  |
| --- | --- |
| Permission | `records:write` |
| Risk | `write` |
| Audiences | `staff` |
| Actors | `automation` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `connectionId` | string (starts_with) | yes | max length 64, pattern `^con_.*` |   |
| `items` | array of object | yes | at least 1, at most 50 |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `created` | number | yes |   |   |
| `updated` | number | yes |   |   |
| `skipped` | number | yes |   |   |
| `deleted` | number | yes |   |   |
| `bodies` | array of object | yes |   |   |
| `bodies[].externalKey` | string | yes |   |   |
| `bodies[].activityId` | string | yes |   |   |
| `bodies[].key` | string | yes |   |   |
| `removedBodies` | array of string | yes |   |   |

## sync.setSettings

Set the org's internal domains for mail and calendar sync. Admins only; people only.

|  |  |
| --- | --- |
| Permission | `integrations:manage` |
| Risk | `write` |
| Audiences | `staff` |
| Actors | `human` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `internalDomains` | array of string |   | at most 50, default `[]` |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `internalDomains` | array of string | yes |   |   |
