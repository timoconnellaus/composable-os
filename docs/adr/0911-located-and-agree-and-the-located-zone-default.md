# ADR 0911: `located` and `agree`, and the located zone default

Status: accepted, 2026-11-26 (stage 64, step 2). Amends ADR [0460](0460-time-zones-on-records.md)
with a dated note. Builds on ADRs [0910](0910-locations-a-base-record-inside-the-one-organisation.md)
(the location record and the main location), [0502](0502-declared-uniqueness.md) (a declared rule
refused on every write, with a read first for the message), [0765](0765-occupies-the-claim-on-a-thing.md)
(triggers the reconciler builds on a pack's tables) and [0500](0500-recurring-a-weekly-rule-in-local-time.md) (series).
Spec: [stage 64](../stages/64-multi-location.md).

## Context

Bookings, Rostering and later Jobs need to say which location a record is at, and the host has to
act on it (fill it, zone by it, limit staff by it, filter reports by it) without each pack writing
its own location code. A class and its room are each at a location, and the two must be the same
whoever writes: a person, the assistant once approved, MCP, an import or a series' generation.

## Decision

**`location` is a relation target** for extension fields, beside `person`, `organisation` and
`task`.

**`located`, one declaration per object** (SDK `LocatedSpec`): `{ field }`, a required relation of
the object to one location (a room, a series, a class), or `{ path: "relation.field" }`, a required
relation to one record of another of the extension's objects and that object's relation to one location (a
booking's `class.location`). A path is at most one relation away, through the extension's own
objects: the host reads it in one statement and builds its triggers on that object's table, which
the same reconcile owns. `cos ext check` refuses a field that is not a required relation to one
location, a path that does not end at one or whose relation is not required, both `field` and
`path` (or neither), an `agree` side that does not reach a location, and an `agree` whose two
sides are one path. Trigger names built from two table names are fitted to an identifier (cut and
ended with a hash of the whole name, `fitName`), so the longest names the contract allows install;
a name that already fitted is unchanged, so `occupies`' and `staffed`' existing triggers keep
theirs.

**The fill.** A new record of an object located by its own field, given no location, is at the only
open location while there is one (`record.create`, so every writer); with two or more open the
required field refuses it. When the reconciler adds a located field to an object with records, or
declares `located` on a field that already held records, it fills the empty rows with the **main
location** in the reconcile's batch: one `UPDATE … SET <column> = (SELECT id FROM core_location
WHERE main = 1) WHERE <column> IS NULL` per field, with no bound values, whatever the table's size
(D1's limits on compound terms, result columns, bound parameters and statements per invocation are
not reached: one statement, one subquery, no parameters). It runs again without change. The spec
said "the only location"; on a host that already has two when a pack gains the field, the main
location is the one that existed for every older record.

**Filed under the main location on a host with more than one.** The fill cannot know where an older
record belongs. When more than one location exists at the time of a reconcile that fills, the plan
carries one change per filled field (`fill_main_location`) naming the object and how many records
were filed under the main location. It shows in an extension's approval (as a warning), in
`extension.install`'s and `extension.check`'s answers, and every admin is sent a notice when the
plan is installed (shipped packs too, which are installed with no one watching). `cos ext check`
plans against an empty database, so it never sees records to fill.

**Correcting a record filed at the wrong location: `location.relocate`.** A room's location never
changes on its own while a live record that agrees with it names it: `record.update` is refused
(`location_mismatch`), and so is any statement by the database. The one write that changes it is
`location.relocate` (`settings:manage`; an AI's call always waits for a person): it moves the
record and **every record of every object whose `agree` passes through it** (its series and
classes, past and future, in the Trash too) to the new location in one batch. Each moved record's
relation to the room is first set to a mark no id can be, the room is moved, then each record
names the room again with the new location, so every trigger reads the end state; the batch is
refused whole if anything would still disagree (another rule of a moved record) or the new
location is closed. Times and zones are kept: it says where records are filed, not when anything
happens. It is audited on the record, with the count of each object moved. Making a new room
remains possible, but is not the remedy.

**The located zone default** (amends ADR 0460). A located record's empty `timezone` field takes its
location's zone, not the organisation's: in `record.create`, in `recurring` (a series' rule with no
zone of its own, at generation, a series change and following a series), and in the reconciler (a
zone added to located records that exist takes each row's location's zone). What is not located
keeps the organisation's zone. A series at a location in another zone makes its classes at their
local time there on both sides of every clock change; each class carries that zone, which a
coach's "today" and the zoned triggers already read.

**A record moved takes its new location's zone** (the spec: "Moving a series to another location
changes its future classes as any series change does"). On any write that changes a located
record's location (`record.update`, so the import's updates and every other writer too), each of
its `timezone` fields that the write does not set and that holds the old location's zone, or
nothing, becomes the new location's zone. A zone that differs from the old location's was set by
hand and is kept. For a series, its future classes then follow the new zone as any series change
does (`recurring`). `location.relocate` is not a move in this sense and keeps zones.

**`agree`** (SDK `AgreeSpec`, at most four per object): two paths of the object, each a relation to
one location or `relation.field`, that must name the same location (`{ a: "location", b:
"room.location" }`). It is the database's: the reconciler builds triggers on the declaring table
(after an insert, and after an update of the id, the Trash column or a column the paths read: the
row is refused when it is live and both sides name a location and they differ) and on the table a
path passes through (after an update of the location there: refused while a live record naming the
row would then disagree), with an index on the relation. So a room's location is fixed while a live
class at it names it (make a new room), and a room moved while a class is being written cannot leave
them apart. The write path reads first (`locations/index.ts`, one `EXISTS` over every live record
naming the room), for a clear message and for the approval queue's dry run. A write it cannot see,
one earlier in the same batch (a nested tool run), meets the trigger, whose refusal is answered with
the same rule and, for a room moved, the same words. Both
are `invalid_input` with `rule: "location_mismatch"`: a series whose generation is refused is tried
again in an hour, and an import reports the record as invalid. A series that declares `agree`
itself cannot reach that state (its own write is refused first), so packs declare `agree` on a
series as on what it makes; one that does not fails each hour, logged, with nothing shown to staff
(no notice exists for a failing series today). A side that is empty agrees with
anything; a record in the Trash is not checked until it is restored. A reconcile that would build
the triggers over live records that already disagree (after its fill) is refused, naming them
(`agree_conflict`); the read is made only when the rule, its tables or the plan's fills of them
change. The relation index the triggers read by is dropped when the object is hidden.

**A closed location takes nothing new.** A record of an object located by its own field, created at
a closed location or moved to one, is refused (`location_closed`); what is already there can be
changed and cancelled. A series at a closed location makes nothing (without failing) until it
reopens. A record located by a path (a booking of a class already made) is not refused.

## Why

- One declaration that every later piece reads (the staff limit, the report filter, the public
  timetable filter) is what keeps location code out of packs.
- Triggers, as for `occupies`, are the only place a rule holds for statements the record code does
  not write and for two writes racing; the read before only explains.
- A used room's location is never changed under its classes one write at a time; when it was wrong,
  everything that uses it moves together, so reports by location stay true for past records too.

## Proof

`packages/core/test/located.test.ts`: the contract's refusals; the fill on a new record and on
records that existed (twice, without change); a zone added to located records takes each one's
location's; a series at a London location in a Sydney organisation makes its classes at 06:00
London time across 30 March, 6 April, 5 October and 26 October 2031, and a series whose zone is
cleared does too; a class whose room is elsewhere is refused for a person, the assistant once
approved, MCP, an import and a series' generation, and by the database for raw writes and a
restore; a used room keeps its location; an install over disagreeing records is refused; a closed
location takes no room, series or class and its series make nothing until it reopens; a series
moved from Sydney to London takes London's zone and its future classes are at 06:00 London time,
and one with a zone set by hand keeps it; a fill on a host with two locations says how many
records it filed; `location.relocate` moves a room with its series and its past, future and
trashed classes, and an AI only asks; names as long as the contract allows install.
`packages/sdk/test/located.test.ts`: each contract refusal.

## Consequences

- Bookings, Memberships and Rostering declare `located` and `agree` in steps 4 and 6; nothing in a
  shipped pack is located yet, so nothing changes on a host today.
- The zone readers that still read only the organisation's zone become location-aware in step 3.
