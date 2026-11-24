---
title: "code.* operations"
description: "The core operations named code.*"
sidebar:
  label: "code"
editUrl: false
---

## code.run

Run a short JavaScript/TypeScript ES module against the CRM, for work that takes many calls or some logic: looping over search results, joining data, computing a report, preparing one bulk change. It runs in a sandbox with no network, for at most 30 seconds and 100 operation calls, as you (same permissions, approval policy and audit as the other tools: a change that needs approval is queued, not applied, and your later reads in the script see it as pending). Import { crm } from "codemode:ops" and call operations by name: await ops.call("person.list", { filter: …, limit: 50 }). Names and inputs are the ones describe_operations lists (person.get, person.list, person.updateMany, organisation.list, activity.log, record.list, query.sql, search.global, …). A failed call throws an Error with .code and .details; a call queued for approval returns { status: "pending_approval", actionId, … } instead of its result. Export default an async function (or a value); its return value (JSON) comes back as "value", with console.log/info/warn/error output as "logs". To change many records, prefer ONE *Many call (e.g. person.updateMany with up to 100 ids) over a loop of single updates: it is atomic and becomes one reviewable change. Pass the input "reason" to say why; it is stored on anything queued. Example, tagging every person at an organisation: import { ops } from "codemode:ops"; export default async function () { const page = await ops.call("person.list", { filter: { field: "organisationId", op: "eq", value: "org_01J…" }, fields: ["id", "displayName"], limit: 100, }); const ids = page.items.map((p) =&gt; p.id); console.log("tagging", ids.length, "people"); const result = await ops.call("person.updateMany", { ids, addTags: ["offsite-2026"] }); return { tagged: ids.length, result }; }

|  |  |
| --- | --- |
| Permission | `records:write` |
| Risk | `write` |
| Audiences | `staff` |
| Actors | `mcp`, `assistant` |
| Also | bookkeeping, never queued for review |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `code` | string | yes | min length 1, max length 50000 | The ES module source; import { ops } from "codemode:ops" |
| `reason` | string |   | max length 1000 | Why: stored on any change the script queues for approval |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `ok` | boolean | yes |   |   |
| `value` | any |   |   |   |
| `error` | object |   |   |   |
| `error.code` | string | yes |   |   |
| `error.message` | string | yes |   |   |
| `logs` | array of object | yes |   |   |
| `logs[].level` | string | yes |   |   |
| `logs[].message` | string | yes |   |   |
| `operations` | array of object | yes |   |   |
| `operations[].operation` | string | yes |   |   |
| `operations[].ok` | boolean | yes |   |   |
| `operations[].code` | string |   |   |   |
| `operations[].pendingActionId` | string |   |   |   |
| `operations[].ms` | number | yes |   |   |
| `pending` | array of any | yes |   |   |
| `durationMs` | number | yes |   |   |
| `truncated` | boolean |   |   |   |
