# What the Durable Objects cost

**Date:** 2026-11-24. **Code:** `main` at `2f8f07ee` plus the fixes below. **Scope:** every Durable
Object class in the repository, found from each `wrangler*.jsonc` (`durable_objects` and
`migrations`) and from every `extends DurableObject` / `extends Agent`. D1, Workers, Queues and
Workflows are not covered here; the earlier audit is
[`docs/research/cloudflare-cost-audit.md`](research/cloudflare-cost-audit.md).

Nothing was deployed and no Cloudflare API was called. Every number in this file is either read
from the code or counted in workerd by a test; none is measured on a live host.

## How Durable Objects are billed

From Cloudflare's documentation, read on 2026-11-24
([pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/),
[lifecycle](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/),
[alarms](https://developers.cloudflare.com/durable-objects/api/alarms/),
[WebSockets](https://developers.cloudflare.com/durable-objects/best-practices/websockets/),
[state API](https://developers.cloudflare.com/durable-objects/api/state/),
[limits](https://developers.cloudflare.com/durable-objects/platform/limits/)). Workers Paid:

| What | Included a month | Then | One unit, past the included amount |
| --- | --- | --- | --- |
| **Requests**: HTTP requests, RPC sessions and method calls, alarm runs, incoming WebSocket messages (20 messages count as 1 request) | 1M | $0.15 per M | $0.00000015 a request |
| **Duration**: wall-clock time while the object is active, *or idle but unable to hibernate*, billed as 128 MB whatever it uses | 400,000 GB-s | $12.50 per M GB-s | 1 s awake = 0.125 GB-s = $0.0000016 |
| **SQLite rows read** (the KV API on a SQLite object counts as rows too) | 25 billion | $0.001 per M | $0.000000001 a row |
| **SQLite rows written** (each `setAlarm()` is 1 row; a delete counts as written; each index an insert or update touches is more rows) | 50M | $1.00 per M | $0.000001 a row |
| **Stored data** | 5 GB-month | $0.20 per GB-month | |

What decides duration:

- An object **hibernates** after about 10 seconds with no request or event, but only when
  nothing is pending:
  - no `setTimeout` or `setInterval`;
  - no pending I/O and no `waitUntil` promise;
  - no open outbound connection;
  - no WebSocket accepted with the standard API (`ws.accept()`).

  A hibernated object costs no duration.
- An object that cannot hibernate stays **idle in memory**, billed, and is evicted after 70 to
  140 seconds of inactivity. A pending outbound call can hold it for up to 15 minutes.
- A WebSocket accepted with **`ctx.acceptWebSocket()`** (the hibernation API) lets the object
  hibernate. The runtime answers protocol pings without waking it.
  `setWebSocketAutoResponse` answers a fixed application-level ping without waking it or billing
  duration.
- **Alarms**: one per object, and a new `setAlarm` replaces the old one. Delivery is at least once.
  A throwing `alarm()` is retried up to 6 times, with exponential backoff from 2 seconds.

Limits that matter here:

- 10 GB of SQLite per object;
- 100 bound parameters per statement and 100 KB per statement;
- 8 MB per row, string or BLOB;
- a soft limit of 1,000 requests a second per object;
- 30 s of CPU per request by default.

The local runtime enforces none of the billing and few of the limits. The tests in this change count
rows and statements from each statement's cursor (`cursor.rowsRead`, `cursor.rowsWritten`).

## The objects

| Class | Worker (binding) | One per | Production? |
| --- | --- | --- | --- |
| `AssistantAgent` | cos-app (`ASSISTANT`) | person (`user:<userId>`) | yes |
| `AgentJob` | cos-app (`AGENT_JOB`) | background agent (`job:<jobId>`) | yes |
| `ExtensionWorkspace` | cos-runner (`EXTENSION_WORKSPACE`) | deployment (`"workspace"`) | yes |
| `CodeModeGate` | cos-runner (`CODE_MODE_GATE`) | person | yes |
| `IntegrationHost` | cos-runner (`INTEGRATION_HOST`) | connection | yes |
| gatekeeper facets (`*GatekeeperImpl`, `OutlookGatekeeper`, …) | each gatekeeper Worker, run as facets in `IntegrationHost` | bound resource | yes |
| `UserAccount` (google, microsoft, slack, zoominfo, email), `SlackPostUserAccount`, mcp-shared account | each gatekeeper Worker (`ctx.exports`) | connected account | yes |
| `GmailHookDriver`, `ChatHookDriver`, `OutlookHookDriver` | gatekeeper-google, gatekeeper-microsoft | mailbox or space | yes |
| `EmailAddress` | gatekeeper-email | address | yes |
| `WebhookEndpoint` | gatekeeper-webhook (`WEBHOOK_ENDPOINT`) | endpoint | yes |
| `PaymentsEvents` | gatekeeper-payments (`PAYMENTS_EVENTS`) | provider (`"stripe"`) | yes |
| `FakeAccount`, `FakeProvider`, `FakeGatekeeper` | cos-runner | address, account | development and tests only (`GATEKEEPER_FAKE` is never deployed) |
| `FakePaymentsLedger` | gatekeeper-payments (`FAKE_PAYMENTS`) | deployment | only with `PAYMENTS_FAKE_PROVIDER=true` |
| `FakeAccountingBooks` | gatekeeper-accounting `wrangler.fake.jsonc` | deployment | development and tests only |
| `FakeD1Database` | control `wrangler.e2e.jsonc` | e2e run | local workerd only, never billed |
| `TestHost`, `TestHooks`, `TrackerHost`, `Sent`, `Conformance*` | test workers | test | never deployed |

None of them uses `ws.accept()`, `setInterval`, or an unbounded `setTimeout`. The one WebSocket
object, `AssistantAgent`, uses the hibernation API.

## What each object costs per unit of use

### AssistantAgent (`apps/app/src/server/assistant/agent.ts`)

**What wakes it.** Every signed-in tab keeps one WebSocket open to it
(`apps/app/src/components/assistant/thread-provider.tsx:170`), reconnecting with backoff. Besides
that, it wakes for:

- the HTTP turn route and thread operations (RPC);
- routine deliveries from the queue;
- an agent's progress (`jobChanged`, at most every 3 s while a job runs, `job.ts:87`) and its end;
- erases (`scrub`);
- its one idle alarm.

**WebSockets: hibernating.** The Agents SDK (0.33.0) accepts every socket through its hibernating
WebSocket manager, so an idle open tab costs nothing. Incoming frames each wake it: `send`, `stop`,
`sync`, and `visible` when a tab gains or loses focus (`agent.ts:598`). Each frame is 1/20 of a
request, plus a few milliseconds of duration and the SDK's wake-up.

Outgoing frames are not billed. A turn broadcasts every streamed event to every open tab
(`agent.ts:892`), which costs no requests but some CPU.

**A turn.** The object is active, and billed, for the turn's whole wall time, since it awaits the
model and the tools (`agent.ts:716`). A 20-second turn is 2.5 GB-s, about $0.00003. Its storage is
the person's message and the replies, each with its turn index and full-text row, plus the turn's
row and a few meta keys: tens of rows written (estimated from the code, not counted). Inherent to
the design.

**Opening a chat** (`onConnect`, `agent.ts:541`, and every `sync`). The state read now costs
**508 rows read and 10 statements on a 1,500-turn thread**, down from 1,908. It no longer grows with
the thread's age (fixed below; `apps/app/test/assistant-costs.test.ts`).

**Idle alarm** (`compaction.ts:434`). At most one per turn, set just before the estimated cache
expiry. When it fires it plans once and either compacts or stops. At the idle moment the planner
returns no next alarm, except in the fixed-wait fallback when woken early
(`packages/agent-core/src/compaction/plan.ts:263-270`, `:327-346`). It never re-arms while idle.

The handler catches everything, so it cannot retry-storm. Each alarm costs 1 request, 1 row
written by the SDK's schedule table and its `setAlarm`, and one D1 write through
`ai.recordCacheReview`. Pinned by `apps/app/test/assistant-compaction.test.ts` ("the idle alarm
compacts just before expiry…", "never compacts below the floor…": no alarm is left).

**Fan-out.** One object per person. Turns are serialised per person on purpose.

### AgentJob (`apps/app/src/server/assistant/job.ts`)

- **A slice** of up to 8 model steps (`:84`) runs on an alarm set for now (`:538`). It costs:
  - 1 request;
  - the slice's wall time in duration;
  - 1 row written per step for its usage (`:503`);
  - the messages appended.

  It reads all of the job's messages 2 to 4 times per slice (`:149`), which is cheap: hundreds
  of rows.
- **While it runs**, it tells the parent thread at most every 3 s (`:87`). Each time costs 1
  `AssistantAgent` request, and every open tab refetches the agent card.
- **Errors**: `alarm()` catches a failed slice and finishes the job as failed (`:268-280`), so it
  does not retry-storm. A D1 error inside `#finish` or `#remind` can still throw, and then the
  platform retries at most 6 times.
- **While changes wait for review**, a reminder alarm fires every `reminderHours` (`:620`). It stops
  once no pending action is left. Pending actions expire after `APPROVAL_EXPIRY_DAYS` (7 by
  default), so the reminders end.
- **Cleanup**: `#cleanUp` deletes the alarm and all storage (`:634`). A finished job leaves nothing.
- **`wait()`** holds a timer only for as long as its caller's RPC waits (`:183`).
- **The 10-minute cron** (`job-cron.ts`) wakes only jobs that have been quiet for a while, at most 50.

### ExtensionWorkspace (`apps/runner/src/extensions/workspace.ts`)

- **One object for the deployment** (`apps/runner/src/index.ts:100`,
  `executor/build-cache.ts:25`). Since ADR 0043 it is off the execution path. It wakes:
  - when a cos-app isolate starts: 1 + N requests, one `commitShipped` per pack (`:232`), with no
    writes when nothing changed;
  - when a tool or manifest worker starts cold and its build is not cached;
  - when an extension is authored, committed or proposed.
- **No alarms, timers or sockets.** Its `#queue` is an in-memory promise chain (`:60`).
- **Storage grows slowly**:
  - git history, one commit per changed pack per release;
  - `summary:*` and `source:*:*` keys that are never pruned;
  - `vfs_changes` rows.

  All of it is small, billed as stored data.

### CodeModeGate (`apps/runner/src/executor/code-gate.ts`)

- **Per Code Mode run**: 2 requests (`acquire` and `release`, `:15`, `:24`), 2 rows read, 2 rows
  written.
- **No alarm**: a lease expires by its `until` time.

### IntegrationHost (`apps/runner/src/integrations/host.ts`)

- **What wakes it**: every gatekeeper call, approval apply, hook firing and gatekeeper callback,
  plus its sync alarm.
- **A call** costs about 3 KV reads and no writes. The gatekeeper's facets run inside this object,
  so their time is this object's duration.
- **A sync pass** (`#syncPass`, `:1132`) costs:
  - 1 request;
  - about 6 KV reads;
  - 2 rows written (`sync`, plus the `setAlarm`);
  - a D1 read and the D1 mirror write;
  - the pass's wall time while the provider answers.
- **How often it passes**: every second while backfilling, then every 15 minutes for good
  (`CATCH_UP_MS`, `:54`; `:1159`). That is 2,880 passes a month per syncing connection, about
  5,760 rows written. At 3 s a pass it is about 1,080 GB-s, roughly $0.013 a month per connection
  past the included amount. Pushes in between merge into one alarm 5 s out (`syncSoon`).
- **Expired connections**: they used to keep polling every 15 minutes, forever. Fixed below.
- **Fan-out**: one object per connection, and no `blockConcurrencyWhile`. A busy org mailbox
  connection funnels its mail through one object, but its calls mostly wait on RPC, so they
  interleave.

### Gatekeeper accounts, facets and hook drivers (`packages/gatekeeper-*`, `packages/mcp-shared`)

Most of this is vendored from cloudflare-os (`UPSTREAMS.md`). There are no WebSockets and no
singletons, and every timer is bounded. One-shot connect-timeout alarms are deleted when the
connect completes.

The real multiplier is RPCs from a facet to its account object for tokens: each is a billed
`UserAccount` request, multiplied by the host's 96 sync passes a day.

- **`GmailHookDriver`** (`gatekeeper-google/src/gmail-hooks.ts`):
  - **Per push**: 1–2 requests, about 1 row written, and an alarm.
  - **Per sync**: 3 Google calls, each with a token RPC to `UserAccount` (`:414-417`), and 3–5
    rows written.
  - **Background alarms**: a safety sync every hour forever while a hook exists (`:89`), and the
    watch renewed daily (`:86`).
  - **Total**: about 24 alarms and 72 token requests a day per mailbox, well under a cent a month.
- **`ChatHookDriver`**: renews its subscription every 3 hours (`chat-hooks.ts:83`), as Google
  requires. Errors retry in 15 minutes.
- **`OutlookHookDriver`** (`gatekeeper-microsoft/src/outlook-hooks.ts`): a safety sync hourly
  while hooks exist (`:36`), and subscriptions renewed every 1.5 days.
- **Delivery queue** (`gatekeeper-kit/src/hook-delivery-queue.ts`): about 7 rows written per
  delivered message per hook. Retries are capped at 8 with backoff, so there is no storm. A finished
  row is forgotten 24 h later, on its own alarm (`:149-154`).

### WebhookEndpoint and PaymentsEvents (our own: `gatekeeper-webhook/src/endpoint.ts`, `gatekeeper-payments/src/events.ts`)

- **What wakes them**: each inbound delivery and admin status calls. There are no timers and no
  polls; the only alarm delivers queued events.
- **An accepted delivery** costs:
  - 1–3 requests;
  - about 15–18 rows written (the dedupe row with its two indexes, the event, the stats key, the
    queue rows and `setAlarm`), about $0.000018;
  - now **13 rows read and 6 statements**, down from 10,234 rows read (fixed below).
- **A rejected signature** writes one stats key. Any well-formed endpoint id from the internet
  wakes an object, at 1 request; an unconfigured one returns 404 with no writes.
- **`PaymentsEvents` is one object per provider.** Payment event rates are far below one object's
  1,000 requests a second.

### The fakes

- `FakePaymentsLedger` and `FakeAccountingBooks` list and rewrite their whole state on calls.
- `FakeD1Database` runs only in local e2e.

None runs on a production host.

## Fixed in this change

| # | Where | What was wasted | What is billed, before → after | Pinned by |
| --- | --- | --- | --- | --- |
| 1 | `apps/app/src/server/assistant/agent.ts:331` (`#errorItems`) | Every chat open, reconnect and `sync` read every row of `thread_turns`, one row per turn the thread ever had, to find failed turns, then dropped those outside the window. It now asks by primary key for the window's turns only. | Rows read per state read on a 1,500-turn thread: 1,908 → 508. No longer grows with the thread's age. | `apps/app/test/assistant-costs.test.ts` |
| 2 | `apps/runner/src/integrations/host.ts:1144`, `:1104`, and `credentialsChanged` / `redeem` | A connection whose credentials expired kept its 15-minute sync alarm forever. Each pass opened gatekeeper sessions that failed, then wrote its state and the D1 mirror and re-armed. The pass now stops with no alarm while the connection is `expired`. The provider's "restored", or a reconnect, starts it again in 5 s, from its cursors. | Per expired connection a month: 2,880 alarm runs, about 5,760 rows written, the failed passes' duration and 2,880 D1 writes → 0. | `apps/runner/test/integrations.test.ts`, "an expired connection stops polling with no alarm left, and carries on once restored" |
| 3 | `packages/gatekeeper-webhook/src/endpoint.ts:177`, `packages/gatekeeper-payments/src/events.ts:120` | Keeping the dedupe cap (10,000 ids, 30 days) and the recent-events cap (100) read the whole `seen` table and `events` twice on every accepted delivery (`… OR id IN (… OFFSET 10000)`, `seq NOT IN (…)`). They now delete by key range: rowid and seq grow with each insert, and the newest row is never deleted. | Rows read per accepted delivery with a full table: 10,234 → 13. Same caps, same rows kept. | `packages/gatekeeper-webhook/__tests__/storage-costs.test.ts`, `packages/gatekeeper-payments/__tests__/storage-costs.test.ts` |

In dollars, #1 and #3 are small, since rows read are the cheapest unit. They are fixed because the
cost grew with data that nothing bounded except the cap itself, and because each statement held its
object for the whole scan. #2 is a pure loss for as long as nobody reconnects.

## What is left

Severity weighs cost at the scale of one org (10 people, a few mailboxes) against how it grows.
None is above Low in dollars.

| # | Where | What | Billed | Why it is left |
| --- | --- | --- | --- | --- |
| L1 | `apps/runner/src/integrations/host.ts:54`, `:1159` | The 15-minute catch-up runs even while push hooks work, and with sharing set to `none`. | About 2,880 requests, 5,760 rows written and about 1,000 GB-s a month per syncing connection. | Lengthening it while push is healthy needs a decision on how late a missed push may arrive. |
| L2 | `apps/runner/src/integrations/host.ts:1121` | If `alarm()` throws every time (D1 or storage down), the 6 retries run out, nothing re-arms, and sync stops until the next `syncSoon` or `setSync`. | Reliability, not cost. | A re-arm in `finally` changes failure behaviour, so it should be its own change with its own test. |
| L3 | `apps/runner/src/integrations/host.ts:1073` | `setSync` to a new resource subscribes a new hook but never turns the old one off. The old hook keeps calling `syncSoon`. | Extra wakes, at 1 request each. | Needs the gatekeepers' hook disable path for sync hooks. |
| L4 | `packages/gatekeeper-webhook/src/endpoint.ts:199`, `packages/gatekeeper-payments/src/events.ts:143` | `setAlarm(now)` on every accepted event, even when an alarm is already due. | 1 row written per event. | Skipping it needs care during a running alarm. |
| L5 | `packages/gatekeeper-kit/src/hook-delivery-queue.ts:149-154` | Each finished delivery gets its own wake 24 h later, only to forget it. | 1 request and 1 row written per delivery. | Rounding up to the hour would cap it at 24 a day per object, but it relaxes the documented 24 h dedupe floor. Vendored kit. |
| L6 | `packages/gatekeeper-email-send/src/worker.ts:600-614` | `#remember` lists the whole idempotency order prefix on every new key: up to 2,000 keys, or 20,000 for agreements. `#record` lists about 200 history rows to trim them. | About 20k rows read per agreement email. | Needs a stored count or batched pruning, plus migration of the existing keys. |
| L7 | `apps/runner/src/extensions/workspace.ts:232`, `apps/app/src/server/operations.ts` | Each new cos-app isolate makes 1 + N calls to the one workspace object, one per pack. | 1 + N requests per isolate start. | A batched `commitShippedAll` would make it 1. Small at today's isolate churn. |
| L8 | `packages/gatekeeper-microsoft/src/outlook-hooks.ts:289` (vendored) | A dead grant whose hooks were not dropped retries every 5 minutes, forever. | 288 alarm runs, 288 `UserAccount` requests and about 576 rows written a day per dead mailbox. | Vendored. An hour on `isCredentialsExpired` is the obvious change; recorded for upstream. |
| L9 | `packages/gatekeeper-google/src/gmail-hooks.ts:414-417`, `chat-hooks.ts:302-305` (vendored, V2) | The hook drivers ask `UserAccount` for a token on every Google call, with no `AccessTokenCache`. | About 2–3 extra requests per sync. | Vendored. Upstream. |
| L10 | `packages/gatekeeper-google/src/google-api.ts:3250-3255` (vendored, V1) | The Gmail watch has no label filter, so every mailbox change pushes. | 2 requests per push, plus a sync. | Label hooks need the union of their labels, not INBOX alone. |
| L11 | `packages/gatekeeper-google/src/gmail.ts:4804` (vendored) | Each Gmail session writes `selfEmail` even when it is unchanged, after a userinfo fetch. | 1 row written per session. | Vendored. Upstream. |
| L12 | Microsoft facets, `gatekeeper-kit/src/credentials.ts:978-983`, `cache.ts:114` (vendored) | One `UserAccount` RPC per Graph call and per cache lookup. | A few requests per Graph read. | Deliberate upstream, so a reconnect is seen before a cache hit. |
| L13 | `packages/mcp-shared/src/connection.ts:149`, `catalog.ts:23` (vendored, V3 and V4) | MCP servers with no session id are re-initialised before every call. The tool catalog lives 5 minutes. | 2 `getConnection` / `assertConnectionCurrent` requests per tool call. | Vendored. Upstream. |
| L14 | `gatekeeper-kit/src/cache.ts:258`, Google calendar revert keys `google.ts:2818`, Chat `chat:revert:*` (vendored, V5) | KV cache entries and revert keys are never deleted. | Stored data only, tiny. | Vendored. Needs a revert window. |

## What to watch on the dashboard

- **Durable Objects → each namespace → Metrics.** Requests and duration per class. Five
  namespaces should dominate: `cos-app`'s `AssistantAgent`, `cos-runner`'s `IntegrationHost`, and
  the gatekeepers' `UserAccount` and hook drivers.
  - `AssistantAgent` duration should track turns: about the turn's seconds × 0.125 GB-s. Duration
    that grows with open tabs, not turns, means something keeps sockets from hibernating.
  - `IntegrationHost` requests should be about 2,880 a month per syncing connection, plus calls.
    Far more means a hook storm or a backfill that does not end.
  - `ExtensionWorkspace` requests should track deploys and authoring, never page views.
- **The account's billable usage**: Durable Objects requests, duration (GB-s), rows read, rows
  written and stored data against the included 1M, 400k, 25B, 50M and 5 GB. Rows written are the
  first SQLite line likely to pass its allowance (every delivery, sync pass and turn writes tens
  of rows).
- **GraphQL Analytics**, for one object's share:
  - `durableObjectsInvocationsAdaptiveGroups` (requests);
  - `durableObjectsPeriodicGroups` (CPU and active time);
  - `durableObjectsStorageGroups` (stored bytes);
  - `durableObjectsSubrequestsAdaptiveGroups`.

  Cloudflare's page names these datasets; check the exact fields by introspection.
- **Stored bytes per object** near the 10 GB cap: a person's `AssistantAgent` (the thread never
  resets) and `ExtensionWorkspace` (git history).
