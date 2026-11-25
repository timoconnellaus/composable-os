# Stage 67: Postgres as a second database

Read first: [`AGENTS.md`](../../AGENTS.md), [`docs/architecture.md`](../architecture.md),
[`CONTEXT.md`](../../CONTEXT.md), ADRs [0002](../adr/0002-d1-real-tables.md),
[0014](../adr/0014-kysely-for-core-schema.md),
[0020](../adr/0020-query-sql-validator-and-csv-import.md),
[0550](../adr/0550-timed-moves-and-a-cancel-that-races-a-booking.md),
[0611](../adr/0611-one-host-a-database-per-client.md),
[0623](../adr/0623-offers-and-takes-the-race-and-the-cut-off.md) and
[0950](../adr/0950-two-targets-cloudflare-and-aws.md); stage
[66](66-one-host-many-clients.md); `packages/db/src/handle.ts`, `dialect.ts` and `migrate.ts`,
`packages/db/migrations/0006_search.sql` and `0560_recurring.sql`, `packages/core/src/errors.ts`,
`operation.ts`, `operations/query.ts` and `operations/search.ts`, `extensions/reconciler.ts` and
`extensions/schema.ts`, `recurring/bookkeeping.ts`, `dashboards/params.ts`,
`packages/sdk/src/formula/compile.ts`, `packages/core/test/helpers.ts` and
`packages/core/vitest.config.ts`.

Status: **spec proposed (2026-11-26)**. Not built until its interview settles the questions at its end.

This is the first of eight stages (67 to 74) that give the host a second target, AWS. It changes
no Worker and deploys nothing. It makes `packages/db`, `packages/core`, the formula compiler and
the packs' dashboards work on Postgres as they do on SQLite, and proves it in CI.

## Goal

The host's records, rules and queries run on Postgres with the same behaviour as on D1. One
`CrmDb` interface has two implementations. Core's suite passes against both. A pack author and
the assistant write one kind of dashboard SQL that runs on both. Cloudflare deployments are
unchanged.

## What exists today (from the code)

- **The handle.** `CrmDb` (`packages/db/src/handle.ts`) is `query` (Kysely), `batch(statements)`
  (the only atomic unit, D1's `batch()`), `size()` (from D1's `meta.size_after`) and `readOnly()`
  (a textual check, `isReadOnlySql`, because D1 has no read-only session). The dialect
  (`dialect.ts`) is Kysely's SQLite compiler over a D1 binding and throws on an interactive
  transaction.
- **How a call writes.** A handler reads through `ctx.db` at once, queues statements with
  `ctx.write()`, and the pipeline commits them as one batch (`HandlerContext`,
  `packages/core/src/operation.ts`). Reads are not in the batch's transaction.
- **D1 result fields.** `meta.changes` and `meta.last_row_id` are read only in `dialect.ts`, where
  they become Kysely's `numAffectedRows` and `insertId`. Core reads `numAffectedRows` in three
  files (`guesses.ts`, `customers/email-change.ts`, `http/idempotency.ts`) and `insertId` nowhere.
  `rows_read` is read only by tests (24 files that hold a query to a cost).
- **Migrations.** 161 SQLite files in `packages/db/migrations`, applied by `applyMigrations`
  (`migrate.ts`, which takes a `D1Database` and reads `sqlite_master`) or by
  `wrangler d1 migrations apply`, sharing the `core_migrations` table. Parallel stages take number
  ranges, so files land out of numeric order; the schema version is the highest number recorded
  (ADR 0002's amendment). They hold about 280 `CREATE TABLE`, 73 views, 360 triggers in 71 files,
  441 `RAISE(ABORT, …)` with about 140 distinct codes, 14 `RAISE(IGNORE)`, about 200 partial
  indexes, 70 `WITHOUT ROWID`, 7 `AUTOINCREMENT`, 29 `GLOB`, 118 `json_valid` and two FTS5 tables.
- **Conventions.** Booleans are `INTEGER` 0 or 1, dates and times ISO-8601 `TEXT`, money `INTEGER`
  minor units, JSON `TEXT`, ids `TEXT`.
- **Errors.** `toOperationError` (`packages/core/src/errors.ts`, 1,203 lines) decides what a failed
  batch meant by 117 `message.includes(…)` tests on SQLite's message text: rule codes, and
  `UNIQUE constraint failed: table.column`.
- **Guards.** `core_write_guard` (migration 0560, remade with more kinds in 0670, 0690 and 0851)
  stores nothing: a statement inserts what the plan read, a `BEFORE INSERT` trigger compares it
  with what is there now and either raises or drops the row with `RAISE(IGNORE)`.
  `guardStatement` is in `recurring/bookkeeping.ts`. `core_staff_guard` works the same way and
  reads SQLite's `changes()` (`staffing/time.ts`, `staffing/leaving.ts`). ADR 0623's offers rely on
  "D1 runs one batch at a time" with no guard at all.
- **SQLite in core's SQL.** Kysely's `sql` tag is in about 150 files of `packages/core/src`, and
  `CompiledQuery.raw` with `?` placeholders about 190 times in 52. SQLite-only forms, by rough
  count: `json_extract` 143, `json_each` 138, `strftime` 34, `julianday` 21, `date(` and
  `datetime(` about 45, `INSERT OR IGNORE` or `OR REPLACE` 34, `COLLATE NOCASE` 6, `GLOB` 4,
  `changes()` 2, and `sqlite_master` in four places (`records/erase-stores.ts`,
  `records/relations.ts`, `operations/query.ts`, `extensions/schema.ts`).
- **Extensions.** The reconciler (`extensions/reconciler.ts`, 1,759 lines) writes `CREATE TABLE`,
  `ALTER TABLE … ADD`, `RENAME` and `DROP COLUMN`, partial indexes and `DROP VIEW`. `schema.ts`
  (1,712 lines) generates the `rec_*` views, with `json_extract` for document fields and the
  scalar `min(a, b)`. The formula compiler (`packages/sdk/src/formula/compile.ts`) emits
  `julianday`, `strftime`, `date(x, modifier)` and `printf`.
- **Query SQL.** `operations/query.ts` (557 lines) is a tokenizer that lexes exactly as SQLite
  does and an allow-list over the tokens (ADR 0020). It reads every schema name from
  `sqlite_master`, refuses reserved prefixes, allows `json_each` and `json_tree` as tables, wraps
  the SQL in `SELECT * FROM (…) LIMIT n+1` and races it against a timer, since D1 cannot cancel.
  `dashboards/params.ts` turns named parameters (`:today`, `:now`, `:date_from`, `:me`) into
  positional ones.
- **Dashboard SQL in packs.** 71 `sql:` strings in 8 `packs/*/dashboards.ts`. The SQLite-only
  parts are few: `strftime` 9 times, `date(x, modifier)` 8, `printf` once. Core's own overview
  (`dashboards/overview.ts`) has more.
- **Search.** `core_search` (FTS5 over `core_search_docs`, `unicode61 remove_diacritics 2`, prefix
  indexes; migration 0006) and `core_published_text_fts` (0970). `MATCH`, `bm25` and `snippet` are
  in `operations/search.ts`, `operations/content.ts`, `ai/hybrid.ts` and `assistant/memory.ts`,
  joined on `rowid`.
- **Tests.** `packages/core/test` has 270 test files. They run inside workerd
  (`vitest.config.ts`), read `env.DB` from `cloudflare:workers`, and 219 of them seed or check
  with raw D1 statements (about 2,060 `.prepare(` calls).
- **Already on Node.** `packages/extension-check/src/node/local-db.ts` puts Node's SQLite behind
  the same Kysely dialect so `cos ext check` can run the reconciler outside workerd.
- **Not anywhere:** a Postgres driver, a second migration set, a database error that is not a
  SQLite message, a schema chosen per connection.

## Decided by the owner (2026-11-26)

| # | Decision |
| --- | --- |
| 1 | **Two targets.** Cloudflare as it is, and AWS with RDS Postgres. The reason is a health product that must keep its data in Australia |
| 2 | **Two databases, one query layer.** Kysely with a Postgres dialect beside the D1 one. A Postgres migration set beside the SQLite set, starting from one squashed baseline |
| 3 | **Rules in triggers are ported** to Postgres triggers that raise the same rule codes. One error mapper per database |
| 4 | **Write ordering.** On Postgres a unit of work is one transaction holding one lock for its client, so a client's writes run one at a time, as D1's do |
| 5 | **Dashboard SQL is one portable subset** for pack authors and the assistant, with date helpers supplied by the host. The validator enforces it |
| 6 | **Search is Postgres full-text search** behind the same search operation |
| 7 | **A schema per client in one Postgres database.** No table gains a client column (ADR 0611's rule, kept) |
| 14 | **Core's suite runs against both databases in CI** |
| 15 | **The build starts after stage 66 lands** |

## The design in one page

```
 operations, pipeline, reconciler, dashboards        packages/core, one body of code
        │  ctx.db (Kysely)   ctx.write() ─► batch          │ SQL that both databases accept,
        ▼                                                  │ or a helper from the dialect module
   CrmDb: query · batch · readOnly · size · dialect
        │                                   │
   SQLite handle (as today)            Postgres handle
   D1, or stage 66's ClientDb          a pool, one schema per client
   batch = D1 batch                    batch = BEGIN · client lock · statements · COMMIT
        │                                   │
   migrations/*.sql                    migrations-pg/: one baseline, then a twin per later file
        └────────── CI: same schema, same rule codes, core's suite on both ──────────┘
```

- **One interface.** Everything above `CrmDb` is the same code on both databases.
- **The same logical types.** A date is ISO text and a boolean is 0 or 1 on Postgres too, so the
  application code, the `rec_*` views and dashboard SQL do not fork.
- **Three tiers of SQL.** SQL both databases accept is written once. Where they differ, core calls
  one small dialect module. Only migrations are written twice.
- **A client is a schema.** The handle is made for one schema and sets `search_path` to it. No
  query names a schema.

## The model

### The Postgres handle

`createPostgresCrmDb({ pool, schema })` in `packages/db` returns a `CrmDb`. It uses Kysely's own
`PostgresDialect` over `pg` (node-postgres), the driver that dialect is written for.

- **`query`** runs a read on a pooled connection with the client's `search_path` (below).
- **`batch(statements)`** is one transaction at `READ COMMITTED`: `BEGIN`, take the client's lock,
  run the statements in order, `COMMIT`. Any error rolls all of it back, as a D1 batch does.
  Statements see the effects of earlier ones.
- **A single write through `query`** (the three `numAffectedRows` sites, and any insert, update or
  delete executed directly) runs as a batch of one, so it holds the lock too. No write on
  Postgres runs outside the lock.
- **`readOnly()`** runs each statement in a `READ ONLY` transaction, so Postgres refuses a write.
  The error (SQLSTATE 25006) becomes `ReadOnlyDatabaseError`. `isReadOnlySql` stays for SQLite.
- **`size()`** is the sum of `pg_total_relation_size` over the schema's tables.
- **`dialect`**, new on `CrmDb` and on `HandlerContext`: `"sqlite"` or `"postgres"`, with the
  helper module for it.
- **Interactive transactions stay refused** on both handles. Core is written for read, plan, then
  one batch, and keeping that shape is what keeps the two databases alike.

What replaces the D1 result fields:

| D1 | Postgres |
| --- | --- |
| `meta.changes` | The command's row count, as `numAffectedRows` |
| `meta.last_row_id` | Nothing. Core does not read it. A statement that needs a made id uses `RETURNING` |
| `meta.size_after` | `size()` above |
| `rows_read` | Nothing. The 24 cost tests run on SQLite only (see Tests) |
| SQLite's `changes()` inside a batch | A data-modifying `WITH … RETURNING` whose count the guard insert reads, built by a dialect helper |

Three conversions happen in the handle, each with tests:

- **Placeholders.** `CompiledQuery.raw` strings are written with `?`. The Postgres handle renumbers
  them to `$1…` with a small tokenizer that skips strings, quoted names and comments. Core does
  not use Postgres's `?` JSON operators.
- **Values in.** A JavaScript boolean is sent as 0 or 1, as D1 does today.
- **Values out.** `bigint` and `numeric` come back as JavaScript numbers, as SQLite's integers do,
  and a value past 2^53 throws instead of losing digits.

### A schema per client

- One Postgres database holds every client of a deployment. Each client has a schema
  (`c_<client id>`). A single-client deployment has one schema and is otherwise the same.
- **`search_path` is set per unit of work.** In a batch it is `SET LOCAL` after `BEGIN`. For a
  read, the handle sets it on the connection it was given, and remembers on the connection which
  schema it last set, so a run of reads for one client costs one extra round trip, not one each.
- **Fail closed.** The path is the client's schema and one shared schema for Postgres extensions,
  never `public`. The role's default path names a schema with no tables, so a connection that
  missed the step finds nothing.
- **The lock is per schema:** `pg_advisory_xact_lock` on a 64-bit hash of the schema name. A hash
  collision makes two clients wait for each other and is never wrong.
- **How this meets stage 66.** Stage 66 gives every entry "the client's environment", whose `DB`
  is that client's database behind the D1 interface. On AWS the same seam hands out a `CrmDb` for
  the client's schema. So the unit both targets share is `CrmDb`, not `D1Database`: code that
  takes a `D1Database` today (`applyMigrations`, `getMigrationLevel`) takes a `CrmDb` after this
  stage. The call sites in the apps (`createCrmDb(env.DB)`) and the registry on AWS are stages
  [68](68-host-on-node.md) and [70](70-deploy-to-aws.md).

### Writes, guards and the lock

The guard pattern is: read, plan, then one batch whose trigger aborts if what was read has moved.
It is correct on D1 because batches run one at a time. On Postgres without a lock it is not: two
transactions can each run the guard's trigger, neither sees the other's uncommitted change, and
both commit.

One lock per client per unit of work restores the D1 property exactly:

- The lock is the first statement after `BEGIN`. A second batch for the same client waits there.
- At `READ COMMITTED` every statement takes a fresh snapshot. So when the second batch gets the
  lock, each of its statements, and each trigger they fire, sees everything the first committed.
  The guard compares against the true counter and aborts if it moved.
- This is why the level is `READ COMMITTED` and never `REPEATABLE READ`: there the snapshot would
  be taken while waiting for the lock and the guard would compare against stale rows.
- ADR 0623's offers need nothing more: the second take runs its update after the first commits
  and the trigger refuses it.
- A batch holds only planned statements, with no application code between them, so the lock is
  held for the time the statements take. Clients do not wait for each other.
- Migrations and the reconciler's DDL run in a batch and take the same lock.

`core_write_guard` and `core_staff_guard` are ported as tables with a `BEFORE INSERT` trigger that
raises the same codes and returns `NULL` where SQLite says `RAISE(IGNORE)`, so nothing is stored.

### The Postgres migration set

- **Where.** `packages/db/migrations-pg/`. The baseline is one file equal to the SQLite set at one
  moment, with a manifest naming every SQLite migration it stands for. Because migrations land out
  of numeric order, "later" means "not in the manifest", not "a higher number".
- **How the baseline is made.** A script reads a migrated SQLite database and writes the tables,
  columns, defaults, primary keys and indexes. Triggers, views, checks and search are ported by
  hand and reviewed once. The script is kept, so the baseline can be cut again while the stage is
  being built.
- **After the baseline,** each SQLite migration has a Postgres file of the same name beside it,
  or a file that says in one comment why Postgres needs nothing.
- **One runner.** `applyMigrations(db: CrmDb, migrations)` applies either set, one batch per file,
  with the same `core_migrations` table. The expected schema version is the highest number in
  the set being applied (the same for both until a Postgres-only migration exists, below).
- **Type mapping.** The logical types stay the same:

  | SQLite | Postgres | Why kept |
  | --- | --- | --- |
  | `TEXT` | `text`, compared by bytes (`COLLATE "C"`) | Ids, cursors and ISO dates sort as they do on SQLite |
  | `INTEGER` (numbers, money) | `bigint` | SQLite's integers are 64-bit |
  | `INTEGER` 0 or 1 (booleans) | `smallint` with the same check | `WHERE flag = 1` is the same SQL |
  | `TEXT` dates and times | `text` | Comparisons, `substr` and the formula types are unchanged |
  | `TEXT` JSON | `text`, `CHECK (x IS JSON)` for `json_valid` | The value read back is the string written |
  | `REAL` | `double precision` | |
  | `INTEGER PRIMARY KEY AUTOINCREMENT` | `bigint` identity | |
  | `WITHOUT ROWID` | A plain table | |
  | Partial and expression indexes | The same | |
  | `GLOB` checks | A regular expression check | |

  **What keeping them costs:** no native date arithmetic or JSON indexes on Postgres, text dates
  that take more room than `timestamptz`, and an outside reporting tool sees text. Postgres also
  holds a column to its type, where SQLite stores whatever it is given, so the port will find
  places that wrote text into a number column. Those are fixed in core, for both databases.
- **Postgres 16 or later** (`IS JSON`). The exact version is a setting of stage 70.

**How CI proves the two sets are one schema:**

1. **Structure.** Both sets are applied, each database is read into one neutral description
   (tables, columns with logical type, nullability and default, primary keys, unique and partial
   indexes with their predicates, views with their column names), and the two are compared. Any
   difference fails.
2. **Pairs.** Every SQLite migration outside the manifest has its Postgres twin.
3. **Rule codes.** Every code raised in the SQLite set is raised in the Postgres set and is known
   to the error mapper.
4. **Behaviour.** Trigger bodies and checks cannot be compared as text. Core's suite running on
   both is the proof that they act alike.

**Tables only one database has.** The two sets are not required to hold exactly the same tables.
On Cloudflare some state lives in a Durable Object's own SQLite (an assistant thread and its jobs,
a connection's state); on AWS it lives in tables in the client's schema, which stages
[72](72-assistant-on-aws.md) and [73](73-connections-on-aws.md) add to the Postgres set only.

- One checked-in list, `packages/db/migrations-pg/postgres-only.json`, names each such table, the
  stage that added it and what holds that state on Cloudflare. Its views, indexes and triggers
  go with the table.
- The structure check leaves the listed tables out and compares everything else. A table found
  in one database and not the other, and not on the list, fails. So does a listed table that the
  SQLite set also has, and a listed name that no Postgres migration makes.
- A migration that makes only a listed table has no SQLite twin, and says so in its first line.
  The pair check reads the list for that.
- A shared table must still match in full. It may not gain a column, index or trigger on Postgres
  alone, and no trigger on a shared table may read or write a listed one, so a shared rule never
  depends on state only one target has.
- A Postgres-only migration takes a number from its block like any other, and SQLite has no file
  of that number. So the expected schema version is worked out per database, as the highest
  number in that database's own set (`scripts/schema-version.mjs` reads one directory today and
  writes one constant; it writes one for each). Otherwise a D1 database could never be "up to
  date" once a Postgres-only migration had the highest number.
- The list starts empty in this stage. Adding to it is a reviewed change in the stage that needs
  it. There is no SQLite-only list: the FTS5 tables are handled by the search port, not by
  exemption.

### Triggers and rule codes

Each SQLite trigger becomes a PL/pgSQL function and a trigger with the same name, raising the same
code as the message of `RAISE EXCEPTION`. Four differences are handled by rule, not case by case:

- **Order.** Postgres fires a table's triggers in name order. Where two triggers on one table can
  refuse the same write with different codes, the names are chosen so the order matches SQLite's.
- **Recursion.** D1 runs with recursive triggers off (the migrations say so in 0811, 0815 and
  0851). Postgres always fires triggers for a trigger's own writes. A ported trigger that writes
  to a table with triggers checks `pg_trigger_depth()` where SQLite's behaviour depended on it.
- **`INSERT OR REPLACE`.** Rewritten as an upsert on a named conflict target, in the migrations
  and in core, since Postgres has no replace and SQLite's deletes rows without firing triggers.
- **`RAISE(IGNORE)`** is `RETURN NULL` from a `BEFORE` row trigger.

### The error mapper

A failed statement is first decoded into one normal form, by a decoder per database:

- `{ kind: "rule", code }`: SQLite's `RAISE(ABORT)` text, or Postgres's raised exception.
- `{ kind: "unique", table, columns }`: SQLite's `UNIQUE constraint failed: t.a, t.b`, or
  Postgres's SQLSTATE 23505 with the error's table and the columns of its constraint (looked up
  once from the catalogue and cached).
- `{ kind: "check" | "not_null" | "foreign_key", table, … }` and `{ kind: "unknown" }`.

`toOperationError` then matches on the normal form. Its 117 text tests become a table from rule
code or unique key to the operation error, which is also what CI's rule-code check reads. The
messages people see do not change.

### The dialect module

The rule for core's SQL, in order: write SQL both databases accept; if there is none, call the
dialect module; never write one database's function in core. The common forms cover much of
today's use (`ON CONFLICT … DO UPDATE`, `ON CONFLICT DO NOTHING` for `INSERT OR IGNORE`,
`coalesce`, `CASE`, `substr`, `||`, `lower()` for `COLLATE NOCASE`).

The module is `packages/db/src/sql/`, one interface with a SQLite and a Postgres implementation,
reached as `ctx.dialect` or from the handle. It is small on purpose:

| Helper | For |
| --- | --- |
| JSON: text or number at a path, each element of an array, build an array or object | `json_extract`, `json_each`, `json_group_array`, `json_object` |
| Dates: now, add days or months, days between, the date of a time, start of week or month, weekday, hour | `strftime`, `julianday`, `date()`, `datetime()` |
| Text: join a group, pattern match without case | `group_concat`, `GLOB`, SQLite's case-blind `LIKE` |
| `least`, `greatest` | SQLite's scalar `min(a, b)`, `max(a, b)` |
| Rows changed by the statement before | `changes()` in `core_staff_guard` |
| Schema: tables, views and indexes of this database | `sqlite_master` |
| A typed parameter | Postgres cannot always infer a bare parameter's type |

A lint check (beside `scripts/check-stray-names.mjs`, run by `pnpm lint`) fails on a SQLite-only
or Postgres-only function in `packages/core/src` outside this module.

### The reconciler, the `rec_*` views and formulas

- **Types.** The reconciler's three column types map as in the table above.
- **Reading the schema** goes through the dialect module's schema helper, limited to the client's
  schema.
- **Views are bound early on Postgres.** A view holds its columns from the moment it is made:
  a column under a view cannot be dropped, and `SELECT b.*` does not grow when the table does. So
  on both databases the reconciler drops the generated views it will touch first, changes tables,
  then makes the views again in dependency order, all in one batch. Whether any generated view has
  two columns of one name, which SQLite allows and Postgres refuses, is checked in step 9.
- **The view generator** asks the dialect module for JSON paths and `least`.
- **The formula compiler** takes a target. Its output for dates (`julianday` differences,
  `strftime`, `date(x, modifier)`, `printf`) is the part that differs; arithmetic, `CASE` and
  `CAST` are common. Text dates keep the formula types as they are. A formula's result is the
  same value on both databases, held to by running the SDK's formula tests against both.

### Dashboard and assistant SQL: one portable subset

- **The subset** is what both databases lex and run alike: one `SELECT` or `WITH`, `rec_*` views
  and the query's own CTEs, joins, `GROUP BY`, `ORDER BY`, `LIMIT`, `CASE`, `coalesce`, `nullif`,
  `substr`, `||`, `lower`, `upper`, `trim`, `length`, `round(x)`, `abs`, and the aggregates
  `count`, `sum`, `min`, `max`, `avg`. Functions are an allow-list, where today they are a
  deny-list.
- **Refused as not portable:** SQLite's `strftime`, `date(x, modifier)`, `julianday`, `printf`,
  backtick and bracket names, `json_each` as a table; Postgres's `::` casts, `E'…'` and dollar
  strings, nested comments; a comparison used as a number (`sum(a = b)`).
- **Date helpers are supplied by the host** and written as plain function calls:
  `add_days(x, n)`, `add_months(x, n)`, `days_between(a, b)`, `day_of(x)`, `week_start(x)`,
  `month_start(x)`, `weekday(x)`, `hour_of(x)`, `pad2(n)`. D1 has no user functions, so the
  validator expands each call into the database's own SQL after checking it. The named parameters
  (`:today`, `:now`, the date windows, `:me`) stay as they are.
- **The tokenizer** keeps ADR 0020's rule, lexing exactly as the engine does, by accepting only
  text that both engines lex the same way and refusing the rest.
- **On Postgres the database also enforces it.** The checked SQL runs in a read-only transaction
  with a statement timeout, which cancels the query (D1 can only stop waiting), as a role that
  may read only that client's `rec_*` views. On D1 the validator remains the only boundary.
- **Existing SQL on Cloudflare keeps running.** A dashboard a person or the assistant saved on a
  D1 deployment may hold SQLite functions. On SQLite the validator still accepts what it accepts
  today and marks such a query "not portable". On Postgres only the subset is accepted.
- **Packs are held to the subset.** The 71 strings in `packs/*/dashboards.ts` and core's overview
  are rewritten with the helpers, and `cos ext check` refuses a pack dashboard that is not
  portable. The operation's description and the skill
  (`skills/add-automations-tools-dashboards`) teach the subset.

### Search

Behind the same operations (`search`, published content search, hybrid search, the assistant's
memory lookup):

- `core_search_docs` and `core_published_text` gain a generated `tsvector` column (title weighted
  above body) with a GIN index. The three sync triggers each FTS5 table needs go away, and so do
  the joins on `rowid`. The triggers that rebuild a record's row are ported.
- **Tokens.** `unicode61` splits `ada@example.com` into `ada`, `example`, `com`. Postgres's parser
  keeps an email or host whole. So the indexed text and the query are first reduced to letters,
  digits and spaces, with accents removed (`unaccent`), under the `simple` configuration, which
  does no stemming, as FTS5 does none.
- **Queries** are every word as a prefix term, all required, as `ftsQuery` builds today.
- **Ranking differs.** `bm25` weighs a word by how rare it is; `ts_rank_cd` does not. The same
  records match on both databases. Their order can differ.
- **Snippets differ.** `ts_headline` picks its own fragment and is run only on the page of rows
  returned. The marks around a hit are the same.
- Tests that assert an exact order or snippet are rewritten to assert what both promise: which
  records match, title hits before body hits, and that the snippet holds the word.

### Tests

- **Portable fixtures.** The 219 files that call `env.DB.prepare(…)` move to one test helper with
  `run`, `first` and `all`, taking the same SQL strings and running them through whichever handle
  the run has. This is a mechanical change (a codemod), after which only the strings that are not
  common SQL need a person. New fixtures are written with Kysely. `helpers.ts` stops importing the
  database from `cloudflare:workers` directly.
- **Two runs of one suite,** chosen by an environment variable: SQLite on D1 in workerd, as today,
  and Postgres.
- **A database per test file** on Postgres: a fresh schema made from the baseline, dropped after.
- **SQLite-only tests** are marked as such: the 24 `rows_read` cost tests and the tests of the
  SQLite migrations' history (`packages/db/test`). Postgres-only tests cover the lock, the schema
  path and the handle's conversions.
- **Not settled from the code: where the Postgres run executes.** Three candidates, in order of
  preference: (a) the tests stay in workerd and reach a Postgres container over TCP; (b) PGlite,
  an in-process Postgres, if it loads in workerd or in a Node project; (c) a Node vitest project
  for the Postgres run, with a container in CI. Core imports nothing from `cloudflare:workers`,
  and `local-db.ts` shows the Kysely path already runs on Node, so (c) is known to be possible.
  Step 1 measures and chooses. PGlite is single-connection, so the lock's tests need a real
  server whatever is chosen.

## Out of scope

- The app and the runner on Node, their `createCrmDb(env.DB)` call sites and raw statements, the
  outbox, queues, schedules and workflows in Postgres, better-auth's database adapter, files:
  stage [68](68-host-on-node.md).
- The Lambda sandbox: stage [69](69-lambda-sandbox.md).
- RDS itself, connection pooling in production (a pooler that pins a session on `SET` matters
  here), backups, restore before an update, creating a client's schema and role, the registry on
  AWS, `cos deploy`: stage [70](70-deploy-to-aws.md).
- Vectors (pgvector) and the embedding half of hybrid search, models and mail: stage
  [71](71-models-vectors-mail-on-aws.md).
- The assistant, connections and live screens: stages [72](72-assistant-on-aws.md),
  [73](73-connections-on-aws.md) and [74](74-live-screens.md).
- The control plane (`products/crm/apps/control`, 73 raw statements), which stays on Cloudflare.
- Moving a client's data from SQLite to Postgres or back.
- Changing any column to a native Postgres type.

## Acceptance criteria

1. `packages/core`'s suite passes on Postgres and on D1 in CI, from one set of test files. Every
   test skipped on one database is marked with the reason, and the count of each is printed.
2. The suite on D1 passes with no change in behaviour, and no SQLite migration is edited.
3. CI fails when the two migration sets differ in structure, when a SQLite migration outside the
   baseline has no Postgres twin, or when a rule code is missing from the Postgres set or the
   error mapper. A table on the Postgres-only list is left out of the comparison; a table missing
   from one database and not on the list fails, and so does a shared table that differs.
4. Twenty concurrent takes of one offer on Postgres: one succeeds and nineteen get `offer_taken`.
   A booking and a class cancel committed together: one fails with the error it gives on D1.
5. With the lock removed in a test build, criterion 4's test fails. (The lock is what is tested.)
6. Two schemas in one database: a handle for one cannot read or write the other's rows through
   any `CrmDb` method, and a connection with no path set finds no table.
7. Every operation error raised from a database failure has the same code and message on both
   databases for the same input.
8. An extension reconciled on Postgres (add a field, rename one, remove one, add an index) leaves
   tables and `rec_*` views that a second reconcile reports as unchanged. `cos ext check` and
   `cos ext test` pass for every shipped pack on both databases.
9. Each formula in the SDK's tests gives the same value on both databases.
10. Every dashboard in `packs/*/dashboards.ts` and core's overview validates as portable and
    returns the same rows on both databases over the same fixture. `pnpm lint` fails on a
    SQLite-only function in core outside the dialect module.
11. On Postgres, query SQL that names a `core_*` table, another schema or a function off the list
    is refused by the validator, and, with the validator bypassed in a test, by the database.
12. Search returns the same set of records on both databases for the search tests' queries,
    including a part of an email address and a word with an accent.
13. `docs/architecture.md`, `CONTEXT.md`, ADRs 0002, 0014 and 0020 (dated notes), CONTRIBUTING.md
    (how to write a migration twice) and the dashboards skill say what is now true.

## Dependencies

Stage 66, for the seam that hands each entry its client's database. Nothing else. No AWS account
is needed: every step runs locally and in CI.

## Migrations and numbers

Block CD in [`docs/parallel-work.md`](../parallel-work.md) is claimed for stages 67 to 74. Each
build step takes its ADR and migration numbers from that block when it starts and records them
there. This stage should need no new SQLite migration. The Postgres baseline takes the number of
the schema version it equals.

## Suggested build order

1. **Spike, then stop and report.** Where the Postgres test run executes (in workerd over TCP,
   PGlite, or a Node project). The time a 30-statement batch and a schema set per read take
   against a local server. The time to make a schema from a baseline per test file. Three hard
   ports done by hand to prove the trigger rules: `core_write_guard`, the staffed time claim and
   search.
2. **The handle.** `dialect` on `CrmDb` and `HandlerContext`; the Postgres handle (batch with the
   lock, single writes, `readOnly`, `size`, placeholders, value conversions, the schema path);
   `applyMigrations` and `getMigrationLevel` over `CrmDb`.
3. **The error normal form,** a decoder per database, and `errors.ts` moved onto a table. D1
   behaviour unchanged.
4. **The dialect module, JSON and schema helpers,** and core's JSON and `sqlite_master` uses moved
   onto it or onto common SQL.
5. **The dialect module, dates and the rest** (upserts, `NOCASE`, `GLOB`, `changes()`), and the
   lint check.
6. **Portable fixtures:** the test helper and the codemod over `packages/core/test`, still
   running on D1 only.
7. **The baseline:** the generator, the hand-ported triggers and views, and the structure, pair
   and rule-code checks in CI.
8. **Search on Postgres.**
9. **The reconciler, the view generator and the formula compiler** on Postgres.
10. **The portable subset:** the validator, the date helpers, the reader role, and the packs'
    and core's dashboard SQL rewritten.
11. **Both runs green in CI,** the twin-migration rule switched on, and the skipped tests marked.
12. **Docs, the skill and the ADR notes.**

Steps 3 and 6 need only the spike and can run beside step 2. Steps 8, 9 and 10 can run side by
side once 5 and 7 are in.

## Decided by this spec, open to override

- **The shared unit is `CrmDb`,** not `D1Database`. No D1 interface is put in front of Postgres.
- **`pg` and Kysely's own Postgres dialect.**
- **No interactive transactions on either database.**
- **Every write on Postgres holds the client's lock,** batched or single, at `READ COMMITTED`.
- **An advisory lock keyed on the schema's name.**
- **`search_path` per unit of work, remembered per connection,** and never `public`.
- **A baseline with a manifest,** and a twin by file name after it.
- **Common SQL first, the dialect module second.** No emulation of SQLite's functions inside
  Postgres.
- **Raw statements keep `?` placeholders;** the Postgres handle renumbers them.
- **Text compared by bytes on Postgres,** as on SQLite.
- **The portable subset's functions are an allow-list,** and the date helpers are expanded by the
  validator.
- **On Postgres, query SQL also runs read-only, with a timeout, as a role limited to the client's
  views.**
- **SQL already saved on a Cloudflare deployment keeps running** and is marked not portable.
- **Search matches the same records on both databases; order and snippets may differ.**
- **The `rows_read` cost tests stay SQLite-only.** Query cost on Postgres is not held to a number
  in this stage.
- **`json_each` leaves the portable subset.** No pack dashboard uses it.

## Questions for the owner

1. **Do dates, money, booleans and JSON keep their SQLite shapes on Postgres for good?**
   Recommended: yes. It is what lets one body of code, one set of views and one dashboard SQL
   serve both databases. The cost is in "The Postgres migration set" above, and it is hard to
   undo once a health product's data is stored that way: a later change to native types is a
   migration of every table and a fork of the query code.
2. **From when must every pull request with a migration carry its Postgres twin?** Recommended:
   from step 11, enforced by CI, and not before. Until then the baseline is cut again from
   `main`. After it, every stage's author writes each migration and trigger twice, which slows
   all later work a little whether or not it is for AWS.
3. **Does the Postgres run of core's suite gate every pull request?** Recommended: every pull
   request that touches `packages/core`, `packages/db`, `packages/sdk` or `packs`, and always on
   `main`. It roughly doubles the longest job in CI; running it only nightly would let a
   Postgres-only break sit on `main` for a day.

## Status

Spec proposed (2026-11-26). No build step is built yet. Each build step changes its own bullet
here (CONTRIBUTING.md, Working in parallel).

- **Step 1** — not built — needs: stage 66 — Spike: where the Postgres test run executes, batch and schema-path timings, three hard trigger ports

- **Step 2** — not built — needs: step 1 — The handle: `dialect` on `CrmDb`, the Postgres handle with the client's lock and schema path, the migration runner over `CrmDb`

- **Step 3** — not built — needs: step 1 — The error normal form, a decoder per database, `errors.ts` on a table

- **Step 4** — not built — needs: step 2 — The dialect module: JSON and schema helpers, core moved onto them

- **Step 5** — not built — needs: step 4 — The dialect module: dates, upserts, `NOCASE`, `GLOB`, `changes()`, and the lint check

- **Step 6** — not built — needs: step 1 — Portable fixtures: the test helper and the codemod over core's tests

- **Step 7** — not built — needs: step 2 — The Postgres baseline, ported triggers and views, and the structure, pair and rule-code checks

- **Step 8** — not built — needs: step 5, step 7 — Search on Postgres

- **Step 9** — not built — needs: step 5, step 7 — The reconciler, the `rec_*` view generator and the formula compiler on Postgres

- **Step 10** — not built — needs: step 5, step 7 — The portable SQL subset: validator, date helpers, reader role, dashboard SQL rewritten

- **Step 11** — not built — needs: step 3, step 6, step 8, step 9, step 10 — Both runs green in CI, the twin-migration rule on

- **Step 12** — not built — needs: step 11 — Docs, the dashboards skill and the ADR notes
