# ADR 0611: One host, a database per client

Status: accepted, 2026-11-23 (the owner's answer to "One host for the standard product?", after
the checks of stage 46's step 1 and the spike on `spike/one-host`). Amends
[ADR 0610](0610-three-homes-for-a-client-hosted-by-default.md) and
[ADR 0001](0001-self-hosted-single-org.md). Designed in
[stage 47](../stages/47-one-host-many-clients.md); nothing here is built yet.

## Context
ADR 0610 hosted client products in our account, in a Workers for Platforms dispatch namespace,
each client with its own Workers and database. Three things were learned the same day.

- **A namespace does not fit the host** (stage 46, step 1, on a real namespace). Worker Loader
  and scheduled calls work there. Service bindings between two namespace Workers are refused,
  a namespace Worker cannot consume a queue, and Workflows cannot be created for one. Routing all
  three through an ordinary Worker of ours was then tested and works, at the cost of a host that
  runs in one shape when hosted and another in a client's own account.
- **The owner expects dozens of gyms on one standard product,** and wants the first client to be
  that standard if it can.
- **The platform's database code does not depend on D1 itself,** only on the `D1Database`
  interface. A Durable Object with SQLite storage placed behind that interface carried all of
  `packages/core`'s tests unchanged (152 files, 4,088 tests), locally.

A Worker's D1 bindings are fixed when it is uploaded, so one Worker cannot open a different D1
database for each client. It can open a different Durable Object for each.

## Decision
- **Hosted clients share one deployment of the host.** The app, the runner and the gatekeepers
  are deployed once, as ordinary Workers, and serve every hosted client.
- **Each client's records are in a database of its own:** a Durable Object with SQLite storage,
  opened by client on every request, behind the interface the platform already uses.
- **No client's data holds its client id.** ADR 0001's rule is kept in the form that matters: no
  table gains a tenant column. The client exists only in the host's registry, in names and in key
  prefixes, as the tenant id of ADR 0210 did.
- **The registry is the deploy-time setting, per client.** Policy, identity settings and secrets
  that are per organisation today move from the Worker's environment to a registry only the
  operator can write. No operation, extension or assistant reaches it.
- **A single-client deployment is the host as built today,** on D1. Self-hosted installs and a
  client in its own Cloudflare account run that way.
- **The three tiers of ADR 0610 stand.** Standard and bespoke clients are both clients of the
  shared host; a bespoke client adds its own web app and extensions. The own-account tier is a
  single-client deployment.
- **The host does not run per client,** neither in a Workers for Platforms namespace nor as a
  set of ordinary Workers for each hosted client.
- **Workers for Platforms holds a client's own code that has to be a Worker:** a bespoke
  client's web app now, one Worker each, calling the shared host with the client fixed on its
  binding; a client's own gatekeeper later. This is the use the product is made for: our Worker
  calling, or being called by, one Worker of a customer's code.

## Consequences
- **One deploy reaches every client.** A bad release does too. Updates go to a staging deployment
  first, and no client is held on an older release (stage 47's decision 7).
- **Separation of clients' files, search, queues and key-value data is the host's work,** not
  Cloudflare's: prefixes, namespaces and stamps added by wrappers at one seam. A client's
  database is separate by construction.
- **Anything cached at module level can leak between clients.** Each such cache is keyed by
  client, and the suite is run with two clients in one isolate.
- **ADRs 0008, 0151 and 0428 are amended** for a many-client deployment (the owner's answer of
  2026-11-23, stage 47's decision 8): auth secrets are derived per client from one secret in the
  environment, and a client's given secrets are stored encrypted in the registry, written only by
  the operator.
- **A client's database holds 10 GB at most** and handles one query at a time.
- **The deploy engine's database steps change:** bookmark, migrate and restore are done for each
  client through the host, where today they are done over D1's REST API.
- **Stage 46 is replaced in large part** by stage 47. Its decisions 13 to 22 stand. Its step 1
  results are the record of why the namespace was not used.
- **Not yet proved:** the result on Cloudflare itself, the app's and the runner's suites, and the
  time a request takes when each query crosses to a Durable Object. Stage 47's first build step.
