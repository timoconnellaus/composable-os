# ADR 0613: The registry and the client's environment

Status: accepted, 2026-11-26 (stage 66 step 3, built on `feat/stage-66-registry`, stacked on step
1's `feat/stage-66-client-db`). Builds [ADR 0611](0611-one-host-a-database-per-client.md)'s
"the registry is the deploy-time setting, per client" and stage 66's "the client's environment".
Uses [ADR 0612](0612-clientdb-a-durable-object-behind-the-d1-interface.md)'s `clientDatabase`.

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
  read by nothing until step 6) and `registry_meta` (the version stamp).
- **A version stamp moved by triggers** on every insert, update and delete of the four tables,
  so no writer can forget it. A host holding the registry in memory reads one row to know whether
  it is current.
- **Client ids** (`validateClientId`, `clientIdProblem` in `@composable-os/db/registry`): 3 to 30
  characters of lowercase letters, digits and single hyphens, starting with a letter and not
  ending with a hyphen; never a reserved word (the host's surfaces, environments and platform
  names: `admin`, `www`, `api`, `registry`, `staging`, ...), never starting with `cos-` or `xn-`,
  and never ending with `-admin`, `-desk`, `-staff`, `-staging` or `-web` (the fleet's hostnames
  add those to an id, so `gym-a-admin` would claim gym-a's staff hostname). The shape is also a
  `CHECK` in the table; the reserved words are code's, and a row the code refuses is never read.
- **Hostnames** are stored canonical (lowercase ASCII labels, no port, no trailing dot; checked in
  the table) and looked up exactly. `canonicalHostname` turns a Host header into that form or
  null: a dotted quad, a bracketed or bare IPv6 literal, an empty or over-long label, any
  character outside `a-z0-9.-`, or more than 253 characters is null. A client is never derived
  from a hostname and never found by a suffix; only a verified hostname reaches a client.
- **Settings** are by env name, and `CLIENT_SETTINGS` lists the names a client may have:
  `APPROVAL_FLOOR`, `APPROVAL_EXPIRY_DAYS`, `IDENTITY_PROVIDER`, `AUTH_ALLOW_SIGNUP` and
  `COS_PACKS`, `AI_MODEL_ROLES`, `AI_PROVIDERS` (with no row, the deployment's own value:
  `inherit`), and `COS_ORG_EXTENSIONS`, `API_ALLOWED_ORIGINS` (the client's own or nothing:
  `empty`; another client's org extensions or origins can never be inherited). A row with a name
  not on the list is never read.
- **Read in one batch, whatever the number of clients** (`readRegistry`): the stamp, every
  client, every setting and every verified hostname, four statements, no bound parameter, no
  compound SELECT, one transaction. D1's limits (100 bound parameters, 5 terms a compound SELECT,
  1,000 statements an invocation) hold with hundreds of clients; the test reads 400.
- **Only the operator writes it.** No operation, extension, tool or assistant can: it is exported
  as `@composable-os/db/registry`, never from `@composable-os/db`; packages/core and every pack
  never name it (`packages/core/test/registry-unreachable.test.ts`); and no client's environment
  holds it.
- **A client whose schema is behind:** `registry_clients.schema_version` is the version the
  operator's update last saw for the client's database, and `isSchemaBehind(client)` is true when
  it is lower than `CORE_SCHEMA_VERSION` or was never recorded. Ahead is not behind (an update
  migrates every client before it uploads the Workers, and the old code goes on serving). The
  host does not write the registry, so the update (step 7) records the version; the refusal with a
  "being updated" page is at the entries (step 4).

### The client's environment
- **`@composable-os/db/client-environment`.** `hostMode(env)` is `single` with no `REGISTRY`,
  `many` with one; `REGISTRY` without `CLIENT_DB` is refused, never served from the one D1
  database. **`CLIENT_DB` is the binding of every client's databases:** a Durable Object
  namespace of `ClientDb`, which lives in a Worker of its own (`cos-client-db`, through the
  product's names; added by stage 66 step 2) and is bound by script name. Deploying a class's
  Worker restarts every live object of that class, so neither the app nor the runner exports
  `ClientDb` or lists it in its migrations; that Worker is deployed rarely. With no registry, `environmentFor(env, null)` and `clientForRequest(env, host)` give
  the real `env` itself: the same object, `DB` its D1 binding, nothing read. Naming a client on a
  single-client deployment is refused.
- **`buildClientEnvironment(env, { client, settings })`** builds a new object shaped like `env`
  from what `envNameUse` lets through, and nothing else:
  - `DB` is `clientDatabase(CLIENT_DB, client.id)`, at the client's location hint;
  - each name in `CLIENT_SETTINGS` is the client's, else the deployment's (`inherit`) or absent
    (`empty`);
  - a `shared` name (the operator's own: Worker Loader, Workers AI, the gateways, Stream's account
    and token, release vars, the gatekeepers' bindings) is the same value as in `env`;
  - a `kept-apart` binding (files, OAuth's key-value, search, queues, Workflows, Durable Object
    namespaces, the runner, rate limits) is its wrapper's result, and is left out while it has no
    wrapper;
  - the host's own names (`REGISTRY`, `CLIENT_DB`, `CLOUDFLARE_API_TOKEN` and
    `AI_SECRET_SCRIPTS`, with which Settings → AI writes the deployment's Worker secrets for every
    client at once, `COS_UPDATE_TOKEN`, stage 10's `COS_TENANT_ID` and control plane) are left out;
  - the client's secrets and addresses that step 6 fills in (`BETTER_AUTH_SECRET`,
    `CUSTOMER_AUTH_SECRET`, `DESK_SECRET`, Google and Access sign-in, `AI_KEY_*`, the judge's key,
    Turnstile's keys; `BETTER_AUTH_URL`, `CUSTOMER_AUTH_URL`, `APP_ORIGIN`, `MCP_RESOURCE`,
    `DESK_HOSTNAME`, `NATIVE_REDIRECT_URIS`, `STREAM_ALLOWED_ORIGINS`) are left out;
  - any name the table does not list is left out.

  So everything fails closed: until a later step supplies a secret, an address or a wrapper, code
  that needs it fails for want of it, and never gets the host's or another client's. Nothing in
  the result leads to the registry, to `CLIENT_DB`, to the real `env` or to the D1 binding (a test
  walks every property and prototype).
- **The table is `ENV_NAMES` (`src/client-env-names.ts`), with three patterns** (`AI_KEY_*`,
  `GATEKEEPER_*`, `*_RATE_LIMIT`). `packages/db/test/client-env-names.test.ts` fails when a name
  the app's or the runner's generated `Env`, `.dev.vars.example`, `deploy-inputs.json` or code
  (`env.NAME`) has is not in it, and when the table lists a name none of them has.
- **A wrapper** is `BindingWrapper<B> = (binding: B, client: ClientId) => B`: a binding of the
  same shape that reaches only the client's part, holds nothing of another client or of one
  request, never hands the real binding out, and refuses what it cannot keep to the client's part.
  The worked example is `keepRateLimitApart` (the client in every key, `<client>:<key>`; an id
  never holds `:`), registered in `BINDING_WRAPPERS`. The others are step 4's, with the entries
  that need them.
- **The directory** (`ClientDirectory`, one per real `env` through `hostDirectory(env)`, a
  `WeakMap` keyed by that object) holds the whole registry in memory and reads the stamp at most
  every 10 seconds (`REGISTRY_REFRESH_MS`); only a changed stamp reads the registry again. A
  hostname is matched in memory, so an unknown hostname (an attacker's Host header) costs the
  registry nothing. Each client's environment is built once per stamp and is the same object for
  every request until the registry changes, as auth's caches (keyed by the `env` object) need;
  a changed stamp rebuilds every one. Every cache in it is keyed by client id or exact hostname.
  It never shares a promise between requests (the Workers runtime refuses one request awaiting
  another's I/O), so two requests arriving together each read the stamp. An optional
  `environment` limits it to the deployment's own environment.
- **`clientOf(env)`** gives the client an environment was built for (a `WeakMap` keyed by the
  environment object), or null for a single-client `env`.

### What the entries will call (step 4)
`clientForRequest(env, hostname)` (single: the real `env`; many: the client, its surface and its
environment, or `client: null` for a 404), `environmentFor(env, client)` (an entry that knows
the client: the runner called by the app, a queue message's stamp, a Durable Object's name),
`hostDirectory(env).activeClients()` (a cron's fan-out) and `isSchemaBehind(client)`.

## Deferred
- **Step 4:** deciding the client at every entry, the 404 for an unknown hostname, the refusal of
  a client whose schema is behind, `AsyncLocalStorage` for the module-level `env`, the wrappers
  of files, key-value, search, queues, Workflows, Durable Object namespaces and the runner, and
  the `REGISTRY` and `CLIENT_DB` bindings in the Workers' configuration. Whether `paused` and
  `moving` refuse requests, and how, is decided there.
- **Step 5:** the module-level caches below the entries, keyed by client.
- **Step 6:** derived auth secrets, given secrets decrypted from `registry_secrets`, and each
  address from the client's hostnames: filling in the names this ADR leaves out.
- **Step 7:** writing the registry (`cos client add` and the rest), applying its migrations on
  deploy, recording `schema_version` after each client's migration, and the deployment table the
  spec lists ("the deploy engine's state for the Workers themselves"), which waits for the shape
  of the per-client update. Whether a subset of packs set in `COS_PACKS` must be checked against
  the product's packs is decided where it is written.

## Consequences
- **A single-client deployment is unchanged:** no Worker binds `REGISTRY` or `CLIENT_DB`, no entry
  calls the new code, and every existing test runs on D1 as before.
- **Adding a binding, var or secret to the app or the runner now needs a line in `ENV_NAMES`,**
  saying what it is for a client; without one it is not in any client's environment, and a test
  says so.
- **An operator's change reaches a running isolate within 10 seconds.**
- **Stage 10's tenant tag and Settings → AI's key writing are not available to a client** on a
  many-client host; per-client AI keys are step 6's.
