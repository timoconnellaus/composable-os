---
title: "ack.* operations"
description: "The core operations named ack.*"
sidebar:
  label: "ack"
editUrl: false
---

## ack.confirm

Confirm that I have read and understood the current version of a record staff must read (a procedure): one tap, by the person themselves. Refused for a version that is not the current one, a record I am not asked to read, and a second time for the same version. A confirmation is never changed or deleted. Not for an AI actor.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `write` |
| Audiences | `staff` |
| Actors | `human`, `extension` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `object` | string | yes | min length 1, max length 80 | An object staff confirm they have read (see schema.objects, acknowledge) |
| `id` | string | yes | min length 1, max length 64 | Record id |
| `version` | integer | yes | ≥ 1, ≤ 9007199254740991 | The version I read: the current one |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `version` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |
| `confirmedAt` | string | yes |   |   |
| `object` | string | yes |   |   |
| `id` | string | yes |   |   |

## ack.mine

What I must read and have not confirmed (each published record that asks me, with its current version), and what I have confirmed and when. For the person themselves; not for an AI actor. Read-only.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `read` |
| Audiences | `staff` |
| Actors | `human`, `extension` |

### Input

No fields.

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `toRead` | array of object | yes |   |   |
| `toRead[].object` | string | yes |   |   |
| `toRead[].id` | string | yes |   |   |
| `toRead[].title` | string or null | yes |   |   |
| `toRead[].version` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 | The current version: confirm this one |
| `toRead[].publishedAt` | string | yes |   |   |
| `toRead[].since` | string | yes |   | When it became mine to read: the version that asked everyone |
| `confirmed` | array of object | yes |   |   |
| `confirmed[].object` | string | yes |   |   |
| `confirmed[].id` | string | yes |   |   |
| `confirmed[].title` | string or null | yes |   |   |
| `confirmed[].version` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 | The current version: confirm this one |
| `confirmed[].publishedAt` | string | yes |   |   |
| `confirmed[].confirmedAt` | string | yes |   |   |

## ack.overview

Every published record staff must read, of the objects the caller manages: its current version, how many must read it and how many have confirmed what counts. For admins and people granted an object's manage permission; never for an AI actor. Read-only.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `read` |
| Audiences | `staff` |
| Actors | `human` |

### Input

No fields.

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `items` | array of object | yes |   |   |
| `items[].object` | string | yes |   |   |
| `items[].id` | string | yes |   |   |
| `items[].title` | string or null | yes |   |   |
| `items[].version` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |
| `items[].publishedAt` | string | yes |   |   |
| `items[].mustRead` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |
| `items[].confirmed` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |

## ack.status

For one published record staff must read (a procedure), its current version: everyone who must read it, who has confirmed it (and when), and who has not (and since when). For admins and people granted the object's manage permission; never for an AI actor. Read-only.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `read` |
| Audiences | `staff` |
| Actors | `human` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `object` | string | yes | min length 1, max length 80 | An object staff confirm they have read (see schema.objects, acknowledge) |
| `id` | string | yes | min length 1, max length 64 | Record id |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `object` | string | yes |   |   |
| `id` | string | yes |   |   |
| `title` | string or null | yes |   |   |
| `version` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |
| `publishedAt` | string | yes |   |   |
| `askedVersion` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 | The version from which confirmations count |
| `everyone` | boolean | yes |   | Every staff account must read it |
| `roles` | array of string | yes |   | Otherwise: the roles, pack roles and grants that must |
| `people` | array of object | yes |   |   |
| `people[].account` | string | yes |   |   |
| `people[].name` | string | yes |   |   |
| `people[].email` | string | yes |   |   |
| `people[].confirmed` | object or null | yes |   | The confirmation that counts for the current version, if any |
| `people[].confirmed.version` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |
| `people[].confirmed.confirmedAt` | string | yes |   |   |
| `people[].lastConfirmed` | object or null | yes |   | Their latest confirmation, of any version (an older one no longer counts) |
| `people[].lastConfirmed.version` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |
| `people[].lastConfirmed.confirmedAt` | string | yes |   |   |
| `people[].since` | string or null | yes |   | Not confirmed: since when it has been theirs to read |
