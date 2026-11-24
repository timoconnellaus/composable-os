---
title: "state.* operations"
description: "The core operations named state.*"
sidebar:
  label: "state"
editUrl: false
---

## state.after

Platform use only (the minute cron, as the host): make one record's timed move (a declaration's `states.after`, such as a booking still booked after its class becoming a no-show), from the state it was read in or not at all, once it is due.

|  |  |
| --- | --- |
| Permission | `records:write` |
| Risk | `write` |
| Audiences | `staff` |
| Actors | `automation` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `object` | string | yes | min length 1, max length 81 |   |
| `id` | string | yes | min length 1, max length 64 |   |
| `rule` | integer | yes | ≥ 0, ≤ 3 | Which of the object's timed moves |
| `from` | string | yes | min length 1, max length 100 | The state it was read in |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `state` | string | yes |   |   |

## state.resolve

From a tool: which state a requested move (such as `cancel`) would move a record to now, decided by the host's clock and the object's windows exactly as the write would decide it (a cancel more than the late-cancel time before a class is `cancelled`, later `late_cancelled`). Writes nothing. Refused with the rule's details when no state may be entered now. A customer asks only of their own records. Read-only.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `read` |
| Audiences | `staff`, `customer` |
| Also | called only from a tool's run (`toolOnly`); host-internal (`hostInternal`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `object` | string | yes | min length 1, max length 81 |   |
| `id` | string | yes | min length 1, max length 64 |   |
| `request` | string | yes | min length 1, max length 40 | The request's name, e.g. cancel |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `state` | string | yes |   | The state the request would enter now |
| `label` | string | yes |   |   |
| `from` | string or null | yes |   | The state the record is in |
