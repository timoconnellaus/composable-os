---
title: "intake.* operations"
description: "The core operations named intake.*"
sidebar:
  label: "intake"
editUrl: false
---

## intake.open

From a pack's tool: one of its forms as the caller may answer it now (published, open, within its dates and open to them; otherwise not found, whatever the reason). Returns the published version's number and content (its questions, title and thank-you words) and, for a caller who is not signed in, `shown`: the host's token of when the form was shown, which intake.submit needs to tell a person from a script. Give the form's id, or its address (`slug`) when the form object has one: a link or a QR code names a form by its address. Read-only.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `read` |
| Audiences | `staff`, `customer`, `public` |
| Also | called only from a tool's run (`toolOnly`); host-internal (`hostInternal`); not offered to MCP clients (`mcp.expose: false`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `object` | string | yes | min length 1, max length 81 | The form object, e.g. forms.form |
| `id` | string |   | min length 1, max length 64 |   |
| `slug` | string |   | min length 1, max length 200 | The form's address, instead of id |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `version` | number | yes |   |   |
| `content` | map of any | yes |   |   |
| `anonymous` | boolean | yes |   |   |
| `turnstile` | boolean | yes |   | Whether the caller must pass a Turnstile token to intake.submit |
| `shown` | string or null | yes |   |   |

## intake.submit

From a pack's tool: send answers to one of its forms (the public-write door, ADR 0720). The host checks the form takes answers from the caller now, a visitor's Turnstile token and shown time, the caps and the answers against the published version; then keeps one submission, matching or making the submitter's Person by the address answered (only empty fields of a Person are filled), and any destination record the form names, in one batch, and tells staff. Answers that break the version are refused naming the question's key, never the value. A submission kept as spam, or dropped by the honeypot or the fill time, is answered exactly as a kept one: { received: true }.

|  |  |
| --- | --- |
| Permission | `records:write` |
| Risk | `write` |
| Audiences | `staff`, `customer`, `public` |
| Also | called only from a tool's run (`toolOnly`); host-internal (`hostInternal`); not offered to MCP clients (`mcp.expose: false`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `object` | string | yes | min length 1, max length 81 | The form object, e.g. forms.form |
| `id` | string | yes | min length 1, max length 64 |   |
| `answers` | map of any | yes |   | The answers by question key, as the client sends them |
| `via` | `"site"`, `"app"`, `"page"`, `"link"`, `"staff"` |   |   | Which way in: site, app or page |
| `version` | integer |   | &gt; 0, ≤ 9007199254740991 | The version intake.open showed: refused when another has been published since |
| `turnstileToken` | string |   | max length 4096 | A visitor's Turnstile token |
| `shown` | string |   | max length 200 | intake.open's shown token |
| `honeypot` | string |   | max length 1000 | The hidden field a person leaves empty |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `received` | `true` | yes |   |   |
