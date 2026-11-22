# ADR 0500: `recurring`: a weekly rule in local time, made ahead by the minute cron

Status: accepted, 2026-11-22 (stage 31, build step 1). Adds the `recurring` row of
[ADR 0404](0404-behaviours-are-the-vocabulary.md). Builds on
[ADR 0460](0460-time-zones-on-records.md).

## Context
A gym sets its timetable once (CrossFit, Tuesdays and Thursdays at 06:00) and the host must make
each week's classes from it, with their coach, room and places, so members can book them. Stage 40
(Rosters) and stage 31b (a coach's working hours) need the same thing. Three things make it hard:
clocks change twice a year, a person changes one class by hand (another coach that day) and that
must survive the timetable, and two runs of the generator must never make one class twice.

The wall-clock-to-instant conversion that survives a clock change existed only privately in
`subscriptions/offers.ts` (`paidUpMoment`), and stage 32b's allowances need it too.

## Decision
- **The wall-clock helper is shared**, `packages/core/src/time/local.ts`: `zoneOffset` and
  `realWallClock` moved from `offers.ts` unchanged (offers.ts imports them; stage 32b's session
  moves the same two functions to the same file), and on top of them `localInstant(date,
  minutes, zone)`, `localParts`, `localDaysBefore`, `addDays`, `isoWeekday`, `parseLocalTime`.
  No Temporal (workerd's is not there yet); dates are `YYYY-MM-DD` strings.
- **The rule is weekly, in local wall-clock time** (spec's guess kept): weekdays (a multiSelect
  whose values are `mon`…`sun`), a local time (`HH:MM`, a text field), a length in minutes, a
  first and an optional last date, and a zone (the organisation's when empty). Not RFC 5545.
  06:00 is 06:00 on both sides of a clock change: the instant moves, the wall clock does not.
- **A time that does not exist on a change day moves forward by the gap** (02:30 when clocks go
  forward is 03:30); **one that happens twice is the first** (02:30 when clocks go back is the
  earlier 02:30). The spec said "the same rule `paidUpMoment` uses"; `paidUpMoment` only ever asks
  for midnight, so this is now stated, and tested in a whole-hour zone, a half-hour zone and one
  whose clocks move by half an hour.
- **The declaration**, on the series' object: `recurring: { generates, link, rule: { weekdays,
  time, length?, from, until?, zone? }, into: { starts, ends?, zone?, changed? }, copy?, cancel,
  ended?, closures?, horizonDays? }`. The spec's sketch had no `into`; the generated object's
  instant, zone and "changed" flag must be named somewhere, and `cancel` names the state a record
  is cancelled into. `link` and `changed` are read-only fields the host sets.
- **Generation is the minute cron's**, as the host, through `recurring.generate` (actor
  `automation`, not on MCP), one series per batch: a series is due when it is written (its create
  or update sets `core_recurrence_series.next_run_at` to now in the write's own batch) and once a
  day at 00:05 local in its zone. So "at once when a series is created or changed" is within the
  next minute, and generation has one code path. At most 60 records a run; the rest next tick.
- **Idempotent by a key in the database**: each record made writes a
  `core_recurrence_occurrence` row keyed on the series and its local date, in the batch that
  creates the record (migration 0560). A re-run reads the keys and makes nothing; two runs at once
  both try, and the second batch fails whole on the key.
- **The horizon** is the declaration's `horizonDays` (default 56). Its floor, "never less than
  the longest booking window any class type sets", is the Bookings pack's to meet when class types
  have windows (step 3); the platform does not know which field is a window.
- **Exceptions.** A write to a made record by anyone but the host that changes its times, zone,
  copied fields or state marks the occurrence edited (and sets `changed`); the series never writes
  to it again. A field the series does not set (a note) changes nothing. A cancelled or deleted
  record keeps its date's key, so it is never made again.
- **Changing a series applies at once, in the write's batch**, to its future records nobody
  edited: copied fields (places never below what is held and taken: kept at that number), new
  times, and dates no longer in the rule (moved to Trash with their key, so the date can return,
  or cancelled into `cancel` when places are claimed on them). **Ending** a series (its `ended`
  states) does that to every future record, edited or not, and nothing more is made.
- **A change that moves or cancels records with places taken is refused** by `record.update`
  (`conflict`, `rule: "recurring_confirm"`, the count and the records), and made by
  `recurring.change { object, id, values, confirm }` with that count (risk `destructive`: an AI
  asks, a person approves). A count that no longer matches is refused again. Emailing the bookers
  is the pack's (step 9).
- **Closures**: `closures: { object, from, until }` names an object of date ranges. Nothing is
  made on their dates, and a closure written cancels (a host move into `cancel`) every future
  record of the generated object it covers, one-off records included, each by its own local date
  in its own zone. Shortening or deleting a closure brings nothing back that was cancelled; dates
  never made are made by the next run.

## Consequences
- The timetable a member sees is at most a minute behind the series staff saved.
- A record's local date is its key: changing a series' zone moves its records' instants but not
  their dates.
- The concurrency between a series change and a booking made a moment before it (counted after
  the change's read) is not closed: such a booking's class is moved without the count including
  it. The booking itself is never lost.
- Trashing a series stops nothing by itself: its made records stay, and its daily run makes
  nothing while it is in Trash. Staff end a series to remove its classes.
