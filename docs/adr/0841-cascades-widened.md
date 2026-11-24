# ADR 0841: Cascades widened: a non-drawing child of a pool, a parent in a required pack

Status: accepted, 2026-11-24 (stage 57, build step 2). Amends
[ADR 0507](0507-what-the-bookings-review-needed-of-the-platform.md) (the state cascade) and
[ADR 0550](0550-timed-moves-and-a-cancel-that-races-a-booking.md) (a cascade cannot follow a
pool).

## Context
Stage 57 needs two followers the cascade refused. Crew shifts must follow their event to
`cancelled`, but a Ticketing event is a pool its ticket types draw places from, and ADR 0550
refused `follows` on any pool: the cascade guarded the parent's counter at commit against what it
had read of the parent's own claims, and a pool's counter also counts its members' claims, so the
guard could never hold. Room uses (Venue hire) must follow Ticketing's event, and `follows` named
only a parent in the follower's own extension.

Proving the widening showed two more things. The counter guard was the only thing stopping a
follower made between the cascade's read and its commit, and only for a follower that claims places
on the parent: a crew shift made then would stay open on a cancelled event, holding its person's
time. And the limit of 500 followers a move was never reachable: measured, a follower costs the
parent's batch 3 to 8 statements, so a cancel with more than about 120 bookings would have been
refused by D1 (1,000 queries an invocation), which the local runtime does not enforce. The first
version of this ADR sized the new limit from batch statements; the review of PR #355 showed that
D1 counts reads (a batch is one query), that one call or one cron tick moves many parents, that a
follower's own cascade had a budget of its own, and that a restore brought a follower back live
onto a cancelled parent. The decisions below are after that review.

## Decision
- **A child that draws no places may follow a pool.** The contract refuses `follows` on a pooled
  parent only for a child that draws places from it: a member of the pool (its `capacity.pool` is
  the parent), or a claimant of the parent or of a member. A child that draws none moves no places.
- **The counter guard is queued only when a follower claims places on the parent** (its `claims.on`
  is the relation it follows). Unchanged for Bookings; never on a pool, whose counter it cannot
  read.
- **None left behind.** After moving each following object's records, the cascade queues one
  statement that fails the batch at commit if a live record of that object still points at the
  parent in one of its `from` states (other than the state it moves to): one made after the
  cascade's read. It is a conditional insert of migration 0560's `claimed` guard with an expected
  count no counter has (-1), so the batch fails as the counter guard fails the same race
  (`conflict`, `rule: "recurring_stale"`): asked again, the move reads the new record and takes it.
  No migration and no new guard kind (core_write_guard is rebuilt by every migration that adds a
  kind, which parallel stages would collide on). Records in the Trash are not read and not counted.
- **A parent in a required extension.** `follows.relation` may be a relation to an object of an
  extension the follower's `requires` lists, named in full (`ticketing.event`). The SDK checks the
  follower's side (each `from` state, and a host move from each into what `when` gives). The host
  checks the parent's side in `checkManifest`, so at install and on every upgrade of either
  extension: the parent is installed and declares states, every state `when` names is one of them,
  and an upgrade of the parent's extension keeps every state an installed follower follows. A pool
  is always within one extension, so a follower in another never draws places from its parent. The
  follower's moves are made as the host in the parent's batch, whoever moved the parent: the
  follower's extension opted into them by declaring `follows`, and only into its own host moves.
- **One budget for a whole call, 80 records** (`FOLLOWERS_MAX`, was 500 a parent). Every
  object that follows a parent, every parent one call moves (an import of 25, a series change, a
  closure) and every cascade a follower's own move starts draw on it (`followerBudget`, one per
  call, keyed by its write queue). What D1 counts against its 1,000 queries a Worker invocation is
  each read and each batch, a batch being one query whatever it holds (Cloudflare's D1 limits), so
  the budget is sized from the reads: measured through `meterQueries` (`records/query-meter.ts`),
  a crew shift with its time claim costs 7 queries, a booking 2, a room use 1, the parent's own
  move 8. At `FOLLOWER_QUERIES_MAX` (10) each, 80 is at most about 810 queries. A move over the
  budget is refused before anything is written (`follows_too_many`; `reason: "budget"` when other
  moves of the call took the rest).
- **One budget for a tick of timed moves.** The minute cron's `runTimedMovesDue` makes many moves
  in one invocation, so it hands every `state.after` one shared budget
  (`InvocationContext.followerBudget`, platform code only). A move that does not fit what the tick
  has left is left due, not counted as a failure, and moves on a later tick, where it is first in
  its rule's order. A move that fails gives its followers back.
- **A follower never comes back from the Trash live onto a parent that moved it.** `record.restore`
  refuses it (`rule: "follows"`, `reason: "parent_moved"`) when its parent is in a state `when`
  names and the follower is in one of `from`, and queues an `unmoved` guard on the parent
  (migration 0670), so a parent moving before the restore commits fails it; a restore committed
  first is read by the parent's move, or fails it on the guard against a follower left behind.
- **A runtime extension cannot follow another extension's record.** Its moves would sit in that
  extension's batch, where a refusal fails its move (`outside_audience`, as calling its tools is):
  a reviewed change, in a shipped pack or the org's own repository.

## Consequences
- Ticketing's crew shifts (stage 57 step 4) and Venue hire's room uses (step 5) can follow the
  event. A ticket or a ticket type still cannot.
- A class with more than 80 live bookings cannot be cancelled in one move, and a series change or a
  closure that cancels classes with more than 80 bookings in all is refused naming the budget: made
  in smaller parts, it goes through. A timed move into a state a large cascade follows waits for a
  tick with room.
- A parent's move with followers costs one more statement for each following object.
- `follows` still has one `from` list for every state in `when`: each target needs a host move from
  each of them. A room use following a hire into `held`, `confirmed` and `released` from different
  states (step 5) needs that widened too; it is not done here.
- Two installs at once (a parent's upgrade dropping a state while a follower of it installs) are
  not serialised: each checks against the registry it read. Installing is an admin's act, one at
  a time in practice; accepted.

## Proof
`packages/core/test/cascades-widened.test.ts` (11): the contract (a non-drawing child of a pool and
a child in a requiring extension pass; a pool member, a claimant of a member and a claimant of the
pool are refused; a parent in an extension not required is refused); the install check (a state the
parent lacks; an upgrade of the parent dropping a state a follower in another extension follows);
a pooled event with a ticket sold cancelled by a person, by the host, by an import and ended by a
timed move, its crew shifts and room uses moved and the crew's time freed, the pool's counter
untouched (with the counter guard queued as before, every one of these fails); a follower in the
Trash left alone; a follower made under the move, of each extension, failing the move whole (with
the new statement taken out, it is left open on the cancelled event); a parent move refused whole
when a follower's time claim is refused (`double_booked`); the statements one follower costs; the
limit counted across two following objects, across a chain (a follower's own followers), across
an import of two parents and across a tick of timed moves; a follower refused back from the Trash
onto a cancelled parent, and failing a restore planned with the parent's cancel in either order; a
runtime extension refused a follower of another extension's record. Each of these fails with its
fix taken out. `packages/core/test/bookings-platform.test.ts`: what
a booking costs its class's cancel, in queries, under 850 at the limit.
