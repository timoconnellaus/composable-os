---
title: "query.* operations"
description: "The core operations named query.*"
sidebar:
  label: "query"
editUrl: false
---

## query.sql

Run one read-only SQL query (SQLite dialect) over the rec_* views: rec_person, rec_organisation, rec_affiliation, rec_activity, rec_activity_link, rec_task, rec_task_link, rec_record_tag, rec_user, rec_publish_version (the published versions of publishable records, without their content), rec_capacity and rec_capacity_claim (places, held, taken and claims of records with a capacity), rec_allowance, rec_allowance_period and rec_allowance_use (passes' and memberships' uses: terms, counts per period, every use spent or given back), rec_stock_movement (the stock ledger: every movement of a record with stock, its kind, signed quantity, place and source; on hand is rec_capacity's places - taken), rec_stage_history (stage entered/left times, days_in_stage), rec_state_history (the same for objects with a state machine: state, is_final, days_in_state) and extension objects as rec_x_&lt;ext&gt;_&lt;object&gt; (e.g. rec_x_deals_deal; see schema.objects). Only a single SELECT or WITH is allowed; core_* and sqlite_* tables, PRAGMA, ATTACH, writes, recursive CTEs and named parameters are refused. Pass values as params bound to ? (or ?1, ?2) placeholders, never by pasting them into the SQL. Multi-valued columns (emails, domains, tags) are JSON arrays: use json_each. Returns at most maxRows rows (default 200, max 1000) with truncated set when there were more, and fails after timeoutMs (default 5000). Use list operations for simple filtering; use this for joins, grouping and counts. Read-only.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `read` |
| Audiences | `staff` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `sql` | string | yes | min length 1, max length 20000 |   |
| `params` | array of string or number or boolean or null |   | at most 100, default `[]` |   |
| `maxRows` | integer |   | ≥ 1, ≤ 1000, default `200` |   |
| `timeoutMs` | integer |   | ≥ 1, ≤ 10000, default `5000` |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `columns` | array of string | yes |   |   |
| `rows` | array of map of any | yes |   |   |
| `rowCount` | number | yes |   |   |
| `truncated` | boolean | yes |   |   |
| `views` | array of string | yes |   | The rec_* views the query read |
