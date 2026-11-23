# Stage 47: One host, many clients

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

Status: **proposal.** The owner chose the design on 2026-11-23 (decisions 1 to 6). The questions
at the end are open. Build step 1 repeats the spike on Cloudflare and needs none of them.

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
| 4 | Workers for Platforms is not the layout. Its checks are recorded in stage 46: a host's own Workers cannot be bound to each other, consume queues or run Workflows inside a namespace. Routing all three through a fleet Worker was tested and works, and was not chosen |
| 5 | A set of Workers per client (built today) is not the layout for hosted clients either: it does not fit dozens of gyms |
| 6 | Stage 46's decisions 13 to 22 stand: hostnames on `composableos.app`, the fleet's account, usage reported before limits are set, a moved client's old copy kept 90 days, our repositories while a client is hosted, and the leaving promise |

## The design in one page

```
 customer ─► gym-a.com ─► standard web app ─┐
 customer ─► ghetto.com ─► Ghetto's web app ─┤ HOST binding, the client fixed on the binding
 staff ────► gym-a-admin.composableos.app ───┤
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

This amends ADRs 0008, 0151 and 0428 for a many-client deployment (question 2). A single-client
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
every client, and a dynamic Worker holds nothing of a client between runs.

**Stream:** the host stamps each upload with the client as its `creator` and refuses any call for
a video with another creator. With one host there is one holder of the token and no broker.

### Module-level caches

Every cache listed under "What exists today" is keyed by client or moved into the client's
environment. Auth's caches are keyed by the `env` object, so they are correct as soon as each
client's environment is one stable object per isolate.

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
- **`cos deploy`** in a hosted client's repository uploads its web app (with the client fixed on
  its `HOST` binding), stores its own extensions and updates its registry settings. It never
  uploads the host.
- **An update of the host** is the deploy engine's update, with the database steps done for every
  client: pause, then for each client bookmark and migrate, then upload the Workers once, smoke
  check, resume. A client whose migration fails is restored to its bookmark and the update stops
  before the upload. After the upload, a failed smoke check uploads the previous Workers and
  restores every client's bookmark.
- **The host refuses a request for a client whose schema is behind the code,** with a "being
  updated" page, where today it only reports it.
- **Staging first:** a second deployment, `staging`, holds every client's staging environment. An
  update goes there, then to live (question 4).
- **`cos client export`, `cos client import`, `cos client remove`:** the database as SQL, the
  client's files, its videos by creator, its secrets. Export then install in the client's own
  account is the leaving promise; a removed client's export is kept 90 days.

### What is not shared

A client's own web app is its own Worker, as today. A client's own extensions are data in the
host, run by Worker Loader. A client in its own Cloudflare account runs the same release as a
single-client deployment.

## Out of scope

- **The standard web app and signing a gym up from settings.** The standard product's own
  interview and stage, next. This stage makes the host able to hold them.
- **Holding one client on an older release** (question 1).
- Charging for usage, and limits.
- Moving the single-client deployment off D1.
- Selling the hosted CRM by sign-up, and the stage 10 control plane, which is unchanged.
- Workers for Platforms.

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
9. A client's own web app, through its `HOST` binding, can reach only its own client, whatever
   hostname or header it sends.
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
decisions 13 and 14). Nothing here needs Workers for Platforms.

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
8. **Hostnames:** `composableos.app` addresses, then custom hostnames for a client's own domain.
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
- **Worker Loader ids are not per client.**
- **Gatekeeper callbacks use one address per deployment.**
- **The host refuses requests for a client whose schema is behind.**
- **Packs are the product's:** every client of a deployment has the product's packs, or a subset
  set in the registry. What only one client needs is that client's own extension.

## Questions for the owner

1. **Is holding one client on an older release needed at the start?** With one deploy for
   everyone it needs a second copy of the live host and a router in front. Proposed: no. Updates
   go to staging first, and a client whose own extensions fail the new release's checks stops the
   update before live; the extensions are in our repositories, so we fix them.
2. **May a client's given secrets (Stripe keys, their own Google sign-in, their own AI keys) be
   stored encrypted in the registry?** Today the rule is that these are Worker secrets only. With
   one set of Workers there is no per-client Worker to hold them. Proposed: yes, encrypted under a
   key only the host's `env` holds, written only by the operator's command, never readable by an
   operation or the assistant.
3. **Does a client in its own account, and a self-hosted install, stay on D1 as today?**
   Proposed: yes.
4. **Is staging a second deployment holding every client's staging environment?** Proposed: yes.
   It is also where each release runs before live.
5. **Does the first client start with its own web app and its own repository** (the bespoke tier,
   on the shared host), with the standard web app and settings-only gyms as the next stage?
   Proposed: yes.
6. **Shall Workers for Platforms be switched off?** Nothing in this design uses it. Proposed: yes.
