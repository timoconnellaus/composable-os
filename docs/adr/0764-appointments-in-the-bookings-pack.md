# ADR 0764: Appointments in the Bookings pack, booked by staff

Status: accepted, 2026-11-25 (stage 49, build step 5). Is the spec's ADR "0765" (stage 49's
"Migrations and numbers": step 2 took 0765, so this one takes the lowest free number). Amends
[ADR 0504](0504-the-bookings-pack.md) (the Bookings pack), [ADR 0493](0493-the-allowance-behaviour.md)
(allowance conditions and copies), [ADR 0626](0626-the-rostering-pack-and-bookings-additions.md)
(who says who works a shift) and [ADR 0763](0763-the-customers-check-on-a-free-time.md) (the room a
booking takes). Builds on ADRs [0760](0760-claim-margins-and-a-required-account-on-staffed.md),
[0761](0761-a-shift-that-names-a-client-kept-off-the-roster-and-the-feed.md),
[0762](0762-open-hours-and-free-times.md), [0765](0765-occupies-the-claim-on-a-thing.md),
[0506](0506-a-spender-paid-another-way.md), [0513](0513-a-granted-holder-keeps-what-it-was-granted.md) and
[0551](0551-staff-bound-windows-and-a-move-only-by-its-new-record.md).

## Context
Steps 1 to 4 built the platform pieces of one-to-one sessions (claim margins and a required
account, `occupies`, open hours, free times and the customer's check), with nothing declaring
them. A gym needs the records: kinds of session, booked sessions, how they are paid, and what a
late cancel or a no-show costs (decision 1: the session, never a fee). Staff book first; members
booking their own is step 6. Three things the pack could not say with the platform as it was:

1. **What a pass pays for.** A holder's conditions compared a spender field the host fills with a
   holder field, and an empty holder field allowed anything. Every pass and membership on file has
   empty class types ("every class type"); declaring appointments as a second spender with the
   service compared would have let every class pass pay for personal training, and a "10 PT
   sessions" pass pay for classes. And the appointment's service is its own field, which no copy
   could fill (a copy reads one relation away, never the related record's id).
2. **The room.** The customer's check needs the room named; staff should not have to pick one.
   ADR 0763 left "the host choosing the first free room when none is given" to this step.
3. **Who names the provider.** Where Rostering is installed, saying who works a shift is a
   rosterer's (ADR 0626), so a member at the desk could not book a client with a coach. ADR 0763
   left whether `bookings:appointments` covers it to this step.

## Decision
- **`bookings.service`**: title, description, length, a buffer before and after, a price per
  session (not sold yet: step 8), the rooms it may use in order, the step, its own opens, closes and
  late-from (else the organisation's `appointmentOpensDays` 28, `appointmentClosesMinutes` 720,
  `appointmentLateMinutes` 1,440, each a person's to change), who books it, offered. It is the
  appointment's kind: who gives it is a qualification, never a list on it.
- **`bookings.appointment`**: service, client (a Person), coach (a coach profile), room, start, end,
  zone, state, the holder spent, the service's id, local weekday and minute (host-filled), paid at
  the desk, booked by, moved from, a staff note, who marked it. It declares:
  - `staffed`: the coach profile's staff account (`account: "required"`), the service's buffer as
    claim margins, `private`, and `open` (length, step and rooms from the service; the client; the
    closures; `customer: true`, judged once customers book in step 6);
  - `occupies` its room when the room is exclusive, with the buffer;
  - `states`: created booked (held while paying and not paid yet are the host's alone, steps 8 and
    9); a requested cancel resolved by the clock, in time (the session back) until "late from"
    and binding staff, late (the session kept, no fee) until the start; moved only by making the
    new one (`movedFrom`); attended and no-show from the start, corrected one into the other for 7
    days after the end; **excused** from a late cancel or a no-show only through the `humanOnly`
    `excuseAppointment` (decision 1: staff give it back); **cancelled by us** from booked, held or
    not paid only through the `personApproves` `cancelAppointmentByUs` or the host; and the host
    marks one nobody marked attended 30 minutes after its end (`states.after`);
  - `allowance` as a spender: booked spends; an in-time cancel, a move, an excuse and the
    business's cancel give back; `waived` for paid at the desk; `released` for a membership cooled
    off; `paidBy` Memberships' membership and pass;
  - the agreement point `appointment`.
- **Memberships' plans, memberships, pass types and passes say what they pay for**: `covers`
  (classes, one-to-one sessions; empty is classes only, as everything on file is) and `services`
  (empty: every one), copied onto what they grant. Their holders spend on two objects: bookings
  when they cover classes, appointments when they cover sessions and the service.
- **Two allowance conditions and one copy (platform, amends ADR 0493).** A condition may read a
  fixed word, `value`, in place of a spender field: what every record of the spender is (`{ value:
  "sessions", in: "covers" }`). `empty: "none"` makes an empty holder field allow nothing instead
  of anything. A spender's `copy` may read `<relation>.id`, the related record's own id, when it
  exists (`{ serviceId: "service.id" }`): the field stays host-filled, so no caller sets what pays.
- **The host chooses the room (amends ADR 0763).** A new record of an object booked at free times
  (`staffed.open.rooms` with `occupies`) that is live and names no room takes the first of its
  kind's rooms free for its time with the room's margins, an unclaimed room always being free; when
  none is, the write is refused `conflict`, `rule: "room_taken"`, naming nobody (`hostRoomFor`,
  `staffing/free.ts`, called by `createRecord`). The trigger still decides a race. A customer's
  create then meets the check with the room the host gave.
- **Booking a provider is not rostering (amends ADR 0626).** For an object booked at free times
  (`staffed.open`), the shift's person is not one of the fields only a rosterer may set: whoever may
  write the object (and the pack's tools' permissions) names the provider, with the warnings and the
  claim deciding the rest, **while the shift is still to come** (a create starting after now; an
  update before its stored start). Who gave one that has started or is over is counted for pay,
  so it stays a rosterer's (`assertMayRoster`). A coach profile's account and a series' person stay
  rosterers'. And **an AI's change of a booked shift's provider waits for a person on every path**:
  a `record.update` of it by the assistant, MCP, an automation or extension code is a person's
  field (`person-approves.ts`), unless it comes from a person's own tool of the record's extension
  (`humanOnly` or `personApproves` with a permission, ADR 0513: `reassignAppointment`), whose call
  was already a person's act or waited for one (the review of PR #452).
- **A used session never comes back by a change of time (the review of PR #452).** Platform, on
  the allowance's `movedFrom`: `fixed` names fields that change only by a move (a new record
  naming the old), never by an update, for every caller but the host (an appointment's start, end
  and service), refused `rule: "allowance"`, `reason: "moves_only"`; `anchor: { field, from }` is
  a read-only datetime the host sets at create, the moved record's anchor (or its start), else the
  record's own `from`. The appointment's late point is counted back from `lateAnchor`, so **a
  moved appointment keeps the original's late point** (the coordinator's decision): moved once
  late, cancelling the new one is late and keeps the session; moved earlier, it is in time until
  the original's late point. Staff still move until the start, as the spec says.
- **A client is required when it is made, not by the field** (`states.create.requires`, platform:
  fields every create must give, the host included). So `person.erase` keeps an appointment with
  its client cleared, for pay and the business's books, as a class booking's Person is cleared
  (ADR 0320), instead of deleting it.
- **A leaver's appointments** follow the spec's leaving section: future ones become uncovered (no
  coach) and the rosterers are told (ADR 0624). The host's 30-minute attended mark never marks one
  with no coach (`states.after[].ifSet`, platform: a timed move only while those fields have a
  value), so nobody is counted as having given a session they did not.
- **`bookings:desk` covers one-to-one sessions as well as classes**: booking, moving, cancelling
  and marking them, giving one back, and every coach's day with its clients. Its label says so.
  Nothing is installed anywhere yet, so no existing grant widens in the wild.
- **`bookings:appointments`**, grantable (ADR 0600), held by any member of staff, labelled for a
  coach who manages the others' sessions. The staff tools: `bookAppointment` (a coach, or the first
  qualified one free then through `staffing.free`; the end from the service's length; paid at the
  desk or from a holder), `moveAppointment`, `cancelAppointment`, `markAppointment` and
  `coachDay` (`bookings:desk` or `bookings:appointments`); `excuseAppointment` (a person, either);
  `cancelAppointmentByUs` and `reassignAppointment` (`bookings:appointments`, each waiting for a
  person when an AI asks). `coachDay` reads classes and appointments from Bookings' records and a
  coach's other shifts (duties) from `staffing.week`.
- **Memberships requires Bookings** (decided by the coordinator in the review of PR #452). Its
  relations to `bookings.service` need the object installed; a pack whose holders pay only for
  Bookings' records had little use without it. The cost: a host cannot have Memberships without
  Bookings (one that does could no longer upgrade Memberships), so revisit it if a business wants
  memberships with no bookings. The alternative not taken: services kept as a list of ids (a text
  or multi field) with `requires: ["programs"]`, losing the relation picker and needing a field
  type change later. `cos ext check` leaves out a sibling that requires the extension it checks
  (it is installed after it), so Bookings and Memberships each check from either side.

## Why
- Decision 1 is one state machine: a late cancel and a no-show keep the session because neither
  is a return state; a person's tool alone moves them to one.
- A pass's terms are the business's words, so what it pays for is a field of the pass, not of the
  service; the fixed word keeps classes and sessions apart without a second kind of holder, and
  `empty: "none"` keeps every pass already sold from paying for something it was never sold for.
- The room is a booking's detail, not a rule: the host choosing it keeps one answer for staff and,
  later, customers, while the claim stays the rule.
- ADR 0626 protects the roster from someone putting themselves on any shift; a session booked for
  a client is the client's choice of coach (decision 8), already bounded by qualifications as
  warnings and by the claim.

## Not in this step (the spec's later steps)
Members booking, moving and cancelling online, opening services and free times to the public, the
coach role's own appointments on any date, the confirmation, reminder, moved, reassigned and
cancelled-by-us emails (step 6 and 10); outside practitioners (7); paying per session (8);
standing appointments and the `unpaid` date (9); dashboards and views (10). Telling the client of
an uncovered appointment is the messages' step. Queued after the review: `hostRoomFor` reading
inside the write's batch, an AI's record writes under the balanced preset in general, and an
overlap check on a merge of People.

## Proof
- `apps/runner/test/bookings-appointments.test.ts` (the real host and sandbox, the shipped packs):
  an appointment over the coach's class refused and "any coach" booking the other; the buffer kept
  in the claim, back-to-back classes still allowed; two exclusive rooms given in order and the third
  refused, a class over a session refused; a profile with no account refused; a session pass
  paying for its service only, a class pass refused for a session (the test that fails when
  `empty: "none"` is removed), a session pass refused for a class, paid at the desk spending
  nothing; in time giving back, late keeping it, no other staff write giving it back, a person
  excusing it, the assistant refused; a no-show marked, corrected and excused; a move over its own
  old time carrying the session; a reassignment refused over a clash and made with a warning; the
  coach's day; the business's cancel giving back; with Rostering installed, a member booking a
  coach's appointment but still refused a class's coach (fails when the roster exemption is removed).
  After the review of PR #452: a retime and a change of service by `record.update` refused, for
  staff and an AI (fails when `fixed` is removed); moved when late, the new one's cancel is late and
  the session stays used, as an AI too; moved in time, cancelled in time; a create with no client
  refused, and erasing the client keeps the appointment; the host's attended mark 30 minutes after
  the end, and never on a leaver's uncovered appointment; with Rostering, a member refused a past
  session's coach and a started one's, a future one's changed, an AI's change waiting for a person,
  and `reassignAppointment` applied at once.
- `packs/bookings/test/appointments.test.ts` (`cos ext test`): the declarations and every tool.
- `packages/sdk/test/allowance-conditions.test.ts`: the condition forms and the id copy.
- `packages/core/test/staffing-free.test.ts`: a customer's create with no room gets the host's.
- `packages/extension-check/test/check.test.ts`: Bookings and Memberships each pass `cos ext check`.
