---
title: "agentProfile.* operations"
description: "The core operations named agentProfile.*"
sidebar:
  label: "agentProfile"
editUrl: false
---

## agentProfile.get

One agent profile by name, with its instructions. Read-only.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `read` |
| Audiences | `staff` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `name` | string | yes | min length 1, max length 120 |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `name` | string | yes |   |   |
| `label` | string | yes |   |   |
| `description` | string | yes |   |   |
| `role` | `"build"`, `"assistant.core"`, `"assistant.subagent"`, `"summarise"`, `"extract"`, `"classify"`, `"embed"`, `"vision"`, `"review"`, `"dictation.cleanup"`, `"transcribe"`, `"speak"` | yes |   |   |
| `operations` | array of string | yes |   |   |
| `caps` | object | yes |   |   |
| `caps.changes` | integer | yes | ≥ 0, ≤ 5000 | Fields filled, without review |
| `caps.notes` | integer | yes | ≥ 0, ≤ 5000, default `0` | Notes added, without review |
| `caps.tasks` | integer | yes | ≥ 0, ≤ 5000, default `0` | Tasks added, without review |
| `expiresInHours` | number | yes |   |   |
| `budget` | object | yes |   |   |
| `budget.steps` | integer | yes | ≥ 1, ≤ 5000 |   |
| `budget.minutes` | integer | yes | ≥ 1, ≤ 1440 |   |
| `budget.spendUsd` | number | yes | ≥ 0, ≤ 1000 |   |
| `source` | string | yes |   |   |
| `instructions` | string | yes |   |   |

## agentProfile.list

The kinds of agent you can start by name: what each is for, what it can do by default, its budget and its model role. Shipped ones and any a plugin added. Read-only.

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
| `items[].name` | string | yes |   |   |
| `items[].label` | string | yes |   |   |
| `items[].description` | string | yes |   |   |
| `items[].role` | `"build"`, `"assistant.core"`, `"assistant.subagent"`, `"summarise"`, `"extract"`, `"classify"`, `"embed"`, `"vision"`, `"review"`, `"dictation.cleanup"`, `"transcribe"`, `"speak"` | yes |   |   |
| `items[].operations` | array of string | yes |   |   |
| `items[].caps` | object | yes |   |   |
| `items[].caps.changes` | integer | yes | ≥ 0, ≤ 5000 | Fields filled, without review |
| `items[].caps.notes` | integer | yes | ≥ 0, ≤ 5000, default `0` | Notes added, without review |
| `items[].caps.tasks` | integer | yes | ≥ 0, ≤ 5000, default `0` | Tasks added, without review |
| `items[].expiresInHours` | number | yes |   |   |
| `items[].budget` | object | yes |   |   |
| `items[].budget.steps` | integer | yes | ≥ 1, ≤ 5000 |   |
| `items[].budget.minutes` | integer | yes | ≥ 1, ≤ 1440 |   |
| `items[].budget.spendUsd` | number | yes | ≥ 0, ≤ 1000 |   |
| `items[].source` | string | yes |   |   |
