---
title: "Deals: data model"
sidebar:
  label: "Data model"
  order: 1
editUrl: false
---

It requires no other pack.

## Pipeline (`deals.pipeline`)

A sales process: an ordered set of stages deals move through.

|  |  |
| --- | --- |
| Plural | Pipelines |
| Title field | `name` |
| Listed in | settings |
| Indexes | `position` |

### Fields

| Field | Type | Label | Required | Details | Description |
| --- | --- | --- | --- | --- | --- |
| `name` | `text` | Name | yes |   |   |
| `position` | `number` | Order |   |   |   |
| `description` | `longText` | Description |   |   |   |

## Stage (`deals.stage`)

One step of a pipeline: its order, whether deals in it are open, won or lost, the default probability, and the deal fields required to enter it (stage rules).

|  |  |
| --- | --- |
| Plural | Stages |
| Title field | `name` |
| Listed in | settings |
| Indexes | `pipeline, position` |

### Fields

| Field | Type | Label | Required | Details | Description |
| --- | --- | --- | --- | --- | --- |
| `name` | `text` | Name | yes |   |   |
| `pipeline` | `relation` | Pipeline | yes | to `deals.pipeline` |   |
| `position` | `number` | Order | yes |   |   |
| `type` | `select` | Type | yes | one of `open`, `won`, `lost` |   |
| `probability` | `percent` | Default probability |   |   |   |
| `requiredFields` | `multiSelect` | Required fields |   | one of `value`, `expectedClose`, `owner`, `organisation`, `source`, `nextStep`, `nextStepDate`, `lostReason` | Deal fields that must have a value to enter this stage. |

### Relations

- `pipeline` → `deals.pipeline`

## Deal (`deals.deal`)

A potential sale moving through a pipeline.

|  |  |
| --- | --- |
| Plural | Deals |
| Title field | `name` |
| Listed in | main |
| Behaviours | [`stages`](/reference/behaviours/#stages) |
| Indexes | `stage`; `pipeline, status`; `status, expectedClose`; `status, closedAt`; `organisation`; `owner, status`; `status, updatedAt` |
| Owner field | `owner` |

### Fields

| Field | Type | Label | Required | Details | Description |
| --- | --- | --- | --- | --- | --- |
| `name` | `text` | Name | yes |   |   |
| `value` | `currency` | Value |   |   | In the deployment's base currency (Settings → General). |
| `pipeline` | `relation` | Pipeline |   | to `deals.pipeline` | Defaults to the Default pipeline setting (New business). |
| `stage` | `relation` | Stage |   | to `deals.stage` | Defaults to the pipeline's first stage. Stage rules apply on entering it. |
| `status` | `select` | Status |   | one of `open`, `won`, `lost`; read-only | Open, won or lost: the type of the deal's stage. |
| `expectedClose` | `date` | Expected close |   |   |   |
| `probability` | `percent` | Probability |   |   | Follows the stage's default unless set by hand. |
| `probabilityOverridden` | `boolean` | Probability set by hand |   |   | Clear it to go back to the stage's default probability. |
| `weightedValue` | `formula` | Weighted value |   |   |   |
| `owner` | `user` | Owner |   |   |   |
| `organisation` | `relation` | Organisation |   | to `organisation` |   |
| `source` | `select` | Source |   | one of `inbound`, `outbound`, `referral`, `partner`, `event`, `existing`, `other` |   |
| `lostReason` | `select` | Lost reason |   | one of `price`, `competitor`, `noBudget`, `noDecision`, `timing`, `productFit`, `other` | Required to move a deal to a lost stage. |
| `nextStep` | `text` | Next step |   |   |   |
| `nextStepDate` | `date` | Next step date |   |   |   |
| `closedAt` | `datetime` | Won/lost date |   | read-only | Set when the deal enters a won or lost stage; cleared when it reopens. |

### Relations

- `pipeline` → `deals.pipeline`
- `stage` → `deals.stage`
- `organisation` → `organisation`

### Behaviour declarations

<details>
<summary>The declarations as the manifest gives them</summary>

```json
{
  "stages": {
    "field": "stage",
    "stage": {
      "type": "type",
      "order": "position",
      "requiredFields": "requiredFields",
      "probability": "probability",
      "group": "pipeline"
    },
    "group": "pipeline",
    "probability": {
      "field": "probability",
      "overridden": "probabilityOverridden"
    },
    "closedDate": "closedAt",
    "status": "status",
    "requiredByType": {
      "lost": [
        "lostReason"
      ]
    },
    "defaultGroupSetting": "defaultPipeline"
  }
}
```

</details>

## Deal participant (`deals.participant`)

A person involved in a deal, and their role in it.

|  |  |
| --- | --- |
| Plural | Deal participants |
| Title field | `role` |
| Listed in | none |
| Indexes | `deal`; `person` |

### Fields

| Field | Type | Label | Required | Details | Description |
| --- | --- | --- | --- | --- | --- |
| `role` | `select` | Role | yes | one of `decisionMaker`, `champion`, `influencer`, `user`, `other` |   |
| `deal` | `relation` | Deal | yes | to `deals.deal` |   |
| `person` | `relation` | Person | yes | to `person` |   |
| `note` | `text` | Note |   |   |   |

### Relations

- `deal` → `deals.deal`
- `person` → `person`

## Views

| View | Object | Label |
| --- | --- | --- |
| `myOpenDeals` | `deals.deal` | My open deals |
| `closingThisMonth` | `deals.deal` | Closing this month |
| `wonThisQuarter` | `deals.deal` | Won this quarter |
| `pipelineBoard` | `deals.deal` | Pipeline board |

## On other records' pages

| Kind | Key | On | Label |
| --- | --- | --- | --- |
| tab | `organisationDeals` | `` | Deals |
| tab | `personDeals` | `` | Deals |
| tab | `dealPeople` | `` | People |
| panel | `organisationOpenDeals` | `` | Open deals |
