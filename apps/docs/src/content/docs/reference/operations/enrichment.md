---
title: "enrichment.* operations"
description: "The core operations named enrichment.*"
sidebar:
  label: "enrichment"
editUrl: false
---

## enrichment.enrichNow

Enrich a person or organisation from ZoomInfo now, through the org's ZoomInfo connection. Spends ZoomInfo credits, so it is an outbound action: a person's click applies it, an AI's request waits for approval. Once applied, empty fields on the record (location, phone, website, industry, description) are filled from the result; existing values are never overwritten. Nothing is polled or scheduled.

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
| `id` | string | yes | min length 4, max length 64 |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `status` | `"pending"`, `"applied"`, `"unavailable"` | yes |   |   |
| `message` | string | yes |   |   |
| `pendingActionId` | string |   |   |   |
| `filled` | array of string |   |   |   |
