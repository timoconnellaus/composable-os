# ADR 0505: Window numbers through two relations and over the extension's settings

Status: accepted, 2026-11-22 (stage 31a, build step 3). Extends
[ADR 0503](0503-time-windows-and-staff-only-on-the-transition-engine.md) and
[ADR 0500](0500-recurring-a-weekly-rule-in-local-time.md) (`horizonAtLeast`).

## Context
A booking's windows are worked out from its class's start and from numbers the gym sets: a class
type's own rule when it has one, else the organisation's. ADR 0503 let a window read a field of
the record or one relation away (`class.startsAt`), and said the numbers would be "copied by the
host onto the class". Two things stood in the way when the pack was written:

- **The class type is Programs'** (spec 31). Bookings adds its rules to `programs.classtype`, two
  relations from the booking (booking → class → class type), in another extension's object.
- **"Else the organisation's"** is an extension setting, which no window could read; and a copy on
  each class (made when the class is made) goes stale when the gym changes a class type's rule or
  the organisation's, for up to the timetable's 56 days of classes already made. Keeping copies
  current would be a cascade on every class type and every settings change.

## Decision
- **A path may pass through two relations** (`class.classType.lateMinutes`), each of one record.
  **Every field on the way is the declaring extension's**: a field of one of its objects, or one it
  adds to another object (`fields: { "programs.classtype": { lateMinutes } }`, registry name
  `bookings.lateMinutes`). So a pack reads its own rules on another pack's object, and nothing else
  of it. The SDK checks it (`resolveFieldPath`); the host reads each record once per write, through
  its own view (ADR 0503), at most two reads more than before.
- **A window's number may be `{ field?, setting? }`**: the field's value, and when it is empty the
  extension's setting of that name (its stored value, else its declared default). Read in the
  write, so a change to a class type's rule or to the organisation's setting holds from the next
  write, for every class already made. A setting must be a number setting of the extension (the
  SDK checks it). When both are empty the window cannot be worked out and a customer is refused
  (`state_window_unknown`), as before.
- **A staff-only rule may name several booleans** (`staffOnly: ["class.classType.staffOnly",
  "class.closed"]`), any true being staff only, and a **boolean formula** among them (the host
  computes it in the view): a class that is not scheduled is closed to members, as a staff-only
  class type is, so a member who still reads a cancelled class through an old booking cannot book
  it again.
- **`horizonAtLeast` may name another extension's object** with a number field this extension adds
  to it (`{ object: "programs.classtype", field: "opensDays" }`): the timetable reaches as far as
  the longest window any class type opens.
- **`state.resolve`** (ADR 0504) is the operation a tool calls for ADR 0503's dry run.

## Consequences
- The class carries no copy of its rules, so the public timetable cannot show them: the booking's
  refusal says when booking opens (`opensAt`), and "booked by the gym" (ADR 0504).
- A setting's declared default is read from the installed manifest (`core_extensions`), and its
  stored value from `core_extension_settings`: two reads, made only when a field is empty.
- The organisation's setting is not a floor of `horizonAtLeast`; Bookings bounds its "opens"
  setting to the default horizon instead.

## Proof
`packages/core/test/bookings-platform.test.ts`: a late cancel decided by the class's type two
relations away; the setting's default, a stored value, a changed one, and the class type's own
winning over it; a customer's create refused for a staff-only type and for a class not scheduled
(a formula), staff not bound; and the SDK naming each wrong path, number setting and waived field.
`apps/runner/test/bookings.test.ts` does the same through the Bookings pack on Programs' class type.
