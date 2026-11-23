# Stage 46: Hosted clients

Read first: [`AGENTS.md`](../../AGENTS.md), [`docs/architecture.md`](../architecture.md)
(Deployment, Hosted SaaS, Client repos), [`CONTEXT.md`](../../CONTEXT.md) (Deployment, Hosted
deployment, Control plane, Release), ADRs [0001](../adr/0001-self-hosted-single-org.md),
[0163](../adr/0163-deploy-engine-over-the-cloudflare-api.md),
[0191](../adr/0191-saas-and-enterprise-model.md),
[0210](../adr/0210-hosted-deployments-on-workers-for-platforms.md) to
[0215](../adr/0215-staged-rollouts.md), [0250](../adr/0250-deployment-to-control-plane-channel.md),
[0422](../adr/0422-client-repos-and-one-command-as-built.md),
[0450](../adr/0450-client-environments.md) and
[0610](../adr/0610-three-homes-for-a-client-hosted-by-default.md);
[`docs/saas-go-live.md`](../saas-go-live.md) (section 2, the checks); `packages/release/src/`
(`deploy.ts`, `cloudflare.ts`, `install.ts`, `update.ts`),
`packages/create-composable-os/src/client-repo.ts` and `main.ts`, `packages/product/src/index.ts`,
`products/crm/apps/control/src/` (`dispatch/`, `instances.ts`, `rollout.ts`, `lifecycle.ts`,
`metering.ts`).

Status: **proposal.** The owner's interview of 2026-11-23 settled the decisions below (ADR 0610).
The questions at the end are open, and build steps 2 onward wait for them. Build step 1, the
checks on a real namespace, needs only the Workers for Platforms subscription and can start once
it is on.

## Goal

A client's product runs in our Cloudflare account by default. `cos deploy`, run in the client's
repository, puts its host and web app in our Workers for Platforms namespace. One command updates
every hosted client to a new platform release. A client can be moved to its own Cloudflare account
with all its data, and the first client is moved the other way, from its own account into ours.

## What exists today (from the code)

- **The deploy engine targets a namespace** when `DeploymentState.dispatchNamespace` is set
  (`packages/release/src/deploy.ts`). `scriptsApi` sends script calls to the namespace;
  `deployWorkers` uploads each Worker whole with `tags`, and skips crons, workers.dev and custom
  domains. Queue consumers are still attached through the account-level call with the script name.
  `installRelease`, `runUpdate` and `runRollback` follow the state and have no namespace logic of
  their own. A namespace has no versions, so an update is a live re-upload; the D1 bookmark and
  the smoke check still apply.
- **Deployment state lives in the deployment's own database** (`core_install`, key `deployment`).
  `locateDeployment` finds it by the database's name.
- **`cos deploy` has no hosted target.** `install()` sets `hostnameMode` to `workers.dev` or
  `custom`, never `dispatch`, and never sets `dispatchNamespace` or `tags`. `deployWeb` uploads the
  web app as an ordinary Worker in the account, with one binding, `HOST`, a service binding to the
  app Worker's `ClientApp` entrypoint, and attaches its hostname with a Custom Domain on a zone in
  the same account.
- **`defineClientProduct`** has `environments`, `web`, `mobile`, `gatekeepers`, `names` and
  `location`. It has no field for where the product is hosted. A client product's Workers and
  resources are already named from its id and environment (`<id>-app`, `<id>-<env>-app`, the
  `<id>` database), so two clients never share a name.
- **The control plane** (`products/crm/apps/control`) has the pieces a fleet needs, tied to the
  CRM sold by sign-up:
  - `crm-dispatch` looks a hostname up in the `ROUTES` KV namespace and calls that tenant's app
    Worker with limits; its minute cron reads a `schedule` key and calls `scheduled()` on tenants'
    Workers (marked "verify at go-live").
  - `rollout.ts` updates instances in waves through `runUpdate`, pauses on failures, resumes or
    rolls back. It has no hold on one instance.
  - `lifecycle.ts` exports (a D1 dump link and a seven-day read token for the bucket) and destroys.
  - `metering.ts` measures AI only, from the shared gateway's logs by tenant tag.
  - Provisioning gives a tenant no packs setting, no org extensions, no label, no gatekeepers and
    no web app. One instance per account; plans, Stripe and sign-up throughout.
- **One host is** the app Worker (D1, R2, KV, two Durable Object classes, a queue consumer, two
  crons), the runner (D1, R2, five Durable Object classes, two Workflows, a queue consumer, a
  minute cron, and the only **Worker Loader** binding) and the chosen gatekeepers (some with
  Durable Objects, `email-send` with a `send_email` binding). Service bindings: app to runner,
  runner to each gatekeeper, and the web app to the app Worker.
- **Stream is reached with an account token** (`STREAM_API_TOKEN`, `STREAM_ACCOUNT_ID`), not a
  binding. Uploads carry a name only: nothing says whose a video is.
- **Never verified on a real namespace** (`docs/saas-go-live.md`, B2 to B6): service bindings
  between two namespace Workers, queue consumers, Worker Loader, Workflows, and `scheduled()`
  called from the dispatch Worker.
- **Not anywhere:** a way to move a deployment between accounts, an export of a whole deployment
  (Durable Object storage, KV, secrets and videos are in no export), per-client measurement of
  anything but AI, a hold on one deployment's version.

## Decided at the interview (2026-11-23)

| # | Decision |
| --- | --- |
| 1 | The default home of a client product is a Workers for Platforms namespace in our Cloudflare account |
| 2 | Three tiers: **standard** (settings only, no repository, a shared web app), **bespoke** (own repository, web app and extensions), **own account** (the exception) |
| 3 | Clients are kept apart by data: each has its own host and database on every tier. No tenant id. Only the AI gateway and a standard product's web app are shared |
| 4 | `cos deploy` gains a hosted target, driven from the client repository. The stage 10 control plane is not used for clients |
| 5 | We set the platform version of the hosted fleet: one command, environments that are not live first, with a hold that can be put on one client |
| 6 | A client can move to its own Cloudflare account at any time, with its data |
| 7 | Own account when: the client or its contract asks; compliance or data ownership rules; the client wants more control or to write more code itself |
| 8 | A standard client is settings only until it goes bespoke, then it gets a repository. A bespoke client always has one |
| 9 | Cloudflare usage is included in the subscription up to a fair-use limit, measured per client |
| 10 | The first client moves from its own account into ours, staging and live together, and stays bespoke |
| 11 | The first standard product is built from the first client's setup, with what is only that client's left in its own extensions |
| 12 | No trial on a real namespace before deciding. The first build step is that trial |

## The design in one page

```
 customer ─► www.<client domain> ─┐
 staff ────► admin.<client domain>┤
                                  ▼
                            cos-dispatch ──(KV host:<hostname>, written only by the fleet)──┐
                              │ minute cron: each hosted host's crons                       │
                              ▼                                                             ▼
                            cos-fleet                                namespace cos-clients
                              registry, fleet update,                  <id>-web ─HOST─► <id>-app ─► <id>-runner ─► <id>-gatekeeper-*
                              usage, Stream broker                     <id>-staging-web … (each environment its own host)
                                                                       own D1, R2, KV, queues, Durable Objects per host
```

- **The namespace** is `cos-clients`. A client's Workers keep the names `product.ts` gives them
  today; the namespace is what separates them from our own Workers. Every script is tagged
  `client-<id>` and `env-<env>`.
- **Two platform Workers,** in a new `apps/fleet`, belonging to no product:
  - `cos-dispatch` receives every request for a hosted hostname, looks it up in KV and calls the
    script it names. It never derives a script from the Host header (ADR 0210's rule).
  - `cos-fleet` holds the registry and does the work that needs our account's authority.
- **The generic parts of the control plane move** into a package (`packages/fleet`): the dispatch
  handler, the cron fan-out, the rollout engine. The CRM's control plane then imports them. Its
  sign-up, plans and Stripe code stays where it is.

## The model

### Where a product is hosted

`defineClientProduct` gains `hosting`:

```ts
hosting: "fleet"            // our account, our namespace
hosting: "account"          // the account of the token: today's behaviour, and the default
```

- An environment may not override it: one client is in one place.
- `cos deploy` reads which fleet from the operator's configuration (account id, namespace, fleet
  URL), never from the client repository. A client repository holds no account id.
- A product without the field deploys exactly as today.

### The registry

One record per hosted host (a client's environment), in `cos-fleet`'s own database:

| Field | Meaning |
| --- | --- |
| `client`, `environment` | The product id and environment name. Together, the key |
| `tier` | `standard` or `bespoke` |
| `repository` | The client repository that deploys it (bespoke). A deploy from another repository is refused |
| `database` | The host's D1 id, where its deployment state lives |
| `version` | The platform version it runs |
| `hold` | Unset, or a reason and who set it |
| `live` | Whether it is a live environment (decides its place in a fleet update) |
| `hostnames` | Those routed to it, each with its script and whether it is verified |
| `crons` | Its Workers' cron expressions, from the release manifest |

The registry holds no client data. It is rebuilt from the namespace's tags and each host's
deployment state if lost.

### `cos deploy` to the fleet

In a repository whose product says `hosting: "fleet"`:

1. Everything `cos deploy` checks today, in the same order, before anything changes.
2. It asks the fleet for the host's record. **None: a first deploy.** The host is installed with
   `installRelease` at the fleet's current version, with `dispatchNamespace`, the tags,
   `hostnameMode: "dispatch"`, no AI gateway of its own (Platform AI, ADR 0213), and the names,
   label, packs, org extensions, customer sign-in and gatekeeper settings exactly as today.
3. **A later deploy** changes only what is the client's own: the web app, org extensions, packs,
   label, gatekeeper settings and hostnames. It never changes the host's platform version.
4. The web app is uploaded into the namespace with its `HOST` binding to the app Worker.
5. The fleet records the host and its hostnames, and publishes routes for those that are verified.

`cos deploy` refuses when the repository's `platform.version` is newer than the host's (the fleet
must be updated first) and warns when it is older. `cos upgrade` in a hosted client's repository
moves the repository only.

### Hostnames

- Every host gets a hostname on a domain of ours for its staff address, and one for its web app
  (question 1). They work at once and need nothing from the client.
- **A client's own domain** is added one of two ways, chosen by where its DNS is:
  - its zone is in our account: a Worker route on that zone to `cos-dispatch`;
  - its zone is elsewhere: a Cloudflare for SaaS custom hostname on our domain, which the client
    points a CNAME at. The route is published only once Cloudflare reports the hostname active.
- An apex hostname (`example.com` with no `www`) needs the client's DNS to allow a CNAME there.
  Where it cannot, the apex redirects to `www`.

### Crons, queues and Workflows

- `cos-dispatch`'s minute cron calls `scheduled()` on each hosted Worker whose cron matches,
  from the registry's `crons`. A host on hold, or being moved, still gets its crons.
- Queue consumers and Workflows are attached by the deploy engine as today.
- Each depends on a check in build step 1.

### The fleet update

`cos fleet update <version>`:

1. The release is verified as for any install.
2. For each host not on hold, the new release's checks run on its org extensions (their source is
   in its bucket). **A host whose extensions fail is put on hold by the update,** with the failure
   as the reason, and reported.
3. Hosts that are not live are updated first, each through `runUpdate` (bookmark, migrations,
   upload, smoke check, restore on failure).
4. After a pause to look, live hosts are updated the same way. A failure stops the run; hosts
   already updated stay updated, and `cos fleet rollback` returns chosen hosts to the previous
   release and bookmark.
5. `cos fleet status` lists every host with its version, hold and last update.

`cos fleet hold <client> --reason "…"` and `cos fleet release <client>` set and clear a hold. A
held host is never more than one contract version behind: when a release ends support for the
contract version a held host is on, the update refuses to start until the hold is resolved.

### Moving a host between accounts

`cos move <client> --to <account>` (and `--to fleet`). One move covers every environment named.

What has to travel, and how:

| What | How |
| --- | --- |
| The database (D1) | Export from the source, import at the destination |
| Files (R2) | Copied object by object, hashes compared |
| Key-value data (KV) | Listed and copied |
| Durable Object storage (assistant, extension workspaces, integration connections, payment and webhook events) | Each class gains an export and an import the host runs for the move; storage cannot be read from outside |
| Secrets (auth secrets, encryption keys, customer sign-in secret, provider keys) | Cloudflare never returns a secret. The source host hands each to the move over a signed, one-use channel; they are never written to disk or printed |
| Search index (Vectorize) | Rebuilt at the destination from the records |
| Videos (Stream) | Copied to the destination account by Stream's copy-from-URL; records updated with the new ids |
| Queues and Workflows | Not moved. The source stops taking writes and the move waits for both to drain |
| Deployment state | Written fresh by the install, then the bookkeeping that still applies is carried |

The order protects the running host:

1. Install the same release at the destination, with no hostnames routed.
2. Copy files and videos while the source keeps running. These are large and can be repeated.
3. **Stop writes at the source** (the kill switch `runUpdate` already uses). Drain queues and
   Workflows.
4. Copy the database, key-value data, Durable Object storage and secrets. Copy what changed in
   files since step 2.
5. Check the destination: record counts per object, file hashes, a sign-in as a staff user and as
   a customer, the smoke check.
6. **Switch last:** the hostnames, then payment and other provider webhooks.
7. The source stays stopped and untouched for a set time (question 4), then is removed by a
   separate command. Until then `cos move --back` restores service from the source.

Sessions survive a move because the auth secrets travel. A customer who is mid-checkout at step 3
sees the site unavailable for the length of steps 3 to 6.

### What is shared, and how it is kept safe

- **Platform AI:** as ADR 0213. A host's token can only run Workers AI through the shared gateway.
- **Stream:** a hosted host gets no Stream token. It calls a broker in `cos-fleet`, which stamps
  every upload with the client as its `creator` and refuses any call for a video with another
  creator. The same seam the host uses for Stream today, with a second backend.
- **Email sending:** each client sends from its own verified domain, as today.
- **Anything else account-wide** is handled the same way before a hosted host may use it: a token
  that can reach another client's data is never given to a host.
- `cos-dispatch` calls each host with CPU and subrequest limits, as `crm-dispatch` does.

### Usage

A daily job in `cos-fleet` records per client: Worker requests and CPU time, database size, stored
files, Stream minutes stored and delivered, and AI spend. `cos fleet usage` prints the month so
far against the fair-use limits (question 3). This stage measures and reports. It does not charge
or cut anything off.

### Who may deploy

Deploying to the fleet needs a token on our account, which cannot be limited to one client's
Workers. So a hosted client's deploys run with our token: from our machines, or from the client
repository's CI with a secret we add. A client that wants to deploy with its own token goes in its
own account (decision 7).

## Out of scope

- **The standard product** and signing a standard client up from settings (decisions 2, 8, 11).
  It has its own interview and stage. This stage leaves room for it: the registry's `tier`, and
  a namespace in which several hosts may run one release.
- Charging for usage over the limit, and any automatic limit.
- Selling the hosted CRM by sign-up (ADR 0465 leaves it undecided). The CRM's control plane keeps
  working against fakes.
- A console in the browser for the fleet. The commands are enough for the first clients.
- Moving a host between two clients' accounts, or splitting one host in two.

## Acceptance criteria

1. Each check of build step 1 has a recorded result on a real namespace, and for each failure the
   fallback is chosen and written into ADR 0610 as a dated amendment.
2. `cos deploy` in a repository with `hosting: "fleet"` installs a host and its web app in the
   namespace. Staff sign in at its hostname, a customer signs in on the web app, a pack's records
   can be created, an org extension runs, and a scheduled automation fires.
3. A second deploy from the same repository changes the web app and an org extension and leaves
   the host's platform version alone.
4. A deploy from a different repository naming the same client id is refused before anything
   changes.
5. A request for a hostname that is not in the routes reaches no client's Worker. No request can
   reach a client's runner or gatekeepers from outside.
6. `cos fleet update` moves two hosted clients to a new release, the environment that is not live
   first. A client on hold is skipped and listed. A client whose org extension fails the new
   release's checks is put on hold with the reason.
7. A fleet update that fails the smoke check on one host restores that host's previous release and
   database, and stops.
8. A host with a Stream video cannot read, list or delete another client's video through the
   broker, and holds no token that could.
9. `cos move` carries a host with records, files, a video, a connected provider account, an
   installed extension with stored state and signed-in staff and customers to another account. At
   the destination every record count and file hash matches, the staff and customer sessions still
   work, the provider connection works, and the search index answers.
10. A move that fails at any step before the switch leaves the source serving as before.
11. `cos move --back` after a completed move restores service from the source.
12. The first client's staging and live hosts run in the fleet, on its own domain, with payments
    taken and the provider's webhooks received, and its old hosts are stopped.
13. `cos fleet usage` shows, per client, requests, database size, stored files, Stream minutes and
    AI spend for the month.
14. A product without `hosting` deploys exactly as before: the installer's and `cos deploy`'s
    existing tests pass unchanged.
15. `docs/architecture.md`, `CONTEXT.md` and `docs/first-deploy.md` describe hosted clients; a
    skill covers moving a client (`skills/move-client/SKILL.md`), and `start-client-app` says how
    to choose where a product is hosted.

## Dependencies

Stages 8, 10 and 24. A Workers for Platforms subscription on our account, and a domain of ours
for hosted hostnames (question 1). Nothing here waits for stages 31 to 45.

## Migrations and numbers

Block AU in [`docs/parallel-work.md`](../parallel-work.md): ADRs 0610 to 0619 (0610 used),
migrations 0790 to 0809. The fleet's own database has its own migrations in `apps/fleet`, like the
control plane's.

## Suggested build order

1. **The checks.** On the real namespace, with a throwaway host: Worker Loader in a namespace
   Worker; a service binding between two namespace Workers, to a named entrypoint (`ClientApp`,
   `GatekeeperVendor`); a queue consumer; Workflows; `scheduled()` from the dispatch Worker; a
   namespace Worker reaching an ordinary Worker in the account (the broker). Record each result.

   | If this fails | Then |
   | --- | --- |
   | Worker Loader | The runner cannot run in a namespace. Every host's Workers are ordinary Workers in our account (ADR 0210's `account` placement, at most 500 scripts) and the namespace is not used |
   | Service bindings between namespace Workers | The same fallback, unless bindings to named entrypoints fail and plain ones work: then calls go through `fetch` on the binding |
   | Queue consumers or Workflows | The Worker that needs them is an ordinary Worker; the rest stay in the namespace only if bindings across the boundary work |
   | `scheduled()` from dispatch | A signed `POST` to a path on the host that runs its scheduled handler |
   | Reaching an ordinary Worker | The broker is called over HTTPS with the signed channel of ADR 0250 |

2. **`packages/fleet`, `apps/fleet`:** the dispatch Worker, the registry, routes, the cron
   fan-out, lifted from the control plane, which then imports them.
3. **`hosting` in `product.ts` and the hosted target of `cos deploy`,** the web app included, on
   hostnames of ours. Criteria 2 to 5 and 14.
4. **Client domains:** routes on a zone of ours, custom hostnames for a zone elsewhere.
5. **The fleet update, holds and rollback.** Criteria 6 and 7.
6. **The Stream broker.** Criterion 8.
7. **The move:** export and import on each Durable Object class, the secrets hand-over, then the
   command. Criteria 9 to 11.
8. **The first client's move,** staging and live in one run, after a rehearsal against a copy.
   Criterion 12.
9. **Usage.** Criterion 13.
10. Docs and skills. Criterion 15.

Steps 3 to 6 and step 7 can run side by side after step 2.

## Decided by this spec, open to override

- **Client hosts keep their `product.ts` names** in the namespace; no `t…` tenant ids. A client id
  is unique in the fleet.
- **No control plane for clients:** two Workers and commands, no sign-up, plans or console.
- **A fleet update checks each client's org extensions against the new release first** and holds
  a client that fails, so one client's code never stops the others' update.
- **A held host may lag by one contract version at most.**
- **A hosted host gets no Stream token;** Stream goes through a broker.
- **The move stops writes for its last steps.** A move with no stop would need two hosts writing
  to one set of records, which the platform does not have.
- **The source of a move is kept, stopped, until removed by hand.**
- **The registry is in `cos-fleet`'s own database,** rebuilt from tags and deployment states if
  lost.

## Questions for the owner

1. **Which domain of ours carries hosted hostnames?** Each host gets `<client>.` and
   `<client>-admin.` on it before the client's own domain is connected. It should be a domain used
   for nothing else, so a client's pages can never set cookies for our own sites.
2. **Where is the first client's DNS, and does its site use the apex** (no `www`)? This decides
   whether its domain is routed by moving the zone into our account or by custom hostnames.
3. **What are the fair-use limits?** At least: stored video minutes, delivered video minutes,
   stored files, and AI spend per month. Usage is only reported in this stage, so a first guess is
   enough.
4. **How long is a moved host's source kept,** stopped, before it is removed? Proposed: 30 days.
5. **How long may the first client's site be read-only or unavailable during its move,** and at
   what time of the week? The length depends on the size of its data; a rehearsal gives the number.
6. **Who deploys a hosted bespoke client?** Proposed: us, and the client repository's CI on merge
   to `main` with a secret we add. The client's own developers do not hold the token.
7. **Does the first client hold its own Stream videos and Stripe account today?** Stripe stays the
   client's own account on every tier. Videos would move into our Stream account with the host.
