---
title: "assignment.* operations"
description: "The core operations named assignment.*"
sidebar:
  label: "assignment"
editUrl: false
---

## assignment.apply

Re-run the assignment rules on existing records ("Assign by rules" in a list): each record (at most 200) gets the owner the rules give it now, as if it were new; round-robin rules continue their rotation. Records no rule (and no fallback owner) assigns keep their owner. Each change is audited with the rule's name and posted on the record's timeline.

|  |  |
| --- | --- |
| Permission | `records:write` |
| Risk | `bulk-write` |
| Audiences | `staff` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `object` | string | yes | min length 1, max length 80 | An object with an owner field: person, organisation, or e.g. leads.lead |
| `ids` | array of string | yes | at least 1, at most 200 |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `items` | array of object | yes |   |   |
| `items[].id` | string | yes |   |   |
| `items[].ownerId` | string or null | yes |   |   |
| `items[].ruleName` | string or null | yes |   |   |
| `items[].changed` | boolean | yes |   |   |

## assignment.create

Add an assignment rule for an object, last in its order (human admins only). Conditions name fields of the object, or with `via` a relation field, of the related record (a lead's organisation's industry): eq, in (a list), between [low, high] for numbers and dates, is_null and is_not_null.

|  |  |
| --- | --- |
| Permission | `settings:manage` |
| Risk | `write` |
| Audiences | `staff` |
| Actors | `human` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `object` | string | yes | min length 1, max length 80 | An object with an owner field: person, organisation, or e.g. leads.lead |
| `name` | string | yes | min length 1, max length 100 |   |
| `enabled` | boolean |   | default `true` |   |
| `conditions` | array of object | yes | at most 20 | All must hold. Empty: the rule matches every record. |
| `conditions[].field` | string | yes | min length 1, max length 80 | A field of the object (or of the `via` record) |
| `conditions[].op` | `"eq"`, `"in"`, `"between"`, `"is_null"`, `"is_not_null"` | yes |   | eq (equals), in (is one of), between [low, high], is_null, is_not_null |
| `conditions[].value` | any |   |   |   |
| `conditions[].via` | string |   | min length 1, max length 40 | A relation field (e.g. `organisation`): test the related record's field instead |
| `method` | `"roundRobin"`, `"user"` | yes |   | roundRobin: rotate through userIds in order; user: always the one user |
| `userIds` | array of string | yes | at least 1, at most 50 | The users to rotate through, or the one user |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `object` | string | yes |   |   |
| `name` | string | yes |   |   |
| `position` | number | yes |   |   |
| `enabled` | boolean | yes |   |   |
| `conditions` | array of object | yes |   |   |
| `conditions[].field` | string | yes | min length 1, max length 80 | A field of the object (or of the `via` record) |
| `conditions[].op` | `"eq"`, `"in"`, `"between"`, `"is_null"`, `"is_not_null"` | yes |   | eq (equals), in (is one of), between [low, high], is_null, is_not_null |
| `conditions[].value` | any |   |   |   |
| `conditions[].via` | string |   | min length 1, max length 40 | A relation field (e.g. `organisation`): test the related record's field instead |
| `method` | `"roundRobin"`, `"user"` | yes |   |   |
| `userIds` | array of string | yes |   |   |

## assignment.delete

Delete an assignment rule (human admins only). Records it assigned keep their owners.

|  |  |
| --- | --- |
| Permission | `settings:manage` |
| Risk | `write` |
| Audiences | `staff` |
| Actors | `human` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string (starts_with) | yes | max length 64, pattern `^asr_.*` |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |

## assignment.get

Get one assignment rule by id: its object, conditions, method and users. Read-only.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `read` |
| Audiences | `staff` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string (starts_with) | yes | max length 64, pattern `^asr_.*` |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `object` | string | yes |   |   |
| `name` | string | yes |   |   |
| `position` | number | yes |   |   |
| `enabled` | boolean | yes |   |   |
| `conditions` | array of object | yes |   |   |
| `conditions[].field` | string | yes | min length 1, max length 80 | A field of the object (or of the `via` record) |
| `conditions[].op` | `"eq"`, `"in"`, `"between"`, `"is_null"`, `"is_not_null"` | yes |   | eq (equals), in (is one of), between [low, high], is_null, is_not_null |
| `conditions[].value` | any |   |   |   |
| `conditions[].via` | string |   | min length 1, max length 40 | A relation field (e.g. `organisation`): test the related record's field instead |
| `method` | `"roundRobin"`, `"user"` | yes |   |   |
| `userIds` | array of string | yes |   |   |

## assignment.list

List the assignment rules: for each object with an owner field (person, organisation, and extension objects such as leads.lead and deals.deal), its rules in order and its fallback owner. When a record is created without an owner, the first enabled rule whose conditions all hold assigns it (round-robin among its users, or one user); otherwise the fallback owner. Read-only.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `read` |
| Audiences | `staff` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `object` | string |   | min length 1, max length 80 | An object with an owner field: person, organisation, or e.g. leads.lead |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `objects` | array of object | yes |   |   |
| `objects[].object` | string | yes |   |   |
| `objects[].label` | string | yes |   |   |
| `objects[].ownerField` | string | yes |   |   |
| `objects[].rules` | array of object | yes |   |   |
| `objects[].rules[].id` | string | yes |   |   |
| `objects[].rules[].object` | string | yes |   |   |
| `objects[].rules[].name` | string | yes |   |   |
| `objects[].rules[].position` | number | yes |   |   |
| `objects[].rules[].enabled` | boolean | yes |   |   |
| `objects[].rules[].conditions` | array of object | yes |   |   |
| `objects[].rules[].conditions[].field` | string | yes | min length 1, max length 80 | A field of the object (or of the `via` record) |
| `objects[].rules[].conditions[].op` | `"eq"`, `"in"`, `"between"`, `"is_null"`, `"is_not_null"` | yes |   | eq (equals), in (is one of), between [low, high], is_null, is_not_null |
| `objects[].rules[].conditions[].value` | any |   |   |   |
| `objects[].rules[].conditions[].via` | string |   | min length 1, max length 40 | A relation field (e.g. `organisation`): test the related record's field instead |
| `objects[].rules[].method` | `"roundRobin"`, `"user"` | yes |   |   |
| `objects[].rules[].userIds` | array of string | yes |   |   |
| `objects[].fallbackUserId` | string or null | yes |   | Owner when no rule matches; null: no owner |

## assignment.reorder

Set the order of an object's assignment rules (human admins only): pass every rule id of the object, first first. The first enabled rule that matches wins.

|  |  |
| --- | --- |
| Permission | `settings:manage` |
| Risk | `write` |
| Audiences | `staff` |
| Actors | `human` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `object` | string | yes | min length 1, max length 80 | An object with an owner field: person, organisation, or e.g. leads.lead |
| `ids` | array of string (starts_with) | yes | at most 200 |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `rules` | array of object | yes |   |   |
| `rules[].id` | string | yes |   |   |
| `rules[].object` | string | yes |   |   |
| `rules[].name` | string | yes |   |   |
| `rules[].position` | number | yes |   |   |
| `rules[].enabled` | boolean | yes |   |   |
| `rules[].conditions` | array of object | yes |   |   |
| `rules[].conditions[].field` | string | yes | min length 1, max length 80 | A field of the object (or of the `via` record) |
| `rules[].conditions[].op` | `"eq"`, `"in"`, `"between"`, `"is_null"`, `"is_not_null"` | yes |   | eq (equals), in (is one of), between [low, high], is_null, is_not_null |
| `rules[].conditions[].value` | any |   |   |   |
| `rules[].conditions[].via` | string |   | min length 1, max length 40 | A relation field (e.g. `organisation`): test the related record's field instead |
| `rules[].method` | `"roundRobin"`, `"user"` | yes |   |   |
| `rules[].userIds` | array of string | yes |   |   |

## assignment.setFallback

Set the owner given to records of an object when no assignment rule matches (human admins only). null: such records get no owner.

|  |  |
| --- | --- |
| Permission | `settings:manage` |
| Risk | `write` |
| Audiences | `staff` |
| Actors | `human` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `object` | string | yes | min length 1, max length 80 | An object with an owner field: person, organisation, or e.g. leads.lead |
| `userId` | string or null | yes |   |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `object` | string | yes |   |   |
| `userId` | string or null | yes |   |   |

## assignment.test

Show which assignment rule a sample record would match and who it would be assigned to, without creating anything or moving a round-robin rotation. `values` are field values by registry name; for conditions with `via`, give the related record's id as that relation field's value (e.g. organisation). Read-only.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `read` |
| Audiences | `staff` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `object` | string | yes | min length 1, max length 80 | An object with an owner field: person, organisation, or e.g. leads.lead |
| `values` | map of any |   | default `{}` |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `ruleId` | string or null | yes |   |   |
| `ruleName` | string or null | yes |   |   |
| `ownerId` | string or null | yes |   |   |
| `ownerName` | string or null | yes |   |   |
| `fallback` | boolean | yes |   | True when no rule matched and the fallback owner applies |

## assignment.update

Change an assignment rule's name, conditions, method, users or whether it is on (human admins only). Fields left out stay as they are.

|  |  |
| --- | --- |
| Permission | `settings:manage` |
| Risk | `write` |
| Audiences | `staff` |
| Actors | `human` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string (starts_with) | yes | max length 64, pattern `^asr_.*` |   |
| `name` | string |   | min length 1, max length 100 |   |
| `enabled` | boolean |   |   |   |
| `conditions` | array of object |   | at most 20 | All must hold. Empty: the rule matches every record. |
| `conditions[].field` | string | yes | min length 1, max length 80 | A field of the object (or of the `via` record) |
| `conditions[].op` | `"eq"`, `"in"`, `"between"`, `"is_null"`, `"is_not_null"` | yes |   | eq (equals), in (is one of), between [low, high], is_null, is_not_null |
| `conditions[].value` | any |   |   |   |
| `conditions[].via` | string |   | min length 1, max length 40 | A relation field (e.g. `organisation`): test the related record's field instead |
| `method` | `"roundRobin"`, `"user"` |   |   | roundRobin: rotate through userIds in order; user: always the one user |
| `userIds` | array of string |   | at least 1, at most 50 | The users to rotate through, or the one user |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `object` | string | yes |   |   |
| `name` | string | yes |   |   |
| `position` | number | yes |   |   |
| `enabled` | boolean | yes |   |   |
| `conditions` | array of object | yes |   |   |
| `conditions[].field` | string | yes | min length 1, max length 80 | A field of the object (or of the `via` record) |
| `conditions[].op` | `"eq"`, `"in"`, `"between"`, `"is_null"`, `"is_not_null"` | yes |   | eq (equals), in (is one of), between [low, high], is_null, is_not_null |
| `conditions[].value` | any |   |   |   |
| `conditions[].via` | string |   | min length 1, max length 40 | A relation field (e.g. `organisation`): test the related record's field instead |
| `method` | `"roundRobin"`, `"user"` | yes |   |   |
| `userIds` | array of string | yes |   |   |
