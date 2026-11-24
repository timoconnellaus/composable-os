---
title: "agent.* operations"
description: "The core operations named agent.*"
sidebar:
  label: "agent"
editUrl: false
---

## agent.allowSpend

Let an agent paused at its spend limit carry on, with this much more. People only: it goes back in line and is charged to whatever started it.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `write` |
| Audiences | `staff` |
| Actors | `human` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `jobId` | string (starts_with) | yes | max length 64, pattern `^job_.*` | The agent's id (job_…) |
| `usd` | number | yes | ≥ 0.01, ≤ 100 |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `jobId` | string | yes |   |   |
| `spendUsd` | number | yes |   |   |
| `state` | `"awaiting_confirm"`, `"refused"`, `"queued"`, `"running"`, `"paused"`, `"done"`, `"stopped"`, `"failed"`, `"cancelled"` | yes |   |   |

## agent.confirmGrant

The person's answer on a grant shown before an agent starts: start it, start it with every change set aside for them, or cancel. People only.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `write` |
| Audiences | `staff` |
| Actors | `human` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `jobId` | string (starts_with) | yes | max length 64, pattern `^job_.*` | The agent's id (job_…) |
| `decision` | `"start"`, `"startReviewing"`, `"cancel"` | yes |   |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `jobId` | string | yes |   |   |
| `state` | `"awaiting_confirm"`, `"refused"`, `"queued"`, `"running"`, `"paused"`, `"done"`, `"stopped"`, `"failed"`, `"cancelled"` | yes |   |   |

## agent.progress

For an agent at work: say how far along you are, for the person's progress card. `done` of `total` records, and what you are on `now`. Call it as you finish each record.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `write` |
| Audiences | `staff` |
| Actors | `assistant` |
| Also | bookkeeping, never queued for review |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `done` | integer |   | ≥ 0, ≤ 1000000 |   |
| `total` | integer |   | ≥ 0, ≤ 1000000 |   |
| `now` | string |   | max length 200 |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `ok` | boolean | yes |   |   |

## agent.report

Internal: the AgentJob object's bookkeeping, as its person. What it has used, and how it ended. Returns the job's state, which may be stopped. Refused for anything but that object.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `write` |
| Audiences | `staff` |
| Actors | `human` |
| Also | bookkeeping, never queued for review |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `jobId` | string (starts_with) | yes | max length 64, pattern `^job_.*` | The agent's id (job_…) |
| `steps` | integer | yes | ≥ 0, ≤ 9007199254740991 |   |
| `spentMicrousd` | integer | yes | ≥ 0, ≤ 9007199254740991 |   |
| `fieldsFilled` | integer | yes | ≥ 0, ≤ 9007199254740991 |   |
| `end` | object |   |   |   |
| `end.state` | `"done"`, `"failed"`, `"stopped"`, `"paused"` | yes |   |   |
| `end.result` | string |   | max length 40000 |   |
| `end.error` | string |   | max length 2000 |   |
| `refs` | array of string |   | at most 100, default `[]` |   |
| `remind` | string (starts_with) |   | max length 64, pattern `^chs_.*` | Tell the person this change set is still waiting |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `state` | `"awaiting_confirm"`, `"refused"`, `"queued"`, `"running"`, `"paused"`, `"done"`, `"stopped"`, `"failed"`, `"cancelled"` | yes |   |   |

## agent.settings

The limits on agents: how many run at once per person and per workspace, the default step, time and spend budgets, how long the assistant waits for an awaited agent, and how often people are reminded of changes to review. Read-only.

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
| `maxRunningPerUser` | integer | yes | ≥ 1, ≤ 100 |   |
| `maxRunningPerWorkspace` | integer | yes | ≥ 1, ≤ 1000 |   |
| `defaultSteps` | integer | yes | ≥ 1, ≤ 5000 |   |
| `defaultMinutes` | integer | yes | ≥ 1, ≤ 1440 |   |
| `defaultSpendUsd` | number | yes | ≥ 0.01, ≤ 1000 |   |
| `awaitSeconds` | integer | yes | ≥ 1, ≤ 120 |   |
| `reminderHours` | integer | yes | ≥ 1, ≤ 168 |   |
| `defaults` | object | yes |   |   |
| `defaults.maxRunningPerUser` | integer | yes | ≥ 1, ≤ 100 |   |
| `defaults.maxRunningPerWorkspace` | integer | yes | ≥ 1, ≤ 1000 |   |
| `defaults.defaultSteps` | integer | yes | ≥ 1, ≤ 5000 |   |
| `defaults.defaultMinutes` | integer | yes | ≥ 1, ≤ 1440 |   |
| `defaults.defaultSpendUsd` | number | yes | ≥ 0.01, ≤ 1000 |   |
| `defaults.awaitSeconds` | integer | yes | ≥ 1, ≤ 120 |   |
| `defaults.reminderHours` | integer | yes | ≥ 1, ≤ 168 |   |

## agent.start

Start an agent: a background worker for anything longer than a couple of tool calls or a few seconds (research across records, a clean-up, drafting several things). Tell the person at once that it is running and carry on: they see a progress card and can keep chatting. It gets only what you give it: write a full brief, because it cannot see this chat. Pick a profile (researcher, drafter, importer, analyst, see agentProfile.list) for its default access, or name the operations. It can fill empty fields and add notes and tasks on `records` by itself; every other change waits in one review for the person. Use mode `awaited` for short work you need in your reply (no card, it moves to the background if it runs long). If the grant is refused as wider than the brief needs, narrow it, or call again once with a `justification`. Never for a single lookup: do those yourself.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `write` |
| Audiences | `staff` |
| Actors | `human`, `assistant`, `automation`, `extension` |
| Also | bookkeeping, never queued for review |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `title` | string | yes | min length 1, max length 120 | A short name: 'Account research' |
| `brief` | string | yes | min length 10, max length 8000 | Everything it needs to know, written out. It cannot see the chat |
| `records` | array of object |   | at most 1000, default `[]` | The records it works on |
| `records[].object` | string | yes | min length 1, max length 64 |   |
| `records[].id` | string | yes | min length 1, max length 64 |   |
| `profile` | string |   | max length 120 | An agent profile's name |
| `mode` | `"awaited"`, `"background"` |   | default `"background"` |   |
| `operations` | array of string |   | at most 60 |   |
| `target` | object |   |   | Default: `records` |
| `caps` | object |   |   |   |
| `caps.changes` | integer |   | ≥ 0, ≤ 5000 | Fields filled, without review |
| `caps.notes` | integer |   | ≥ 0, ≤ 5000, default `0` | Notes added, without review |
| `caps.tasks` | integer |   | ≥ 0, ≤ 5000, default `0` | Tasks added, without review |
| `expiresInHours` | number |   | ≥ 0.25, ≤ 168 |   |
| `budget` | object |   |   | Default: the profile's |
| `budget.steps` | integer |   | ≥ 1, ≤ 5000 |   |
| `budget.minutes` | integer |   | ≥ 1, ≤ 1440 |   |
| `budget.spendUsd` | number |   | ≥ 0, ≤ 1000 |   |
| `justification` | string |   | min length 5, max length 500 | Only after a refusal: why it needs this access |

### Output

No fields.

## agent.status

How the person's agents are doing: one by id, or their newest. Each has its state, progress, steps, spend, fields filled, how many changes wait for review, and its result once done. Read-only.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `read` |
| Audiences | `staff` |
| Actors | `human`, `assistant`, `automation` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `jobId` | string (starts_with) |   | max length 64, pattern `^job_.*` | The agent's id (job_…) |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `jobs` | array of object | yes |   |   |
| `jobs[].id` | string | yes |   |   |
| `jobs[].title` | string | yes |   |   |
| `jobs[].brief` | string | yes |   |   |
| `jobs[].profile` | string or null | yes |   |   |
| `jobs[].mode` | `"awaited"`, `"background"` | yes |   |   |
| `jobs[].state` | `"awaiting_confirm"`, `"refused"`, `"queued"`, `"running"`, `"paused"`, `"done"`, `"stopped"`, `"failed"`, `"cancelled"` | yes |   |   |
| `jobs[].grant` | object | yes |   |   |
| `jobs[].grant.operations` | array of string | yes | at least 1, at most 60 |   |
| `jobs[].grant.target` | object | yes |   |   |
| `jobs[].grant.caps` | object | yes |   |   |
| `jobs[].grant.caps.changes` | integer | yes | ≥ 0, ≤ 5000 | Fields filled, without review |
| `jobs[].grant.caps.notes` | integer | yes | ≥ 0, ≤ 5000, default `0` | Notes added, without review |
| `jobs[].grant.caps.tasks` | integer | yes | ≥ 0, ≤ 5000, default `0` | Tasks added, without review |
| `jobs[].grant.expiresAt` | string (date-time) | yes | pattern `^(?:(?:\d\d[2468][048]\|\d\d[13579][26]\|\d\d0[48]\|[02468][048]00\|[13579][26]00)-02-29\|\d{4}-(?:(?:0[13578]\|1[02])-(?:0[1-9]\|[12]\d\|3[01])\|(?:0[469]\|11)-(?:0[1-9]\|[12]\d\|30)\|(?:02)-(?:0[1-9]\|1\d\|2[0-8])))T(?:(?:[01]\d\|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z))$` |   |
| `jobs[].budget` | object | yes |   |   |
| `jobs[].budget.steps` | integer | yes | ≥ 1, ≤ 5000 |   |
| `jobs[].budget.minutes` | integer | yes | ≥ 1, ≤ 1440 |   |
| `jobs[].budget.spendUsd` | number | yes | ≥ 0, ≤ 1000 |   |
| `jobs[].reviewEverything` | boolean | yes |   |   |
| `jobs[].progress` | object or null | yes |   |   |
| `jobs[].progress.done` | integer |   | ≥ 0, ≤ 1000000 |   |
| `jobs[].progress.total` | integer |   | ≥ 0, ≤ 1000000 |   |
| `jobs[].progress.now` | string |   | max length 200 |   |
| `jobs[].steps` | number | yes |   |   |
| `jobs[].spentUsd` | number | yes |   |   |
| `jobs[].fieldsFilled` | number | yes |   |   |
| `jobs[].result` | string or null | yes |   |   |
| `jobs[].error` | string or null | yes |   |   |
| `jobs[].changeSetId` | string or null | yes |   |   |
| `jobs[].toReview` | number | yes |   |   |
| `jobs[].place` | number or null | yes |   |   |
| `jobs[].placeLabel` | string or null | yes |   |   |
| `jobs[].startedBy` | object | yes |   |   |
| `jobs[].startedBy.kind` | string | yes |   |   |
| `jobs[].startedBy.id` | string | yes |   |   |
| `jobs[].createdAt` | string | yes |   |   |
| `jobs[].startedAt` | string or null | yes |   |   |
| `jobs[].finishedAt` | string or null | yes |   |   |

## agent.stop

Stop an agent, or take one out of the queue, when the person asks. Nothing else runs. What it already did stays, and its changes waiting for review stay waiting.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `write` |
| Audiences | `staff` |
| Actors | `human`, `assistant` |
| Also | bookkeeping, never queued for review |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `jobId` | string (starts_with) | yes | max length 64, pattern `^job_.*` | The agent's id (job_…) |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `jobId` | string | yes |   |   |
| `state` | `"awaiting_confirm"`, `"refused"`, `"queued"`, `"running"`, `"paused"`, `"done"`, `"stopped"`, `"failed"`, `"cancelled"` | yes |   |   |

## agent.updateSettings

Set the limits on agents (admins). Jobs already running keep their budgets.

|  |  |
| --- | --- |
| Permission | `settings:manage` |
| Risk | `write` |
| Audiences | `staff` |
| Actors | `human` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `maxRunningPerUser` | integer | yes | ≥ 1, ≤ 100 |   |
| `maxRunningPerWorkspace` | integer | yes | ≥ 1, ≤ 1000 |   |
| `defaultSteps` | integer | yes | ≥ 1, ≤ 5000 |   |
| `defaultMinutes` | integer | yes | ≥ 1, ≤ 1440 |   |
| `defaultSpendUsd` | number | yes | ≥ 0.01, ≤ 1000 |   |
| `awaitSeconds` | integer | yes | ≥ 1, ≤ 120 |   |
| `reminderHours` | integer | yes | ≥ 1, ≤ 168 |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `maxRunningPerUser` | integer | yes | ≥ 1, ≤ 100 |   |
| `maxRunningPerWorkspace` | integer | yes | ≥ 1, ≤ 1000 |   |
| `defaultSteps` | integer | yes | ≥ 1, ≤ 5000 |   |
| `defaultMinutes` | integer | yes | ≥ 1, ≤ 1440 |   |
| `defaultSpendUsd` | number | yes | ≥ 0.01, ≤ 1000 |   |
| `awaitSeconds` | integer | yes | ≥ 1, ≤ 120 |   |
| `reminderHours` | integer | yes | ≥ 1, ≤ 168 |   |
