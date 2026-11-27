---
title: "Bookings"
description: "A gym's or studio's timetable and the bookings members make on it, with places, waitlists, spending a membership's uses, attendance and drop-ins; and one-to-one appointments staff book."
sidebar:
  label: "Overview"
  order: 0
editUrl: false
---

A gym's or studio's timetable and the bookings members make on it, with places, waitlists, spending a membership's uses, attendance and drop-ins; and one-to-one appointments staff book.


## What it is for

Bookings runs a gym's or studio's classes from the host. Staff set a weekly timetable once and the
host makes each week's classes from it, with their coach, room and places. Members see the
timetable on the business's site and in its app, book a class with their membership or pass,
cancel it, and join a waitlist when it is full. Parents book their children. A visitor pays for a
single class on the web. Coaches see the day's classes and tick who came. The business's rules
(how far ahead a class may be booked, when booking closes, when a cancel is late, which class
types only staff book) hold for everyone: members, staff, the assistant and any API call.

It also runs one-to-one sessions (appointments): the business's kinds of session (a 60-minute
personal training session), booked by staff for a client with one of its coaches, paid from a pass
that covers sessions or at the desk. A coach is never booked into a session over a class, a duty
or another session, and a private room is never taken twice.

It requires no other pack: its class types are its own. It spends the uses that
[Memberships](/packs/memberships/) holds, when that pack is installed. The Programs pack, a gym's
training, requires Bookings and assigns its class programs to Bookings' class types.

## Concepts

- **Class type** (`bookings.classtype`): a kind of class (Strength, Yoga, Kids), with its name,
  order and colour, and its own rules when they differ from the organisation's: how many days
  ahead it opens, when booking closes, when a cancel is late, when the waitlist stops, when the
  reminder goes, whether only staff book it, a drop-in price, and the set-up and pack-down
  minutes counted in its coach's pay.
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
- **Service** (`bookings.service`): a kind of one-to-one session: its length, a buffer before and
  after, the rooms it may use in order, the step its start times keep, and its own booking rules
  when they differ from the business's. Who gives it is a qualification (Rostering's), not a list
  on the service.
- **Appointment** (`bookings.appointment`): one booked session: a client, a coach, a service, a
  start and an end, and the room it takes. Its state is booked, cancelled, cancelled late, moved,
  attended, no-show, excused (a late cancel or no-show given back) or cancelled by the business.

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
- An appointment declares [`staffed`](/reference/behaviours/#staffed) too, with the service's
  buffer in its coach's time and a coach with a staff account required; the roster and the
  calendar feed show it as its service, never the client. It
  [`occupies`](/reference/behaviours/#occupies) its room (with the buffer), which the host chooses
  when staff name none: the first of the service's rooms free then. It spends a use of a pass or
  membership that pays for sessions and covers its service ([`allowance`](/reference/behaviours/#allowance)),
  unless booked paid at the desk. A cancel from "late from" (24 hours before unless the service
  says otherwise) is late and keeps the session, with no fee, as a no-show does; only a person
  excuses either, giving it back. 30 minutes after it ends the host marks one nobody marked as
  attended.
- Messages are automations that email members through the `email-send` gatekeeper on what the
  host did, as [routine mail](/packs/bookings/messages/) an admin can turn off.
- **Feedback after a class** is routine mail too (`feedback`, a follow-up a member can stop with
  one tap): a few hours after a member is ticked as come (`feedbackMinutes`, 3 hours by default),
  when a Forms form answered by personal link is chosen (`feedbackForm`, its address), the host
  emails a personal link to it, made for the booking's Person about that booking, good for a week. The host sends it at most
  once a month to a member, never to a child's own address (their parents or guardians get it),
  and never to someone who stopped follow-ups; the same link is the member's Needs your attention
  item, and the answer is tied to the booking. It needs the Forms pack, the business's site and
  Bookings' routine email turned on: an email with a personal link is never sent for approval.

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
5. **Book for a child.** A parent with a family link books their child (`me.family`, `book`).
6. **Drop in.** A visitor, or a member with nothing to spend, pays for one class on the web
   (`buy`); a paid drop-in cancelled in time, or by the business, owes the money back, which a
   person approves.
7. **Take attendance.** From an hour before the class, a coach ticks who came (`day`, `roster`,
   `markAttended`, `markAll`). After the class, the host makes the bookings still booked no-shows,
   only when someone was ticked.
8. **Move or cancel.** Staff move a booking to another class (`move`) in one batch, or cancel a
   class (`cancelClass`, a person's act or a person's approval of an assistant's request), which
   cancels its bookings and gives their uses back.
9. **Book a session for a client.** Staff book an appointment (`bookAppointment`) with a coach,
   or with whichever qualified coach is free then; the host refuses a clash and says what it was
   made with (the coach away, not qualified, outside their open hours, the client busy). Staff
   move it (`moveAppointment`, the session moving with it), cancel it (`cancelAppointment`, in time
   or late by the clock), mark it attended or a no-show (`markAppointment`), excuse a late cancel
   or no-show (`excuseAppointment`, a person only), give it to another coach
   (`reassignAppointment`), or cancel it for the business (`cancelAppointmentByUs`, a person's
   act); the coaches' day (`coachDay`) lists each coach's classes, appointments and duties.
10. **Tell people.** The host emails confirmations, waitlist news, changes, cancellations, a
   reminder before the class with an add-to-calendar file, and drop-in refunds; staff are told of
   a class whose list was not taken.
11. **Ask for feedback.** Choose a Forms form in the settings; members ticked as come are asked
   by email (`feedbackAfterClass`) and in the app, and answer once by their personal link.

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
  child's, shown once they or the child have a booking, where a parent books and cancels for the
  child; the blocks read who they act for from the host's `me.family` (the `family` tool stays
  for the API);
- appointments booked by staff (stage 49's step 5): services, appointments and their states,
  paying from a pass or at the desk, late cancels and no-shows with no fee, excusing, moving,
  reassigning and the coaches' day, under `bookings:desk` or the grantable
  `bookings:appointments`;
- feedback after a class by a personal link to a Forms form (stage 29's step 5).

Not in the code: `cos bookings import` (31a's step 10), and members booking appointments
themselves, appointment emails, outside practitioners, paying per session and standing
appointments ([stage 49](/planned/)'s later steps).


## Reference

Generated from the code:

- [Data model](/packs/bookings/data-model/)
- [Operations and tools](/packs/bookings/tools/)
- [Permissions and roles](/packs/bookings/permissions/)
- [Screens](/packs/bookings/screens/)
- [Messages](/packs/bookings/messages/)
- [Settings](/packs/bookings/settings/)
- [Decisions](/packs/bookings/decisions/)

The specification is stage 31's, [31-bookings.md](https://github.com/timoconnellaus/composable-os/blob/main/docs/stages/31-bookings.md).

This page is [bookings/docs/overview.md](https://github.com/timoconnellaus/composable-os/blob/main/packs/bookings/docs/overview.md), written by hand beside the code.
