---
title: "access.* operations"
description: "The core operations named access.*"
sidebar:
  label: "access"
editUrl: false
---

## access.check

From a tool: which of these records (of an object that declares who holds access to it, such as a course) the caller holds access to now. Staff hold every one; the public none; a customer those a live source gives them (an enrolment, a bundle). Read-only.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `read` |
| Audiences | `staff`, `customer`, `public` |
| Also | called only from a tool's run (`toolOnly`); host-internal (`hostInternal`); not offered to MCP clients (`mcp.expose: false`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `object` | string | yes | min length 1, max length 81 |   |
| `ids` | array of string | yes | at least 1, at most 100 |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `held` | array of string | yes |   |   |
