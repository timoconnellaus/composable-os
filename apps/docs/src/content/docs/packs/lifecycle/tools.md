---
title: "Lifecycle stage: operations and tools"
sidebar:
  label: "Operations and tools"
  order: 2
editUrl: false
---

Each tool is called as `x.lifecycle.<tool>`. Its description is the one a model reads. Input and output are the tool's schemas.

## Tools

None.

## Automations

### stageChangedOn

**Record when a lifecycle stage changes.** When a person's lifecycle stage changes, sets their Stage changed on date to today. Turn it off to stop keeping the date.

|  |  |
| --- | --- |
| Trigger | fieldChanged on person, field lifecycle.lifecycleStage |
| Steps | `setDate` Set the stage changed date |

## Core operations it may call

The operations its code may call through `ctx.ops`, as its manifest asks for them.

None.

Host modules it asks for: `ops`.
