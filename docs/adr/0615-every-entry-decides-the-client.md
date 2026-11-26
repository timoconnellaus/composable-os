# ADR 0615: Every entry decides the client, and the shared bindings are kept apart

Status: accepted, 2026-11-26; revised 2026-11-27 after its security review (stage 66 step 4,
`feat/stage-66-entries`, on step 3 as merged). Builds on [ADR 0613](0613-the-registry-and-the-clients-environment.md)
(the registry, the client's environment, the directory's admissions) and
[ADR 0612](0612-clientdb-a-durable-object-behind-the-d1-interface.md) (`clientDatabase`).

## Context
Step 3 made the client's environment and wired no entry. On a host that serves many clients
every place where code starts running must decide which client it runs for before anything else,
then run as before on that client's environment; and every shared binding a client's environment
holds must reach that client's part only, by construction, not by convention. A single-client
deployment (no `REGISTRY`) must not change.

## Decision

### The entries, and what decides the client at each
Every entry calls `servesManyClients(env)` (one constant check: `REGISTRY` bound). Single-client:
the code that ran before, on the real `env`. Many-client: the entry decides, or refuses. The
helpers are `@composable-os/db/client-entries`.

| Worker | Entry | What decides the client | Refused when |
| --- | --- | --- | --- |
| app | `fetch` (`src/server/entry.ts`, `hostFetch`): the desk origin, support, the assistant socket, agreement PDFs, media, the staff and customer feeds, `/api/v1`, the form page, customer and practitioner sign-in, native staff sign-in, OAuth and `/mcp`, then TanStack Start | The URL's hostname among the registry's verified `staff` hostnames (`decideRequest`) | Unknown, unverified, another environment's, or a `web` or `desk` hostname: one plain 404 before any other code. Paused, moving, schema behind: "being updated" (503, the same words for each) |
| app | TanStack Start's code that reads no `env` of its own: the request middleware (`start.ts`), `call-operation.ts`, `session.public.ts`, `system.ts`, the routes `api/auth/$`, `api/health`, `api/assistant/*`, `gatekeeper/$`, and `routine-agents.ts` | The environment the entry decided, held for the request (and its `waitUntil`) by AsyncLocalStorage: `requestEnv()` (`src/server/request-env.ts`) | Outside an entry that decided one: throws, never the host's `env` |
| app | `scheduled` | The registry: one message per client served to the Worker's fan-out queue (`fanOutCron`) | A client not served now gets no message |
| app | the deployment's callback address (`COS_CALLBACK_HOSTNAME`), before any client | No client: only `/gatekeeper/<vendor>/*`, to the runner's `gatekeeperCallback` (a shared gatekeeper's own `fetch`, whose state says whose connection); `isCallbackRequest` is step 6's stand-in | Any other path: the plain 404 |
| app | `queue`: `cos-routine-delivery`, the fan-out queue, the dead-letter queues | By `batch.queue`. A routine delivery: the stamp the runner's ROUTINE_DELIVERY wrapper put beside it. A tick, or a parked message, on the fan-out queue: its `client` or its stamp | No stamp, or an unknown client: retried, never acted on, to the dead-letter queue, which is reported. A client paused, moving or behind: parked (below), never retried. A tick for a client no longer served: dropped |
| app | `ClientApp` (`bound.ts`), the door a client's web app binds to | The `client` in the binding's props with the host's proof (`clientAppProps`), set by the deploy when it uploads the web app (step 8). Never a hostname or header the web app sends | No client, no or a wrong proof, or a client not known: 404; not served: "being updated" |
| app | `AssistantAgent` (Durable Object): its RPC, `fetch`, the Agents SDK's `onConnect`, `onMessage`, `onClose`, `onError`, `onRequest`, its schedule alarm (`onIdleAlarm`) and the wake from hibernation | Its own name, `<client>:<proof>:<name>`, given by the ASSISTANT wrapper and checked against the host's key (`ClientObject`) when the object is built; its admission read again before every async method it defines (`refreshOnEachCall`) | A name with no client or no valid proof, or a client the registry does not serve: the event refused |
| app | `AgentJob` (Durable Object): its RPC and its alarm | As the assistant's | As above |
| app | Work started with `waitUntil` | The request's: the AsyncLocalStorage store carries over (the runner passes `env` explicitly) | As the request |
| app, runner | Module code at import (`server.ts`: the product label, the staff codes for the module `env`, the video host; the runner: the label, the packs named) | The deployment's own env (`deploymentEnv`), read once; the video host is not set on a many-client host | n/a |
| app, runner | `exports`, `ctx.exports` | Not an entry: the way to every namespace raw and to mint any entrypoint. What they reach checks the host's proof (names, props); the lint keeps them out of code (below) | A name or props without the host's proof |
| runner | RPC from the app (26 methods) | `callAs(<client>, <method>, args)`: the client its own argument, from the app's RUNNER wrapper, accepted only with the props the deploy fixes on the app's binding (`runnerCallerProps`: `caller` and the host's proof). The methods on the runner itself refuse | No such props, not one of `RUNNER_METHODS`, or a client not served |
| runner | `gatekeeperCallback` | No client (as the callback address) | Without the app's props, or a gatekeeper kept apart |
| runner | `fetch` | None: it answers 404, as before | Always |
| runner | `scheduled` | The registry: the fan-out, as the app's | As the app's |
| runner | `queue`: `cos-automation-events`, and the fan-out queue | The stamp of the sender's AUTOMATION_EVENTS wrapper; a tick's `client` | As the app's |
| runner | Workflows `AutomationWorkflow`, `HelloWorkflow` | The instance id `<client>_<id>` and the stamped params `{ cosClient, params }`, which must agree (`workflowRun`), read again on every invocation of `run()` | Either missing, or they disagree |
| runner | Durable Objects `ExtensionWorkspace` (one per client), `CodeModeGate`, `IntegrationHost`: their RPC and alarms | Their names, as the app's objects, read again before every async method | As the app's objects |
| runner | `ConnectCallback`, `HostHookInitiator` (minted for gatekeepers) | The `client` and the host's proof of it and the connection, put in the props by the IntegrationHost (`ClientObject.proof`); a gatekeeper cannot change props | No client, or no valid proof |
| runner | `PaymentSink`, `TextSink`, `WebhookSink`, `HostQueue`, `RunHost` (RPC targets handed to gatekeepers and dynamic Workers) | Made with the client's environment by the object or executor that hands them out: a capability, nothing to decide | n/a |
| runner | Dynamic Workers: tool, manifest and producer Workers (`LOADER.get`), Code Mode's (`LOADER.load`), the type checker's | Loaded by an executor made with the client's environment; their ids are `client:<client>:<id>` (Code Mode's are new each run); the checker is shared, our code handed source per call | n/a |
| runner | The fake gatekeeper (`FakeGatekeeperVendor`, `FakeUser`, `FakeVerifier`, `FakeHookController`, `FakeAccount`, `FakeProvider`, `FakeGatekeeper`) | A gatekeeper, not a client: the runner's own `env`, as any gatekeeper Worker has its own. Development and e2e only (`INTEGRATIONS_FAKE_PROVIDER`, never on in a fleet) | n/a |
| gatekeepers | Their own Workers, their `fetch` (reached through `/gatekeeper/$` and the callback address) and their state | Those offered: a connection's account is a stub the client's IntegrationHost holds (a capability), each account in its own object; callbacks come back through the props above. Those whose state or credentials are the whole deployment's are offered to no client (below) | n/a |

### The wrappers (`@composable-os/db/client-bindings`, registered in `BINDING_WRAPPERS`)
Each holds the real binding only in a closure, has no accessor, `raw`, `unwrap` or forwarding
`Proxy`, offers only the methods it implements, refuses (throws) what it cannot keep to the
client's part, and has a behavioural test in which client A tries B's key, name or id through
every method (`packages/db/test/client-bindings.test.ts`). The builder freezes each result.

- **Files (BLOBS):** every key `clients/<client>/<key>` (`clientKey`). A key is never empty,
  absolute, with a `.` or `..` segment, a backslash or a NUL. `get`, `head`, `put`, `delete` (one
  or many), `createMultipartUpload`, `resumeMultipartUpload` and `list` all prefix; `list` forces
  its prefix under the client's part (`""` lists the part, nothing above), prefixes `startAfter`,
  strips the prefix from every key and delimited prefix, drops anything outside the part, and ties
  its cursor to the client (`<client>~<cursor>`: another's is refused, and even a forged one lists
  only the client's part). Returned objects are views with the client's own key, not proxies.
- **Key-value (OAUTH_KV):** the same prefix, on `get` (one or many), `getWithMetadata`, `put`,
  `delete` and `list` (prefix forced, keys stripped, cursor tied). The OAuth library builds its
  own keys and lists by prefix through this wrapper, so its clients, grants and tokens are the
  client's. The library writes its helpers onto the `env` it is handed; a client's environment is
  frozen, so the app makes them over the client's own OAUTH_KV and hands the library a frozen copy
  with them (`withOAuthHelpers`).
- **Search (VECTORIZE):** the client's id is the namespace of every vector written (`insert`,
  `upsert`, overriding any given) and of every query (`query`, `queryById`); ids are
  `c:<sha-256 of client and id>` (Vectorize ids are one space for the index and 64 bytes at most),
  so `getByIds` and `deleteByIds` never name another's vector; the caller's id travels in the
  metadata (`cos_vector_id`) and is what it gets back; a match or vector outside the namespace is
  dropped. Queries read metadata `all` (topK at most 50, as core already asks). `describe()`
  (the whole index's counts) is refused.
- **Queues (AUTOMATION_EVENTS, ROUTINE_DELIVERY):** every message is sent as
  `{ cosClient, body }`; a body shaped like a stamp is only a body, stamped again. Only `v8` and
  `json` content. `metrics()` is refused. The consumer reads the stamp (`stampOf`) before any code
  runs, hands each client's share to the consumer's code as a batch of its own, and acks or
  retries per message (`consumeByClient`): one client's failure retries its messages only.
- **Workflows (AUTOMATION_WORKFLOW, HELLO_WORKFLOW):** every instance id is `<client>_<id>` (an id
  left out is made), on `create`, `createBatch` (array or `instances`; by count refused), `get`
  and `deleteBatch`; never "already prefixed, pass through": `gym-b_x` from A is `gym-a_gym-b_x`.
  Params go as `{ cosClient, params }`. Returned instances carry the caller's id.
- **Durable Object namespaces (ASSISTANT, AGENT_JOB, EXTENSION_WORKSPACE, CODE_MODE_GATE,
  INTEGRATION_HOST, FAKE_ACCOUNT, FAKE_PROVIDER):** `idFromName` and `getByName` name
  `<client>:<proof>:<name>` (the proof the host's HMAC of the client and the name, under
  `COS_BINDING_KEY`, held in the wrapper's closure); `get` opens only an id a wrapper made for the
  same client; `idFromString` and
  `newUniqueId` are refused, `jurisdiction()` is left out. Inside the object `this.env` is the
  real `env`: each class makes a `ClientObject` from its own `ctx.id.name`, which holds every
  event until the client's environment is read and refuses a name with no served client.
- **The runner (RUNNER):** exactly the methods of `RUNNER_METHODS`, each `callAs(<client>,
  <method>, args)`; no `fetch`, no `connect`, nothing forwarded by name. apps/runner's suite fails
  when the runner has a method the list lacks.
- **Rate limits:** step 3's (`<client>:<key>`).
- **Gatekeepers (`GATEKEEPER_*`), by their state** (review of #512, B1). `ENV_NAMES` is the one
  list, read by the environment builder and by `availableVendors` and the integration host
  (`gatekeeperOffered`), with step 6's pattern so the two merge cleanly:
  - **Kept apart, no wrapper, offered to no client** ("not available on this host yet"):
    payments (one Stripe key, whose payout reads cover the whole account, and one events object
    per provider with one hook, so one client's hook replaces another's), text (one events object
    for the deployment, one hook), webhook (endpoint ids chosen by the user, one object each for
    the deployment), email receiving (one mailbox object per local part for the deployment),
    email sending (the deployment's sender domains).
  - **Shared:** Google (accounts by unique id; Gmail and Chat hook drivers are keyed by mailbox
    or space but hold one registration per account, each with its own tokens, so two clients on
    one mailbox each see it with their own authorisation), Microsoft (accounts by unique id; hook
    drivers by account and mailbox), Slack, Slack posting, MCP and ZoomInfo (accounts by unique id,
    connect links by that id and a nonce; the OAuth app is the operator's), web search (no state;
    public results; the operator's Web Search binding, its cost not split by client).
  - The fakes (`fake`, `accounting-fake`, `booking-system-fake`) are development and test only.
- **Stream (`STREAM_API_TOKEN`, `STREAM_SIGNING_JWK`, `STREAM_SIGNING_KEY_ID`):** kept apart by
  step 3 and left without a wrapper here: absent from every client's environment, and on a
  many-client host the app sets no video host at all, so video is "not configured" for every
  client until step 5 builds the host that stamps each upload with its client and refuses other
  creators.

### Worker Loader ids per client
The coordinator amended "Worker Loader ids are not per client": on a many-client host every id
the executor loads (tool, manifest and producer workers) is `client:<client>:<id>`, so a pack's
warm isolate and its module-level state are never shared between clients. Single-client ids are
unchanged. Code Mode loads a fresh worker each run; the type checker stays shared (our code,
handed source per call).

### The crons fan out through a queue
A many-client host's `scheduled` sends one `{ cosFanOut, client, cron, scheduledTime }` per client
served to `CLIENT_FANOUT`, 100 a `sendBatch` (a call per hundred clients), and does no client's
work; the Worker's `queue` runs each tick in its client's environment and acks or retries it
alone (`consumeFanOut`), one message at a time whatever the batch, and the deploy engine sets the
fan-out consumer to a batch of one (`FANOUT_CONSUMER`: `max_batch_size` 1, `max_batch_timeout` 1,
`max_retries` 3), so one client's tick never shares an invocation's limits with another's. Each
Worker has its own fan-out queue (`cos-app-fanout`, `cos-runner-fanout`, `FANOUT_QUEUES`),
produced and consumed by itself, and recognised by `batch.queue`.

### A client not served for a while: its messages wait
A routine delivery or automation event for a client paused, moving or behind is parked, not
retried: re-sent to the Worker's fan-out queue as `{ cosParked, queue, stamped, parkedAt,
delaySeconds }` and the original acked, so a pause never uses up `max_retries` (3 for
cos-routine-delivery, 5 for cos-automation-events, 10 s apart: 30 to 50 s, which every update's
pause outlasts). It comes back after 1 minute, then 2, 4, 8 and every 15 minutes (`PARKING`); when
the client is served again its queue's consumer handles it as a batch of one; after 7 days it is
given up. A message given up, and every message of a dead-letter queue (each Worker consumes its
queues' `-dlq` on a fleet deployment, step 7), is reported as a log line
`{"event":"cos.queue.dead_letter","queue","client","message","why"}` for the operator's alerts.
Tested with a 10-minute pause (apps/runner's suite).

### What a many-client deployment binds, and where it comes from
`REGISTRY`, `CLIENT_DB`, `COS_HOST_ENVIRONMENT`, `CLIENT_FANOUT`, `COS_BINDING_KEY` (a long random
secret of the operator's) and `COS_CALLBACK_HOSTNAME` are added by the deploy engine for a fleet
deployment (step 7) and never to the committed `wrangler.jsonc`, which self-hosted installs use;
so are the props of the app's binding to the runner (`runnerCallerProps(key)`) and, at each web
app's upload (step 8), the props of its binding to `ClientApp` (`clientAppProps(key, client)`).
The suites that run as a many-client host have their own vitest configurations
(`apps/app/vitest.two-client.config.ts`, `apps/runner/vitest.two-client.config.ts`).

### Proofs on names and props, and who may mint them (review of #512, S1, S4)
Anything the host hands a client by a name or by props carries the host's proof: an HMAC-SHA256
under `COS_BINDING_KEY` (`@composable-os/db/client-proofs`, synchronous, checked against
WebCrypto), one purpose each so a proof of one is never another's. A Durable Object's name is
`<client>:<proof>:<name>` and the object checks it when it is built; `ClientApp`'s props are
`{ client, proof }`; the integration host's minted callbacks carry a proof of the client and the
connection (`ClientObject.proof`, made with the object's real env); the app's binding to the
runner carries `{ caller: "cos-app", proof }`, and `callAs` and `gatekeeperCallback` refuse
without it. The key is the host's: in no client's environment, held by a wrapper only in its
closure. So code below an entry that reaches `exports`, `ctx.exports` or a raw namespace cannot
mint a name or props the receiving side accepts as another client's: a two-client test mints
`ClientApp` for gym-b through `exports` (404) and opens gym-b's assistant object through the raw
namespace (refused), and the runner's suite forges each kind.

Any Worker of the fleet's account can bind cos-runner or ClientApp, but a binding's props are set
by whoever uploads it, never by its code, and a proof needs the key. **Step 8 must hold to this:**
uploads into the `cos-clients` namespace are made only by the operator's code (never with a token a
client's repository holds), and a namespace Worker's one binding is `HOST`, to `ClientApp`, with its
client and proof fixed.

`scripts/check-module-env.mjs` (in `pnpm lint`) scans `apps/app/src`, `apps/runner/src`, the packs
and every package bundled into the two Workers (packages/core, auth, sdk, product, the agent
packages and the rest it lists), and fails when a file outside its allow-list imports `env` or
`exports` from `cloudflare:workers` (an alias, a namespace import, a re-export, a dynamic import
with a string or template literal), uses `ctx.exports` (allowed: the integration host and the fake
gatekeeper), imports `deploymentEnv` (allowed: `server.ts`, the runner's `index.ts` and the two
modules that define it), or names `CLIENT_DB` or `ClientDb`.

**What remains convention**, by construction nowhere else:
- Code in the allowed files (`request-env.ts`, `deployment-env.ts`, the entry modules, the
  integration host, the fake gatekeeper) holds the real env or `ctx.exports` and is trusted to use
  them only as written; review is what keeps it so.
- Dependencies are not scanned: the Agents SDK uses `exports` and its own `this.env` (the real env)
  inside `AssistantAgent` (its routing, sub-agents and MCP client, none of which the host uses).
- A DO's `this.env` is the real env until its `ClientObject` adopts the client's; code in a class
  that reads `this.env` before that, or keeps a reference to it, would hold the host's.
- The proofs are as strong as the key's secrecy: the operator holds `COS_BINDING_KEY` (step 7
  stores it as a Worker secret, never in the registry) and rotating it renames every object.

### `CLIENT_DB`, and step 2's query-only service
Today `CLIENT_DB` is touched only by `packages/db/src/client-environment.ts` (`hostMode`),
`client-environment-build.ts` (`openClientDatabase`) and the test helpers
`packages/db/testing/use-client-db.ts`, `testing/two-clients.ts` (which migrates the clients'
databases, standing in for step 7) and `testing/vitest.ts`. When #511 lands (the binding
`CLIENT_DB_QUERIES`, service `cos-client-db`, entrypoint `ClientDbQueries`), the switch is two
lines: `openClientDatabase`'s `return clientDatabase(namespace, client.id, hint);` becomes
`return clientDatabaseService(env.CLIENT_DB_QUERIES, client.id, hint);`, and `hostMode`'s
`if (!bindings.CLIENT_DB) {` becomes `if (!bindings.CLIENT_DB_QUERIES) {`, with the binding's
type in `HostBindings` and a `host` line in `ENV_NAMES`; the raw namespace is then the operator's
only. The tests stay on the namespace until then.

### Secrets and addresses until step 6
A client's environment has none of the names step 3 marked `per-client`. A place that needs one
fails with a message naming step 6 (`perClientMissing`, `requirePerClient`): Better Auth and
customer and practitioner sign-in, the calendar feeds (which keyed with `""` when the secret was
missing), the integration host's public origin, the staff invite's link (from the client's
`APP_ORIGIN`, never the request's), and OAuth and `/mcp` (whose issuer and resource are the
client's `MCP_RESOURCE`, never the request's: every OAuth path and `/mcp` answer 503 until then).
Nothing falls back to the deployment's value or to the request's address. The deployment's
callback address is routed before any client (`isCallbackRequest`).

**When step 6 (#513) merges:** its derived and given secrets and its addresses fill these names,
and its `#admit` is async (the directory's callers here already await it); its
`isCallbackRequest` and `COS_CALLBACK_HOSTNAME` replace this step's stand-in in `client-entries.ts`
(the same name, so the call in `entry.ts` stays); the MCP refusal and the invite's address then
answer with the client's own `MCP_RESOURCE` and `APP_ORIGIN`; the two-client suites set each
client's secrets and drive the browser sessions', native handoff's and MCP's cross-client tests;
`ConnectCallback`'s props already carry the client and its proof.

### Where a credential of one client is refused at another's address (criterion 4)
Every credential is a row of the client's own database or a key of its own part of OAUTH_KV, so at
another client's address it is simply unknown:
- staff and customer device tokens (the native apps', API tokens, `cos content import`'s):
  `core_device_session`, resolved in the request's client's database (tested);
- MCP: the OAuth library's clients, grants and tokens under the client's KV prefix (tested in
  packages/db), and the connected app's row in its database; until step 6 OAuth and `/mcp` are
  refused at every client's address (tested), and the cross-client exchange is step 6's test;
- staff (Better Auth), customer and practitioner sessions, native sign-in's handoff, the calendar
  feeds' tokens and support access: their rows are the client's, and their signing keys are the
  client's own secrets (step 6). Today they are refused for want of the secret, with the message
  naming step 6; their cross-client test waits for step 6.

### Other fixes from the review of #512
- The MCP OAuth providers are cached by client and origin, so a hostname the registry gives
  another client never keeps the first one's token lifetime or resource (M4).
- A memory line made active in the same millisecond as a fold was counted as folded and its edit
  lost from the tail; every write that makes a line active now takes its `active_since` strictly
  after the latest (packages/core `operations/memory.ts`, `activeSinceNow`), with a test that
  forces one clock (M6).
## Consequences
- A single-client deployment is unchanged: one constant check at each entry; every existing test
  passes on D1.
- Adding an entry, a queue, a Workflow or a Durable Object class to the app or the runner now
  means deciding its client here; adding a kept-apart binding needs a wrapper (a test says so).
- A client's paused, moving or behind state refuses its objects' events (each async method of
  each object class reads the admission first: `refreshOnEachCall`; a stub of an object reset by
  a refusal stays broken, and a new one reaches it once the client is served) and parks its
  queue messages, not only its requests.
- Deferred: step 5, the module-level caches (the product label, the Stream host, the bound
  door's no-visitor notice, the widget caches) and the video host
  with its creator check; step 6, secrets and addresses, and with them the browser sessions' and
  MCP consent's cross-client tests; step 7, the fleet's bindings at deploy, the fan-out queues'
  consumer settings, and the clients' org extensions written under their prefix
  (`clients/<client>/org-extensions/<hash>.json`); step 8, desk and web hostnames, and the
  standard web app's hostname-passing form of ClientApp.
