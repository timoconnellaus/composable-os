---
title: "location.* operations"
description: "The core operations named location.*"
sidebar:
  label: "location"
editUrl: false
---

## location.close

Close a location: it takes no new classes, appointments or shifts. Classes already made there are not cancelled (cancel them with the closure or cancel tools, which tell members). The last open location cannot be closed. A person only, never an AI. Returns the location.

|  |  |
| --- | --- |
| Permission | `settings:manage` |
| Risk | `destructive` |
| Audiences | `staff` |
| Actors | `human` |
| Also | not offered to MCP clients (`mcp.expose: false`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes | min length 1, max length 64 | A location's id (loc_…) |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `name` | string | yes |   |   |
| `shortName` | string or null | yes |   |   |
| `address` | string or null | yes |   |   |
| `timezone` | string | yes |   |   |
| `public` | boolean | yes |   | Shown on the website and in the app while open |
| `dropInPrice` | integer or null | yes |   |   |
| `state` | `"open"`, `"closed"` | yes |   |   |
| `notes` | string or null | yes |   |   |
| `main` | boolean | yes |   | The main location: the first, whose zone is the organisation's (pay and the books) |
| `createdAt` | string | yes |   |   |
| `updatedAt` | string | yes |   |   |

## location.create

Add a place the business works from (a second studio, a branch), open from now. Its time zone defaults to the organisation's. Its name is unique among locations. A request from an AI always waits for a person to apply it. Returns the location.

|  |  |
| --- | --- |
| Permission | `settings:manage` |
| Risk | `write` |
| Audiences | `staff` |
| Actors | `human`, `assistant`, `mcp` |
| Also | always reviewed when called by `assistant`, `mcp` (`alwaysReview`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `name` | string | yes | min length 1, max length 120 | The location's name, e.g. City studio |
| `shortName` | string |   | min length 1, max length 16 | A short name for a badge, at most 16 characters, e.g. "City" |
| `address` | string |   | min length 1, max length 500 | The location's address, one line per line of the address |
| `timezone` | string |   | max length 64 | The IANA time zone the location works in, e.g. Europe/London |
| `public` | boolean |   | default `true` | Show it on the website and in the app |
| `dropInPrice` | integer |   | ≥ 0, ≤ 100000000 | A drop-in's price at this location, in minor units of the deployment's currency (cents). Used when the class type sets none; null: the organisation's price |
| `notes` | string |   | max length 5000 | Notes for staff; never shown to the public |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `name` | string | yes |   |   |
| `shortName` | string or null | yes |   |   |
| `address` | string or null | yes |   |   |
| `timezone` | string | yes |   |   |
| `public` | boolean | yes |   | Shown on the website and in the app while open |
| `dropInPrice` | integer or null | yes |   |   |
| `state` | `"open"`, `"closed"` | yes |   |   |
| `notes` | string or null | yes |   |   |
| `main` | boolean | yes |   | The main location: the first, whose zone is the organisation's (pay and the books) |
| `createdAt` | string | yes |   |   |
| `updatedAt` | string | yes |   |   |

## location.get

One place the business works from. Read-only.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `read` |
| Audiences | `staff` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes | min length 1, max length 64 | A location's id (loc_…) |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `name` | string | yes |   |   |
| `shortName` | string or null | yes |   |   |
| `address` | string or null | yes |   |   |
| `timezone` | string | yes |   |   |
| `public` | boolean | yes |   | Shown on the website and in the app while open |
| `dropInPrice` | integer or null | yes |   |   |
| `state` | `"open"`, `"closed"` | yes |   |   |
| `notes` | string or null | yes |   |   |
| `main` | boolean | yes |   | The main location: the first, whose zone is the organisation's (pay and the books) |
| `createdAt` | string | yes |   |   |
| `updatedAt` | string | yes |   |   |

## location.list

Every place the business works from (a studio, a branch), the main location first: each one's name, short name, address, time zone, whether the public is shown it, its drop-in price, and whether it is open or closed. Read-only.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `read` |
| Audiences | `staff` |

### Input

No fields.

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `items` | array of object | yes |   |   |
| `items[].id` | string | yes |   |   |
| `items[].name` | string | yes |   |   |
| `items[].shortName` | string or null | yes |   |   |
| `items[].address` | string or null | yes |   |   |
| `items[].timezone` | string | yes |   |   |
| `items[].public` | boolean | yes |   | Shown on the website and in the app while open |
| `items[].dropInPrice` | integer or null | yes |   |   |
| `items[].state` | `"open"`, `"closed"` | yes |   |   |
| `items[].notes` | string or null | yes |   |   |
| `items[].main` | boolean | yes |   | The main location: the first, whose zone is the organisation's (pay and the books) |
| `items[].createdAt` | string | yes |   |   |
| `items[].updatedAt` | string | yes |   |   |

## location.reopen

Open a closed location again: it takes new classes, appointments and shifts. A person only, never an AI. Returns the location.

|  |  |
| --- | --- |
| Permission | `settings:manage` |
| Risk | `write` |
| Audiences | `staff` |
| Actors | `human` |
| Also | not offered to MCP clients (`mcp.expose: false`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes | min length 1, max length 64 | A location's id (loc_…) |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `name` | string | yes |   |   |
| `shortName` | string or null | yes |   |   |
| `address` | string or null | yes |   |   |
| `timezone` | string | yes |   |   |
| `public` | boolean | yes |   | Shown on the website and in the app while open |
| `dropInPrice` | integer or null | yes |   |   |
| `state` | `"open"`, `"closed"` | yes |   |   |
| `notes` | string or null | yes |   |   |
| `main` | boolean | yes |   | The main location: the first, whose zone is the organisation's (pay and the books) |
| `createdAt` | string | yes |   |   |
| `updatedAt` | string | yes |   |   |

## location.update

Change a location's name, short name, address, time zone, whether the public is shown it, its drop-in price or its notes; null clears an optional one. The main location's zone is the organisation's, changed in Settings → General (settings.update), not here. Records already made keep their own zone. A request from an AI always waits for a person to apply it. Returns the location.

|  |  |
| --- | --- |
| Permission | `settings:manage` |
| Risk | `write` |
| Audiences | `staff` |
| Actors | `human`, `assistant`, `mcp` |
| Also | always reviewed when called by `assistant`, `mcp` (`alwaysReview`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes | min length 1, max length 64 | A location's id (loc_…) |
| `name` | string |   | min length 1, max length 120 | The location's name, e.g. City studio |
| `shortName` | string or null |   |   |   |
| `address` | string or null |   |   |   |
| `timezone` | string |   | max length 64 | The IANA time zone the location works in, e.g. Europe/London |
| `public` | boolean |   |   | Show it on the website and in the app |
| `dropInPrice` | integer or null |   |   |   |
| `notes` | string or null |   |   |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `name` | string | yes |   |   |
| `shortName` | string or null | yes |   |   |
| `address` | string or null | yes |   |   |
| `timezone` | string | yes |   |   |
| `public` | boolean | yes |   | Shown on the website and in the app while open |
| `dropInPrice` | integer or null | yes |   |   |
| `state` | `"open"`, `"closed"` | yes |   |   |
| `notes` | string or null | yes |   |   |
| `main` | boolean | yes |   | The main location: the first, whose zone is the organisation's (pay and the books) |
| `createdAt` | string | yes |   |   |
| `updatedAt` | string | yes |   |   |
