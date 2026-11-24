---
title: "dictation.* operations"
description: "The core operations named dictation.*"
sidebar:
  label: "dictation"
editUrl: false
---

## dictation.cleanup

Tidies dictated text: removes fillers, fixes punctuation and applies self-corrections, spelling names from the records on screen and those your chat mentioned. Returns the text unchanged when AI is not available. Read-only.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `read` |
| Audiences | `staff` |
| Actors | `human` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `text` | string | yes | min length 1, max length 20000 |   |
| `names` | array of string |   | at most 100, default `[]` | Names on screen |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `text` | string | yes |   |   |
| `changed` | boolean | yes |   |   |
