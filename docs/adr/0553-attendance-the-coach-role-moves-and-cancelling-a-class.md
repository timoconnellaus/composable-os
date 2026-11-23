# ADR 0553: Bookings: attendance, the coach role, moving people and cancelling a class

Status: accepted, 2026-11-23 (stage 31a, build step 7). Composes ADRs
[0436](0436-pack-roles-and-the-door-role.md) (pack roles), [0437](0437-a-move-is-made-from-a-current-read.md),
[0507](0507-what-the-bookings-review-needed-of-the-platform.md), [0520](0520-a-waitlist-on-a-claimant.md),
[0550](0550-timed-moves-and-a-cancel-that-races-a-booking.md),
[0551](0551-staff-bound-windows-and-a-move-only-by-its-new-record.md) and
[0552](0552-a-tool-a-person-approves.md). Spec: [stage 31](../stages/31-bookings.md), decisions 10,
11 and 15, acceptance criteria 6, 7 and 11.

## Decision

### Attendance and no-shows
- A booking records who marked its attendance and when (`markedAt`, `markedBy`, `markedByName`,
  read-only, set by the pack's tools from `ctx.caller`, never the input).
- **Ticking** (`markAttended`) moves `booked` (or `no_show`, a late correction) to `attended`, from
  where it was read or not at all: of two coaches ticking one name at once, one tick is made and the
  other is answered `already` with who was first. The move's window opens an hour before the class
  and binds staff (a guess: people arrive early; never days ahead); it has no end, so a correction
  after the class is allowed. `undoAttended` moves it back to `booked`; `markNoShow` marks one from
  the class's start; `markAll` ticks everyone still booked, each name conditionally.
- **No-shows**: 30 minutes after the class's end the host makes every booking still `booked` a
  `no_show`, only if someone on the class is `attended` or `no_show` (`states.after`, ADR 0550).
  A no-show and an attended booking keep their place and their use; nothing else follows.
- A booking cancelled (by the member, or with its class), waiting or moved cannot be ticked.

### The coach role
`bookings.coach`: `permissions: ["bookings:coach"]` (the tools `day`, `roster`, `markAttended`,
`undoAttended`, `markNoShow`, `markAll`) and `read: ["bookings.class"]`. `roster` is the coach's
list: the class, and each booking's person's name, state, who marked it and when promoted; nothing
of holders or desk payments. The coach role does **not** hold `classList` (it shows holders and desk
payments), `bookFor`, `findPeople`, `cancelFor`, `move`, `returnUse`, `cancelClass`, any record
read of bookings, people, passes or memberships, settings, or anything else (ADR 0436's pipeline
refuses every other operation).

### Moving people
`move { bookingId, toClassId, note? }` (staff, `write`): `record.create` of the new booking naming
the old one in `movedFrom`; the host moves the old one, gives its place back (to the waitlist before
its cut-off), spends the use again from the same holder, in one batch, or refuses the whole
(ADR 0551). The new class's places count the waitlist's holds, so a staff move never takes a place
held for the queue; staff who want to put someone in anyway raise the class's places first (spec 31).
Only a booked booking, before its class starts.

### Cancelling a class
`cancelClass { classId, reason }` (staff, `destructive`, `personApproves`, `bookings:cancelClasses`):
the class moves `scheduled → cancelled` with the reason (`cancelledReason`, read-only); the cascade
(ADR 0507) cancels every booked, waiting and held booking in the batch (`cancelled_by_us`), each
place given back and each use returned. Bookings already ticked stay `attended`. The move into
`cancelled` is the host's and this tool's alone.

### Pack roles do not combine (checked at build)
Spec 31 asked whether a coach who also scans event tickets can hold both roles. An account holds
one pack role (`core_user.pack_role`, ADR 0436); this step does not change that. Such a coach uses
a staff account with an ordinary role (which holds every tool), or one account per role. Roles that
combine are stage 14a's (ADR 0436's consequences); ADR 0436 is amended with this note.

## Deviations from the spec
- **The coach role does not book walk-ins or members.** Spec 31 gives the role "book walk-ins and
  members into a class"; booking someone on file needs looking them up (`findPeople`, every person's
  name and email) and a walk-in runs the duplicate check, which answers with the People it matches:
  both reach people beyond the lists, which the same sentence rules out, and `paidAtDesk` books a
  place for no use. The desk (staff) books them; the coach ticks them once booked.
- **Promote by hand** (a waiter moved in ahead of the queue, with a reason) is not built here.
- **Emails** (a change or cancel by the gym, the member moved) are step 9's; **paid drop-in
  refunds** on a cancelled class are step 8's (there are no drop-ins yet).
- **"Staff are told of classes with no attendance"** is step 9's (views and messages).
- **Closures** (listed in step 7) were built in step 3 and cancel through the same cascade.

## Proof
`packs/bookings/test/bookings.test.ts` (the declarations and every new tool's calls and words),
`packages/core/test/attendance-platform.test.ts`, `apps/runner/test/bookings-attendance.test.ts`,
and `apps/app/e2e/bookings.spec.ts` ("a coach ticks who came on a class's list", with the
`bookings-class-list` web block).

## Amended 2026-11-23, after the review of PR #253 (before merge)
- **A class the gym cancels gives every use on it back** (the coordinator's decision, against
  criterion 6): the cascade now takes every booking holding a place or a use, `booked`, `waiting`,
  `pending`, `attended`, `no_show` and `late_cancelled`, to `cancelled_by_us`, each use given back
  once (a late cancel is no longer final; only the host's cascade moves it on). Before, a ticked
  booking stayed `attended` on a cancelled class with its place and use, and unticking it left it
  `booked` there.
- **A class that has ended cannot be cancelled**: the class's move into `cancelled` has a window
  until its `endsAt` that binds the tool's staff write (`bindsStaff` with `tools`), and `endsAt` is
  now required. So no-shows never arise on a cancelled class. The host's own cancels (closures,
  series) are not bound.
- **Nothing takes a place on a closed record**, for anyone, the host included: a move from a state
  holding no place into one that holds a place is refused while `states.create.closed` is set
  (`state_closed`), with the same `unmoved` guard (ADR 0550). A move between two place-holding
  states (unticking on a class marked done) is not a new place and is allowed.
- **`cancelClass` fails rather than answering a refusal** (not found, not scheduled, ended, or
  changed twice): a race is retried once from a fresh read, and an approved request that cannot
  apply shows that it did not. The errors are caller errors (`not_found`, `conflict`,
  `invalid_input`), so they never quarantine the pack.
- **The coach role reaches today only** (`roles.coach.today`, a new declaration on a pack role,
  `packages/core/src/pack-role-today.ts`). By object it names a moment, its end and its zone, read
  through one relation at most: a class by its `startsAt`, `endsAt` and `timezone`, a booking by
  its class's. A record is today's when its start falls on today's date in the class's own zone
  (the organisation's only when it has none), or it has started and not yet ended, so a coach
  ticks a class that runs past midnight until it ends. The pipeline holds the limit before every
  operation a limited call makes: the calls of an account holding the role, and every call of a
  tool run it started, the runs of tools those tools call included (the limit travels in the
  run's own state and in each invocation it makes, never in an input). `record.list` gets the
  limit as a predicate in its own query, so its page size, cursor and any projection see only
  today's records; `record.get` and `record.update` check the stored row (not found otherwise);
  any other operation naming a limited object (`record.count`, `record.create`, a batch, …) is
  refused, since the limit cannot check it. Another day's class is not found, `day` for another
  date lists nothing, and another day's name cannot be ticked. The spec says the coach reads
  "today's classes and their lists", so yesterday's late corrections are not the coach's: the desk
  (any other staff role, not limited) makes them. Identifiers in the predicate are the registry's.
- **Exactly what a cancel gives back**: a use spent from a membership or pass. A booking paid at
  the desk holds no use, so it has nothing to give back; refunds are not built (step 8).
- **`move` and `cancel` call a booking already in a final state a race** (`changed`); any other
  undeclared move fails loudly.
- Proof: `apps/runner/test/bookings-attendance.test.ts` (cancel after a tick and a late cancel,
  each use back once; untick after the cancel refused; cancel after the end refused; a move racing
  the member's cancel; a move into a class type the pass does not cover; the coach refused a class
  five days ahead, through its reads and its tools; a list of one sorted newest first, and one
  projected without the date, still today's only; a fixture tool calling roster under the limit;
  `record.count` refused; a class in a zone just past midnight ticked while it runs; a cancel
  racing an untick, one return; a class with no end time not cancelled), `packages/core/test/attendance-platform.test.ts`
  (a set-aside booking refused back onto a cancelled class), and the pack's tests. A weekly
  membership moved across weeks was not added on the shipped packs (it needs a subscription
  through the fake provider); the platform's fixture covers a move into a week with no use left
  (`allowance.test.ts`).

## Note, 2026-11-23 (merging the family link, ADR 0540)
- A moved booking stays its Person's (a child's stays the child's) and carries who made it: the
  host copies the source's `madeBy` onto the new booking inside the move (the allowance's
  `movedFrom`), and nobody, staff and the pack's tools included, can write it.
- Ticking, moving, cancelling a class and the class list are staff tools: no customer, a
  guardian included, reaches them. The coach's limit to today is a staff sign-in's; a guardian's
  scope is a customer sign-in's; the two never meet in one call.

## Amendment, 2026-11-23 (issue #258, ADR 0600)
- **The coach role does not book walk-ins or members, by default**: a coach is given the desk's
  permission. Bookings declares `bookings:desk` (grantable) on `findPeople`, `bookFor`,
  `cancelFor`, `move`, `returnUse` (whose permission was `bookings:returns`) and `classList`, and
  `day` names both `bookings:coach` and `bookings:desk`. A human admin ticks it for a coach on the
  Users page; the coach then works the desk on any day, and the coach role's own reach (`roster`,
  the ticks, `markAll`, its reads of `bookings.class`) stays today's. A coach who also scans event
  tickets still uses an ordinary staff role or a second account: an account holds one pack role.
- **The limit to today binds what the coach role gives, not the account**: the pipeline carries it
  only on a call the role allows (`roleLimitsFor`), never on one a grant allows, so it never blocks
  the desk and a grant never lifts it off the roster or a tick. See
  [ADR 0600](0600-a-pack-role-and-its-grants-add-up.md).
