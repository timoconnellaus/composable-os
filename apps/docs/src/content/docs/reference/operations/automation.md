---
title: "automation.* operations"
description: "The core operations named automation.*"
sidebar:
  label: "automation"
editUrl: false
---

## automation.bindConnection

Bind one connection an automation declares (its `connections[].id`) to a connection: one you own, or an org connection (admins). This is your consent that the automation's steps use it as the connection's owner; it is recorded and can be withdrawn. Binding the last declared connection lets a waiting automation run. People only.

|  |  |
| --- | --- |
| Permission | `records:write` |
| Risk | `write` |
| Audiences | `staff` |
| Actors | `human` |
| Also | not offered to MCP clients (`mcp.expose: false`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes | pattern `^[a-z][a-z0-9]{1,29}\.[a-z][a-zA-Z0-9]{0,39}$` | Automation id: &lt;extension&gt;.&lt;automation&gt;, e.g. deals.wonOnboarding |
| `slot` | string | yes | pattern `^[a-z][a-zA-Z0-9]{0,39}$` | The connection id the automation declares (`connections[].id`) |
| `connectionId` | string | yes | max length 64 |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `pausedReason` | string or null | yes |   |   |
| `connections` | array of object | yes |   |   |
| `connections[].slot` | string | yes |   |   |
| `connections[].gatekeeper` | string | yes |   |   |
| `connections[].purpose` | string | yes |   |   |
| `connections[].binding` | object or null | yes |   |   |
| `connections[].binding.connectionId` | string | yes |   |   |
| `connections[].binding.connectionTitle` | string | yes |   |   |
| `connections[].binding.scope` | `"personal"`, `"org"` | yes |   |   |
| `connections[].binding.status` | string | yes |   |   |
| `connections[].binding.ownerUserId` | string | yes |   |   |
| `connections[].binding.ownerName` | string or null | yes |   |   |
| `connections[].binding.boundBy` | string | yes |   |   |
| `connections[].binding.boundByName` | string or null | yes |   |   |
| `connections[].binding.boundAt` | string | yes |   |   |
| `connections[].revoked` | object or null | yes |   |   |
| `connections[].revoked.connectionTitle` | string or null | yes |   |   |
| `connections[].revoked.revokedAt` | string | yes |   |   |
| `connections[].revoked.revokedByName` | string or null | yes |   |   |
| `connections[].revoked.reason` | string or null | yes |   |   |

## automation.cancel

Cancel a running or waiting automation run. Steps already done stay done.

|  |  |
| --- | --- |
| Permission | `records:write` |
| Risk | `write` |
| Audiences | `staff` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `runId` | string | yes | pattern `^arn_[0-9A-Z]{26}$` |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `runId` | string | yes |   |   |

## automation.disable

Disable an automation (admins): it stops starting runs. Runs already in progress finish. Enable it again with automation.enable.

|  |  |
| --- | --- |
| Permission | `settings:manage` |
| Risk | `write` |
| Audiences | `staff` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes | pattern `^[a-z][a-z0-9]{1,29}\.[a-z][a-zA-Z0-9]{0,39}$` | Automation id: &lt;extension&gt;.&lt;automation&gt;, e.g. deals.wonOnboarding |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `status` | `"active"`, `"disabled"`, `"paused"`, `"killed"`, `"removed"` | yes |   |   |

## automation.enable

Enable an automation (admins). Also clears an auto-pause from a rate limit, so it runs again from the next event. The kill switch, when engaged, still stops everything.

|  |  |
| --- | --- |
| Permission | `settings:manage` |
| Risk | `write` |
| Audiences | `staff` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes | pattern `^[a-z][a-z0-9]{1,29}\.[a-z][a-zA-Z0-9]{0,39}$` | Automation id: &lt;extension&gt;.&lt;automation&gt;, e.g. deals.wonOnboarding |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `status` | `"active"`, `"disabled"`, `"paused"`, `"killed"`, `"removed"` | yes |   |   |

## automation.explain

An optional AI-written explanation of an automation in plain words (labelled as AI-written; the host's own summary from automation.get is the authoritative one). Null when the deployment has no AI. Read-only.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `read` |
| Audiences | `staff` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes | pattern `^[a-z][a-z0-9]{1,29}\.[a-z][a-zA-Z0-9]{0,39}$` | Automation id: &lt;extension&gt;.&lt;automation&gt;, e.g. deals.wonOnboarding |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `text` | string or null | yes |   |   |
| `model` | string or null | yes |   |   |
| `aiWritten` | `true` | yes |   |   |

## automation.get

Get one automation: the host-written plain-English summary and step diagram (generated from its declarations, not by AI), its permissions, safety rails, what happens when a change it queued is rejected, provenance, run count and the latest test-mode report. Read-only.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `read` |
| Audiences | `staff` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes | pattern `^[a-z][a-z0-9]{1,29}\.[a-z][a-zA-Z0-9]{0,39}$` | Automation id: &lt;extension&gt;.&lt;automation&gt;, e.g. deals.wonOnboarding |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `extensionId` | string | yes |   |   |
| `extensionLabel` | string or null | yes |   |   |
| `key` | string | yes |   |   |
| `label` | string | yes |   |   |
| `description` | string | yes |   |   |
| `triggerType` | string | yes |   |   |
| `triggerObject` | string or null | yes |   |   |
| `triggerText` | string | yes |   |   |
| `status` | `"active"`, `"disabled"`, `"paused"`, `"killed"`, `"removed"` | yes |   |   |
| `pausedReason` | string or null | yes |   |   |
| `lastRunAt` | string or null | yes |   |   |
| `lastRunStatus` | `"queued"`, `"running"`, `"waiting"`, `"review"`, `"completed"`, `"failed"`, `"cancelled"`, `"expired"`, `"skipped"` or null | yes |   |   |
| `runs7d` | number | yes |   |   |
| `errors7d` | number | yes |   |   |
| `manual` | object or null | yes |   |   |
| `manual.label` | string | yes |   |   |
| `manual.object` | string | yes |   |   |
| `manual.bulk` | boolean | yes |   |   |
| `version` | string or null | yes |   |   |
| `commit` | string or null | yes |   |   |
| `provenance` | object | yes |   |   |
| `provenance.author` | string or null | yes |   |   |
| `provenance.approvedBy` | string or null | yes |   |   |
| `provenance.approvedAt` | string or null | yes |   |   |
| `provenance.shipped` | boolean | yes |   |   |
| `spec` | any | yes |   |   |
| `summary` | object | yes |   |   |
| `summary.segments` | array of object | yes |   |   |
| `summary.segments[].text` | string | yes |   |   |
| `summary.segments[].strong` | boolean | yes | default `false` |   |
| `summary.text` | string | yes |   |   |
| `diagram` | array of object | yes |   |   |
| `diagram[].kind` | `"trigger"`, `"condition"`, `"do"`, `"notify"`, `"sleep"`, `"waitForEvent"` | yes |   |   |
| `diagram[].heading` | string | yes |   |   |
| `diagram[].text` | string | yes |   |   |
| `diagram[].code` | array of string | yes | default `[]` |   |
| `diagram[].detail` | string or null | yes | default `null` |   |
| `diagram[].risk` | string or null | yes | default `null` |   |
| `diagram[].stepName` | string or null | yes | default `null` |   |
| `permissions` | object | yes |   |   |
| `permissions.read` | array of string | yes |   |   |
| `permissions.write` | array of string | yes |   |   |
| `permissions.notify` | boolean | yes |   |   |
| `permissions.operations` | array of string | yes |   |   |
| `permissions.principal` | string | yes |   |   |
| `rails` | object | yes |   |   |
| `rails.maxRunsPerMinute` | number | yes |   |   |
| `rails.maxWritesPerHour` | number | yes |   |   |
| `rails.debounceSeconds` | number | yes |   |   |
| `rails.cascadeDepth` | number | yes |   |   |
| `rails.selfRetrigger` | `false` | yes |   |   |
| `onRejected` | string | yes |   |   |
| `runCount` | number | yes |   |   |
| `lastTest` | any or null | yes |   |   |
| `killSwitch` | boolean | yes |   |   |
| `connections` | array of any | yes | default `[]` |   |

## automation.killSwitch

Engage or release the automation kill switch (human admins only). Engaged, no automation starts a run, and running runs stop before their next step.

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
| `engaged` | boolean | yes |   |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `engaged` | boolean | yes |   |   |

## automation.list

List the automations installed extensions declare, with their status (active, disabled, paused by a rail, stopped by the kill switch, removed), trigger in plain English, last run and 7-day run and error counts. `manualFor` lists the manual automations of one object (the buttons on its record pages and bulk actions on its lists). Read-only.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `read` |
| Audiences | `staff` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `extensionId` | string |   |   |   |
| `manualFor` | string |   |   |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `items` | array of object | yes |   |   |
| `items[].id` | string | yes |   |   |
| `items[].extensionId` | string | yes |   |   |
| `items[].extensionLabel` | string or null | yes |   |   |
| `items[].key` | string | yes |   |   |
| `items[].label` | string | yes |   |   |
| `items[].description` | string | yes |   |   |
| `items[].triggerType` | string | yes |   |   |
| `items[].triggerObject` | string or null | yes |   |   |
| `items[].triggerText` | string | yes |   |   |
| `items[].status` | `"active"`, `"disabled"`, `"paused"`, `"killed"`, `"removed"` | yes |   |   |
| `items[].pausedReason` | string or null | yes |   |   |
| `items[].lastRunAt` | string or null | yes |   |   |
| `items[].lastRunStatus` | `"queued"`, `"running"`, `"waiting"`, `"review"`, `"completed"`, `"failed"`, `"cancelled"`, `"expired"`, `"skipped"` or null | yes |   |   |
| `items[].runs7d` | number | yes |   |   |
| `items[].errors7d` | number | yes |   |   |
| `items[].manual` | object or null | yes |   |   |
| `items[].manual.label` | string | yes |   |   |
| `items[].manual.object` | string | yes |   |   |
| `items[].manual.bulk` | boolean | yes |   |   |
| `killSwitch` | boolean | yes |   |   |

## automation.replay

Replay an automation run from the start against current data, with the same trigger. Its steps run again (and write again). Returns the new run's id.

|  |  |
| --- | --- |
| Permission | `records:write` |
| Risk | `write` |
| Audiences | `staff` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `runId` | string | yes | pattern `^arn_[0-9A-Z]{26}$` |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `runId` | string | yes |   |   |
| `deferred` | boolean |   |   |   |

## automation.retry

Retry a failed automation run from the step that failed: the steps that completed keep their results and are not repeated. Returns the new run's id.

|  |  |
| --- | --- |
| Permission | `records:write` |
| Risk | `write` |
| Audiences | `staff` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `runId` | string | yes | pattern `^arn_[0-9A-Z]{26}$` |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `runId` | string | yes |   |   |
| `deferred` | boolean |   |   | It waits its turn over the runs-per-minute rail, and starts on a later minute |

## automation.run

Start a manual automation for records (the button on a record page, or a bulk action on selected records): one run per record, subject to the automation's conditions and rails. Returns the run ids and how many records were skipped.

|  |  |
| --- | --- |
| Permission | `records:write` |
| Risk | `write` |
| Audiences | `staff` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes | pattern `^[a-z][a-z0-9]{1,29}\.[a-z][a-zA-Z0-9]{0,39}$` | Automation id: &lt;extension&gt;.&lt;automation&gt;, e.g. deals.wonOnboarding |
| `object` | string | yes |   |   |
| `recordIds` | array of string | yes | at least 1, at most 100 |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `runIds` | array of string | yes |   |   |
| `skipped` | number | yes |   |   |
| `deferredRunIds` | array of string |   |   | Runs over the runs-per-minute rail: recorded, and started on a later minute |

## automation.runs

Run history, newest first: one automation's runs (`id`), the runs that touched a record (`record`), or one run (`runId`). Each run has its trigger and record, status, steps with timings, operations called and logs, writes, its change set when it waits for approval, and errors. Kept 30 days (failed runs 90). Test runs only with includeTests. Read-only.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `read` |
| Audiences | `staff` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string |   | pattern `^[a-z][a-z0-9]{1,29}\.[a-z][a-zA-Z0-9]{0,39}$` | Automation id: &lt;extension&gt;.&lt;automation&gt;, e.g. deals.wonOnboarding |
| `record` | object |   |   |   |
| `record.object` | string | yes |   |   |
| `record.id` | string | yes |   |   |
| `runId` | string |   | pattern `^arn_[0-9A-Z]{26}$` |   |
| `status` | `"queued"`, `"running"`, `"waiting"`, `"review"`, `"completed"`, `"failed"`, `"cancelled"`, `"expired"`, `"skipped"` |   |   |   |
| `includeTests` | boolean |   | default `false` |   |
| `limit` | integer |   | ≥ 1, ≤ 200, default `50` |   |
| `cursor` | string |   |   |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `items` | array of object | yes |   |   |
| `items[].id` | string | yes |   |   |
| `items[].automationId` | string | yes |   |   |
| `items[].automationLabel` | string | yes |   |   |
| `items[].status` | `"queued"`, `"running"`, `"waiting"`, `"review"`, `"completed"`, `"failed"`, `"cancelled"`, `"expired"`, `"skipped"` | yes |   |   |
| `items[].statusReason` | string or null | yes |   |   |
| `items[].outcomeText` | string | yes |   |   |
| `items[].trigger` | any | yes |   |   |
| `items[].record` | object or null | yes |   |   |
| `items[].record.object` | string | yes |   |   |
| `items[].record.id` | string | yes |   |   |
| `items[].record.title` | string or null | yes |   |   |
| `items[].test` | boolean | yes |   |   |
| `items[].depth` | number | yes |   |   |
| `items[].steps` | array of any | yes |   |   |
| `items[].writes` | number | yes |   |   |
| `items[].changeSetId` | string or null | yes |   |   |
| `items[].waitUntil` | string or null | yes |   |   |
| `items[].retryOf` | string or null | yes |   |   |
| `items[].replayOf` | string or null | yes |   |   |
| `items[].error` | any or null | yes |   |   |
| `items[].startedAt` | string | yes |   |   |
| `items[].finishedAt` | string or null | yes |   |   |
| `nextCursor` | string or null | yes |   |   |

## automation.settings

The automation settings: whether the kill switch is engaged, the timezone schedules and date-relative triggers run in, and the debounce window for record updates. Read-only.

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
| `killSwitch` | boolean | yes |   |   |
| `timezone` | string | yes |   |   |
| `debounceSeconds` | number | yes |   |   |

## automation.test

Test mode: dry-run an automation against a chosen record with nothing written. Every step runs as it would for real, through the approval policy, but writes are simulated (later steps see them) and waits are skipped and shown. Reports whether the trigger and conditions match the record, each step, the records it would create or change, the notifications it would send and the changes that would need approval. Pass `id` for an installed automation. Use it after writing an automation: after extension.propose, test the proposed automation with proposal { actionId, key } and show the result before the proposal is approved (actionId: the pending action extension.propose returned; key: the automation's name in the extension's automations). A proposal can be tested only while it is pending.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `read` |
| Audiences | `staff` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string |   | pattern `^[a-z][a-z0-9]{1,29}\.[a-z][a-zA-Z0-9]{0,39}$` | Automation id: &lt;extension&gt;.&lt;automation&gt;, e.g. deals.wonOnboarding |
| `proposal` | object |   |   |   |
| `proposal.actionId` | string (starts_with) | yes | max length 64, pattern `^pac_.*` | The extension.apply pending action id (pac_…) from extension.propose |
| `proposal.key` | string | yes | pattern `^[a-z][a-zA-Z0-9]{0,39}$` | The automation's key in the proposed extension's automations |
| `record` | object |   |   |   |
| `record.object` | string | yes |   |   |
| `record.id` | string | yes |   |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `report` | any | yes |   |   |

## automation.unbindConnection

Withdraw the consent that lets an automation use a connection (revoke one binding). The automation waits for connections until someone binds another, and the admins are told. The person who bound it, the connection's owner or an admin. People only.

|  |  |
| --- | --- |
| Permission | `records:write` |
| Risk | `write` |
| Audiences | `staff` |
| Actors | `human` |
| Also | not offered to MCP clients (`mcp.expose: false`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes | pattern `^[a-z][a-z0-9]{1,29}\.[a-z][a-zA-Z0-9]{0,39}$` | Automation id: &lt;extension&gt;.&lt;automation&gt;, e.g. deals.wonOnboarding |
| `slot` | string | yes | pattern `^[a-z][a-zA-Z0-9]{0,39}$` | The connection id the automation declares (`connections[].id`) |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `pausedReason` | string or null | yes |   |   |
| `connections` | array of object | yes |   |   |
| `connections[].slot` | string | yes |   |   |
| `connections[].gatekeeper` | string | yes |   |   |
| `connections[].purpose` | string | yes |   |   |
| `connections[].binding` | object or null | yes |   |   |
| `connections[].binding.connectionId` | string | yes |   |   |
| `connections[].binding.connectionTitle` | string | yes |   |   |
| `connections[].binding.scope` | `"personal"`, `"org"` | yes |   |   |
| `connections[].binding.status` | string | yes |   |   |
| `connections[].binding.ownerUserId` | string | yes |   |   |
| `connections[].binding.ownerName` | string or null | yes |   |   |
| `connections[].binding.boundBy` | string | yes |   |   |
| `connections[].binding.boundByName` | string or null | yes |   |   |
| `connections[].binding.boundAt` | string | yes |   |   |
| `connections[].revoked` | object or null | yes |   |   |
| `connections[].revoked.connectionTitle` | string or null | yes |   |   |
| `connections[].revoked.revokedAt` | string | yes |   |   |
| `connections[].revoked.revokedByName` | string or null | yes |   |   |
| `connections[].revoked.reason` | string or null | yes |   |   |

## automation.updateSettings

Change the automation timezone (IANA, e.g. Australia/Sydney) or the debounce window in seconds (admins).

|  |  |
| --- | --- |
| Permission | `settings:manage` |
| Risk | `write` |
| Audiences | `staff` |
| Also | not offered to MCP clients (`mcp.expose: false`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `timezone` | string |   | min length 1, max length 64 |   |
| `debounceSeconds` | integer |   | ≥ 0, ≤ 3600 |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `killSwitch` | boolean | yes |   |   |
| `timezone` | string | yes |   |   |
| `debounceSeconds` | number | yes |   |   |
