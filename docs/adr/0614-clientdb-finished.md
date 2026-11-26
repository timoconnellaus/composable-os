# ADR 0614: ClientDb finished: answers, migrations, bookmarks, export, size, place, its own Worker

Status: accepted, 2026-11-26 (stage 66 step 2, built on `feat/stage-66-client-db-finished`,
stacked on step 1's PR #507). Finishes [ADR 0612](0612-clientdb-a-durable-object-behind-the-d1-interface.md),
whose "Deferred to step 2" list this answers, and the findings of the review of step 1 that fall
in `packages/db/src/client-db.ts` (B1, S1, M1, M2, M4, S6) and the decision on S9. The parts only
Cloudflare can show wait for the proof run (`/step2/*` on `apps/client-db-proof`, below).

## Context
Step 1 put each client's records in `ClientDb` behind the `D1Database` interface and ran the
suites on it. What the update, `cos client add`, `cos client export` and `cos client import`
(step 7) and usage (step 10) need from it was left to step 2: migrations they can report on,
bookmarks and restore, the database out as SQL and back, its size against the limit, and where it
is placed. The review of step 1 found that a large batch could commit and still be reported as
failed, because the answer crossed Workers RPC's 32 MiB a call unbounded.

## Decision

### A set is committed only with an answer that can be returned (B1, S1, M1, M2, M4)
- **The answer is bounded inside the transaction.** The object packs each set's results compactly
  (a statement's meta as seven numbers; the constant fields are filled in on the binding's side) and
  cuts them into parts of at most 8 MiB by an estimate of their size on the wire. An answer of one
  part is returned as it is. A larger one is **held** by the object and fetched part by part
  (`take`), so a 200,000-statement batch (about 10 MB of answer) or a 40 MB read works as on D1.
  An answer over 48 MiB, or one that would take what the object holds for callers over 64 MiB, is
  refused **inside the transaction**, which rolls back: `D1_ERROR: the result is more than 48 MiB,
  the most a client's database returns for one query set; read it in pages. Nothing was applied`.
  The rows are counted **as the cursor is read** (review of #511, S7): past 48 MiB nothing more is
  kept, the statement is run to its end (SQLite cannot roll back under a running statement) and the
  set refused, so one oversized read cannot fill the object's memory and reset it for every caller.
  D1 returns larger results; a client's database does not, so a read that large is read in pages
  (ADR 0612's table).
- **Every set that may have written is recorded under its id in the same transaction** (the
  object's own key-value storage, `_cf_KV`, never the client's schema), so "committed" and
  "recorded as committed" cannot be separated. "May have written" is every set but one each of
  whose statements provably only reads (`isReadOnlySql`: a single SELECT, VALUES or WITH … SELECT):
  `total_changes()` does not count DDL (CREATE TABLE, CREATE INDEX, CREATE TRIGGER, ALTER TABLE,
  DROP TABLE), so it cannot decide this (review of #511, S1; migrations and extension installs are
  DDL). The binding sends every set with a fresh id. When a call's answer is lost (the call threw,
  the object restarted before the rest of a held answer was taken), the binding asks `outcome(id)`:
  - the set committed and its answer is still held: the answer is fetched again;
  - it committed and the answer is gone: `D1_ERROR: the batch committed, but its answer was lost
    …; it must not be sent again`, with `committed: true` and `retryable: false`;
  - it did not: `outcome` **fences** the id, so a set still on its way is refused when it
    arrives, and the original error stands;
  - `outcome` itself failed: the outcome is unknown, and the error says so with
    `committed: "unknown"` and `retryable: false` (S2). A set that only reads skips all of this
    and keeps the runtime's flags.
  A set whose id is already recorded is never run again. Records are kept an hour, also under a
  key by time, so a sweep reads only the expired ones, at most 256 every ten seconds (M7).
- **Exactly once holds within one `send` only** (S2). Each `send` makes a new id, so a queue
  redelivery, a workflow step's retry or a person pressing a button again is a new set and writes
  again, exactly as on D1. What the outcome record prevents is a single call's lost answer being
  taken for a failure.
- **A batch sent in parts is indexed** (M1): `stage(batch, index, queries)`, and `commit` refuses,
  with nothing applied, unless parts 0 to n-1 each arrived exactly once; they are applied in index
  order whatever order they came in.
- **What the object holds for callers is bounded and swept** (M2): staged parts and held answers
  together at most 64 MiB, each forgotten after a minute untouched, by a timer while anything is
  held as well as on the next call. When a new answer or part would not fit, those idle for two
  seconds (their callers are gone: a live caller fetches the next part within milliseconds) are
  dropped, oldest first, before anything is refused (review of #511, M1); a dropped answer's caller
  is told so and asks `outcome`.
- **Every argument that crosses RPC is checked** (review of #511, M4): queries are a list of SQL
  text with D1's wire values, ids are text, indexes whole numbers; anything else is refused with
  nothing applied.
- **Errors keep the runtime's flags** (M4 of #507): `retryable`, `overloaded`, `remote` and
  `durableObjectReset` are copied onto the `D1_ERROR` the binding throws, and `exec`'s
  `D1_EXEC_ERROR` keeps them and `committed` (review of #511, M2).

### Calls count as subrequests (S6)
Each call `clientDatabase` makes is a Durable Object call. Cloudflare's Workers limits (2026-11)
give an invocation on the Paid plan 10,000 subrequests by default (configurable up to 10 million
with `limits` in the Worker's config), with "subrequests to internal services" matching that
limit, and count D1 queries among them; they do not say in so many words that a Durable Object
call is one. Where D1 had its own 1,000 queries an invocation (the budget ADR 0841's meter keeps
paths under), a client's database draws on the invocation's subrequests, shared with fetches to
gatekeepers and providers, and a batch or an answer in parts costs one call a part.
`clientDbCalls(db)` counts every call a database from `clientDatabase` has made, so the host's
meter can take the difference over a path (packages/core is not changed in this step). The proof
Worker's `/subrequests` (step 1's, after its review) measures where the limit falls on Cloudflare.

### Migrations inside the object
`migrate(list)` is step 1's: the same `applyMigrations` as on D1, in the same order (by name) and
with the same bookkeeping (`core_migrations`, then `core_meta.schema_version` set to the highest
number recorded), one transaction per migration, so a migration that fails leaves the database
exactly as before it and the next call resumes from it. Step 2 adds `migrateAndReport(list)`,
which returns `{ applied, failed: { name, error } | null, level }` instead of throwing, and
`level()`, `getMigrationLevel` read inside the object. `level.schemaVersion` is what step 3's "is
this client behind the code" check compares with `CORE_SCHEMA_VERSION`. A test runs the same list,
out of numeric order, on D1 and on a client's database and requires the same `core_migrations`
rows and `core_meta`.

### Bookmarks and restore (point-in-time recovery)
- The API is Cloudflare's Durable Object storage point-in-time recovery, as documented in 2026-11:
  `ctx.storage.getCurrentBookmark()`, `getBookmarkForTime(time)` (within the last **30 days**) and
  `onNextSessionRestoreBookmark(bookmark)`, which returns a bookmark that undoes the restore and
  takes effect when the object next starts (`ctx.abort()`).
- `ClientDb.bookmark()`, `bookmarkAt(time)`, `restore(bookmark)`, `restart()` and `session()`;
  `restoreClientDb(namespace, client, bookmark)` does the whole of it for the update: it arranges
  the restore, restarts the object, waits until a new session answers, and returns `{ undo }`.
- **What a restore does:** the whole database returns to the bookmark; every write after it is
  discarded, the object's own records with it (outcome records, size limits, its place, a hold).
  From `restore` until the restart the object refuses every call that reads or writes, the
  object's own records included (`query`, `stage`, `commit`, `take`, `outcome`, `place`,
  `setSizeLimits`, `hold`: review of #511, M6), with nothing applied
  (`this client's database is being restored to a bookmark; nothing was applied`), so nothing is
  accepted that the restore would silently discard, and no fence is written that it would lose. A
  call in flight at the restart fails, as any call to a restarting object does. If the caller dies
  before `restart`, the object restarts itself after five seconds. `undo` puts the discarded
  writes back the same way.
- **For the update (step 7):** a write the object acknowledges between `bookmark()` and a restore is
  discarded by the restore. So the update pauses the client (the registry's `paused`, which the
  host refuses to serve) **before** it takes the bookmark, and keeps it paused until the update has
  succeeded or the restore has finished; pausing automations alone is not enough.
- **On Cloudflare** (the proof's `/step2/pitr`, 2026-11-27): a bookmark, a write, a restore to
  the bookmark (1,435 ms, the write gone), then the undo (1,121 ms, the write back), on a real
  object; a write made while the restore waited was refused with `RESTORING_MESSAGE`; and
  `bookmarkAt` a minute before the database existed was refused cleanly.
- **Locally,** workerd answers `getCurrentBookmark()` with a bookmark of zeros and refuses
  `getBookmarkForTime` and `onNextSessionRestoreBookmark` ("This Durable Object's storage back-end
  does not implement point-in-time recovery"); `restore` then reports the refusal and the object
  carries on unchanged. Restore itself is proved only by the proof Worker's `/step2/pitr` on
  Cloudflare.
- **Sessions:** a D1 session's bookmark is a read-replication token, not a restore point; one object
  has no replicas, so `withSession()` is a session over the same object and `getBookmark()` answers
  null, as a D1 session does before its first query. Nothing in the host uses sessions.

### Export and import as SQL
`@composable-os/db/sql-export`: `exportPart(db, cursor, { hold })` / `exportDatabase(db, { hold })`
and `importPart(db, part, { expectedSchema })` / `importDatabase(db, parts, { expectedSchema })`,
over any `D1Database`, so the same code moves a client's database onto D1 (the leaving promise) and
a D1 deployment onto the host.
- **The format** (`cos-sql-export/1`): parts of plain SQL statements with no parameters, each under
  90,000 bytes (D1 and SQLite take 100,000), a part about 4 MiB and at most 20,000 statements.
  `partToSql` writes a part as a `.sql` file the `sqlite3` shell runs. An export is taken a part a
  call with a cursor between calls, so neither the database's size nor an invocation's limits bound
  it.
- **Exactly what it carries:** every ordinary table's rows with every value as stored (integers past
  2^53, reals to the last bit through `quote()`, NULLs, BLOBs, text of any bytes through hex, with
  text that is not UTF-8 or holds a NUL written as `CAST(X'…' AS TEXT)`), the rowid where it is not
  a column, `sqlite_sequence`, FTS5 tables (an external-content index rebuilt from its content, an
  index with its own content given its rows; their shadow tables are not copied: SQLite refuses
  writes to them), and indexes, views and triggers after the rows, in the order they were made, so
  no trigger fires as rows go in; the FTS5 rebuilds run after the views, so an index whose content
  is a view finds it (review of #511, M9). Whether a table has a rowid is read from SQLite
  (`pragma_table_list`'s `wr`), never from its CREATE text, which a trailing comment fools, and the
  rowid is written bare, never as `"rowid"` (which SQLite may take for a string) (M3). A generated
  column is left to its table. A value too large for a statement is
  built a chunk at a time in `_cos_import_scratch` and inserted whole, so a `CHECK
  (json_valid(...))` sees only the whole value. Tables are loaded parents first; a column that
  refers to its own table is inserted as NULL and set once the table's rows are in, so no part
  commits a row whose parent is in a later part.
- **Refused at export:** a virtual table that is not FTS5, a contentless FTS5 table.
- **Not carried:** the object's own storage (`_cf_*`) and `sqlite_stat*`.
- **The database is held still for the whole export, enforced** (review of #511, S3). `hold` is
  required:
  - `clientDbHold(namespace, client)` for a client's database: `ClientDb.hold()` records a hold
    (with a lifetime, five minutes by default, in the object's storage, so it outlives a restart);
    while it is live every set that may write is refused (`this client's database is held still
    while it is exported; nothing was applied`), reads go on. Each part renews it at its start and
    its end, and an export whose hold lapsed at any moment, or was replaced, is refused (`the
    database was not held still for the whole export`): it starts again. The last part releases it,
    and so does `exportDatabase` if the export stops.
  - `"caller-paused"`: the caller guarantees nothing writes. Only for a database this code cannot
    hold, a single-client deployment's D1, which step 7's command pauses first.
  - The schema is fingerprinted at the first part, and every part refuses a schema that changed
    (a migration during an export would otherwise shift the cursor onto another table).
- **An import trusts nothing in the file** (review of #511, S5). The leaving promise means
  importing files that come from elsewhere.
  - **Shapes:** every statement must be one an export writes: a CREATE only if the first part
    declared it (`source.schema`, kept in `_cos_import`); INSERTs of literals (or a value built in
    the scratch table) into a named table; keyed UPDATEs of literals; the scratch table's own
    statements; `sqlite_sequence`; an FTS5 rebuild. Never into `sqlite_*`, `_cf_*` or `_cos_*`;
    no subquery, no second statement, no PRAGMA, no DELETE of rows. A part's fields are type-checked
    (an `index` of `"1"` is refused: M4). A wrong statement refuses the part before anything runs.
  - **The schema:** after the last part, the whole schema (every table, column, index, trigger and
    view, compared by its text) must be what the importing code says it should be,
    `options.expectedSchema(db, source)`. For core objects that is `migrationsSchema(reference,
    migrations, source.migrations)`: the code's own migrations, at the names the export recorded
    (a name the code does not know is refused), applied to an empty reference database. For
    extension objects (`x_*` tables, their indexes, `rec_x_*` views, and core views the reconciler
    rebuilds), whose schema is data-defined, it is what the reconciler derives from the manifests
    the import brought, never the file's own CREATEs: step 7 supplies that from packages/core,
    which packages/db cannot import. Any difference **empties the database** and refuses the
    import, naming the objects that differ.
  - A file can still bring rows into any table the schema has; the host's own checks of those
    rows (an approval floor, a status) are the reconciler's and the host's, as for any import.
- **Import** goes only into a database that holds no table or view (`the database is not empty …`).
  Each part is one transaction that also records the next part due in `_cos_import`, so an import
  that stopped is resumed by giving the same parts again (those already in are skipped); a missing
  part, or a part of another export, is refused. **The last part checks every table's row count in
  its own transaction** (a `CHECK` that rolls it back on any mismatch; the database is then
  emptied), then the schema is verified and `_cos_import` dropped. An import whose last part is in
  but whose verification or drop did not finish is finished by giving the last part again
  (review of #511, S4), and a last part whose answer was lost after it committed is taken as in.
- `dump()` still refuses, now pointing to the export; D1's `query()` (`d1_binding_jsrpc`) is
  refused clearly.
- A test moves a D1 database (every migration, the demo seed and a fixture of every kind of value
  and object) into a client's database and out onto a second D1 database, in parts of 64 KB, and
  compares every table, the schema and the search indexes with a reading that shares no code with
  the export (`@composable-os/db/testing/contents`).

### Size
`size()` is the database's bytes (`sql.databaseSize`, as `meta.size_after`). `usage()` gives
`{ bytes, limitBytes, warnAtBytes, refuseAtBytes, reserveBytes, state }`: the limit is a Durable
Object's 10 GB on the Paid plan (Cloudflare's limits, 2026-11; writes past it fail with
`SQLITE_FULL`, reads and deletes still work), `warning` past 8 GB, `refusing` past 9.5 GB.
- **The refusal leaves room for an erase** (review of #511, M5). Past `refuseAtBytes` a set that
  grows the database by more than 1 MiB is rolled back; a smaller one (a person's erase, a delete
  with its audit rows) still goes in, up to a reserve of 250 MB above the line; past the reserve any
  set that grows the database is refused. A set that does not grow it (a delete) always goes in. The
  message: `D1_ERROR: this client's database is full: … reads, deletes and small writes such as an
  erase still work`; the platform's own `SQLITE_FULL` is reported in the same words.
- **Space is not given back by itself.** SQLite reuses the pages a delete frees, so writes that fit
  in them pass, but the file does not shrink, so `usage().state` stays `refusing` after a cleanup
  until the operator raises the line or the client moves (export, then import into a fresh object,
  which holds only the live pages). Whether a Durable Object's `databaseSize` ever falls after
  deletes, and whether it allows `VACUUM`, is what the proof's `/step2/size` reports.
- The operator may set other thresholds below the limit (`setSizeLimits`, with the reserve), which
  is also how the test exercises the refusal locally (workerd does not allow `PRAGMA
  max_page_count`).

### Place
`clientDatabase(namespace, client, { locationHint })` passes the hint to every `get()`. Cloudflare
places an object where its first `get()` asks and honours no later hint ("Only the first call to
`get()` for a particular Object will respect the hint", best effort), so a later call with a
different hint changes nothing. `place(hint)` records the hint the object was first given and
answers it with `differs: true` when a later caller asks for another; `cos client add` (step 7)
calls it with the registry's hint (Oceania for new clients, stage 43).

### Its own Worker (S9)
Deploying a Durable Object class's Worker restarts every live object of that class. If the host's
app or runner exported `ClientDb`, every release of the host would abort the queries in flight for
every client. So `ClientDb` lives in **its own small Worker**, `apps/client-db` (`cos-client-db`,
renamed to the product's names at deploy), which exports the class and answers no request; it is
deployed only when `ClientDb` changes. It is in `NOT_RELEASED` (`scripts/release/manifest-lib.ts`),
so no single-client release or install ships it and the release manifest is unchanged; a
deployment gains it when it holds clients (steps 3 and 7 decide how the release carries it then).

### The host binds the query path only (review of #511, S6; the coordinator's decision)
`ClientDb` has the operator's methods (`restore`, `restart`, `setSizeLimits`, `migrate`,
`migrateAndReport`, the bookmark calls, `hold`, `place`) on the same object as the query path, and
whatever holds its namespace can call them. So the host's Workers never hold the namespace:
- `cos-client-db` also exports **`ClientDbQueries`**, a `WorkerEntrypoint`
  (`packages/db/src/client-db-service.ts`) that serves only `query`, `stage`, `commit`, `take` and
  `outcome`, each for a target `{ client, locationHint? }` it checks: the client id by the
  registry's rule (`validateClientId`, `packages/db/src/registry.ts`, step 3) and the hint against
  Cloudflare's list. `clientDatabaseService(service, client, { locationHint })` is the same
  `D1Database` as `clientDatabase`, over that service.
- **Binding names**, for step 4 to switch to mechanically:
  - the app and the runner: `"services": [{ "binding": "CLIENT_DB_QUERIES", "service":
    "cos-client-db", "entrypoint": "ClientDbQueries" }]`, and the client's `DB` is
    `clientDatabaseService(env.CLIENT_DB_QUERIES, client.id, { locationHint })` where step 3's
    `buildClientEnvironment` now calls `clientDatabase(env.CLIENT_DB, …)`; `hostMode` then requires
    `CLIENT_DB_QUERIES` where it requires `CLIENT_DB` today.
  - the operator's commands (step 7): `"durable_objects": { "bindings": [{ "name": "CLIENT_DB",
    "class_name": "ClientDb", "script_name": "cos-client-db" }] }`, with `clientDatabase(env.CLIENT_DB,
    client)` and the operator methods on its stubs.
  - tests keep binding the namespace (`CLIENT_DB`).
- A test calls each operator method through the service and finds it is not there ("The RPC
  receiver does not implement …"), and that a client id the registry refuses is refused.
- **Settled by the proof (2026-11-27): no 32-call limit.** Cloudflare's service-binding page
  (2026-11) says service bindings add "zero overhead or added latency" (both Workers run on the
  same thread), and also "A single request has a maximum of 32 Worker invocations, and each call to
  a Service binding counts towards this limit". On Cloudflare one request made 9,980 queries
  through `ClientDbQueries` before the ordinary 10,000-subrequest refusal, so that sentence did
  not apply to RPC calls to an entrypoint, and the query-only shape stands. Warm, the service costs
  nothing measurable against the namespace (31 against 30 ms for the staff list; ADR 0612,
  "Measured on Cloudflare").
- **The proof measures this arrangement** (after its first three runs had the class inside the
  7.7 MB proof Worker): `apps/client-db` deployed as `<product>-client-db-proof-db`, the timed
  pages through `ClientDbQueries`, setup and the operator's probes through the namespace.

## Consequences
- A single-client deployment is unchanged: nothing outside `packages/db`, `apps/client-db` and the
  proof Worker uses any of this, and every Worker still opens `createCrmDb(env.DB)` on D1.
- Every set that may write costs two more rows written in the object's own storage (its outcome
  record and its entry by time), and every set one key-value read (its id, and whether a hold is
  live). None shows in `meta.changes`, `rows_written` or `last_row_id`.
- What is proved locally: the answers (B1, S1, M1, M2, M4 of #507; S1, S2, S7, M1, M2, M4 of #511),
  the call counter, migrations and their report, the size refusal and its reserve, place, the
  holds, the local refusal of restore, the query-only service, and export and import both ways
  between D1 and a client's database, with the statement checks, the schema verification and the
  in-transaction counts. Shown on Cloudflare (2026-11-27, `/step2/pitr`): restore and undo on a
  real object, how long they take, and a call refused in the window. Still waiting for the proof
  run, the next probes having timed out as one long request each and been made resumable since
  (`/step2/export`, `/step2/d1`, `/step2/answers`, `/step2/size`, driven a bounded call at a time
  by `scripts/step2.mjs`): the export across real D1 and Durable Objects; whether real D1 allows
  each feature the export and import use; the large batch, the 40 MB read and a 60 MB read refused
  without a reset there; and whether a Durable Object's size falls after deletes and what
  `VACUUM` answers. The
  restore window's refusals of `outcome`, `place` and `setSizeLimits` (M6), the bounded outcome
  sweep (M7) and the memory bound of S7 (that a large read no longer fills the isolate) are not
  exercised by any test: the local runtime cannot enter the restore window, an hour cannot pass in
  a test, and local memory is not the isolate's.
- Step 7's commands and the update call: `migrateAndReport`, `level`, `bookmark`,
  `restoreClientDb`, `place`, `hold` (through `clientDbHold`), `exportPart`/`exportDatabase`,
  `importPart`/`importDatabase`, `migrationsSchema`, `schemaRows`, and step 10's usage calls
  `usage`. Step 7 also supplies the extension half of `expectedSchema` (the reconciler's).
