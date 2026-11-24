# ADR 0881: A pack role limited to the People its holder looks after, and Programs' coach role

Status: accepted, 2026-11-24 (stage 41, found while putting the first client's app on the
platform). Builds on [ADR 0436](0436-pack-roles-and-the-door-role.md) (pack roles),
[ADR 0451](0451-role-clients-staff-in-the-mobile-app-and-browser-calls.md) (a role's own client),
[ADR 0448](0448-programs-the-layout-assignments-and-the-log.md) (Programs),
[ADR 0453](0453-pack-hooks-over-the-clients-operations.md) (pack hooks) and
[ADR 0553](0553-attendance-the-coach-role-moves-and-cancelling-a-class.md) (a role limited to
today). Builds the "shipped pack's team" that stage 56 decided (ADR 0831, in review as PR #373)
and left for the first pack that needs it.

## Context
The native coach's client view (`programs-native-coach-client`) and the session screen it opens
need `record.list` on `programs.session` and logging for a named client (`personId` on the log
tools and `sessionGet`). Only the full staff client has those, and the whole staff client is never
written into a client app (ADR 0451). Programs had no pack role, so a coach in the gym's app had no
client to use. A role reaching every client's training would be the staff client again in a
smaller shape: a coach looks after some clients, not all of them.

Pack roles could hold tools and read objects (ADR 0436), and limit reads to today (ADR 0553), but
nothing said "only the people this account looks after". Stage 56 decided what looking after
means: chosen, never worked out from bookings; and a shipped pack may declare a `team` on an
object, the staff named on a live record about a Person looking after that Person while it is live.

Separately, `useClassTypes` in the pack's hooks called `record.list`, which a customer's client
does not hold, so `programs-native-class-today` could not be wired in a member's app as shipped,
although `my.list` already serves `programs.classtype` to every signed-in member (ADR 0447).

## Decision

**A team on an object** (`team` in the SDK's `ObjectSpec`, `TeamSpec`): `{ person, staff, live }`:
`person` a relation (one record) to `person`, `staff` up to four `user` fields, `live` the states
of the object's `states` in which a record counts (left out: every record not in the Trash). It
gives nothing by itself. Only shipped packs and an org's own extensions declare it: a runtime
extension is refused (`outside_audience`), as for every declaration of who reaches what.

**A role limited to the People its holder looks after** (`looksAfter` on `RoleSpec`): by object of
the pack, its relation (one record) to `person`. The holder looks after a Person when a live
record of one of the pack's own objects that declares a `team` names the account in a staff field.
The check refuses an object of another extension, a path that is not a single relation to
`person`, an object already limited to today, and `looksAfter` in a pack that declares no team.
`cos ext check` says which objects a role reaches only for those People.

**The host holds it, as it holds today's limit** (`pack-role-looks-after.ts`). The pipeline reads
the role with its pack's manifest in the one statement it already makes (`loadStaffRights`), so
the teams come with it. While a call carries the limit (the account's own call, or a tool run it
started, and the runs that run starts, through `roleLooksAfter` beside `roleToday`), before the
operation runs:
- `record.list` of a limited object holds a predicate in its own query (`looksAfterWhere`):
  `<relation> IN (SELECT person FROM <team's view> WHERE <staff> = ? AND <state> IN (…))`, one
  `SELECT` per team joined by `UNION`. Its bound values are the account and the live states,
  however many People it looks after; a filter, sort, cursor or projection cannot reach past it;
- `record.get` and `record.update`: the stored record must be about one of them, else not found;
  an update pointing it at another Person must point it at one of them;
- `record.create`: the new record's Person must be one of them, else not found;
- any other operation naming a limited object (count, `createMany`, delete, batch): refused.
The limit is held before the gate, the agent's grant and the queue, so a call on someone else's
record is not even queued. Nothing is cached: when the record ends or names another coach, the
reach changes on the next call. A grant that opens a tool (ADR 0600) lifts the limit on that call,
as it lifts today's; Programs declares no grantable permission.

**Programs' coach role** (`programs.coach`): `permissions: ["programs:coach"]`, on `today`,
`sessionGet`, `logAdd`, `logUpdate`, `sessionComplete`, `history` and `progress`; `read:
["programs.assignment", "programs.session"]`; `looksAfter` on assignments, sessions and logged sets
by `person`. The assignment gains `coach` (a `user` field) and declares `team: { person: "person",
staff: ["coach"], live: ["generating", "active"] }`; `x.programs.assign` takes `coachId`. So a
coach-role account lists and opens its clients' assignments and sessions, reads a session with its
last times, logs and changes sets and marks sessions for them (the set records the coach), and
reads their history and progress. Nothing else: no other client's anything, no class session (it
is about no Person), not the bank, programs or class types as records, not `assign`,
`classToday`, the draft or the import, no people, no settings. Its client (`roles.json`, `cos
client generate` with `mobile.roles: ["programs.coach"]`) is those seven tools and `record.get`
and `record.list` typed to its two objects. Any member of staff calls the tools as before.

**A hook that reads each audience's way** (`packHooks`, `@composable-os/client`): a hook's calls
may be `{ anyOf: [[…], […]] }`; it is there for a client holding all of one list, and `make` gets
`holds(operation)` to pick. `useClassTypes` is `{ anyOf: [["record.list"], ["my.list"]] }`: staff
read with `record.list`, a member with `my.list`. `hooksOperations(calls)` lists every operation
the hooks may call (the admin's screen client holds them all, and so reads with `record.list`).

## Why
- A coach's reach is people, not records: the limit names the Person relation and the team says
  who, so a client's sessions, sets and assignments follow from one choice, the assignment's coach.
  Through the assignment and not a field on each session, a new coach takes over a program's whole
  history at once and nothing is copied.
- The team is stage 56's decided shape, so stage 56's own "looks after" (`core_person_carer`, set
  on the Person's page by a person) can be added to the same predicate when it lands, without a
  second notion of who looks after whom.
- A subquery, not a list of ids, keeps a coach with many clients inside D1's 100 bound values a
  statement; today's limit reads its candidates into a list because a day's classes are few.
- Not found, not forbidden, for someone else's record: the coach learns nothing of who else there
  is. Refusing every other operation on a limited object keeps the rule checkable: there are four
  operations it understands.

## Consequences
- Who a client's coach is, is an ordinary staff write of the assignment's `coach` (a member, or an
  assistant's write through the gate as any write); it opens that client's training to the coach
  role's account only, never notes or the Person. Stage 56 makes "looks after" a person's choice
  (`people:link`, human only); when it lands, the assignment's coach should either become a
  person's choice too or be read alongside `core_person_carer`. Recorded as a follow-up.
- One more statement on each role call that gets, updates or creates a limited record; none on
  anyone else's calls. A list's predicate rides in its own query.
- The admin: the coach role passes the gate of Programs' client tab (`programs/client`, it opens
  `logAdd` and `sessionComplete`), which sits on a Person's page the role never opens. Its work is
  in the app.
- The class-today blocks list `my.list` and `record.list` in their `operations`: a member's client
  calls the first, staff's the second.

## Proof
`apps/runner/test/programs-coach.test.ts`: the coach lists and opens only its client's sessions
and assignments (a filter naming another, a page of one, a projection); reads, logs, marks, and
reads history and progress for its client through the tools; every tool on another client's
session or set, and on a class session, is not found, and another's history and progress are
empty; the whole registry walked with empty input lets through only the role's operations
(`roles.json`); record reads of the bank, programs, class types, sets and core objects are
forbidden; the reach follows a change of coach and ends when the assignment ends; a member's call
carrying the limit (as a tool run does) is held to it, and `record.count`, `createMany` and
`delete` are refused, a create about someone else and an update pointing at them not found; the
list's predicate binds three values. The manifest checks name a bad team and a bad `looksAfter`,
and a runtime extension's team is refused. Removing the list's predicate fails four of its tests.
`apps/runner/test/programs-hooks.test.ts`: a member's client (the customer contract's operations)
has `useClassTypes` over `my.list`; staff's reads with `record.list`; the coach role's client has
the coach screens' hooks and not `useAssign`, `usePeople`, `usePublish`, `useDraft` or
`useClassToday`, and its client view shows its client's sessions and none of anyone else's.
`packages/core/test/screens.test.ts`: the role's admin screens.
