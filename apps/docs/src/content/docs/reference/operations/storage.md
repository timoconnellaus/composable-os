---
title: "storage.* operations"
description: "The core operations named storage.*"
sidebar:
  label: "storage"
editUrl: false
---

## storage.refresh

Measure the database again now (size and row counts of the largest tables) instead of waiting for the daily measurement. Counting reads every row of those tables, so a refresh within 10 minutes of the last returns that one. Admins only.

|  |  |
| --- | --- |
| Permission | `audit:read` |
| Risk | `write` |
| Audiences | `staff` |
| Actors | `human` |

### Input

No fields.

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `sizeBytes` | number or null | yes |   | Database size now, when the runtime reports it |
| `capBytes` | number | yes |   | D1's hard limit per database |
| `warnBytes` | number | yes |   |   |
| `criticalBytes` | number | yes |   |   |
| `level` | `"ok"`, `"warning"`, `"critical"`, `"unknown"` | yes |   |   |
| `tables` | array of object | yes |   |   |
| `tables[].table` | string | yes |   |   |
| `tables[].rows` | number | yes |   |   |
| `measuredAt` | string or null | yes |   | When the row counts were taken (daily, or refresh) |
| `measuredSizeBytes` | number or null | yes |   |   |

## storage.status

How full the database is: its size against D1's 10 GB limit (warning from 6 GB, critical from 8 GB) and row counts of the largest tables as of the last daily measurement. Admins only. Read-only.

|  |  |
| --- | --- |
| Permission | `audit:read` |
| Risk | `read` |
| Audiences | `staff` |

### Input

No fields.

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `sizeBytes` | number or null | yes |   | Database size now, when the runtime reports it |
| `capBytes` | number | yes |   | D1's hard limit per database |
| `warnBytes` | number | yes |   |   |
| `criticalBytes` | number | yes |   |   |
| `level` | `"ok"`, `"warning"`, `"critical"`, `"unknown"` | yes |   |   |
| `tables` | array of object | yes |   |   |
| `tables[].table` | string | yes |   |   |
| `tables[].rows` | number | yes |   |   |
| `measuredAt` | string or null | yes |   | When the row counts were taken (daily, or refresh) |
| `measuredSizeBytes` | number or null | yes |   |   |
