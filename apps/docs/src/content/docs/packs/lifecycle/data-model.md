---
title: "Lifecycle stage: data model"
sidebar:
  label: "Data model"
  order: 1
editUrl: false
---

It requires no other pack.

## Fields on other objects

### On `person`

| Field | Type | Label | Required | Details | Description |
| --- | --- | --- | --- | --- | --- |
| `lifecycleStage` | `select` | Lifecycle stage |   | one of `subscriber`, `lead`, `marketingQualified`, `salesQualified`, `opportunity`, `customer`, `evangelist`, `other` | Where the person is in their relationship with you, as HubSpot names it. |
| `lifecycleStageChangedAt` | `date` | Stage changed on |   | read-only | The date the lifecycle stage last changed. |

## Views

| View | Object | Label |
| --- | --- | --- |
| `peopleByStage` | `person` | People by lifecycle stage |
