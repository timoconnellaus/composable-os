# ADR 0163: The deploy engine talks to the Cloudflare API directly

Status: accepted, 2026-11-05 (stage 8 build).

## Decision
`packages/release` deploys a bundle with `fetch` against the Cloudflare REST API, in Node (the CLI)
and in Workers (the self-updater) alike. No wrangler at runtime.

- **Provision** (find by name, else create): D1 ([create/list](https://developers.cloudflare.com/api/resources/d1/subresources/database/)),
  R2 ([buckets](https://developers.cloudflare.com/api/resources/r2/subresources/buckets/methods/create/)),
  KV ([namespaces](https://developers.cloudflare.com/api/resources/kv/subresources/namespaces/methods/create/)),
  Queues ([queues](https://developers.cloudflare.com/api/resources/queues/methods/create/)),
  Vectorize ([v2 indexes](https://developers.cloudflare.com/api/resources/vectorize/subresources/indexes/methods/create/)).
  Workflows and Durable Objects are created by the script upload itself (a `workflow` binding with no
  `script_name` registers it); resolved ids go into `core_install`.
- **Migrations** over `POST …/d1/database/{id}/query`, each migration plus its `core_migrations` row
  in one query, which D1 runs as one batch, exactly as `wrangler d1 migrations apply` bookkeeps, so
  either tool sees the other's work.
- **Workers:** stage everything first: assets through an upload session
  ([direct upload](https://developers.cloudflare.com/workers/static-assets/direct-upload/)), then a new
  **version** of each existing Worker without traffic
  ([versions](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/versions/methods/create/));
  then switch them back to back, dependencies first, with
  [deployments](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/deployments/methods/create/).
  A new Worker, or one whose Durable Object migration tag moves, is uploaded with `PUT …/scripts/{name}`
  (versions cannot carry DO migrations), with `old_tag` = the deployed tag and only the later steps.
  There is no cross-script atomic deploy, so "together" means after all uploads succeeded, in
  consecutive calls.
- **Secrets** are `secret_text` bindings in the upload metadata (one version, not one per secret,
  unlike [the secrets API](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/secrets/)),
  and every upload sends `keep_bindings: ["secret_text", "secret_key"]` so secrets not set in this
  run keep their stored values.
- **Then:** cron schedules, queue consumers (not part of upload metadata), workers.dev on/off
  ([subdomain](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/subdomain/methods/create/))
  or a custom domain ([domains](https://developers.cloudflare.com/api/resources/workers/subresources/domains/methods/update/)).
- **Idempotent:** every step checks first; re-running an install changes nothing that is already
  right and keeps BETTER_AUTH_SECRET.
- **Token permissions** (account level): Workers Scripts Edit, D1 Edit, Workers R2 Storage Edit,
  Workers KV Storage Edit, Queues Edit, Vectorize Edit, Account Settings Read; for a custom hostname
  also Zone Read and Workers Routes Edit on the zone
  ([permissions](https://developers.cloudflare.com/fundamentals/api/reference/permissions/)).
- The client never logs, and errors carry the API's messages, never request bodies. The CLI also
  redacts every secret it handled from its output.
- **Tests** run against `FakeCloudflare` (`@relationship-os/release/testing`), which is strict where the API is
  (auth, DO `old_tag`, no migrations on versions, assets tokens), with SQL on Node's SQLite and Time
  Travel emulated by replaying writes.

## Consequences
- We maintain a small API client instead of depending on wrangler's internals. Fields such as
  `worker_loader` are documented only in wrangler's source; the real-account test (ADR 0168) is the
  backstop.

## Amendment, 2026-11-05: stage 5 queues and stage 7a's Vectorize index
- Queue consumers carry their dead-letter queue as a top-level `dead_letter_queue` (a queue name),
  next to `settings`. The manifest keeps it as `deadLetterQueue: "$QUEUE_NAME(…)"` and renders it at
  deploy time. Stage 5's `ros-automation-events` and `ros-automation-events-dlq` are provisioned
  from the manifest. The `ros-automation` Workflow is registered by ros-runner's upload, and the
  rate limit namespace 4201 passes through.
- Vectorize indexes are created from `deploy-inputs.json` `vectorize` settings when wrangler.jsonc
  cannot express them (dimensions, metric and `metadataIndexes`), e.g. 7a's `ros-records` (384,
  cosine, `object` string metadata index). Missing metadata indexes are created on every run, so the
  step is idempotent (`POST …/vectorize/v2/indexes/{name}/metadata_index/create`,
  [docs](https://developers.cloudflare.com/api/resources/vectorize/subresources/indexes/subresources/metadata_index/methods/create/)).

## Amended 2026-11-27: upload order and Workflows (the second real staging run)

- **Workers are uploaded in the order their bindings need**, read from the bindings as uploaded
  (`bindingOrder`, `boundWorkers` in `packages/release/src/deploy.ts`), not only the release's
  `dependsOn`, which knows nothing of the bindings the engine adds (a gatekeeper on the runner, a
  fleet's client-db). Cloudflare refuses a Worker or a version whose service binding names a Worker
  that does not exist (400, 10143, seen on a real run). A new Worker that an existing Worker's new
  version binds (a gatekeeper added to a host) is uploaded while staging, before that version. A
  cycle of bindings is refused by name; none exists. A rollback never deletes a Worker, so it
  cannot leave a binding to one it removed.
- **Each Workflow is created by its own call**, `PUT /accounts/{id}/workflows/{name}` with
  `class_name` and `script_name`, after the Worker that exports its class is switched. Uploading
  the Worker does not create it: wrangler's deploy makes the same call (workers-sdk,
  `packages/deploy-helpers/src/triggers/deploy.ts`, `triggersDeploy`), and the Workflows API
  reference describes the call as "Creates a new workflow or updates an existing workflow
  definition" (developers.cloudflare.com/api/resources/workflows/methods/update/). Hosts installed
  before this have no Workflows; their next upgrade or install re-run creates them. Not done in a
  dispatch namespace (ADR 0210), whose Workflows were not checked.
- The fake Cloudflare API refuses as the real one does: a missing service binding (10143) and a
  missing D1 database (10181); and it creates a Workflow only by that call, listing them paged by
  `total_count` with no `total_pages`, as the API reference documents, which `all()` now follows.
