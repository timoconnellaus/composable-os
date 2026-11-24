---
title: "duplicate.* operations"
description: "The core operations named duplicate.*"
sidebar:
  label: "duplicate"
editUrl: false
---

## duplicate.check

Check whether a person or organisation you are about to create already exists, by plain rules (no score). Returns conflicts, which would block the create (a live email or domain already belongs to that record), and warnings, which do not block (people: same name and same organisation, same name and same email domain, same phone number, same name only; organisations: same name, or a website at a domain another organisation holds). Each comes with the existing record's id, name and reasons, at most 5 of each. Pass exceptId when checking an existing record's new values. Read-only.

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
| `conflicts` | array of object | yes |   |   |
| `conflicts[].id` | string | yes |   | The existing record's id |
| `conflicts[].title` | string | yes |   | Its name |
| `conflicts[].rules` | array of `"same_email"`, `"same_name_organisation"`, `"same_name_email_domain"`, `"same_phone"`, `"same_name_only"`, `"same_domain"`, `"same_name"` | yes |   |   |
| `conflicts[].reasons` | array of string | yes |   | One plain sentence per rule, e.g. 'Same name only' |
| `warnings` | array of object | yes |   |   |
| `warnings[].id` | string | yes |   | The existing record's id |
| `warnings[].title` | string | yes |   | Its name |
| `warnings[].rules` | array of `"same_email"`, `"same_name_organisation"`, `"same_name_email_domain"`, `"same_phone"`, `"same_name_only"`, `"same_domain"`, `"same_name"` | yes |   |   |
| `warnings[].reasons` | array of string | yes |   | One plain sentence per rule, e.g. 'Same name only' |

## duplicate.count

How many open duplicate pairs await review, for people and organisations (counted up to 1000). Read-only.

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
| `person` | number | yes |   |   |
| `organisation` | number | yes |   |   |
| `total` | number | yes |   |   |

## duplicate.dismiss

Mark suggested duplicates as not duplicates: every open pair among the given records (two ids for one pair; a whole group's ids to dismiss all in the group). A dismissed pair is never suggested again. Records are not changed. Returns how many pairs were dismissed.

|  |  |
| --- | --- |
| Permission | `records:write` |
| Risk | `write` |
| Audiences | `staff` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `object` | `"person"`, `"organisation"` | yes |   |   |
| `ids` | array of string | yes | at least 2, at most 50 | The records that are not duplicates |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `dismissed` | number | yes |   |   |

## duplicate.list

List likely duplicate people or organisations found by the scan, for review, grouped (A, B and C sharing a name and organisation are one group). Each group has its members side by side, the rules matched with a plain reason per pair, the proposed survivor (more linked activities, then the older record) and the fields that differ. Groups that share only a name come last (kind nameOnly) and are never pre-selected. Filter by rule. Dismissed pairs are not listed. Merge with duplicate.mergeMany. Read-only.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `read` |
| Audiences | `staff` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `object` | `"person"`, `"organisation"` | yes |   |   |
| `rule` | `"same_email"`, `"same_name_organisation"`, `"same_name_email_domain"`, `"same_phone"`, `"same_name_only"`, `"same_domain"`, `"same_name"` |   |   | Only pairs matching this rule |
| `kind` | `"likely"`, `"nameOnly"` |   |   |   |
| `limit` | integer |   | ≥ 1, ≤ 100, default `50` | Groups per call |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `groups` | array of object | yes |   |   |
| `groups[].id` | string | yes |   | Stable for these members: the kind and the first member id |
| `groups[].kind` | `"likely"`, `"nameOnly"` | yes |   | nameOnly groups share only a name; they are listed separately |
| `groups[].members` | array of object | yes |   |   |
| `groups[].members[].id` | string | yes |   |   |
| `groups[].members[].title` | string | yes |   |   |
| `groups[].members[].createdAt` | string | yes |   |   |
| `groups[].members[].activityCount` | number | yes |   |   |
| `groups[].members[].fields` | array of object | yes |   | Values to compare side by side |
| `groups[].members[].fields[].field` | string | yes |   |   |
| `groups[].members[].fields[].label` | string | yes |   |   |
| `groups[].members[].fields[].value` | string or null | yes |   |   |
| `groups[].pairs` | array of object | yes |   |   |
| `groups[].pairs[].aId` | string | yes |   |   |
| `groups[].pairs[].bId` | string | yes |   |   |
| `groups[].pairs[].rules` | array of `"same_email"`, `"same_name_organisation"`, `"same_name_email_domain"`, `"same_phone"`, `"same_name_only"`, `"same_domain"`, `"same_name"` | yes |   |   |
| `groups[].pairs[].reasons` | array of string | yes |   |   |
| `groups[].rules` | array of `"same_email"`, `"same_name_organisation"`, `"same_name_email_domain"`, `"same_phone"`, `"same_name_only"`, `"same_domain"`, `"same_name"` | yes |   |   |
| `groups[].reasons` | array of string | yes |   |   |
| `groups[].survivorId` | string | yes |   | Proposed survivor: more linked activities, then the older |
| `groups[].survivorReason` | string | yes |   |   |
| `groups[].differingFields` | array of string | yes |   | Fields whose values differ between members |
| `groups[].preselected` | boolean | yes |   | Pre-selected for bulk merge (never for name only) |
| `total` | number | yes |   | Groups matching, before the limit |
| `truncated` | boolean | yes |   | More than 2000 open pairs: narrow by rule to see the rest |

## duplicate.mergeMany

Merge groups of duplicates: for each group, every id in mergedIds is merged into survivorId by calling person.merge or organisation.merge once per duplicate, as you, so each merge is gated, simulated and audited exactly like a single merge (the survivor keeps its values, empty ones are filled from the duplicate). At most 50 groups and 200 records per call. A failure in one merge does not stop the others; each group reports what merged, what failed and why, and what is waiting for review. When the merges need review (AI clients usually do), they go into one titled change set, e.g. 'Merge 12 duplicate people', reviewed whole or per item.

|  |  |
| --- | --- |
| Permission | `records:write` |
| Risk | `write` |
| Audiences | `staff` |
| Also | bookkeeping, never queued for review |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `object` | `"person"`, `"organisation"` | yes |   |   |
| `groups` | array of object | yes | at least 1, at most 50 |   |
| `groups[].survivorId` | string | yes | max length 64, pattern `^(per\|org)_` | The record that remains |
| `groups[].mergedIds` | array of string | yes | at least 1, at most 50 | Duplicates merged into it |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `results` | array of object | yes |   |   |
| `results[].survivorId` | string | yes |   |   |
| `results[].merged` | array of string | yes |   | Merged into the survivor |
| `results[].queued` | array of object | yes |   | Waiting for review in the change set |
| `results[].queued[].id` | string | yes |   |   |
| `results[].queued[].pendingActionId` | string | yes |   |   |
| `results[].failed` | array of object | yes |   |   |
| `results[].failed[].id` | string | yes |   |   |
| `results[].failed[].code` | string | yes |   |   |
| `results[].failed[].message` | string | yes |   |   |
| `merged` | number | yes |   |   |
| `queued` | number | yes |   |   |
| `failed` | number | yes |   |   |
| `changeSetId` | string or null | yes |   |   |

## duplicate.scan

Look for duplicates and store them for review (duplicate.list). incremental looks only at records created or changed since the last scan (it runs nightly and after an import); full (admins) looks at every record; continue carries on work in progress. Each call does a bounded amount of work: call again while done is false. Records are not changed.

|  |  |
| --- | --- |
| Permission | `records:write` |
| Risk | `write` |
| Audiences | `staff` |
| Also | bookkeeping, never queued for review |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `mode` | `"incremental"`, `"full"`, `"continue"` |   | default `"incremental"` |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `ran` | array of `"backfill"`, `"full"`, `"incremental"` | yes |   |   |
| `found` | number | yes |   | Pairs found or confirmed in this call |
| `changed` | number | yes |   | Changed records looked at in this call |
| `done` | boolean | yes |   |   |
| `status` | object | yes |   |   |
| `status.backfillDone` | boolean | yes |   |   |
| `status.fullScanRunning` | boolean | yes |   |   |
| `status.pending` | boolean | yes |   | More work is waiting (the backfill, a full scan or a backlog) |
| `status.lastFullAt` | string or null | yes |   |   |
| `status.lastIncrementalAt` | string or null | yes |   |   |

## duplicate.settings

The duplicate settings (how many people may share a phone number before it stops counting as a match) and the scan's status: last full and incremental scans, and whether work is in progress. Read-only.

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
| `settings` | object | yes |   |   |
| `settings.phoneShareLimit` | integer | yes | ≥ 1, ≤ 50, default `3` | A phone number held by more than this many people (a shared office line) is not used for the same phone number rule. |
| `status` | object | yes |   |   |
| `status.backfillDone` | boolean | yes |   |   |
| `status.fullScanRunning` | boolean | yes |   |   |
| `status.pending` | boolean | yes |   | More work is waiting (the backfill, a full scan or a backlog) |
| `status.lastFullAt` | string or null | yes |   |   |
| `status.lastIncrementalAt` | string or null | yes |   |   |

## duplicate.updateSettings

Change the duplicate settings (admins): phoneShareLimit is how many people may hold the same phone number before it stops counting for the same phone number rule (default 3), so a shared office line does not flood suggestions. Takes effect at the next scan.

|  |  |
| --- | --- |
| Permission | `settings:manage` |
| Risk | `write` |
| Audiences | `staff` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `phoneShareLimit` | integer | yes | ≥ 1, ≤ 50 |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `phoneShareLimit` | integer | yes | ≥ 1, ≤ 50, default `3` | A phone number held by more than this many people (a shared office line) is not used for the same phone number rule. |
