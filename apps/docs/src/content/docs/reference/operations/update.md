---
title: "update.* operations"
description: "The core operations named update.*"
sidebar:
  label: "update"
editUrl: false
---

## update.apply

Update this deployment to a release: pause automations, take a D1 Time Travel bookmark, run core migrations, switch all Workers together, smoke-check, resume. A failure rolls back to the installed release and restores the bookmark. Refused when preflight finds a blocker. Human admins only, never from AI or MCP; audited.

|  |  |
| --- | --- |
| Permission | `settings:manage` |
| Risk | `destructive` |
| Audiences | `staff` |
| Actors | `human` |
| Also | not offered to MCP clients (`mcp.expose: false`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `version` | string | yes |   |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `runId` | string | yes |   |   |
| `status` | `"succeeded"`, `"rolled_back"`, `"failed"` | yes |   |   |
| `from` | string | yes |   |   |
| `to` | string | yes |   |   |
| `migrations` | array of string | yes |   |   |
| `error` | string or null | yes |   |   |

## update.preflight

Check an update before running it: runtime extensions against the new extension contract, pending core migrations, gatekeeper changes and new secrets or inputs. `ok` false means Update is refused; `blockers` say why and what to do. Admins only. Read-only.

|  |  |
| --- | --- |
| Permission | `settings:manage` |
| Risk | `read` |
| Audiences | `staff` |
| Also | not offered to MCP clients (`mcp.expose: false`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `version` | string | yes |   |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `ok` | boolean | yes |   |   |
| `from` | string or null | yes |   |   |
| `to` | string | yes |   |   |
| `blockers` | array of object | yes |   |   |
| `blockers[].code` | string | yes |   |   |
| `blockers[].message` | string | yes |   |   |
| `warnings` | array of object | yes |   |   |
| `warnings[].code` | string | yes |   |   |
| `warnings[].message` | string | yes |   |   |
| `migrations` | array of string | yes |   |   |
| `extensions` | array of object | yes |   |   |
| `extensions[].id` | string | yes |   |   |
| `extensions[].contractVersion` | number | yes |   |   |
| `extensions[].compatible` | boolean | yes |   |   |
| `extensions[].status` | string | yes |   |   |
| `gatekeepers` | object | yes |   |   |
| `gatekeepers.added` | array of string | yes |   |   |
| `gatekeepers.removed` | array of string | yes |   |   |
| `gatekeepers.changed` | array of string | yes |   |   |
| `secrets` | array of object | yes |   |   |
| `secrets[].worker` | string | yes |   |   |
| `secrets[].name` | string | yes |   |   |
| `secrets[].required` | boolean | yes |   |   |
| `secrets[].set` | boolean or null | yes |   |   |
| `inputs` | array of string | yes |   |   |
| `cliCommand` | string | yes |   |   |

## update.releases

Releases published on the deployment's channel (public GitHub Releases, cached for an hour), newest first, with their changelogs and whether each is newer than what is installed. Admins only.

|  |  |
| --- | --- |
| Permission | `settings:manage` |
| Risk | `read` |
| Audiences | `staff` |
| Also | not offered to MCP clients (`mcp.expose: false`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `refresh` | boolean |   |   | Ask GitHub now, not the cache |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `channel` | `"stable"`, `"beta"` | yes |   |   |
| `fetchedAt` | string or null | yes |   |   |
| `releases` | array of object | yes |   |   |
| `releases[].version` | string | yes |   |   |
| `releases[].channel` | `"stable"`, `"beta"` | yes |   |   |
| `releases[].name` | string | yes |   |   |
| `releases[].notes` | string | yes |   | The changelog: the release's notes, generated from PR titles |
| `releases[].publishedAt` | string or null | yes |   |   |
| `releases[].url` | string | yes |   |   |
| `releases[].newer` | boolean | yes |   |   |
| `error` | string or null | yes |   |   |

## update.rollback

Undo the last update: redeploy the release it replaced and restore the database to the bookmark taken before it (changes since then are lost). Human admins only; audited.

|  |  |
| --- | --- |
| Permission | `settings:manage` |
| Risk | `destructive` |
| Audiences | `staff` |
| Actors | `human` |
| Also | not offered to MCP clients (`mcp.expose: false`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `runId` | string | yes |   |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `version` | string | yes |   |   |

## update.setChannel

Choose the update channel: stable (releases only) or beta (betas too). Human admins only.

|  |  |
| --- | --- |
| Permission | `settings:manage` |
| Risk | `write` |
| Audiences | `staff` |
| Actors | `human` |
| Also | not offered to MCP clients (`mcp.expose: false`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `channel` | `"stable"`, `"beta"` | yes |   |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `channel` | `"stable"`, `"beta"` | yes |   |   |

## update.status

The deployment's installed release, update channel, whether it can update itself (a scoped token is stored) and its update history. Admins only. Read-only.

|  |  |
| --- | --- |
| Permission | `settings:manage` |
| Risk | `read` |
| Audiences | `staff` |
| Also | not offered to MCP clients (`mcp.expose: false`) |

### Input

No fields.

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `currentVersion` | string or null | yes |   | Installed release; null for a source deploy |
| `channel` | `"stable"`, `"beta"` | yes |   |   |
| `repository` | string | yes |   |   |
| `canUpdateInApp` | boolean | yes |   | A scoped update token is stored, so Update works here |
| `installedFromRelease` | boolean | yes |   |   |
| `hostname` | string or null | yes |   |   |
| `cliCommand` | string | yes |   | The command an operator runs to update without a token |
| `running` | object or null | yes |   |   |
| `running.id` | string | yes |   |   |
| `running.kind` | `"update"`, `"rollback"` | yes |   |   |
| `running.fromVersion` | string or null | yes |   |   |
| `running.toVersion` | string | yes |   |   |
| `running.status` | `"running"`, `"succeeded"`, `"rolled_back"`, `"failed"` | yes |   |   |
| `running.step` | string or null | yes |   |   |
| `running.error` | string or null | yes |   |   |
| `running.surface` | `"ui"`, `"cli"` | yes |   |   |
| `running.startedBy` | string or null | yes |   |   |
| `running.startedAt` | string | yes |   |   |
| `running.finishedAt` | string or null | yes |   |   |
| `running.canRollBack` | boolean | yes |   |   |
| `runs` | array of object | yes |   |   |
| `runs[].id` | string | yes |   |   |
| `runs[].kind` | `"update"`, `"rollback"` | yes |   |   |
| `runs[].fromVersion` | string or null | yes |   |   |
| `runs[].toVersion` | string | yes |   |   |
| `runs[].status` | `"running"`, `"succeeded"`, `"rolled_back"`, `"failed"` | yes |   |   |
| `runs[].step` | string or null | yes |   |   |
| `runs[].error` | string or null | yes |   |   |
| `runs[].surface` | `"ui"`, `"cli"` | yes |   |   |
| `runs[].startedBy` | string or null | yes |   |   |
| `runs[].startedAt` | string | yes |   |   |
| `runs[].finishedAt` | string or null | yes |   |   |
| `runs[].canRollBack` | boolean | yes |   |   |
