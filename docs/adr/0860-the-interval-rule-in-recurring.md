# ADR 0860: The interval rule in `recurring`: every N weeks, months or years, fixed on the calendar

Status: accepted, 2026-11-24 (stage 59, build step 1: platform piece P1). Amends
[ADR 0500](0500-recurring-a-weekly-rule-in-local-time.md) (the weekly rule). Builds on
[ADR 0620](0620-field-level-exceptions-in-recurring.md) (exceptions), which it leaves unchanged.
No migration.

## Context
Equipment (stage 59) needs service plans whose dates come round every 3 months, every year or
every other week: a quarterly service by a supplier, a yearly safety test, a fortnightly check.
`recurring` could only say "these weekdays, every week". The owner chose fixed dates (the spec's
decision 6): every 3 months from 1 March, whether or not the last one was late, never counted from
when the last one was done. Making the next record when the last is done (an automation) was
rejected in the spec: "made once, never twice, an edited one left alone, moved by a closure" is
what `recurring` already holds for every writer. A maintenance also stays open for days (a window
of a week), which a length in minutes, capped at a day, cannot say.

## Decision
- **The rule gains optional fields**, all naming the series object's fields:
  `rule: { weekdays?, time, length?, from, until?, zone?, unit?, every?, day?, month?, lengthDays? }`.
  - `unit`: a `select` whose option values are some of `week`, `month`, `year`
    (`RECURRING_UNITS`), no editable options. Empty on a record is `week`.
  - `every`: a number field, whole 1 to 100 (`RECURRING_EVERY_MAX`); empty is 1.
  - `day`: a number field, 1 to 31, the day of the month for `month` and `year`; empty is the
    `from` date's day. **A day the month lacks is the month's last day** (the 31st in April is
    the 30th; 29 February is 28 February outside a leap year).
  - `month`: a number field, 1 to 12, for `year`; empty is the `from` date's month.
  - `lengthDays`: a number field, whole days 1 to 366, instead of `length` (never both). The
    record ends at the same wall-clock time that many local days on: a week-long window opened at
    09:00 closes at 09:00 across a change of clocks (seven days and an hour when clocks go back).
- **Fixed on the calendar, anchored on `from`.** Every N weeks counts weeks (Monday first) from
  the week holding `from`, on the given weekdays; every N months counts months from `from`'s
  month; every N years counts years from `from`'s year. A date before `from` is never made (a
  monthly rule on the 1st from 20 January starts on 1 February). This is RFC 5545's `INTERVAL`
  counted from `DTSTART`, kept to the three cases a business asks for; still not RRULE.
- **Without `unit` the rule is weekly, as before**, and every existing declaration is unchanged.
  `weekdays` is needed only while the rule can be weekly (no `unit`, or a `unit` with a `week`
  option). The contract refuses `every`, `day` or `month` without a `unit`, a `unit` with other
  options, those fields of the wrong type, and `length` with `lengthDays`. The host refuses a
  value out of range on write (`invalid_input`, `rule: "recurring_rule"`, the field), as it does a
  bad time.
- **Nothing else changes.** Keys (series and local date), exceptions and detaching, changes to a
  series reaching its future records (a date no longer in the rule removed or cancelled), endings,
  closures, the horizon (at most 366 days) and the per-run and per-tick budgets are ADR 0500's and
  0620's. The rule's new fields are rule fields: changing one is a change of the series.
- **One code path.** `ruleIncludes` decides every unit and `occurrencesBetween` walks the window's
  days through it, as the weekly rule did; Rostering's pattern preview calls the same helpers.

## Consequences
- A yearly plan needs a horizon long enough to reach its next date (Equipment's plan declares one
  of 366 days); with the default 56 days its record is made 56 days ahead.
- A run of the interval rule reads what a weekly run of as many dates reads: the rule is worked
  out in memory, and a run still makes at most 25 records (`recurring-interval.test.ts`).
- Servicing by usage (kilometres, hours) and "the second Tuesday of the month" are not said;
  either is a new unit or field later, not a change to these.
