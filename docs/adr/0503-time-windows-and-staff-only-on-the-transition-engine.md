# ADR 0503: Time windows, staff-only rules and requested moves on the transition engine

Status: accepted, 2026-11-22 (stage 31, build step 2). Extends
[ADR 0425](0425-one-transition-engine-for-stages-and-states.md).

## Context
A gym's rules decide when a member may book (opens 7 days before, closes at the start), when a
cancel is late (from an hour before), and which class types only staff book. They must hold for a
member on the web, in the app, through their own AI client and through any pack tool: a pack
tool deciding "late" would be the pack hooking a write. The rules come from fields: the class's
start, and numbers a class type overrides over the organisation's defaults.

## Decision
- **A window on a move** (`moves[].window: { from?, until? }`) and **on every create**
  (`states.create.window`): a customer may make the move, or the create, from `from`
  (inclusive) until `until` (exclusive), by the host's clock in the write (`ctx.now`). Staff and
  the host are not bound (they book a member into a closed class); a window binds customers only,
  so a move with one must list `customer`.
- **A window's end is worked out from fields**: `{ at, daysBefore?, minutesBefore?, zone? }`.
  `at` is a datetime field of the record or of the record a relation points to
  (`klass.startsAt`, one hop); `daysBefore` counts whole local days at the same time of day in
  `zone` (a timezone field; the organisation's when left out), so "opens 7 days before" is 06:00
  a week earlier across a clock change; `minutesBefore` is an exact length of time. Each is a
  number or a number field. When any of them has no value, the window cannot be worked out and a
  customer is refused (`state_window_unknown`) rather than let through. The spec had the host
  compute `opensAt` and the rest onto the class; that remains open to the pack (a host-set field
  named as `at`), and the engine does not need it.
- **Staff only** (`moves[].staffOnly`, `states.create.staffOnly`): a boolean field, named the
  same way; while it is true a customer is refused (`state_staff_only`).
- **A requested move** (`states.requests: { cancel: ["cancelled", "late_cancelled"] }`): a caller
  writes the request's name into the state field and the host picks the first listed state whose
  move from where the record is the caller may make now, windows included. A member's "cancel" an
  hour and a minute before is `cancelled`; at 59 minutes, `late_cancelled`; at the start, refused.
  Staff asking for "cancel" get `cancelled` (not bound). The record operations resolve it before
  validating, so a request is never stored; `resolveStateRequest` is the dry run a pack's tool
  shows before the member confirms.
- **States a record may be created in** (`states.create.in: { waiting: ["staff", "customer"],
  pending: ["host"] }`): a create into one of them is not judged as a move from `initial`, and is
  made only by the movers listed. A booking is created booked or waiting by a member, pending
  (held while a drop-in is paid) only by the host. Without it, creating in `pending` would have
  needed a `booked → pending` move, which a claimant may not declare (ADR 0501).
- **Refusals** are `invalid_input` with `rule` `state_window_not_open`, `state_window_closed`,
  `state_window_unknown`, `state_staff_only` or `state_request_refused`, and the window's
  `opensAt` and `closesAt` where they apply, so a block can say "opens Tuesday at 06:00".

## Consequences
- Windows read one related record per write, through the host's own view.
- Who staff are is unchanged: the assistant and MCP clients are staff and bound as staff are;
  the approval gate decides what they may do without a person.
- The local-time opening the spec mentions ("00:00 seven days before") is a pack's field set by
  the host, read as `at`; the engine has only lengths of time and whole local days.

## Amended 2026-11-22 (review, before merge)
- **Changing what the create rules read is a create.** A customer's write that changes a field
  the create rules read (the relation in `klass.startsAt`, or a field of the record itself) is
  judged against them for the record as the write leaves it, whatever state it is in: waiting on
  an open class and then pointing the booking at a closed or staff-only one is refused. A move's
  window is always judged on the record as the write leaves it, so changing the relation in the
  same write as the move is judged against the new one.
- **The AI assistant is resolved by the clock.** Staff asking for `cancel` still get the first
  state (a person on the staff may cancel late without keeping the use), but a call whose actor
  is `assistant` (an AI acting for a member) is resolved as a customer's is. The actor is the
  invocation's (`ctx.actor`), set by the pipeline, not by the caller's input.
- `localDaysBefore` keeps the seconds and milliseconds past the minute.

## Amended 2026-11-22 (stage 31a step 3, ADR 0505)
- A path may pass through two relations, every field on the way the declaring extension's (its
  own objects' fields, or fields it adds to another object); a window's number may be `{ field,
  setting }`, the field else the extension's setting; `staffOnly` may name several booleans, a
  boolean formula among them. The numbers are read in the write rather than copied onto the
  class, so a change of a class type's rule or the organisation's setting holds at once.
- The dry run is an operation: `state.resolve { object, id, request }` (tool-only, staff and
  customer, a customer of their own records only; ADR 0504).

## Amended 2026-11-23: the engine asks an agreement point (stage 44 step 3, [ADR 0644](0644-enforcement-nobody-pays-or-books-without-what-is-due.md))
Beside its windows, staff-only rule and `closed` flag, the engine asks an object's agreement point
(`agreements.enter`, `person`) for every caller's write, every actor, every path (`record.create`,
`record.update`, `my.create`, `my.update`, the record import, a pack's tools, MCP): a record created
in a listed state, moved into one (except, with `claims`, between two states that both hold the
place), or given to another Person while in one, is refused while something is due for its Person
(`agreements_due`), and the batch carries the guard. The host's own moves are never asked.
