---
title: "message.* operations"
description: "The core operations named message.*"
sidebar:
  label: "message"
editUrl: false
---

## message.note

Write a staff note on a conversation: staff only, never sent to the person and never shown to them. mentions names staff (usr_…) who are told in the app; on a private conversation only admins and whoever has it can be mentioned. Returns the note's id.

|  |  |
| --- | --- |
| Permission | `inbox:work` |
| Risk | `write` |
| Audiences | `staff` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string (starts_with) | yes | max length 64, pattern `^cnv_.*` | Conversation id (cnv_…) |
| `body` | string | yes | min length 1, max length 10000 | The note, in plain words |
| `mentions` | array of string (starts_with) |   | at most 20, default `[]` | Staff to tell (usr_…) |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `conversationId` | string | yes |   |   |
