# ADR 0551: Windows on staff-only moves, and a move made only by its new record

Status: accepted, 2026-11-23 (stage 31a, build step 7). Extends
[ADR 0503](0503-time-windows-and-staff-only-on-the-transition-engine.md),
[ADR 0507](0507-what-the-bookings-review-needed-of-the-platform.md) (`bindsStaff`),
[ADR 0493](0493-the-allowance-behaviour.md) (`movedFrom`) and
[ADR 0506](0506-a-spender-paid-another-way.md) (`waived`).

## Context
Step 7 adds three staff moves with a time rule: a coach ticks a name from an hour before the class,
not days ahead; a no-show is marked once the class has started; a booking is moved to another class
only before its own class starts (after that, giving its use back is a person's act, `returnUse`).
A window bound only customers, and a move with one had to list `customer`.

ADR 0493 made "moved returns, and the new booking spends, in one batch" a declaration (`movedFrom`
on the new record). But the moved state could also be written on its own: `record.update` to
`moved` by any staff caller gave the use back with nothing spent again, at any time, which is the
late give-back ADR 0507 closed for every other path. And a booking paid at the desk (`waived`)
moved into a new booking was charged a use, or a paid one moved into a waived one gave its use
back for nothing.

## Decision
- **A window may sit on a move only staff make** when the move binds staff (`bindsStaff`); without
  `customer` in `by` and without `bindsStaff` it is refused (it would bind nobody). `staffOnly`
  still needs `customer`. The host is never bound.
- **The moved state is entered only by making the record it moves to.** A spender's write into its
  `movedFrom.state` is refused (`invalid_input`, `rule: "allowance"`, `reason: "move_needs_target"`)
  unless it is the host moving the source inside the new record's create (`movedInto`). The new
  record must be created in a spend state, by staff, for the same person.
- **`waived` moves with the record.** A source paid another way makes the new record paid another way
  (the host sets the mark; nothing is spent). A paid source into a record marked waived is refused
  (`waived_kept`).
- The source's own move is judged as any move: its window (`until: class.startsAt` for Bookings)
  binds the staff move, and of two moves of one booking at once one wins (ADR 0437).

## Consequences
- Moving a member is one operation the host checks whole: the new class's places (its waitlist's
  holds included, so a move never takes a place held for the queue), one booking per person per
  class, a closed class, the use in the new class's period. Any refusal refuses the whole batch.
- A place a move frees on the old class before its cut-off is handed to the waitlist in the move's
  batch, as a cancel's is (ADR 0520).

## Proof
`packages/core/test/attendance-platform.test.ts` (the window on a staff move; its declaration's
check), `apps/runner/test/bookings-attendance.test.ts` (a move with its use, full, a use that
cannot be spent, already booked, a direct write to `moved`, after the class started, desk-paid,
the hand-on, a held place not taken).
