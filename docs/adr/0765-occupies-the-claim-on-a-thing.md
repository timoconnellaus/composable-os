# ADR 0765: `occupies`, the claim on a thing

Status: accepted, 2026-11-24 (stage 49, build step 2). Is the spec's ADR "0761" (stage 49's
"Migrations and numbers"): the coordinator gave this step migrations from 1095 and ADRs from 0765,
so the spec's later numbers move with whoever builds them. Builds on ADRs
[0404](0404-behaviours-are-the-vocabulary.md) (behaviours are the vocabulary) and
[0621](0621-the-staffed-behaviour-and-the-time-claim.md) (the time claim, whose design this
follows), and [0430](0430-capacity-is-refused-by-the-database.md) (why it is not a capacity).
Stage 57 (Events and venue hire) reuses it and amends this ADR for what it adds.

## Context
Stage 49 decision 5: some one-to-one sessions need a private room, and a class in that room blocks
it, and the reverse. The rule must hold for every writer (a member booking online, staff at the
desk, the assistant once approved, an import, the host's own generation of a series) and under
races (two members picking the last 07:00 in the treatment room at once). A read before the write
is not a guarantee, and a rule in one pack's tool binds no other writer (ADRs 0404, 0405). Classes
and appointments are different objects, so neither object's rules can hold it. ADR 0621 solved
the same problem for people: a core table of claims kept by triggers, refused by the database.
A room is a thing, not an account, so it needs its own claim; stage 57's halls need the same.

## Decision
- **A platform behaviour, `occupies`**, declared on an object
  (`packages/sdk/src/occupies.ts`): `occupies: { thing, starts, ends, live, before?, after?, only? }`.
  `thing` is a relation field (one record, or many: one claim per thing) to another of the
  extension's own objects; `starts` and `ends` are datetime fields; `live` the states in which the
  record takes its thing; `before` and `after` are minutes kept free around it (a number field of
  the record, or `relation.field`: a service's buffer); `only` is a boolean field of the thing, and
  only things with it set are claimed. Any extension may declare it on its own objects (it claims
  only its own things, and says nothing about people or pay, unlike `staffed`).
- **The claim is a core table kept by the database** (`core_thing_time`, migration 1095): one row
  per live occupant and claimed thing, with the occupant's time and its margins as whole unix
  seconds, half-open (09:00 to 10:00 and 10:00 to 11:00 do not clash). `BEFORE INSERT` and
  `BEFORE UPDATE` triggers refuse a row that overlaps another on the same thing, whatever object
  holds it (`core_thing_double_booked`, answered `conflict`, `rule: "room_taken"`). The answer
  **names no other record**: who else is in the room is not the writer's to know (a member booking
  online). Indexed by thing and end, so the check reads only the claims ending after the new one
  starts: a room's years of past classes are never read.
- **The claims are derived by triggers the schema reconciler builds**, never by the record
  operations: on the occupant's table (`AFTER INSERT`, `AFTER UPDATE OF` every column the claim
  reads plus the id, `AFTER DELETE`); on the thing's table (a thing inserted, deleted, given another
  id or its `only` flag changed re-derives its claims); and on the table a margin is read from (a
  service's buffer changed re-derives the records naming it). Every statement shape is covered as
  ADR 0621 covers them (a REPLACE and an upsert are inserts first; an id change is an update; a row
  a REPLACE deletes leaves its claim behind, which can only refuse more and the next reconcile
  heals). A live record naming a thing whose end is not after its start is refused
  (`core_thing_time_backwards`, `rule: "occupies_time"`).
- **History is never a reason to refuse.** A claim that has ended (by the database's clock) is
  written only when it overlaps nothing, in every derivation: two classes that overlapped in a room
  before it was claimed stay as they were, and editing one later (marking it done) is not refused.
  A claim that has not ended always meets the triggers. ADR 0621's per-shift triggers do not do
  this; a room's flag is turned on long after its history, which a coach's account is not.
- **Only things marked as taking one booking at a time are claimed** (`only`). Bookings' room
  gains `exclusive` ("One booking at a time", off by default), and a class declares
  `occupies: { thing: "room", live: ["scheduled", "done"], only: "exclusive" }`: a gym floor many
  classes share is never claimed, so installing this on a timetable that is fine never fails.
- **Marking a thing exclusive over a clash to come is refused** by the same trigger (the update of
  the room derives its claims and the second overlapping one is refused, `room_taken`); a clash
  that has ended does not stop it (above).
- **Installing or changing the declaration over records that already clash** is refused by the
  reconcile before the triggers are built (`occupies_conflict`) when any of the clashing records has
  not ended, naming each pair by title and start (staff read the plan, so naming is fine there).
  Past clashes are reported (`skip_claims`) and the later record of each claims nothing. The check
  is one pass per thing in order of start, with the claims other objects already hold on the same
  things. Each reconcile drops the triggers, builds them again and derives every claim again.
- **The host's generation never fails on a taken room.** A series' date whose room another record
  takes then is made with no room, kept as the date's own (a field exception, ADR 0620) so the
  series does not write the clash back, and the rosterers are told ("Made with no room: …"), as ADR
  0621 makes a date uncovered. A series change whose new room or time would clash on a date is
  refused whole by the trigger (`room_taken`, without naming the dates, unlike ADR 0621's
  `assertPlansStaffFree`; a later step may add the read).
- **What it is not**: no capacity (one occupant at a time: a room's time is a range shared across
  many records and objects, the reason ADR 0621's claim is not a capacity either); no nesting (a
  hall containing two rooms); no setup time beyond `before` and `after`; no thing of another
  extension (the reconciler builds triggers on the thing's table, so it is the declaring
  extension's own). Stage 57 adds what it needs by amending this ADR, not by a second claim.

## Consequences
- An appointment (stage 49 step 5) declares `occupies` on the same room and is refused over a class
  in it, and the reverse, with nothing more in the platform; its service's buffer enters the claim
  through `before` and `after`, so changing a service's gap re-derives its appointments' claims (and
  is refused if the longer gap would reach a booking to come).
- A batch is checked statement by statement, as ADR 0621's: two classes swapped between rooms in
  one batch are refused even though the end state is fine.
- The triggers read the database's clock for "ended"; tests that inject a host clock write their
  records years ahead or behind any real clock.
- A thing deleted for good, or given another id, leaves its occupants claiming nothing; a thing in
  the Trash is still claimed (its occupants still name it).
- Stage 33's import must check first: refuse, or import with no room, what would clash and has not
  ended.
