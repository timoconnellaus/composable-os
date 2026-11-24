# ADR 0507: What the Bookings review needed of the platform

Status: accepted, 2026-11-22 (stage 31a, build step 3, after the independent review). Extends
ADRs [0425](0425-one-transition-engine-for-stages-and-states.md),
[0503](0503-time-windows-and-staff-only-on-the-transition-engine.md),
[0505](0505-window-numbers-through-two-relations-and-settings.md),
[0500](0500-recurring-a-weekly-rule-in-local-time.md), [0402](0402-staff-and-customers.md)
and [0480](0480-an-ai-asks-to-publish-a-person-approves.md).

## Context
The review of the Bookings pack's spine found no way for a customer to book outside the rules
through its tools, but found rules the pack could only have kept by trusting its own tools, or not
at all: a class the host cancels left its bookings booked with their uses spent; a member's
booking could be repointed to another class after a late cancel, its kept use returned and spent
again; staff could book into a cancelled class; an AI or MCP client could return a use after the
class through the staff cancel; a trashed class type opened its classes to members on the
organisation's default; a class without a zone could not be booked; booking rules any staff actor
could change; a walk-in left a Person behind when their booking was refused. Each is a rule that
must hold for every actor, so each is the host's.

## Decision
- **A state cascade** (`states.follows: { relation, when, from }`): when the record a relation
  points to moves into a state `when` names, the host moves every live record of the following
  object in `from` to the state given, as the host, in the same batch, through the record code
  (so each child's place is released and its use returned). At most 500 a move, else refused.
  Bookings declares it on the booking (`class` cancelled: `booked`, `waiting`, `pending` to
  `cancelled_by_us`). Every host cancel path reaches it (closures, a series changed, ended or
  trashed), and so would a staff cancel. ADR 0500's confirm now counts a record with live
  followers as well as one with places taken, and its refusal names how many followers each
  cancel moves (`followers`).
- **Closed to everyone but the host** (`states.create.closed`, booleans named as `staffOnly` is):
  while any is true nobody but the host creates one, staff included; judged on create and when a
  write changes what it reads. Bookings: a class that is not scheduled.
- **A customer creates only in the initial state**, or one `create.in` lists for them; creating
  straight into a later state (a booking made already cancelled) is refused for every object.
- **Create-only customer fields** (`customer.createOnly`, a subset of `customer.write`): set when
  the customer makes the record, refused on any later write of theirs, at the seam's write helpers
  and in its final check, whatever tool asks. Bookings: the class and the holder.
- **An unreadable rule source is not an empty one**: a relation set on a window's path whose
  record cannot be read (in Trash, gone) makes the window unknown (refused to a customer) and a
  staff-only or closed flag set, never the organisation's default. **An empty zone is the
  organisation's** (it was an unknown window).
- **A request is resolved by the clock for every caller but a person**: the assistant, an MCP
  client, an automation and extension code (any pack tool's own calls) as a customer's; a person on
  the staff is not bound. Bookings' `cancelFor` asks for `cancel`; giving a use back after the late
  point is `returnUse` (below: a move only that tool makes), with its reason kept. The in-time
  cancel's window binds staff too (`moves[].bindsStaff`), so no staff write, a person's included,
  returns a use late except through it.
- **A person's approval for fields and settings** (`personApproves: true` on a field or a setting): a write that
  sets one, by the assistant, an MCP client, an automation or extension code, always waits for a
  person's approval (the gate forces review, as for an AI's publish, `ALWAYS_REVIEWED_PUBLISHERS`,
  ADR 0480). Chosen over refusing because it is the policy code's existing way to keep a change a
  person's while letting an AI propose it; a person's approval is the person's change. It covers
  `record.create`, `record.update`, `record.createMany`, `record.import`, `recurring.change` and
  `recurring.close`, and `extensionSettings.update`. Bookings' booking rules (the class type's
  fields and the organisation's settings) are declared so.
- **`person.createWith`**: a Person and one record of an extension object pointing at them, in one
  batch, after the platform's duplicate check (an email already on file is refused naming them;
  possible duplicates are refused listing them unless `allowDuplicates`). Granted to extension code
  as a write of `person` plus the record's object.
- **`state.resolve` is granted by object** (`operationObject` names its object, so a pack reaches
  only its own objects and those its read list names, never by listing the operation), reads with
  a staff caller's own scope, and knows only the object's own request names.
- **A pack does not list `record.*` or `my.*`**: listed, `checkGrant` allows them on every object.
  Bookings and Courses now rely on object grants (issue #243).
- **A dry run does not run an extension tool**: the approval queue's dry run of a queued tool
  called the sandbox, whose operation calls are real, so a destructive tool queued for a person had
  already made its change. The host tool returns nothing while `ctx.simulation` is set; it runs when
  approved.
- **The runner's packs are a Text module** (`shipped.txt`), as the SDK bundle is: they had grown
  the main module by each pack's whole source.

### Two notions of "a person's own", and why they differ (amended 2026-11-22, merging stage 32b)
- **A tool only a person may call** is ADR 0512's `humanOnly` on a tool, and **a move only such a
  tool may make** is ADR 0513's `states.moves[].tools`. Anyone else (the assistant, an MCP client,
  an automation, other code) is **refused**: the act is a person's, there is nothing to propose.
  Bookings uses it for `returnUse` (giving a use back after the late point, into `excused`), with
  the permission `bookings:returns`: there is one person-only mechanism for acts.
- **A value a person approves** is this ADR's `personApproves` on a field or an extension setting.
  Anyone else's write of it is **queued for a person's approval**, as an AI's publish request is
  (ADR 0480): the assistant may well propose "make late cancels 2 hours", and a person decides.
  It applies to data any staff write may touch (`record.update`, imports, settings), where
  refusing would only push the assistant to ask a person to do it by hand.
- So the names differ on purpose: `humanOnly` (tools) refuses, `personApproves` (fields, settings)
  queues. The first version of this ADR called both `humanOnly`; the field and setting one was
  renamed when stage 32b's merged.

## Consequences
- A class cancelled by staff (step 7's `cancelClass`) needs only a staff move into `cancelled`.
- A queued extension tool's approval screen shows no dry-run output.
- A booking's class cannot be changed by a member; a member cancels and books again.

## Proof
`packages/core/test/bookings-platform.test.ts` (13 tests: the cascade, closed for staff, the
initial-state create, the unreadable source, the empty zone, the clock for each actor, human-only
for each actor, `state.resolve`'s grant and request names, create-only fields at the seam and the
final check); `apps/runner/test/bookings.test.ts` (16: through the pack, closures and a series
ended cancelling bookings with uses back and `mine` showing it, staff refused a cancelled class,
walk-ins in one batch with duplicates offered, `cancelFor` by the clock, `returnUse` queued for the
assistant and applied for a person, booking rules held for the assistant and MCP, a trashed class
type, places required); the pack's own tests (17).

## Amended 2026-11-23 (stage 31a step 7)
- The cascade now holds at commit: it reads the parent's claims before its followers and guards the
  counter, and a create judged against `create.closed` guards that the record it is for has not
  moved ([ADR 0550](0550-timed-moves-and-a-cancel-that-races-a-booking.md)).
- Staff cancel a class through `cancelClass`, a tool a person approves
  ([ADR 0552](0552-a-tool-a-person-approves.md)); the class's move is the host's and that tool's.
- The `moved` state is entered only by the new booking's create (`movedFrom`), and before the old
  class starts ([ADR 0551](0551-staff-bound-windows-and-a-move-only-by-its-new-record.md)).

## Note, 2026-11-23 (ADR 0600)
`returnUse`'s permission is now `bookings:desk`, the front desk's (it was `bookings:returns`, which
no role held and nobody could be granted). It stays `humanOnly`, the one person-only mechanism.

## Amended 2026-11-24 (stage 57 step 2, ADR 0841)
- A follower may name a parent in an extension its own `requires` (`ticketing.event`); the host
  checks the parent's states at install and on every upgrade of either extension.
- The limit is 100 records a move across every following object (it was 500 an object, which D1
  would have refused past about 120: a follower costs up to 8 statements).
- A follower made between the cascade's read and its commit fails the move whole, whatever it
  claims ([ADR 0841](0841-cascades-widened.md)).
