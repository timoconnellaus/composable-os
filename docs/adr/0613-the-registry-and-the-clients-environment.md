# ADR 0613: The registry and the client's environment

Status: accepted, 2026-11-26 (stage 66 step 3, `feat/stage-66-registry`; revised the same day
after its independent review). Builds [ADR 0611](0611-one-host-a-database-per-client.md)'s
"the registry is the deploy-time setting, per client" and stage 66's "the client's environment".
Uses [ADR 0612](0612-clientdb-a-durable-object-behind-the-d1-interface.md)'s `clientDatabase`.
Amends stage 66's "Decided by this spec" on Worker Loader ids (below).

## Context
A host that serves many clients needs one list of its clients (the registry) and one way to turn
the Worker's real `env` into an `env` for one client, so that everything below an entry keeps
reading `env` as it does today. A single-client deployment (self-hosted, or a client in its own
account) must not change at all. Step 3 builds both, and wires no entry: deciding the client at
the app's and the runner's entries is step 4.

## Decision

### The registry
- **Its own D1 database, the `REGISTRY` binding,** with its own migrations in
  `packages/db/registry-migrations/` (beside the host's `packages/db/migrations/`), recorded in
  `registry_migrations` (`applyMigrations(db, list, { table: "registry_migrations" })`). Its
  numbers come from block AU (0790 first). The host's migrations never touch it and it never
  holds a client's records; `CORE_SCHEMA_VERSION` is the host's migrations' only.
- **Tables** (migration 0790): `registry_clients` (id, environment `live`/`staging`, status
  `active`/`paused`/`moving`, tier `standard`/`bespoke`, the repository that may deploy it,
  location hint, the schema version last seen), `registry_hostnames` (hostname, client, surface
  `staff`/`web`/`desk`, verified), `registry_settings` (client, env name, value),
  `registry_secrets` (client, name, AES-GCM ciphertext, 12-byte nonce, key id: the columns only,
  read by nothing until step 6) and `registry_meta` (the stamp).
- **A stamp that never recurs,** moved by triggers on every insert, update and delete of the four
  tables, so no writer can forget it: a counter plus a random nonce written with each change
  (`<n>:<nonce>`, `readRegistryStamp`). A host holding the registry in memory reads one row to
  know whether it is current. After a restore of the registry the counter can come back to a
  number it had, with other rows, but never with the same nonce, so an equal stamp always means
  equal rows.
- **Client ids** (`validateClientId`, `clientIdProblem` in `@composable-os/db/registry`): 3 to 30
  characters of lowercase letters, digits and single hyphens, starting with a letter and not
  ending with a hyphen; never a reserved word (`RESERVED_CLIENT_IDS`: the host's surfaces,
  environments and platform names, and the labels the fleet's own domain is likely to need:
  `admin`, `api`, `app`, `www`, `mail`, `status`, `docs`, `fleet`, `registry`, `callback`,
  `webhook`, `login`, `billing`, `media`, `files` and more; step 8 checks its labels against the
  list), never starting with `cos-` or `xn-`, and never ending with `-admin`, `-desk`, `-staff`,
  `-staging` or `-web` (the fleet's hostnames add those to an id, so `gym-a-admin` would claim
  gym-a's staff hostname). The shape is also a `CHECK` in the table.
- **Hostnames** are stored canonical and looked up exactly. `canonicalHostname` turns a hostname
  into that form or null: refused are any port (entries pass `new URL(request.url).hostname`),
  anything numeric-looking (a last label of digits, as in `127.0.0.1`, `127.1`, `0x7f.1`, or a
  single hex label), IPv6 literals, empty or over-long labels, characters outside `a-z0-9.-` and
  names over 253 characters. The table's `CHECK` holds most of this; what it cannot say (a label
  over 63 characters) the code refuses on read.
- **A row the code refuses is reported, not silently dropped.** `readRegistry` leaves out a
  client whose id `validateClientId` refuses, a setting not in `CLIENT_SETTINGS` and a hostname
  that is not canonical, and names each in `RegistrySnapshot.problems`. The directory logs them
  once per stamp; `cos` (step 7) shows them and validates before it writes.
- **Settings** are by env name, and `CLIENT_SETTINGS` lists the names a client may have:
  `APPROVAL_FLOOR`, `APPROVAL_EXPIRY_DAYS`, `IDENTITY_PROVIDER`, `AUTH_ALLOW_SIGNUP` and
  `COS_PACKS`, `AI_MODEL_ROLES`, `AI_PROVIDERS` (with no row, the deployment's own value:
  `inherit`), and `COS_ORG_EXTENSIONS`, `API_ALLOWED_ORIGINS` (the client's own or nothing:
  `empty`; another client's org extensions or origins can never be inherited).
- **Read in one batch, whatever the number of clients** (`readRegistry`): the stamp, every
  client, every setting and every hostname, four statements, no bound parameter, no compound
  SELECT, one transaction. D1's limits (100 bound parameters, 5 terms a compound SELECT, 1,000
  statements an invocation) hold with hundreds of clients; the test reads 400.
- **Only the operator writes it.** No operation, extension, tool or assistant can: it is exported
  as `@composable-os/db/registry`, never from `@composable-os/db`; packages/core and every pack
  never name it (`packages/core/test/registry-unreachable.test.ts`, a textual check of those two
  trees only); and no client's environment holds it. The remaining path is the real `env`, which
  on a many-client host holds `REGISTRY`: step 4 lands `AsyncLocalStorage` and the lint rule on the
  module-level `env` before any Worker binds it.
- **A client whose schema is behind:** `registry_clients.schema_version` is the version the
  operator's update last saw for the client's database, and `isSchemaBehind(client)` is true when
  it is lower than `CORE_SCHEMA_VERSION` or was never recorded. Ahead is not behind (an update
  migrates every client before it uploads the Workers, and the old code goes on serving). The host
  does not write the registry, so the update (step 7) records the version, and records it again
  after restoring a client to a bookmark.

### The client's environment
- **`@composable-os/db/client-environment`.** `hostMode(env)` is `single` with no `REGISTRY`,
  `many` with one; `REGISTRY` without `CLIENT_DB` is refused, never served from the one D1
  database. **`CLIENT_DB` is the binding of every client's databases:** a Durable Object
  namespace of `ClientDb`, which lives in a Worker of its own (`cos-client-db`, through the
  product's names; added by stage 66 step 2) and is bound by script name. Deploying a class's
  Worker restarts every live object of that class, so neither the app nor the runner exports
  `ClientDb` or lists it in its migrations; that Worker is deployed rarely.
- **Single-client:** `environmentFor(env, null)` and `clientForRequest(env, host)` answer
  `{ mode: "single", served: true, env }` with the real `env` itself: the same object, `DB` its
  D1 binding, nothing read, nothing frozen. Naming a client there is refused.
- **Many-client: refusal is the default.** The directory answers `served: true` with `env` only
  for a client of this deployment's environment that is `active` and whose schema is not behind,
  reached (by hostname) on a verified hostname. Every other answer is
  `{ served: false, refused, client }` with no `env` property at all, `refused` one of `unknown`
  (no such client, or one of the other environment), `unverified`, `paused`, `moving` (never
  served: writes during an export would be lost) and `schema-behind`. An entry cannot forget the
  check: without `served: true` it has no environment to run with. Step 4 answers each refusal as
  an unknown hostname's 404, except `schema-behind`, which gets the "being updated" page.
- **The deployment's environment comes from `env`:** `COS_HOST_ENVIRONMENT` (`live` or
  `staging`), required with `REGISTRY` (`hostEnvironment(env)` throws without it). It is the one
  source: `hostDirectory(env)` takes no options, so whichever entry asks first, every caller gets
  the same filter, and a staging client is never returned by a live deployment.
- **Building an environment is internal** (`src/client-environment-build.ts`, not in the
  package's exports): only the directory builds one, from a record it read and admitted.
  `buildClientEnvironment(env, { client, settings })` makes a new object shaped like `env` from
  what `envNameUse` lets through, and nothing else:
  - `DB` is `clientDatabase(CLIENT_DB, client.id)`, at the client's location hint;
  - each name in `CLIENT_SETTINGS` is the client's, else the deployment's (`inherit`) or absent
    (`empty`);
  - a `shared` name is the same value as in `env`; each says in `ENV_NAMES` why it reaches no
    client's part (the operator's ids and flags, Workers AI, Images, the gateway token, the
    gatekeepers' bindings, the support key whose grants name the hostname);
  - a `kept-apart` binding or credential is its wrapper's result, and is left out while it has no
    wrapper: files, OAuth's key-value, search, queues, Workflows, Durable Object namespaces, the
    runner, rate limits, and **the account's Stream token and signing key** (`STREAM_API_TOKEN`,
    `STREAM_SIGNING_JWK`, `STREAM_SIGNING_KEY_ID`), which can list, delete and sign any video of
    the account: in only through the video host's wrapper that stamps the client as `creator` and
    refuses another creator's video;
  - the host's own names (`REGISTRY`, `CLIENT_DB`, `COS_HOST_ENVIRONMENT`, `CLOUDFLARE_API_TOKEN`
    and `AI_SECRET_SCRIPTS`, `COS_UPDATE_TOKEN`, stage 10's tenant, control plane and customer
    gateway) are left out;
  - the client's secrets and addresses that step 6 fills in are left out;
  - any name the table does not list is left out.

  So everything fails closed: until a later step supplies a secret, an address or a wrapper, code
  that needs it fails for want of it, and never gets the host's or another client's.
- **AI Gateway's credentials.** `CLOUDFLARE_API_TOKEN` has AI Gateway Read (ADR 0151), which reads
  the gateway's logs and so every client's prompts: it is the host's, never a client's.
  `AI_GATEWAY_TOKEN` is generated with AI Gateway Run and Workers AI Read only
  (`packages/release/src/gateway.ts`): it sends requests and cannot read logs, so it is shared. A
  token the operator supplies instead is checked for Run but not for more: on a many-client host
  the deploy (step 7) must refuse a supplied token with AI Gateway Read. `AI_GATEWAY_REST` is a
  flag, not a credential. Spend through the shared gateway is told apart per client in step 10.
- **Frozen.** The environment, its `DB` and every wrapper's result are frozen: the object is shared
  by every request of the client in the isolate, so a write below an entry throws (modules are
  strict) and never reaches the client's next request. Shared values are the host's own objects
  and are not frozen; **any cache keyed by a shared object (a `WeakMap` on `env.LOADER`, `env.AI`,
  `env.IMAGES` or a `GATEKEEPER_*` binding) is one cache for every client**: step 5's list
  includes such caches.
- **The table is `ENV_NAMES` (`src/client-env-names.ts`), with three patterns** (`AI_KEY_*`,
  `GATEKEEPER_*`, `*_RATE_LIMIT`). `packages/db/test/client-env-names.test.ts` fails when a name is
  not in it that the app's or the runner's generated `Env`, `.dev.vars.example` or
  `deploy-inputs.json` declares, that their code reads (`env.NAME`, or through a `*_VAR`
  constant), or that the deploy engine sets on them (`packages/create-composable-os`,
  `packages/release`, `scripts`: `COS_PRODUCT_LABEL` is one, shared for now and made per client by
  step 5); and when the table lists a name none of them has.
- **A wrapper** is `BindingWrapper<B> = (binding: B, client: ClientId) => B`: it holds the real
  binding only in a closure or a `#private` field (no accessor, `raw`, `unwrap` or echo of its
  options), keeps every method that takes a key, name, id or prefix to the client's part, leaves
  out (never forwards) what it does not implement, and holds nothing of another client or of one
  request. The worked example is `keepRateLimitApart` (`<client>:<key>`; an id never holds `:`).
  **Each wrapper needs behavioural tests** (step 4's): through every method, with another
  client's key, name or id and with empty, `..` and over-long input, client A never reaches B.
- **What the property walk proves.** The test walks every own property and prototype of a
  client's environment, data and accessor alike (getters are called), and fails on any value that
  is `REGISTRY`, `CLIENT_DB`, the real `env` or the D1 binding, and on any function named like an
  escape hatch (`raw`, `unwrap`, `binding`, `target`, ...). It cannot see into closures, so it does
  not show what a method does with its arguments: that is the wrappers' behavioural tests.
- **The directory** (`ClientDirectory`, one per real `env` through `hostDirectory(env)`, a
  `WeakMap` keyed by that object) holds the whole registry in memory and reads the stamp at most
  every 10 seconds (`REGISTRY_REFRESH_MS`); only a changed stamp reads the registry again. A
  hostname is matched in memory, so an unknown hostname (an attacker's Host header) costs the
  registry nothing. Each served client's environment is built once per stamp and is the same
  object for every request until the registry changes, as auth's caches (keyed by the `env`
  object) need. Every cache in it is keyed by client id or exact hostname. It never shares a
  promise between requests (the Workers runtime refuses one request awaiting another's I/O). Each
  read takes a ticket, and a read that started before one already applied never replaces it, so a
  slow older read cannot bring back a removed client. (Ordering by the stamp's counter was not
  used: after a restore the counter goes back, and the isolate would then refuse the restored
  registry.)
- **Availability: a failed registry read stops every client.** When the stamp or the registry
  cannot be read, the call fails; the directory never serves the copy it holds. Deliberate: a
  stale copy would keep serving a client the operator has paused, moved or removed, or a hostname
  reassigned to another client, for as long as the registry is down. The cost is that one outage of
  the registry's D1 database stops every client of the deployment. The alternative, serving a copy
  at most a few minutes old on a read error, would keep clients up through a short outage and
  would let those operator changes lag by as much; it can be chosen later without changing the
  interface.
- **`clientOf(env)`** gives the client an environment was built for, or null for a single-client
  `env`.

### Worker Loader ids are per client (decided 2026-11-26, coordinator; open to the owner)
The spec's "Worker Loader ids are not per client" let one warm dynamic isolate run a shipped
pack's tools for every client (`toolWorkerId` is `ext:<id>:<commit>:…`, the same for every client
at one commit). `env: {}` and the per-run RPC target are right, but any module-level variable in
the pack's code survives between runs and so between clients, in isolates nobody audits for it.
**Isolation wins over cold starts: on a many-client host, the client is part of every tool worker
id.** This amends the spec's "Decided by this spec" list, open to the owner's override. Step 4,
which owns the loader call, builds it; `LOADER` stays a shared binding.

### What the entries will call (step 4)
`clientForRequest(env, hostname)` and `environmentFor(env, client)`, which answer
`RequestClient<E>` and `EnvironmentAdmission<E>` (`served: true` with `env`, or `served: false`
with `refused`); `hostDirectory(env).activeClients()` for a cron's fan-out (an active client may
still be refused as `schema-behind` when its message is handled); `isSchemaBehind(client)`; and
`BINDING_WRAPPERS` for the wrappers.

## Deferred
- **Step 4:** deciding the client at every entry, the answers to each refusal, `AsyncLocalStorage`
  for the module-level `env` and its lint rule, the wrappers of files, key-value, search, queues,
  Workflows, Durable Object namespaces, the runner and Stream, the client in the tool worker id,
  and the `REGISTRY`, `CLIENT_DB` and `COS_HOST_ENVIRONMENT` bindings in a many-client
  deployment's configuration.
- **Step 5:** the module-level caches below the entries, keyed by client, including caches keyed
  by a shared binding object and the product label.
- **Step 6:** derived auth secrets, given secrets decrypted from `registry_secrets`, and each
  address from the client's hostnames: filling in the names this ADR leaves out.
- **Step 7:** writing the registry (`cos client add` and the rest, validated with
  `validateClientId` and `canonicalHostname`, each change in one batch), applying its migrations
  on deploy, recording `schema_version`, refusing a supplied gateway token with AI Gateway Read,
  and the deployment table the spec lists. Whether a subset of packs set in `COS_PACKS` must be
  checked against the product's packs is decided where it is written.

## Consequences
- **A single-client deployment is unchanged:** no Worker binds `REGISTRY` or `CLIENT_DB`, no entry
  calls the new code, and every existing test runs on D1 as before.
- **Adding a binding, var or secret to the app or the runner now needs a line in `ENV_NAMES`,**
  saying what it is for a client; without one it is not in any client's environment, and a test
  says so.
- **An operator's change reaches a running isolate within 10 seconds; a registry outage stops
  every client.**
- **Stage 10's tenant tag and Settings → AI's key writing are not available to a client** on a
  many-client host; per-client AI keys are step 6's.
