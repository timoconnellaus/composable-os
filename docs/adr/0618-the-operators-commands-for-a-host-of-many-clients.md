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
`ClientApp`'s props for a client's web app are step 8's (its upload). _Note 2026-11-27: not built
in step 8 (the owner moved how a client's web app is served to stage 75's spike, ADR 0619); step 8
adds cos-front, a fleet Worker with the registry and two vars only._ The keys are refused when the
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
domain. Nothing here assumes the listing. _Amended 2026-11-27 (step 8, ADR 0619): a desk hostname
is our code (cos-app's desk pages), so it is on the fleet's domain like the staff hostname
(`--desk`, `<id>-desk.<domain>`), and a web hostname is written unverified until `cos client
hostname verify` finds its custom hostname active._ The product's packs are the deployment's
(`COS_PACKS` inherited unless a setting says otherwise); a client's own extensions come with its
repository's `cos deploy` (step 8).

### The update (`cos fleet upgrade`)
Check every client's own extensions against the new release's contracts (one that would stop
working stops the update with nothing changed, decision 7); pause every active client; for each
client a bookmark, then its migrations, its schema version recorded; one that fails is restored to
its bookmark, and so is every client migrated before it, and nothing is uploaded; the Workers
uploaded once; a smoke check at the host's own health address (below); on failure the previous
Workers again and every client restored; then the clients it paused resumed (one the operator had paused stays so).
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

### After the review of #526 (2026-11-28)
- **M1, the smoke check.** Every client is paused while the update runs, so a client's address
  answers "being updated". The app now answers `GET /api/health` on the deployment's callback
  hostname before any client is decided (`hostHealthResponse`): the version these Workers run and
  whether the registry's stamp reads; nothing of any client's. The update smoke-checks there,
  always, whether or not a client was active. Tested through the app's real entry and the real
  `healthSmoke`, with a paused client.
- **M2, a lost answer.** On a failure or a re-run every client with a bookmark recorded is restored
  to it, not only those whose migration answered: a call that applied its migrations and then lost
  its answer is undone too (restoring an unchanged database to its bookmark changes nothing).
- **S1, one command at a time.** Opening the operator's Worker sets its token, which would cut off
  another command. A command that needs the Worker first takes the registry's one session row
  (`registry_operator_session`, migration 0795), before it changes anything, renewed with each call
  and given back at its end; while another holds it, it is refused. One killed holds it for 30
  minutes, or until `--take-over`. `list`, `pause`, `resume` and `secret` touch only the registry and
  never open the Worker, so they are safe beside a running command.
- **S2, the keys file and its deployment.** The state keeps a SHA-256 of the root, binding and props
  keys (`keysFingerprint`) beside the sealing public key; `cos fleet install` (re-run) and `cos
  fleet upgrade` refuse any other keys file before a key is set, and a re-run never replaces the
  stored public key.
- **S3, web hostnames.** `--domain` is put in its one form at install (case, a trailing dot, an IDN as
  punycode), and a client's web or desk hostname is refused anywhere under the fleet domain's
  registrable domain (two labels, three under a country's `co`, `com`, `org` and the like; no Public
  Suffix listing is assumed). A client's code runs only on the client's own domain (the owner's
  decision: no Public Suffix List submission).
- **S4, what an import accepts** (*amended after the second review, N3; see below*). Beside the core
  schema the code's migrations make, only: tables and indexes of extension tables (`x_…`), and
  triggers on extension tables whose SQL names nothing but extension tables. No view. Never another
  object with a core object's name; anything else is a difference, and the import is refused and the
  database emptied (`importedExtensionObjects`). The text of the extension tables, indexes and
  triggers is the export's own.
- **S5, what an export's checks are.** The hashes in `manifest.json` catch a part or file damaged or
  cut short; the manifest carries no signature, so they do not catch a folder someone edited on
  purpose: an import trusts the folder it is given. `secrets.json` is plain JSON, unencrypted, mode
  0600: keep it as a password. An imported derivable secret must be at least 32 characters with 10
  distinct ones (`importedSecretProblem`), checked before anything is written.
- **F-d.** `cos client add` and `import` are refused while an update is unfinished.
- Later work from the review is issue #528.

### After the second review of #526 (2026-11-28)
- **N1, a session taken over.** A run closing replaces the operator's Worker's token only while it
  still holds the session row; a run another took over from (or whose session lapsed) leaves the
  Worker to that one. `--take-over` takes the row once and never again, so the run that took over
  never takes it back from a later command. A live run renews its row on a heartbeat (every 10
  minutes, a third of the 30 it holds) whatever it is doing, so a long migration, export or upload
  cannot let it lapse; it lapses only when the run is gone.
- **N2, a pause during an update.** `cos client pause` is refused while an update is unfinished: the
  update resumes every client it paused at its end, which would undo the operator's pause.
- **N3, what an import accepts, now** (*amended after the review of #530, R1 to R3*). The name
  check is a **deny-by-default filter over the SQL the export wrote**, and not a proof that an
  export is harmless. **Import only an export you trust.** What it covers:
  - Every imported table, index and trigger must sit on an extension table (`x_…`), and every name
    its SQL refers to must be an extension table. The SQL is tokenised (`namesIn`), not parsed:
    comments are skipped, and `"…"`, `` `…` `` and `[…]` identifiers are unquoted. The text of
    single-quoted strings counts as a name too, since SQLite takes `UPDATE 'core_user'`. Case is
    folded. Each name is matched against the imported database's objects, and any name with a
    core or platform prefix (`core_`, `rec_`, `crm_`, `pub_`, `sqlite_`) refuses the object. It
    errs towards finding a name, never towards missing one. This covers a trigger's body, a table's
    DEFAULT, CHECK and generated columns, and an index's expressions and partial `WHERE`.
  - A virtual table is refused (an FTS5 table's external content reads whatever table it names).
    So is an `INSTEAD OF` trigger.
  - No view is taken from an export (`ImportOptions.skipViews`). Once the database is in, every
    view is made again from the host's own definitions (packages/core `rebuildRecordViews`: the
    views of the host's migrations, then every record view). That happens only after the imported
    extension state is checked (`importedStateProblems`), with these rules:
    - each object's table must be exactly the `x_<ext>_<object>` its name derives, and an imported
      extension table;
    - each field's table must be its own object's (or its side table), and its column a real column
      of that table;
    - every relation must name an object that passes.

    Anything else refuses the import and empties the database. `cos client import` (the operator's
    `rebuild-views`) and `cos install --import` both go through that one function.
  - Consequence: a client using a pack whose behaviours make triggers naming core tables cannot be
    exported and imported this way; the import is refused, failing closed. That is `occupies`
    (`core_thing_time`) and `staffed` (`core_staff_time`), so Bookings and Rostering. An end-to-end
    export and import of Memberships, Ticketing, Courses, Programs and Content has not been run.
  - **The sturdier design**, issue #532: an import carries data only, and the host's reconciler
    makes the extension tables, indexes, triggers and views again from the extensions' checked
    manifests.
- **N4, a sender domain renamed.** Registry migration 0798: a change of a row's `domain` must leave
  it unverified (a rename, an `UPDATE OR REPLACE` onto another client's domain, an upsert's `DO
  UPDATE SET domain`).
- **Follow-up F1, partly.** The host's health route answers a registry failure with a fixed
  message and logs the database's own text; it is still unauthenticated and reads the stamp per
  request (#528).

### Email sending per client, wired (2026-11-28; issue #529)
- A fleet deploy sets `SENDER_DOMAINS_PER_CLIENT=true` on the email-send gatekeeper (tested; a
  single-client deployment's stays as it was). *Corrected 2026-11-27, PR #544 (this section's
  heading carries 2026-11-28, written a day ahead of the calendar; the correction comes after it
  all the same):* as first built, `cos fleet install` deployed no gatekeeper at all (its state's `gatekeepers` was always empty), so the
  engine had no email-send Worker to set it on and no fleet could send email. See "A fleet's
  gatekeepers" below.
- `cos client sender add|verify|unverify|remove <id> <domain>` over
  `@composable-os/db/registry-senders`. A domain is added unverified. `verify` asks for the
  client's id and says what the operator confirms: that the domain is onboarded to Email Sending
  in this deployment's Cloudflare account with its sending records valid (nothing checks it). `remove`
  asks too. These touch only the registry, never the operator's Worker.
- `addSenderDomain` refuses a shared suffix (`co.uk`, `github.io` and a short built-in list), a
  shared mail domain or a name under one (`gmail.com` and the like), and the fleet's own
  registrable domain or a name of its tree (issue #529, F2).
- Registry migration 0797: a domain given to another client starts unverified, whether by an
  `UPDATE` of its client, an upsert or an `INSERT OR REPLACE` (issue #529, F1).
- An export lists the client's sender domains in its manifest; an import adds each unverified (one
  another client holds is named, not added).

### A fleet's gatekeepers (2026-11-27, PR #544; issue #529)
*Amendment, a correction of "Email sending per client, wired" above (whose heading date runs a day
ahead): step 7 meant the fleet to send email per client and built everything for it except
installing the gatekeeper.*
- **The list is fixed by the platform, not chosen by a flag.** A gatekeeper goes on a fleet only
  once it is made per client (ADR 0616, "Gatekeepers"); which ones those are is code, reviewed, not
  an operator's option, and a flag would let one command put a gatekeeper holding one account for
  every client on a shared host. Today the list is email sending alone (`FLEET_GATEKEEPERS`,
  `packages/create-composable-os/src/fleet/gatekeepers.ts`). Payments, text, inbound webhooks and
  email receiving stay off a fleet; the OAuth gatekeepers (Google, Microsoft, Slack, ZoomInfo)
  stay off until the operator's apps and the checks ADR 0616 lists (items 6 and 7) are done, each
  a change to this list.
- **One mechanism, the single-client one.** `cos fleet install` writes the list into the
  deployment state's `gatekeepers`, on a first install and on a re-run, exactly as `cos install
  --gatekeepers` does; the deploy engine then uploads the gatekeeper's Worker, binds it on the
  runner as `GATEKEEPER_EMAIL_SEND` (the runner's `gatekeeperBindings`) and, on a fleet, sets
  `SENDER_DOMAINS_PER_CLIENT=true` (`packages/release/src/fleet.ts`). `cos fleet upgrade` takes the
  list from the new release's manifest, uploads with it and records it with the new version, so a
  fleet installed before this change gains the gatekeeper at its next upgrade and every later
  upgrade keeps it. Rolling back uploads the previous release with the state as it was.
- **A single-client command never touches a fleet.** `cos install` and `cos upgrade` refuse a
  deployment whose state is a fleet's, before writing anything: run on the fleet's database, they
  wrote the state again without `fleet` (found in the review of #544, reproduced by a test), and
  the next upload would have dropped the registry, the clients' databases and the per-client
  sending. `cos fleet install` already refused the reverse.
- **A release without the email-send gatekeeper is refused** by `install` and `upgrade` before
  anything is made: a fleet whose clients cannot be sent a sign-in code is not a working fleet.
- **No secret.** Cloudflare Email Service is the gatekeeper's `send_email` binding in the
  deployment's own account; it has no key. What the operator does instead is onboard each
  client's domain to Email Sending in that account (its DNS records valid), then `cos client
  sender add` and `verify` (above). `ALLOWED_SENDER_DOMAINS` stays as the committed
  configuration has it (empty) and is never read on a fleet.
- **`INTERNAL_DOMAINS` is always empty on a fleet**, set by the deploy engine whatever a state var
  or the configuration says (`packages/release/src/fleet.ts`, tested). It is one list for the
  whole deployment, and a send whose every recipient is in it is the `email.internal` kind: it
  skips the per-person consent check and is auto-approvable. On a fleet a list meant for one
  client's colleagues would do that for every client's mail.
- **Isolation stays where #527 put it**, in the host and the gatekeeper, for every send whoever
  starts it (an operation, the host's own mail, an automation's step or extension code, all through
  the client's integration host): the gatekeeper allows a sender only on the verified domains the
  registry gives that client, at bind, at send and again at apply; a client paused or removed is
  refused by its integration host at its next call (every call re-reads the client's admission,
  so up to `REGISTRY_REFRESH_MS`, 10 seconds, after the registry changes). A send queued before is
  not sent while the client is paused (once resumed, an approver may still approve it), and never
  after it is removed. Tests: `packages/create-composable-os/test/fleet.test.ts`
  ("a fleet's gatekeepers") and the runner's two-client `email-sending.test.ts` ("a client
  paused, then removed, by the operator").

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
- **Payments, text, inbound webhooks and email receiving** stay off on a host of many clients
  (ADR 0616; email sending is on, "A fleet's gatekeepers" above); a
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
