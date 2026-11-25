# Stage 72: The assistant on AWS

Read first: [`AGENTS.md`](../../AGENTS.md), [`docs/architecture.md`](../architecture.md)
(MCP, AI), [`CONTEXT.md`](../../CONTEXT.md) (Assistant, Thread, Agent), ADRs
[0950](../adr/0950-two-targets-cloudflare-and-aws.md),
[0021](../adr/0021-mcp-surface.md), [0032](../adr/0032-mcp-sessions-and-approval-mechanics.md),
[0200](../adr/0200-in-app-assistant-build.md), [0320](../adr/0320-erase-reaches-every-store.md),
[0340](../adr/0340-one-assistant-thread-per-user.md),
[0341](../adr/0341-compaction-cost-model-and-cache-lifetime-learner.md),
[0344](../adr/0344-agents-as-child-durable-objects.md) and
[0349](../adr/0349-voice-on-agents-voice.md); stages [67](67-postgres.md),
[68](68-host-on-node.md) and [71](71-models-vectors-mail-on-aws.md); code:
`apps/app/src/server/assistant/` (`agent.ts`, `job.ts`, `http.ts`, `compaction.ts`, `voice.ts`),
`apps/app/src/server/mcp/handler.ts`, `apps/app/src/components/assistant/thread-provider.tsx`,
`packages/agent-core/src/store.ts`, `packages/agent-voice/src/mixin.ts`.

Status: **spec proposed (2026-11-26)**. Not built until its interview settles the questions at its
end.

## Goal

On the AWS target a member of staff has the same assistant as on Cloudflare: one thread, turns
that stream to every open window, agents that work beside the chat, compaction, and the MCP server
for connected apps. The thread is kept in the client's Postgres schema, in the deployment's
region. Cloudflare's assistant does not change.

## What exists today (from the code)

- **The thread is a Durable Object.** `AssistantAgent` (`apps/app/src/server/assistant/agent.ts`,
  1,409 lines) extends the Agents SDK's `Agent` through `withAssistantVoice`. One object per
  user, named `user:<userId>` (ADR 0340). It runs one turn at a time and keeps the running turn
  in memory.
- **Its storage is the object's SQLite.** `thread_meta`, `thread_turns` and agent-core's
  `thread_messages` with the FTS5 table `thread_search` are created with `ctx.storage.sql`.
  Several writes are grouped with `ctx.storage.transactionSync`. The thread is not in D1; D1 gets
  only what operations write (`thread.open`, `thread.finishTurn`, the tool calls).
- **Readers are WebSockets.** The browser opens `/api/assistant/socket`
  (`thread-provider.tsx` uses a plain `WebSocket`, no SDK client); `http.ts` forwards the upgrade
  to the object, which accepts hibernatable sockets (`onConnect`, `onMessage`) and sends frames
  with `this.broadcast`. `/api/assistant/turn` and `/thread/stream` return the same events as
  server-sent events for evals.
- **One scheduled wake-up.** Compaction's idle alarm is `this.schedule(at, "onIdleAlarm")`,
  cancelled with `cancelSchedule` (`agent.ts`, the `ThreadCompaction` host).
- **An agent is a second Durable Object.** `AgentJob` (`job.ts`, 629 lines) extends
  `DurableObject`, named `job:<jobId>` (ADR 0344). It keeps `job_messages` in its own SQLite and
  works in slices of 8 model steps, each started by `ctx.storage.setAlarm`. A reminder alarm
  stays while changes wait for review; then it deletes its storage. The 10-minute cron
  (`job-cron.ts`) starts queued jobs and nudges quiet ones.
- **Already free of Cloudflare:** `packages/agent-core`, `packages/agent-plugins` and
  `packages/agent-a2ui` import nothing from `cloudflare:workers` or `agents`. Turn assembly,
  compaction's planner, the thread types and the card format are theirs.
- **Not free:**
  - agent-core's `MessageStore` is **synchronous** by design ("the store sits next to the
    thread's single writer"). `SqliteMessageStore` takes `SqlLike`, the shape of a Durable
    Object's `sql.exec`, and searches with FTS5 `MATCH`.
  - `packages/agent-voice` is built on `agents/voice` (`withVoice` in `mixin.ts`) and needs an
    `Agent` class under it. Its sockets go straight to AssemblyAI (ADR 0349).
  - The MCP server (`apps/app/src/server/mcp/handler.ts`) uses `createMcpHandler` from
    `agents/mcp/server` over an MCP SDK server built per request, behind
    `@cloudflare/workers-oauth-provider`, which keeps clients, grants and tokens in `OAUTH_KV`.
- **The assistant's tools are portable.** They are an in-process MCP client of our own server
  (`mcp-client.ts`), acting as `assistant` for the thread's owner. No network hop is involved.
- **Models** are asked for by role (`assistant.core`, `assistant.subagent`) through
  `aiContextFor`. Nothing in the thread names a model.

## Decided by the owner (2026-11-26)

1. Two targets. The AWS target is Node 22 in containers, with RDS Postgres. Not workerd on AWS.
2. A schema per client in one Postgres database. No table gains a client column.
3. Schedules and queues on AWS are stored in Postgres behind the platform's own interfaces
   (stage 68).
4. Search on AWS is Postgres full-text search.
5. Models on AWS come from Bedrock in the deployment's region (stage 71).
6. The whole host is wanted on AWS, in stages. The assistant is one of them.

## The design in one page

```
 browser ── WebSocket /api/assistant/socket ──► any Node task
                                                  │ LISTEN (turn events, by thread)
 browser ── POST a message ──► a Node task ───────┤
                                 │ takes the thread's lock, runs the turn
                                 ▼
          the client's schema: thread messages, turns, meta, turn events
                                 ▲
 stage 68's queue ── a job slice ┘   stage 68's schedules ── the idle wake-up
```

- **A thread host** is a new seam: what `AssistantAgent` does with `ctx.storage`, `broadcast`
  and `schedule`, behind one interface. Cloudflare's implementation is the object as it is. The
  Node implementation is new. The turn logic above the seam is shared.
- **On Node, the thread is rows** in the client's schema. One writer per thread is kept by a
  lock, not by an object.
- **Nothing is held only in one task's memory** that another task needs: a turn's events are
  written and announced, so a window connected to a different task still sees them.

## The model

### The thread's tables

In the Postgres migration set only (stage 67), in each client's schema: the thread's messages,
turns and meta, keyed by user, and a search column on the messages. They hold what the object's
SQLite holds today, with the same conventions (ISO-8601 text dates, JSON as text). The Cloudflare
target has no such tables: its thread stays in the object.

Erase (ADR 0320) and a client's export reach these rows as they reach any core table. On
Cloudflare they reach the object through its own methods, as now.

### The message store

agent-core's `MessageStore` becomes asynchronous: every method returns a promise. The SQLite
store keeps its code and resolves at once. A `PostgresMessageStore` joins it, over the query
layer of stage 67. Compaction's `transaction` hook takes an async body.

Thread search uses Postgres full-text search with the `simple` configuration and prefix terms,
to match what `ftsQuery` does today (every term, as a prefix, no operators). The excerpt is
already made in TypeScript (`excerpt`).

### One writer per thread

A task that runs a turn first takes a Postgres advisory lock named for the thread, on a
connection it holds for the length of the turn. A second message for the same thread is refused
with the same 409 answer as today ("A reply is still being written"). If the task dies, the
connection closes and the lock is released; the turn is left `running` in the table and shows as
interrupted, which is what an evicted object leaves today.

This lock is separate from stage 67's per-client write lock. A turn's tool calls are operations
and take that lock one at a time, for the length of each write only.

### Sockets and the running turn

The Node server accepts the WebSocket at the same path, with the same frames, so the browser
code does not change. The session is checked on upgrade, as `handleSocket` does.

A running turn's events are appended to a turn-events table in small batches and announced with
`NOTIFY`. Each task holds one listening connection and forwards a thread's events to the sockets
it holds for that thread's owner. Resuming (`/thread/stream?after=N`) reads the table. The rows
are deleted when the turn finishes. A notification carries only the thread and a sequence
number, never content.

How large a batch can be before the stream looks slow, and what it costs the database, is not
known. Step 1 measures it.

### Wake-ups and agents

- **The idle alarm** becomes a one-off wake-up in stage 68's schedules, keyed by the thread, set
  and cancelled as `schedule` and `cancelSchedule` are today. Stage 68 must offer one-off
  wake-ups at a time, not only repeating ones.
- **An agent** on Node is a job row and its messages in the client's schema. A slice is a message
  on stage 68's queue: the consumer takes the job's lock, runs up to 8 model steps, and queues
  the next slice or the reminder. A failed slice is redelivered and carries on from the stored
  messages, as the next alarm does today. The sweep on the 10-minute schedule is unchanged
  (`sweepAgentJobs` is core's).
- The limits of ADR 0344 (4 per user, 16 per workspace) are already counted in the database.

### The MCP server and its OAuth store

- `/mcp` is served by the MCP SDK's own Streamable HTTP transport in place of
  `createMcpHandler`. The server (`createCrmMcpServer`) and its tools do not change.
- OAuth keeps `@cloudflare/workers-oauth-provider`, given a store with the key-value shape it
  expects, backed by a table in the client's schema. Whether the library runs unchanged on Node
  22 has not been verified; step 1 checks. If it does not, the same endpoints are written with a
  maintained Node OAuth server library and the same table.

### Voice

Not in the first steps. agent-voice sits on `agents/voice`, and a call's audio goes to a speech
provider outside the deployment's region. On AWS the assistant reports voice as off, which the
app already handles (voice is off today unless a key is set). Step 7 is written here so it is
not forgotten; it waits for question 1.

## Out of scope

- Any change to the assistant on Cloudflare beyond the store interface becoming asynchronous.
- Which Bedrock models fill the roles, and what happens if none in the region is good enough:
  stage 71.
- Connections the assistant's tools call: stage 73.
- A speech provider for AWS.
- Moving Cloudflare's thread into D1 to have one store.

## Acceptance criteria

1. agent-core's suite passes with the asynchronous store, on SQLite and on Postgres.
2. On the AWS target a person sends a message and the reply streams to two windows at once,
   with two Node tasks running and each window on a different task.
3. A second message sent while a turn runs is refused; killing the task mid-turn frees the
   thread within seconds and the turn shows as interrupted.
4. Reloading mid-turn resumes the stream from where it stopped.
5. Thread search returns the same messages as on Cloudflare for the search tests' queries.
6. Compaction's idle wake-up fires once at its time and is cancelled by a new turn.
7. An agent runs to the end across more than one slice, survives a task killed mid-slice, and
   leaves its changes for review. Its limits hold across tasks.
8. Erase removes a person's content from thread and job rows; a client's export includes them.
9. A connected app completes OAuth against the Node server and calls a tool over `/mcp`;
   revoking the app (`connectedApp.revoke`) ends its tokens.
10. One client's thread, events and OAuth grants cannot be read from another client's schema.
11. The app's assistant e2e spec passes against the Node server.
12. The Cloudflare assistant's tests pass unchanged apart from awaiting the store.

## Dependencies

Stage 67 (Postgres), stage 68 (the Node server, schedules with one-off wake-ups, the queue),
stage 71 (models). Stage 66 for the client a request belongs to.

## Migrations and numbers

No numbers are picked here. The first build step claims a block for its ADR and its Postgres
migrations in [`docs/parallel-work.md`](../parallel-work.md). No SQLite migration is needed.

## Suggested build order

1. **Spike.** One thread on Node with two tasks: the lock, events through a table and `NOTIFY`,
   measured for delay and database load at a few batch sizes. Check that the OAuth library runs
   on Node. Record the results; return to the owner if streaming is not acceptable.
2. **The asynchronous message store,** and `PostgresMessageStore` with search. Criteria 1, 5.
3. **The thread host seam and its Node implementation:** turns, the lock, sockets, resume, the
   idle wake-up. Criteria 2 to 4, 6, 12.
4. **Agents on Node:** job rows, slices on the queue, the reminder. Criterion 7.
5. **The MCP server and OAuth store on Node.** Criterion 9.
6. **Erase, export, the two-client test, e2e and docs.** Criteria 8, 10, 11.
7. **Voice on Node** (later, after question 1).

Steps 4 and 5 can run beside step 3 once step 2 is in.

## Decided by this spec, open to override

- **The thread is in the client's schema on AWS,** not in a store of its own.
- **Cloudflare's thread stays in its Durable Object.** The two targets share turn logic, not
  storage.
- **The message store is asynchronous on both targets,** so there is one interface.
- **One writer per thread by a Postgres advisory lock** held for the turn.
- **Turn events go through a table and `NOTIFY`,** so any task can serve any window. No sticky
  routing at the load balancer.
- **Thread tables exist only in the Postgres migration set.**
- **The same socket path and frames,** so the browser code is one.
- **The Agents SDK is not run on Node.** It is a Durable Object library.
- **Voice is off on AWS** until its own step.

## Questions for the owner

1. **Is voice wanted on the AWS target?** A call's audio and transcript go to a speech provider
   that is not in Australia. Recommended: no voice on AWS for now, and step 7 waits until a
   provider that keeps audio in the region is chosen. A health product's spoken notes are the
   data the region rule is for.
2. **May outside apps connect over MCP on a deployment that must keep data in the region?** A
   connected app (a desktop AI client, say) receives record data wherever it runs.
   Recommended: build it, with a per-client setting in the registry that turns outside
   connections off, and off by default on AWS. The server is needed anyway, because the
   assistant's own tools use it in-process.

## Status

Spec proposed (2026-11-26). No build step is built yet. Each build step changes its own line
here (CONTRIBUTING.md, Working in parallel).

- **Step 1** — not built — needs: stage 68, stage 71 — Spike: one thread on Node with two tasks, timed; the OAuth library on Node

- **Step 2** — not built — needs: step 1 — The asynchronous message store and `PostgresMessageStore` with search

- **Step 3** — not built — needs: step 2 — The thread host seam and its Node implementation

- **Step 4** — not built — needs: step 2 — Agents on Node: job rows, slices on the queue, the reminder

- **Step 5** — not built — needs: step 1 — The MCP server and OAuth store on Node

- **Step 6** — not built — needs: step 3, step 4, step 5 — Erase, export, the two-client test, e2e and docs

- **Step 7** — not built — needs: step 3 — Voice on Node (waits for question 1)
