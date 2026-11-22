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
