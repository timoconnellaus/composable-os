---
title: "settings.* operations"
description: "The core operations named settings.*"
sidebar:
  label: "settings"
editUrl: false
---

## settings.get

Get the org's general settings: the base currency every currency field (deal values, budgets) is shown in, the organisation's name, logo and timezone, and the assistant's name. Read-only.

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
| `baseCurrency` | string | yes | pattern `^[A-Z]{3}$` | ISO 4217 code of the deployment's one currency, e.g. USD, EUR, AUD |
| `orgName` | string or null | yes |   | The organisation's name |
| `logo` | string or null | yes |   | A small logo image as a data: URL (PNG, JPEG, GIF, WebP or SVG), or null |
| `timezone` | string | yes | max length 64 | IANA timezone the organisation works in, e.g. Europe/London |
| `assistantName` | string | yes | min length 1, max length 40 | The in-app assistant's display name, shown in the UI (default "Assistant") |

## settings.update

Change the org's general settings (admins). baseCurrency is the ISO 4217 code currency fields display in; changing it relabels amounts and does not convert them. orgName, logo (a data: URL) and timezone describe the organisation; assistantName renames the in-app assistant. AI models are chosen in Settings → AI, not here.

|  |  |
| --- | --- |
| Permission | `settings:manage` |
| Risk | `write` |
| Audiences | `staff` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `baseCurrency` | string |   | pattern `^[A-Z]{3}$` | ISO 4217 code of the deployment's one currency, e.g. USD, EUR, AUD |
| `orgName` | string or null |   |   | The organisation's name |
| `logo` | string or null |   |   | A small logo image as a data: URL (PNG, JPEG, GIF, WebP or SVG), or null |
| `timezone` | string |   | max length 64 | IANA timezone the organisation works in, e.g. Europe/London |
| `assistantName` | string |   | min length 1, max length 40 | The in-app assistant's display name, shown in the UI (default "Assistant") |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `baseCurrency` | string | yes | pattern `^[A-Z]{3}$` | ISO 4217 code of the deployment's one currency, e.g. USD, EUR, AUD |
| `orgName` | string or null | yes |   | The organisation's name |
| `logo` | string or null | yes |   | A small logo image as a data: URL (PNG, JPEG, GIF, WebP or SVG), or null |
| `timezone` | string | yes | max length 64 | IANA timezone the organisation works in, e.g. Europe/London |
| `assistantName` | string | yes | min length 1, max length 40 | The in-app assistant's display name, shown in the UI (default "Assistant") |
