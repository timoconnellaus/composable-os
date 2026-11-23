# ADR 0620: Field-level exceptions in `recurring`

Status: accepted, 2026-11-23 (stage 45, build step 1). Amends
[ADR 0500](0500-recurring-a-weekly-rule-in-local-time.md) ("Exceptions"). Builds on its guards
(migration 0560's `core_write_guard`, ADRs 0500 to 0503).

## Context
Under ADR 0500, a write by anyone but the host that changed a record's times, zone, copied fields
or state marked the whole occurrence edited, and the series never wrote to it again. So one coach
swapped on one Monday froze that class against every later change to its series: a new room, new
places, a new time. Rostering ([stage 45](../stages/45-rostering.md)) swaps coaches often, and
duty series (cleaning) will have the same need. The swap must keep, and everything else must
still follow.

## Decision
- **What a series owns on a record it made**: its time fields (`into.starts`, `into.ends`,
  `into.zone`), every `copy` target, and its state (through `cancel` and `ended`). Nothing new is
  declared: every `recurring` declaration gets this, so Bookings' classes and later duty series
  have it without pack code hooking writes (ADR 0405).
- **A copied field changed by hand is that record's own** (a field exception): a row in
  `core_recurrence_exception` (migration 0810: object, record, field, `set_by` the staff account,
  `set_at`), written in the batch of the write. Changed again by hand, who and when are the latest.
  The series never writes that field of that record again, and still writes its others. `into.changed`
  is not set by a field exception.
- **A change of time, end, zone or state by hand still detaches the whole record**, as before
  (`edited_at`, `into.changed` true). A class moved by hand is a one-off at a time a person chose;
  its series' rule no longer describes it, so neither the series' time nor its copied fields reach
  it. (Cancelled and finished records were never touched by a series, and are not now.)
- **Setting a field by hand back to the series' value clears its exception**: the field follows the
  series again. An exception equal to the series' value is indistinguishable from following it,
  and keeping it would surprise later (the series changes coach and that date silently does not).
  The write's history and audit row record the change as any write's.
- **`recurring.follow { object, id, fields? }`** is the explicit "follow the series" (the roster's
  "back to the pattern"): each named field (default every copied field) takes the series' value
  now, as the host, and follows from then on. On a record detached whole, it re-attaches the
  record if its time, end and zone are still the series' for its date (refused `recurring_moved`
  otherwise: following would move it); copied fields not named that differ from the series are
  kept as exceptions, by the person following, so nothing changes but what was asked. Refused for a
  past, cancelled or finished record (`recurring_past`), one its series no longer makes on that
  date (`recurring_not_in_series`), and a one-off (`recurring_not_generated`). Risk `write`; a
  human-only field (`personApproves`) among the fields makes it wait for a person.
- **`recurring.exceptions { object, id }`** (read) answers whether a record was made by a series,
  whether it is detached whole, and its field exceptions with who and when.
- **A series change applies field by field** to its future records that are not detached whole: it
  writes the series' values to every field the record does not keep as its own. A date that leaves
  the rule is removed (or cancelled with places taken) whether or not it has field exceptions: the
  exception is about a field on a date, not about the date; its exception rows go with it. Ending
  or trashing the series deals with every future record as before.
- **Races are guarded at commit with the existing series guard**, with no new guard kind (so
  `core_write_guard`, which other builds also rebuild, is untouched). Every write by anyone but
  the host to a generated record that changes something the series owns (an exception set or
  cleared, the record detached, `recurring.follow`) guards on its series' version as read and
  bumps it, in its own batch. Runs and changes already guard on the version they read. So of a
  series change and an edit to one of its records racing, exactly one commits; the other fails
  whole (`conflict`, `recurring_stale`) and is made again from what is there now. A batch that
  guards and bumps one series several times (a bulk edit of five of its classes, an edit beside a
  change of the series) counts the bumps it has queued, so it never trips its own guard
  (`guardSeries` and `noteSeriesBump`, keyed on the batch's `write`). A run racing an edit fails and
  is made on the next tick, as a run racing a change already did.
- **Upgrade: nothing already generated changes meaning.** The migration adds a table and nothing
  else. Every occurrence detached under the old rule (`edited_at` set) stays detached whole,
  exactly as before, its `changed` true, whatever field caused it: the old rule recorded no field,
  and guessing one from history could make a class follow a series it was meant to ignore. A
  person re-attaches one with `recurring.follow`, naming the fields that should follow; the rest
  become its exceptions.

## Consequences
- A coach swapped on one date keeps the swap when the owner later changes the series' room, places
  or time; the series' new coach reaches every other date.
- **Bookings** needs no change of code: its class's `coach`, `room`, `places`, `title` and
  `classType` are copied fields. Its `changed` field now means "moved or its state changed by hand";
  its description says so. Capacity and the waiting list are unchanged: places never go below what
  is held and taken (the change keeps them at that number, the counter's CHECK refuses below), a
  places exception keeps the class's own number, and a change that moves a class with places taken
  still needs `recurring.change` with the count, whatever its exceptions.
- **Members' mail is unchanged**: the series' host update of a class carries only the fields it
  changes, so a class whose coach was swapped and whose time the series then moves sends one
  "class changed" message (its time), and the swap itself sends nothing (stage 31 decision 16).
  The automation reads the change's diff, on main and on the routine-mail branch alike.
- A staff edit racing a run of its series (at most a minute after the series is written, and once a
  day) fails and is tried again by the person; rare, and the price of a guard that holds.
- **The import** (stage 31a step 10, not built) must write classes that differ from their series
  through the record operations as staff, or write the exception rows itself, so a coach different
  from the series' is imported as a coach exception (stage 45's "The move"), never by a host write
  that would leave it following the series, nor as a whole detach.
- Records detached under the old rule show `changed` until someone follows them again; the class
  list's filter on `changed` still finds them.
