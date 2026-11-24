# ADR 0871: Day windows in the business's zone

Status: accepted, 2026-11-24 (stage 60, build step 1; decision 12 of the stage's spec). Amends ADR
[0057](0057-dashboards-params-cache-and-click-through.md) (date presets, `:today`, the cache key).
Builds on ADR [0167](0167-first-run-setup-wizard.md) (the organisation's time zone) and ADR
[0493](0493-the-allowance-behaviour.md)'s wall-clock helpers (`packages/core/src/time/local.ts`). Closes
issue #306. No migration.

## Context
`resolveDateWindow` started every day, week, month, quarter and year at UTC midnight, and `:today`
was the UTC date. For a business ten hours ahead of UTC, "today" at 07:30 was still yesterday's
numbers until 10:00; for one behind UTC, the evening's sales counted as tomorrow. Rostering, pay
periods, agreements, booking windows and a pack role's `today` limit already work in the
organisation's zone (`org_timezone`, `loadGeneralSettings`); dashboards were the exception. Stage 60's
Today and stage 52's reports need the same day too, so it is one function.

## Decision
- **One function for a local day.** `localDay(now, zone, offsetDays)` in `time/local.ts` returns a
  local date and its `[from, to)` instants: from the date's first instant to the next date's
  first, through `wallClockToInstant`. A day across a change of clocks is 23 or 25 hours; where
  clocks jump at midnight the day starts at the first instant that exists. `localDateStart(date,
  zone)` is the same for any date (month and day may overflow, so "the first of last month" is
  `{ month: m - 1, day: 1 }`). Today (step 3 of stage 60) and stage 52 use these; nothing else
  computes a local day.
- **Every dashboard preset is in the organisation's zone.** `resolveDateWindow(value, now, zone)`:
  today; the last 7, 30, 90 or 365 days (today and the local days before it); this and last month;
  this quarter; this year; and a `{ from, to }` range of local dates, both ends included.
  `previousWindow(value, window, zone)` steps a calendar preset back one unit and a rolling or
  custom range back by its own number of local days, so a KPI's "today" compares with the whole
  local yesterday whatever its length in hours. Weeks are not a preset today; when one is added it
  starts on Monday (`isoWeekday`).
- **`:today` is the local date.** `:now` stays an instant (UTC ISO, to the minute). The SDK's
  system-parameter description says so.
- **The zone is the organisation's setting, read by the host per widget run.** `runWidget` reads it
  with `loadGeneralSettings` (one small statement) unless its caller passes `zone`; a missing or
  invalid setting is UTC, which is the old behaviour.
- **The cache key includes the zone.** A widget whose SQL binds no date (only `:me`) has the same
  params in every zone; with the zone in the key, a change of zone is never answered from the
  cache filled before it.
- **No new system parameters for dashboards.** Stage 60's `:today_from` and `:today_to` are bound
  for Today's items (step 3) from `localDay`, not added to every widget: a dashboard has its own
  date filter, and a filter with the id `today` would already bind those names.

## Consequences
- **Every dashboard's figures shift on the day this ships** for a business not on UTC: "today",
  "this month" and the rest now start at its midnight. The release note says so
  (`docs/deploying.md`, Upgrading past the business-day fix).
- A pack dashboard that compares a timestamp with `:today` (as text) still compares with a date;
  one that wants the local day's instants uses a date-range filter.
- Two instants that are the same local day in one zone may be two days in another: a business that
  changes its zone sees its history regrouped, as rostering and pay periods already do.
