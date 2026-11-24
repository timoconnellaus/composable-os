---
title: "rooms.* operations"
description: "The core operations named rooms.*"
sidebar:
  label: "rooms"
editUrl: false
---

## rooms.check

Tool-only (a shipped pack's tool): whether a room is free from `starts` to `ends` (ISO instants, half-open: a claim ending at `starts` does not count), and what takes it then, as rooms.week shows it. Add set-up and pack-down to the times yourself. A guide only: the database still refuses a clash when the record is written. Someone holding a pack's fixed role reads only that the room is taken, and when. Read-only.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `read` |
| Audiences | `staff` |
| Also | called only from a tool's run (`toolOnly`); not offered to MCP clients (`mcp.expose: false`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `roomId` | string | yes | min length 1, max length 64 |   |
| `starts` | string | yes | min length 1, max length 40 |   |
| `ends` | string | yes | min length 1, max length 40 |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `free` | boolean | yes |   |   |
| `claims` | array of object | yes |   |   |
| `claims[].thing` | object | yes |   |   |
| `claims[].thing.object` | string | yes |   |   |
| `claims[].thing.id` | string | yes |   |   |
| `claims[].thing.name` | string or null | yes |   |   |
| `claims[].object` | string or null | yes |   | The occupying object (null to a fixed role) |
| `claims[].label` | string or null | yes |   | Its kind: Class, Appointment, Hire (null to a fixed role) |
| `claims[].id` | string or null | yes |   | The record, for a click-through (null to a fixed role) |
| `claims[].title` | string or null | yes |   | What the calendar shows: the object's declared title, else its label. Never a name |
| `claims[].startsAt` | string or null | yes |   | The record's own start (null to a fixed role) |
| `claims[].endsAt` | string or null | yes |   | The record's own end (null to a fixed role) |
| `claims[].takenFrom` | string | yes |   | When it takes the room from, set-up or a buffer included |
| `claims[].takenTo` | string | yes |   | When it takes the room until, pack-down or a buffer included |
| `claims[].provisional` | boolean or null | yes |   | Held, not yet firm (a hire before its deposit); it refuses a clash all the same |

## rooms.week

Tool-only (a shipped pack's tool): the room calendar, every claim on a room (one booking at a time) from `from` to `to` (local dates in the organisation's zone, both included; at most 62 days), whatever holds it (a class, an appointment, a hire, an event, a block), in order of start: the room, its kind, its title, its own times, the times it takes with set-up and pack-down, and whether it is provisional (a hold). `roomIds` keeps those rooms. Never a client's or a hirer's name, nor any money. Someone holding a pack's fixed role reads only that a room is taken, and when. Read-only.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `read` |
| Audiences | `staff` |
| Also | called only from a tool's run (`toolOnly`); not offered to MCP clients (`mcp.expose: false`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `from` | string | yes | pattern `^\d{4}-\d{2}-\d{2}$` |   |
| `to` | string | yes | pattern `^\d{4}-\d{2}-\d{2}$` |   |
| `roomIds` | array of string |   | at least 1, at most 100 | Only these rooms |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `claims` | array of object | yes |   |   |
| `claims[].thing` | object | yes |   |   |
| `claims[].thing.object` | string | yes |   |   |
| `claims[].thing.id` | string | yes |   |   |
| `claims[].thing.name` | string or null | yes |   |   |
| `claims[].object` | string or null | yes |   | The occupying object (null to a fixed role) |
| `claims[].label` | string or null | yes |   | Its kind: Class, Appointment, Hire (null to a fixed role) |
| `claims[].id` | string or null | yes |   | The record, for a click-through (null to a fixed role) |
| `claims[].title` | string or null | yes |   | What the calendar shows: the object's declared title, else its label. Never a name |
| `claims[].startsAt` | string or null | yes |   | The record's own start (null to a fixed role) |
| `claims[].endsAt` | string or null | yes |   | The record's own end (null to a fixed role) |
| `claims[].takenFrom` | string | yes |   | When it takes the room from, set-up or a buffer included |
| `claims[].takenTo` | string | yes |   | When it takes the room until, pack-down or a buffer included |
| `claims[].provisional` | boolean or null | yes |   | Held, not yet firm (a hire before its deposit); it refuses a clash all the same |
| `zone` | string | yes |   |   |
| `truncated` | boolean | yes |   | More claims than one answer holds (2000): ask for fewer days or rooms |
