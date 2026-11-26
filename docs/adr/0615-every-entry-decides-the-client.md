# ADR 0615: Every entry decides the client, and the shared bindings are kept apart

Status: accepted, 2026-11-26 (stage 66 step 4, `feat/stage-66-entries`, stacked on step 3's
`feat/stage-66-registry`). Builds on [ADR 0613](0613-the-registry-and-the-clients-environment.md)
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
| app | `queue`: `cos-routine-delivery`, and the fan-out queue | A routine delivery: the stamp the runner's ROUTINE_DELIVERY wrapper put beside it. A tick: its `client` | No stamp, or a client not served: retried (to the dead-letter queue), never acted on. A tick for a client no longer served: dropped |
| app | `ClientApp` (`bound.ts`), the door a client's web app binds to | The `client` in the binding's props, set by the deploy when it uploads the web app (step 8). Never a hostname or header the web app sends | No client in the props, or one not known: 404; not served: "being updated" |
| app | `AssistantAgent` (Durable Object) | Its own name, `<client>:user:<id>`, given by the ASSISTANT wrapper (`ClientObject`). Re-read on each socket message and each turn | A name with no client, or a client the registry does not serve: every event refused |
| app | `AgentJob` (Durable Object) | Its name, `<client>:job:<id>` | As above |
| runner | RPC from the app (26 methods) | `callAs(<client>, <method>, args)`: the client its own argument, from the app's RUNNER wrapper. The runner trusts it because only the host's Workers are bound to it (`workers_dev` off, no route). The methods on the runner itself refuse | Not one of `RUNNER_METHODS`, or a client not served |
| runner | `fetch` | None: it answers 404, as before | Always |
| runner | `scheduled` | The registry: the fan-out, as the app's | As the app's |
| runner | `queue`: `cos-automation-events`, and the fan-out queue | The stamp of the sender's AUTOMATION_EVENTS wrapper; a tick's `client` | As the app's |
| runner | Workflows `AutomationWorkflow`, `HelloWorkflow` | The instance id `<client>_<id>` and the stamped params `{ cosClient, params }`, which must agree (`workflowRun`), read again on every invocation of `run()` | Either missing, or they disagree |
| runner | Durable Objects `ExtensionWorkspace` (one per client: `<client>:workspace`), `CodeModeGate`, `IntegrationHost` | Their names, as the app's objects | As the app's objects |
| runner | `ConnectCallback`, `HostHookInitiator` (minted for gatekeepers) | The `client` the IntegrationHost put in the props when it minted them; a gatekeeper cannot change props | No client in the props |
| runner | `PaymentSink`, `TextSink`, `WebhookSink`, `RunHost` (RPC targets handed to gatekeepers and dynamic Workers) | Made with the client's environment by the object or executor that hands them out: a capability, nothing to decide | n/a |
| runner | The fake gatekeeper (`FakeGatekeeperVendor`, `FakeUser`, `FakeVerifier`, `FakeHookController`, `FakeAccount`, `FakeProvider`, `FakeGatekeeper`) | A gatekeeper, not a client: the runner's own `env`, as any gatekeeper Worker has its own. Development and e2e only (`INTEGRATIONS_FAKE_PROVIDER`, never on in a fleet) | n/a |
| gatekeepers | Their own Workers | Unchanged: a connection's state is reached only through the account stub the client's IntegrationHost holds (a capability); callbacks come back through the props above | n/a |

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
  `<client>:<name>`; `get` opens only an id a wrapper made for the same client; `idFromString` and
  `newUniqueId` are refused, `jurisdiction()` is left out. Inside the object `this.env` is the
  real `env`: each class makes a `ClientObject` from its own `ctx.id.name`, which holds every
  event until the client's environment is read and refuses a name with no served client.
- **The runner (RUNNER):** exactly the methods of `RUNNER_METHODS`, each `callAs(<client>,
  <method>, args)`; no `fetch`, no `connect`, nothing forwarded by name. apps/runner's suite fails
  when the runner has a method the list lacks.
- **Rate limits:** step 3's (`<client>:<key>`).
- **Gatekeepers (`GATEKEEPER_*`):** shared, as step 3 classed them, and not wrapped: nothing a
  gatekeeper binding offers is reached by a name or id (it mints accounts; existing ones are
  stubs held in the client's IntegrationHost), and callbacks carry the client in props.
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
alone (`consumeFanOut`). A slow or failing client holds up nobody else; the queue's consumer
settings bound the work per invocation. Each Worker has its own fan-out queue (`cos-app-fanout`,
`cos-runner-fanout`), produced and consumed by itself.

### What a many-client deployment binds, and where it comes from
`REGISTRY`, `CLIENT_DB`, `COS_HOST_ENVIRONMENT` and `CLIENT_FANOUT` are added by the deploy engine
for a fleet deployment (step 7) and never to the committed `wrangler.jsonc`, which self-hosted
installs use. The suites that run as a many-client host have their own vitest configurations
(`apps/app/vitest.two-client.config.ts`, `apps/runner/vitest.two-client.config.ts`).

### The module-level `env`, and `CLIENT_DB`
`scripts/check-module-env.mjs` (in `pnpm lint`) fails when a file of `apps/app/src` or
`apps/runner/src` imports the module-level `env` of `cloudflare:workers`, except
`src/server/request-env.ts` (the app) and `src/deployment-env.ts` (the runner), which read it only
at load (the product's label, the packs named, the staff codes, the video host). It also fails
when any of them names `CLIENT_DB` or `ClientDb`: the app and the runner reach a client's database
only as its environment's `DB` (`clientDatabase`, in packages/db), so `CLIENT_DB` can become a
service binding to `cos-client-db`'s query-only entrypoint (step 2) without touching them. Today
`CLIENT_DB` is touched only by `packages/db/src/client-environment.ts` (`hostMode`),
`client-environment-build.ts` (`clientDatabase(CLIENT_DB, client)`) and the test helpers
`packages/db/testing/use-client-db.ts`, `testing/two-clients.ts` (which migrates the clients'
databases, standing in for step 7) and `testing/vitest.ts`.

### Secrets and addresses until step 6
A client's environment has none of the names step 3 marked `per-client`. A place that needs one
fails with a message naming step 6 (`perClientMissing`, `requirePerClient`): Better Auth and
customer and practitioner sign-in, the calendar feeds (which keyed with `""` when the secret was
missing), and the integration host's public origin. Nothing falls back to the deployment's value.

### Where a credential of one client is refused at another's address (criterion 4)
Every credential is a row of the client's own database or a key of its own part of OAUTH_KV, so at
another client's address it is simply unknown:
- staff and customer device tokens (the native apps', API tokens, `cos content import`'s):
  `core_device_session`, resolved in the request's client's database (tested);
- MCP: the OAuth library's clients, grants and tokens under the client's KV prefix, and the
  connected app's row in its database (tested: a client registered at A is unknown at B, and a
  bearer token is refused there);
- staff (Better Auth), customer and practitioner sessions, native sign-in's handoff, the calendar
  feeds' tokens and support access: their rows are the client's, and their signing keys are the
  client's own secrets (step 6). Today they are refused for want of the secret, with the message
  naming step 6; their cross-client test waits for step 6.

## Consequences
- A single-client deployment is unchanged: one constant check at each entry; every existing test
  passes on D1.
- Adding an entry, a queue, a Workflow or a Durable Object class to the app or the runner now
  means deciding its client here; adding a kept-apart binding needs a wrapper (a test says so).
- A client's paused, moving or behind state refuses its objects' events and its queue messages
  too, not only its requests.
- Deferred: step 5, the module-level caches (the product label, the Stream host, the MCP
  providers by origin, the bound door's no-visitor notice, the widget caches) and the video host
  with its creator check; step 6, secrets and addresses, and with them the browser sessions' and
  MCP consent's cross-client tests; step 7, the fleet's bindings at deploy, the fan-out queues'
  consumer settings, and the clients' org extensions written under their prefix
  (`clients/<client>/org-extensions/<hash>.json`); step 8, desk and web hostnames, and the
  standard web app's hostname-passing form of ClientApp.
