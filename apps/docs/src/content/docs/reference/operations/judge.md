---
title: "judge.* operations"
description: "The core operations named judge.*"
sidebar:
  label: "judge"
editUrl: false
---

## judge.get

The judge (Jev): whether it has a key, where the key is held and where calls go (never the key), the pinned model, each placement with its switch, fail mode, the data it sends and its spend over the last 30 days, and the policy adjudicator's reviewer. Admins only, people only. Read-only.

|  |  |
| --- | --- |
| Permission | `policy:manage` |
| Risk | `read` |
| Audiences | `staff` |
| Actors | `human` |
| Also | not offered to MCP clients (`mcp.expose: false`) |

### Input

No fields.

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `on` | boolean | yes |   |   |
| `keySource` | `"byok"`, `"secret"` or null | yes |   |   |
| `viaGateway` | boolean | yes |   |   |
| `route` | `"gateway"`, `"direct"` or null | yes |   |   |
| `hosted` | boolean | yes |   |   |
| `problem` | string or null | yes |   |   |
| `keyStore` | object | yes |   |   |
| `keyStore.available` | boolean | yes |   |   |
| `keyStore.via` | `"cloudflare"`, `"control-plane"` or null | yes |   |   |
| `keyStore.missing` | array of string | yes |   |   |
| `model` | string | yes |   |   |
| `pricePerMillionInputTokensUsd` | number | yes |   |   |
| `spendDays` | number | yes |   |   |
| `placements` | array of object | yes |   |   |
| `placements[].id` | string | yes |   |   |
| `placements[].label` | string | yes |   |   |
| `placements[].askedWhen` | string | yes |   |   |
| `placements[].failMode` | string | yes |   |   |
| `placements[].onFailure` | string | yes |   |   |
| `placements[].sends` | string | yes |   |   |
| `placements[].sendsRecordContent` | boolean | yes |   |   |
| `placements[].switchable` | boolean | yes |   |   |
| `placements[].built` | boolean | yes |   |   |
| `placements[].on` | boolean | yes |   |   |
| `placements[].source` | `"shipped"`, `"deploy"`, `"admin"`, `"fixed"` | yes |   |   |
| `placements[].spend` | object | yes |   |   |
| `placements[].spend.calls` | number | yes |   |   |
| `placements[].spend.inputTokens` | number | yes |   |   |
| `placements[].spend.costUsd` | number | yes |   |   |
| `placements[].spendCounted` | boolean | yes |   |   |
| `adjudicatorReviewer` | `"llm"`, `"jev"` | yes |   |   |
| `adjudicatorReviewerSetting` | `"llm"`, `"jev"` or null | yes |   |   |
| `policyRules` | number or null | yes |   |   |
| `maxPolicyRules` | number | yes |   |   |

## judge.setKey

Store or remove the judge's TypeSafe API key (admins): the Worker secret TYPESAFE_API_KEY on cos-app and cos-runner through the Cloudflare API, or, on a hosted workspace, a workspace secret set through the control plane. It takes effect within seconds. The key is never written to the database, the audit log or any response. Removing it turns the judge off, and the policy adjudicator falls back to the LLM reviewer unless it is set to Jev.

|  |  |
| --- | --- |
| Permission | `policy:manage` |
| Risk | `write` |
| Audiences | `staff` |
| Actors | `human` |
| Also | not offered to MCP clients (`mcp.expose: false`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `apiKey` | string or null | yes |   | The TypeSafe API key, or null to remove it |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `stored` | boolean | yes |   |   |
| `targets` | array of string | yes |   |   |

## judge.test

Make one live call to the judge with a fixed sentence (no CRM data) and report whether it answered, how long it took and which model answered, or why it could not. Admins only, people only.

|  |  |
| --- | --- |
| Permission | `policy:manage` |
| Risk | `read` |
| Audiences | `staff` |
| Actors | `human` |
| Also | not offered to MCP clients (`mcp.expose: false`) |

### Input

No fields.

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `ok` | boolean | yes |   |   |
| `model` | string or null | yes |   |   |
| `latencyMs` | number | yes |   |   |
| `reason` | string or null | yes |   |   |
| `detail` | string or null | yes |   |   |

## judge.update

Switch judge placements on or off (null returns one to its default). Turning off a placement that fails closed lets more changes through without a person, so only a human admin can. Admins only, people only.

|  |  |
| --- | --- |
| Permission | `policy:manage` |
| Risk | `write` |
| Audiences | `staff` |
| Actors | `human` |
| Also | not offered to MCP clients (`mcp.expose: false`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `placements` | map of boolean or null | yes |   | Placement id → true (on), false (off) or null (the default) |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `on` | boolean | yes |   |   |
| `keySource` | `"byok"`, `"secret"` or null | yes |   |   |
| `viaGateway` | boolean | yes |   |   |
| `route` | `"gateway"`, `"direct"` or null | yes |   |   |
| `hosted` | boolean | yes |   |   |
| `problem` | string or null | yes |   |   |
| `keyStore` | object | yes |   |   |
| `keyStore.available` | boolean | yes |   |   |
| `keyStore.via` | `"cloudflare"`, `"control-plane"` or null | yes |   |   |
| `keyStore.missing` | array of string | yes |   |   |
| `model` | string | yes |   |   |
| `pricePerMillionInputTokensUsd` | number | yes |   |   |
| `spendDays` | number | yes |   |   |
| `placements` | array of object | yes |   |   |
| `placements[].id` | string | yes |   |   |
| `placements[].label` | string | yes |   |   |
| `placements[].askedWhen` | string | yes |   |   |
| `placements[].failMode` | string | yes |   |   |
| `placements[].onFailure` | string | yes |   |   |
| `placements[].sends` | string | yes |   |   |
| `placements[].sendsRecordContent` | boolean | yes |   |   |
| `placements[].switchable` | boolean | yes |   |   |
| `placements[].built` | boolean | yes |   |   |
| `placements[].on` | boolean | yes |   |   |
| `placements[].source` | `"shipped"`, `"deploy"`, `"admin"`, `"fixed"` | yes |   |   |
| `placements[].spend` | object | yes |   |   |
| `placements[].spend.calls` | number | yes |   |   |
| `placements[].spend.inputTokens` | number | yes |   |   |
| `placements[].spend.costUsd` | number | yes |   |   |
| `placements[].spendCounted` | boolean | yes |   |   |
| `adjudicatorReviewer` | `"llm"`, `"jev"` | yes |   |   |
| `adjudicatorReviewerSetting` | `"llm"`, `"jev"` or null | yes |   |   |
| `policyRules` | number or null | yes |   |   |
| `maxPolicyRules` | number | yes |   |   |
