# ADR 0244: Record visibility is enforced at one seam in the operation layer, over the `crm_*` views

Status: proposed, 2026-11-05 (stage 14 spec). Amends [ADR 0015](0015-core-data-model.md),
[ADR 0020](0020-query-sql-validator-and-csv-import.md),
[ADR 0057](0057-dashboards-params-cache-and-click-through.md),
[ADR 0153](0153-ai-summaries.md) and [ADR 0155](0155-hybrid-search-similar-records-and-retrieval.md).

## Context

The user decided that visibility is based on the record owner: everyone sees everything by
default, and admins can restrict an object to "own" or "own team"; Managers see their team's
records. It must hold for lists, search (FTS and Vectorize), MCP and the assistant, dashboards and
`query.sql`, exports, summaries and automations, and be enforced in one place, within the D1
`rows_read` cost rules.

What the code offers:
- Every read already goes through an operation, and every handler has the acting user on its
  context. But the read paths each name their source: `runListQuery` callers, `record.count`,
  `record.groups`, `export.csv`, `loadRecord`, `loadPerson`, `loadDisplays`.
- `query.sql` and dashboards run arbitrary validated SQL over `crm_*` views. Views are static, and
  D1 has no session variables, so a view cannot know who is asking.
- Vectorize metadata holds only `{object, id}`.

Options considered:
1. **Per-user views.** Impossible to parameterise in SQLite; generating views per user is DDL per
   user and per team change.
2. **A materialised access table** (user × record). Every owner, team or policy change rewrites up
   to N × users rows: unbounded `rows_written` and storage against the 10 GB cap.
3. **Filtering in the index** (owner metadata in Vectorize and FTS). Owner changes must then
   re-upsert vectors and FTS rows; a stale index leaks. It also covers only search.
4. **One seam in the operation layer** that computes the caller's scope once and gives every read a
   filtered source, plus a rewrite of validated SQL.

## Decision

Option 4.

- `packages/core/src/visibility/` computes the caller's **scope** per object once per invocation:
  `all`, or a set of owner ids, from the policy (`core_visibility_policy`), the role and team
  membership (one indexed read, cached on the invocation context).
- **Door 1, `visibleSource(ctx, object)`:** the object's `crm_*` view, filtered by
  `(owner IS NULL OR owner IN (SELECT value FROM json_each(?)))` when restricted. Every read path
  takes its source from it. Inherited objects (activities, affiliations, participants) get their
  own predicate built from their parents' scopes.
- **Door 2, SQL rewrite:** `runReadOnlySql` replaces restricted `crm_*` views in FROM and JOIN
  positions with generated CTEs carrying the same predicate, using the validator's token stream.
  User CTEs may not use `crm_` or `__vis_` names.
- **Door 3, hydration:** search indexes stay unfiltered; every hit is hydrated through door 1, and
  vector queries over-fetch.
- Caches and stored AI output that depend on visibility are keyed by a hash of the reader's scopes
  (dashboard cache, `core_ai_summary.scope_key`).
- Two tests keep it the only seam: a registry-wide test over every `records:read` operation (an
  operation not in its table fails), and a test that fails on a `crm_*` or core record table read
  outside the seam.
- When every policy is `everyone`, no predicate is added and no cost changes.

## Why

- The operation layer is the one place every surface already passes through (UI, MCP, the
  assistant, Code Mode, extension tools), and it knows the caller. The `crm_*` views are already
  the only thing reads and user SQL may name, so filtering them there covers user SQL as well.
- The predicate uses the existing owner indexes, costs one membership read per invocation, and adds
  no writes when owners or teams change.
- Hydration-time filtering cannot leak through a stale index.

## Consequences

- Restricted users pay a predicate on reads; budgets in the `rows_read` tests are added for it.
- A query over activities under a restricted policy costs an EXISTS per activity row; dashboards
  aggregating activities are slower for restricted users.
- Vector search may return fewer than `topK` results for very restricted users.
- Extension objects need a declared owner field to be restrictable; the contract gains `owner`.
- Automations act org-wide; their notifications are filtered by recipient.

## Note, 2026-11-20: the first door is built (stage 22)
Stage 22 built `packages/core/src/visibility/` with door 1 (`visibleSource`), ahead of stage 14a,
because customers need it ([ADR 0402](0402-staff-and-customers.md)). The views are now `rec_*`,
not `crm_*`. Staff have the scope `all`, so nothing changed for them. What was built, what moved
onto the seam and what is still listed as outside it is in
[ADR 0410](0410-the-seams-first-door-as-built.md). Doors 2 and 3, staff scopes and the
registry-wide test for staff are still stage 14a's, on the same seam.

## Note, 2026-11-25: re-specced for the platform (stage 14, proposal)
Stage 14 was re-specced for the platform as it is ([the spec](../stages/14-teams-permissions.md)).
The decision stands: one seam, three doors, caches and stored output keyed by scope, nothing added
when every policy is Everyone. What the re-spec changes, once it is agreed and built:
- **The predicate** is a subquery on `core_team_member` binding only the caller's id, not a list of
  owner ids bound through `json_each(?)`: a large team stays inside D1's 100 bound values, and the
  scope is never stale. The pipeline's one staff statement reads the policies with the account's
  rights, so a host that restricts nothing makes no extra statement.
- **The views are `rec_*`** (ADR 0410's note above); the validator refuses user CTEs named `rec_…`
  or `__vis_…`.
- **One rule for how limits combine.** The staff scope is one of four limits (the object's policy,
  the account's locations, a pack role's own reach, the object's row rules such as note levels);
  they intersect, and a permission never widens one, except ADR 0600's grant over a pack role's
  own reach. Admins are outside policies and locations.
- **The ratchet** (ADR 0410): stage 14 moves every read listed as `sql`, `later` or `part` onto the
  seam and deletes those reasons. The reads with no caller, a write's own checks and host code stay
  listed with their reasons; "empties the list" now means that.
The build records this in ADR 0950 (block CD).
