# ADR 0550: Timed moves (`states.after`), and a cancel that races a booking

Status: accepted, 2026-11-23 (stage 31a, build step 7). Extends
[ADR 0425](0425-one-transition-engine-for-stages-and-states.md),
[ADR 0507](0507-what-the-bookings-review-needed-of-the-platform.md) (the state cascade) and
[ADR 0520](0520-a-waitlist-on-a-claimant.md) (host steps). Migration 0670.

## Context
Decision 11 of stage 31: after a class ends, the bookings still `booked` become `no_show`, but only
when attendance was taken for that class, so a coach who forgot the list does not make the whole
class no-shows. That is a move nobody asks for: it happens because time passed. A pack cannot hook
a write, and a pack automation writing states would be a rule outside the host (ADR 0404), so it is
a declaration the host acts on.

Building the staff cancel of a class showed a race the cascade (ADR 0507) did not cover: the
cascade moves the bookings it reads in the class's batch, and a booking's "class not closed" check
reads the class when the booking is planned. A booking and a cancel a moment apart could each pass
on a read the other was about to change, leaving a booking `booked`, its place taken and its use
spent, on a cancelled class.

## Decision
- **`states.after`** (at most four rules): `{ from, to, at, minutesAfter?, ifAnyIn? }`. `at` is a
  datetime field of the record or one relation away (`class.endsAt`); the move is due
  `minutesAfter` (0 to 10,080) after it. With `ifAnyIn`, only while another live record of the
  object pointing at the same record through that relation is in one of those states (a class whose
  list was taken has someone `attended` or `no_show`). Each rule needs a declared `host` move from
  each `from` to `to` (the SDK checks it).
- **The minute cron** (`runTimedMovesDue`, apps/runner) reads each rule's records due in one SQL
  statement (the moment compared with `julianday`, so stored offsets compare correctly), oldest
  first, at most 100 a rule a tick, and only moments in the last 14 days (a class from months ago is
  not re-read every minute). Each record is moved by `state.after` in its own batch, as the host,
  from the state it was read in or not at all (ADR 0437), after checking again that it is due.
  `state.after` is the automation actor's, not on MCP, refused from any origin but `system`, and a
  host step the gate never queues from it (`hostStep`, ADR 0520); a deny still applies and is logged.
  A record that moved meanwhile or is no longer due is skipped; anything else is logged and counted.
- **A booking planned against a class that then moves fails.** A write judged against
  `states.create.closed` through a relation (`class.closed`) queues a guard on that record: its
  state history must still have the number of rows read when the write was planned (guard kind
  `unmoved`, migration 0670). A cancel committing first adds a row, and the booking's batch fails
  whole (`conflict`, `rule: "state_closed"`, `reason: "moved_meanwhile"`). The waitlist's move in,
  judged against the same flags (ADR 0520), queues the same guard.
- **A cancel planned before a booking commits fails.** When a record's move cascades to its
  followers and the record has `capacity`, the cascade reads the record's live claims *before* its
  followers, and queues a `claimed` guard (migration 0560's) that the counter at commit is that
  read less what the cascade gives back (the followers' own claims, and the waitlist's holds when
  its waiters move too). A booking committed between the claims read and the commit adds a claim,
  and the cancel fails (`recurring_stale`: "the schedule or a booking changed"); asked again, it
  reads the booking and takes it with the class.

## Consequences
- A class's no-shows are written within about a minute of the moment; "staff are told of classes
  with no attendance" (spec 31) is left to step 9's messages and views.
- A one-off class with no end time gets no no-shows (`at` is empty).
- A late correction after the sweep (unticking someone) makes the booking `booked` again, and the
  next sweep makes it a no-show if the class's list was taken; past 14 days nothing is swept.
- A waiter that joins between a cancel's read and its commit is not caught by either guard (it
  holds no claim); it stays `waiting` on a cancelled class, holding nothing and spending nothing,
  and the waitlist never promotes into a closed class. Accepted.

## Proof
`packages/core/test/attendance-platform.test.ts`: the declaration's checks; no-shows only after the
moment and only where someone was marked, once, within the look-back; `state.after` refused from a
pack's origin and for a record no longer due; a cancel then a booking planned before it in one
batch (refused by the `unmoved` guard; without it the booking stands on the cancelled class) and a
booking then a cancel (refused by the counter guard). `apps/runner/test/bookings-attendance.test.ts`:
the same on the shipped packs, and ten bookings racing a cancel, never one left booked (with the
counter guard taken out it fails every run).

## Amended 2026-11-23, after the review of PR #253
- **Failures never starve the sweep**: a record that keeps failing stays first in the order, so a
  rule pages past them within a tick (up to ten pages of 100), logging each; one hundred
  permanently failing records no longer hold back the rest. Records refused as no longer due (or
  moved meanwhile) are paged past the same way. One budget (500 records) is shared by every rule in
  a tick, and the rule that goes first turns each minute, so a rule whose records keep failing
  cannot starve the rules after it.
- **A cascade cannot follow a pool**: a parent other records draw places from as a pool counts
  claims that are not its own, which the counter check cannot read, so `follows` on such a parent
  is refused at the contract check.

## Amended 2026-11-24 (stage 57 step 2, ADR 0841)
- **A child that draws no places may follow a pool**: the refusal above now holds only for a child
  that draws places from the pooled parent (a member of the pool, or a claimant of the parent or a
  member). The counter guard is queued only when a follower claims places on the parent, and a
  follower made under the move, of any kind, fails the move at commit
  ([ADR 0841](0841-cascades-widened.md)).
- **A tick's cascades share one budget** of records they may move (`FOLLOWERS_MAX`, ADR 0841):
  a move whose followers do not fit what the tick has left stays due, is not counted as failed,
  and moves on a later tick; a move that fails gives its followers back.
