---
title: "messages.* operations"
description: "The core operations named messages.*"
sidebar:
  label: "messages"
editUrl: false
---

## messages.textSpend

This month's spend on texts (ADR 0672): the segments sent, the estimate the limit is counted with (segments times the price per segment set in Settings → Routine email), what the text provider reported, and the month's limit. Amounts in minor units of the business's currency. Admins only. Read-only.

|  |  |
| --- | --- |
| Permission | `audit:read` |
| Risk | `read` |
| Audiences | `staff` |

### Input

No fields.

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `month` | string | yes |   | YYYY-MM, in the business's zone |
| `segments` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |
| `estimatedMinor` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |
| `reportedMinor` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |
| `limitMinor` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |
| `segmentPriceMinor` | integer or null | yes |   |   |
