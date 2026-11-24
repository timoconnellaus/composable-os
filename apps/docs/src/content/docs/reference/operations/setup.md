---
title: "setup.* operations"
description: "The core operations named setup.*"
sidebar:
  label: "setup"
editUrl: false
---

## setup.finish

Close the setup wizard: completed (every step done) or skipped (the admin chose to set up later; Settings → General can reopen it). Human admins only.

|  |  |
| --- | --- |
| Permission | `settings:manage` |
| Risk | `write` |
| Audiences | `staff` |
| Actors | `human` |
| Also | not offered to MCP clients (`mcp.expose: false`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `outcome` | `"completed"`, `"skipped"` | yes |   |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `status` | `"pending"`, `"in_progress"`, `"completed"`, `"skipped"` | yes |   |   |
| `step` | `"admin"`, `"organisation"`, `"ai"`, `"policy"`, `"connect"`, `"sample"` | yes |   |   |
| `data` | map of any | yes |   |   |
| `open` | boolean | yes |   |   |
| `sampleRecords` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 | Records 'Install sample data' created that still exist |

## setup.restart

Open the setup wizard again from the first step, keeping earlier answers. Human admins only.

|  |  |
| --- | --- |
| Permission | `settings:manage` |
| Risk | `write` |
| Audiences | `staff` |
| Actors | `human` |
| Also | not offered to MCP clients (`mcp.expose: false`) |

### Input

No fields.

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `status` | `"pending"`, `"in_progress"`, `"completed"`, `"skipped"` | yes |   |   |
| `step` | `"admin"`, `"organisation"`, `"ai"`, `"policy"`, `"connect"`, `"sample"` | yes |   |   |
| `data` | map of any | yes |   |   |
| `open` | boolean | yes |   |   |
| `sampleRecords` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 | Records 'Install sample data' created that still exist |

## setup.save

Record the wizard's progress: the step reached and non-secret answers so far, so it can be resumed later. Human admins only.

|  |  |
| --- | --- |
| Permission | `settings:manage` |
| Risk | `write` |
| Audiences | `staff` |
| Actors | `human` |
| Also | bookkeeping, never queued for review; not offered to MCP clients (`mcp.expose: false`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `step` | `"admin"`, `"organisation"`, `"ai"`, `"policy"`, `"connect"`, `"sample"` | yes |   |   |
| `data` | map of any |   |   |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `status` | `"pending"`, `"in_progress"`, `"completed"`, `"skipped"` | yes |   |   |
| `step` | `"admin"`, `"organisation"`, `"ai"`, `"policy"`, `"connect"`, `"sample"` | yes |   |   |
| `data` | map of any | yes |   |   |
| `open` | boolean | yes |   |   |
| `sampleRecords` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 | Records 'Install sample data' created that still exist |

## setup.status

The first-run setup wizard's progress: pending, in progress (with the step reached), completed or skipped, and how many sample records are installed. Read-only.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `read` |
| Audiences | `staff` |
| Also | not offered to MCP clients (`mcp.expose: false`) |

### Input

No fields.

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `status` | `"pending"`, `"in_progress"`, `"completed"`, `"skipped"` | yes |   |   |
| `step` | `"admin"`, `"organisation"`, `"ai"`, `"policy"`, `"connect"`, `"sample"` | yes |   |   |
| `data` | map of any | yes |   |   |
| `open` | boolean | yes |   |   |
| `sampleRecords` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 | Records 'Install sample data' created that still exist |
