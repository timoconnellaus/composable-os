---
title: "extension.* operations"
description: "The core operations named extension.*"
sidebar:
  label: "extension"
editUrl: false
---

## extension.apply

Install a proposed extension commit: what an approved extension proposal runs. It is always queued for a person to approve (extension.propose queues it); on approval it evaluates and checks the commit again, reconciles the schema and makes the commit live in one transaction. Fails if the installed version changed since it was proposed.

|  |  |
| --- | --- |
| Permission | `extensions:manage` |
| Risk | `extension` |
| Audiences | `staff` |
| Also | always reviewed by a person, whoever calls it (`alwaysReview`); not offered to MCP clients (`mcp.expose: false`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes | pattern `^[a-z][a-z0-9]{1,29}$` | Extension id: 2-30 lowercase letters or digits, starting with a letter, e.g. projects |
| `commit` | string | yes | min length 4, max length 64 |   |
| `version` | string | yes | max length 64 |   |
| `baseCommit` | string or null | yes |   | The installed commit when proposed |
| `eject` | boolean |   | default `false` |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `version` | string | yes |   |   |
| `commit` | string | yes |   |   |
| `source` | `"shipped"`, `"runtime"` | yes |   |   |
| `changed` | boolean | yes |   |   |
| `changes` | array of object | yes |   |   |
| `changes[].kind` | string | yes |   |   |
| `changes[].object` | string | yes |   |   |
| `changes[].field` | string |   |   |   |
| `changes[].from` | string |   |   |   |
| `changes[].detail` | string |   |   |   |

## extension.approve

Approve an extension proposal (or its separate drop-hidden-data item) from the approval queue: installs the proposed commit (schema reconcile, new version live) in the same transaction as the approval and its audit row. The same as approving the action in the Approvals inbox. Admin, human only.

|  |  |
| --- | --- |
| Permission | `extensions:manage` |
| Risk | `extension` |
| Audiences | `staff` |
| Actors | `human` |
| Also | not offered to MCP clients (`mcp.expose: false`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `actionId` | string (starts_with) | yes | max length 64, pattern `^pac_.*` | Pending action id (pac_…) |
| `note` | string |   | max length 1000 |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `actionId` | string | yes |   |   |
| `status` | string | yes |   |   |
| `statusReason` | string or null | yes |   |   |
| `error` | any or null | yes |   |   |

## extension.check

Check extension source without installing it: TypeScript (syntax and types against @composable-os/sdk), allowed imports, the defineExtension contract, formula parsing and types, and a dry-run of the schema reconcile (the DDL it would run and the changes it makes, e.g. lossy type changes are refused). Pass just id to check its working copy (what extension.write wrote), or files (path → source, entry index.ts), or a workspace commit. Returns structured issues with stage, code, path, message and often a suggestion; fix them all and check again until ok is true. Pass request (the user's own words) to also check each automation against what they asked: those findings are warnings (intent/…) that never fail the check. Changes nothing.

|  |  |
| --- | --- |
| Permission | `extensions:manage` |
| Risk | `read` |
| Audiences | `staff` |

### Input

No fields.

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `ok` | boolean | yes |   |   |
| `issues` | array of object | yes |   |   |
| `issues[].stage` | `"typecheck"`, `"contract"`, `"formula"`, `"reconcile"`, `"intent"` | yes |   |   |
| `issues[].severity` | `"error"`, `"warning"`, `"info"` |   |   |   |
| `issues[].code` | string | yes |   |   |
| `issues[].path` | string | yes |   |   |
| `issues[].message` | string | yes |   |   |
| `issues[].suggestion` | string |   |   |   |
| `issues[].span` | object |   |   |   |
| `issues[].span.start` | number | yes |   |   |
| `issues[].span.end` | number | yes |   |   |
| `manifest` | map of any or null | yes |   |   |
| `plan` | object or null | yes |   |   |
| `plan.ddl` | array of string | yes |   |   |
| `plan.changes` | array of object | yes |   |   |
| `plan.changes[].kind` | string | yes |   |   |
| `plan.changes[].object` | string | yes |   |   |
| `plan.changes[].field` | string |   |   |   |
| `plan.changes[].from` | string |   |   |   |
| `plan.changes[].detail` | string |   |   |   |

## extension.disable

Disable an extension: its tools stop running (its objects and data stay readable). Admin, human only.

|  |  |
| --- | --- |
| Permission | `extensions:manage` |
| Risk | `extension` |
| Audiences | `staff` |
| Actors | `human` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes | pattern `^[a-z][a-z0-9]{1,29}$` | Extension id, e.g. example |
| `reason` | string |   | max length 500 |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `label` | string | yes |   |   |
| `description` | string or null | yes |   |   |
| `source` | `"shipped"`, `"runtime"` | yes |   |   |
| `status` | `"active"`, `"disabled"`, `"quarantined"` | yes |   |   |
| `statusReason` | string or null | yes |   |   |
| `version` | string | yes |   |   |
| `commit` | string | yes |   |   |
| `lastGoodCommit` | string or null | yes |   |   |
| `failureCount` | number | yes |   |   |
| `permissions` | object | yes |   |   |
| `permissions.read` | array of string | yes |   |   |
| `permissions.write` | array of string | yes |   |   |
| `permissions.operations` | array of string | yes |   |   |
| `permissions.modules` | array of string | yes |   |   |
| `objects` | array of string | yes |   |   |
| `tools` | array of string | yes |   |   |
| `installedAt` | string | yes |   |   |
| `updatedAt` | string | yes |   |   |

## extension.dropHidden

Permanently drop the data of an extension's removed fields and objects that have been hidden for at least 30 days (see extension.get's hidden list). Optionally only some (`object.field` or object names). Destructive and irreversible. Admin, human only.

|  |  |
| --- | --- |
| Permission | `extensions:manage` |
| Risk | `destructive` |
| Audiences | `staff` |
| Actors | `human`, `mcp`, `assistant` |
| Also | always reviewed when called by `mcp`, `assistant` (`alwaysReview`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes | pattern `^[a-z][a-z0-9]{1,29}$` | Extension id, e.g. example |
| `only` | array of string |   | at most 100 |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `changes` | array of object | yes |   |   |
| `changes[].kind` | string | yes |   |   |
| `changes[].object` | string | yes |   |   |
| `changes[].field` | string |   |   |   |
| `changes[].from` | string |   |   |   |
| `changes[].detail` | string |   |   |   |
| `ddl` | array of string | yes |   |   |

## extension.eject

Eject a shipped extension: copy its source into its working copy so it can be edited, after which extension.propose installs it as a runtime extension. WARNING: once that proposal is approved it stops receiving upstream updates with new releases. Prefer extending it from your own extension (fields on its objects, views, tools) when that is enough. Nothing changes in the live CRM until a proposal is approved.

|  |  |
| --- | --- |
| Permission | `extensions:manage` |
| Risk | `write` |
| Audiences | `staff` |
| Also | bookkeeping, never queued for review |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes | pattern `^[a-z][a-z0-9]{1,29}$` | Extension id: 2-30 lowercase letters or digits, starting with a letter, e.g. projects |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `ref` | `"working"` | yes |   |   |
| `head` | string or null | yes |   | The latest commit of the extension, if any |
| `paths` | array of string | yes |   | Every file in the working copy now |
| `written` | array of string | yes |   | Files this call wrote |
| `deleted` | array of string | yes |   | Files this call deleted |
| `changed` | boolean | yes |   | The working copy has edits since its last commit |
| `ejected` | boolean | yes |   |   |
| `warning` | string | yes |   |   |

## extension.enable

Enable a disabled or quarantined extension again and reset its failure counter. Admin, human only.

|  |  |
| --- | --- |
| Permission | `extensions:manage` |
| Risk | `extension` |
| Audiences | `staff` |
| Actors | `human` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes | pattern `^[a-z][a-z0-9]{1,29}$` | Extension id, e.g. example |
| `reason` | string |   | max length 500 |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `label` | string | yes |   |   |
| `description` | string or null | yes |   |   |
| `source` | `"shipped"`, `"runtime"` | yes |   |   |
| `status` | `"active"`, `"disabled"`, `"quarantined"` | yes |   |   |
| `statusReason` | string or null | yes |   |   |
| `version` | string | yes |   |   |
| `commit` | string | yes |   |   |
| `lastGoodCommit` | string or null | yes |   |   |
| `failureCount` | number | yes |   |   |
| `permissions` | object | yes |   |   |
| `permissions.read` | array of string | yes |   |   |
| `permissions.write` | array of string | yes |   |   |
| `permissions.operations` | array of string | yes |   |   |
| `permissions.modules` | array of string | yes |   |   |
| `objects` | array of string | yes |   |   |
| `tools` | array of string | yes |   |   |
| `installedAt` | string | yes |   |   |
| `updatedAt` | string | yes |   |   |

## extension.get

Get one installed extension: its summary, manifest, installed versions (git commits, newest first), recent runs, and hidden fields and objects with the date their data can be dropped. Read-only.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `read` |
| Audiences | `staff` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes | pattern `^[a-z][a-z0-9]{1,29}$` | Extension id, e.g. example |
| `runs` | integer |   | ≥ 0, ≤ 100, default `20` |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `label` | string | yes |   |   |
| `description` | string or null | yes |   |   |
| `source` | `"shipped"`, `"runtime"` | yes |   |   |
| `status` | `"active"`, `"disabled"`, `"quarantined"` | yes |   |   |
| `statusReason` | string or null | yes |   |   |
| `version` | string | yes |   |   |
| `commit` | string | yes |   |   |
| `lastGoodCommit` | string or null | yes |   |   |
| `failureCount` | number | yes |   |   |
| `permissions` | object | yes |   |   |
| `permissions.read` | array of string | yes |   |   |
| `permissions.write` | array of string | yes |   |   |
| `permissions.operations` | array of string | yes |   |   |
| `permissions.modules` | array of string | yes |   |   |
| `objects` | array of string | yes |   |   |
| `tools` | array of string | yes |   |   |
| `installedAt` | string | yes |   |   |
| `updatedAt` | string | yes |   |   |
| `manifest` | map of any | yes |   |   |
| `versions` | array of object | yes |   |   |
| `versions[].commit` | string | yes |   |   |
| `versions[].version` | string | yes |   |   |
| `versions[].installedAt` | string | yes |   |   |
| `runs` | array of object | yes |   |   |
| `runs[].id` | string | yes |   |   |
| `runs[].commit` | string or null | yes |   |   |
| `runs[].kind` | string | yes |   |   |
| `runs[].name` | string or null | yes |   |   |
| `runs[].actor` | string or null | yes |   |   |
| `runs[].userId` | string or null | yes |   |   |
| `runs[].startedAt` | string | yes |   |   |
| `runs[].durationMs` | number | yes |   |   |
| `runs[].outcome` | `"ok"`, `"error"`, `"timeout"` | yes |   |   |
| `runs[].error` | any or null | yes |   |   |
| `runs[].logs` | array of any | yes |   |   |
| `runs[].operations` | array of any | yes |   |   |
| `hidden` | array of object | yes |   |   |
| `hidden[].object` | string | yes |   |   |
| `hidden[].field` | string or null | yes |   |   |
| `hidden[].hiddenAt` | string | yes |   |   |
| `hidden[].droppableAt` | string | yes |   |   |

## extension.install

Install or upgrade an extension, admin and human only: commits the files (or a shipped extension's bundled source) to the extension workspace, checks it, reconciles its schema (x_* tables and rec_* views) and makes the commit the live version, all or nothing. Fails with the check's issues if it does not pass. Installing the current version again changes nothing.

|  |  |
| --- | --- |
| Permission | `extensions:manage` |
| Risk | `extension` |
| Audiences | `staff` |
| Actors | `human` |

### Input

No fields.

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `version` | string | yes |   |   |
| `commit` | string | yes |   |   |
| `source` | `"shipped"`, `"runtime"` | yes |   |   |
| `changed` | boolean | yes |   |   |
| `changes` | array of object | yes |   |   |
| `changes[].kind` | string | yes |   |   |
| `changes[].object` | string | yes |   |   |
| `changes[].field` | string |   |   |   |
| `changes[].from` | string |   |   |   |
| `changes[].detail` | string |   |   |   |

## extension.list

List installed extensions (shipped and runtime) with version, status (active, disabled or quarantined), declared permissions, objects and tools, plus `workspace`: every extension directory in the extension workspace with whether it has uncommitted edits or is installed (extension.read lists its files), `shipped`: the shipped extension ids (extend them, don't modify them), and `available`: shipped extensions that are opt-in and not installed yet (an admin installs one with extension.install { id, shipped: true }). Read-only.

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
| `items` | array of object | yes |   |   |
| `items[].id` | string | yes |   |   |
| `items[].label` | string | yes |   |   |
| `items[].description` | string or null | yes |   |   |
| `items[].source` | `"shipped"`, `"runtime"` | yes |   |   |
| `items[].status` | `"active"`, `"disabled"`, `"quarantined"` | yes |   |   |
| `items[].statusReason` | string or null | yes |   |   |
| `items[].version` | string | yes |   |   |
| `items[].commit` | string | yes |   |   |
| `items[].lastGoodCommit` | string or null | yes |   |   |
| `items[].failureCount` | number | yes |   |   |
| `items[].permissions` | object | yes |   |   |
| `items[].permissions.read` | array of string | yes |   |   |
| `items[].permissions.write` | array of string | yes |   |   |
| `items[].permissions.operations` | array of string | yes |   |   |
| `items[].permissions.modules` | array of string | yes |   |   |
| `items[].objects` | array of string | yes |   |   |
| `items[].tools` | array of string | yes |   |   |
| `items[].installedAt` | string | yes |   |   |
| `items[].updatedAt` | string | yes |   |   |
| `workspace` | array of object | yes |   |   |
| `workspace[].id` | string | yes |   |   |
| `workspace[].changed` | boolean | yes |   | Edited since its last commit |
| `workspace[].installed` | boolean | yes |   |   |
| `workspace[].ejected` | boolean | yes |   |   |
| `shipped` | array of string | yes |   |   |
| `available` | array of object | yes |   |   |
| `available[].id` | string | yes |   |   |
| `available[].version` | string | yes |   |   |
| `available[].label` | string or null | yes |   |   |
| `available[].description` | string or null | yes |   |   |

## extension.proposal

The review detail of an extension proposal (a pending action of extension.apply): the per-file diff from the installed version, the host-computed impact, the check result and the AI-written summary (null when no AI is configured). Read-only.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `read` |
| Audiences | `staff` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `actionId` | string (starts_with) | yes | max length 64, pattern `^pac_.*` | Pending action id (pac_…) |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `actionId` | string | yes |   |   |
| `extensionId` | string | yes |   |   |
| `commit` | string | yes |   |   |
| `baseCommit` | string or null | yes |   |   |
| `version` | string | yes |   |   |
| `message` | string | yes |   |   |
| `status` | string | yes |   |   |
| `diff` | array of any | yes |   |   |
| `impact` | map of any | yes |   |   |
| `check` | map of any | yes |   |   |
| `aiSummary` | object or null | yes |   |   |
| `aiSummary.text` | string | yes |   |   |
| `aiSummary.model` | string or null | yes |   |   |
| `intentCheck` | object or null | yes |   |   |
| `intentCheck.status` | `"checked"`, `"unchecked"` | yes |   |   |
| `intentCheck.requestSource` | `"person"`, `"client"` | yes |   |   |
| `intentCheck.request` | string | yes |   |   |
| `intentCheck.reason` | string |   |   |   |
| `intentCheck.automations` | array of object | yes |   |   |
| `intentCheck.automations[].id` | string | yes |   |   |
| `intentCheck.automations[].findings` | array of object | yes |   |   |
| `intentCheck.automations[].findings[].question` | string | yes |   |   |
| `intentCheck.automations[].findings[].code` | string | yes |   |   |
| `intentCheck.automations[].findings[].message` | string | yes |   |   |
| `intentCheck.automations[].faults` | map of number or null | yes |   |   |
| `intentCheck.model` | string |   |   |   |
| `intentCheck.checkedAt` | string | yes |   |   |
| `createdBy` | string | yes |   |   |
| `createdAt` | string | yes |   |   |

## extension.propose

Send an extension's working copy for approval: commits it (a new version in the extension workspace), runs extension.check, and queues ONE pending action in your change set holding the diff from the installed version and the host-computed impact (schema changes, permissions requested or widened, host modules, tools, triggers). Nothing is installed until a person approves it in the Approvals inbox. If the check fails it returns status 'check_failed' with the issues and queues nothing: fix them with extension.write and propose again. Bump `version` in defineExtension for each change. impact.triggers holds each automation's host-written summary, the text the approver reads: check it states everything the user asked for and nothing they did not. Pass request (the user's own words) and each automation is also checked against it; findings come back as warning issues (intent/…) and are shown to the approver. dropHidden: true also queues a separate destructive item to drop data of fields removed more than 30 days ago.

|  |  |
| --- | --- |
| Permission | `extensions:manage` |
| Risk | `extension` |
| Audiences | `staff` |
| Also | bookkeeping, never queued for review |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes | pattern `^[a-z][a-z0-9]{1,29}$` | Extension id: 2-30 lowercase letters or digits, starting with a letter, e.g. projects |
| `message` | string |   | min length 1, max length 500 | Commit message |
| `dropHidden` | boolean |   | default `false` |   |
| `request` | string |   | min length 1, max length 4000 | What the user asked for, in their own words (quote them; do not summarise). When given, each automation is checked against it, and anything it adds, leaves out or sends to someone else comes back as a warning issue (code intent/…). Warnings never fail the check. |

### Output

No fields.

## extension.read

Read an extension's source files: the working copy (your uncommitted edits, the default) or the files at a commit (from extension.get's versions). Use it before editing an existing extension, including the shipped ones (e.g. id 'example') to see how they are written. Pass path to read one file. Read-only.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `read` |
| Audiences | `staff` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes | pattern `^[a-z][a-z0-9]{1,29}$` | Extension id: 2-30 lowercase letters or digits, starting with a letter, e.g. projects |
| `commit` | string |   | min length 4, max length 64 | A commit; omit for the working copy |
| `path` | string |   | min length 1, max length 200, pattern `^[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)*$` | Only this file |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `ref` | string | yes |   | "working" for the working copy, else the commit read |
| `head` | string or null | yes |   | The latest commit of the extension, if any |
| `files` | map of string | yes |   |   |
| `changed` | array of string | yes |   | Working-copy paths that differ from head (only when reading the whole working copy) |
| `ejected` | boolean | yes |   |   |

## extension.reject

Reject an extension proposal: nothing is installed (the commit stays in the workspace's history). The same as rejecting it in the Approvals inbox. Admin, human only.

|  |  |
| --- | --- |
| Permission | `extensions:manage` |
| Risk | `extension` |
| Audiences | `staff` |
| Actors | `human` |
| Also | not offered to MCP clients (`mcp.expose: false`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `actionId` | string (starts_with) | yes | max length 64, pattern `^pac_.*` | Pending action id (pac_…) |
| `note` | string |   | max length 1000 |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `actionId` | string | yes |   |   |
| `status` | string | yes |   |   |
| `statusReason` | string or null | yes |   |   |
| `error` | any or null | yes |   |   |

## extension.rollback

Roll an extension back to a previously installed version (a commit from extension.get's versions, e.g. the last-known-good one after a quarantine). Fields the later version added are hidden with their data kept; the extension becomes active again. Admin, human only.

|  |  |
| --- | --- |
| Permission | `extensions:manage` |
| Risk | `extension` |
| Audiences | `staff` |
| Actors | `human` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes | pattern `^[a-z][a-z0-9]{1,29}$` | Extension id, e.g. example |
| `commit` | string | yes | min length 4, max length 64 |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `version` | string | yes |   |   |
| `commit` | string | yes |   |   |
| `source` | `"shipped"`, `"runtime"` | yes |   |   |
| `changed` | boolean | yes |   |   |
| `changes` | array of object | yes |   |   |
| `changes[].kind` | string | yes |   |   |
| `changes[].object` | string | yes |   |   |
| `changes[].field` | string |   |   |   |
| `changes[].from` | string |   |   |   |
| `changes[].detail` | string |   |   |   |

## extension.write

Write files into an extension's working copy in the extension workspace (creating the extension if it is new). Nothing is installed or committed: run extension.check to see issues, then extension.propose to send it for approval. files maps paths relative to the extension root to their full new contents (index.ts is the entry, whose default export is defineExtension({...}) from @composable-os/sdk); null deletes a file. replace: true deletes every other file. Shipped extensions cannot be written unless ejected. Returns the working copy's paths (use extension.read for contents).

|  |  |
| --- | --- |
| Permission | `extensions:manage` |
| Risk | `write` |
| Audiences | `staff` |
| Also | bookkeeping, never queued for review |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes | pattern `^[a-z][a-z0-9]{1,29}$` | Extension id: 2-30 lowercase letters or digits, starting with a letter, e.g. projects |
| `files` | map of string or null | yes |   | Path → full file contents, or null to delete |
| `replace` | boolean |   | default `false` | Delete files not listed (default false) |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `ref` | `"working"` | yes |   |   |
| `head` | string or null | yes |   | The latest commit of the extension, if any |
| `paths` | array of string | yes |   | Every file in the working copy now |
| `written` | array of string | yes |   | Files this call wrote |
| `deleted` | array of string | yes |   | Files this call deleted |
| `changed` | boolean | yes |   | The working copy has edits since its last commit |
| `ejected` | boolean | yes |   |   |
