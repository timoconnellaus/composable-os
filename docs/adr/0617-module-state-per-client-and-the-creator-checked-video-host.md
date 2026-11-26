# ADR 0617: Module-level state per client, and the creator-checked video host

Status: accepted, 2026-11-27 (stage 66 step 5, `feat/stage-66-caches-video`). Builds stage 66's
"Module-level caches" and "Stream" sections and criterion 5, on
[ADR 0613](0613-the-registry-and-the-clients-environment.md)'s client's environment and
[ADR 0615](0615-every-entry-decides-the-client.md)'s entries.

## Context
A Worker isolate serves many requests, after each other and side by side. On a host that serves
many clients they are different clients' requests, and whatever a module keeps at its top level
(the extension schema core loaded, the plan it read, an answer it memoised, a notice it sent, an
embedding drain in flight) is there for the next request, whoever's that is. Step 4 made every
entry decide the client and hand its code that client's environment; it left what modules keep
between requests to this step, and the video host unset on a many-client host, because one Stream
token reaches every client's videos.

Most of what core keeps is read with no handle to say whose it is: `getObject(name)` is called
everywhere, synchronously, after the pipeline's `refreshSchemaRegistry(db)`. Two clients'
requests interleaving at an `await` would read each other's schema. Passing a client to every
such call would touch most of core.

## Decision

### The client scope
`packages/core/src/client-scope.ts`. A **client scope** is the database a client's requests reach
(one object per client and isolate: the client's environment's `DB`, or a single client's D1
binding) and the client's id. It is held by an `AsyncLocalStorage`, which follows the code through
every `await`, callback and `waitUntil` it starts.

- **Given once, at load, by the host Worker** (`provideClientScope`): the app's
  `server/request-env.ts` and the runner's `client-scope.ts`, only when the deployment serves many
  clients. Core never imports `node:async_hooks` (it is bundled into the browser too), and
  `client-scope.ts` imports nothing.
- **Set at every entry** once it has decided the client: the app's `runInClientEnv` (every fetch,
  cron tick, queue batch, routine delivery and the client-app door, as step 4 placed it), the
  runner's `callAs`, its fan-out ticks and parked and stamped queue batches, and its automation
  Workflow (`inClientScope`).
- **Set by `invoke`** for an operation called where no scope is held (a Durable Object's own call,
  a test): the scope of its handle's database (`databaseOf`, `@composable-os/db`, which maps every
  handle made by `createCrmDb` or `createDb`, and the read-only twin, to the binding it was made
  over). Inside a scope `invoke` adds nothing.
- **Code outside every scope is refused** on a many-client host (`NoClientScopeError`): it has no
  client to answer for, so it gets nothing rather than another client's.
- **A single-client deployment gives no store.** Every value is one module-level value, read and
  written as before; no scope is made or read. This is the whole of its change.

What core keeps between requests is a `clientState(make)`: one value per scope's database, held
weakly (an environment the registry replaced takes its values with it), or one value with no store.
Converted: the extension schema registry (`extensions/schema.ts`, with the objects in
`fields/index.ts` and the declared unique keys in `errors.ts`), the entitlements, the plan on sale,
the dashboards' and Today's schema names, the query embedding cache, Today's failed items, and the
rate-limits-down notice to a client's admins (the pipeline).

### Caches outside the isolate
The Workers Cache API is the zone's, so every client of a host shares it. The widget cache key
(`widgetCacheKey`: dashboards, Today's pack items and Today's takings) gains the scope's client id,
and code whose scope names no client (an operation in a Durable Object's own call) uses no shared
cache at all. A single client's keys are as they were. Public content was already keyed by a
random epoch in the client's own database. Settings → AI's usage cache needs the account's API
token, which a client's environment never holds.

### Keyed elsewhere
Outside core a cache is keyed by the client's environment object (each client's is one frozen
object per isolate), with one slot for a single client so nothing changes there: the shipped
extensions' install per isolate (`ensureShippedExtensions`, which installed only the first
client's), a client's own extensions read from its files (by environment, then content hash), the
in-memory vector stand-in, the no-visitor notice; the embedding drain is one per client's database.
The MCP OAuth helpers, the HTTP surfaces and auth were already keyed by environment.

### The inventory and the tripwire
`scripts/check-module-state.mjs` (in `pnpm lint`) parses with TypeScript every source file the
host's Workers load (the app, the runner, the packs, the packages bundled into them, and every
gatekeeper, whose Workers serve every client's connections) and finds its module-level state: a
`let` or `var`; a `const` made with `new` of a keeping kind or of any class but a few that keep
nothing; a `const` Map, Set, array, object or typed array the file changes; a static field that is
not `readonly`. Each must be on `scripts/module-state.mjs` with a decision (`client`,
`independent` or `call`) and its reason; one that is not, or an entry whose state is gone, fails.
A value made by a call (`clientState(...)`, a memo helper), a closure's own variables and a change
made from another file are not seen: those are review's, and the two-client tests'.

### The two-client tests
- `packages/core/test/client-scope.test.ts`: a test per cache, two clients' databases in one
  isolate, their calls interleaved, and the refusal outside a scope.
- `COS_TEST_DB=two-clients pnpm --filter @composable-os/core test:two-clients`: the whole core
  suite, unchanged, as one client, with a second client (`test/other-client.ts`: its own D1
  database, an extension, a plan and a person of its own) taking its turn in its own scope before
  and after every test. Its turn fills every converted cache with its own and checks it reads only
  its own records; around it the suite's client must see none of its schema.
- `apps/app/test-two-clients/caches.test.ts`: through the app's real entries, one client with an
  extension the other lacks, their requests side by side.

### The creator-checked video host
One Stream account and one token hold every client's videos. `creatorCheckedVideoHost(shared,
client)` (`records/stream.ts`) is that account as one client's:

- every upload (basic: `creator` in the body; resumable: `Upload-Creator`) and every copy is
  stamped with the client as its creator;
- every call that names a video (its details, securing it, its captions, deleting it) first reads
  its details and is refused with the one not-found unless Stream says this client created it
  (none, or another, is refused);
- a playback token is signed only for a video this host has seen to be its client's: the first
  token for a video costs one details call per isolate, the rest none (`CHECKED_VIDEOS_MAX`, 1,000
  remembered, the oldest forgotten first). The memory is the host object's, and there is one host
  object per client environment, so it is that client's.

The app's entry module sets a resolver (`setVideoHostResolver`) that builds each client's host from
the operator's own Stream credentials in the host's env (a client's environment never holds them)
and the client's own addresses, once per client environment. A single-client deployment sets its
one host as before, with no creator and no check.

## Consequences
- A many-client host's module-level state is its clients' own, by construction for everything
  converted, and by the tripwire's list for everything else.
- Code a many-client host runs outside every scope fails loudly rather than silently sharing.
  What is not yet scoped: a Durable Object's own code outside an operation in the runner (the
  integration host, the workspace, the code-mode gate) and the app's agent objects outside
  `runInClientEnv`; their operations are scoped by `invoke`, but a direct read of a converted
  cache from such code is refused. Wrapping each object's calls in its client's scope belongs with
  the object base class of the hardening after #512 (#515, PR #520), once it lands.
- Video calls on a many-client host cost one more Stream call each (the details check), and the
  first playback token per video per isolate one more.
- The product label stays the deployment's: every client of a host is the same product
  (`COS_PRODUCT_LABEL` is `SHARED`).
- The whole core suite in its two-client mode is a script, not a CI job: it doubles core's time.
