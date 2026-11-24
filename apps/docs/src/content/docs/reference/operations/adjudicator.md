---
title: "adjudicator.* operations"
description: "The core operations named adjudicator.*"
sidebar:
  label: "adjudicator"
editUrl: false
---

## adjudicator.agreement

How the policy adjudicator's verdicts compare with people's decisions on the same pending actions over the last `days` days: agreement rate, approve precision, escalation rate, the verdict × decision confusion matrix, and the same by day or week. Admins only, people only. Read-only.

|  |  |
| --- | --- |
| Permission | `policy:manage` |
| Risk | `read` |
| Audiences | `staff` |
| Actors | `human` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `days` | integer |   | ≥ 1, ≤ 365, default `30` |   |
| `bucket` | `"day"`, `"week"` |   | default `"day"` |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `from` | string | yes |   |   |
| `to` | string | yes |   |   |
| `count` | number | yes |   |   |
| `decided` | number | yes |   |   |
| `agreement` | number or null | yes |   |   |
| `approvePrecision` | number or null | yes |   |   |
| `escalationRate` | number or null | yes |   |   |
| `autoApproved` | number | yes |   |   |
| `confusion` | object | yes |   |   |
| `confusion.approve` | object | yes |   |   |
| `confusion.approve.approved` | number | yes |   |   |
| `confusion.approve.rejected` | number | yes |   |   |
| `confusion.approve.undecided` | number | yes |   |   |
| `confusion.deny` | object | yes |   |   |
| `confusion.deny.approved` | number | yes |   |   |
| `confusion.deny.rejected` | number | yes |   |   |
| `confusion.deny.undecided` | number | yes |   |   |
| `confusion.escalate` | object | yes |   |   |
| `confusion.escalate.approved` | number | yes |   |   |
| `confusion.escalate.rejected` | number | yes |   |   |
| `confusion.escalate.undecided` | number | yes |   |   |
| `periods` | array of object | yes |   |   |
| `periods[].period` | string | yes |   |   |
| `periods[].count` | number | yes |   |   |
| `periods[].decided` | number | yes |   |   |
| `periods[].agreed` | number | yes |   |   |
| `periods[].agreement` | number or null | yes |   |   |
| `capped` | boolean | yes |   |   |

## adjudicator.get

The policy adjudicator's settings (mode off, shadow or active; confidence threshold), the written policy in force, and the models behind the review and assistant roles. Admins only, people only. Read-only.

|  |  |
| --- | --- |
| Permission | `policy:manage` |
| Risk | `read` |
| Audiences | `staff` |
| Actors | `human` |

### Input

No fields.

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `mode` | `"off"`, `"shadow"`, `"active"` | yes |   |   |
| `threshold` | number | yes |   |   |
| `enabledAt` | string or null | yes |   |   |
| `policy` | object or null | yes |   |   |
| `policy.version` | number | yes |   |   |
| `policy.text` | string | yes |   |   |
| `policy.hash` | string | yes |   |   |
| `policy.createdAt` | string | yes |   |   |
| `policy.createdBy` | string | yes |   |   |
| `policy.createdByName` | string or null | yes |   |   |
| `models` | object or null | yes |   |   |
| `models.review` | object | yes |   |   |
| `models.review.provider` | string | yes |   |   |
| `models.review.model` | string | yes |   |   |
| `models.assistant` | object | yes |   |   |
| `models.assistant.provider` | string | yes |   |   |
| `models.assistant.model` | string | yes |   |   |
| `sameModelAsAssistant` | boolean | yes |   |   |
| `reviewer` | `"llm"`, `"jev"` | yes |   |   |
| `reviewerSetting` | `"llm"`, `"jev"` or null | yes |   |   |
| `judgeAvailable` | boolean | yes |   |   |
| `rules` | array of object | yes |   |   |
| `rules[].number` | number | yes |   |   |
| `rules[].text` | string | yes |   |   |
| `maxRules` | number | yes |   |   |

## adjudicator.setPolicy

Replace the org's written policy: the plain-language rules the policy adjudicator judges pending changes against. Each save is a new version; verdicts record the version they used. Admins only, people only.

|  |  |
| --- | --- |
| Permission | `policy:manage` |
| Risk | `write` |
| Audiences | `staff` |
| Actors | `human` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `text` | string | yes | min length 1, max length 20000 | The written policy, plain text or Markdown |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `mode` | `"off"`, `"shadow"`, `"active"` | yes |   |   |
| `threshold` | number | yes |   |   |
| `enabledAt` | string or null | yes |   |   |
| `policy` | object or null | yes |   |   |
| `policy.version` | number | yes |   |   |
| `policy.text` | string | yes |   |   |
| `policy.hash` | string | yes |   |   |
| `policy.createdAt` | string | yes |   |   |
| `policy.createdBy` | string | yes |   |   |
| `policy.createdByName` | string or null | yes |   |   |
| `models` | object or null | yes |   |   |
| `models.review` | object | yes |   |   |
| `models.review.provider` | string | yes |   |   |
| `models.review.model` | string | yes |   |   |
| `models.assistant` | object | yes |   |   |
| `models.assistant.provider` | string | yes |   |   |
| `models.assistant.model` | string | yes |   |   |
| `sameModelAsAssistant` | boolean | yes |   |   |
| `reviewer` | `"llm"`, `"jev"` | yes |   |   |
| `reviewerSetting` | `"llm"`, `"jev"` or null | yes |   |   |
| `judgeAvailable` | boolean | yes |   |   |
| `rules` | array of object | yes |   |   |
| `rules[].number` | number | yes |   |   |
| `rules[].text` | string | yes |   |   |
| `maxRules` | number | yes |   |   |

## adjudicator.update

Change the policy adjudicator's mode or confidence threshold. Switching it on from off starts in shadow mode (verdicts recorded, nothing acted on); only then can an admin switch it to active, where approve verdicts at or above the threshold apply without a person. Needs a written policy. `reviewer` picks who reviews: `jev` (the judge, the default while it has a key), `llm` (the review model role), or null for the default. Admins only, people only.

|  |  |
| --- | --- |
| Permission | `policy:manage` |
| Risk | `write` |
| Audiences | `staff` |
| Actors | `human` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `mode` | `"off"`, `"shadow"`, `"active"` |   |   |   |
| `threshold` | number |   | ≥ 0.5, ≤ 1 | Verdicts below this confidence go to a person (0.5–1) |
| `reviewer` | `"llm"`, `"jev"` or null |   |   | Who reviews: jev, llm, or null for the default (Jev while the judge has a key) |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `mode` | `"off"`, `"shadow"`, `"active"` | yes |   |   |
| `threshold` | number | yes |   |   |
| `enabledAt` | string or null | yes |   |   |
| `policy` | object or null | yes |   |   |
| `policy.version` | number | yes |   |   |
| `policy.text` | string | yes |   |   |
| `policy.hash` | string | yes |   |   |
| `policy.createdAt` | string | yes |   |   |
| `policy.createdBy` | string | yes |   |   |
| `policy.createdByName` | string or null | yes |   |   |
| `models` | object or null | yes |   |   |
| `models.review` | object | yes |   |   |
| `models.review.provider` | string | yes |   |   |
| `models.review.model` | string | yes |   |   |
| `models.assistant` | object | yes |   |   |
| `models.assistant.provider` | string | yes |   |   |
| `models.assistant.model` | string | yes |   |   |
| `sameModelAsAssistant` | boolean | yes |   |   |
| `reviewer` | `"llm"`, `"jev"` | yes |   |   |
| `reviewerSetting` | `"llm"`, `"jev"` or null | yes |   |   |
| `judgeAvailable` | boolean | yes |   |   |
| `rules` | array of object | yes |   |   |
| `rules[].number` | number | yes |   |   |
| `rules[].text` | string | yes |   |   |
| `maxRules` | number | yes |   |   |
