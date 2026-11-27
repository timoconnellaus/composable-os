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
| 12 | **Workers for Platforms holds each client's own code that has to be a Worker.** In this stage that is a bespoke client's web app: one Worker each, in a namespace, calling the shared host. Later it is also where a client's own gatekeeper would go, as a second Worker. A client's own records, tools and automations stay extensions, run in the host's sandbox. _Note 2026-11-27 (the owner, for step 8): the namespace is not built in step 8. How a client's web app is served (Worker Loader, or an upload to a namespace) waits for stage 75's step 1 spike; step 8 builds cos-front with a holding page as its one target (ADR 0619)._ | question 6, which proposed switching it off |

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
    _Amended 2026-11-27 (the owner, after the review of #543; ADR 0619): a bare domain is refused
    as a client's own domain (Cloudflare for SaaS needs a CNAME, and apex proxying is not ours to
    use). The first client's site stays in its own account for now; later it is `www.<domain>`
    through cos-front, with the apex redirected in the client's own zone. The criterion's "on its
    own bare domain" is read as "on its own domain"._
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
   _Changed by the owner, 2026-11-27 (ADR 0619):_ no Public Suffix List submission (it would be
   declined at our size), and "a registrable domain apart from the staff hostnames" is withdrawn.
   In their place three rules: (a) client-written web code runs only on the client's own domain,
   never on any hostname under the fleet's registrable domain; (b) a state-changing request is
   refused unless it comes from the exact same origin; (c) a many-client host reads no cookie
   without the `__Host-` prefix. The namespace and a client's web app in it are not built in this
   step: they wait for stage 75's step 1 spike, which decides how a client's web app is served.
   Step 8 builds the hostnames (staff, desk, callback; a client's own domain) attached by `cos`,
   and `cos-front` with a holding page as its one target.
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

- **Step 5** — built — PR #522 — Module-level caches and the two-client suite: ADR 0617, no migration. What core keeps between requests is a `clientState`, one value per client scope (the client's database and id, held by an AsyncLocalStorage the host Worker gives core at load, set by every entry and by `invoke`; code outside every scope refused on a many-client host): the extension schema registry, entitlements, the plan on sale, schema names, query embeddings, Today's failed items, the rate-limits-down notice; the shared widget cache's key holds the client; the app's and runner's caches keyed by the client's environment (the shipped extensions' install, the org extensions, the vector stand-in, the no-visitor notice, the embedding drain). `scripts/check-module-state.mjs` lists every piece of module-level state in what the host's Workers load, gatekeepers included, each with its decision and reason (`scripts/module-state.mjs`). The creator-checked video host (`creatorCheckedVideoHost`): each upload and copy stamped with the client, every call and playback token for another creator's video refused. Two-client tests: a test per cache in core, the whole core suite with a second client taking turns (`pnpm --filter @composable-os/core test:two-clients`, a script, not CI), the app's entries, the video host. After review: each Workflow step and Worker Loader callback enters its client's scope, every call into a client's object too (`provideObjectScope`), the client's stamp `<environment>:<client>` for the video creator and the shared caches (public content included), and a per-environment value refused for an environment that is no client's

- **Step 6** — built — PR #513 — Secrets and addresses per client, gatekeeper callbacks on one address (ADR 0616; ADRs 0008, 0151 and 0428 amended): the staff, customer and desk secrets (and so the person-code and practitioner keys), the support cookie's key and the client-address key derived per client with HKDF from the host's `COS_ROOT_KEY` and the client's secret generation (migration 0792), stored nowhere, except a deployment imported as a client, whose own are stored sealed and override derivation (`writeImportedSecret`), and taken by a leaving client (`exportClientSecrets`); a client's given secrets (its own Google sign-in, Cloudflare Access, Turnstile, judge and AI keys) sealed with HPKE (X25519, AES-256-GCM, `@hpke/core`) to the host's public key in `registry_secrets`, so only `COS_SECRETS_PRIVATE_KEY` in the host's environment opens them, written only by the operator's command (`@composable-os/db/registry-sealing`, which cannot open) and opened only by the directory into that client's environment, never in the snapshot; rotation by a re-seal on the host; on a many-client host every session cookie `__Host-` prefixed; each address from the client's verified hostnames (migration 0791: the marked hostname of a surface), `NATIVE_REDIRECT_URIS` a registry setting; the deployment's one callback hostname (`COS_CALLBACK_HOSTNAME`, `@composable-os/db/callbacks`), no client's. The payments, text, inbound webhook, email and email-sending gatekeepers are left out of every client's environment and the fake gatekeeper refused, until each is made per client (email sending since, PR #527, and installed on every fleet since "A fleet's gatekeepers", below) (ADR 0616 lists the work; of payments' two shapes the owner chose, 2026-11-27, each client's own Stripe account with its keys passed per call sealed to the gatekeeper, not Stripe Connect: a later step builds it)

- **Email sending per client** — built — PR #527 — after step 6, for the first client's sign-in codes (ADR 0616, its note "Email sending per client"): a client's sender domains in the registry (registry migration 0796, `registry_sender_domains`: one client a domain, none under or over another client's, verified by the operator once the domain is onboarded to Email Sending in the deployment's account; written only through `@composable-os/db/registry-senders`), only the verified ones in its environment (`COS_SENDER_DOMAINS`); the client's integration host passes them to the email-send gatekeeper with every bind, send and apply, and the gatekeeper with `SENDER_DOMAINS_PER_CLIENT` refuses a sender off them (never reading `ALLOWED_SENDER_DOMAINS`) and the plain apply; email sending offered only to a client with a verified domain. Two-client tests in the app and the runner: sign-in codes, staff and practitioner invites and a notification from the client's own domain with its own links, another client's domain, an unverified one and none refused, stored bodies apart. Email receiving stays left out. Step 7's commands set the var and call the writes

- **Step 7** — built — PR #526 — `cos client add`, the update, export, import, remove. Built (ADR 0618; registry migrations 0795, 0797 and 0798): the operator's Worker `cos-operator` (apps/operator, `@composable-os/db/operator`), the only binder of the raw `ClientDb` namespace, reached by `cos` with a fresh token per command; the registry's writes (`@composable-os/db/registry-writes`, over D1's REST API) and `registry_operations`, so every command's re-run carries on; `cos fleet keys` (a keys file only where the operator says, mode 0600, never in a git working tree, never printed), `cos fleet install` and the deploy engine's fleet bindings, ADR 0615's whole list (`packages/release/src/fleet.ts`; staging named `-staging`); `cos client add` (rows paused, database placed and migrated, schema recorded, then served; no Worker upload; a staff hostname on the fleet's domain, a web hostname only on the client's own); `cos fleet upgrade` (extension checks, pause, bookmark and migrate each client, a failure restores it and every client before it and uploads nothing, one upload, smoke check, roll back, resume; live only after staging); `cos client export` (database parts and files into the exports bucket, kept 90 days, with `--out` downloaded and the client's secrets in a 0600 file), `cos client import` (a new client added as imported, its own secrets stored sealed, migrated, its search index requeued; an existing id refused), `cos install --import` (an export as a single-client deployment in another account, criterion 13), `cos client remove` (export, erase, files, OAuth keys, vectors, then its rows and a tombstone), `pause`, `resume`, `list`, `secret set|remove`; erase reaching one client's stores only (criterion 14, the app's two-client suite); a client's Stripe keys storable as given secrets in no client's environment (the owner's payments decision). Closes #523 F2 (a parked message acked once sent, its id the original's) and F4 (a client's environment fixed by a trigger). Authenticated sealing decided as not added now (ADR 0616, open to the owner). An import re-stamps the client's videos this account's Stream holds with its creator (`clientStamp`, step 5's `<environment>:<client>`); a web hostname is never on the fleet's domain (no Public Suffix listing is assumed). Not built: copying videos in export and import (issue #525), extension objects of an import checked against the reconciler, deleting a removed client's Durable Objects (left unreachable), key rotation as a command, the deployment's state in the registry (kept in the host D1's `core_install`). After its review (ADR 0618, "After the review of #526"): the update smoke-checks the host's own health on the callback hostname (answered while clients are paused) and restores every client it bookmarked; one operator's command at a time on the operator's Worker; the keys file tied to its deployment; web hostnames refused under the fleet domain's registrable domain; an import takes extension objects only on extension tables; weak imported secrets refused; add and import refused during an unfinished update; later work is #528. Email sending wired (issue #529): `SENDER_DOMAINS_PER_CLIENT` on a fleet's email-send gatekeeper, `cos client sender add|verify|unverify|remove`, sender domains carried by export and added unverified by import, registry migration 0797 (a domain handed to another client starts unverified, F1), and shared suffixes, shared mail domains and the fleet's own domain refused (F2). After the second review (PR #530): a run that was taken over no longer cuts off the one that took over, and a live run's session never lapses (N1); `pause` refused during an update (N2); an import takes no view, no virtual table and no table, index or trigger whose SQL names a core table (string names included), and makes its views again from the host's definitions once the imported extension state is checked (N3, and the review of #530); the session's last heartbeat awaited on close; registry migration 0798, a renamed sender domain starts unverified (N4); the host's health route answers a registry failure with a fixed message. An import is a deny-by-default filter, to be used on trusted exports only; an import carrying data only is #532, and Bookings and Rostering clients cannot be imported yet. Nothing run on Cloudflare

- **A fleet's gatekeepers** — built — PR #544 — after step 7, so a fleet can send email (issue #529): `cos fleet install` and `cos fleet upgrade` install the email-send gatekeeper on every fleet, through the single-client mechanism (the deployment state's `gatekeepers`, the runner's `GATEKEEPER_EMAIL_SEND`, the engine's `SENDER_DOMAINS_PER_CLIENT`); the list is fixed by the platform, not a flag (`FLEET_GATEKEEPERS`, email sending alone), and a release without it is refused (ADR 0618, "A fleet's gatekeepers", a correction: step 7 deployed no gatekeeper). An upgrade adds it to a fleet installed without it and keeps it. No secret: Email Service is the account's binding, and the operator onboards each client's domain. Tests: the fleet install plan and upgrade (`packages/create-composable-os/test/fleet.test.ts`); in the runner's two-client suite a third client sends from its own domain, never gym-a's, nothing while paused (a send queued before included) and again once resumed, and nothing once removed. After its review: `INTERNAL_DOMAINS` always empty on a fleet's email-send gatekeeper; single-client `cos install` and `cos upgrade` refuse a fleet's deployment state before writing anything; the staging check asserts the gatekeeper (step 4a, and after the upgrade); the fleet docs list a client's mail steps in full. Not run on Cloudflare or against the real Email Service

- **Staging check** — built, run once — PR #541, first real run fixed in PR #546 — after step 7: `.github/workflows/fleet-staging-check.yml`, run by hand, makes a throwaway staging fleet on the fleet's account (a throwaway product `cosstg-<run id>`, two releases built from the commit), runs `cos fleet keys` and `install`, two `cos client add`s (timed), requests to the clients' staff hostnames and the callback hostname (attached as Workers Custom Domains under a zone given as an input: `cos` attaches none until step 8), sender domains, three upgrades (a failed migration, a failed smoke check, a success), export and import compared by row counts and file hashes, two operator commands at once and a remove, each step timed into the summary, then deletes everything with the prefix and fails if anything is left; mode `remove` deletes what a failed run left. Its logic is `scripts/fleet-staging-check.mjs`, tested against the fake Cloudflare API. Added to `cos`: `--product-file`, `cos fleet install --location` and `--ai` (first install only), and the test switch `COS_FLEET_FORCE_FAILURE`, refused outside a staging fleet of a `cosstg-` product in that workflow. Not checked: a send (the fleet's email-send gatekeeper is checked as deployed and bound, step 4a since PR #544, but a real send needs an onboarded domain and the client's in-app set-up), a client's web hostname, AI (off: an install with it makes an account token and changes the account's custom AI provider, which no teardown undoes), live. After its review: the second release carries one more migration, so the upgrades migrate for real; a partial step fails the run's verdict; the teardown fails when a kind cannot be listed, lists Durable Object namespaces, and never deletes by a recorded id; `--product-file` and the switch take only a throwaway product whose every name is its own. docs/deploying.md, "Proving a host of many clients on Cloudflare" First real run (45966813610, 2026-11-27): the install and the first client passed; the second `cos client add` was refused "not the operator" by a copy of the operator's Worker still on the previous version of its token secret (cos now tries such a call again, and says so), and the teardown left 24 things because Cloudflare deletes neither a Worker that consumes a queue nor a queue that is a dead-letter queue or bound (it now removes the run's queues' consumers first; `cos uninstall` too, and it and `cos rollback` refuse a fleet).

- **The hosted product** — built — PR #553 — the owner's decision of 2026-11-27: a fleet is installed as a neutral hosted product of ours, not the CRM (ADR 0618, "The product a fleet is installed as"). `products/composable/product.ts`: id `composable`, label "Composable OS", every built pack offered (a new pack is listed or left out with a reason, tested), no apps of its own. A tag's release carries a bundle of every product (`build-release.ts --products all`, each built as it would be alone, merged by `scripts/release/merge.ts` with one `SHA256SUMS`, every bundle attested), so `cos fleet install --product composable` takes `composable-os-composable-<version>.tar.gz` from a published, attested release and makes `composable-*` Workers and stores; every later `cos fleet` and `cos client` command takes the same flag. `npm create composable-os` and a single-client `cos install` take the CRM's bundle as before (tested: what an install creates is the same from a release carrying both). After its review: a deployment records its product (`DeploymentState.product`), and the engine and every `cos` command refuse another product before anything is made (`--database` could point one at another's deployment); a fleet client has exactly the packs it is given (`cos client add` requires `COS_PACKS` and refuses `*`; none without a row, registry `blank`); `--products all` refuses `--skip-build`; preflight checks the manifest asset's product; the hosted product has no public solution page. After its re-review: a new client's packs are checked against the installed release's (an unknown pack refused, a pack's required packs named, never added silently), an export carries the client's `COS_PACKS` and an import restores and checks it (an older export needs `--setting COS_PACKS`), the staging check's step 6 compares the packs too, and a state with no product is the product its database is named for. The app's screens, the host's mail, errors and dashboards' descriptions no longer say "CRM" (scanned, tested). Every client sees the label "Composable OS" until a client's own label is held (PR #552). Follow-up, not built: the model-facing text still says "CRM" (the assistant's prompt, the judge, adjudicator, extension review, summary, widget and automation-explainer instructions, operation descriptions in the staff contract, tools' refusals; listed in docs/deploying.md "What a client sees"), a prompt change for a later PR; and a client leaving with `cos install --import` lands as the CRM product. Not run: a real release with both bundles (needs a tag), a fleet on Cloudflare as the hosted product. The fleet-operate workflow (PR #547) needs `--product composable` on every command it runs

- **Step 8** — built — PR #543 — Hostnames, `cos-front` and the namespace (a desk hostname per client included). Reduced by the owner, 2026-11-27 (the namespace waits for stage 75's spike). Built (ADR 0619; ADR 0616 "Cookies" amended): `cos fleet install` learns the zone the fleet's domain is on (`--zone`) and how its hostnames are attached (`--attach custom-domains`, the default, a Workers Custom Domain each; or `wildcard`, one `*.<domain>` route, only at a zone's apex), attaches the callback hostname, and makes `clients.<domain>` (a proxied placeholder, the zone's Cloudflare for SaaS fallback origin, routed to cos-front); `cos client add` and `import` attach the client's staff and desk hostnames (`--desk`, `<id>-desk.<domain>`) to cos-app, `remove` detaches every one in a recorded step, `pause` leaves them ("being updated"); `cos client hostname add|verify|remove|list`: a client's own web domain recorded unverified, made a custom hostname validated in real time by the client's CNAME to `clients.<domain>` (DNS only; this works for a client zone on Cloudflare in another account, where pre-validation does not), verified and routed to cos-front only once Cloudflare reports it and its certificate active and its `_cos-client` TXT names the client (no takeover of a domain already pointing at the fleet), refused under the fleet's registrable domain, at a bare domain (a subdomain, the bare domain redirected by the client: a departure from stage 46 decision 15 for the owner to confirm), on the target, on another client's hostname or domain; `--web-hostname` at add writes it unverified now (before, verified at once); `cos-front` (apps/front, `@composable-os/db/front`): the hostname looked up exactly among verified web hostnames, one plain 404 for anything else and anywhere under the fleet's registrable domain (criterion 8), "being updated" for a paused client, client-naming headers removed, security headers on every answer, bindings only the registry and two vars, its one target the holding page behind `WebTarget`, the interface stage 75 step 5 implements; the desk surface served by cos-app on a many-client host; rule (b), one same-origin check for every state-changing request at the many-client entry (`same-origin-writes.ts`, with the existing exceptions: token calls, customer-facing calls from the client's own web address or allowed origins, never a sibling's, OAuth's token and registration endpoints, non-browser callers, callbacks); rule (c), `scripts/check-host-cookies.mjs` in `pnpm lint` listing every cookie read, and the form page and Cloudflare Access made to read only `__Host-` names on a many-client host; `keepCustomerSignedIn` setting a `__Host-` session back with the `__Host-` rules (the web blocks' pictures redrawn). Two-client tests in packages/db (cos-front), apps/app (rule (b), the desk) and the fake Cloudflare API (the commands). Left: the namespace, a client's web app in it and its `ClientApp` props (waiting for stage 75's spike, then stage 75 step 5's target); nothing run on Cloudflare. The staging check (PR #541) now confirms cos's attaching instead of attaching itself, checks cos-front (step 3b, a client's own domain with `client_zone`) and tears down the run's routes, DNS records and custom hostnames. After its review (ADR 0619, "After the review of #543"): a deployment acts only on what it made, a custom hostname by the id its registry recorded (registry migration 0799) and a route only while its Worker is its own cos-front, and the `_cos-client` TXT names the environment, so a staging fleet on the live fleet's zone never takes or deletes a live client's domain (tested with both on one zone); a zone without Cloudflare for SaaS (the fleet's real zone, 1456 and 1404) installs and serves the fleet's own hostnames, sets up nothing of clients' own domains, records `clientDomains: false` and refuses a client's own domain naming the dashboard step (step 3b partial there); a dangling fallback origin replaced, and the staging check's own reset at its teardown; the cookie check scans core, db and the packs and counts reads; the fake API stricter. Follow-ups, not built: F1, a verified hostname is never checked again (its Cloudflare status and its TXT), so a lapsed domain re-registered by someone else keeps being served; F3, the 100-a-zone Custom Domain limit and the zone's route limit are not checked before an add; F4, `--attach wildcard` checks the domain is the zone's apex but not that the zone is the fleet's alone

- **Operating a fleet from GitHub** — built, not yet run — PR #547 — for step 9: `.github/workflows/fleet-operate.yml`, run by hand, one `cos` command a run against the real staging fleet (environment `fleet`) or live (`fleet-live`, the owner its required reviewer, `main` only); a fixed list of commands mapped to fixed arguments, every input checked by a job with no secret and again by `scripts/fleet-operate.mjs`; dry run by default (a command without one only planned); `--yes` only when `confirm` is the client's id (or a live upgrade's version); the keys file (`FLEET_KEYS`) only for install and upgrade, a 0600 file deleted on exit, error and signal; a client's secret value from `CLIENT_<ID>_<NAME>` by `--value-file`; never `export --out`; the repository's product from a published, attested release (`--require-gh`); anything naming the staging check's `cosstg-` refused. The hostname commands are refused until PR #543 gives cos them. After its review: every job that reads a secret first checks the environment secret `FLEET_ENVIRONMENT` (staging, live; `check` for the staging check and the client database proof, now in their own `fleet-check`), runs only from main, and pins its actions by commit; `cos fleet install` refuses an existing fleet unless version, domain and callback hostname are what is installed, and the workflow needs `confirm` = the domain and says in the dry run what is installed; a release's tag must be on main; export, hostname-verify, a live resume and take_over need confirm; identity and approval settings are never set; the keys and a secret value leave the environment before any non-Node import; an upgrade may run six hours. docs/deploying.md, "Operating a host of many clients from GitHub"

- **Step 9** — not built — needs: step 8, the first client — The first client, staging then live

- **Step 10** — not built — needs: step 7 — Usage

- **Step 11** — not built — needs: step 8, step 10 — Docs, skills and the ADR amendments

- **The first client's day one** — built — PR #552 — after step 7, for step 9 (the scoping pass's G4, G5, G8, G9 and G10; ADR 0618, "The first client's day one"; no registry migration): **the first admin** named by the operator with only its setup token's SHA-256 (`cos client add <id> --admin <email> --admin-token-sha256 <hex>`, `cos client first-admin <id> --email <email> --token-sha256 <hex>`; the token made on the owner's own machine by `cos client first-admin-token --staff-hostname <host>`, refused in CI; 72 hours; nothing of a token, a link or the address printed, so the commands can run in a public repository's workflow with no secret; `--print-link` makes and prints one at a terminal only, refused in CI; the sign-in page drops the token from the address bar once read), and on a host of many clients no first account but that address's, by password, with the link (none named: nobody); a single-client deployment unchanged, except that an installed pack's principal no longer closes its first sign-up; **`cos client setting list|set|unset`** over `COS_PACKS` (only wider, packs the installed release carries with those they require), `API_ALLOWED_ORIGINS`, `NATIVE_REDIRECT_URIS`, `APPROVAL_EXPIRY_DAYS` and `COS_PRODUCT_LABEL`, each value checked (at `add` too), every other setting refused with its reason at `add` too, the list and the checks held by the registry's own write (`setClientSetting`; `COS_FIRST_ADMIN` only through `setFirstAdmin`), no allowed origin under the fleet's registrable domain (as the host's `withoutFleetOrigins`), native redirects only `<scheme>://staff-sign-in`, cos's loopback or https on the client's own verified hostnames, and an install the runner made from an older list not held by the app; **a label per client** (`COS_PRODUCT_LABEL` a client setting, `--label`; `productName` reads the label of the client scope the code runs in); **routine mail's reply address**, the client's admin's (Settings → Routine email), the one Reply-To the email-send gatekeeper lets keep the routine kind, sign-in codes still with none. Tests: packages/auth `first-admin.test.ts`; the app's two-client `email-sending.test.ts` (the first account at gym-a and never at gym-b, each client's label on its sign-in page and in its sign-in mail); the runner's two-client `scopes.test.ts` (the label in each client's scope); packages/create-composable-os `fleet-settings.test.ts`; email-send's `routine.test.ts` and the runner's `routine-mail.test.ts` (the reply address). **Stream on a fleet** (G10): `cos fleet install --stream-account-id … --stream-customer-code … --stream-signing-key-id … --stream-token-file … --stream-jwk-file …`, the ids kept in the deployment's state and the token and key the app Worker's secrets, kept by `cos fleet upgrade` (packages/create-composable-os `fleet-stream.test.ts`); one Stream account kept apart per client by the creator-checked video host (the app's two-client `caches.test.ts`). The staging check makes each client's setup token itself, masks it before any cos call and gives cos only its hash (tested through the real cos runner). An import re-stamps no video: one the imported database names that is not already the client's (no creator, another's, unreadable) refuses it, the client left paused (ADR 0618). Not built: a safe move of a client's videos between deployments (it needs the named client checked in its own environment's registry, `live:*` refused on staging, and an explicit opt-in for unstamped videos). Not run on Cloudflare

- **The operator's workflow for a client's first day** — built, not yet run — the follow-up to PR #547 (reviews of #552, S-W1 and S-W2, and of #553) — `.github/workflows/fleet-operate.yml` and `scripts/fleet-operate.mjs`: `client-add` takes its packs (`COS_PACKS` required and never `*`, refused at input checking), a `label` and a first admin (`admin_token_sha256`, a hash from `cos client first-admin-token` on the owner's machine, with the address from the environment secret `CLIENT_<ID>_ADMIN_EMAIL`, never an input; refused before cos without it, and for a client id with a hyphen), and waits for the new staff hostname (never `--no-wait`; the hour covers its 15 minutes; a hostname still not answering, which cos now marks with a fixed line, is said first in the run's log and summary); `client-first-admin` (confirm: the client's id); the settings commands with `COS_PACKS` never unset nor `*`, and only the settings an operator writes; `fleet-install` passes Stream's five flags when the environment has them (the account id, token and key as secrets, the customer code and key id as variables; all or none; the token and key by 0600 file, masked); the `<client id>:<NAME>` confirm follows the registry's own `policy` mark on `OPERATOR_SETTINGS`. The admin's address is cut from all output, never in the command line shown, redacted in the summary; cos runs with `CI=true`; `--print-link`, `first-admin-token`, `--show-email` and `--adopt` are never mapped. Not done: building cos in a job without secrets (the job with them still installs the dependencies the script imports). docs/deploying.md, "A client's first day" and "Operating a host of many clients from GitHub"
