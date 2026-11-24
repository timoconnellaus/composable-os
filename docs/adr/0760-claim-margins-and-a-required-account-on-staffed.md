# ADR 0760: Claim margins and a required account on `staffed`

Status: accepted, 2026-11-24 (stage 49, build step 1). Amends
[ADR 0621](0621-the-staffed-behaviour-and-the-time-claim.md) (the time claim is the shift's own
time). Builds on [ADR 0627](0627-pay-periods-the-basis-the-totals-the-lock-and-the-export.md)
(minutes for pay, read from the kind) and [ADR 0628](0628-the-staff-calendar-feed-and-the-shared-calendar-writer.md)
(the feed reads the claims).

## Context
Stage 49 makes one-to-one sessions (appointments) shifts, so they share the one time claim with
classes and duties and nobody is ever booked twice at once. Two things the claim did not have:

- **A buffer.** A service keeps a gap before or after itself (15 minutes to write notes, reset a
  room). The coach is not free in it, so it must be refused in the database like the session
  itself, for every writer. ADR 0621 kept the claim to the shift's own time so that two classes
  back to back stay allowed, and that must still hold.
- **No escape from the claim.** A class may have a visiting coach with no staff account: it covers
  the class for members and claims nobody's time (ADR 0621). An appointment with such a profile
  would be bookable over anything, so for appointments the account must be there.

## Decision
- **`staffed.claimBefore` and `claimAfter`**: `kind.field` number paths, minutes, like `payBefore`
  and `payAfter`, but they **enter the claim**: its `starts` is the shift's start less them, its
  `ends` its end plus them. The overlap triggers of migration 0811 are unchanged, so a shift inside
  another's buffer is refused (`conflict`, `rule: "double_booked"`) for every writer and under
  races. Read as a whole number from 0 to 1,440 (anything else is none), as pay reads its minutes.
  Classes declare none: back to back stays allowed.
- **The kind must be another of the declaring extension's objects**, and the minutes number fields
  of it (a contract check), because the reconciler builds triggers on its table: a kind inserted
  (a REPLACE too), deleted, or given other minutes or another id derives again the claims of its
  shifts that **have not ended**, by the database's clock. So a service's new buffer holds from now
  on, and is refused whole when it would reach another shift. Shifts that have ended keep the claim
  they had: changing a buffer never fails on history (the rule stage 49 step 2 takes for `occupies`). The
  shift's own kind column joins the columns its update trigger watches, and is indexed (live rows),
  so the kind's trigger finds its shifts by it.
- **The claim keeps its margins** (`margin_before`, `margin_after`, seconds, migration 1091). A
  reader that wants the shift's own time takes them off instead of reading the kind again: the
  feed shows a session's own start and end, a leaver's future shifts are those whose own start is
  after now, and the away notice and a clash answer give the other shift's own times. A margin
  never changes the shift's stored times or pay (the rejected "longer end time": the client would
  see a wrong end, pay would count the gap, and a new buffer would rewrite every appointment).
- **The read before the write uses the same margins**: a shift's margins are read from its kind
  row by the expression the triggers use, so the answer names the other shift in the common case,
  and `staffing.candidates` checks people against the widened span.
- **`staffed.account: "required"`** (only with `who.account`: a user field always is an account).
  A live shift that has not ended, whose person is a profile holding no account, is refused: as a
  validation error at write (`rule: "staffed_account"`), and by the trigger on the shift's table
  (`core_staff_time_no_account`) for every other writer. On the profile's table, triggers keep its
  account while such a shift names it: clearing it, a REPLACE or upsert without one, an id change
  and a delete for good are refused; the record operations refuse the clearing first, saying how
  many (`conflict`, `rule: "staffed_account"`). A shift with **nobody** on it stays allowed: the
  host's generation and a leaver make dates uncovered (ADRs 0621 and 0624), and an uncovered
  appointment claims no one's time, so it cannot double-book anyone.
- **History is never refused** here either: a shift that has ended may name a profile with no
  account (it claims nothing), and editing it is not refused.

## Consequences
- Appointments (step 5) declare `claimBefore: { field: "service.bufferBefore" }`, `claimAfter`,
  and `account: "required"`; a visiting coach with no account still teaches classes, and cannot be
  booked for appointments.
- A kind with thousands of past shifts changes its minutes in one statement: the trigger reads its
  shifts by the index and derives again only those not ended (tested with 2,000).
- Uses the database's clock, unlike ADR 0621's shift triggers: tests use dates years ahead of or
  behind any real clock. A shift ending while a request runs is judged by the database's now.
- A reconcile derives every claim again with the margins as they are now, and a declaration added
  over shifts whose buffers clash and have not ended is refused (`staffed_conflict`), as ADR 0621.
- Not here: the open-hours check and free times read these margins (step 4); a practitioner as the
  account (step 7).
