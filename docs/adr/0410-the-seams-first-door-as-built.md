# ADR 0410: The visibility seam's first door, as built

Status: accepted, 2026-11-20 (stage 22 build, step 1). Builds [ADR 0244](0244-visibility-enforced-at-one-seam.md)'s
first door for [ADR 0402](0402-staff-and-customers.md).

## Context
ADR 0244 designed one seam with three doors and left it unbuilt. Stage 22 needs the first door,
`visibleSource`, before a customer can exist. The code had 229 reads of a `rec_*` view or a core record
table in 47 files of `packages/core/src` (counted by the test's own scan). Some are reads for a caller (lists, gets, counts, exports). Many
are not: a write checking uniqueness, a scheduled job, SQL text for a dashboard.

## Decision
- **`packages/core/src/visibility/` is the seam.** It exports:
  - `visibleSource(ctx, object, alias?)`: the object's `rec_*` view, filtered for the caller. It
    is a Kysely source, used in `selectFrom(…)` or after `FROM` in a `sql` template.
  - `visibleTable(ctx, object, alias?)`: the table behind the object, with soft-deleted rows, for
    a get that may include the Trash and for the snapshot before a write. Same filter.
  - `scopeOf(principal, object)`: the caller's scope. Pure, so it can be tested without a database.
  - `orgReader(db)`: the reader for work with no caller, which acts for the whole org.
- **The seam reads the caller from `ctx.principal`.** A handler context carries a `principal`
  beside `user`. Helpers that load records (`loadPerson`, `loadOrganisation`, `loadActivity`,
  `loadTask`, `loadRecord`, `loadDisplays`) take a `Reader` (`{ db, principal }`) where they took
  a database, so none of them can read without saying for whom.
- **`runListQuery(ctx, object, input)` builds its own query from the seam.** Callers no longer
  hand it a query over a view they named. `pageQuery` is the old function, kept for lists of
  things that are not records (users).
- **For staff the scope is `all`:** the plain view under its own name, no predicate. A test
  compares every read's rows and `rows_read` with a baseline recorded on the commit before the
  seam (`test/visibility-staff-unchanged.test.ts`).
- **The one-seam test is a ratchet, not yet a wall.** `test/visibility-one-seam.test.ts` reads the
  source and fails on a read of a record view or table outside the seam, unless the file is on its
  list with a count and a reason. A new read in a listed file, or any read in a file that is not
  listed, fails. Stage 14a empties the list.

## What moved, and what did not
Moved onto the seam (49 reads, 11 files cleared): every `<object>.list`, `record.list`, `record.get`, `record.count`,
`record.groups`, `export.csv`, the four core gets and their loads before a write, `task.listMine`,
`activity.listForRecord`, `activity.body`, `trash.list`, search and similar-record hydration
(`loadDisplays`), relation checks and titles in `record.*`, stage and group lookups, assignment
rule lookups, import reference lookups, voice name hints and duplicate member cards.

Not moved (180 reads in 36 files), and listed in the test with one of five reasons:
- SQL text run by `query.sql`, dashboards and routines. It is the seam's second door.
- Reads for a caller that take their scope in stage 14a: summaries, duplicates, memory.
- Parts of a record (emails, links, tags, affiliations) reached from a record already read. ADR
  0244 gives them their parents' scope.
- Jobs and checks with no caller: embedding, the duplicate scan, digests, sync ingest.
- Staff write paths: uniqueness, snapshots, merge, import, erase.

## Why
- ADR 0244 and the stage 22 spec ask for a test that fails on any read outside the seam. Moving
  all 229 reads now would have touched areas other builds have reserved (erase, the assistant, AI)
  and rewritten SQL that belongs to the second and third doors, in a step that must change no
  behaviour. A ratchet gives the property that matters now: the list cannot grow unseen.
- What keeps a customer out of the unmoved reads is not this list. It is that an operation is
  closed to customers unless it says otherwise (ADR 0411), and that the isolation test calls every
  open operation with another customer's ids (stage 22, criterion 4).
- A `Reader` in place of a bare database makes "who is reading" a compile error to leave out.

## Consequences
- **A deviation from the spec:** criterion 3 says a read outside the seam fails a test. As built,
  a read outside the seam that is not on the list fails a test. The list has 180 reads in 36 files, all in code only staff can reach.
- Stage 14a must extend this module (scopes, the SQL rewrite, hydration) and empty the list.
- `rec_user` is not a record view for this test. It is the staff directory, and no object
  declares it.
- Code that has only a database and no caller must choose `orgReader(db)` on purpose.
