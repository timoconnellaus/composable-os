# Stage 68: The host on Node

Read first: [`AGENTS.md`](../../AGENTS.md), [`docs/architecture.md`](../architecture.md),
[`CONTEXT.md`](../../CONTEXT.md), ADRs [0950](../adr/0950-two-targets-cloudflare-and-aws.md),
[0004](../adr/0004-worker-topology.md), [0006](../adr/0006-dynamic-runtime-cloudflare-computer.md),
[0021](../adr/0021-mcp-surface.md), [0043](../adr/0043-extension-executor-and-stable-loader-ids.md),
[0091](../adr/0091-rate-limiting-binding.md), [0130](../adr/0130-automation-runtime.md) and
[0171](../adr/0171-automation-events-outbox.md); stages
[66](66-one-host-many-clients.md) (the client's environment) and [67](67-postgres.md);
`apps/app/src/server.ts`, `start.ts`, `server/operations.ts`, `server/runner.ts`,
`server/mcp/handler.ts`, `apps/app/vite.config.ts`, both `wrangler.jsonc` files,
`apps/runner/src/index.ts`, `rpc.ts`, `automations/workflow.ts`, `automations/dispatch.ts`,
`executor/code-gate.ts`, `extensions/workspace.ts`, `packages/core/src/rate-limit.ts`,
`automations/events.ts`.

Status: **spec proposed (2026-11-26)**. Not built until its interview settles the questions at its end.

## Goal

The host runs as a Node server as well as on Workers. The app and the runner's work start from
Node entries, and everything they need from the platform under them (the database, files, queues,
schedules, workflows, rate limits, small locks, key-value data, extension source, secrets) comes
through one seam with two implementations. Above the seam the code is the same on both targets.
At the end a developer runs the host on Node with Postgres on their own machine, and the tests
and the end-to-end suite run against it. Nothing is deployed to AWS in this stage.

## What exists today (from the code)

- **Two Workers.** `apps/app` is TanStack Start built through `@cloudflare/vite-plugin`
  (`vite.config.ts`), with its own `fetch`, `queue` and `scheduled` in `src/server.ts`.
  `apps/runner` is a `WorkerEntrypoint` (`src/index.ts`) with about 30 RPC methods (`RunnerRpc`,
  `src/rpc.ts`), a `queue` consumer and a `scheduled` handler that calls `minuteTick`.
- **The app calls the runner over a service binding** (`runner(env)`, `server/runner.ts`), from
  `operations.ts`, `integrations.ts`, `health.ts`, `updater.ts` and `system.ts`. Every method
  takes and returns plain data, with one exception: `gatekeeperFetch(vendor, request)` takes a
  `Request` and returns a `Response`. The interfaces behind it (`ExtensionHost`, `AutomationHost`,
  `IntegrationRuntime` in `packages/core`) name no stream, stub or byte array.
- **`cloudflare:workers` is imported by 31 non-test files in the two Workers' `src`** (112 across
  `apps`, `packages` and `products`). 14 of the 31 import the ambient `env`: twelve in the app
  (seven routes under `routes/api` and `routes/gatekeeper`, `server.ts`, `start.ts`,
  `call-operation.ts`, `session.public.ts`, `system.ts`, `assistant/routine-agents.ts`) and the
  runner's `index.ts`. The rest are classes the runtime constructs: Durable Objects, the Workflow,
  entrypoints and RPC targets.
- **The adapters** that turn bindings into what operations are given are in
  `apps/app/src/server/operations.ts` (`extensionHostFor`, `automationWiring`,
  `assistantThreadsFor`, `agentJobsFor`), `integrations.ts` (`blobStoreFor`) and `media.ts`
  (`mediaStoreFor`, `mediaResizerFor`). The runner reads the bucket directly in three places
  (`extensions/shipped-list.ts`, `integrations/runtime.ts`, `integrations/host.ts`).
- **The database is reached by `createCrmDb(env.DB)`** in 23 non-test files of the app's `src`,
  16 of the runner's and 2 of `packages/auth`, and by raw `.prepare(` statements in 4, 9 and 6
  places in the same three. `packages/auth/src/better-auth.ts` hands better-auth the
  `D1Database` itself. Callers' addresses are read from `cf-connecting-ip` (`server/http/api.ts`).
- **Queues.** `cos-automation-events`: the app and the runner produce, the runner consumes, at
  most 100 messages or 5 seconds a batch, 5 retries, then `cos-automation-events-dlq`; a failed
  batch is retried whole after 10 seconds. It is fed after commit from an outbox row written with
  the change (ADR 0171), and the minute tick re-sends what is left. `cos-routine-delivery`: the
  runner produces, the app consumes, 10 a batch, 3 retries, a dead-letter queue, each message
  acknowledged or retried after 30 seconds on its own.
- **Schedules.** The app: `17 3 * * *` (maintenance) and `*/10 * * * *` (embeddings, the
  adjudicator, file deletion, agent jobs). The runner: `* * * * *`, about twenty independent
  steps in `minuteTick`, which takes the tick's time.
- **One real workflow,** `AutomationWorkflow` (`automations/workflow.ts`), an instance per run.
  It uses `step.do` with a name and a retry policy (limit, delay, backoff, timeout), `step.sleep`,
  `step.waitForEvent` with a timeout, and `NonRetryableError`. Outside it the code calls
  `createBatch` (an existing id is ignored, which is what makes a run start once), `get(id)`,
  `sendEvent` and `terminate`. `HelloWorkflow` is the stage 0 smoke test.
- **Files.** One bucket, `cos-blobs`, behind `BlobStore` (text: get, put, delete, list by prefix)
  and `MediaStore` (bytes with a type: put, get as a stream with its size, delete). Nothing is
  served by a signed link. Resizing is Cloudflare Images, and the code already runs without it.
- **Rate limits.** `RateLimitBinding` is `limit({ key })` returning `{ success }`
  (`packages/core/src/rate-limit.ts`). The app declares 18 in its `wrangler.jsonc` and the runner
  three, two of them the same counts as the app's. Each has a fixed limit and a period of 10 or
  60 seconds. They are approximate and per Cloudflare location.
- **Small Durable Objects.** `CodeModeGate` (one per user) holds one lease with an expiry: 28
  lines. `ExtensionWorkspace` is described under the model.
- **Key-value.** `OAUTH_KV` is the store of `@cloudflare/workers-oauth-provider` (clients,
  grants, hashed tokens), which wraps the app's fetch handler (`server/mcp/handler.ts`); its
  built file imports one thing from the runtime, `WorkerEntrypoint`. `ROUTES` is not the host's:
  it belongs to the stage 10 control plane (`products/crm/apps/control`).
- **Tests.** 52 of the app's 78 test files and 86 of the runner's 93 import `cloudflare:test` or
  `cloudflare:workers`. The end-to-end suite starts `vite dev` (`e2e/dev-server.mjs`), which runs
  both Workers and four development gatekeepers in the local Workers runtime.
- **Not anywhere:** a Node entry for the app or the runner, a queue, schedule or workflow that is
  not Cloudflare's, a Postgres or S3 client, a `docker compose` file.

## Decided by the owner (2026-11-26)

1. Two targets: Cloudflare as it is, and AWS as Node in containers on ECS with RDS Postgres and
   S3. Not the Workers runtime on AWS, and no third-party Workers-compatible runtime.
2. Workflows, queues and schedules are stored in Postgres, behind the platform's own interfaces.
3. Files are in S3.
4. A schema per client in one Postgres database; no table gains a client column.
5. On Postgres, a unit of work is one transaction holding one lock for its client.
6. The whole host is wanted on AWS, in stages. This is the stage the others stand on.

## The design in one page

```
      Cloudflare target                               AWS target (this stage: local only)
 app Worker ──binding──► runner Worker          web process ◄── same image ──► worker process
   fetch / queue / scheduled                      HTTP                 queues, schedules, workflows
          │                                          │   the runner's methods, called in process
          ▼                                          ▼
 ┌───────────────────────── the same code: operations, routes, automations ───────────────────┐
 └───────────────────────────────────── the target seam ──────────────────────────────────────┘
   D1 or ClientDb · R2 · Queues · cron        Postgres (stage 67) · S3 · pg-boss · the workflow
   Workflows · Rate Limiting · Durable         engine · tables for limits, leases, key-value and
   Objects · KV · Worker Loader                extension source · the sandbox (stage 69)
```

- **A target** is one object the entry builds: the ports below, plus settings and secrets. Stage
  66's client environment is built from it. Nothing above the entry knows which target it is on.
- **One image, two services.** `web` answers HTTP. `worker` consumes queues, runs schedules and
  runs workflows. Both hold the runner's code and call it as a function.
- **Queues and schedules use pg-boss. Workflows use a small engine of our own** on top of it.

## The model

### The target seam

A new package, `packages/platform`, holds the ports as plain TypeScript interfaces and imports
nothing from either runtime:

| Port | What it gives | Cloudflare | Node |
| --- | --- | --- | --- |
| Database | `CrmDb` for a client | D1 or `ClientDb` | Postgres (stage 67) |
| `BlobStore`, `MediaStore` | as today | R2 | S3 |
| Queues | send a batch, with a delay; register a consumer | Queues | pg-boss |
| Schedules | register a cron and its handler; a one-off wake-up at a time | cron triggers, alarms | pg-boss |
| Workflows | create, get, send an event, terminate; `step` | Workflows | the engine below |
| Rate limits | `RateLimitBinding` by name | the bindings | a table |
| Leases | acquire with an expiry, release | `CodeModeGate` | a row |
| Key-value | get, put with expiry, delete, list by prefix | KV | a table |
| Notices | tell every task something happened; listen | not needed (one object per name) | `NOTIFY` |
| Extension source | the workspace's methods | `ExtensionWorkspace` | tables (below) |
| Sandbox | run built modules with a host object | Worker Loader | stage 69 |
| Runner | `RunnerRpc` | the service binding | the same object, in process |
| Settings and secrets | named strings | `env` | the process environment |

- **The adapters move under the seam.** What `operations.ts`, `integrations.ts` and `media.ts`
  build from bindings today is built by the Cloudflare target, in a folder of each Worker that is
  the only place allowed to import `cloudflare:workers`. A lint rule enforces that, as stage 66's
  rule does for the ambient `env`. The runner's three direct uses of the bucket go through
  `BlobStore`.
- **The 14 files** that import the ambient `env` read the current request's environment, as stage
  66 makes them. On Node the entry sets it the same way (`AsyncLocalStorage`).
- **Stage 66's wrappers wrap the ports,** not the bindings, so keeping clients apart is written
  once for both targets.
- **Classes the runtime constructs stay Cloudflare's.** A Durable Object or Workflow class is a
  thin shell over a function that takes the target. The Node entry calls the same function.
- **Ports for later stages** (models, vectors, mail, the assistant's threads, connections, video)
  are declared by their own stages. Until then the Node target leaves them out, and the
  operations that need them answer "not configured", as they do today when a binding is missing.

### The database's call sites, sign-in and the caller's address

Stage 67 gives the Postgres handle and leaves the two Workers' use of it to this stage.

- **Every `createCrmDb(env.DB)`** in the app, the runner and `packages/auth` becomes the
  target's Database port for the current client. After stage 66 most already read the client's
  environment, so this is its `DB` member changing type from `D1Database` to the handle.
- **The 19 raw statements** in the three are rewritten on the query layer, so none is SQLite's.
- **Sign-in.** better-auth is given its Postgres adapter on Node, on stage 67's tables, with the
  same options otherwise. Sessions made on one target are not expected to work on the other.
- **The caller's address** comes from one function of the target: `cf-connecting-ip` on
  Cloudflare; on Node the address the load balancer forwards, trusted only from the balancer.
  Which header that is, and how many proxies to trust, is a setting stage 70 fills.

### One image, two services

- **Why not two servers with a network call between them.** The service binding exists because
  Workers have a size budget and the loader belongs to one Worker (ADR 0004). A Node process has
  neither constraint. Calling the runner as a function removes a hop, a second deploy and an
  internal door to secure. `gatekeeperFetch`'s `Request` and `Response` pass as they are.
- **Why not one process.** The minute tick, batch dispatch and workflow steps would share one
  thread with page requests, and every deploy would stop running jobs. `worker` is scaled and
  restarted apart from `web`.
- **Roles.** The entry takes `web`, `worker` or `all`. Local development and the tests use `all`.
- **The web process** serves the app's existing `fetch` handler through a standard adapter from
  Node's HTTP server to `Request` and `Response`. `waitUntil` becomes a set of promises the
  process waits for on `SIGTERM`. The assistant's socket path answers 404 until stage 72.
- **Building the app for Node.** The Vite config gains a second mode without the Cloudflare
  plugin, producing a Node server bundle; the runner's text modules (the SDK bundle, the checker,
  the shipped packs) are bundled as text, as `scripts/build.mjs` does today. How TanStack Start's
  Node output is produced and served has not been tried on this app: step 1 is that trial.
- **Shutdown.** On `SIGTERM` a process stops taking work, finishes what it holds for up to 30
  seconds and exits. Work cut off is retried by the queue or the engine.

### Queues and schedules

pg-boss, in the host's own schema, sharing the host's connection pool.

- **Why a library.** A job queue on Postgres is a solved problem with sharp edges (row claiming
  with `SKIP LOCKED`, expiry of a job whose process died, retry delays, dead letters, one firing
  of a cron across several processes). pg-boss is the common choice for Node and covers each.
- **What was checked.** The code's needs, listed under "What exists today", against pg-boss's
  documented features as known at writing: queues with a retry limit, delay and dead-letter
  queue; fetching a batch; delayed sends; cron schedules to the minute, fired once. It was not
  run. Step 4 pins a version and confirms each against it before anything is built on it.
- **The two queues keep their rules:** 100 a batch, 5 retries, a 10 second retry delay and a
  dead-letter queue for automation events; 10 a batch, 3 retries and 30 seconds for routine
  delivery. The consumer is handed a batch with `ack` and `retry` on each message and on the
  whole, so `queue()` in both Workers becomes a function both targets call.
- **A batch on Node is what is waiting,** up to the size, polled every second. Cloudflare's 5
  second batch window has no equivalent and needs none.
- **The outbox stays** on both targets (ADR 0171). Sending to pg-boss inside the change's own
  transaction would make it unnecessary on Postgres. That is not done here: one path is worth
  more than the saved row.
- **The three schedules** are registered from one list. The handler gets the tick's time, fans
  out one message per client (stage 66) and runs today's functions.
- **One-off wake-ups.** Besides repeating schedules, the port offers "call this handler for this
  client at this time, with this small payload": set, replace by key, cancel. It is what a
  Durable Object's alarm and the Agents SDK's `this.schedule(at, …)` give on Cloudflare, and what
  the assistant's idle alarm (stage [72](72-assistant-on-aws.md)) and a connection host's alarms
  (stage [73](73-connections-on-aws.md)) use. On Node it is a delayed pg-boss job with the client
  stamped on it and a key that makes a second set replace the first. It fires at least once, at
  or after its time, within the polling interval; a handler must tolerate a repeat. On
  Cloudflare the port is implemented by the object's own alarm, so the callers above are the
  same code. The workflow engine's sleeps use the same mechanism.
- **The routine delivery consumer** is wired and tested with a stand-in thread store. Real
  delivery waits for stage 72.

### Workflows

A small engine of our own, about three tables in the host's schema, driven by pg-boss jobs.

- **Why not a library.** `AutomationWorkflow` must keep one body on both targets, and that body
  is written against Cloudflare's model: `run` is replayed from the top, and each named step's
  result is stored and returned on replay. The established Postgres-backed choice, DBOS
  Transact, has its own model (its own registration of workflows and steps, and its own system
  tables), so the body would be written twice or wrapped until it no longer looked like either.
  Temporal, Restate and Inngest each add a server to run. The engine needed is small because
  the model is simple and only three primitives are used. **The alternative is DBOS Transact.**
- **The port** is the subset the code uses: `create` and `createBatch` with caller-chosen ids (an
  existing id is ignored), `get(id)` with `status`, `sendEvent` and `terminate`, and a `step`
  with `do(name, config, fn)`, `sleep(name, duration)` and `waitForEvent(name, { type, timeout })`.
  `AutomationWorkflow.run` is rewritten against the port's `step`. On Cloudflare the port's
  `step` is the runtime's.
- **The engine.** An instance row (id, class, params, status, result). A step row per instance
  and name (result, attempts, wake time). An event row per instance and type. A job runs an
  instance under a row lock: it replays `run`, returning stored results, until a step has to
  run, sleep or wait. A sleep or wait stores its wake time, ends the job and schedules the next.
  `sendEvent` stores the event and schedules a job. An event that arrives before its wait is
  kept for it. A step that fails is retried by its policy; a non-retryable error ends the run.
- **One suite proves both.** The port's tests (a step runs once, a retry, a sleep that outlives a
  restart, an event before and after the wait, a timeout, a duplicate id, terminate) run against
  Cloudflare Workflows in the local Workers runtime and against the engine on Postgres.

### Files

`BlobStore` and `MediaStore` on S3 with the AWS SDK: one bucket per deployment, keys as today,
credentials from the task's role, the region a setting. Deletes go 1,000 keys a call. No signed
links: media is served through the host as now. There is no resizer on Node in this stage, so
originals are served, as on a Cloudflare install without Images. Locally the bucket is MinIO.

### Rate limits

One table in the host's schema: limit name, key, window start, count. `limit()` is one upsert
that adds one and returns the count. The minute tick deletes old windows.

- **The limits are declared once,** in a list in `packages/core` (name, limit, period). A test
  fails when either `wrangler.jsonc` disagrees with it.
- **These counts are exact and host-wide,** where Cloudflare's are approximate and per location.
  A limit can therefore bite sooner on AWS. The numbers are not changed in this stage.
- **Cost.** Every limited request writes one row. Step 6 measures the busiest (media, 1,200 a
  minute per address). If it matters, flood-only limits move to a count per process; the
  alternative, a Redis, is a new piece of infrastructure and is not proposed.

### Leases, and what small Durable Objects become

A Durable Object gives two things: state kept by name, and one caller at a time. On Postgres
those are a row and a lock.

- **`CodeModeGate`** becomes the Leases port. On Node, `acquire` is one statement: insert the
  lease, or replace it if it has expired, and return the token or nothing. No lock is held
  between statements.
- **The others** follow the same rule in their own stages: `AgentJob` in stage
  [72](72-assistant-on-aws.md); `WebhookEndpoint`, `PaymentsEvents`, `TextEvents`,
  `IntegrationHost` and the gatekeepers' own objects in stage [73](73-connections-on-aws.md).
  Where one needs "one at a time", it takes a Postgres advisory lock for its name inside its
  transaction.

### Key-value

A table in the host's schema: key, value, expiry. A sweep deletes expired rows.

- **`OAUTH_KV`.** The same OAuth library runs on both targets, given an object with the methods
  of a key-value namespace it uses, over that table. Its one runtime import is satisfied by a
  small stand-in module in the Node build, for that dependency only. Running it on Node has not
  been tried; step 6 does, and if it fails the fallback is a second OAuth server for Node, which
  returns to the owner because it doubles a security surface.
- **`ROUTES`** is the control plane's. On AWS a hostname is resolved by the registry (stage
  [70](70-deploy-to-aws.md)).

### Notices between tasks

More than one Node task runs at once (two services, and each may have several tasks), so
something that happens in one task is sometimes wanted in another: a turn's events for a socket
another task holds (stage 72), a change on a screen people are watching (stage
[74](74-live-screens.md)). The Notices port is the one way to do that.

- **It is Postgres `LISTEN` and `NOTIFY`,** behind a helper in `packages/platform` (the port)
  with the Postgres implementation beside the Node target's other adapters: `notify(channel,
  payload)` and `listen(channel, handler)`. Channels are named per client by stage 66's wrapper.
- **A notice is a hint, never the data.** Postgres drops a notice nobody is listening for and
  limits its size (about 8,000 bytes), so the payload is an id or a sequence number, and the
  listener reads the truth from a table. Stages 72 and 74 each keep that table.
- **Each task holds one dedicated connection for listening,** outside the pool, re-opened and
  re-subscribed when it drops. After a reconnect a listener is told to catch up from its table.
  A pooler in transaction mode cannot carry `LISTEN`; stage 70 must give this connection a
  direct route to the database.
- **A notice sent inside a transaction is delivered when it commits,** which is the behaviour
  wanted: nobody is told of a change that was rolled back.
- **On Cloudflare the port is not needed** for those uses, since one object per name already
  holds every connection for it. Stage 74 says what it uses there.

### Extension source

`ExtensionWorkspace` today is one Durable Object holding an `@cloudflare/computer` workspace: a
filesystem and a git client on the object's storage, a repository per extension under
`/extensions/<id>/`. The same object's key-value storage holds what git does not: the source
hash of each commit, the last 200 builds by content hash, summaries of proposals, which packs
were ejected, a "changed since last commit" flag per extension, and the shipped packs' hashes.
Git mutations are run one at a time by a promise chain in the object.

What the host asks of it is narrower than git. It commits a whole set of files with a message
and an author. It lists versions newest first. It reads the files at a version. It keeps one
working copy per extension. There are no branches, merges or remotes; nothing clones it; diffs
are computed in `packages/core`. Everything above it treats a commit id as an opaque string
(`core_extensions`, run history, proposals, the sandbox's ids).

**The design: versions as rows, in the client's schema.**

| Table | Holds |
| --- | --- |
| Versions | extension, version id, parent, message, author, time, the files as path to content hash |
| File contents | content hash, text (shared between versions) |
| Working copy | extension, path, text; and per extension: changed, ejected |
| Builds, summaries | by content hash and by (version, base), capped as today |

- **A version id** is a hash of the parent, the file hashes, the message, the author and the
  time. Imported history keeps the ids it came with.
- **One writer per extension:** a commit runs in a transaction that locks the extension's row,
  which replaces the promise chain and holds across processes.
- **Why rows.** Extension source is the client's data. In the client's schema it is covered by
  the client's backup, export, move and erase with no extra work. It needs no volume to mount
  and no filesystem emulation, and "one writer" is a database lock.
- **What is given up.** It is not a git repository. On Cloudflare it is not one anyone can reach
  either: it lives inside a Durable Object. Eject and `extension.read` return files as they do
  now.
- **The alternative** is real git: the same library over a filesystem adapter backed by Postgres
  or S3, or bare repositories on a shared volume (EFS) with the `git` binary. It keeps git's own
  ids and format. It costs a filesystem to emulate or mount, locking across tasks, and a store
  that export and erase must each learn about.
- **Cloudflare keeps the Durable Object.** These tables exist only in the Postgres migration
  set. Moving Cloudflare onto rows is not proposed.

### The sandbox, in this stage

Every pack runs through the loader, so the host cannot install a pack without something to run
its code. This stage puts the loader's three uses (a reused worker by stable id, a throwaway
worker, the type checker) behind the Sandbox port and adds a **local sandbox**: a child process
on the developer's machine. It is not a security boundary, and the Node entry refuses to start
with it unless the process says it is development or a test. The real one is stage
[69](69-lambda-sandbox.md).

### Local development and tests

- **`docker compose`** starts Postgres and MinIO. `pnpm dev:node` applies stage 67's migrations
  and starts the host with the role `all` and the local sandbox. `pnpm dev` is unchanged.
- **The ports' suites run on both targets:** in the local Workers runtime against the Cloudflare
  adapters, and in Node against real Postgres and MinIO. No port is tested against a mock.
- **A test's environment comes from one helper** in place of `cloudflare:test`, which gives the
  target under test. The app's and the runner's suites move to it file by file. A file that
  tests a Cloudflare adapter or a class the runtime constructs stays on Workers only, with a line
  saying why. How many can move is not known until step 9 has moved the first twenty.
- **Seeding.** Tests that seed with raw statements are stage 67's concern; this stage uses what
  it provides.
- **End to end.** The Playwright suite gains a target setting. With it, the web server is the
  Node host on Postgres, with the fake payment, webhook, accounting and booking providers left
  out until stage 73, so specs that need them are skipped by tag on that target.

## Out of scope

- The real sandbox for pack and extension code: stage [69](69-lambda-sandbox.md).
- Deploying: the container image, the OpenTofu module, `cos deploy`, the registry, a schema per
  client, connection pooling, secrets from AWS's stores: stage [70](70-deploy-to-aws.md).
- Models, search by meaning and mail: stage [71](71-models-vectors-mail-on-aws.md).
- The assistant, its socket, `AgentJob`, voice: stage [72](72-assistant-on-aws.md).
- Connections and every gatekeeper, `IntegrationHost`, `gatekeeperFetch` beyond a 404: stage
  [73](73-connections-on-aws.md).
- Live screens: stage [74](74-live-screens.md).
- Video (Cloudflare Stream) and picture resizing on AWS.
- The stage 10 control plane.
- Any change to what a Cloudflare deployment does.

## Acceptance criteria

1. On Cloudflare nothing changes: every existing test passes, and a release's Workers have the
   same bindings as before.
2. No file outside the two Workers' Cloudflare folders imports `cloudflare:workers`, and lint
   fails on a new one. No raw SQL statement is left in the app, the runner or `packages/auth`.
3. `pnpm dev:node` on a clean machine with Docker gives a host where a person signs in, creates
   and edits records, uploads and views a picture, installs the shipped packs and calls a pack's
   tool.
4. A record change on the Node host starts its automation through the outbox, the queue and the
   workflow engine, and the run finishes. With the queue's table made unwritable, the minute tick
   delivers it.
5. An automation that sleeps, and one that waits for an approval, each survive the `worker`
   process being killed and restarted, and run each step once.
6. A message that fails its retries is in the dead-letter queue and nowhere else.
7. With two `worker` processes, each schedule fires once a tick; a one-off wake-up set for a
   client fires once at its time, a second set with the same key replaces the first, and a
   cancelled one does not fire. A notice sent by one process is received by the other, and a
   listener whose connection was cut catches up.
8. The workflow port's suite passes against Cloudflare Workflows and against the engine.
9. The suites for files, rate limits, leases, key-value and one-off wake-ups pass on both
   targets.
10. An MCP client completes OAuth against the Node host and calls an operation.
11. An extension is written, proposed, approved, rolled back and ejected on the Node host, and
    its versions list reads the same as on Cloudflare for the same steps.
12. The Node entry refuses to start with the local sandbox outside development and tests.
13. The suites of the app and the runner that moved to the helper pass on both targets in CI,
    and the list of files left on Workers only is in the pull request with a reason each.
14. The end-to-end run agreed in question 2 passes against the Node host in CI.
15. `docs/architecture.md`, `CONTEXT.md` and `CONTRIBUTING.md` say what is now true, and a new
    ADR records the seam, pg-boss, the engine and extension source as rows.

## Dependencies

Stage [67](67-postgres.md): the Postgres dialect, migrations (better-auth's tables among them),
the unit of work and the error mapper. Stage [66](66-one-host-many-clients.md) as built, for the client's environment.
New packages: pg-boss, a Postgres client if stage 67 has not added one, the AWS SDK's S3 client.

## Migrations and numbers

The build step that needs them claims a block in [`docs/parallel-work.md`](../parallel-work.md)
for the ADR and for the Postgres migrations. Two sets are added to, both stage 67's: the client
schema's (extension source) and the host schema's (the engine, limits, leases, key-value).
Notices need no table.
pg-boss creates and migrates its own tables in a schema of its own. No SQLite migration.

## Suggested build order

1. **Prove the app on Node.** Build the app without the Cloudflare plugin and serve one signed-in
   page and one operation from Node on stage 67's Postgres, with whatever stand-ins it takes.
   Record what had to be stubbed and every Workers-only API found above the seam. If TanStack
   Start cannot be built both ways from one source, stop and return to the owner.
2. **The seam.** `packages/platform`, the Cloudflare adapters moved under it, the lint rule.
   Criteria 1 and 2.
3. **The Node entries:** the HTTP server, the runner in process, roles, settings, shutdown; the
   database's call sites, the raw statements, sign-in and the caller's address.
4. **Queues, schedules, one-off wake-ups and notices:** pg-boss, after pinning and confirming
   it, and the `NOTIFY` helper. Criteria 6 and 7.
5. **The workflow port and engine;** `AutomationWorkflow` on the port. Criteria 4, 5 and 8.
6. **Files, rate limits, leases, key-value and MCP's OAuth.** Criteria 9 and 10.
7. **Extension source as rows.** Criterion 11.
8. **The Sandbox port and the local sandbox.** Criteria 3 and 12.
9. **Local development and the test helper;** the app's and runner's suites moved. Criterion 13.
10. **End to end against the Node host,** in CI. Criterion 14.
11. Docs and the ADR. Criterion 15.

Steps 4, 6, 7 and 8 can run side by side after step 3; step 5 follows step 4.

## Decided by this spec, open to override

- **One image, two services, the runner called in process.** No internal network door.
- **pg-boss for queues and schedules; our own engine for workflows.** DBOS Transact is the
  alternative for workflows.
- **The outbox stays on both targets.**
- **Rate limits in a Postgres table, exact and host-wide,** with the numbers unchanged.
- **The same OAuth library on both targets.**
- **Ports are declared in `packages/platform`;** only a Worker's Cloudflare folder may import the
  runtime.
- **Local files are MinIO, not a folder,** so the S3 code is what the tests run.
- **The Node version** is the one the repository's `engines` names (24 or later), not 22 as the
  interview said: the repository already refuses anything older.
- **No dashboard widget cache on Node** in this stage; `dashboards/cache.ts` already runs
  without one.

## Questions for the owner

1. **May extension source on AWS be rows in Postgres and not a git repository?** Git was the
   owner's choice in the stage 0 interview (ADR 0006). **Recommended: yes, rows.** Nothing reads
   it as git today, and rows put a client's extension source inside its backup, export and erase
   with no second store. Say no if a client or an auditor is to be handed a repository.
2. **How much of the end-to-end suite runs against the Node host on every pull request?** The
   suite takes four CI runners today; running all of it twice doubles that. **Recommended: a
   named set of journeys on every pull request (sign in, records, a pack's tool, an automation,
   files, MCP) and the whole suite nightly,** until AWS carries a live client, then all of it on
   every pull request.

## Status

Spec proposed (2026-11-26). No build step is built yet. Each build step changes its own line
here (CONTRIBUTING.md, Working in parallel).

- **Step 1** — not built — needs: stage 67 — Prove the app on Node

- **Step 2** — not built — needs: step 1 — The seam: `packages/platform`, the Cloudflare adapters under it, the lint rule

- **Step 3** — not built — needs: step 2 — The Node entries: HTTP server, the runner in process, roles, settings, shutdown; database call sites, sign-in, the caller's address

- **Step 4** — not built — needs: step 3 — Queues, schedules, one-off wake-ups and notices

- **Step 5** — not built — needs: step 4 — The workflow port and engine; `AutomationWorkflow` on the port

- **Step 6** — not built — needs: step 3 — Files, rate limits, leases, key-value and MCP's OAuth

- **Step 7** — not built — needs: step 3 — Extension source as rows

- **Step 8** — not built — needs: step 3 — The Sandbox port and the local sandbox

- **Step 9** — not built — needs: step 5, step 6, step 7, step 8 — Local development and the test helper; the app's and runner's suites moved

- **Step 10** — not built — needs: step 9 — End to end against the Node host, in CI

- **Step 11** — not built — needs: step 10 — Docs and the ADR
