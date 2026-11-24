---
title: "Leads: operations and tools"
sidebar:
  label: "Operations and tools"
  order: 2
editUrl: false
---

Each tool is called as `x.leads.<tool>`. Its description is the one a model reads. Input and output are the tool's schemas.

## Tools

### convert

Convert a lead into a deal: creates a deal for the lead's organisation, owned by the lead's owner and linked to the lead, in the given pipeline and stage (default: the default pipeline's first stage); adds the lead's person to the deal as a participant; and marks the lead converted with its deal and date. No data is copied: the deal points at the same person and organisation records. If the lifecycle extension is installed, the person's lifecycle stage moves to opportunity. Safe to run again after a failure (it finishes without a second deal); a converted lead cannot be converted again.

|  |  |
| --- | --- |
| Risk | `write` |
| Audiences | `staff` |
| Button on | `leads.lead` |

#### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `leadId` | string | yes | min length 1 | The lead (leads.lead record id) |
| `dealName` | string |   | min length 1, max length 1000 | Default: the lead's name |
| `pipeline` | string |   | min length 1 | A deals.pipeline id. Default pipeline if left out |
| `stage` | string |   | min length 1 | A deals.stage id. The pipeline's first stage if left out |
| `value` | number |   | ≥ 0 | The deal's value, in the base currency |
| `expectedClose` | string |   | pattern `^\d{4}-\d{2}-\d{2}$` | Expected close date, YYYY-MM-DD |

#### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `leadId` | string | yes |   |   |
| `dealId` | string | yes |   |   |
| `created` | boolean | yes |   |   |
| `open` | object or null | yes |   |   |
| `open.object` | string | yes |   |   |
| `open.id` | string | yes |   |   |

### disqualify

Disqualify a lead: sets its status to unqualified with the reason (no budget, no need, no authority, bad timing, competitor, unresponsive or other). A converted lead cannot be disqualified.

|  |  |
| --- | --- |
| Risk | `write` |
| Audiences | `staff` |
| Button on | `leads.lead` |

#### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `leadId` | string | yes | min length 1 | The lead (leads.lead record id) |
| `reason` | `"noBudget"`, `"noNeed"`, `"noAuthority"`, `"badTiming"`, `"competitor"`, `"unresponsive"`, `"other"` | yes |   |   |

#### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `leadId` | string | yes |   |   |
| `status` | string | yes |   |   |
| `reason` | string | yes |   |   |

## Automations

### notifyNewLead

**Notify the owner of a new lead.** When a lead is created with an owner, tells the owner about it.

|  |  |
| --- | --- |
| Trigger | record on leads.lead (created) |
| Steps | `notifyOwner`  |

### remindNewLead

**Remind the owner of a lead still new.** 2 days after a lead is created, if it is still New, reminds its owner to contact it.

|  |  |
| --- | --- |
| Trigger | dateRelative on leads.lead, field createdAt |
| Steps | `notifyOwner`  |

## Dashboards

| Dashboard | Label | Widgets |
| --- | --- | --- |
| `leads` |   | 7 |

## Core operations it may call

The operations its code may call through `ctx.ops`, as its manifest asks for them.

- [`notification.send`](/reference/operations/notification/#notificationsend)
- [`extensionSettings.list`](/reference/operations/extensionsettings/#extensionsettingslist)

Host modules it asks for: `ops`, `log`.
