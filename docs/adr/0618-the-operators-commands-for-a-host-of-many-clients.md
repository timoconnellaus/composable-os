# ADR 0618: The operator's commands for a host of many clients

Status: accepted, 2026-11-27 (stage 66 step 7, `feat/stage-66-client-commands`). Builds on
[ADR 0613](0613-the-registry-and-the-clients-environment.md) (the registry; "Step 7: writing the
registry"), [ADR 0614](0614-clientdb-finished.md) (migrations, bookmarks, restore, export and import
of a client's database), [ADR 0615](0615-every-entry-decides-the-client.md) ("What a many-client
deployment binds": the list built here) and [ADR 0616](0616-secrets-and-addresses-per-client.md)
("For step 7"). Closes items F2 and F4 of issue #523.

## Context
Steps 1 to 6 made a host that can serve many clients once its registry holds them and its Workers
carry a fleet's bindings. Nothing yet wrote the registry, made a client's database, deployed a
fleet, rolled a release across clients, took a client out or brought one in. Cloudflare's REST API
reaches D1 (the registry) and Workers, but not a Durable Object: a client's database (`ClientDb`
in cos-client-db) is reachable only from a Worker that binds its namespace.

## Decision

### The operator's Worker
- **`cos-operator`** (apps/operator, `@composable-os/db/operator`) is the one Worker that binds the
  raw `CLIENT_DB` namespace (with the operator's methods: migrations, bookmarks, restore, holds,
  `erase`), and beside it the registry, the files bucket, the exports bucket, OAuth's key-value, the
  search index, `COS_HOST_ENVIRONMENT` and the two keys that open a leaving client's secrets
  (`COS_ROOT_KEY`, `COS_SECRETS_PRIVATE_KEY`). No Worker of the host binds it and it binds none of
  the host's. It is a release's `fleet` Worker (as cos-client-db now is): optional, deployed only on
  a fleet deployment.
- **Who may call it:** only `Authorization: Bearer <COS_OPERATOR_TOKEN>`, compared in constant
  time; with no token, or one under 32 characters, every request is refused. `cos` sets a fresh
  random token as the Worker's secret at the start of each command (with the account's token) and
  replaces it with one nobody keeps at the end. No standing credential exists: the operator's
  commands are exactly as strong as the Cloudflare token that runs them, as every other write of the
  registry is (ADR 0613: "only the operator writes it, through cos with the account's token").
- **What it touches:** only a client the registry has in its deployment's environment, by its
  checked id, and only that client's part of each store (`clients/<client>/` in the files bucket and
  the key-value namespace; the client's namespace in the index). Its actions: `level`, `place`,
  `migrate` (the migrations are sent by `cos` from the verified release bundle, split as
  `@composable-os/db/sql-split` does, checked against `readD1Migrations` for every migration of the
  repository), `bookmark`, `restore`, `query` (a statement that provably reads), `export-db-part`,
  `export-files-page`, `export-manifest`, `export-list`, `import-db-part`, `requeue-embeddings`,
  `secrets-export`, `erase-db`, `files-delete-page`, `kv-delete-page`, `vectors-delete-page`; and
  `/files/<client>/<key>` (GET, PUT) and `/exports/<export key>/<path>` (GET).

### The registry's writes (`@composable-os/db/registry-writes`)
- Over any `D1Database`: the binding in tests, D1's REST API from `cos` (`d1OverRest`: a statement
  with its parameters, bytes as `X'…'` literals; a batch as one query of literal statements, which
  D1 runs all or nothing). Exported apart from `@composable-os/db`, and under the name
  `@composable-os/db/registry*`, which packages/core and the packs cannot import.
- `addClientRows` writes the client **paused** with no schema version, its hostnames verified and
  each its surface's address, and its settings, in one batch; `recordSchemaVersion`,
  `setClientStatus` (only from the statuses named), `setClientSetting`, `removeClientRows` (secrets,
  settings, hostnames, then the row, whose trigger keeps the id in `registry_removed_clients`).
- **Registry migration 0795:** a client's environment never changes (a `BEFORE UPDATE OF
  environment` trigger; issue #523, **F4**). Live and staging are two deployments with two
  registries; there is no move between them. And `registry_operations`: one row per run of a command
  that changes more than one thing, with where it has got to, at most one unfinished per kind and
  client (a unique partial index), read back by the next run of the same command. It holds no
  client's records and moves no version stamp.

### The keys file
`cos fleet keys --env <e> --out <file>` makes a deployment's keys once (`newHostKeys` for the root
and sealing keys, and 32 random bytes each for `COS_BINDING_KEY` and `COS_PROPS_KEY`, which differ)
and writes them only to `<file>`: mode 0600, refused inside a git working tree, never replaced, never
printed (the redactor holds every value as it is read). Every fleet deploy reads it, because the
props each host Worker's bindings carry are signed with the props key. The deployment state holds
only the public sealing key. Rotating a key is not built as a command (below).

This departs from ADR 0616's "the two private keys pass through the machine that makes them once":
the keys file keeps the root key and the sealing private key beside the binding and props keys, and
each fleet deploy sets them again (with the same values), so a re-run of an install that stopped
part-way, or a new Worker of the fleet, gets them. What seals a client's secret (`cos client secret
set`) still holds only the public key, from the deployment's state, and never reads the file's
private key. The operator may keep the file offline between deploys. A file that needs only the
props key per deploy (the others set once) is a later change.

### What a fleet deployment binds (ADR 0615's list, built)
`DeploymentState.fleet` (environment, callback hostname, the fleet's domain, the sealing public key)
makes a deployment a fleet's; `packages/release/src/fleet.ts` adds, and the committed
`wrangler.jsonc` never has:
- on cos-app and cos-runner: `REGISTRY`, `COS_HOST_ENVIRONMENT`, `COS_CALLBACK_HOSTNAME`; the secrets
  `COS_ROOT_KEY`, `COS_SECRETS_PRIVATE_KEY` (and `_PREVIOUS` when the keys file has one),
  `COS_BINDING_KEY`, `COS_PROPS_KEY` (and `_PREVIOUS`); `CLIENT_DB_QUERIES` to cos-client-db's
  `ClientDbQueries` with `clientDbCallerProps(propsKey, environment, "cos-app" | "cos-runner")`;
  `CLIENT_FANOUT` and `CLIENT_PARKING` (each Worker's own queues), consumed by the same Worker with
  a batch of one (`FANOUT_CONSUMER`), each with its `-dlq`; `CLIENT_PARKING_LEDGER` to the Worker's
  own `ParkingLedger`, added by a Durable Object migration of the fleet's own (tag `<release
  tag>+fleet`, or `fleet` for a Worker with no step of the release's) after the release's, which
  the release's later steps follow; and every dead-letter queue of the Worker's queues consumed by it;
- on cos-app only: the props of its `RUNNER` binding, `runnerCallerProps(propsKey, environment)`;
- on cos-client-db: `COS_PROPS_KEY` (and `_PREVIOUS`) and `COS_HOST_ENVIRONMENT`;
- on cos-operator: the bindings above; on every gatekeeper, `BASE_URL` under the callback hostname;
- the resources: the registry D1, the exports R2 bucket with a 90-day expiry rule, the four queues
  and their DLQs. Staging's Workers and resources are all named with `-staging`.
`ClientApp`'s props for a client's web app are step 8's (its upload). The keys are refused when the
binding key and the props key are one value. A single-client deployment gets none of this, from a
release that carries the fleet Workers (tested).

The code recognises a queue by its deployed name (`isQueue`): a release renames `cos-…` for the
product and staging adds `-staging`, so a batch's queue is matched on what follows the prefix.

### `cos client add`
The rows (paused), the database placed (location hint) and migrated inside the object, its schema
version recorded, then the client active; no Worker uploaded; prints its hostnames: the staff
hostname `<id>-admin.<domain>` unless named, and a web hostname only when one is named
(`--web-hostname`). **A client's web or desk hostname is refused on the fleet's domain:** the
domain has no Public Suffix listing (and will not soon), so code on one of its hostnames could set
cookies for the staff hostnames beside it (ADR 0616, "Cookies"); a client's web app is on its own
domain. Nothing here assumes the listing. The product's packs are the deployment's
(`COS_PACKS` inherited unless a setting says otherwise); a client's own extensions come with its
repository's `cos deploy` (step 8).

### The update (`cos fleet upgrade`)
Check every client's own extensions against the new release's contracts (one that would stop
working stops the update with nothing changed, decision 7); pause every active client; for each
client a bookmark, then its migrations, its schema version recorded; one that fails is restored to
its bookmark, and so is every client migrated before it, and nothing is uploaded; the Workers
uploaded once; a smoke check at a client's staff address; on failure the previous Workers again and
every client restored; then the clients it paused resumed (one the operator had paused stays so).
Live takes a release only once staging runs it (`--skip-staging` deliberately). The host's
"being updated" answer for a client paused or behind is step 4's.

### Export, import, remove
- **Export** (`cos client export <id> [--out] [--leaving]`): the client `moving` while it runs; its
  database as SQL parts (ADR 0614's export, the object holding it still) and its files into the
  exports bucket under `<client>/<generation>/<stamp>/` with a manifest of every part's and file's
  sha256 and the row counts; with `--out`, downloaded and checked, with `secrets.json` (the client's
  derived or imported secrets and its given ones, opened by the operator's Worker; mode 0600; never
  in the bucket, never printed). Back to its status after, unless `--leaving`.
- **Import** (`cos client import <id> --from <dir>`): an export brought in as a **new** client
  added as `imported` (migration 0793): its database part by part (each checked by `importPart`;
  the schema against this code's migrations for core objects), its files, its derivable secrets
  stored with `writeImportedSecret` and its given ones with `writeClientSecret`, migrated to this
  release, every embedded record queued again (the index is new), its videos in this account
  re-stamped with its creator, then served. **An import over an
  existing id is refused**, not overwritten: a client's id is never given new data under it.
- **`cos install --import <dir>`**: the same export installed as a single-client deployment in
  another account (criterion 13): into the new install's empty D1 before any migration, files into
  its bucket under their own keys, the export's secrets as the app's Worker secrets (staff and
  customers stay signed in), embeddings queued.
- **Remove** (`cos client remove <id>`): an export kept 90 days (as `--leaving`), then the database
  erased (`ClientDb.erase`, `deleteAll`), its files, OAuth keys and vectors deleted a page at a time
  (vectors by a query of the client's namespace, until it answers none), and last the registry rows,
  which keeps the id for good.

### Confirmation, dry runs, re-runs
Every command that removes or overwrites (remove, a secret's replacement or removal) asks for the
client's id to be typed, or `--yes`; with no terminal and no `--yes` it stops. The update asks
yes/no. Every command takes `--dry-run`. Each command's crash and re-run is written beside it in
`packages/create-composable-os/src/fleet/` and tested: an unfinished operation is carried on (add,
export, import, remove) or finished or undone (update) by the next run.

### Authenticated sealing (ADR 0616's open question): decided, open to the owner's override
Not added. Base-mode HPKE stays. An operator signature (or HPKE's auth mode) adds something only when
its signing key lives apart from the Cloudflare token that can write the registry and redeploy the
host; today the operator holds both, so a signature would be made by the same hand it is meant to
check. The familiar, safer course is to keep one secret (the token) and protect it, and to add a
signed audit of the operator's writes together with a signing key held apart (a hardware key or
the control plane), as one later step. Recorded in ADR 0616 too.

## What is left out, and why
- **Videos are not copied.** Step 5 (#522, merged) stamps each video with its client's creator
  (`<environment>:<client>`) and refuses one without. An import re-stamps every video the client's
  records name (`core_media.stream_uid`) that this account's Stream holds, with `clientStamp`, the
  one place the creator's shape is decided (`clientStampOf` uses it), and names the ones the account
  does not hold; an export lists none and does not download them (issue #525).
- **Extension objects in an import** (`x_*`, `rec_*`) are taken as the export declares them; core
  objects are checked against this code's migrations. Checking extension objects against what the
  reconciler derives from the imported manifests is not built.
- **A removed client's Durable Objects** (assistant threads, jobs, workspaces, integration hosts,
  its parking ledgers) are not deleted: their names are not enumerable, and each is named with the
  client's generation, which no later client has, under an id never given again. Its parked
  messages are given up when they come back ("its client is gone").
- **Key rotation** (props key, sealing key) is not a command yet: ADR 0615 and 0616 say how it is
  done; the keys file holds `…Previous` fields the engine already deploys.
- **The deployment's state** stays in `core_install` of the host's own D1 database (which on a fleet
  holds no client's records), not in the registry as the spec's table listed: the deploy engine
  finds a deployment by that database, and moving it gains nothing.
- **Payments, text, inbound webhooks and email** stay off on a host of many clients (ADR 0616); a
  client's Stripe keys can already be stored as given secrets (`STRIPE_SECRET_KEY`,
  `STRIPE_WEBHOOK_SECRET`), in no client's environment until the payments gatekeeper is made per
  client (the owner's decision of 2026-11-27, ADR 0616).

## Also fixed here
- **Issue #523, F2.** A message whose copy reached the parking queue is acked whatever the ledger
  says (a failed ledger write is logged, `cos.queue.parked_unrecorded`, and the delivery handles it
  as unrecorded), and its parked id is derived from its queue and its own message id
  (`parkedIdOf`), so a second delivery of the original parks under the same id and is handled once.

## Consequences
- A host of many clients can be installed, given clients, updated, and have clients taken out or
  brought in, from `cos` alone, with every step recorded so a re-run recovers.
- Nothing of this reaches a single-client deployment: its uploads, tests and commands are as before.
- Nothing here was run on Cloudflare: D1's REST API with a batch of many statements, Durable Object
  point-in-time restore through the operator's Worker, R2 lifecycle rules
  and a fleet's uploads are proved locally and against the fake API only.
