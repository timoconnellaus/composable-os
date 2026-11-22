# ADR 0520: A waitlist on a capacity claimant: a freed place is held for it, the host promotes

Status: accepted, 2026-11-22 (stage 31a, build step 5). Extends
[ADR 0501](0501-a-record-s-states-claim-its-place.md) (claimants),
[ADR 0430](0430-capacity-is-refused-by-the-database.md) (the database refuses past the places),
[ADR 0437](0437-a-move-is-made-from-a-current-read.md) (a move from a current read) and
[ADR 0493](0493-the-allowance-behaviour.md) (a spend on entering a state). Stage 31's spec,
"Places and the waitlist", decisions 4 to 7.

## Context
When a class is full, a member waits. When a place frees before the cut-off (2 hours before the
class, a class type's setting over the organisation's), it goes to the first waiter (decision 6),
who is booked in automatically (decision 4) and spends a use then, not when they joined (decision
7); a waiter with nothing to spend is passed over. After the cut-off a freed place goes to
whoever books first. This must hold for every actor and under races: a cancel, a direct booking and
two promotions at once must not over-fill a class, give one place to two people, or lose it.

A pack cannot hook a write (ADR 0404), and a check of "is anyone waiting?" before a write races
with every other write. So the waitlist is the host's, declared on the claimant.

## Decision

**The declaration.** `claims.waitlist: { state, promote, until, promotedAt?, passedOverAt?,
passedOverReason? }` on a claimant (`packages/sdk/src/capacity.ts`). `state` is a state that holds
no place, is not final and that records may be created in; `promote` is one of the claimant's
confirmed states, with a move from `state` to it declared for the host (for a customer only with a
window, and onto a free place: see the amendment). `until` is a moment named as a window's end is (ADR 0505): the
Bookings pack's is `class.startsAt` less the class type's `promotionMinutes`, else the setting.
The three fields are read-only ones the host writes. The claimed object has no pool. The claim on
`capacity` was the spec's guess at the shape; the waitlist goes with the claimant because the
states are the claimant's (as `claims` did, ADR 0501).

**A waiter holds nothing.** A record in `state` has no claim and spends nothing (its object's
`spendIn` does not list it). It is made only while every place of the record it claims on is held
or taken, and before the cut-off: the transition engine reads the counter for a clear refusal
(`invalid_input`, `rule: "waitlist"`, `reason: "closed"`; or a conflict, `reason: "not_full"`) and
queues a guard (`core_write_guard` kind `full`, migration 0610) that fails the batch if a place
came free before it commits. So nobody waits behind a free place. A waiter's order is when the
record was made (then its id).

**A place given back is the waitlist's, in the same batch.** When a claimant leaves a held or
confirmed state before the cut-off, after the statements that give its place back the engine
queues two more, on one condition evaluated in the database (someone other than this record
waits on the class): the counter's `held` up by one, and a held claim `for_type 'waitlist'`,
`for_id` the claimant object. No read comes first, so the condition and the release are one
transaction; D1 runs one batch at a time, so a booking made directly cannot get between them. The
counter counts the hold, so a direct booking finds the class full and joins the waitlist behind
the waiters. After the cut-off nothing is handed on and the place is free to the first who books.

**Promotion is a host step from a current read.** `runWaitlistDue` (the runner's minute cron)
reads each class with waitlist holds and its waiters, first first, and calls `waitlist.promote`
for one waiter at a time, each its own batch: from `state` or not at all (`record.update { from
}`), before the cut-off, as the host. The promotion's batch first gives one waitlist hold back
(conditionally, if one is still there), then claims the waiter's place as any move into a
confirmed state does, then spends what the move spends. With a hold there, it nets nothing; with
none left (another promotion took it) and no free place, the claim fails on the counter and the
whole batch is refused: of two promotions for one hold, one moves the waiter in and the other
finds nothing. The waiter's spend is the allowance's own (ADR 0493): a refused spend (no use left,
a pass ended, a membership paused, nothing at all) refuses the promotion; the step then notes the
reason on the waiter (`waitlist.passOver`: `passedOverAt`, `passedOverReason`), they stay waiting
in their place, and the next is tried. Holds nobody could take, and every hold once the cut-off
has come, are given back to everyone (`waitlist.release`), except holds made after the step's read
(a place freed meanwhile waits for the next tick). A promotion records `promotedAt`.

**The last waiter leaving gives the holds back**, in the leave's batch, on the same kind of
condition (nobody else waits). So does a class cancelled with its waiters (the state cascade):
whichever order its bookings move in, it ends with no hold. A waiter deleted or erased leaves a
hold for at most a minute, until the step finds nobody waiting.

**Who may move it.** `waitlist.promote`, `waitlist.passOver` and `waitlist.release` are the
automation actor's, not on MCP, and refuse any call whose origin is not `system` (the host's own
cron): a pack automation also runs as the automation actor, and must not move a waiter ahead or
give the waitlist's places away. `waitlist.position` (read) tells staff any waiter's place and a
customer only their own (through the seam), with how many wait, never who.

**The reconciler** compares only what holds and takes places (`on`, `held`, `confirmed`) when it
refuses a claims change under live records; adding a waitlist to a claimant with bookings is
allowed. Dropping a waitlist while it holds places is refused (`claims_conflict`), and dropping a
claimant object gives its waitlist's holds back with its claims.

## Consequences
- Promotion is within about a minute of the freed place (the minute cron), not in the cancel's
  request: the place is held meanwhile, so nothing is lost by the wait. A queue consumer on the
  booking's move could run it sooner; not needed for decision 4.
- Places raised by staff on a full class are free to anyone, not handed to the waitlist (they are
  not given back by a claimant); staff promote by hand in a later step.
- A waiter passed over stays first: the next freed place tries them again first (and notes the
  reason again). Messages saying so are stage 31's step 9, from these fields.
- The waitlist is one place per record, like claims.

## Amended 2026-11-22, after the review (before merge)

- **Promotion is a host step, never held for approval.** Under a deploy floor that sends
  automation writes to a person, the step's promotion was refused in its own dry run (the dry run
  discarded the statements that give the hold back) and read as "taken": the place sat silently
  until the cut-off. A queued system step could not be applied anyway (its user is no one's). So
  `waitlist.promote`, `waitlist.passOver` and `waitlist.release` declare `hostStep`: from the
  `system` origin the gate never queues them. This turns a `review` into `auto` whether it came
  from the org's policy or from the deploy floor: for these three steps the floor's "only ever
  stricter" does not hold, which is the point (a review could never be applied). A `deny` still
  applies, and the step counts and logs it each tick. The audit row shows `auto`; it has no field
  for why, so the reason is this ADR and the `hostStep` flag on the operation. The dry run also counts the hold's return now (`creditSimulatedClaim`), so any
  simulation of a promotion is judged as the real batch.
- **The hand-on is keyed to a place really given back.** Its two statements also require that this
  record's claim was released in this batch, and the engine reads first that the record holds one:
  a booking kept after its Person was erased, in its state but holding nothing, hands nothing on
  when it moves later. Erasing a Person hands on every place it gives back, before the cut-off, as
  a cancel does (`handOnAfterRelease`, from `records/erase-stores.ts`).
- **A waiter keeps its record.** Changing a waiting record's `on` is refused
  (`claim_relation_kept`), as for one holding a place: it would skip the join's checks and the
  other queue. Leave and join the other.
- **A waiter may take a free place themselves.** The move from `state` to `promote` may be declared
  for a customer too, with a window (the booking's): it claims a free place like any booking and
  never takes a hold, so it jumps nobody (only the host's promotion takes a hold). Bookings' `book`
  does it for a member already waiting on the class, when a place is free (after the cut-off, after
  the holds went back, or more places).
- **Every refusal in the step ends somewhere, logged.** A refused spend passes the waiter over
  (noted, still waiting); anything unexpected is logged, counted, and passes the waiter over too;
  the cut-off, or every waiter tried, gives the holds back; holds of an object that no longer
  declares a waitlist are given back directly; only a race (the last hold taken by another
  promotion, two spends on one holder) keeps the holds for the next tick. A waiter passed over
  since the oldest hold was made is not tried again for these holds (`passedOverAt`), so past
  `maxWaiters` (50) the next ticks work further down the queue, and the holds go back only once
  every waiter has been tried; an object without `passedOverAt` gives them back after one page.
  Each tick settles every record it reads, so none keeps the first places of the read.
- **The cut-off is read on the real clock.** The runner's step no longer passes the tick's time: a
  tick that runs late does not promote after the cut-off.
- **What a deny does.** A `deny` (policy or floor) on the automation actor's writes refuses the
  three steps too: nothing promotes and nothing gives the holds back, so a class with holds stays
  full to the public until the deny is lifted; the step logs and counts it on every tick and moves
  on to the other records. That is accepted: a deny on automation writes is a deployment's
  emergency brake (it also stops orders expiring and timetables generating), and the host writing
  the places back anyway would be the very write it forbids. Lifting it, the next tick promotes,
  or at or past the cut-off gives the holds back.
- **Paid at the desk is not for the waitlist.** Bookings' `bookFor` refuses `paidAtDesk` with
  `waitlist: true`: nobody pays at the desk for a place they may not get (and a later promotion would
  then spend nothing). A record made `waiting` with `waived` through the generic operations is
  promoted spending nothing, as the mark says.

## Amended 2026-11-23, second review (before merge)

- **An erased waiter leaves the queue.** Erasing a Person deletes their waiting records in the
  erase's batch, whether or not the relation is required, and gives the waitlist's holds back if
  nobody else waits (`erasedWaiter`, from `records/erase-stores.ts`). Before, a waiter whose
  relation was optional stayed `waiting` with no Person, counted in positions and could be promoted
  into a place for no one. A holder they had named goes with their allowance rows.
- **"Tried" is per round, not per oldest hold.** A waiter is skipped only if passed over since the
  newest hold was made: one passed over for an older place is tried again when another frees.
- **The hand-on's own key.** The engine reads the record's live claim ids when it plans the
  write, and the two statements require one of those claims to be released, at this write's time,
  on this class: a claim goes from live to released once, so only the batch that released it
  matches. (The read is what finds "holds nothing"; the SQL makes the hand-on the release's own.)
- **A closed class takes nobody in.** The flags that close a record to a create
  (`states.create.closed`: the Bookings class cancelled or done) refuse a move from the waiting
  state into the promote state too, by anyone, the host's promotion included (`state_closed`);
  the sweep then gives the holds back.
- **One record's fault never stops the step.** Each record is settled in its own try; a fault is
  logged and counted, and the next record is read.
- **What a member reads.** An unexpected refusal passes a waiter over with the reason
  `unavailable`; the detail is only in the log.

## Note, 2026-11-23 (stage 31a step 7)
A staff move (ADR 0551) frees its old place to the waitlist as a cancel does, and never takes a
place held for one (the hold counts). The promotion's move in queues the `unmoved` guard on its
class (ADR 0550), so a class cancelled meanwhile fails it. Promote by hand is still to come.
