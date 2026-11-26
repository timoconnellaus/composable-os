---
title: "Equipment: operations and tools"
sidebar:
  label: "Operations and tools"
  order: 2
editUrl: false
---

Each tool is called as `x.equipment.<tool>`. Its description is the one a model reads. Input and output are the tool's schemas.

## Tools

### register

The equipment register: items with their tag, category, place, state (in service, out of service with why and since when, retired), keeper, supplier, warranty end and how many faults are open. Out-of-service items and those with open safety risks come first. Retired items are left out unless state is retired. Narrow it with state, category, place or q (a name, tag, make, model or serial). Read-only.

|  |  |
| --- | --- |
| Risk | `read` |
| Audiences | `staff` |
| Permission | `equipment:report` |

#### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `state` | `"in_service"`, `"out_of_service"`, `"retired"` |   |   |   |
| `category` | string |   | max length 80 |   |
| `place` | string |   | max length 200 | Only items whose place contains this |
| `q` | string |   | min length 1, max length 100 |   |

#### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `items` | array of object | yes |   |   |
| `items[].id` | string | yes |   |   |
| `items[].name` | string or null | yes |   |   |
| `items[].tag` | string or null | yes |   |   |
| `items[].category` | string or null | yes |   |   |
| `items[].place` | string or null | yes |   |   |
| `items[].state` | `"in_service"`, `"out_of_service"`, `"retired"` or null | yes |   |   |
| `items[].outSince` | string or null | yes |   |   |
| `items[].outReason` | string or null | yes |   |   |
| `items[].keeper` | string or null | yes |   | The keeper's account id; empty means the managers |
| `items[].issuedTo` | string or null | yes |   |   |
| `items[].supplier` | string or null | yes |   |   |
| `items[].warrantyUntil` | string or null | yes |   |   |
| `items[].openFaults` | number | yes |   | Faults reported or acknowledged, not yet closed |
| `items[].safetyRisks` | number | yes |   | Of the open faults, those reported as a safety risk |
| `truncated` | boolean | yes |   |   |

### item

One item of the register: its details, state (and why and since when it is out of service), keeper, who has it, supplier, purchase cost, warranty and renewal dates, and its faults newest first, each saying whether the item was under warranty when it was reported. Costs are for every staff member. Read-only.

|  |  |
| --- | --- |
| Risk | `read` |
| Audiences | `staff` |
| Permission | `equipment:report` |

#### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `itemId` | string | yes | min length 1, max length 64 |   |

#### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `name` | string or null | yes |   |   |
| `tag` | string or null | yes |   |   |
| `category` | string or null | yes |   |   |
| `place` | string or null | yes |   |   |
| `make` | string or null | yes |   |   |
| `model` | string or null | yes |   |   |
| `serial` | string or null | yes |   |   |
| `state` | `"in_service"`, `"out_of_service"`, `"retired"` or null | yes |   |   |
| `outSince` | string or null | yes |   |   |
| `outReason` | string or null | yes |   |   |
| `keeper` | string or null | yes |   |   |
| `issuedTo` | string or null | yes |   |   |
| `supplierId` | string or null | yes |   |   |
| `supplier` | string or null | yes |   |   |
| `boughtOn` | string or null | yes |   |   |
| `warrantyUntil` | string or null | yes |   |   |
| `warrantyNotes` | string or null | yes |   |   |
| `renewalDue` | string or null | yes |   |   |
| `listForMembers` | string or null | yes |   |   |
| `notes` | string or null | yes |   |   |
| `costs` | object | yes |   |   |
| `costs.purchase` | number or null | yes |   | What it cost to buy, in the base currency |
| `faults` | array of object | yes |   | Newest first, at most 50 |
| `faults[].id` | string | yes |   |   |
| `faults[].title` | string or null | yes |   |   |
| `faults[].description` | string or null | yes |   |   |
| `faults[].severity` | `"safety_risk"`, `"not_working"`, `"worn"` or null | yes |   |   |
| `faults[].state` | `"reported"`, `"acknowledged"`, `"fixed"`, `"not_a_fault"`, `"duplicate"` or null | yes |   |   |
| `faults[].reportedBy` | string or null | yes |   |   |
| `faults[].reportedByName` | string or null | yes |   |   |
| `faults[].closedWhy` | string or null | yes |   |   |
| `faults[].reportedAt` | string or null | yes |   |   |
| `faults[].underWarranty` | boolean | yes |   | The item's warranty had not ended on the day it was reported |
| `moreFaults` | boolean | yes |   |   |

### reportFault

Report a fault on an item and take it out of service in the same call: what is wrong (never an injury: that goes on the incident form), how bad (safety_risk, not_working, worn) and, in takeOut, why it must not be used. For a staff member who sees something unsafe (decision 3). To report without taking it out, use reportFaultOnly. The report is recorded as the caller's, once: a retry with the same requestId (or the same report while it is open) finds it. The answer says whether it was taken out, and why not if not. A fault on a retired item is refused. A person's act: the assistant, an MCP client or an automation may ask, and it waits for a person to approve it.

|  |  |
| --- | --- |
| Risk | `write` |
| Audiences | `staff` |
| Permission | `equipment:report` |
| Approval | a person approves anyone else's call (`personApproves`) |

#### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `itemId` | string | yes | min length 1, max length 64 |   |
| `description` | string | yes | min length 3, max length 4000 |   |
| `severity` | `"safety_risk"`, `"not_working"`, `"worn"` | yes |   |   |
| `requestId` | string |   | min length 1, max length 64 | The caller's own id for this report, the same on every retry: a retry finds the report it made rather than making a second. Left out, a report by the same person on the same item with the same words and severity, still open, is the same report. |
| `takeOut` | object |   |   | Take the item out of service, with why it must not be used |
| `takeOut.reason` | string | yes | min length 3, max length 500 |   |

#### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `faultId` | string | yes |   |   |
| `itemId` | string | yes |   |   |
| `alreadyReported` | boolean | yes |   | This report was made before (a retry, or the same report again): no second fault |
| `takenOut` | boolean | yes |   | This call took the item out of service |
| `takeOutFailed` | string or null | yes |   | Why the take-out asked for did not happen, when it did not; the fault is recorded |
| `itemState` | `"in_service"`, `"out_of_service"`, `"retired"` or null | yes |   |   |
| `underWarranty` | boolean | yes |   |   |
| `message` | string | yes |   |   |

### reportFaultOnly

Report a fault on an item without taking it out of service: what is wrong (never an injury: that goes on the incident form) and how bad (safety_risk, not_working, worn). The report is recorded as the caller's, once: a retry with the same requestId (or the same report while it is open) finds it. Nothing else changes: the item stays as it is, and a manager triages the fault. To take the item out too, use reportFault or takeOut. A fault on a retired item is refused.

|  |  |
| --- | --- |
| Risk | `write` |
| Audiences | `staff` |
| Permission | `equipment:report` |

#### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `itemId` | string | yes | min length 1, max length 64 |   |
| `description` | string | yes | min length 3, max length 4000 |   |
| `severity` | `"safety_risk"`, `"not_working"`, `"worn"` | yes |   |   |
| `requestId` | string |   | min length 1, max length 64 | The caller's own id for this report, the same on every retry: a retry finds the report it made rather than making a second. Left out, a report by the same person on the same item with the same words and severity, still open, is the same report. |

#### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `faultId` | string | yes |   |   |
| `itemId` | string | yes |   |   |
| `alreadyReported` | boolean | yes |   | This report was made before (a retry, or the same report again): no second fault |
| `takenOut` | boolean | yes |   | This call took the item out of service |
| `takeOutFailed` | string or null | yes |   | Why the take-out asked for did not happen, when it did not; the fault is recorded |
| `itemState` | `"in_service"`, `"out_of_service"`, `"retired"` or null | yes |   |   |
| `underWarranty` | boolean | yes |   |   |
| `message` | string | yes |   |   |

### takeOut

Take an item out of service, with why it must not be used: any staff member may (decision 4). Only from in service; an item already out of service or retired is refused with its state. Only a manager puts it back (putBack). A person's act: the assistant, an MCP client or an automation may ask, and it waits for a person to approve it.

|  |  |
| --- | --- |
| Risk | `write` |
| Audiences | `staff` |
| Permission | `equipment:report` |
| Approval | a person approves anyone else's call (`personApproves`) |
| Button on | `equipment.item` |

#### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `itemId` | string | yes | min length 1, max length 64 |   |
| `reason` | string | yes | min length 3, max length 500 |   |

#### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `itemId` | string | yes |   |   |
| `state` | `"out_of_service"` | yes |   |   |
| `outSince` | string | yes |   |   |

### putBack

Put an item that is out of service back in service, once it is safe to use: a manager's own act (equipment:manage), never the assistant's or an automation's (decision 4). Its reason and time out of service are cleared; the state history keeps them.

|  |  |
| --- | --- |
| Risk | `write` |
| Audiences | `staff` |
| Permission | `equipment:manage` |
| Who may call it | a person only (`humanOnly`) |
| Button on | `equipment.item` |

#### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `itemId` | string | yes | min length 1, max length 64 |   |

#### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `itemId` | string | yes |   |   |
| `state` | `"in_service"` | yes |   |   |

### retire

Retire an item for good (worn out, replaced, sold, lost), with why: it leaves the register's usual list, is no longer listed for members, and cannot come back. Its faults and history stay. A manager's (equipment:manage); the assistant, an MCP client or an automation may ask, and it waits for a person to approve it.

|  |  |
| --- | --- |
| Risk | `destructive` |
| Audiences | `staff` |
| Permission | `equipment:manage` |
| Approval | a person approves anyone else's call (`personApproves`) |
| Button on | `equipment.item` |

#### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `itemId` | string | yes | min length 1, max length 64 |   |
| `reason` | string | yes | min length 3, max length 500 |   |

#### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `itemId` | string | yes |   |   |
| `state` | `"retired"` | yes |   |   |

### triage

Triage a fault: acknowledge it (seen, being dealt with), or close it as fixed, not a fault or a duplicate, with why (what fixed it, or which report it repeats). A manager's (equipment:manage); the assistant, an MCP client or an automation may ask, and it waits for a person to approve it. A closed fault stays closed. It does not put the item back in service: that is putBack.

|  |  |
| --- | --- |
| Risk | `write` |
| Audiences | `staff` |
| Permission | `equipment:manage` |
| Approval | a person approves anyone else's call (`personApproves`) |

#### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `faultId` | string | yes | min length 1, max length 64 |   |
| `action` | `"acknowledge"`, `"fixed"`, `"not_a_fault"`, `"duplicate"` | yes |   |   |
| `why` | string |   | min length 3, max length 1000 | Why it is closed. Needed to close one; optional to acknowledge |

#### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `faultId` | string | yes |   |   |
| `state` | `"reported"`, `"acknowledged"`, `"fixed"`, `"not_a_fault"`, `"duplicate"` | yes |   |   |

### correctFault

Correct a fault's report: how bad it is (safety_risk, not_working, worn) and what is wrong. Once reported these are fixed for everyone else, so a safety risk is never quietly lowered; a manager (equipment:manage) corrects them here. The assistant, an MCP client or an automation may ask, and it waits for a person to approve it.

|  |  |
| --- | --- |
| Risk | `write` |
| Audiences | `staff` |
| Permission | `equipment:manage` |
| Approval | a person approves anyone else's call (`personApproves`) |

#### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `faultId` | string | yes | min length 1, max length 64 |   |
| `severity` | `"safety_risk"`, `"not_working"`, `"worn"` |   |   |   |
| `description` | string |   | min length 3, max length 4000 |   |

#### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `faultId` | string | yes |   |   |
| `severity` | `"safety_risk"`, `"not_working"`, `"worn"` or null | yes |   |   |
| `description` | string or null | yes |   |   |

### correctOutReason

Correct why an item that is out of service must not be used. Only the tools that take it out write the reason, so nobody can change it to 'fine now' while it is out; a manager (equipment:manage) corrects it here. To put the item back, use putBack. The assistant, an MCP client or an automation may ask, and it waits for a person to approve it.

|  |  |
| --- | --- |
| Risk | `write` |
| Audiences | `staff` |
| Permission | `equipment:manage` |
| Approval | a person approves anyone else's call (`personApproves`) |

#### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `itemId` | string | yes | min length 1, max length 64 |   |
| `reason` | string | yes | min length 3, max length 500 |   |

#### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `itemId` | string | yes |   |   |
| `outReason` | string or null | yes |   |   |

## Automations

None.

## Core operations it may call

The operations its code may call through `ctx.ops`, as its manifest asks for them.

- [`query.sql`](/reference/operations/query/#querysql)

Host modules it asks for: `ops`.
