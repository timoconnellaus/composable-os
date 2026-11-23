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
- **Races are guarded at commit per occurrence** (amended in review, below): each occurrence has a
  `version` (migration 0810), and `core_recurrence_guard` (migration 0810's own guard table and
  trigger, so `core_write_guard`, which other builds rebuild, is untouched) checks it in the batch.
  - A write by anyone but the host to a generated record that changes something the series owns
    (an exception set or cleared, the record detached, `recurring.follow`) guards that its
    occurrence's version is as read and bumps it.
  - A change of a series guards that the sum of its occurrences' versions from the date it applies
    from is as read, and bumps them all.
  - So of a series change and an edit to one of its records racing, exactly one commits; the other
    fails whole (`conflict`, `recurring_stale`) and is made again from what is there now. **Edits
    of different records of one series do not contend**, and neither an edit nor a cancel contends
    with a generation run (runs only add occurrences; runs and changes still guard the series'
    version against each other, as before).
- **One batch sees what it queued.** Queued writes are invisible to the batch's own reads, so the
  batch keeps what it queued (keyed on its `write`, shared by every context of the batch): bumps,
  exceptions set and cleared, records detached, values written by hand, and series values written.
  Each later guard and plan in the batch adds them. A hand edit and a series edit of the same field
  in one batch therefore keep the hand's value as an exception in either order; the series' value
  used for "set back by hand" is the one the batch wrote.
- **Upgrade: nothing already generated changes meaning.** The migration adds the exception and guard tables and a version column (0 on every row), and nothing
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
- A staff edit fails as `recurring_stale` only when a change of its own series commits between
  its read and its commit; the person (or the tool) tries again.
- **The import** (stage 31a step 10, not built) must write classes that differ from their series
  through the record operations as staff, or write the exception rows itself, so a coach different
  from the series' is imported as a coach exception (stage 45's "The move"), never by a host write
  that would leave it following the series, nor as a whole detach.
- Records detached under the old rule show `changed` until someone follows them again; the class
  list's filter on `changed` still finds them.

## Amended 2026-11-23 (review of PR #271, before merge)
- **The guard is per occurrence, not the series' version.** As first built, every hand edit
  guarded and bumped its series' version, so two edits of different classes of one series, or a
  cancel and a generation run, failed each other as `recurring_stale`: rare for a person, common
  for a tool or an assistant firing several writes. The review asked for a retry in the pipeline
  or a narrower guard. **Retrying was rejected**: a handler may call other operations (each
  committed on its own), call a gatekeeper or queue events before its batch commits, so running it
  again is not sound for every caller. The guard was narrowed instead (above).
- **A batch sees what it queued** (above): a hand edit and a series edit of the same field in one
  batch lost the hand's value and pinned the record to the series' value, because the series
  change read the stored record. Both orders are tested.
- **A series that comes to a record's own value clears its exception**, for the same reason as a
  hand set-back: an exception equal to the series' value is indistinguishable from following it.
- **`recurring.follow { fields: [] }` is refused** (`invalid_input`): only leaving `fields` out
  means every field.
- **Reattaching leaves no exception on a field equal to the series'**: a field not named either
  becomes an exception (it differs) or has its exception cleared (it does not).
- **Reattaching refuses a record whose state was changed by hand** (`recurring_state`, a paused
  class): a made record starts in its object's initial state, and a series must not move a record
  its states hold back. Move it back first, as a moved record's time is put back first.
- **A limit, stated**: reattaching compares the record's time with the series as it is now. There
  is no history of a series, so a record dated before a `recurring.change { from }` that kept the
  old time reads as moved (`recurring_moved`, whose message says so) even though nobody moved it.
  Following a field of a record dated before such a change writes the series' current value.
- **Exceptions on a field taken out of `copy` are deleted at the extension's reconcile**, so none
  is left that `recurring.follow` would refuse to clear.
- **The API contract**: `recurring.*` invalidates the record reads, and `record.*` writes
  invalidate `recurring.exceptions` (one stale group).
