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
  refused **inside the transaction**, which rolls back: `D1_ERROR: the result is about N MiB, more
  than the 48 MiB a client's database returns for one query set; read it in pages. Nothing was
  applied`. D1 returns larger results; a client's database does not, so a read that large is read
  in pages (ADR 0612's table).
- **Every set that wrote is recorded under its id in the same transaction** (the object's own
  key-value storage, `_cf_KV`, never the client's schema), so "committed" and "recorded as
  committed" cannot be separated. The binding sends every set with a fresh id. When a call's answer
  is lost (the call threw, the object restarted before the rest of a held answer was taken), the
  binding asks `outcome(id)`: if the set committed and its answer is still held, the answer is
  fetched again; if it committed and the answer is gone, the error says so
  (`D1_ERROR: the batch committed, but its answer was lost …; it must not be sent again`, with
  `committed: true` and `retryable: false`); if it did not, `outcome` **fences** the id, so a set
  still on its way is refused when it arrives, and the original error stands. A set whose id is
  already recorded is never run again. Records are kept an hour.
- **A batch sent in parts is indexed** (M1): `stage(batch, index, queries)`, and `commit` refuses,
  with nothing applied, unless parts 0 to n-1 each arrived exactly once; they are applied in index
  order whatever order they came in.
- **What the object holds for callers is bounded and swept** (M2): staged parts and held answers
  together at most 64 MiB (a stage past it is refused and its batch dropped), each forgotten after
  a minute, by a timer while anything is held as well as on the next call.
- **Errors keep the runtime's flags** (M4): `retryable`, `overloaded`, `remote` and
  `durableObjectReset` are copied onto the `D1_ERROR` the binding throws.

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
Worker's `/step2/calls` measures where the limit falls on Cloudflare.

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
  discarded, the object's own records with it (outcome records, size limits, its place). From
  `restore` until the restart the object refuses every call with nothing applied
  (`this client's database is being restored to a bookmark; nothing was applied`), so no write is
  accepted that the restore would silently discard. A call in flight at the restart fails, as any
  call to a restarting object does. If the caller dies before `restart`, the object restarts itself
  after five seconds. `undo` puts the discarded writes back the same way.
- **Locally,** workerd answers `getCurrentBookmark()` with a bookmark of zeros and refuses
  `getBookmarkForTime` and `onNextSessionRestoreBookmark` ("This Durable Object's storage back-end
  does not implement point-in-time recovery"); `restore` then reports the refusal and the object
  carries on unchanged. Restore itself is proved only by the proof Worker's `/step2/pitr` on
  Cloudflare.
- **Sessions:** a D1 session's bookmark is a read-replication token, not a restore point; one object
  has no replicas, so `withSession()` is a session over the same object and `getBookmark()` answers
  null, as a D1 session does before its first query. Nothing in the host uses sessions.

### Export and import as SQL
`@composable-os/db/sql-export`: `exportPart(db, cursor)` / `exportDatabase(db)` and
`importPart(db, part)` / `importDatabase(db, parts)`, over any `D1Database`, so the same code moves
a client's database onto D1 (the leaving promise) and a D1 deployment onto the host.
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
  writes to them), and indexes, views and triggers last, in the order they were made, so no trigger
  fires as rows go in. A generated column is left to its table. A value too large for a statement is
  built a chunk at a time in `_cos_import_scratch` and inserted whole, so a `CHECK
  (json_valid(...))` sees only the whole value. Tables are loaded parents first; a column that
  refers to its own table is inserted as NULL and set once the table's rows are in, so no part
  commits a row whose parent is in a later part.
- **Refused at export:** a virtual table that is not FTS5, a contentless FTS5 table.
- **Not carried:** the object's own storage (`_cf_*`), `sqlite_stat*`, and writes made during the
  export: nothing may write while a database is exported (step 7 pauses the client first). The last
  part carries every table's row count, which the import checks.
- **Import** goes only into a database that holds no table or view (`the database is not empty …`).
  Each part is one transaction that also records the next part due in `_cos_import`, so an import
  that stopped is resumed by giving the same parts again (those already in are skipped); a missing
  part, or a part of another export, is refused. The last part checks the counts and drops
  `_cos_import`.
- `dump()` still refuses, now pointing to the export; D1's `query()` (`d1_binding_jsrpc`) is
  refused clearly.
- A test moves a D1 database (every migration, the demo seed and a fixture of every kind of value
  and object) into a client's database and out onto a second D1 database, in parts of 64 KB, and
  compares every table, the schema and the search indexes with a reading that shares no code with
  the export (`@composable-os/db/testing/contents`).

### Size
`size()` is the database's bytes (`sql.databaseSize`, as `meta.size_after`). `usage()` gives
`{ bytes, limitBytes, warnAtBytes, refuseAtBytes, state }`: the limit is a Durable Object's 10 GB
on the Paid plan (Cloudflare's limits, 2026-11; writes past it fail with `SQLITE_FULL`, reads and
deletes still work), `warning` past 8 GB, `refusing` past 9.5 GB. Past `refuseAtBytes` a set that
grows the database is rolled back with `D1_ERROR: this client's database is full: … reads and
deletes still work`; the platform's own `SQLITE_FULL` is reported in the same words. The operator
may set other thresholds below the limit (`setSizeLimits`), which is also how the test exercises
the refusal locally (workerd does not allow `PRAGMA max_page_count`).

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
renamed to the product's names at deploy), which exports the class and answers nothing; the app
and the runner bind to it as a Durable Object namespace by script name, and it is deployed only
when `ClientDb` changes. It is in `NOT_RELEASED` (`scripts/release/manifest-lib.ts`), so no
single-client release or install ships it and the release manifest is unchanged; a deployment
gains it when it holds clients (steps 3 and 7 decide how the release carries it then).

## Consequences
- A single-client deployment is unchanged: nothing outside `packages/db`, `apps/client-db` and the
  proof Worker uses any of this, and every Worker still opens `createCrmDb(env.DB)` on D1.
- Every write set costs one more row written in the object's own storage (its outcome record),
  and every set one key-value read. Neither shows in `meta.changes`, `rows_written` or
  `last_row_id`.
- What is proved locally: the answers (B1, S1, M1, M2, M4), the call counter, migrations and their
  report, the size refusal, place, the local refusal of restore, and export and import both ways
  between D1 and a client's database. What waits for the proof run on Cloudflare (`/step2/pitr`,
  `/step2/export`, `/step2/answers`, `/step2/calls`, run by the workflow after the timing): restore
  and undo on a real object and how long they take, the export across real D1 and Durable Objects,
  the large batch and read there, and where the subrequest limit falls for calls to a client's
  database.
- Step 7's commands and the update call: `migrateAndReport`, `level`, `bookmark`,
  `restoreClientDb`, `place`, `exportPart`/`exportDatabase`, `importPart`/`importDatabase`, and
  step 10's usage calls `usage`.
