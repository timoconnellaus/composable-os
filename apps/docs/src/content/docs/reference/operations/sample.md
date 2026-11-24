---
title: "sample.* operations"
description: "The core operations named sample.*"
sidebar:
  label: "sample"
editUrl: false
---

## sample.install

Add a small set of sample organisations, people and tasks (marked '(sample)') to explore the CRM with. sample.remove deletes exactly these. Human admins only.

|  |  |
| --- | --- |
| Permission | `settings:manage` |
| Risk | `write` |
| Audiences | `staff` |
| Actors | `human` |

### Input

No fields.

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `organisations` | number | yes |   |   |
| `people` | number | yes |   |   |
| `tasks` | number | yes |   |   |

## sample.remove

Permanently delete the sample data sample.install added (and nothing else), with whatever was linked only to it. Human admins only.

|  |  |
| --- | --- |
| Permission | `settings:manage` |
| Risk | `destructive` |
| Audiences | `staff` |
| Actors | `human` |

### Input

No fields.

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `removed` | number | yes |   |   |
