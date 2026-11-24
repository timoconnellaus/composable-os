---
title: "plan.* operations"
description: "The core operations named plan.*"
sidebar:
  label: "plan"
editUrl: false
---

## plan.get

The deployment's hosted plan (free, team, business or enterprise) and its limits: users, records (people plus organisations; null = unlimited) and whether the platform's AI is included, with current usage. managed is false on a self-hosted install, which has no limits. Admins only. Read-only: plans change only through billing.

|  |  |
| --- | --- |
| Permission | `settings:manage` |
| Risk | `read` |
| Audiences | `staff` |

### Input

No fields.

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `managed` | boolean | yes |   | False: self-hosted, no limits |
| `entitlements` | object or null | yes |   |   |
| `entitlements.plan` | `"free"`, `"team"`, `"business"`, `"enterprise"` | yes |   |   |
| `entitlements.maxUsers` | integer or null | yes |   |   |
| `entitlements.maxRecords` | integer or null | yes |   |   |
| `entitlements.platformAi` | boolean | yes |   |   |
| `entitlements.updatedAt` | string | yes |   |   |
| `usage` | object | yes |   |   |
| `usage.users` | number | yes |   | Active people who can sign in (support users never count) |
| `usage.records` | number | yes |   | Live people plus organisations |
| `billingUrl` | string or null | yes |   | Where to upgrade, when managed |
