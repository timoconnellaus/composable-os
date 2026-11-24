---
title: "import.* operations"
description: "The core operations named import.*"
sidebar:
  label: "import"
editUrl: false
---

## import.csv.commit

Apply a CSV import planned by import.csv.preview: pass the same object, csv, mapping and any per-row overrides. The plan is recomputed against current data, then every create and update (people, emails, phones, tags, organisations, affiliations) is written in one transaction with an audit diff per record. Handles at least 5,000 rows. Bulk write: AI and automation callers may need approval above the policy's bulk threshold. Returns counts and the id written for each row.

|  |  |
| --- | --- |
| Permission | `records:write` |
| Risk | `bulk-write` |
| Audiences | `staff` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `object` | `"person"`, `"organisation"` | yes |   | What each row is |
| `csv` | string | yes | min length 1, max length 10000000 | The CSV text, header row first. Comma, semicolon or tab separated. |
| `mapping` | map of string or null |   |   | Column header → field name (null ignores the column). Omit to use the suggestions. |
| `overrides` | map of `"create"`, `"update"`, `"skip"` |   |   | Row number → create \| update \| skip, overriding the suggested action (see options) |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `counts` | object | yes |   |   |
| `counts.total` | number | yes |   |   |
| `counts.create` | number | yes |   |   |
| `counts.update` | number | yes |   |   |
| `counts.skip` | number | yes |   |   |
| `counts.organisationsCreated` | number | yes |   |   |
| `counts.organisationsMatched` | number | yes |   |   |
| `rows` | array of object | yes |   |   |
| `rows[].row` | number | yes |   |   |
| `rows[].action` | `"create"`, `"update"`, `"skip"` | yes |   |   |
| `rows[].id` | string or null | yes |   |   |
| `rows[].reason` | string or null | yes |   |   |

## import.csv.preview

Preview a CSV import of people or organisations without changing anything. Suggests a column mapping from the headers (pass mapping to change it), then decides per row: people are matched to existing people by email, organisations by domain (by name when a row has no domain). Matched rows update (filling in given fields, adding new emails, phones and tags); unmatched rows create; invalid or duplicate rows skip. A row that would create a record with the same name as an existing one says so in its reason. For people, an organisation column is matched by domain or name or creates the organisation, and a current affiliation (primary if the person has none) is added with the job title. Each row lists its options for overrides. Pass the same csv, mapping and overrides to import.csv.commit. Read-only.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `read` |
| Audiences | `staff` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `object` | `"person"`, `"organisation"` | yes |   | What each row is |
| `csv` | string | yes | min length 1, max length 10000000 | The CSV text, header row first. Comma, semicolon or tab separated. |
| `mapping` | map of string or null |   |   | Column header → field name (null ignores the column). Omit to use the suggestions. |
| `overrides` | map of `"create"`, `"update"`, `"skip"` |   |   | Row number → create \| update \| skip, overriding the suggested action (see options) |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `object` | `"person"`, `"organisation"` | yes |   |   |
| `headers` | array of string | yes |   |   |
| `mapping` | map of string or null | yes |   |   |
| `suggestions` | map of string or null | yes |   |   |
| `fields` | array of object | yes |   |   |
| `fields[].name` | string | yes |   |   |
| `fields[].label` | string | yes |   |   |
| `fields[].multi` | boolean | yes |   |   |
| `rows` | array of object | yes |   |   |
| `rows[].row` | number | yes |   | 1-based data row (the header is row 0) |
| `rows[].action` | `"create"`, `"update"`, `"skip"` | yes |   |   |
| `rows[].suggested` | `"create"`, `"update"`, `"skip"` | yes |   |   |
| `rows[].options` | array of `"create"`, `"update"`, `"skip"` | yes |   |   |
| `rows[].reason` | string or null | yes |   |   |
| `rows[].matchId` | string or null | yes |   |   |
| `rows[].values` | map of string or array of string | yes |   |   |
| `rows[].organisation` | object or null | yes |   |   |
| `rows[].organisation.action` | `"create"`, `"match"` | yes |   |   |
| `rows[].organisation.id` | string | yes |   |   |
| `rows[].organisation.name` | string | yes |   |   |
| `rows[].changes` | array of string | yes |   |   |
| `counts` | object | yes |   |   |
| `counts.total` | number | yes |   |   |
| `counts.create` | number | yes |   |   |
| `counts.update` | number | yes |   |   |
| `counts.skip` | number | yes |   |   |
| `counts.organisationsCreated` | number | yes |   |   |
| `counts.organisationsMatched` | number | yes |   |   |

## import.records.commit

Create records of an extension object from CSV rows start…start+count (at most 100 per call; call again with the next start for more), with the same mapping preview showed. Every record is created like record.create (stage rules, default stage, probability and stage history for deals), all in one transaction: a row with a problem fails the whole call with the row number, unless skipInvalid is set. Returns the created ids and skipped rows.

|  |  |
| --- | --- |
| Permission | `records:write` |
| Risk | `bulk-write` |
| Audiences | `staff` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `object` | string | yes | min length 1, max length 80 | An extension object, e.g. deals.deal |
| `csv` | string | yes | min length 1, max length 10000000 | The CSV text, header row first |
| `mapping` | map of string or null |   |   | Column header → field name (null ignores the column). Omit to use the suggestions. |
| `start` | integer |   | ≥ 0, ≤ 9007199254740991, default `0` | 0-based index of the first data row |
| `count` | integer |   | ≥ 1, ≤ 100, default `100` |   |
| `skipInvalid` | boolean |   | default `false` |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `created` | array of string | yes |   |   |
| `skipped` | array of object | yes |   |   |
| `skipped[].row` | number | yes |   |   |
| `skipped[].errors` | array of string | yes |   |   |
| `total` | number | yes |   |   |
| `next` | number or null | yes |   | The start of the next chunk, or null when done |

## import.records.preview

Preview a CSV import of records of an extension object (e.g. deals.deal): the suggested column → field mapping (by field name or label), the parsed values of the first rows, and every row's problems (unparseable cells, missing required fields, relation cells that match no record by id or title, users that match no id, email or name). Stage rules are checked on commit. Read-only.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `read` |
| Audiences | `staff` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `object` | string | yes | min length 1, max length 80 | An extension object, e.g. deals.deal |
| `csv` | string | yes | min length 1, max length 10000000 | The CSV text, header row first |
| `mapping` | map of string or null |   |   | Column header → field name (null ignores the column). Omit to use the suggestions. |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `headers` | array of string | yes |   |   |
| `mapping` | map of string or null | yes |   |   |
| `fields` | array of object | yes |   |   |
| `fields[].name` | string | yes |   |   |
| `fields[].label` | string | yes |   |   |
| `fields[].required` | boolean | yes |   |   |
| `total` | number | yes |   |   |
| `rows` | array of object | yes |   |   |
| `rows[].row` | number | yes |   |   |
| `rows[].values` | map of any | yes |   |   |
| `rows[].errors` | array of string | yes |   |   |
| `invalid` | number | yes |   |   |
