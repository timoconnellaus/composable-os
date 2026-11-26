# ADR 0612: ClientDb, a Durable Object behind the D1 interface

Status: accepted, 2026-11-26 (stage 66 step 1, built on `feat/stage-66-client-db`). Builds
[ADR 0611](0611-one-host-a-database-per-client.md)'s "each client's records are in a database of
its own". The deployed half of step 1 (the timing on Cloudflare) has not run yet.

## Context
ADR 0611 put each hosted client's records in a Durable Object with SQLite storage, behind the
`D1Database` interface the host already uses everywhere (`createCrmDb(env.DB)`). The spike on
`spike/one-host` showed `packages/core`'s suite passing on such an object locally. Step 1 makes it
real code, carries the app's and the runner's suites as well, and prepares the proof on Cloudflare
that the time a page takes is acceptable before anything else is built on it.

## Decision
- **`ClientDb`** (`packages/db/src/client-db.ts`, exported as `@composable-os/db/client-db`, for
  the Workers runtime only) is a Durable Object class with SQLite storage, one object per client
  and environment, named by the client's id. Its methods: `query` (one query set in one
  transaction), `stage` and `commit` (a query set too large for one call, below), `migrate` (every
  migration the object lacks, applied inside it with the same `applyMigrations` D1 is migrated
  with) and `size`.
- **`clientDatabase(namespace, client, options?)`** returns a `D1Database` that sends every call to
  that client's object. It reproduces D1's binding (`cloudflare-internal:d1-api` in workerd) and the
  object behind it (miniflare's local D1, itself SQLite in a Durable Object): the same `bind`
  conversions and refusals, result shapes, `first`/`raw`/`run`/`all`, `exec` one statement a line,
  `D1_ERROR: …` errors with the bare message as `cause`, and the same meta (`changes` from
  `total_changes()`, so a trigger's writes count; `last_row_id`; `rows_read` and `rows_written` of
  the statement's own cursor; `size_after`; `changed_db`).
- **A stub is made for every call.** A Durable Object stub belongs to the request or object that
  made it; one held across requests failed the app's suite at once (an assistant object and a
  queue consumer using a stub made in another request). A D1 binding has no such limit, so
  `clientDatabase` keeps only the object's id. The client's environment (step 3) can therefore be
  built once per isolate and stay a stable object, as auth's caches need.
- **A batch larger than one call is sent in parts.** Workers RPC carries at most 32 MiB a call; D1
  takes a batch of any size whose statements are each within its limits. The month close's biggest
  batch (packages/core `finance-close-cost.test.ts`, 100,000 lines) is 37.5 MB. Above 8 MiB by a
  generous estimate, the earlier parts are held by the object (`stage`) and the last part commits
  them all in one transaction (`commit`), so the batch is still all or nothing; a part lost (the
  object restarted between calls) refuses the whole batch with nothing applied.
- **The suites run on it without a copy of their tests.** `COS_TEST_DB=client-db` before a
  package's tests (packages/core, packages/auth, apps/app, apps/runner;
  `@composable-os/db/testing/vitest`) adds `ClientDb` in a Worker of its own and a first setup file
  that migrates one client's object and puts it where `env.DB` was. After each file the D1 binding
  must still hold no table, so a test cannot pass by reaching D1 another way. Unset, nothing changes.
- **The differences are probed, not assumed.** `@composable-os/db/testing/conformance` is one probe
  per behaviour below. `packages/db/test/client-db.test.ts` runs them on the local D1 and on
  `ClientDb` and requires the same answers; the proof Worker (`apps/client-db-proof`, `/conformance`)
  runs them on Cloudflare, where D1 and a Durable Object are different services.
- **The proof on Cloudflare** is `apps/client-db-proof`: `ClientDb` with one client (`proof-gym`)
  beside a D1 database, both created with the same location hint, seeded alike (300 people, each
  with a note, a shop of two class passes, a payments connection), timing three scenarios inside
  the Worker as the app's screens call them: the People list (`person.list`, `record.count`), a
  person's page (`person.get`, `activity.listForRecord`) and a guest checkout (`order.start`,
  `order.checkout`, against a stand-in gatekeeper that answers at once). Deployed only by hand
  (`.github/workflows/client-db-proof.yml`); docs/deploying.md has the runbook.

## What differs from D1, and what was done

"Local" is workerd on a developer's machine, where D1 is itself SQLite in a Durable Object, so the
engine is the same and only the binding's side can differ. "Cloudflare" is what `/conformance`
reports there; until it has run, those rows are what the platform documents, not what was seen.

| Behaviour | D1 | ClientDb, local | On Cloudflare | Done |
| --- | --- | --- | --- | --- |
| `bind`: booleans 1/0, bytes (ArrayBuffer, a view, an array of 0-255) as a BLOB; `undefined`, `bigint`, a plain object or a `Date` refused with `D1_TYPE_ERROR` | as listed | same | same code runs | D1's conversions copied |
| NaN and Infinity bound | null (the binding sends JSON) | null | same code | converted as D1 does |
| A BLOB read | an array of numbers | same | same code | converted |
| An integer past 2^53 | a lossy number | same | same engine | none needed |
| 1e999 read | null (JSON) | null | same code | converted |
| Duplicate column names in `all` | the last wins | same | same code | `Object.fromEntries` as D1 |
| `first(column)` on a missing column | `D1_COLUMN_NOTFOUND` | same | same code | copied |
| `run` | the same result as `all`, rows included | same | same code | copied |
| `meta.changes` with a trigger | counts the trigger's writes (`total_changes`) | same | to be seen | `total_changes()` around each statement |
| `meta.rows_read` / `rows_written` | the statement's cursor | same | to be seen | the cursor's own counts; the rows-read budgets pass |
| `meta.size_after` | the database's size | same | to be seen | `databaseSize` (retention's storage report reads it) |
| `meta.duration`, `served_by` | D1's | the object's own time, `cos-client-db` | different by design | nothing reads them |
| Error text | `D1_ERROR: <SQLite message>`, the message as `cause` | same, UNIQUE and FOREIGN KEY text included (`errors.ts` matches on it) | to be seen (real D1 may word some errors its own way) | copied; a probe per case |
| A failure of the service itself | D1's own message | `D1_ERROR:` and the runtime's message (object unreachable, reset, overloaded) | different | nothing matches on it |
| Batch atomicity | one transaction | one `transactionSync`: a failing statement leaves nothing | same | a probe; the suites' atomicity tests pass |
| A batch over 32 MiB | accepted when each statement is in its limits | **refused by Workers RPC** (found by `finance-close-cost.test.ts`) | same limit | **sent in parts, committed in one transaction** |
| A stub used from another request or object | not applicable (a binding) | **refused by the runtime** (found by the app's suite) | same | **a stub per call** |
| An empty batch, an empty statement | `No SQL statements detected.` | same | same code | copied, comment filter included |
| Two statements in one `prepare` | the last statement's rows | same | to be seen | a probe |
| `exec` | one statement a line, one transaction, an error naming line 1 | same | same code | copied |
| 100 bound parameters a statement | 101 refused | **101 refused locally by both** (`too many SQL variables`) | DO SQLite documents 100 too | a probe; the host chunks (records/common.ts) and its tests count binds through a meter |
| 100,000 bytes a statement | refused | refused locally by both (`SQLITE_TOOBIG`) | documented the same for both | a probe |
| 100 columns a table | 101 refused | refused locally by both | documented the same | a probe |
| 2,000,000 bytes a value or row | refused | **not enforced locally by either** | both document 2 MB | a probe; a test passing on a larger value would pass on local D1 too |
| 32 arguments a function | refused | **33 accepted locally by both** | to be seen | a probe |
| 1,000 queries a Worker invocation | refused | not enforced locally by either | each ClientDb query is a Durable Object call, and a staged batch one per part; Workers allow 10,000 subrequests an invocation (paid plan), and whether ClientDb's calls share that budget with outbound fetches is what the proof's `/subrequests` reports | the host's own meter keeps paths under 1,000 (ADR 0841), on both; it counts a staged batch as one |
| A result over 32 MiB | returned | **refused by Workers RPC** (review of PR #507, S1: 40 rows of 1 MB) | same limit | the probe `read-over-32mib`, on the proof's allow-list as known; paging or a clear refusal is step 2's |
| A batch's results over 32 MiB | returned | **written, then reported as failed** (review B1: 200,000 one-row inserts) | same limit | **step 2 fixes it** (bound the response inside the transaction); not probed on Cloudflare (too large a write for the proof) |
| How a bound JS number is typed with no column affinity | to be seen (D1 may bind an integral number as INTEGER) | REAL for both locally (`typeof(?)` of 42 is `real`, `json_array(3)` is `[3.0]`) | the probe `number-binding` shows it | if D1 differs, the binding's side must match it |
| A trigger's `RAISE(ABORT, …)` text | `D1_ERROR: <message>: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_TRIGGER)` locally | same | the probe `trigger-raise` | `errors.ts` matches with `includes()` |
| A client's first request after idle | no cold start per client (one database for the deployment) | an evicted object starts again: its isolate, constructor and SQLite opening (Cloudflare evicts after 70 to 140 s idle) | the proof's cold samples time it and say whether each object really was evicted | the owner's threshold: no more than a few hundred ms worse |
| Deploying the Worker that holds the class | D1 is not touched by a Worker deploy | deploying `ClientDb`'s Worker resets every live object ("Durable Object reset because its code was updated"), aborting queries in flight for every client | the proof exports the class itself, so it is not measured | steps 2 and 3: put `ClientDb` in its own Worker, deployed only when the class changes, or say why not (review S9) |
| `PRAGMA foreign_keys`, `defer_foreign_keys`, `table_info` | on, allowed, allowed | same | to be seen | probes |
| `PRAGMA journal_mode`, `user_version`, `compile_options` | refused (not authorised) | same locally | to be seen | a probe; the host uses none |
| `BEGIN`, `SAVEPOINT` | refused | refused (the object's message) | real D1's text may differ | nothing uses them |
| FTS5 (migrations 0006, 0970), JSON functions, `->>`, `jsonb` | available | same | to be seen | probes |
| Sessions and bookmarks (`withSession`, `getBookmark`) | read replicas, a bookmark per session | a session over the same object, `getBookmark()` always null | different | **deferred to step 2**; nothing in the host uses them |
| `dump` | retired, refuses | refuses | same | export as SQL is step 2 |
| `query()` (`d1_binding_jsrpc`) | behind a compatibility flag | absent | absent | nothing uses it |
| One query at a time | one primary | one object | to be timed | the proof's checkout times it |

Every probe's answer on Cloudflare is printed by the workflow, D1's beside ClientDb's, and a
difference not in `apps/client-db-proof/conformance-allow.json` fails the run; the "to be seen"
cells are filled from that run.

## Deferred to step 2
- **Bookmarks and restore** with the object's point-in-time recovery (`getCurrentBookmark`,
  `onNextSessionRestoreBookmark`), and a session's `getBookmark` returning one.
- **Export and import** as SQL (`dump` refuses until then).
- **Size for usage reports:** `size()` and `meta.size_after` exist; the report and the 10 GB limit
  do not.
- **The location hint from the registry:** `clientDatabase` takes one (the proof Worker passes
  `oc`); where a client's comes from is step 3's registry.
- Step 1 rewires no entry: every Worker still calls `createCrmDb(env.DB)` with its D1 binding, and
  a single-client deployment runs exactly as before. The registry and the client's environment are
  step 3, the entries steps 4 and 5.

## Consequences
- **A single-client deployment is unchanged.** No Worker of the host binds `ClientDb` yet; the new
  code is reached only by the suites on `COS_TEST_DB=client-db` and by the proof Worker.
- **The suites prove the interface, not the service.** Locally both databases are SQLite in a
  Durable Object; what D1 and Durable Objects do differently on Cloudflare is what `/conformance`
  reports there, and the rows marked "to be seen" are updated from it.
- **Step 2 does not start until the timing is seen** (stage 66, suggested build order 1): if a page
  on a client's database is not acceptably close to D1, the owner decides before anything is built
  on it.
