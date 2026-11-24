---
title: "capacity.* operations"
description: "The core operations named capacity.*"
sidebar:
  label: "capacity"
editUrl: false
---

## capacity.get

How many places a record of an object with a capacity has left (a ticket type, a class). Staff get places, held (while someone pays), taken (paid), available, and the pool's numbers when the record draws on a parent's places. Customers and the public get only what the object shows: the number left, a low-stock warning, or available / sold out. Read-only; claims nothing.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `read` |
| Audiences | `staff`, `customer`, `public` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `object` | string | yes | min length 1, max length 80 | An extension object that declares a capacity |
| `id` | string | yes | min length 1, max length 64 |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `object` | string | yes |   |   |
| `id` | string | yes |   |   |
| `status` | `"available"`, `"low"`, `"sold_out"` | yes |   | `low` only when the object shows a low-stock warning and few are left |
| `available` | number or null |   |   | Places left; null when unlimited. Shown to outsiders only when `show` allows |
| `places` | number or null |   |   |   |
| `held` | number |   |   |   |
| `taken` | number |   |   |   |
| `show` | `"exact"`, `"low"`, `"availability"` |   |   |   |
| `lowAt` | number or null |   |   |   |
| `pool` | object or null |   |   |   |
| `pool.object` | string | yes |   |   |
| `pool.id` | string | yes |   |   |
| `pool.places` | number or null | yes |   |   |
| `pool.held` | number | yes |   |   |
| `pool.taken` | number | yes |   |   |
| `pool.available` | number or null | yes |   |   |
