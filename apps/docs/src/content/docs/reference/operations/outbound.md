---
title: "outbound.* operations"
description: "The core operations named outbound.*"
sidebar:
  label: "outbound"
editUrl: false
---

## outbound.kinds

Outbound action kinds gatekeepers have submitted (e.g. email.send, slack.post) and whether each may auto-apply under Balanced: only kinds the gatekeeper marks autoApprovable can be, and only once an admin enabled it. Read-only.

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
| `items[].tag` | string | yes |   |   |
| `items[].vendor` | string | yes |   |   |
| `items[].label` | string | yes |   |   |
| `items[].autoApprovable` | boolean | yes |   |   |
| `items[].autoApprove` | boolean | yes |   |   |
| `items[].firstSeenAt` | string | yes |   |   |
| `items[].updatedAt` | string | yes |   |   |

## outbound.setAutoApprove

Let an outbound action kind auto-apply under the Balanced preset (or require review again). Only kinds the gatekeeper marks autoApprovable qualify. Loosens the approval policy, so it is admin-only, human-only and audited. The deploy-time floor still applies.

|  |  |
| --- | --- |
| Permission | `policy:manage` |
| Risk | `write` |
| Audiences | `staff` |
| Actors | `human` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `tag` | string | yes | min length 1, max length 100 |   |
| `enabled` | boolean | yes |   |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `tag` | string | yes |   |   |
| `vendor` | string | yes |   |   |
| `label` | string | yes |   |   |
| `autoApprovable` | boolean | yes |   |   |
| `autoApprove` | boolean | yes |   |   |
| `firstSeenAt` | string | yes |   |   |
| `updatedAt` | string | yes |   |   |
