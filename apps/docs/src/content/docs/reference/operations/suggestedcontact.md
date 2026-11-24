---
title: "suggestedContact.* operations"
description: "The core operations named suggestedContact.*"
sidebar:
  label: "suggestedContact"
editUrl: false
---

## suggestedContact.add

Add suggested contacts as people: each becomes a person with that email (and name), affiliated with the organisation that owns their domain, or with organisationId, or with a new organisation for the domain when createOrganisation is true. Runs person.create (and organisation.create, affiliation.create) through the approval pipeline as you, so an AI caller's creates may wait for approval. Returns what was created.

|  |  |
| --- | --- |
| Permission | `records:write` |
| Risk | `write` |
| Audiences | `staff` |
| Also | bookkeeping, never queued for review |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `emails` | array of string | yes | at least 1, at most 50 |   |
| `organisationId` | string (starts_with) |   | max length 64, pattern `^org_.*` |   |
| `createOrganisation` | boolean |   | default `false` |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `added` | array of object | yes |   |   |
| `added[].email` | string | yes |   |   |
| `added[].personId` | string | yes |   |   |
| `organisationIds` | array of string | yes |   |   |

## suggestedContact.dismiss

Dismiss suggested contacts (by email, or a whole domain) so they stop appearing in the inbox. Nothing else changes.

|  |  |
| --- | --- |
| Permission | `records:write` |
| Risk | `write` |
| Audiences | `staff` |
| Also | bookkeeping, never queued for review |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `emails` | array of string |   | at least 1, at most 200 |   |
| `domain` | string |   | min length 3, max length 253 |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `dismissed` | number | yes |   |   |

## suggestedContact.list

The Suggested contacts inbox: external people the org has emailed with at least twice who are not in the CRM yet, grouped by their email domain (with the organisation that owns the domain, if any), busiest first. Add them with suggestedContact.add or dismiss them with suggestedContact.dismiss. Read-only.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `read` |
| Audiences | `staff` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `limit` | integer |   | ≥ 1, ≤ 100, default `50` | Domains per page |
| `minMessages` | integer |   | ≥ 1, ≤ 100, default `2` |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `groups` | array of object | yes |   |   |
| `groups[].domain` | string | yes |   |   |
| `groups[].organisation` | object or null | yes |   |   |
| `groups[].organisation.id` | string | yes |   |   |
| `groups[].organisation.name` | string | yes |   |   |
| `groups[].messageCount` | number | yes |   |   |
| `groups[].contacts` | array of object | yes |   |   |
| `groups[].contacts[].email` | string | yes |   |   |
| `groups[].contacts[].name` | string or null | yes |   |   |
| `groups[].contacts[].messageCount` | number | yes |   |   |
| `groups[].contacts[].firstSeenAt` | string | yes |   |   |
| `groups[].contacts[].lastSeenAt` | string | yes |   |   |
| `total` | number | yes |   |   |
