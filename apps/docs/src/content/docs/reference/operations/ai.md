---
title: "ai.* operations"
description: "The core operations named ai.*"
sidebar:
  label: "ai"
editUrl: false
---

## ai.cacheReport

Export the prompt cache review data (admins): cache observations, compaction decisions with what the following turns really cost, and each change of a learned lifetime. Sizes, prices and times only, never message content. The JSON is what `pnpm ai:replay-cache` reads; the CSV is one table for a spreadsheet. Read-only.

|  |  |
| --- | --- |
| Permission | `settings:manage` |
| Risk | `read` |
| Audiences | `staff` |
| Actors | `human` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `format` | `"json"`, `"csv"` |   | default `"json"` |   |
| `since` | string (date-time) |   | pattern `^(?:(?:\d\d[2468][048]\|\d\d[13579][26]\|\d\d0[48]\|[02468][048]00\|[13579][26]00)-02-29\|\d{4}-(?:(?:0[13578]\|1[02])-(?:0[1-9]\|[12]\d\|3[01])\|(?:0[469]\|11)-(?:0[1-9]\|[12]\d\|30)\|(?:02)-(?:0[1-9]\|1\d\|2[0-8])))T(?:(?:[01]\d\|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z))$` | Only rows at or after this time |
| `limit` | integer |   | ≥ 1, ≤ 50000, default `50000` | Newest rows per table |

### Output

No fields.

## ai.cacheSettings

Settings → AI (admins): the prompt cache lifetime in use per provider and model, where it comes from (published or learned) and how sure it is, and the compaction rails. Read-only.

|  |  |
| --- | --- |
| Permission | `settings:manage` |
| Risk | `read` |
| Audiences | `staff` |
| Actors | `human` |

### Input

No fields.

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `rails` | object | yes |   |   |
| `rails.minTokens` | integer | yes | ≥ 1000, ≤ 2000000 |   |
| `rails.maxShareOfWindow` | number | yes | ≥ 0.1, ≤ 1 |   |
| `rails.fallbackIdleMinutes` | integer | yes | ≥ 1, ≤ 1440 |   |
| `defaults` | object | yes |   |   |
| `defaults.minTokens` | integer | yes | ≥ 1000, ≤ 2000000 |   |
| `defaults.maxShareOfWindow` | number | yes | ≥ 0.1, ≤ 1 |   |
| `defaults.fallbackIdleMinutes` | integer | yes | ≥ 1, ≤ 1440 |   |
| `estimates` | array of object | yes |   |   |
| `estimates[].provider` | string | yes |   |   |
| `estimates[].model` | string | yes |   |   |
| `estimates[].seconds` | number or null | yes |   |   |
| `estimates[].source` | `"published"`, `"learned"`, `"fallback"` | yes |   |   |
| `estimates[].learnedSeconds` | number or null | yes |   |   |
| `estimates[].publishedSeconds` | number or null | yes |   |   |
| `estimates[].confidence` | number or null | yes |   |   |
| `estimates[].sampleSize` | number | yes |   |   |
| `estimates[].updatedAt` | string | yes |   |   |

## ai.connectGateway

Hosted workspaces only (admins): connect the customer's own AI Gateway, so calls with their own provider keys go through it and they get its logs and spend. Takes the Cloudflare account id, the gateway id and, for an authenticated gateway, a token with AI Gateway Run. Stored as a secret on the workspace's Workers through the control plane, never in the database. Platform AI never goes through it. Pass `disconnect` to remove it.

|  |  |
| --- | --- |
| Permission | `settings:manage` |
| Risk | `write` |
| Audiences | `staff` |
| Actors | `human` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `disconnect` | boolean |   | default `false` |   |
| `accountId` | string |   | pattern `^[a-f0-9]{32}$` |   |
| `gatewayId` | string |   | pattern `^[a-z0-9][a-z0-9-_]{0,63}$` |   |
| `token` | string |   | min length 8, max length 4096 |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `connected` | boolean | yes |   |   |
| `gatewayId` | string or null | yes |   |   |

## ai.deleteProviderKey

Remove a provider's key (admins): deletes the Workers secret from cos-app and cos-runner, or forgets that the provider's key is held by AI Gateway (remove it there too).

|  |  |
| --- | --- |
| Permission | `settings:manage` |
| Risk | `write` |
| Audiences | `staff` |
| Actors | `human` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `provider` | `"openai"`, `"google"`, `"openrouter"`, `"deepseek"`, `"anthropic"`, `"openai-compatible"`, `"custom"`, `"assemblyai"` | yes |   |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `provider` | string | yes |   |   |

## ai.recordCacheReview

Record cache observations and compaction decisions from your assistant thread when no turn is finishing (an idle alarm, a compaction). Called by the thread itself.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `write` |
| Audiences | `staff` |
| Actors | `human` |
| Also | bookkeeping, never queued for review |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `role` | string | yes | min length 1, max length 60 |   |
| `model` | object | yes |   |   |
| `model.provider` | string | yes | min length 1, max length 60 |   |
| `model.model` | string | yes | min length 1, max length 200 |   |
| `model.publishedLifetimeSeconds` | number or null | yes |   |   |
| `observations` | array of object | yes | at most 64 |   |
| `observations[].workspaceId` | string |   |   |   |
| `observations[].provider` | string | yes | min length 1 |   |
| `observations[].model` | string | yes | min length 1 |   |
| `observations[].role` | string |   |   |   |
| `observations[].at` | string | yes |   |   |
| `observations[].gapSeconds` | number | yes | ≥ 0 |   |
| `observations[].prefixUnchanged` | boolean | yes |   |   |
| `observations[].cachedTokens` | number | yes | ≥ 0 |   |
| `observations[].promptTokens` | number | yes | ≥ 0 |   |
| `observations[].prefixTokens` | number or null |   |   |   |
| `decisions` | array of object | yes | at most 4 |   |
| `decisions[].id` | string | yes | min length 1 |   |
| `decisions[].workspaceId` | string |   |   |   |
| `decisions[].provider` | string | yes | min length 1 |   |
| `decisions[].model` | string | yes | min length 1 |   |
| `decisions[].role` | string |   |   |   |
| `decisions[].at` | string | yes |   |   |
| `decisions[].input` | object | yes |   |   |
| `decisions[].input.moment` | `"turn-end"`, `"idle"` | yes |   |   |
| `decisions[].input.now` | number | yes |   |   |
| `decisions[].input.lastRequestAt` | number | yes |   |   |
| `decisions[].input.contextTokens` | number | yes | ≥ 0 |   |
| `decisions[].input.compactedTokens` | number | yes | ≥ 0 |   |
| `decisions[].input.noteTokens` | number | yes | ≥ 0 |   |
| `decisions[].input.contextWindow` | number | yes | &gt; 0 |   |
| `decisions[].input.prices` | object | yes |   |   |
| `decisions[].input.prices.input` | number or null | yes |   |   |
| `decisions[].input.prices.output` | number or null | yes |   |   |
| `decisions[].input.prices.cacheWrite` | number or null |   |   |   |
| `decisions[].input.prices.cachedInput` | number or null |   |   |   |
| `decisions[].input.lifetime` | object | yes |   |   |
| `decisions[].input.lifetime.seconds` | number or null | yes |   |   |
| `decisions[].input.lifetime.source` | `"published"`, `"learned"`, `"fallback"` | yes |   |   |
| `decisions[].input.lifetime.confidence` | number or null |   |   |   |
| `decisions[].input.usage` | object | yes |   |   |
| `decisions[].input.usage.gapShares` | array of number | yes |   |   |
| `decisions[].input.usage.addedTokensPerTurn` | number | yes | ≥ 0 |   |
| `decisions[].input.usage.outputTokensPerTurn` | number | yes | ≥ 0 |   |
| `decisions[].input.rails` | object |   |   |   |
| `decisions[].input.rails.minTokens` | number |   | ≥ 0 |   |
| `decisions[].input.rails.maxShareOfWindow` | number |   |   |   |
| `decisions[].input.params` | object |   |   |   |
| `decisions[].input.params.maxHorizonTurns` | number |   |   |   |
| `decisions[].input.params.fallbackIdleSeconds` | number |   |   |   |
| `decisions[].input.params.alarmMarginMinSeconds` | number |   |   |   |
| `decisions[].input.params.alarmMarginShare` | number |   |   |   |
| `decisions[].input.params.fallbackWarmSeconds` | number |   |   |   |
| `decisions[].result` | object | yes |   |   |
| `decisions[].result.decision` | `"compact"`, `"continue"` | yes |   |   |
| `decisions[].result.rule` | `"ceiling"`, `"floor"`, `"cost"`, `"fallback"`, `"unknown-prices"` | yes |   |   |
| `decisions[].result.costContinue` | number or null | yes |   |   |
| `decisions[].result.costCompact` | number or null | yes |   |   |
| `decisions[].result.horizonTurns` | number | yes | &gt; 0 |   |
| `decisions[].result.nextAlarmAt` | number or null | yes |   |   |
| `decisions[].actual` | object or null | yes |   |   |
| `decisions[].actual.turns` | integer | yes | &gt; 0, ≤ 9007199254740991 |   |
| `decisions[].actual.cost` | number | yes | ≥ 0 |   |
| `actuals` | array of object | yes | at most 32 |   |
| `actuals[].id` | string | yes | min length 1 |   |
| `actuals[].turns` | integer | yes | &gt; 0, ≤ 9007199254740991 |   |
| `actuals[].cost` | number | yes | ≥ 0 |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `estimate` | object | yes |   |   |
| `estimate.provider` | string | yes |   |   |
| `estimate.model` | string | yes |   |   |
| `estimate.seconds` | number or null | yes |   |   |
| `estimate.source` | `"published"`, `"learned"`, `"fallback"` | yes |   |   |
| `estimate.confidence` | number or null | yes |   |   |

## ai.setProviderKey

Store a provider's API key (admins): in AI Gateway (BYOK, the default when the deployment has a gateway) or as a Workers secret on cos-app and cos-runner, through the Cloudflare API. A custom provider's key is BYOK only, under `custom-<slug>`. The key goes straight to Cloudflare: it is never written to the database, the audit log or any response.

|  |  |
| --- | --- |
| Permission | `settings:manage` |
| Risk | `write` |
| Audiences | `staff` |
| Actors | `human` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `provider` | `"openai"`, `"google"`, `"openrouter"`, `"deepseek"`, `"anthropic"`, `"openai-compatible"`, `"custom"`, `"assemblyai"` | yes |   |   |
| `apiKey` | string | yes | min length 8, max length 4096 |   |
| `mode` | `"secret"`, `"byok"` |   |   |   |
| `customProvider` | string |   | pattern `^(custom-)?[a-z0-9][a-z0-9-]{0,62}$` |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `provider` | string | yes |   |   |
| `stored` | `"secret"`, `"byok"` | yes |   |   |
| `targets` | array of string | yes |   |   |

## ai.settings

Settings → AI (admins): every model role with its provider, model, fallback, params, capabilities and where the setting comes from (shipped default, deploy config or admin override), which providers are ready (a key as a Workers secret or AI Gateway BYOK, never the key itself), and the semantic search index. Read-only.

|  |  |
| --- | --- |
| Permission | `settings:manage` |
| Risk | `read` |
| Audiences | `staff` |
| Actors | `human` |

### Input

No fields.

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `configured` | boolean | yes |   |   |
| `roles` | array of object | yes |   |   |
| `roles[].role` | `"build"`, `"assistant.core"`, `"assistant.subagent"`, `"summarise"`, `"extract"`, `"classify"`, `"embed"`, `"vision"`, `"review"`, `"dictation.cleanup"`, `"transcribe"`, `"speak"` | yes |   |   |
| `roles[].kind` | `"text"`, `"embedding"`, `"speech"` | yes |   |   |
| `roles[].provider` | `"workers-ai"`, `"platform"`, `"openai"`, `"google"`, `"openrouter"`, `"deepseek"`, `"anthropic"`, `"openai-compatible"`, `"custom"`, `"assemblyai"` | yes |   |   |
| `roles[].model` | string | yes |   |   |
| `roles[].label` | string | yes |   |   |
| `roles[].capabilities` | object | yes |   |   |
| `roles[].capabilities.chat` | boolean | yes |   |   |
| `roles[].capabilities.toolUse` | boolean | yes |   |   |
| `roles[].capabilities.jsonSchema` | boolean | yes |   |   |
| `roles[].capabilities.jsonObject` | boolean |   |   |   |
| `roles[].capabilities.vision` | boolean | yes |   |   |
| `roles[].capabilities.embedding` | boolean | yes |   |   |
| `roles[].capabilities.contextTokens` | integer | yes | ≥ 0, ≤ 10000000 |   |
| `roles[].capabilities.dimensions` | integer |   | ≥ 1, ≤ 4096 |   |
| `roles[].capabilities.maxBatch` | integer |   | ≥ 1, ≤ 4096 |   |
| `roles[].capabilities.streamingAudioIn` | boolean |   |   |   |
| `roles[].capabilities.voicesOut` | boolean |   |   |   |
| `roles[].capabilities.supportsSpeed` | boolean |   |   |   |
| `roles[].params` | object | yes |   |   |
| `roles[].params.maxTokens` | number | yes |   |   |
| `roles[].params.temperature` | number | yes |   |   |
| `roles[].params.thinking` | boolean or `"low"`, `"medium"`, `"high"` |   |   |   |
| `roles[].fallback` | object or null | yes |   |   |
| `roles[].fallback.provider` | `"workers-ai"`, `"platform"`, `"openai"`, `"google"`, `"openrouter"`, `"deepseek"`, `"anthropic"`, `"openai-compatible"`, `"custom"`, `"assemblyai"` | yes |   |   |
| `roles[].fallback.model` | string | yes |   |   |
| `roles[].pricing` | object or null | yes |   |   |
| `roles[].pricing.input` | number | yes |   |   |
| `roles[].pricing.cacheWrite` | number | yes |   |   |
| `roles[].pricing.cachedInput` | number | yes |   |   |
| `roles[].pricing.output` | number | yes |   |   |
| `roles[].pricing.cacheKnown` | boolean | yes |   |   |
| `roles[].pricing.cacheLifetimeSeconds` | number or null | yes |   |   |
| `roles[].source` | `"shipped"`, `"deploy"`, `"admin"` | yes |   |   |
| `roles[].ignored` | array of object | yes |   |   |
| `roles[].ignored[].layer` | string | yes |   |   |
| `roles[].ignored[].problems` | array of string | yes |   |   |
| `roles[].requirements` | object | yes |   |   |
| `roles[].requirements.description` | string | yes |   |   |
| `roles[].requirements.toolUse` | boolean | yes |   |   |
| `roles[].requirements.json` | boolean | yes |   |   |
| `roles[].requirements.jsonSchema` | boolean | yes |   |   |
| `roles[].requirements.vision` | boolean | yes |   |   |
| `roles[].requirements.embedding` | boolean | yes |   |   |
| `roles[].requirements.streamingAudioIn` | boolean | yes |   |   |
| `roles[].requirements.voicesOut` | boolean | yes |   |   |
| `roles[].requirements.minContextTokens` | number | yes |   |   |
| `roles[].ready` | boolean | yes |   |   |
| `roles[].notReadyReason` | string or null | yes |   |   |
| `roles[].warnings` | array of string | yes |   |   |
| `providers` | array of object | yes |   |   |
| `providers[].id` | `"workers-ai"`, `"platform"`, `"openai"`, `"google"`, `"openrouter"`, `"deepseek"`, `"anthropic"`, `"openai-compatible"`, `"custom"`, `"assemblyai"` | yes |   |   |
| `providers[].label` | string | yes |   |   |
| `providers[].needsKey` | boolean | yes |   |   |
| `providers[].ready` | boolean | yes |   |   |
| `providers[].keySource` | `"secret"`, `"byok"`, `"binding"`, `"platform"` or null | yes |   |   |
| `providers[].reason` | string or null | yes |   |   |
| `providers[].secretName` | string or null | yes |   |   |
| `providers[].byokPossible` | boolean | yes |   |   |
| `catalogue` | array of object | yes |   |   |
| `catalogue[].provider` | `"workers-ai"`, `"platform"`, `"openai"`, `"google"`, `"openrouter"`, `"deepseek"`, `"anthropic"`, `"openai-compatible"`, `"custom"`, `"assemblyai"` | yes |   |   |
| `catalogue[].model` | string | yes |   |   |
| `catalogue[].label` | string | yes |   |   |
| `catalogue[].capabilities` | object | yes |   |   |
| `catalogue[].capabilities.chat` | boolean | yes |   |   |
| `catalogue[].capabilities.toolUse` | boolean | yes |   |   |
| `catalogue[].capabilities.jsonSchema` | boolean | yes |   |   |
| `catalogue[].capabilities.jsonObject` | boolean |   |   |   |
| `catalogue[].capabilities.vision` | boolean | yes |   |   |
| `catalogue[].capabilities.embedding` | boolean | yes |   |   |
| `catalogue[].capabilities.contextTokens` | integer | yes | ≥ 0, ≤ 10000000 |   |
| `catalogue[].capabilities.dimensions` | integer |   | ≥ 1, ≤ 4096 |   |
| `catalogue[].capabilities.maxBatch` | integer |   | ≥ 1, ≤ 4096 |   |
| `catalogue[].capabilities.streamingAudioIn` | boolean |   |   |   |
| `catalogue[].capabilities.voicesOut` | boolean |   |   |   |
| `catalogue[].capabilities.supportsSpeed` | boolean |   |   |   |
| `catalogue[].note` | string or null | yes |   |   |
| `admin` | object | yes |   |   |
| `admin.api` | boolean | yes |   |   |
| `admin.gateway` | string or null | yes |   |   |
| `admin.keyModes` | array of `"secret"`, `"byok"` | yes |   |   |
| `admin.scripts` | array of string | yes |   |   |
| `admin.missing` | array of string | yes |   |   |
| `admin.hosted` | boolean |   |   |   |
| `admin.customerGateway` | object or null |   |   |   |
| `admin.customerGateway.accountId` | string | yes |   |   |
| `admin.customerGateway.gatewayId` | string | yes |   |   |
| `admin.customerGateway.authenticated` | boolean | yes |   |   |
| `semanticSearch` | object | yes |   |   |
| `semanticSearch.configured` | boolean | yes |   |   |
| `semanticSearch.dimensions` | number or null | yes |   |   |
| `semanticSearch.embedded` | number | yes |   |   |
| `semanticSearch.queued` | number | yes |   |   |

## ai.testRole

Settings → AI's Test button (admins): send one tiny request to a role's model (or to the given provider and model, before saving it) and report whether it answered, how long it took and which model replied. Uses a few tokens; read-only otherwise.

|  |  |
| --- | --- |
| Permission | `settings:manage` |
| Risk | `read` |
| Audiences | `staff` |
| Actors | `human` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `role` | `"build"`, `"assistant.core"`, `"assistant.subagent"`, `"summarise"`, `"extract"`, `"classify"`, `"embed"`, `"vision"`, `"review"`, `"dictation.cleanup"`, `"transcribe"`, `"speak"` | yes |   |   |
| `target` | object |   |   |   |
| `target.provider` | `"workers-ai"`, `"platform"`, `"openai"`, `"google"`, `"openrouter"`, `"deepseek"`, `"anthropic"`, `"openai-compatible"`, `"custom"`, `"assemblyai"` | yes |   |   |
| `target.model` | string | yes | min length 1, max length 200 |   |
| `target.capabilities` | object |   |   |   |
| `target.capabilities.chat` | boolean | yes |   |   |
| `target.capabilities.toolUse` | boolean | yes |   |   |
| `target.capabilities.jsonSchema` | boolean | yes |   |   |
| `target.capabilities.jsonObject` | boolean |   |   |   |
| `target.capabilities.vision` | boolean | yes |   |   |
| `target.capabilities.embedding` | boolean | yes |   |   |
| `target.capabilities.contextTokens` | integer | yes | ≥ 0, ≤ 10000000 |   |
| `target.capabilities.dimensions` | integer |   | ≥ 1, ≤ 4096 |   |
| `target.capabilities.maxBatch` | integer |   | ≥ 1, ≤ 4096 |   |
| `target.capabilities.streamingAudioIn` | boolean |   |   |   |
| `target.capabilities.voicesOut` | boolean |   |   |   |
| `target.capabilities.supportsSpeed` | boolean |   |   |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `ok` | boolean | yes |   |   |
| `model` | string or null | yes |   |   |
| `provider` | string or null | yes |   |   |
| `reply` | string or null | yes |   |   |
| `ms` | number | yes |   |   |
| `error` | string or null | yes |   |   |

## ai.updateCacheRails

Set the compaction rails (admins): never compact a chat smaller than this many tokens, always compact before it reaches this share of the model's window, and how many idle minutes to wait while no cache lifetime is known. Between the rails, cost decides.

|  |  |
| --- | --- |
| Permission | `settings:manage` |
| Risk | `write` |
| Audiences | `staff` |
| Actors | `human` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `minTokens` | integer | yes | ≥ 1000, ≤ 2000000 |   |
| `maxShareOfWindow` | number | yes | ≥ 0.1, ≤ 1 |   |
| `fallbackIdleMinutes` | integer | yes | ≥ 1, ≤ 1440 |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `minTokens` | integer | yes | ≥ 1000, ≤ 2000000 |   |
| `maxShareOfWindow` | number | yes | ≥ 0.1, ≤ 1 |   |
| `fallbackIdleMinutes` | integer | yes | ≥ 1, ≤ 1440 |   |

## ai.updateRole

Choose the provider, model, fallback and settings (max output tokens, temperature, thinking off, on or a level) for one model role (admins), or reset it to the deploy/shipped default. The model and the fallback must have every capability the role needs (tool use, JSON schema, context size, vision, embeddings): an unsuitable model is rejected. Keys are not set here (ai.setProviderKey).

|  |  |
| --- | --- |
| Permission | `settings:manage` |
| Risk | `write` |
| Audiences | `staff` |
| Actors | `human` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `role` | `"build"`, `"assistant.core"`, `"assistant.subagent"`, `"summarise"`, `"extract"`, `"classify"`, `"embed"`, `"vision"`, `"review"`, `"dictation.cleanup"`, `"transcribe"`, `"speak"` | yes |   |   |
| `reset` | boolean |   | default `false` |   |
| `provider` | `"workers-ai"`, `"platform"`, `"openai"`, `"google"`, `"openrouter"`, `"deepseek"`, `"anthropic"`, `"openai-compatible"`, `"custom"`, `"assemblyai"` |   |   |   |
| `model` | string |   | min length 1, max length 200 |   |
| `capabilities` | object |   |   |   |
| `capabilities.chat` | boolean | yes |   |   |
| `capabilities.toolUse` | boolean | yes |   |   |
| `capabilities.jsonSchema` | boolean | yes |   |   |
| `capabilities.jsonObject` | boolean |   |   |   |
| `capabilities.vision` | boolean | yes |   |   |
| `capabilities.embedding` | boolean | yes |   |   |
| `capabilities.contextTokens` | integer | yes | ≥ 0, ≤ 10000000 |   |
| `capabilities.dimensions` | integer |   | ≥ 1, ≤ 4096 |   |
| `capabilities.maxBatch` | integer |   | ≥ 1, ≤ 4096 |   |
| `capabilities.streamingAudioIn` | boolean |   |   |   |
| `capabilities.voicesOut` | boolean |   |   |   |
| `capabilities.supportsSpeed` | boolean |   |   |   |
| `params` | object |   |   |   |
| `params.maxTokens` | integer |   | ≥ 16, ≤ 32000 |   |
| `params.temperature` | number |   | ≥ 0, ≤ 2 |   |
| `params.thinking` | boolean or `"low"`, `"medium"`, `"high"` |   |   |   |
| `fallback` | object or null |   |   |   |
| `fallback.provider` | `"workers-ai"`, `"platform"`, `"openai"`, `"google"`, `"openrouter"`, `"deepseek"`, `"anthropic"`, `"openai-compatible"`, `"custom"`, `"assemblyai"` | yes |   |   |
| `fallback.model` | string | yes | min length 1, max length 200 |   |
| `fallback.capabilities` | object |   |   |   |
| `fallback.capabilities.chat` | boolean | yes |   |   |
| `fallback.capabilities.toolUse` | boolean | yes |   |   |
| `fallback.capabilities.jsonSchema` | boolean | yes |   |   |
| `fallback.capabilities.jsonObject` | boolean |   |   |   |
| `fallback.capabilities.vision` | boolean | yes |   |   |
| `fallback.capabilities.embedding` | boolean | yes |   |   |
| `fallback.capabilities.contextTokens` | integer | yes | ≥ 0, ≤ 10000000 |   |
| `fallback.capabilities.dimensions` | integer |   | ≥ 1, ≤ 4096 |   |
| `fallback.capabilities.maxBatch` | integer |   | ≥ 1, ≤ 4096 |   |
| `fallback.capabilities.streamingAudioIn` | boolean |   |   |   |
| `fallback.capabilities.voicesOut` | boolean |   |   |   |
| `fallback.capabilities.supportsSpeed` | boolean |   |   |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `role` | `"build"`, `"assistant.core"`, `"assistant.subagent"`, `"summarise"`, `"extract"`, `"classify"`, `"embed"`, `"vision"`, `"review"`, `"dictation.cleanup"`, `"transcribe"`, `"speak"` | yes |   |   |
| `provider` | string | yes |   |   |
| `model` | string | yes |   |   |
| `source` | string | yes |   |   |

## ai.usage

Usage and spend per model role over the last N days (admins), from AI Gateway's logs: requests, tokens, cost in USD, cache hits and errors. Cached for 10 minutes. Says why when AI Gateway or the Cloudflare API is not configured. Read-only.

|  |  |
| --- | --- |
| Permission | `settings:manage` |
| Risk | `read` |
| Audiences | `staff` |
| Actors | `human` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `days` | integer |   | ≥ 1, ≤ 31, default `7` |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `available` | boolean | yes |   |   |
| `reason` | string or null | yes |   |   |
| `days` | number | yes |   |   |
| `roles` | array of object | yes |   |   |
| `roles[].role` | string | yes |   |   |
| `roles[].requests` | number | yes |   |   |
| `roles[].tokensIn` | number | yes |   |   |
| `roles[].tokensOut` | number | yes |   |   |
| `roles[].cost` | number | yes |   |   |
| `roles[].cached` | number | yes |   |   |
| `roles[].errors` | number | yes |   |   |
| `truncated` | boolean | yes |   |   |
| `sampled` | number | yes |   |   |
| `fetchedAt` | string | yes |   |   |
| `source` | `"gateway"`, `"workspace"` |   |   |   |
| `speech` | array of object |   |   |   |
| `speech[].role` | string | yes |   |   |
| `speech[].provider` | string | yes |   |   |
| `speech[].requests` | number | yes |   |   |
| `speech[].audioSeconds` | number | yes |   |   |
| `speech[].characters` | number | yes |   |   |
| `providers` | array of object |   |   |   |
| `providers[].provider` | string | yes |   |   |
| `providers[].label` | string | yes |   |   |
| `providers[].billed` | boolean | yes |   |   |
| `providers[].requests` | number | yes |   |   |
| `providers[].tokensIn` | number | yes |   |   |
| `providers[].tokensOut` | number | yes |   |   |
