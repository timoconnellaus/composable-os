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
refused by D1 (1,000 queries an invocation), which the local runtime does not enforce.

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
- **One limit across every following object, 100 records** (`FOLLOWERS_MAX`, was 500 per object).
  The dearest measured follower, a booking paid from a pass, costs 8 statements; 100 of them and
  the parent's own are about 810 statements. A move over the limit is refused (`follows_too_many`)
  before anything is written.

## Consequences
- Ticketing's crew shifts (stage 57 step 4) and Venue hire's room uses (step 5) can follow the
  event. A ticket or a ticket type still cannot.
- A class with more than 100 live bookings cannot be cancelled in one move; it is refused, named,
  where before it would have failed on D1 past about 120.
- A parent's move with followers costs one more statement for each following object.
- `follows` still has one `from` list for every state in `when`: each target needs a host move from
  each of them. A room use following a hire into `held`, `confirmed` and `released` from different
  states (step 5) needs that widened too; it is not done here.
- A follower restored from the Trash onto a parent that moved is not moved; an object that must
  not be is closed by `create.closed` on the parent's state, as Bookings' booking is.

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
limit counted across two following objects. `packages/core/test/bookings-platform.test.ts`: what
a booking costs its class's cancel, under 1,000 at the limit.
