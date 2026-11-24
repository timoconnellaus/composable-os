---
title: "Deals: operations and tools"
sidebar:
  label: "Operations and tools"
  order: 2
editUrl: false
---

Each tool is called as `x.deals.<tool>`. Its description is the one a model reads. Input and output are the tool's schemas.

## Tools

### stageMetrics

Time in stage and velocity for a deal pipeline, from stage history: for each stage how many deals entered it, how many are in it now, and the average days deals spent in it; and for won deals how many were won, the average days from entering the pipeline to being won, and their total value. Optionally only stage entries since a date. Read-only.

|  |  |
| --- | --- |
| Risk | `read` |
| Audiences | `staff` |

#### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `pipelineId` | string | yes | min length 1 | The pipeline (deals.pipeline record id) |
| `since` | string |   | pattern `^\d{4}-\d{2}-\d{2}` | Only count stage entries on or after this date (YYYY-MM-DD) |

#### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `pipelineId` | string | yes |   |   |
| `stages` | array of object | yes |   |   |
| `stages[].stageId` | string | yes |   |   |
| `stages[].stage` | string | yes |   |   |
| `stages[].type` | string | yes |   |   |
| `stages[].entered` | number | yes |   |   |
| `stages[].current` | number | yes |   |   |
| `stages[].avgDaysInStage` | number or null | yes |   |   |
| `stages[].avgDaysBeforeMovingOn` | number or null | yes |   |   |
| `velocity` | object | yes |   |   |
| `velocity.won` | number | yes |   |   |
| `velocity.avgDaysToWin` | number or null | yes |   |   |
| `velocity.wonValue` | number | yes |   |   |

## Automations

### stalledDeal

**Stalled deal follow-up.** Every morning, an open deal with no changes or activity for 14 days gets a follow-up task for its owner, unless it already has an open one.

|  |  |
| --- | --- |
| Trigger | schedule, 0 8 * * * |
| Steps | `createFollowUps` Create follow-up tasks for stalled deals |

### wonOnboarding

**Won deal → onboarding.** When a deal is won, creates three onboarding tasks for its owner and tells them. Three days later, if any are still open, tells the owner's manager (the admins, as users have no manager field).

|  |  |
| --- | --- |
| Trigger | fieldChanged on deals.deal, field stage |
| Steps | `createTasks` Create onboarding tasks; `notifyOwner` ; `wait` ; `anyOpen` Any onboarding task still open?; `notifyManager`  |

### closeDatePassed

**Close date passed.** The day after an open deal's expected close date, reminds its owner to update the date or close the deal.

|  |  |
| --- | --- |
| Trigger | dateRelative on deals.deal, field expectedClose |
| Steps | `notifyOwner`  |

## Dashboards

| Dashboard | Label | Widgets |
| --- | --- | --- |
| `salesOverview` |   | 8 |
| `pipelineHealth` |   | 5 |

## Core operations it may call

The operations its code may call through `ctx.ops`, as its manifest asks for them.

- [`query.sql`](/reference/operations/query/#querysql)
- [`notification.send`](/reference/operations/notification/#notificationsend)

Host modules it asks for: `ops`, `log`.
