---
title: "fieldOptions.* operations"
description: "The core operations named fieldOptions.*"
sidebar:
  label: "fieldOptions"
editUrl: false
---

## fieldOptions.list

List the select fields whose options admins can edit (declared by extensions with editableOptions, such as a lead's status and source): the options in use and the declared defaults. Fixed options cannot be removed. Read-only.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `read` |
| Audiences | `staff` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `object` | string |   | max length 80 |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `items` | array of object | yes |   |   |
| `items[].object` | string | yes |   |   |
| `items[].objectLabel` | string | yes |   |   |
| `items[].field` | string | yes |   |   |
| `items[].label` | string | yes |   |   |
| `items[].extension` | string or null | yes |   |   |
| `items[].options` | array of object | yes |   |   |
| `items[].options[].value` | string | yes | min length 1, max length 100 |   |
| `items[].options[].label` | string | yes | min length 1, max length 100 |   |
| `items[].options[].color` | string |   | max length 20 |   |
| `items[].options[].fixed` | boolean | yes |   |   |
| `items[].defaults` | array of object | yes |   |   |
| `items[].defaults[].value` | string | yes | min length 1, max length 100 |   |
| `items[].defaults[].label` | string | yes | min length 1, max length 100 |   |
| `items[].defaults[].color` | string |   | max length 20 |   |
| `items[].defaults[].fixed` | boolean | yes |   |   |
| `items[].edited` | boolean | yes |   |   |

## fieldOptions.update

Set the options of an editable select field (admins): the full list in order, each { value, label, color? }. New values become choices; fixed options must stay. Records holding a removed option keep their value. Pass options null to go back to the defaults.

|  |  |
| --- | --- |
| Permission | `extensions:manage` |
| Risk | `write` |
| Audiences | `staff` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `object` | string | yes | min length 1, max length 80 |   |
| `field` | string | yes | min length 1, max length 80 |   |
| `options` | array of object or null | yes |   |   |
| `options.value` | string | yes | min length 1, max length 100 |   |
| `options.label` | string | yes | min length 1, max length 100 |   |
| `options.color` | string |   | max length 20 |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `object` | string | yes |   |   |
| `objectLabel` | string | yes |   |   |
| `field` | string | yes |   |   |
| `label` | string | yes |   |   |
| `extension` | string or null | yes |   |   |
| `options` | array of object | yes |   |   |
| `options[].value` | string | yes | min length 1, max length 100 |   |
| `options[].label` | string | yes | min length 1, max length 100 |   |
| `options[].color` | string |   | max length 20 |   |
| `options[].fixed` | boolean | yes |   |   |
| `defaults` | array of object | yes |   |   |
| `defaults[].value` | string | yes | min length 1, max length 100 |   |
| `defaults[].label` | string | yes | min length 1, max length 100 |   |
| `defaults[].color` | string |   | max length 20 |   |
| `defaults[].fixed` | boolean | yes |   |   |
| `edited` | boolean | yes |   |   |
