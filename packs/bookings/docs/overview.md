---
title: Bookings
summary: A gym's or studio's timetable and the bookings members make on it, with places, waitlists, spending a membership's uses, attendance and drop-ins.
stage: 31
spec: docs/stages/31-bookings.md
adrs: [0404, 0500, 0501, 0502, 0503, 0504, 0505, 0506, 0507, 0520, 0550, 0551, 0552, 0553, 0560, 0570, 0571, 0572, 0600, 0620, 0621, 0765]
---

## What it is for

Bookings runs a gym's or studio's classes from the host. Staff set a weekly timetable once and the
host makes each week's classes from it, with their coach, room and places. Members see the
timetable on the business's site and in its app, book a class with their membership or pass,
cancel it, and join a waitlist when it is full. Parents book their children. A visitor pays for a
single class on the web. Coaches see the day's classes and tick who came. The business's rules
(how far ahead a class may be booked, when booking closes, when a cancel is late, which class
types only staff book) hold for everyone: members, staff, the assistant and any API call.

It requires the [Programs](/packs/programs/) pack, whose class types it uses, and spends the uses
that [Memberships](/packs/memberships/) holds.

## Concepts

- **Class type**: Programs' kind of class (`programs.classtype`). Bookings adds its rules to it:
  how many days ahead it opens, when booking closes, when a cancel is late, whether only staff
  book it, and a drop-in price.
- **Series** (`bookings.series`): a class type on chosen weekdays at a local time, with its coach,
  room and places. The host makes its classes ahead of time.
- **Class** (`bookings.class`): one dated class, made by a series or by hand. It has places, a
  coach and a room.
- **Booking** (`bookings.booking`): one Person's place in one class. Its state says where it is:
  booked, waiting, held while paying, cancelled, cancelled late, attended, no-show, moved and the
  rest.
- **Closure** (`bookings.closure`): dates on which a series makes no classes.
- **Room** and **coach** (`bookings.room`, `bookings.coach`): where a class is and who coaches it.
  A coach is a staff account with a coach profile.
- **The coach role** (`bookings.coach`): a staff role that sees the day's classes and their lists
  and ticks names, and nothing else.

## How the pieces fit

Every rule is the host's, declared on the pack's objects as behaviours; the pack's tools compose
the host's operations and add no rules of their own.

- A series declares [`recurring`](/reference/behaviours/#recurring): the host makes its classes in
  local time across clock changes, never on a closure's dates, and never over what staff changed
  by hand on one class.
- A class declares [`capacity`](/reference/behaviours/#capacity) and a booking declares
  [`claims`](/reference/behaviours/#claims): a booking holds a place by its state, and the
  database refuses a booking past the places, for every writer. A full class has a waitlist.
- A booking declares [`unique`](/reference/behaviours/#unique) (one live booking per Person per
  class) and [`allowance`](/reference/behaviours/#allowance): entering `booked` spends a use of the
  Person's membership or pass, and an in-time cancel gives it back.
- The booking windows and staff-only class types are time windows on the booking's
  [`states`](/reference/behaviours/#states), read from the class type or, when it is empty, the
  business's setting.
- A booking declares [`agreements`](/reference/behaviours/#agreements): when the business has
  attached a document (a waiver, a health form) to the booking point, nobody books without having
  agreed to it. See [Agreements](/capabilities/agreements/).
- A class declares [`staffed`](/reference/behaviours/#staffed) (its coach's shift, shared with
  [Rostering](/packs/rostering/)) and [`occupies`](/reference/behaviours/#occupies) (a room that
  takes one class at a time is never double booked).
- Drop-ins use [`sellable`](/reference/behaviours/#sellable): the booking is held while its order
  is unpaid and booked when the payment is verified.
- Messages are automations that email members through the `email-send` gatekeeper on what the
  host did, as [routine mail](/packs/bookings/messages/) an admin can turn off.

## Main flows

1. **Set the timetable.** Staff make a series for each regular class; the host makes its classes
   ahead, at least as far as the longest booking window any class type sets.
2. **Book.** A member books from the timetable (`book`) within the class type's window. The host
   holds a place and spends a use; a member with nothing to spend is refused. Staff book a member
   or a walk-in (`bookFor`), optionally paid at the desk, which spends no use.
3. **Wait for a place.** In a full class, a member joins the waitlist, spending nothing. When a
   place is given back before the cut-off, the host moves the first waiter in and spends their use,
   or passes them over when nothing they hold can pay.
4. **Cancel.** A member's cancel (`cancel`) is resolved by the host's clock to cancelled (use given
   back) or cancelled late (use kept); the preview shows which before it is confirmed.
5. **Book for a child.** A parent with a family link books their child (`family`, `book`).
6. **Drop in.** A visitor, or a member with nothing to spend, pays for one class on the web
   (`buy`); a paid drop-in cancelled in time, or by the business, owes the money back, which a
   person approves.
7. **Take attendance.** From an hour before the class, a coach ticks who came (`day`, `roster`,
   `markAttended`, `markAll`). After the class, the host makes the bookings still booked no-shows,
   only when someone was ticked.
8. **Move or cancel.** Staff move a booking to another class (`move`) in one batch, or cancel a
   class (`cancelClass`, a person's act or a person's approval of an assistant's request), which
   cancels its bookings and gives their uses back.
9. **Tell people.** The host emails confirmations, waitlist news, changes, cancellations, a
   reminder before the class with an add-to-calendar file, and drop-in refunds; staff are told of
   a class whose list was not taken.

## What is built

Stage 31a's steps 3 to 9, as the code has them:

- the pack's objects, the timetable read and booking and cancelling within the windows;
- spending and giving back a membership's or pass's uses, and the waitlist with promotion;
- the family link (booking for a child);
- attendance, the coach role, no-shows, moving a booking and cancelling a class;
- drop-ins paid on the web, and their refunds through approval;
- the messages, the reminder with its calendar file, the dashboard, and the web and native
  blocks; the front desk and class list as staff screens in the admin;
- the class as its coach's shift (stage 45) and the room it occupies (stage 49);
- a section of the member's My account (stage 48): the timetable with their bookings and a linked
  child's, shown once they or the child have a booking.

Not in the code: `cos bookings import` (31a's step 10) and appointments booked by staff (31b,
now [stage 49](/planned/)).
