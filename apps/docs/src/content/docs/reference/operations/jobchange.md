---
title: "jobChange.* operations"
description: "The core operations named jobChange.*"
sidebar:
  label: "jobChange"
editUrl: false
---

## jobChange.apply

Confirm a suggested job change: runs person.changeJob for the person with the new organisation (organisationId, or the proposal's organisation) and title, through the approval pipeline as you. A bounce with no new organisation known needs organisationId.

|  |  |
| --- | --- |
| Permission | `records:write` |
| Risk | `write` |
| Audiences | `staff` |
| Also | bookkeeping, never queued for review |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string (starts_with) | yes | max length 64, pattern `^jcs_.*` |   |
| `organisationId` | string (starts_with) |   | max length 64, pattern `^org_.*` |   |
| `title` | string |   | max length 200 |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `personId` | string | yes |   |   |
| `result` | any | yes |   |   |

## jobChange.dismiss

Dismiss a suggested job change. Nothing else changes.

|  |  |
| --- | --- |
| Permission | `records:write` |
| Risk | `write` |
| Audiences | `staff` |
| Also | bookkeeping, never queued for review |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string (starts_with) | yes | max length 64, pattern `^jcs_.*` |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |

## jobChange.list

Suggested job changes from mail: a known person's address bounced, their signature names a new company, or they wrote from a new domain. Each has its evidence and a proposal. Confirm with jobChange.apply (runs person.changeJob) or dismiss. Read-only.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `read` |
| Audiences | `staff` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `limit` | integer |   | ≥ 1, ≤ 200, default `50` |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `items` | array of object | yes |   |   |
| `items[].id` | string | yes |   |   |
| `items[].personId` | string | yes |   |   |
| `items[].personName` | string or null | yes |   |   |
| `items[].currentOrganisation` | string or null | yes |   |   |
| `items[].signal` | `"bounce"`, `"signature"`, `"domain"` | yes |   |   |
| `items[].evidence` | map of any | yes |   |   |
| `items[].proposal` | map of any | yes |   |   |
| `items[].createdAt` | string | yes |   |   |
