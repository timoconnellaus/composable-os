---
title: "affiliation.* operations"
description: "The core operations named affiliation.*"
sidebar:
  label: "affiliation"
editUrl: false
---

## affiliation.create

Link a person to an organisation (a job or other relationship) with an optional title, role, start and end date. It is current unless current is false or endedOn is given. A person has at most one primary affiliation, which gives them their job title: primary defaults to true when the person has no current primary one, and making this one primary takes the flag from the previous one. To record that someone moved jobs, use person.changeJob instead, which also ends the old affiliation and posts a Job change on the timelines. Returns the affiliation.

|  |  |
| --- | --- |
| Permission | `records:write` |
| Risk | `write` |
| Audiences | `staff` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `personId` | string (starts_with) | yes | max length 64, pattern `^per_.*` | Person id (per_…) |
| `organisationId` | string (starts_with) | yes | max length 64, pattern `^org_.*` | Organisation id (org_…) |
| `title` | string or null |   |   |   |
| `role` | string or null |   |   |   |
| `startedOn` | string or null |   |   |   |
| `endedOn` | string or null |   |   |   |
| `current` | boolean |   |   | Default: true unless endedOn is given |
| `primary` | boolean |   |   | Make this the person's primary affiliation |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `personId` | string | yes |   |   |
| `personName` | string or null | yes |   |   |
| `organisationId` | string | yes |   |   |
| `organisationName` | string or null | yes |   |   |
| `title` | string or null | yes |   | Job title |
| `role` | string or null | yes |   | Role in the relationship, e.g. Decision maker |
| `startedOn` | string or null | yes |   |   |
| `endedOn` | string or null | yes |   |   |
| `current` | boolean | yes |   |   |
| `primary` | boolean | yes |   |   |
| `createdAt` | string | yes |   |   |
| `updatedAt` | string | yes |   |   |

## affiliation.end

End an affiliation: it stops being current (and primary) and gets an end date, default today. It stays in the person's job history. Fails if it has already ended. To end a job and start a new one together, use person.changeJob. Returns the affiliation.

|  |  |
| --- | --- |
| Permission | `records:write` |
| Risk | `write` |
| Audiences | `staff` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string (starts_with) | yes | max length 64, pattern `^aff_.*` | Affiliation id (aff_…) |
| `endedOn` | string |   | pattern `^\d{4}-\d{2}-\d{2}$` | Calendar date, YYYY-MM-DD |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `personId` | string | yes |   |   |
| `personName` | string or null | yes |   |   |
| `organisationId` | string | yes |   |   |
| `organisationName` | string or null | yes |   |   |
| `title` | string or null | yes |   | Job title |
| `role` | string or null | yes |   | Role in the relationship, e.g. Decision maker |
| `startedOn` | string or null | yes |   |   |
| `endedOn` | string or null | yes |   |   |
| `current` | boolean | yes |   |   |
| `primary` | boolean | yes |   |   |
| `createdAt` | string | yes |   |   |
| `updatedAt` | string | yes |   |   |

## affiliation.list

List a person's affiliations (their job history) or an organisation's (its current and past people), current ones first, then by start date, newest first. Pass personId or organisationId. Read-only.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `read` |
| Audiences | `staff` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `personId` | string (starts_with) |   | max length 64, pattern `^per_.*` | Person id (per_…) |
| `organisationId` | string (starts_with) |   | max length 64, pattern `^org_.*` | Organisation id (org_…) |
| `currentOnly` | boolean |   | default `false` |   |
| `limit` | integer |   | ≥ 1, ≤ 500, default `200` |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `items` | array of object | yes |   |   |
| `items[].id` | string | yes |   |   |
| `items[].personId` | string | yes |   |   |
| `items[].personName` | string or null | yes |   |   |
| `items[].organisationId` | string | yes |   |   |
| `items[].organisationName` | string or null | yes |   |   |
| `items[].title` | string or null | yes |   | Job title |
| `items[].role` | string or null | yes |   | Role in the relationship, e.g. Decision maker |
| `items[].startedOn` | string or null | yes |   |   |
| `items[].endedOn` | string or null | yes |   |   |
| `items[].current` | boolean | yes |   |   |
| `items[].primary` | boolean | yes |   |   |
| `items[].createdAt` | string | yes |   |   |
| `items[].updatedAt` | string | yes |   |   |

## affiliation.update

Update an affiliation's title, role, dates, current or primary flags. Only the fields you pass change; pass null to clear one. Making it primary takes the flag from the person's other affiliation; marking it not current also drops primary. Use affiliation.end to end one, and person.changeJob for a job change. Returns the affiliation.

|  |  |
| --- | --- |
| Permission | `records:write` |
| Risk | `write` |
| Audiences | `staff` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string (starts_with) | yes | max length 64, pattern `^aff_.*` | Affiliation id (aff_…) |
| `title` | string or null |   |   |   |
| `role` | string or null |   |   |   |
| `startedOn` | string or null |   |   |   |
| `endedOn` | string or null |   |   |   |
| `current` | boolean |   |   |   |
| `primary` | boolean |   |   |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `personId` | string | yes |   |   |
| `personName` | string or null | yes |   |   |
| `organisationId` | string | yes |   |   |
| `organisationName` | string or null | yes |   |   |
| `title` | string or null | yes |   | Job title |
| `role` | string or null | yes |   | Role in the relationship, e.g. Decision maker |
| `startedOn` | string or null | yes |   |   |
| `endedOn` | string or null | yes |   |   |
| `current` | boolean | yes |   |   |
| `primary` | boolean | yes |   |   |
| `createdAt` | string | yes |   |   |
| `updatedAt` | string | yes |   |   |
