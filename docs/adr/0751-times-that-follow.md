# ADR 0751: Times that follow (`staffed.timesFrom`)

Status: accepted, 2026-11-24 (stage 39, build step 2). Amends
[ADR 0621](0621-the-staffed-behaviour-and-the-time-claim.md) (the `staffed` behaviour and the time
claim) and [ADR 0507](0507-what-the-bookings-review-needed-of-the-platform.md) (`states.follows`).

## Context
In the Jobs pack (stage 39) a visit is one booked time at a customer's site, and several people
work it. `staffed` holds one person per shift (ADR 0621), so each crew member's place on a visit is
its own record, a **crew place**, which is the shift: it claims its person's time, is on the
roster, the feed and the warnings. Its time is the visit's. `states.follows` already cancels the
crew places with their visit; nothing kept their times. A Jobs tool that copied them would be wrong
the first time the visit moved by `record.update`, an import, the assistant or a raw statement, and
a pack must not hook another record's writes. When a visit with a crew of three moves, all three
must move with it in the same batch, and if any would then be on two shifts at once the move must
fail whole, naming who.

## Decision
- **`staffed.timesFrom: "<relation>"`**: a required relation (one record) of the shift to another
  of the same extension's objects. That object has the shift's `starts`, `ends`, `zone` (when the
  shift declares one) and `kind` fields under the same names and types (the kind a relation to the
  same object); the host copies them onto the shift. The shift's own copies must be `readOnly`, and
  nobody but the host writes them, the declaring pack's own code included (`rule: "times_follow"`).
  A series cannot make such a shift (its generation sets times), so `pattern` and `recurring` are
  refused with it. Same names was chosen over a mapping: the shift's fields are the visit's, and a
  mapping is easy to add if a pack ever needs one.
- **The database copies them.** The reconciler builds, beside the time claim's triggers
  (`packages/core/src/staffing/sql.ts`): on the record's table, `AFTER INSERT` (a REPLACE too) and
  `AFTER UPDATE OF` the id and the copied columns write them onto every shift naming the record, in
  or out of the Trash, in the same statement; on the shift's table, `AFTER INSERT` and `AFTER
  UPDATE OF` its link and its copies write them from the record again, so a path that wrote them
  some other way is put right. Only rows that differ are written (no loop; D1 runs with recursive
  triggers off). The shifts' own triggers then derive each claim, and `core_staff_time` refuses the
  whole statement when one person would be on two overlapping shifts: a move fails whole, for every
  writer. An index on the shift's link column finds them.
- **The record code reads first, and names.** A create of a shift takes the record's values in
  place of any given (a default zone included), as does pointing it at another record; a write of
  the record that changes any copied field reads each live shift that follows it and runs the
  shift's own checks on its new values, in the record's batch: a clash is refused as
  `double_booked`, naming the person and the other shift ("Busy Crew is already on another shift at
  that time: …"); a shift that has started is moved only by someone who rosters (ADR 0626's rule
  for a shift's own times); each shift's warnings join the record's answer and audit row; its
  person is told the shift changed time and its open offer's cut-off follows, as for a shift moved
  by hand. The trigger refuses the race the read cannot see.
- **A bound.** At most 25 shifts follow one record's times in a write that moves it
  (`times_follow_too_many` beyond): the read costs about 14 queries a shift, so a move with its tool
  stays well inside D1's 1,000 per invocation (`staffed-times-follow-cost.test.ts`).
- **Declared over existing records**, the reconcile copies each record's values onto its shifts once
  the triggers exist, before it derives the claims again; a copy that would double-book someone
  fails the reconcile in the database. A new pack (Jobs) has no such records.
- **No migration**: the claim's own table and triggers are unchanged; everything is on extension
  tables, built by the reconciler.

## Consequences
- A crew place is on the roster, in the calendar feed, in pay and in Bookings' coaches' clash check
  exactly as a class or a duty is, at its visit's time, with nothing in the Jobs pack keeping it.
- With `states.follows`, a crew place both moves and is cancelled with its visit. Sending a visit
  to the Trash does not trash its crew places (as before for any follower); the Jobs pack's
  `cancelVisit` cancels, and step 5 decides whether trashing a visit with a crew is allowed.
- A record moved inside a locked pay period with following shifts is refused by the pay lock's
  triggers (ADR 0627), as a shift's own move is.
- The crew place's history and timeline do not record a move it inherited: the visit's change is
  the audited act.
- Tests: `packages/core/test/staffed-times-follow.test.ts` (the contract, the triggers, create and
  repointing, a crew of three moved and a clash refused whole naming the person, raw statement
  shapes on both tables, a restore from the Trash, the cascade, two assigns at once, the bound,
  declaring it over existing records) and `staffed-times-follow-cost.test.ts`.

## Amended 2026-11-24 (review of PR #419, before merge)
- **Every roster rule, not one.** Each shift that follows a moved record runs the whole of
  `assertRosterWrite` on its new values, so a member who does not roster cannot change the
  checklist a crew ticks by changing the visit's type (ADR 0650), nor move a visit under way, and
  the next rule added there applies too. The first version checked only a started shift's times.
- **A move and a cancel in one write.** Shifts this write's own cascade takes out of their live
  states are not checked at the new time, and the record's copied columns are written after the
  cascade in the same batch, so the copy never claims a time for a shift being cancelled. The first
  version refused such a write when the new time clashed.
- **The bound holds when a shift is made**: the 26th shift made or pointed at one record is refused
  (`times_follow_too_many`), so no record reaches a state whose time cannot change. A move still
  refuses more than 25 that some other path made.
- **One step only**: the record a shift's times follow may not have times that follow another
  (the contract refuses a chain), since the read before a move reads only its direct followers.
- **A shift naming no record** (a raw insert, a link to a record deleted for good) is refused by
  its table's trigger (`core_staff_times_no_record`, answered `rule: "times_follow"`), rather than
  kept with whatever times it was given.
