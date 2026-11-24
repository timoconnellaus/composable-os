---
title: "policy.* operations"
description: "The core operations named policy.*"
sidebar:
  label: "policy"
editUrl: false
---

## policy.get

Get the org's approval policy: the active preset (cautious, balanced or autonomous) and the actor × risk-class matrix it applies, plus the deploy-time floor (rules no preset can loosen; set by the operator in env, not changeable here). Read-only.

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
| `preset` | `"cautious"`, `"balanced"`, `"autonomous"` | yes |   |   |
| `matrix` | map of map of any | yes |   |   |
| `floor` | map of map of any | yes |   |   |

## policy.update

Change the org's approval-policy preset. Admins only, and only a human can call it: AI assistants, MCP clients and automations are refused. The deploy-time floor still applies on top of any preset.

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
| `preset` | `"cautious"`, `"balanced"`, `"autonomous"` | yes |   |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `preset` | `"cautious"`, `"balanced"`, `"autonomous"` | yes |   |   |
| `matrix` | map of map of any | yes |   |   |
| `floor` | map of map of any | yes |   |   |
| `previousPreset` | `"cautious"`, `"balanced"`, `"autonomous"` | yes |   |   |
| `loosened` | boolean | yes |   |   |
