# ADR 0870: Today's items and the `todayItems` declaration

Status: accepted, 2026-11-24 (stage 60, build step 2; the spec's "The `todayItems` declaration").
Amends ADRs [0010](0010-dashboards-sql-views.md) and
[0057](0057-dashboards-params-cache-and-click-through.md) for shipped packs. Builds on ADR
[0660](0660-pack-screens-in-the-admin.md) (a shipped pack's screens and their gate) and ADR
[0871](0871-day-windows-in-the-business-zone.md) (the business's day). No migration. `today.get`
and `today.rows`, which run the items, are step 3: it amends this ADR with what it builds.

## Context
The owner's Today (stage 60) shows the day's numbers on one screen, and the app names no pack: an
installed pack adds its own numbers. A dashboard of widgets was weighed and rejected (no per-viewer
gate, no "needs attention", widget SQL an MCP client can run, and the host's items read data no
`rec_*` view shows). So a pack needs a way to say "here are my numbers for today" that the host
can check before it installs the pack and run for each viewer. `today` was taken: it already names
a pack role's limit to today (ADR 0553), and Programs has a `today` tool.

## Decision
- **A new manifest key, `todayItems`, for shipped packs only.** By key (camelCase, at most 8 per
  pack): `label`, `order` (default 100), `format`, `sql`, `compare` (`yesterday`, the default;
  `lastWeek`; `none`), `attention` (`{ above: n }` or `{ below: n }`, else never), `rows` (`sql`,
  the display column `label`, an optional secondary column `detail`, and `record: { object, id }`,
  the record a row opens and the column holding its id), `opens` and `web: { screen }`.
  `TodayItemSpec` in `packages/sdk/src/contract.ts`, `todayItemManifestSchema` in `manifest.ts`.
- **No money format.** `format` is `count` or `percent`. A money format is refused with the
  reason: money on Today is the host's, from Finance reports (stage 52, decision 11 of the spec),
  never a second calculation in a pack's SQL.
- **The gate is the screen's.** `opens` names this pack's own tools, every one of which the viewer
  must be able to call to see the item; at least one is for staff only, and a tool staff cannot
  call is refused (as ADR 0660's `opens`). `web.screen` names one of this pack's `screens`. A row
  opens one of this pack's objects, a Person or an Organisation.
- **The SQL is checked by the host, with the widget rules.** The SDK checks the declaration's shape
  and gates (`todayItemIssues`, in `validateManifest`); `checkManifest` in core checks the SQL
  (`todayItemSqlIssues`, `packages/core/src/today/declaration.ts`) with the same guards a widget's
  SQL passes: `bindNamedParams` with only `:today_from`, `:today_to` and `:now`
  (`TODAY_ITEM_PARAMS`), then `validateReadOnlySql` (one `SELECT` or `WITH`, no writes, only `rec_*`
  views in `FROM`, no reserved name anywhere). The views of the pack's own objects count as present,
  since its install creates them in the same batch; any other view must exist. Nothing is run.
- **An item returns exactly what it says.** The outermost `SELECT`'s columns, named as SQLite names
  them (`resultColumns`), are exactly `value` for an item, and exactly the rows' `label`, `detail`
  and `record.id` columns for its rows: a column with no name of its own, or `*`, is refused. So the
  rows carry the names and record ids they declare and nothing more (the spec's "nothing private");
  that a display column is a name and not a note is the review of the pack's code. The contract has
  no mark for a private view: the private data the spec names (checklist runs, health answers, pay,
  leave) is in no `rec_*` view, so a pack's SQL cannot reach it.
- **A runtime extension declaring `todayItems` is refused** by its check and at install
  (`outside_audience` at `todayItems`, `checkManifest` with `source: "runtime"`, which is what
  `extension.check` and `extension.install` run), as `screens` is. The step that reads items
  (step 3) reads them only from a shipped pack's row, so the key is ignored at run time.

## Consequences
- Dashboards stay specs (ADR 0010) and a shipped dashboard's widget SQL is unchanged; a shipped
  pack now also has a second, narrower kind of read-only SQL, checked at install rather than when
  first shown.
- A pack's item whose SQL joins another pack's view installs only where that pack is installed
  first (its view must exist). The packs that declare items (step 4) read their own views and the
  base ones.
- The check adds one statement (the schema's names) to `checkManifest`, only for a manifest with
  items. No bound variables.

**Amended 2026-11-26 (stage 60 step 3):** `today.get` and `today.rows` run the items. A shipped,
active pack's item is shown to whoever could call every tool of its gate (with two more rules for
a pack role's account); its SQL is checked again with the widget guards and run through
`runReadOnlySql`, every visible item a column of one statement, bound to the business's day and,
for its comparison, the same window a day or a week earlier at the same local time; a row's
record is linked only where the caller may open it. See
[ADR 0874](0874-today-get-the-host-items-and-a-pack-roles-today.md).
