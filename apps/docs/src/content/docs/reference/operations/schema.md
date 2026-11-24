---
title: "schema.* operations"
description: "The core operations named schema.*"
sidebar:
  label: "schema"
editUrl: false
---

## schema.objects

List every object in the field registry (core objects and extension objects) with their fields: name, label, type, filterability, sortability, whether computed, and type options (select choices, relation target, formula expression). Use it before record.* and list filters. Read-only.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `read` |
| Audiences | `staff` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `object` | string |   | min length 1, max length 80, pattern `^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)?$` | Object: an extension object (`<extension>.<object>`) or a core object |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `objects` | array of object | yes |   |   |
| `objects[].name` | string | yes |   |   |
| `objects[].label` | string | yes |   |   |
| `objects[].plural` | string or null | yes |   |   |
| `objects[].icon` | string or null | yes |   |   |
| `objects[].titleField` | string or null | yes |   |   |
| `objects[].extension` | string or null | yes |   |   |
| `objects[].description` | string or null | yes |   |   |
| `objects[].view` | string | yes |   |   |
| `objects[].fields` | array of object | yes |   |   |
| `objects[].fields[].name` | string | yes |   |   |
| `objects[].fields[].label` | string | yes |   |   |
| `objects[].fields[].type` | string | yes |   |   |
| `objects[].fields[].fieldType` | string or null | yes |   |   |
| `objects[].fields[].enumValues` | array of string or null | yes |   |   |
| `objects[].fields[].multi` | boolean | yes |   |   |
| `objects[].fields[].filterable` | boolean | yes |   |   |
| `objects[].fields[].sortable` | boolean | yes |   |   |
| `objects[].fields[].readOnly` | boolean | yes |   |   |
| `objects[].fields[].required` | boolean | yes |   |   |
| `objects[].fields[].track` | boolean | yes |   |   |
| `objects[].fields[].extension` | string or null | yes |   |   |
| `objects[].fields[].description` | string or null | yes |   |   |
| `objects[].fields[].options` | map of any or null | yes |   |   |
| `objects[].navigation` | `"main"`, `"settings"`, `"none"` | yes |   |   |
| `objects[].stages` | map of any or null | yes |   |   |
| `objects[].capacity` | object or null | yes |   |   |
| `objects[].capacity.places` | string | yes |   |   |
| `objects[].capacity.pool` | object or null | yes |   |   |
| `objects[].capacity.pool.field` | string | yes |   |   |
| `objects[].capacity.pool.object` | string | yes |   |   |
| `objects[].capacity.show` | `"exact"`, `"low"`, `"availability"` | yes |   |   |
| `objects[].capacity.lowAt` | number or null | yes |   |   |
| `objects[].capacity.releaseOnRefund` | boolean | yes |   |   |
| `objects[].sellable` | map of any or null | yes |   |   |
| `objects[].states` | map of any or null | yes |   |   |
| `objects[].publishable` | object or null | yes |   |   |
| `objects[].publishable.content` | array of string | yes |   |   |
| `objects[].publishable.slug` | string or null | yes |   |   |
| `objects[].publishable.date` | string or null | yes |   |   |
| `objects[].publishable.public` | boolean | yes |   |   |
| `objects[].publishable.acknowledged` | boolean | yes |   |   |
| `objects[].timelineLinks` | array of string | yes |   |   |
| `objects[].ownerField` | string or null | yes |   |   |
| `objects[].navigationOrder` | number | yes |   |   |
| `objects[].titleDefaultFrom` | array of string | yes |   |   |
