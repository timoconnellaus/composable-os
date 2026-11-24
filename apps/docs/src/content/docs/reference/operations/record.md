---
title: "record.* operations"
description: "The core operations named record.*"
sidebar:
  label: "record"
editUrl: false
---

## record.cancelSchedule

Drop the scheduled publish of a record of a publishable object. What is live stays live. Not found when nothing is scheduled. A person with the publish permission does it at once. An AI assistant, MCP client, automation or extension may call it too: then it never happens at once, under any approval policy. It waits for a person with the publish permission to approve it (the result says it is pending), and is refused on approval if the record changed since it was asked for. The account it acts for must hold the publish permission to ask.

|  |  |
| --- | --- |
| Permission | `records:publish` |
| Risk | `write` |
| Audiences | `staff` |
| Also | always reviewed when called by `assistant`, `mcp`, `automation`, `extension` (`alwaysReview`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `object` | string | yes | min length 1, max length 80, pattern `^[a-z][a-z0-9]*\.[a-z][a-z0-9]*$` | An extension object (`<extension>.<object>`, see schema.objects) |
| `id` | string | yes | min length 1, max length 64 | Record id |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `cancelled` | string | yes |   | The time it was scheduled for |

## record.compareVersions

Compare two versions of a record of a publishable object, or a version and the working copy: each content field that differs, with its value in both. `to` left out is the working copy (what would be published now). Read-only.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `read` |
| Audiences | `staff` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `object` | string | yes | min length 1, max length 80, pattern `^[a-z][a-z0-9]*\.[a-z][a-z0-9]*$` | An extension object (`<extension>.<object>`, see schema.objects) |
| `id` | string | yes | min length 1, max length 64 | Record id |
| `from` | integer | yes | ≥ 1, ≤ 9007199254740991 | A version number |
| `to` | integer |   | ≥ 1, ≤ 9007199254740991 | A version number. Default: the working copy |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `from` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |
| `to` | integer or null | yes |   | Null: the working copy |
| `changes` | array of object | yes |   |   |
| `changes[].field` | string | yes |   |   |
| `changes[].before` | any | yes |   |   |
| `changes[].after` | any | yes |   |   |

## record.count

Count live records of an object (person, organisation, task, activity, or an extension object `<extension>.<object>`) matching an optional structured filter, the same filter JSON as the object's list operation. Returns { count, capped }: counting stops at 10000, and capped is true when at least that many match. Use it for totals; read the records with the list operation. Read-only.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `read` |
| Audiences | `staff` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `object` | string | yes | min length 1, max length 80, pattern `^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)?$` | Object name, e.g. person or crm.project |
| `filter` | any |   |   | Structured filter: { and \| or: [...] } of { field, op, value }. |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `count` | integer | yes | ≥ 0, ≤ 9007199254740991 |   |
| `capped` | boolean | yes |   | True when at least 10000 records match |

## record.create

Create a record of an extension object (`<extension>.<object>`, see schema.objects) with field values by name. Formula fields are computed and cannot be set; relation fields take record ids (an array when the field holds many). Returns the stored record. Core objects (person, organisation, …) use their own create operations.

|  |  |
| --- | --- |
| Permission | `records:write` |
| Risk | `write` |
| Audiences | `staff` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `object` | string | yes | min length 1, max length 80, pattern `^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)?$` | Object: an extension object (`<extension>.<object>`) or a core object |
| `values` | map of any |   | default `{}` | Field values by registry field name (see schema.objects) |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `object` | string | yes |   |   |
| `id` | string | yes |   |   |
| `title` | string or null | yes |   |   |
| `values` | map of any | yes |   |   |
| `createdAt` | string or null | yes |   |   |
| `updatedAt` | string or null | yes |   |   |
| `warnings` | array of object |   |   | A shift's warnings (ADR 0622): its person away or not qualified, or nobody on it. The write was made. |
| `warnings[].code` | `"unavailable"`, `"not_qualified"`, `"uncovered"` | yes |   |   |
| `warnings[].object` | string | yes |   |   |
| `warnings[].id` | string | yes |   |   |
| `warnings[].account` | string or null | yes |   |   |
| `warnings[].message` | string | yes |   |   |

## record.createMany

Create up to 50 records of one extension object at once, in one batch: all of them or none (a value one record cannot take refuses the whole call, naming its index). Each is validated and recorded exactly as record.create does it. For generated records (the dated sessions of a program); one at a time is record.create. Returns the ids in the order given.

|  |  |
| --- | --- |
| Permission | `records:write` |
| Risk | `bulk-write` |
| Audiences | `staff` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `object` | string | yes | min length 1, max length 80, pattern `^[a-z][a-z0-9]*\.[a-z][a-z0-9]*$` | An extension object (`<extension>.<object>`, see schema.objects) |
| `records` | array of map of any | yes | at least 1, at most 50 | Field values by registry field name, one object per record |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `ids` | array of string | yes |   |   |

## record.delete

Move a record of an extension object to Trash (soft delete). It can be restored with record.restore for 30 days. Returns the id and the restore deadline.

|  |  |
| --- | --- |
| Permission | `records:write` |
| Risk | `destructive` |
| Audiences | `staff` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `object` | string | yes | min length 1, max length 80, pattern `^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)?$` | Object: an extension object (`<extension>.<object>`) or a core object |
| `id` | string | yes | min length 1, max length 64 | Record id |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `restorableUntil` | string | yes |   |   |

## record.get

Get one record by object and id. For extension objects returns every field; for core objects returns only the values of extension fields (use person.get etc. for core fields). Read-only.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `read` |
| Audiences | `staff` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `object` | string | yes | min length 1, max length 80, pattern `^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)?$` | Object: an extension object (`<extension>.<object>`) or a core object |
| `id` | string | yes | min length 1, max length 64 | Record id |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `object` | string | yes |   |   |
| `id` | string | yes |   |   |
| `title` | string or null | yes |   |   |
| `values` | map of any | yes |   |   |
| `createdAt` | string or null | yes |   |   |
| `updatedAt` | string or null | yes |   |   |

## record.groups

Count live records of an object per value of a single-select field or a single relation to an extension object (e.g. tasks per status, deals per stage), optionally summing a number or currency field per group, for records matching an optional filter. Board columns use it for their totals. Like record.count it reads at most 10000 matching records and reports capped above that. Read-only.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `read` |
| Audiences | `staff` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `object` | string | yes | min length 1, max length 80, pattern `^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)?$` |   |
| `groupBy` | string | yes | min length 1, max length 80 | A single-select field, or a relation (one) |
| `sumField` | string |   | min length 1, max length 80 | A number or currency field |
| `filter` | any |   |   |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `groups` | array of object | yes |   |   |
| `groups[].value` | string or null | yes |   | The choice, or null for records without one |
| `groups[].count` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |
| `groups[].sum` | number or null | yes |   |   |
| `capped` | boolean | yes |   |   |

## record.import

Import up to 25 records of one extension object from an outside source, each with a key the source gives it (its old id or file name). A key seen before updates its record, but only while the record still holds what the import last wrote: a record someone changed since is reported as a conflict and left alone. A new key creates a record. dryRun checks everything and says what would happen, writing nothing. A person's door: cos content import runs it.

|  |  |
| --- | --- |
| Permission | `records:write` |
| Risk | `bulk-write` |
| Audiences | `staff` |
| Actors | `human` |
| Also | not offered to MCP clients (`mcp.expose: false`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `object` | string | yes | min length 1, max length 80, pattern `^[a-z][a-z0-9]*\.[a-z][a-z0-9]*$` | An extension object (`<extension>.<object>`) |
| `records` | array of object | yes | at least 1, at most 25 |   |
| `records[].key` | string | yes | min length 1, max length 200 | The record's key in the source |
| `records[].values` | map of any | yes |   |   |
| `dryRun` | boolean |   | default `false` |   |
| `checkReferences` | boolean |   | default `true` | Check that relations and pictures name live records (a dry run may not yet) |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `results` | array of object | yes |   |   |
| `results[].key` | string | yes |   |   |
| `results[].id` | string or null | yes |   |   |
| `results[].outcome` | `"created"`, `"updated"`, `"unchanged"`, `"conflict"`, `"invalid"` | yes |   |   |
| `results[].fields` | array of string | yes |   |   |
| `results[].problems` | array of string | yes |   |   |

## record.list

List records of an extension object (or a core object's extension fields) with the same filter JSON, sort and cursor as other list operations. Every field in schema.objects is filterable, including formula fields; multi-valued fields match any value. Read-only.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `read` |
| Audiences | `staff` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `filter` | any |   |   | Structured filter: { and \| or: [...] } of { field, op, value }. |
| `sort` | object |   |   | Sort field and direction. Defaults per object. |
| `sort.field` | string | yes | min length 1, max length 64 |   |
| `sort.direction` | `"asc"`, `"desc"` |   | default `"asc"` |   |
| `cursor` | string |   | max length 1000 | nextCursor from the previous page. |
| `limit` | integer |   | ≥ 1, ≤ 200, default `50` |   |
| `fields` | array of string |   | at most 100 | Return only these fields of each item (id is always included). |
| `object` | string | yes | min length 1, max length 80, pattern `^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)?$` | Object: an extension object (`<extension>.<object>`) or a core object |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `items` | array of object | yes |   |   |
| `items[].object` | string | yes |   |   |
| `items[].id` | string | yes |   |   |
| `items[].title` | string or null | yes |   |   |
| `items[].values` | map of any | yes |   |   |
| `items[].createdAt` | string or null | yes |   |   |
| `items[].updatedAt` | string or null | yes |   |   |
| `nextCursor` | string or null | yes |   |   |

## record.publish

Publish a record of a publishable object (see schema.objects): its content fields as they are now become its next version, and the version readers are given. Editing the record afterwards changes no version until it is published again; what follows a version (a program's assignments) keeps the one it pinned. A person with the publish permission does it at once. An AI assistant, MCP client, automation or extension may call it too: then it never happens at once, under any approval policy. It waits for a person with the publish permission to approve it (the result says it is pending), and is refused on approval if the record changed since it was asked for. The account it acts for must hold the publish permission to ask. Returns the new version.

|  |  |
| --- | --- |
| Permission | `records:publish` |
| Risk | `write` |
| Audiences | `staff` |
| Also | always reviewed when called by `assistant`, `mcp`, `automation`, `extension` (`alwaysReview`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `object` | string | yes | min length 1, max length 80, pattern `^[a-z][a-z0-9]*\.[a-z][a-z0-9]*$` | An extension object (`<extension>.<object>`, see schema.objects) |
| `id` | string | yes | min length 1, max length 64 | Record id |
| `note` | string |   | min length 1, max length 500 | What changed, for the history |
| `readAgain` | boolean |   |   | Only on an object staff confirm they have read (see schema.objects, acknowledge): true asks everyone who must read it to confirm this version again; false is a small fix that keeps their confirmations. Required after the first version, which always asks. An AI's request carries it as a suggestion; the person who approves chooses. |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `version` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |
| `current` | boolean | yes |   | The version readers are given |
| `publishedAt` | string | yes |   |   |
| `publishedBy` | string or null | yes |   | The person who published it: for an approved request, the approver |
| `requestedBy` | string or null | yes |   | For an approved request: the staff user the AI actor asked for |
| `requestedVia` | string or null | yes |   | For an approved request: the actor that asked (assistant, mcp, ...) |
| `note` | string or null | yes |   |   |
| `bytes` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |
| `readAgain` | boolean or null | yes |   | On an object staff confirm (acknowledge): whether this version asked everyone who must read it again. Null elsewhere |

## record.publishDue

Platform use only: publish the scheduled publishes whose time has come (the minute cron), each as the snapshot the person who scheduled it took, in their name. A record deleted meanwhile, or no longer in a state it may be published in, loses its schedule. Returns the records published.

|  |  |
| --- | --- |
| Permission | `records:write` |
| Risk | `write` |
| Audiences | `staff` |
| Actors | `automation` |
| Also | not offered to MCP clients (`mcp.expose: false`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `limit` | integer |   | ≥ 1, ≤ 20, default `20` |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `published` | array of object | yes |   |   |
| `published[].object` | string | yes |   |   |
| `published[].id` | string | yes |   |   |
| `published[].version` | number | yes |   |   |
| `dropped` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |

## record.restore

Restore a record of an extension object from Trash (within 30 days of its deletion). Returns the restored record.

|  |  |
| --- | --- |
| Permission | `records:write` |
| Risk | `write` |
| Audiences | `staff` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `object` | string | yes | min length 1, max length 80, pattern `^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)?$` | Object: an extension object (`<extension>.<object>`) or a core object |
| `id` | string | yes | min length 1, max length 64 | Record id |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `object` | string | yes |   |   |
| `id` | string | yes |   |   |
| `title` | string or null | yes |   |   |
| `values` | map of any | yes |   |   |
| `createdAt` | string or null | yes |   |   |
| `updatedAt` | string or null | yes |   |   |

## record.restoreVersion

Copy a published version's content back into the record's working copy, as an ordinary edit (validated, audited, undoable by editing again). No version changes and nothing is published: publish afterwards to make it what readers are given. A content field the object no longer has is left out and listed in `skipped`. Returns the record.

|  |  |
| --- | --- |
| Permission | `records:write` |
| Risk | `write` |
| Audiences | `staff` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `object` | string | yes | min length 1, max length 80, pattern `^[a-z][a-z0-9]*\.[a-z][a-z0-9]*$` | An extension object (`<extension>.<object>`, see schema.objects) |
| `id` | string | yes | min length 1, max length 64 | Record id |
| `version` | integer | yes | ≥ 1, ≤ 9007199254740991 |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `record` | object | yes |   |   |
| `record.object` | string | yes |   |   |
| `record.id` | string | yes |   |   |
| `record.title` | string or null | yes |   |   |
| `record.values` | map of any | yes |   |   |
| `record.createdAt` | string or null | yes |   |   |
| `record.updatedAt` | string or null | yes |   |   |
| `skipped` | array of string | yes |   |   |

## record.schedulePublish

Schedule a record of a publishable object to be published at a time: its content fields as they are now are what goes live then (a later edit waits for the next publish). Replaces any earlier schedule; publishing now or unpublishing drops it. A person with the publish permission does it at once. An AI assistant, MCP client, automation or extension may call it too: then it never happens at once, under any approval policy. It waits for a person with the publish permission to approve it (the result says it is pending), and is refused on approval if the record changed since it was asked for. The account it acts for must hold the publish permission to ask. Returns the schedule.

|  |  |
| --- | --- |
| Permission | `records:publish` |
| Risk | `write` |
| Audiences | `staff` |
| Also | always reviewed when called by `assistant`, `mcp`, `automation`, `extension` (`alwaysReview`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `object` | string | yes | min length 1, max length 80, pattern `^[a-z][a-z0-9]*\.[a-z][a-z0-9]*$` | An extension object (`<extension>.<object>`, see schema.objects) |
| `id` | string | yes | min length 1, max length 64 | Record id |
| `at` | string (date-time) | yes | pattern `^(?:(?:\d\d[2468][048]\|\d\d[13579][26]\|\d\d0[48]\|[02468][048]00\|[13579][26]00)-02-29\|\d{4}-(?:(?:0[13578]\|1[02])-(?:0[1-9]\|[12]\d\|3[01])\|(?:0[469]\|11)-(?:0[1-9]\|[12]\d\|30)\|(?:02)-(?:0[1-9]\|1\d\|2[0-8])))T(?:(?:[01]\d\|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z\|([+-](?:[01]\d\|2[0-3]):[0-5]\d)))$` | When to publish it (ISO-8601, in the future) |
| `note` | string |   | min length 1, max length 500 | What changed, for the history |
| `readAgain` | boolean |   |   | Only on an object staff confirm they have read (see schema.objects, acknowledge): true asks everyone who must read it to confirm this version again; false is a small fix that keeps their confirmations. Required after the first version, which always asks. An AI's request carries it as a suggestion; the person who approves chooses. |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `publishAt` | string | yes |   | When it goes live (ISO-8601 UTC) |
| `scheduledBy` | string | yes |   | The person: for an approved request, the approver |
| `requestedBy` | string or null | yes |   | For an approved request: who the AI asked for |
| `requestedVia` | string or null | yes |   | For an approved request: the actor that asked |
| `note` | string or null | yes |   |   |
| `bytes` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |
| `readAgain` | boolean or null | yes |   | The read-again choice it goes live with |

## record.similar

Records most similar in meaning to one record (people like this person, organisations like this one, related notes), from its stored embedding. Status not_indexed when it has not been embedded yet, unavailable without semantic search. Read-only.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `read` |
| Audiences | `staff` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `object` | string | yes | min length 1, max length 80 |   |
| `id` | string | yes | min length 1, max length 80 |   |
| `objects` | array of string |   | at least 1, at most 20 |   |
| `limit` | integer |   | ≥ 1, ≤ 20, default `5` |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `status` | `"ok"`, `"unavailable"`, `"not_indexed"` | yes |   |   |
| `hits` | array of object | yes |   |   |
| `hits[].object` | string | yes |   | person, organisation, activity, task or &lt;extension&gt;.&lt;object&gt; |
| `hits[].id` | string | yes |   |   |
| `hits[].title` | string | yes |   |   |
| `hits[].subtitle` | string or null | yes |   |   |
| `hits[].titleHighlight` | array of object | yes |   |   |
| `hits[].titleHighlight[].text` | string | yes |   |   |
| `hits[].titleHighlight[].match` | boolean | yes |   |   |
| `hits[].snippet` | array of object or null | yes |   |   |
| `hits[].snippet.text` | string | yes |   |   |
| `hits[].snippet.match` | boolean | yes |   |   |
| `hits[].score` | number | yes |   |   |
| `hits[].matchedBy` | array of `"text"`, `"meaning"` | yes |   |   |
| `hits[].text` | string |   |   |   |
| `message` | string or null | yes |   |   |

## record.unpublish

Unpublish a record of a publishable object: the public no longer reads it (it answers as a record that does not exist) and any scheduled publish is dropped. Its versions are kept and it can be published again. A person with the publish permission does it at once. An AI assistant, MCP client, automation or extension may call it too: then it never happens at once, under any approval policy. It waits for a person with the publish permission to approve it (the result says it is pending), and is refused on approval if the record changed since it was asked for. The account it acts for must hold the publish permission to ask.

|  |  |
| --- | --- |
| Permission | `records:publish` |
| Risk | `write` |
| Audiences | `staff` |
| Also | always reviewed when called by `assistant`, `mcp`, `automation`, `extension` (`alwaysReview`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `object` | string | yes | min length 1, max length 80, pattern `^[a-z][a-z0-9]*\.[a-z][a-z0-9]*$` | An extension object (`<extension>.<object>`, see schema.objects) |
| `id` | string | yes | min length 1, max length 64 | Record id |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `unpublished` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 | The version that was live |

## record.update

Update field values of a record. On extension objects any writable field; on core objects only extension fields (named `<extension>.<field>`). Pass null to clear a value. Changes are recorded in the record's history; fields tracked on the timeline post a system activity. Returns the stored record.

|  |  |
| --- | --- |
| Permission | `records:write` |
| Risk | `write` |
| Audiences | `staff` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `object` | string | yes | min length 1, max length 80, pattern `^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)?$` | Object: an extension object (`<extension>.<object>`) or a core object |
| `id` | string | yes | min length 1, max length 64 | Record id |
| `values` | map of any | yes |   | Field values by registry field name (see schema.objects) |
| `from` | string |   | min length 1, max length 64 | Only move the record if it is still in this state (or stage id), and move it out of it: for a write two people may make at once, such as checking a ticket in. Refused as a conflict (reason not_in_position or moved_meanwhile) when the record has left it. |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `object` | string | yes |   |   |
| `id` | string | yes |   |   |
| `title` | string or null | yes |   |   |
| `values` | map of any | yes |   |   |
| `createdAt` | string or null | yes |   |   |
| `updatedAt` | string or null | yes |   |   |
| `warnings` | array of object |   |   | A shift's warnings (ADR 0622): its person away or not qualified, or nobody on it. The write was made. |
| `warnings[].code` | `"unavailable"`, `"not_qualified"`, `"uncovered"` | yes |   |   |
| `warnings[].object` | string | yes |   |   |
| `warnings[].id` | string | yes |   |   |
| `warnings[].account` | string or null | yes |   |   |
| `warnings[].message` | string | yes |   |   |

## record.version

One published version of a record of a publishable object: its content fields as they were published. Without `version`, the current one (what readers are given). Not found when the record has never been published. Read-only.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `read` |
| Audiences | `staff` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `object` | string | yes | min length 1, max length 80, pattern `^[a-z][a-z0-9]*\.[a-z][a-z0-9]*$` | An extension object (`<extension>.<object>`, see schema.objects) |
| `id` | string | yes | min length 1, max length 64 | Record id |
| `version` | integer |   | ≥ 1, ≤ 9007199254740991 | Default: the current version |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `version` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |
| `current` | boolean | yes |   | The version readers are given |
| `publishedAt` | string | yes |   |   |
| `publishedBy` | string or null | yes |   | The person who published it: for an approved request, the approver |
| `requestedBy` | string or null | yes |   | For an approved request: the staff user the AI actor asked for |
| `requestedVia` | string or null | yes |   | For an approved request: the actor that asked (assistant, mcp, ...) |
| `note` | string or null | yes |   |   |
| `bytes` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |
| `readAgain` | boolean or null | yes |   | On an object staff confirm (acknowledge): whether this version asked everyone who must read it again. Null elsewhere |
| `values` | map of any | yes |   |   |

## record.versions

The published versions of a record of a publishable object, newest first: number, when, who published it (for an approved request, the approver, and who asked, and how), the note, size, and which one is current (what readers are given). Read one with record.version. Read-only.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `read` |
| Audiences | `staff` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `object` | string | yes | min length 1, max length 80, pattern `^[a-z][a-z0-9]*\.[a-z][a-z0-9]*$` | An extension object (`<extension>.<object>`, see schema.objects) |
| `id` | string | yes | min length 1, max length 64 | Record id |
| `limit` | integer |   | ≥ 1, ≤ 200, default `50` |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `items` | array of object | yes |   |   |
| `items[].version` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |
| `items[].current` | boolean | yes |   | The version readers are given |
| `items[].publishedAt` | string | yes |   |   |
| `items[].publishedBy` | string or null | yes |   | The person who published it: for an approved request, the approver |
| `items[].requestedBy` | string or null | yes |   | For an approved request: the staff user the AI actor asked for |
| `items[].requestedVia` | string or null | yes |   | For an approved request: the actor that asked (assistant, mcp, ...) |
| `items[].note` | string or null | yes |   |   |
| `items[].bytes` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |
| `items[].readAgain` | boolean or null | yes |   | On an object staff confirm (acknowledge): whether this version asked everyone who must read it again. Null elsewhere |
