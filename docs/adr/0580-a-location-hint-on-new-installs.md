# ADR 0580: A location hint on new installs

Status: accepted, 2026-11-23 (stage 43, build step 1). Extends
[ADR 0163](0163-deploy-engine-over-the-cloudflare-api.md) (the deploy engine) and
[ADR 0422](0422-client-repos-and-one-command-as-built.md) (`product.ts` and `cos deploy`). Stage 43's spec,
"Privacy and where the data is kept", decision 24 (the owner's answer of 2026-11-23: new installs
ask Cloudflare to store data in Oceania where it can, a preference and not a guarantee).

## Context
A business working with outside practitioners keeps health information on its host (stage 43).
Australia's privacy law does not require such information to stay in Australia, but the owner
wants new hosts to prefer Oceania. The deploy engine created every D1 database and R2 bucket with
a name only, so Cloudflare placed them itself.

Cloudflare's documentation, read on 2026-11-23:
- **D1** ([data location](https://developers.cloudflare.com/d1/configuration/data-location/),
  [create database API](https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/create/)):
  the create call takes `primary_location_hint`, one of `wnam`, `enam`, `weur`, `eeur`, `apac`,
  `oc`; "does not guarantee that D1 runs in your preferred location"; given at creation. Omitted:
  "as close as possible to the current user". A `jurisdiction` (`eu`, `us`, `fedramp`) overrides
  the hint. With read replication on, replicas are made in every available region.
- **R2** ([data location](https://developers.cloudflare.com/r2/reference/data-location/),
  [create bucket API](https://developers.cloudflare.com/api/resources/r2/subresources/buckets/methods/create/)):
  the create call's body takes `locationHint`, the same six values, lower case; "a best effort and
  not a guarantee"; "only honored the first time a bucket with a given name is created".
  Jurisdictions (`eu`, `us`, `fedramp`) are a header, `cf-r2-jurisdiction`.
- **Durable Objects** ([data location](https://developers.cloudflare.com/durable-objects/reference/data-location/)):
  a hint (`oc` among others) is passed in code, `namespace.get(id, { locationHint })`, honoured by
  the first `get()` of each object only; without one an object is made "close to where the initial
  `get()` request is made"; objects do not move after creation. Nothing is set at deploy time.
- **KV** ([create namespace API](https://developers.cloudflare.com/api/resources/kv/subresources/namespaces/methods/create/))
  and **Queues** ([create queue API](https://developers.cloudflare.com/api/resources/queues/methods/create/)):
  a `jurisdiction` only, no location hint. **Vectorize**
  ([create index API](https://developers.cloudflare.com/api/resources/vectorize/subresources/indexes/methods/create/)):
  no location setting at all.

There is no Australian jurisdiction.

## Decision
- **A hint, chosen at the first install.** `cos install --location <hint>` (`none`, or one of the
  six values both D1 and R2 take), asked interactively with `none` as the default; for a client
  repo, `product.ts`'s `location` (an environment may set its own, or `"none"`), which `cos deploy`
  always passes, so a client host's location is its `product.ts`'s and the installer never asks.
  The list is `LOCATION_HINTS` in `@composable-os/product`, re-exported by `@composable-os/release`.
  The choice is kept in the deployment state (`locationHint`) and shown by `cos status`.
- **Sent only on create.** `provisionResources` takes `{ locationHint }` and passes it to
  `createD1` (as `primary_location_hint`) and `createR2` (as `locationHint`) for a database or
  bucket it creates. One found by name is used as it is, and no call is made to it. KV, queues and
  Vectorize are created as before: their APIs take no hint.
- **Upgrades and repairs.** An upgrade creates only the resources a new release adds, with the
  hint recorded at install; a repair re-creates a missing one the same way. A deployment that
  exists keeps its recorded hint whatever is passed: given another `--location` (or a `product.ts`
  location added later), `cos install`, `cos deploy` and `cos upgrade` say plainly that a setting
  cannot move a database or a bucket, and change nothing. Moving one is an export into a new
  install, which no command does.
- **No hint by default.** Without a choice nothing is sent, so existing installs and other regions
  behave exactly as before.
- **Durable Objects: not done.** The hint is per object and per first `get()`, in code, across
  every namespace the host and the runner use (the assistant, operations, the workspace, the code
  gate, integrations, and the Agents SDK's own); doing it correctly means a hint threaded to each
  call site and kept in step as new ones are added. Cloudflare's default already places an object
  near its first request. Left for later, and documented as not covered.
- **Jurisdictions are out of scope.** `eu`, `us` and `fedramp` are hard limits with other effects
  (a jurisdiction endpoint for R2, a binding setting); none is Australian. They are not offered.
- **Said plainly.** `docs/deploying.md` ("Where data is stored") says what the hint is (a
  preference, not a guarantee), what it covers (D1 and R2, at creation) and what it does not (KV,
  queues, Vectorize, Durable Objects, logs, backups, read replicas, model providers), and that it
  is not a promise that data stays in Australia. The checkout path (`pnpm run deploy`, where
  wrangler creates the stores) sends none; the docs give wrangler's own `--location` for it.

## Consequences
- A new host asked for Oceania has its database and buckets created with `oc`, proved against the
  fake Cloudflare API, which records each create's hint and refuses a value the real API would.
- Nothing about an existing host changes. A host made before this ADR records no hint and keeps
  none.
- The consent text stage 43 shows a client says the data may be stored overseas; this hint does
  not change that sentence.
