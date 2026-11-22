# ADR 0570: Date-relative triggers in minutes

Status: accepted, 2026-11-23 (stage 31a, build step 9). Extends
[ADR 0130](0130-automation-runtime.md) (triggers), [ADR 0460](0460-time-zones-on-records.md) (days
in a record's own zone) and [ADR 0505](0505-window-numbers-through-two-relations-and-settings.md)
(a number read from a field one relation away, else a setting).

## Context
Stage 31's reminder goes out a number of hours before each class: 3 by default, a class type's own
setting over the organisation's (decision 16, criterion 13), and staff are to be told of a class
whose list was not taken an hour after it ends. A `dateRelative` trigger counted whole days only,
once a day (or once an hour, in each record's zone), so neither could be said. A pack cannot run
its own clock: a `schedule` automation scanning classes every minute would put "when is a class
due" and "was it already sent" in pack code, which every pack would write again.

## Decision
- **`dateRelative` takes `minutesBefore` or `minutesAfter`** a datetime field, instead of
  `offsetDays` (exactly one of the three; `zoneField` goes with days only). The minutes are a
  number (0 to 10,080, a week), or read per record as a window's numbers are (ADR 0505):
  `{ field?, setting? }`, a number field of the trigger object or one relation away that the
  extension declares (`classType.reminderMinutes`, its own field on Programs' class type), and when
  it is empty the extension's number setting. The field and the setting must declare a `max` of at
  most a week (the SDK checks it): the bound is what keeps the scan small.
- **The minute cron scans them every tick** (`runMomentDateRelative`, `recordsAtMoment` in core).
  A record is due once its moment has passed and for 15 minutes after it: missed ticks are caught
  up, and a record made within those 15 minutes is still run; one made later (a class added two
  hours before its start with a three-hour reminder) is not. The query reads only due rows: the
  field's range for the largest minutes any record can have (the index), then the moment itself
  (the record's number, the related record's through a join, else the setting) compared in SQL
  with `julianday` so stored offsets compare correctly, the trigger's conditions, and leaving out
  records this automation already ran for at this value of the field (amended after the review of
  PR #256: the first version read every row of the range, cancelled classes included, and could
  return the same first page every tick).
- **One run per record and value of the field**: the idempotency key is the record id and the
  field's value as an instant. Every tick that sees a moment starts the same run, so it runs once;
  a class whose time changes is due again at its new time (a second reminder, correctly, for the
  new time), and one whose reminder minutes change after it ran is not run again.
- **A length of time, not a wall clock.** Minutes from an instant are real minutes: three hours
  before 06:00 on the day the clocks change is three hours before, whatever the wall clock did.
  (Days stay local days, ADR 0460.)
- **Conditions are checked when the run starts**, as for every trigger: a class cancelled before
  its reminder's moment starts no run. What a run does is still its own (Bookings' reminder reads
  the bookings still booked when it runs).

## Consequences
- The scan reads, each minute, the trigger object's records within the window (for Bookings, the
  classes starting in the next two days: the reminder's field and setting are bounded to 2,880
  minutes for this reason). An automation with a static number reads exactly its 15-minute slice.
- A run missed by more than the look-back (the runner down for longer) is not made up: a reminder
  late by an hour is worse than none.
- The summary says "some minutes before a Class's Starts (minutes from the classType.reminderMinutes,
  else the setting reminderMinutes)", checked every minute.

## Proof
`packages/core/test/moments.test.ts`: due from the moment for the look-back and not before or
after, before and after a field; across a clock change in Sydney and Adelaide (a half-hour
offset); a record in the Trash ignored; a related record's number, else the setting, else nothing;
the SDK naming each wrong declaration. `apps/runner/test/bookings-messages.test.ts`: the reminder
once over three ticks, a class type's own minutes honoured, none for a cancelled class.
