---
title: "trash.* operations"
description: "The core operations named trash.*"
sidebar:
  label: "trash"
editUrl: false
---

## trash.list

List what is in Trash: soft-deleted people, organisations, activities and tasks, most recently deleted first, each with when it was deleted and the date it stays restorable until (30 days). Merged-away records show the record they were merged into. Restore with person.restore, organisation.restore, activity.restore or task.restore. Pass nextCursor back as cursor for the next page. Read-only.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `read` |
| Audiences | `staff` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `object` | `"person"`, `"organisation"`, `"activity"`, `"task"`, `"media"` |   |   | Only this kind of record |
| `cursor` | string |   | max length 1000 | nextCursor from the previous page. |
| `limit` | integer |   | ≥ 1, ≤ 200, default `50` |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `items` | array of object | yes |   |   |
| `items[].object` | `"person"`, `"organisation"`, `"activity"`, `"task"`, `"media"` | yes |   |   |
| `items[].id` | string | yes |   |   |
| `items[].name` | string | yes |   | Display name, task title, or activity subject (or body excerpt) |
| `items[].deletedAt` | string | yes |   |   |
| `items[].deletedBy` | string or null | yes |   |   |
| `items[].restorableUntil` | string | yes |   | After this the scheduled purge deletes it for good |
| `items[].mergedIntoId` | string or null | yes |   | Set when it was merged away into this record |
| `nextCursor` | string or null | yes |   |   |

## trash.purge

Permanently delete everything that has been in Trash for more than 30 days (oldest first, at most limit per call): people and organisations with their emails, phones, domains, addresses, affiliations, tags and links, and deleted activities and tasks with their links and search entries. Live activities and tasks linked to a purged record are kept (they lose only that link). Run by the scheduled purge as an automation; it never touches records still within their restore window. Returns what was purged and whether more is due.

|  |  |
| --- | --- |
| Permission | `records:erase` |
| Risk | `write` |
| Audiences | `staff` |
| Actors | `automation` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `limit` | integer |   | ≥ 1, ≤ 100, default `50` |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `cutoff` | string | yes |   | Records deleted before this were due |
| `purged` | array of object | yes |   |   |
| `purged[].object` | `"person"`, `"organisation"`, `"activity"`, `"task"`, `"media"` | yes |   |   |
| `purged[].id` | string | yes |   |   |
| `purged[].deletedAt` | string | yes |   |   |
| `more` | boolean | yes |   | True when more records are due; call again |
