# Stage 66: One host, many clients

Read first: [`AGENTS.md`](../../AGENTS.md), [`docs/architecture.md`](../architecture.md)
(Deployment, Hosted SaaS, Client repos), [`CONTEXT.md`](../../CONTEXT.md) (Deployment, Host,
Organisation), ADRs [0001](../adr/0001-self-hosted-single-org.md),
[0008](../adr/0008-identity-adapters.md),
[0151](../adr/0151-provider-keys-as-workers-secrets-or-byok.md),
[0163](../adr/0163-deploy-engine-over-the-cloudflare-api.md),
[0320](../adr/0320-erase-reaches-every-store.md),
[0422](../adr/0422-client-repos-and-one-command-as-built.md),
[0428](../adr/0428-buying-without-an-account.md),
[0450](../adr/0450-client-environments.md),
[0610](../adr/0610-three-homes-for-a-client-hosted-by-default.md) and
[0611](../adr/0611-one-host-a-database-per-client.md); stage
[46](46-hosted-clients.md) (its decisions 13 to 22 and its step 1 results); the spike on the
branch `spike/one-host` (`packages/core/test/spike/`); `packages/db/src/handle.ts` and
`migrate.ts`, `apps/app/src/server.ts`, `start.ts`, `server/operations.ts`, `server/http/api.ts`
and `bound.ts`, `server/mcp/handler.ts`, `apps/runner/src/index.ts`, `automations/dispatch.ts`,
`extensions/shipped-list.ts`, `packages/auth/src/index.ts`, `packages/release/src/update.ts`.

Status: **spec agreed (owner, 2026-11-23; design confirmed 2026-11-25)**. The owner chose the
design on 2026-11-23 (decisions 1 to 6), answered the open questions the same day (decisions 7 to
12), and confirmed on 2026-11-25 that this is the design for hosted clients: one shared host, a
database per client. First written as stage 47, which `main` gave to pack screens; renumbered 66.

This stage replaces most of stage 46. What stage 46 decided about people and promises stands
(its decisions 13 to 22); how a hosted client's Workers are laid out does not.

## Goal

One deployment of the host serves many clients. Each client's records are in a database of its
own, a Durable Object the host opens by client on every request. A new platform release is
deployed once and reaches every client. A client is added with one command and no new Workers.
The first client is the gym that stage 27 was built for.

## What exists today (from the code)

- **One deployment is one organisation** (ADR 0001): its own app Worker, runner, gatekeepers, D1
  database, bucket, key-value namespace, queues, search index, secrets and deploy settings.
- **All database access goes through the `D1Database` interface.** Workers call
  `createCrmDb(env.DB)` (`packages/db/src/handle.ts`) at the point of use: about 52 places in
  `apps/app/src`, 65 in `apps/runner/src`, 5 in `packages/auth/src`. `packages/core` never reads
  `env.DB`; it is handed a database handle. No gatekeeper touches the database.
- **The spike** (`spike/one-host`) put a Durable Object with SQLite storage behind that interface
  and ran `packages/core`'s suite against it unchanged: **152 of 152 test files, 4,088 tests
  pass**, the same as on D1, with every migration applied inside the object. It ran in the local
  Workers runtime, on `packages/core` only. It has no bookmark or restore.
- **There is no one place where a request gets its context.** The app builds an operation context
  in `staffContext`, `outsideContext`, `apiContext` and inline in about ten more places; the runner
  passes `this.env` whole into its helpers. Roughly 20 to 25 construction sites in all.
- **The app reads its environment two ways:** the `env` its fetch handler is given, and the
  module-level `env` from `cloudflare:workers`, which TanStack Start's middleware, its one server
  function (`call-operation.ts`) and several routes use.
- **Where code starts running:**

  | Worker | Entry | What tells it whose data to use today |
  | --- | --- | --- |
  | app | `fetch` (`server.ts`): support, assistant socket, media, `/api/v1`, customer sign-in, native sign-in, MCP and OAuth, then TanStack Start | Nothing: one deployment, one organisation |
  | app | `scheduled`: daily maintenance; every 10 minutes embeddings, the adjudicator, file deletion, agent jobs | Nothing |
  | app | `queue`: `cos-routine-delivery` (`RoutineDeliveryMessage`) | Nothing in the message |
  | app | Durable Objects `AssistantAgent` (`user:<id>`), `AgentJob` (`job:<id>`); both read the database | Their name, which has no organisation in it |
  | app | `ClientApp` entrypoint (`bound.ts`), called by a client's web app | Nothing |
  | runner | RPC from the app (about 30 methods on `Runner`) | Nothing |
  | runner | `scheduled`: the minute tick (schedules, outbox, notifications, orders, publishing, recurring, waitlist, agreements and more) | Nothing |
  | runner | `queue`: `cos-automation-events` (`AutomationQueueMessage`) | Nothing in the message |
  | runner | Workflows `AutomationWorkflow` (`AutomationRunParams`), `HelloWorkflow` | Nothing in the params |
  | runner | Durable Objects `ExtensionWorkspace` (one, named `workspace`), `IntegrationHost` (by connection id, reads the database), `CodeModeGate` (by user id) | Their name |

- **Shared names have no organisation in them:** file keys (`media/<id>`, `email-bodies/…`,
  `erase-log/…`, `org-extensions/<hash>.json`), the OAuth library's keys in `OAUTH_KV`, vector ids
  (`<object>:<id>`, filtered by object only), Workflow instance ids, rate-limit keys (database
  ids, and one constant, `code-new`), Durable Object names.
- **Worker Loader cache ids** are built from the extension, its commit and the runtime, with
  nothing of the deployment in them. A dynamic Worker gets an empty `env` and no network; what it
  may reach is passed to each run.
- **About 30 deploy settings and 20 secrets are per organisation today,** read from `env`:
  policy (`APPROVAL_FLOOR`, `APPROVAL_EXPIRY_DAYS`, `IDENTITY_PROVIDER`, `AUTH_ALLOW_SIGNUP`),
  what is installed (`COS_PACKS`, `COS_ORG_EXTENSIONS`), AI choices (`AI_MODEL_ROLES`,
  `AI_PROVIDERS`, the judge settings), addresses (`BETTER_AUTH_URL`, `CUSTOMER_AUTH_URL`,
  `API_ALLOWED_ORIGINS`, `APP_ORIGIN`, `MCP_RESOURCE`, each gatekeeper's `BASE_URL`), and secrets
  (`BETTER_AUTH_SECRET`, `CUSTOMER_AUTH_SECRET`, Google sign-in, AI provider keys, the payments
  gatekeeper's Stripe keys, the Stream token and signing key).
- **Rules about those:** auth secrets are env-only and identity is never AI-configurable (ADR
  0008); provider keys are Worker secrets, never in the database (ADR 0151); payment secrets are
  env-only (ADR 0428); the approval floor is a deploy-time setting the organisation's own policy
  can never loosen.
- **Auth is built once per `env` object** (`WeakMap`s in `packages/auth/src/index.ts`), with the
  database captured inside, one staff address and one customer address per `env`.
- **Data cached at module level,** which two clients in one isolate would share: the extension
  schema registry (`extensions/schema.ts`), entitlements, the plan on sale, dashboard schema names,
  tool operations, the "packs installed" flag (`operations.ts`), the org extensions cache, the
  Stream host, the product label, the API surfaces, and the MCP providers (keyed by origin).
- **An update** (`packages/release/src/update.ts`) pauses automations, takes a D1 bookmark,
  applies migrations over D1's REST API, uploads the Workers, runs a smoke check and resumes;
  on failure it uploads the previous Workers and restores the bookmark. Deployment state is a row
  in the same database (`core_install`). Nothing refuses a request when the schema is behind the
  code: `/api/health` reports it and that is all.
- **Not anywhere:** a list of clients, a client chosen from a hostname, a setting or secret held
  per client outside `env`, a database that is not D1.

## Decided by the owner (2026-11-23)

| # | Decision |
| --- | --- |
| 1 | Dozens of gyms on a standard product are expected, so the layout is chosen for that |
| 2 | **One host, a database per client.** The host is deployed once; each client's records are in a Durable Object of its own |
| 3 | The gym of stage 27 becomes the standard, if it can: the standard product is built from its setup, and it is the first client |
| 4 | The host itself does not run per client in a Workers for Platforms namespace. The checks are recorded in stage 46: a host's own Workers cannot be bound to each other, consume queues or run Workflows inside one. Routing all three through a fleet Worker was tested and works, and was not chosen. (Recorded here at first as "Workers for Platforms is not used", which the owner had not said: see decision 12) |
| 5 | A set of Workers per client (built today) is not the layout for hosted clients either: it does not fit dozens of gyms |
| 6 | Stage 46's decisions 13 to 22 stand: hostnames on `composableos.app`, the fleet's account, usage reported before limits are set, a moved client's old copy kept 90 days, our repositories while a client is hosted, and the leaving promise |

### The owner's answers to the open questions (2026-11-23)

| # | Decision | Was |
| --- | --- | --- |
| 7 | **No client is held on an older release.** Updates go to staging first. A client whose own extensions fail the new release's checks stops the update before live, and we fix the extensions. This replaces stage 46's decision 5 (a hold per client), made when each client had its own Workers | question 1 |
| 8 | **A client's given secrets may be stored encrypted in the registry:** under a key only the host's environment holds, written only by the operator's command, never readable by an operation, an extension or the assistant. Auth secrets are derived, not stored. ADRs 0008, 0151 and 0428 are amended for a many-client deployment | question 2 |
| 9 | **A client in its own account, and a self-hosted install, stay as built,** on D1 | question 3 |
| 10 | **Staging is a second deployment** holding every client's staging environment. Each release runs there before live | question 4 |
| 11 | **The first client starts with its own web app and repository.** The standard web app and settings-only gyms are the next stage, with their own interview | question 5 |
| 12 | **Workers for Platforms holds each client's own code that has to be a Worker.** In this stage that is a bespoke client's web app: one Worker each, in a namespace, calling the shared host. Later it is also where a client's own gatekeeper would go, as a second Worker. A client's own records, tools and automations stay extensions, run in the host's sandbox | question 6, which proposed switching it off |

## The design in one page

```
 customer ─► gym-a.com ─► standard web app ───────────────────┐
 customer ─► ghetto.com ─► cos-front ─► Ghetto's web app ──────┤ HOST binding, the client fixed on it
                          (namespace cos-clients: clients' code)│
 staff ────► gym-a-admin.composableos.app ─────────────────────┤
                                             ▼
        ┌──────────────── the host, deployed once ────────────────┐
        │ app ──► runner ──► gatekeepers        queues, Workflows │
        │  every entry: which client? ─► the client's environment │
        └───────┬──────────────────────────────────┬──────────────┘
                ▼ opened by client                 ▼ one each, a client's part kept apart by the host
   ClientDb(gym-a)  ClientDb(gym-b)  ClientDb(ghetto)      files · search index · queues · key-value
                ▲
          the registry: clients, their hostnames, settings and secrets (the operator's only)
```

- **A client** is one business on the host. It has an id (`ghetto`), hostnames, settings, secrets
  and a database. Its data never holds its id: no table gains a client column (ADR 0001's rule,
  kept).
- **The client's environment** is the one new idea. At every entry the host decides the client,
  then builds an object shaped like today's `Env` for it: `DB` is that client's database, the
  per-client settings and secrets are filled in from the registry, and each shared binding is
  wrapped so that it only reaches that client's part. Everything below the entry reads `env` as it
  does today.
- **A single-client deployment is today's host.** With no registry, the client's environment is
  the real `env` and `DB` is the D1 binding. A self-hosted install and a client in its own
  Cloudflare account run this way, unchanged.

## The model

### The client's database

`ClientDb`, a Durable Object class with SQLite storage, one object per client and environment,
named by the client's id. It is the spike's class made complete:

- **The D1 interface,** as in the spike: `prepare`, `bind`, `first`, `all`, `run`, `raw`, `batch`
  (one transaction), `exec`, with D1's result shape, error text and value conversions.
- **Migrations** run inside the object, from the list the host's code carries
  (`applyMigrations` already takes the list as data).
- **Bookmarks and restore** with the object's point-in-time recovery, for updates and roll-back.
- **Export and import** as SQL, for a move and for the leaving promise.
- **Size,** for usage reports and the 10 GB limit.
- **Place:** created with the client's location hint (stage 43's decision: Oceania for new
  clients).

A request's queries each cross to the object once. The limits to know: one object handles one
query at a time, and holds 10 GB. Files and videos are not in it.

### The registry

The host's own D1 database (the one real D1 binding left in a many-client deployment), holding no
client's records:

| Table | Holds |
| --- | --- |
| Clients | id, environment, status (`active`, `paused`, `moving`), tier, the repository that may deploy it, location hint, schema version last seen |
| Hostnames | hostname, client, which surface (staff or web), whether verified |
| Settings | per client: the approval floor and expiry, identity provider, sign-up, packs, the org extensions hash, AI roles and providers, the allowed origins |
| Secrets | per client, encrypted: what cannot be derived (below) |
| Deployment | the deploy engine's state for the Workers themselves (`core_install` today) |

**Only the operator writes it,** through `cos` with the account's token. No operation, no
extension and no assistant can read or write the registry. That is how "identity and policy are
not AI-configurable" and "loosening approval policy is human-admin-only" hold with many clients:
the registry is the deploy-time setting, per client.

The host reads a client's row through a short cache per isolate, replaced when the registry's
version stamp changes.

### Secrets

- **Derived:** the staff and customer auth secrets are derived from one master secret in the
  host's `env` and the client's id, a different derivation for each. No auth secret is stored
  anywhere, and one client's cannot be worked out from another's.
- **Given:** secrets a client brings (its Stripe keys, its own Google sign-in, its own AI
  provider keys) are stored in the registry encrypted under a second key in the host's `env`,
  written only by `cos client secret set`, and decrypted only into that client's environment.
- **The operator's own** (the Stream token, the Platform AI token, the gatekeepers' own OAuth
  apps) stay Worker secrets, shared.

This amends ADRs 0008, 0151 and 0428 for a many-client deployment (decision 8). A single-client
deployment keeps Worker secrets exactly as today.

### Deciding the client at each entry

| Entry | The client comes from |
| --- | --- |
| A request to the app | The hostname, looked up among verified hostnames. Unknown hostname: 404, before any other code |
| `ClientApp`, called by a web app | The standard web app: the hostname it was reached on, which it passes and the host verifies. A client's own web app: fixed on its `HOST` binding at deploy (`props`), so its code cannot name another client |
| The app calling the runner | The app passes the client; the runner trusts only the app (the binding is not public) |
| A cron | The registry: the handler queues one message per active client, and each is handled as that client |
| A queue message, a Workflow | The wrapper that sent it stamped the client beside the body; the consumer unwraps it. The message types in `packages/core` do not change |
| A Durable Object | Its own name, which the wrapper prefixed with the client |
| A gatekeeper calling back | The connection it was minted for, as today; the connection's object is the client's |

Code that reads the module-level `env` (TanStack Start's middleware, `call-operation.ts`, the
routes listed above) reads the current client's environment instead, held for the length of the
request (`AsyncLocalStorage`). A lint rule refuses a new import of the module-level `env` in the
host's Workers.

### Shared bindings, kept apart

Each is wrapped in the client's environment so the code below it does not change:

| Binding | Kept apart by |
| --- | --- |
| Files (`BLOBS`) | A key prefix per client, added on write and removed on list |
| `OAUTH_KV` | A key prefix per client |
| Search (`VECTORIZE`) | A namespace per client |
| Queues | The client stamped on every message |
| Workflows | The client in the instance id and beside the params |
| Durable Object namespaces | The client in every name |
| Rate limits | The client in every key |
| The cache | Already keyed by a random value per database |

Worker Loader ids stay as they are: the same extension at the same commit is the same code for
every client, and a dynamic Worker holds nothing of a client between runs. _Amended 2026-11-26
(see "Decided by this spec"): the client is part of every tool worker id on a many-client host._

**Stream:** the host stamps each upload with the client as its `creator` and refuses any call for
a video with another creator. With one host there is one holder of the token and no broker.

### Module-level caches

Every cache listed under "What exists today" is keyed by client or moved into the client's
environment. Auth's caches are keyed by the `env` object, so they are correct as soon as each
client's environment is one stable object per isolate.

- The widget cache key (`widgetCacheKey`, `dashboards/cache.ts`) holds no organisation: dashboard
  widgets, Today's pack items and Today's takings (`host.takings`, keyed by the day and zone only)
  would be shared by two clients in one zone. It gains the client, as do Today's failed-items memo
  (`today/pack.ts`) and the dashboards' schema-names memo (stage 60, ADR 0874).

Because a miss here shows one client another's data, it has its own tests: the core suite run
with two clients taking turns in one isolate, and a test per cache.

### Addresses

Each client has its own staff address and web address, so nothing that holds "the" address of a
deployment can stay a single value: the auth base URLs, the allowed origins, the links in emails,
the MCP resource. Each comes from the client's hostnames in the registry.

Gatekeeper callbacks (OAuth redirects, webhooks) keep one address per deployment, on the fleet's
domain: a provider's app is registered once with one redirect address, and the state or the
endpoint id says which client's connection it is for.

### Adding, updating and removing

- **`cos client add <id>`** writes the registry row, creates the database, applies migrations,
  installs the product's packs and the client's own extensions, and prints the two hostnames. No
  Worker is uploaded.
- **`cos deploy`** in a hosted client's repository uploads its web app into the namespace (with
  the client fixed on its `HOST` binding), stores its own extensions and updates its registry
  settings. It never
  uploads the host.
- **An update of the host** is the deploy engine's update, with the database steps done for every
  client: pause, then for each client bookmark and migrate, then upload the Workers once, smoke
  check, resume. A client whose migration fails is restored to its bookmark and the update stops
  before the upload. After the upload, a failed smoke check uploads the previous Workers and
  restores every client's bookmark.
- **The host refuses a request for a client whose schema is behind the code,** with a "being
  updated" page, where today it only reports it.
- **Staging first:** a second deployment, `staging`, holds every client's staging environment. An
  update goes there, then to live (decision 10). Before live, the new release's checks run on
  every client's own extensions; a failure stops the update (decision 7).
- **`cos client export`, `cos client import`, `cos client remove`:** the database as SQL, the
  client's files, its videos by creator, its secrets. Export then install in the client's own
  account is the leaving promise; a removed client's export is kept 90 days.

### A client's own code

- **Its web app** is one Worker of the client's code, in the Workers for Platforms namespace
  `cos-clients` (decision 12). It does not count toward the account's limit of 500 Workers, and
  it sits apart from our own Workers.
  - `cos-front`, a small Worker of ours, receives requests for clients' web hostnames, looks the
    hostname up in the registry and passes the request to that client's web Worker, with a CPU
    and subrequest limit. It never derives a Worker from the hostname.
  - The web Worker's `HOST` binding points at the host's `ClientApp` with the client fixed on the
    binding. Stage 46's checks showed a namespace Worker can call an ordinary Worker's named
    entrypoint this way, and that the receiving side can refuse another client.
  - A web Worker has that one binding and nothing else: no database, bucket or secret of ours.
- **Its extensions** are data in the host, run by Worker Loader with no network, as today.
- **Its own gatekeeper,** when a client needs one, would be a second Worker in the namespace that
  the runner calls for that client only. Not in this stage; the namespace and `cos-front` leave
  room for it. It is kept apart from the web Worker because it holds credentials and can reach
  the internet.
- **A client in its own Cloudflare account** runs the same release as a single-client deployment,
  with its web app as an ordinary Worker.

## Out of scope

- **The standard web app and signing a gym up from settings.** The standard product's own
  interview and stage, next. This stage makes the host able to hold them.
- **Holding one client on an older release** (decision 7).
- Charging for usage, and limits.
- Moving the single-client deployment off D1.
- Selling the hosted CRM by sign-up, and the stage 10 control plane, which is unchanged.
- A client's own gatekeeper (decision 12 leaves room for it).
- Running the host per client in a namespace.

## Acceptance criteria

1. The spike's result holds on Cloudflare: `packages/core`'s suite, and the app's and runner's,
   pass with the client's database in place of D1, deployed, not only locally. The time a typical
   staff page and a customer checkout take is measured against D1 and recorded.
2. A single-client deployment is unchanged: every existing test passes with no registry, on D1.
3. Two clients on one deployment: a staff user of each signs in at their own address and sees
   only their own records, files, search results, assistant threads and extensions.
4. A staff session, a customer session, an API token and an MCP connection issued for one client
   are refused at another client's address.
5. The core suite passes with two clients taking turns in one isolate, and nothing one client
   wrote is read by the other.
6. A record written by one client fires only that client's automations, and a Workflow started
   for one client reads and writes only that client's database.
7. Each cron's work runs for every active client, and one client's failure does not stop the
   others'.
8. An unknown hostname gets a 404 and reaches no client's data.
9. A client's own web app runs in the namespace and is reached only through `cos-front`. Through
   its `HOST` binding it can reach only its own client, whatever hostname or header it sends, and
   it holds no other binding.
10. No operation, extension or assistant tool can read or change a client's registry settings or
    secrets. Changing the approval floor is possible only through `cos` with the account's token.
11. `cos client add` makes a working client with no Worker upload, in under a minute.
12. An update with three clients migrates each, uploads once and leaves all three on the new
    version. With one client's migration made to fail, that client is restored, nothing is
    uploaded and the other two are as they were.
13. `cos client export` then an install in another account gives a single-client deployment with
    every record count and file hash the same, staff and customers able to sign in after setting
    a new password or code, and the search index rebuilt.
14. Erase (ADR 0320) reaches every store for one client and touches no other client's.
15. The first client's staging and live environments run on the host, on its own bare domain,
    with a test payment taken and the provider's webhook received.
16. `cos client usage` shows, per client, requests, database size, stored files, Stream minutes
    and AI spend for the month.
17. `docs/architecture.md`, `CONTEXT.md`, the skills that deploy (`start-client-app`) and ADRs
    0001, 0008, 0151 and 0428 say what is now true.

## Dependencies

Stages 8, 22 to 28 and 31 as built. The fleet's account and `composableos.app` (stage 46,
decisions 13 and 14). Workers for Platforms, on in that account, for clients' web apps.

## Migrations and numbers

Block AU in [`docs/parallel-work.md`](../parallel-work.md), shared with stage 46: ADRs 0610 to
0619 (0610 and 0611 used), migrations 0790 to 0809. The registry has its own migrations, beside
the host's.

## Suggested build order

1. **Prove it on Cloudflare** (criterion 1). `ClientDb` complete enough to carry the app's and
   runner's suites, deployed to the fleet's account with one client, and timed. If the timing is
   not acceptable, stop and return to the owner before step 2.
2. **`ClientDb` finished:** migrations inside, bookmarks and restore, export and import, size,
   location hint.
3. **The registry and the client's environment,** with single-client mode proved unchanged
   (criterion 2).
4. **The app's entries,** then **the runner's,** each with the wrappers it needs. Criteria 3, 4,
   6 to 9.
5. **Module-level caches and the two-client suite.** Criterion 5.
6. **Secrets and addresses per client;** gatekeeper callbacks on one address. Criterion 10.
7. **`cos client add`, the update, export, import, remove.** Criteria 11 to 14.
8. **Hostnames, `cos-front` and the namespace:** `composableos.app` addresses, a client's web
   app in the namespace, then custom hostnames for a client's own domain. Client-controlled web
   code is never served on the fleet's staff domain: a client's web app is on its own domain or
   on a registrable domain apart from the staff hostnames, and the fleet's domain is submitted to
   the Public Suffix List (ADR 0616, "Cookies"; added 2026-11-27).
9. **The first client,** staging then live. Criterion 15.
10. **Usage.** Criterion 16.
11. Docs, skills and the ADR amendments. Criterion 17.

Steps 2 and 3 can run side by side; 4 and 6 after 3.

## Decided by this spec, open to override

- **A single-client deployment keeps D1.** Self-hosted installs and own-account clients change
  nothing. A move between the two is a SQL export and import, since both are SQLite.
- **No client column anywhere.** The client is in the registry, in names and in key prefixes.
- **The registry is a D1 database of the host,** written only by the operator.
- **Auth secrets are derived, not stored.**
- **Crons fan out through a queue,** one message per client, from the start.
- **Worker Loader ids are not per client.** _Amended 2026-11-26 (coordinator, after the review
  of step 3; open to the owner's override, ADR 0613): on a many-client host the client is part of
  every tool worker id, since a warm isolate and a pack's module-level variables would otherwise
  carry one client's data into another's run. Isolation wins over cold starts. Step 4 builds it._
- **Gatekeeper callbacks use one address per deployment.**
- **The host refuses requests for a client whose schema is behind.**
- **Packs are the product's:** every client of a deployment has the product's packs, or a subset
  set in the registry. What only one client needs is that client's own extension.

## Questions for the owner

None open. Decisions 7 to 12 answer them.

## Status

Spec agreed (owner, 2026-11-23; design confirmed 2026-11-25). No build step is built yet. Each
build step adds a bullet of its own here (CONTRIBUTING.md, Working in parallel).

- **Step 1** — built — PRs #507, #510, #511 — Prove it on Cloudflare: `ClientDb` carrying the app's and runner's suites, timed (the spike is first brought up to `main`). Built: `ClientDb` in `packages/db` (ADR 0612, its D1 differences table), the core, auth, app and runner suites passing on it with `COS_TEST_DB=client-db`, the probes against D1, and the proof Worker `apps/client-db-proof`. Proved on Cloudflare (2026-11-27, ADR 0612 "Measured on Cloudflare", the class in its own Worker reached through `ClientDbQueries`): 39 of 39 probes the same as D1; warm near medians D1 / client's database: staff list 156 / 31 ms, a person's page 275 / 54, checkout 648 / 163; cold first staff page 381, 420, 276 against 115, 357, 375; 9,980 queries in one request through the service before the ordinary 10,000-subrequest refusal. Deviation from criterion 1, kept: the suites do not run deployed; on Cloudflare the proof runs the probes, the warm staff pages and checkout, a cold first page and the subrequest budget, which show the service's behaviour and its time but not every path the suites cover; those run on ClientDb locally only

- **Step 2** — built — PR #511 — `ClientDb` finished: migrations inside, bookmarks and restore, export and import, size, location hint. Built (ADR 0614): bounded answers held and fetched in parts, every set but a provable read recorded under its id and never run twice, unknown outcomes never retryable, `migrateAndReport` and `level`, `bookmark`/`restore`/`restoreClientDb`, `usage` with a refusal before the 10 GB limit and a reserve for an erase, `place`, export and import as SQL (`@composable-os/db/sql-export`: held still, statements checked, the schema verified against the code's migrations, counts in the last part; D1 to a client's database and back, compared table by table locally), `ClientDb` in its own Worker `apps/client-db` with the query-only entrypoint `ClientDbQueries` (`CLIENT_DB_QUERIES`). Shown on Cloudflare (2026-11-27): restore (1,435 ms) and undo (1,121 ms) on a real object, a write during the restore window refused, `bookmarkAt` before the database existed refused cleanly. Still waiting for the proof run: the export and import across real D1 and Durable Objects, real D1's features they use, the 200,000-statement batch and the 40 MB and 60 MB reads there, and the size after deletes (`/step2/export`, `/step2/d1`, `/step2/answers`, `/step2/size`; made resumable after they timed out as one request each)

- **Step 3** — built — PR #509 — The registry and the client's environment, single-client mode unchanged: the registry's own D1 database (`REGISTRY`) and migrations (`packages/db/registry-migrations`, 0790: clients, verified hostnames, settings, the encrypted secrets' columns, a version stamp moved by triggers), read in one batch whatever the number of clients (`@composable-os/db/registry`: client ids, exact hostnames, `isSchemaBehind`); the client's environment (`@composable-os/db/client-environment`: the real `env` with no registry; otherwise the client's database, its settings, shared values and wrapped bindings only, by `ENV_NAMES`, with rate limits as the worked wrapper) and `ClientDirectory`, one per isolate, keyed by client, serving only an active, current client of the deployment's environment (`COS_HOST_ENVIRONMENT`) and refusing every other with its reason, its environments frozen. ADR 0613. No entry wired (step 4); secrets and addresses left out (step 6); the registry's writes and its deployment table are step 7's

- **Step 4** — built — PR #512 — The app's entries, then the runner's, with their wrappers: every entry decides the client first (the hostname; a message's stamp; a Workflow's id and params; an object's name; a minted entrypoint's props; `callAs(<client>, …)` from the app to the runner) and refuses otherwise (one plain 404 for an unknown hostname, "being updated" for a client paused, moving or behind); TanStack Start's code reads the client's environment through AsyncLocalStorage (`requestEnv()`), and a lint check refuses the module-level `env` and `CLIENT_DB` in the app and the runner; wrappers for files, OAuth's key-value, search, the queues, the Workflows, the Durable Object namespaces and the runner (`@composable-os/db/client-bindings`); the crons fanned out through a queue, one message per client, one tick an invocation; a refused client's messages parked, not retried, and dead letters reported; Worker Loader ids per client; the host's proof (`COS_BINDING_KEY`) on objects' names and minted props, and the app's fixed props on its binding to the runner; no gatekeeper that holds one account for every client offered on a many-client host; two-client suites in apps/app and apps/runner. ADR 0615. With step 6 merged: only `__Host-` cookie names are sessions on a many-client host, the fake gatekeeper is refused at the runner's entry too, and the cross-client tests of staff and customer browser sessions, MCP consent and exchange, the native handoff, calendar feeds and support access run in the app's two-client suite. Hardened after the second review (#515, PR to come): cos-client-db answers only the host's Workers and calls with a proof of their client; an object's base class holds its client's environment only (`ClientDurableObject`); proofs bind the client's secret generation and the registry never reuses a removed id (registry migration 0794); a props key apart from the object key, rotatable; parked messages on their own queue with a ledger per client (a cap, duplicates dropped, given-up counted); every method of an object checked; the lint parses the code. Waits for step 5 (module-level caches, the creator-checked video host) and step 7 (the fleet's bindings at deploy)

- **Step 5** — not built — needs: step 4 — Module-level caches and the two-client suite

- **Step 6** — built — PR #513 — Secrets and addresses per client, gatekeeper callbacks on one address (ADR 0616; ADRs 0008, 0151 and 0428 amended): the staff, customer and desk secrets (and so the person-code and practitioner keys), the support cookie's key and the client-address key derived per client with HKDF from the host's `COS_ROOT_KEY` and the client's secret generation (migration 0792), stored nowhere, except a deployment imported as a client, whose own are stored sealed and override derivation (`writeImportedSecret`), and taken by a leaving client (`exportClientSecrets`); a client's given secrets (its own Google sign-in, Cloudflare Access, Turnstile, judge and AI keys) sealed with HPKE (X25519, AES-256-GCM, `@hpke/core`) to the host's public key in `registry_secrets`, so only `COS_SECRETS_PRIVATE_KEY` in the host's environment opens them, written only by the operator's command (`@composable-os/db/registry-sealing`, which cannot open) and opened only by the directory into that client's environment, never in the snapshot; rotation by a re-seal on the host; on a many-client host every session cookie `__Host-` prefixed; each address from the client's verified hostnames (migration 0791: the marked hostname of a surface), `NATIVE_REDIRECT_URIS` a registry setting; the deployment's one callback hostname (`COS_CALLBACK_HOSTNAME`, `@composable-os/db/callbacks`), no client's. The payments, text, inbound webhook, email and email-sending gatekeepers are left out of every client's environment and the fake gatekeeper refused, until each is made per client (ADR 0616 lists the work, and payments' two shapes for the owner)

- **Step 7** — not built — needs: step 2, step 5, step 6 — `cos client add`, the update, export, import, remove

- **Step 8** — not built — needs: step 7 — Hostnames, `cos-front` and the namespace (a desk hostname per client included)

- **Step 9** — not built — needs: step 8, the first client — The first client, staging then live

- **Step 10** — not built — needs: step 7 — Usage

- **Step 11** — not built — needs: step 8, step 10 — Docs, skills and the ADR amendments
