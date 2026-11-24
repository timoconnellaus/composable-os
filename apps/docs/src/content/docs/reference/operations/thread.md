---
title: "thread.* operations"
description: "The core operations named thread.*"
sidebar:
  label: "thread"
editUrl: false
---

## thread.deleteMessage

Delete a message from your assistant chat: one of yours, or a whole reply (its text, tool calls and results). It leaves the chat and its search, and the assistant no longer sees it. Memory lines saved from it are deleted too. Changes it made or proposed are not undone.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `write` |
| Audiences | `staff` |
| Actors | `human` |
| Also | bookkeeping, never queued for review; not offered to MCP clients (`mcp.expose: false`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `seq` | integer | yes | ≥ 1, ≤ 9007199254740991 | The message's seq |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `deleted` | array of number | yes |   |   |

## thread.finishTurn

Record that a turn of your thread finished: its preview, the unread count, and the records it referenced (for erase). Called by the thread itself once per turn.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `write` |
| Audiences | `staff` |
| Actors | `human` |
| Also | bookkeeping, never queued for review; not offered to MCP clients (`mcp.expose: false`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes | pattern `^ath_[0-9A-Za-z]{10,40}$` | An assistant thread id (ath_…) |
| `preview` | string or null | yes |   |   |
| `unread` | integer | yes | ≥ 0, ≤ 9007199254740991 |   |
| `refs` | array of string |   | at most 500 | People and organisations (ids) and emails (email:&lt;sha256&gt;) the turn referenced, for erase |
| `cache` | object |   |   | The turn's cache observations and planner decision, sizes and times only |
| `cache.role` | string | yes | min length 1, max length 60 |   |
| `cache.model` | object | yes |   |   |
| `cache.model.provider` | string | yes | min length 1, max length 60 |   |
| `cache.model.model` | string | yes | min length 1, max length 200 |   |
| `cache.model.publishedLifetimeSeconds` | number or null | yes |   |   |
| `cache.observations` | array of object | yes | at most 64 |   |
| `cache.observations[].workspaceId` | string |   |   |   |
| `cache.observations[].provider` | string | yes | min length 1 |   |
| `cache.observations[].model` | string | yes | min length 1 |   |
| `cache.observations[].role` | string |   |   |   |
| `cache.observations[].at` | string | yes |   |   |
| `cache.observations[].gapSeconds` | number | yes | ≥ 0 |   |
| `cache.observations[].prefixUnchanged` | boolean | yes |   |   |
| `cache.observations[].cachedTokens` | number | yes | ≥ 0 |   |
| `cache.observations[].promptTokens` | number | yes | ≥ 0 |   |
| `cache.observations[].prefixTokens` | number or null |   |   |   |
| `cache.decisions` | array of object | yes | at most 4 |   |
| `cache.decisions[].id` | string | yes | min length 1 |   |
| `cache.decisions[].workspaceId` | string |   |   |   |
| `cache.decisions[].provider` | string | yes | min length 1 |   |
| `cache.decisions[].model` | string | yes | min length 1 |   |
| `cache.decisions[].role` | string |   |   |   |
| `cache.decisions[].at` | string | yes |   |   |
| `cache.decisions[].input` | object | yes |   |   |
| `cache.decisions[].input.moment` | `"turn-end"`, `"idle"` | yes |   |   |
| `cache.decisions[].input.now` | number | yes |   |   |
| `cache.decisions[].input.lastRequestAt` | number | yes |   |   |
| `cache.decisions[].input.contextTokens` | number | yes | ≥ 0 |   |
| `cache.decisions[].input.compactedTokens` | number | yes | ≥ 0 |   |
| `cache.decisions[].input.noteTokens` | number | yes | ≥ 0 |   |
| `cache.decisions[].input.contextWindow` | number | yes | &gt; 0 |   |
| `cache.decisions[].input.prices` | object | yes |   |   |
| `cache.decisions[].input.prices.input` | number or null | yes |   |   |
| `cache.decisions[].input.prices.output` | number or null | yes |   |   |
| `cache.decisions[].input.prices.cacheWrite` | number or null |   |   |   |
| `cache.decisions[].input.prices.cachedInput` | number or null |   |   |   |
| `cache.decisions[].input.lifetime` | object | yes |   |   |
| `cache.decisions[].input.lifetime.seconds` | number or null | yes |   |   |
| `cache.decisions[].input.lifetime.source` | `"published"`, `"learned"`, `"fallback"` | yes |   |   |
| `cache.decisions[].input.lifetime.confidence` | number or null |   |   |   |
| `cache.decisions[].input.usage` | object | yes |   |   |
| `cache.decisions[].input.usage.gapShares` | array of number | yes |   |   |
| `cache.decisions[].input.usage.addedTokensPerTurn` | number | yes | ≥ 0 |   |
| `cache.decisions[].input.usage.outputTokensPerTurn` | number | yes | ≥ 0 |   |
| `cache.decisions[].input.rails` | object |   |   |   |
| `cache.decisions[].input.rails.minTokens` | number |   | ≥ 0 |   |
| `cache.decisions[].input.rails.maxShareOfWindow` | number |   |   |   |
| `cache.decisions[].input.params` | object |   |   |   |
| `cache.decisions[].input.params.maxHorizonTurns` | number |   |   |   |
| `cache.decisions[].input.params.fallbackIdleSeconds` | number |   |   |   |
| `cache.decisions[].input.params.alarmMarginMinSeconds` | number |   |   |   |
| `cache.decisions[].input.params.alarmMarginShare` | number |   |   |   |
| `cache.decisions[].input.params.fallbackWarmSeconds` | number |   |   |   |
| `cache.decisions[].result` | object | yes |   |   |
| `cache.decisions[].result.decision` | `"compact"`, `"continue"` | yes |   |   |
| `cache.decisions[].result.rule` | `"ceiling"`, `"floor"`, `"cost"`, `"fallback"`, `"unknown-prices"` | yes |   |   |
| `cache.decisions[].result.costContinue` | number or null | yes |   |   |
| `cache.decisions[].result.costCompact` | number or null | yes |   |   |
| `cache.decisions[].result.horizonTurns` | number | yes | &gt; 0 |   |
| `cache.decisions[].result.nextAlarmAt` | number or null | yes |   |   |
| `cache.decisions[].actual` | object or null | yes |   |   |
| `cache.decisions[].actual.turns` | integer | yes | &gt; 0, ≤ 9007199254740991 |   |
| `cache.decisions[].actual.cost` | number | yes | ≥ 0 |   |
| `cache.actuals` | array of object | yes | at most 32 |   |
| `cache.actuals[].id` | string | yes | min length 1 |   |
| `cache.actuals[].turns` | integer | yes | &gt; 0, ≤ 9007199254740991 |   |
| `cache.actuals[].cost` | number | yes | ≥ 0 |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `turns` | number | yes |   |   |
| `unread` | number | yes |   |   |
| `preview` | string or null | yes |   |   |
| `lastActivityAt` | string or null | yes |   |   |
| `cacheEstimate` | object or null | yes |   |   |
| `cacheEstimate.provider` | string | yes |   |   |
| `cacheEstimate.model` | string | yes |   |   |
| `cacheEstimate.seconds` | number or null | yes |   |   |
| `cacheEstimate.source` | `"published"`, `"learned"`, `"fallback"` | yes |   |   |
| `cacheEstimate.confidence` | number or null | yes |   |   |

## thread.markSeen

Mark your assistant chat as seen up to a message (the newest when no seq is given), which clears the unread badge.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `write` |
| Audiences | `staff` |
| Actors | `human` |
| Also | bookkeeping, never queued for review; not offered to MCP clients (`mcp.expose: false`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `seq` | integer |   | ≥ 0, ≤ 9007199254740991 |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `unread` | number | yes |   |   |
| `lastSeenSeq` | number | yes |   |   |

## thread.open

Your assistant thread's id, creating its bookkeeping row the first time. Called by the thread itself before its first turn.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `write` |
| Audiences | `staff` |
| Actors | `human` |
| Also | bookkeeping, never queued for review; not offered to MCP clients (`mcp.expose: false`) |

### Input

No fields.

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `turns` | number | yes |   |   |
| `unread` | number | yes |   |   |
| `preview` | string or null | yes |   |   |
| `lastActivityAt` | string or null | yes |   |   |

## thread.search

Search your whole chat with the assistant, including messages from long ago that are no longer in view. Matches every word given (as a word prefix), newest first, and returns each message's seq, who wrote it, when, and its words around the match. Read-only.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `read` |
| Audiences | `staff` |
| Actors | `human`, `assistant` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `query` | string | yes | min length 1, max length 200 | Words to look for |
| `limit` | integer |   | ≥ 1, ≤ 50, default `20` |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `hits` | array of object | yes |   |   |
| `hits[].seq` | number | yes |   |   |
| `hits[].turn` | number | yes |   |   |
| `hits[].role` | `"user"`, `"assistant"`, `"tool"`, `"notice"` | yes |   |   |
| `hits[].at` | string | yes |   |   |
| `hits[].text` | string | yes |   |   |

## thread.status

Your assistant thread at a glance: how many replies you have not seen, and when it was last active. Read-only.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `read` |
| Audiences | `staff` |
| Actors | `human` |
| Also | not offered to MCP clients (`mcp.expose: false`) |

### Input

No fields.

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string or null | yes |   |   |
| `unread` | number | yes |   |   |
| `lastActivityAt` | string or null | yes |   |   |
