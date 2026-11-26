# ADR 0615: Every entry decides the client, and the shared bindings are kept apart

Status: accepted, 2026-11-26; revised 2026-11-27 after its security review (stage 66 step 4,
`feat/stage-66-entries`, on step 3 as merged). Builds on [ADR 0613](0613-the-registry-and-the-clients-environment.md)
(the registry, the client's environment, the directory's admissions) and
[ADR 0612](0612-clientdb-a-durable-object-behind-the-d1-interface.md) (`clientDatabase`).

## Context
Step 3 made the client's environment and wired no entry. On a host that serves many clients
every place where code starts running must decide which client it runs for before anything else,
then run as before on that client's environment; and every shared binding a client's environment
holds must reach that client's part only: by what the code can hold, not by its authors' care
(where that is not so, "What remains convention" below says where). A single-client
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
| app | the deployment's callback address (`COS_CALLBACK_HOSTNAME`), before any client | No client: only `/gatekeeper/<vendor>/*`, to the runner's `gatekeeperCallback` (a shared gatekeeper's own `fetch`, whose state says whose connection); `isCallbackHostname` and `isCallbackRequest` are step 6's (packages/db `callbacks.ts`) | Any other path: the plain 404 |
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
*Amended 2026-11-27 (#515): parked messages now have their own queue and a ledger per client; see
"Hardening" below.* A routine delivery or automation event for a client paused, moving or behind is parked, not
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
`REGISTRY`, `CLIENT_DB_QUERIES`, `COS_HOST_ENVIRONMENT`, `CLIENT_FANOUT`, `COS_BINDING_KEY` (a long random
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

**What remains convention** (amended 2026-11-27, #515): what the code can hold is enforced as
above; these are kept by review alone.
- Code in the allowed files (`request-env.ts`, `deployment-env.ts`, the entry modules and the
  entries' classes, which decide the client from the real env; the integration host, which mints
  with `ctx.exports`; the fake gatekeeper) holds the real env or `ctx.exports` and is trusted to
  use them only as written.
- Dependencies are not scanned: the Agents SDK imports `exports` from `cloudflare:workers` itself
  (sub-agents, `parentAgent`), which the host never calls. Since #515 it is handed the client's
  environment, never the real one.
- The lint parses the Workers' own code. Code it cannot read (a dependency, a string evaluated at
  run time, which the Workers runtime refuses anyway) is not checked.
- The proofs are as strong as the keys' secrecy: the operator holds `COS_BINDING_KEY` and
  `COS_PROPS_KEY` (step 7 stores them as Worker secrets, never in the registry); see "Hardening"
  for rotation and a leak.

### The clients' databases: the query-only service (step 2)
The app and the runner reach a client's database only through `cos-client-db`'s query-only
entrypoint, bound as `CLIENT_DB_QUERIES` (service `cos-client-db`, entrypoint `ClientDbQueries`):
`openClientDatabase` (`client-environment-build.ts`) is `clientDatabaseService(env.CLIENT_DB_QUERIES,
client.id, { locationHint })`, and `hostMode` requires `REGISTRY` and `CLIENT_DB_QUERIES`. The raw
`CLIENT_DB` namespace, with the operator's methods (restore, migrate, bookmarks, export), is the
operator's (step 7): no Worker of the host binds it, and the lint refuses its name in their code.
The two-client suites bind the service as production will; only their operator stand-in
(`testing/two-clients.ts`, `migrate`) holds the namespace, as `OPERATOR_CLIENT_DB`, and apps/runner's
suite checks that the Worker holds no `CLIENT_DB`.

### Secrets and addresses until step 6
*Amended 2026-11-27: step 6 (#513) has merged; see "With step 6" below.* Before it, a client's
environment had none of the names step 3 marked `per-client`. A place that needs one
fails with a message naming step 6 (`perClientMissing`, `requirePerClient`): Better Auth and
customer and practitioner sign-in, the calendar feeds (which keyed with `""` when the secret was
missing), the integration host's public origin, the staff invite's link (from the client's
`APP_ORIGIN`, never the request's), and OAuth and `/mcp` (whose issuer and resource are the
client's `MCP_RESOURCE`, never the request's: every OAuth path and `/mcp` answer 503 until then).
Nothing falls back to the deployment's value or to the request's address. The deployment's
callback address is routed before any client (`isCallbackRequest`).

**With step 6 (#513, merged):** its derived and given secrets and its addresses fill these names
(a client whose registry rows give none still gets the message, now naming ADR 0616); its
`isCallbackHostname` and `isCallbackRequest` route the callback address in `entry.ts`; OAuth and
`/mcp` answer with the client's own `MCP_RESOURCE`. On a many-client host:
- only `__Host-` cookie names are sessions wherever the host reads cookie names (`isSessionCookie`
  in packages/auth: the API's one-hat check, the bound door, the desk, and the typed client's
  `customerCookies`), so an unprefixed `cos-customer.*` a sibling hostname plants on the parent
  domain is neither a session nor a second hat (tested: without the rule the staff request is
  refused as carrying two sessions);
- the fake gatekeeper (`INTEGRATIONS_FAKE_PROVIDER`, `GATEKEEPER_FAKE`) is refused at the runner's
  entry as well as by the directory (`refuseFakeGatekeeper`); the runner's two-client suite runs
  on the committed wrangler config with that binding and var removed
  (`manyClientWranglerConfig`).

### Where a credential of one client is refused at another's address (criterion 4)
Every credential is a row of the client's own database or a key of its own part of OAUTH_KV, so at
another client's address it is simply unknown:
- staff and customer device tokens (the native apps', API tokens, `cos content import`'s):
  `core_device_session`, resolved in the request's client's database (tested);
- MCP: the OAuth library's clients, grants and tokens under the client's KV prefix (tested in
  packages/db), and the connected app's row in its database: a connection made by consent and
  code exchange at A is refused at B, its refresh token too, and every key stored is under A's
  prefix (tested);
- staff (Better Auth) and customer browser sessions, signed in at A: at B the same answer as no
  cookie (tested); practitioner sessions are signed with a key derived from the client's
  customer secret and resolve in its database, as customer ones do (not driven end to end here);
- native sign-in's handoff code: issued in A's database, refused at B's exchange (tested);
- a customer's calendar feed address: 200 at A, the feed's one 404 at B (tested);
- support access: a token for A's address is refused at B for its audience (tested).

### Hardening after the second review of #512 (#515, 2026-11-27)
*Amended 2026-11-27.* The second security review listed five findings and some minor ones; each
is closed here, with a test that fails when the fix is taken out.

- **S1, cos-client-db's callers.** `ClientDbQueries` answers only a binding whose props are a host
  Worker's (`{ caller: "cos-app" | "cos-runner", proof }`, `clientDbCallerProps`, set by the deploy
  engine), and only a call whose target carries the host's proof of its client
  (`{ client, proof }`, `PROOF.clientDb`). The directory makes that proof when it builds the
  client's environment; the client's `DB` holds it in its closure. cos-client-db holds the props key
  as its own secret. The lint refuses `CLIENT_DB_QUERIES` and cos-client-db's modules in the
  Workers' code, as it refuses `CLIENT_DB`. Tested in apps/client-db (no props, another caller, a
  copied name, another key's proof; a call with no proof, another client's, another purpose's).
- **S2, a Durable Object's `env`.** Every object class of the app and the runner extends
  `ClientDurableObject(Base)`: on a many-client host its base class (`DurableObject`, the Agents
  SDK's `Agent` under the voice mixin) is constructed with a read-only view of the client's
  environment (`clientEnvView`), never the real `env`, which stays in the `ClientObject`'s private
  field. So `this.env`, and everything the SDK keeps of it, is the client's from the first line of
  the object's code. `ClientObject.proof` signs for the object's own client and generation only.
  The namespace wrappers hold a namer for one client (`clientObjectNamer`), never the host's `env`
  or a key. The lint parses each file with TypeScript (it no longer matches patterns) and also
  refuses: an object class not on `ClientDurableObject(...)`, `this.env` (plain, by key or by
  `Reflect.get`) in a class that is neither an entry nor a client's object, an import by a
  computed specifier, `require`, and a whole import of an env module. Tested in apps/runner's
  suite: inside gym-a's integration host, `this.env` has none of the host's names and its
  namespaces are gym-a's; the lint's own tests show each evasion the review named caught.
  What the Agents SDK still needs: nothing of the real `env` (it is handed the view); it still
  imports `exports` from `cloudflare:workers` itself, for sub-agents and `parentAgent`, which the
  host never calls.
- **S3, a reused client id.** The registry keeps every removed id (`registry_removed_clients`,
  registry migration 0794) and refuses a client added with one, and a client's id never changes.
  Proofs also bind the client's secret generation: an object's name, `ClientApp`'s props and the
  integration host's minted props; an object checks its name against the generation the registry
  has now, so a name made for an earlier client of the id opens nothing. A parked message carries
  the generation it was parked under and is given up if the client's differs.
- **S4, two keys.** `COS_BINDING_KEY` names objects only and is never rotated in place: an object's
  storage is found by its name, so a new key names new, empty objects. `COS_PROPS_KEY` signs every
  props proof and every call on cos-client-db; it rotates (`COS_PROPS_KEY_PREVIOUS` is accepted,
  never used to sign, until every binding has been redeployed with props under the new key).
  **If a key leaks:** the props key is rotated at once (new key, old as previous, redeploy the
  bindings' props, then drop the previous); the object key is defence in depth behind the
  namespaces no client's code can reach (S2), so its leak alone opens nothing, and it is replaced
  only with a planned move of every client's objects to names under a new key (step 7's
  operator command), never by editing the secret.
- **S5, parking apart.** Parked messages go to each Worker's own parking queue
  (`CLIENT_PARKING`: `cos-app-parking`, `cos-runner-parking`), never the crons' fan-out queue, and
  a ledger per client (`ParkingLedger`, a Durable Object of the host's own,
  `CLIENT_PARKING_LEDGER`) counts them: past `PARKING.maxPerClient` (1,000) a client's oldest are
  given up, each reported as a dead letter and counted (`givenUpTotal`). The ledger also drops a
  second delivery of a message already handled or held by another delivery. The deploy engine
  binds the queue, its consumer (`FANOUT_CONSUMER`'s settings) and the ledger's class and migration
  on a fleet deployment (step 7); the committed `wrangler.jsonc` does not.
- **Minor.** A parked message that fails is retried as its own queue would retry it (5 times for
  cos-automation-events, 3 for cos-routine-delivery, 10 s apart), then given up as its dead letter
  would be. Order: a parked backlog comes back in roughly the order it was parked; no consumer
  depends on order (queues never promised it: routine deliveries are each a whole message into a
  thread, and each automation event is matched against the automations on its own). `refreshOnEachCall`
  checks every method, its own, inherited from the host's classes and mixins, and the runtime's
  entry points even when a framework base defines them; it no longer guesses a method's kind from
  how it was written (a fresh admission runs a sync method at once; otherwise the admission is
  read first and the call answers with a promise; calls the object makes to itself inside a call
  are not checked again). It still does not stop a turn already running when the client is
  paused: the turn ends on its own, and the next event is refused. The MCP providers are kept
  per environment and origin, at most 16 origins (`OAUTH_ORIGINS_KEPT`), least recently used
  dropped first.

### What is accepted
- The memory fix of M6 reads the latest `active_since` and writes in two statements: two writes to
  one person's memory in the same millisecond with a fold between them can leave the second edit
  out of the thread's tail until the next fold. Nothing is lost (the line is in the table and in
  every later fold's block); `activeSinceNow` says so.

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
  with its creator check; step 7, the fleet's bindings at deploy, the fan-out queues'
  consumer settings, and the clients' org extensions written under their prefix
  (`clients/<client>/org-extensions/<hash>.json`); step 8, desk and web hostnames, and the
  standard web app's hostname-passing form of ClientApp.
