---
title: "export.* operations"
description: "The core operations named export.*"
sidebar:
  label: "export"
editUrl: false
---

## export.csv

Export a list to CSV: an object (person, organisation, task, activity), an optional filter (the same filter JSON list operations take), a sort and the columns (field names; default every exportable field). Multi-valued fields (emails, domains, tags) are joined with '; '. Headers are field names, so people and organisation exports re-import with import.csv.*. At most 50000 rows. Returns the CSV text. Read-only.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `read` |
| Audiences | `staff` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `object` | string | yes | min length 1, max length 80 | person, organisation, task, activity or an extension object |
| `filter` | any or null |   |   |   |
| `sort` | object or null |   |   |   |
| `sort.field` | string | yes | min length 1, max length 64 |   |
| `sort.direction` | `"asc"`, `"desc"` |   | default `"asc"` |   |
| `columns` | array of string |   | at least 1, at most 100 |   |
| `maxRows` | integer |   | ≥ 1, ≤ 50000, default `10000` |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `csv` | string | yes |   |   |
| `filename` | string | yes |   |   |
| `columns` | array of string | yes |   |   |
| `rowCount` | number | yes |   |   |
| `truncated` | boolean | yes |   |   |
