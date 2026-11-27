---
title: Memberships
summary: What a gym sells its members, membership plans paid every month and passes bought once, and the classes and one-to-one sessions each pays for.
stage: 32
spec: docs/stages/32-memberships.md
adrs: [0485, 0487, 0489, 0493, 0494, 0510, 0511, 0512, 0513, 0530, 0531, 0532, 0647, 0764, 0980]
---

## What it is for

Memberships is what a gym or studio sells its members. A **membership plan** is paid every month
(unlimited classes, or a number a week or a month); a **pass type** is bought once (a pack of ten
classes that expires, a drop-in as a pass of one, an intro offer once per person, ten personal
training sessions). What a member holds, a membership or a pass, pays for their bookings in the
[Bookings](/packs/bookings/) pack: its classes, and its one-to-one sessions when it says it pays
for them. The limits (how many uses, which class types or services, which days and times) are
refused by the host for every writer, never by a screen.

It requires Bookings: the class types and services a plan names, and what it pays for, are
Bookings'. It needs no Programs.

## Concepts

- **Plan** (`memberships.plan`): a membership paid every month, with its uses per week or month
  (empty: unlimited), what it pays for, a free trial and how long staff may pause it.
- **Membership** (`memberships.membership`): a member's membership, granted by the host when their
  subscription to a plan starts and moved with it (on trial, active, past due, paused, ended).
- **Pass type** (`memberships.passtype`): a pass bought once, with its uses, how long it lasts and
  whether it is an intro offer.
- **Pass** (`memberships.pass`): a member's pass, granted by a paid order or given by staff.
- **What it pays for**: classes, one-to-one sessions, or both (empty: classes only); the class
  types and the services it covers (empty: every one); the days and times of day it allows. Each
  is copied from the plan or pass type onto what it grants, and nobody but the host changes it.

## How the pieces fit

- Plans and pass types declare [`sellable`](/reference/behaviours/#sellable): a plan with
  recurring billing whose subscription grants a membership (`recurring.grants`), with pauses,
  plan changes and cooling off; a pass type whose paid line grants a pass with its expiry, one per
  person for an intro offer.
- Memberships and passes declare [`allowance`](/reference/behaviours/#allowance) as holders: a
  Bookings booking spends a use when it is booked, and an appointment does when the holder pays
  for sessions and covers its service. The database refuses a spend past the limit, for every
  actor.
- Buying asks the agreement point `membership` ([Agreements](/capabilities/agreements/)).

## Main flows

1. **Sell a plan or a pass.** A member buys on the web (`plans`, `passTypes`, `buy`); a verified
   payment grants the membership or the pass.
2. **Spend it.** Booking a class, or staff booking a one-to-one session for a client, spends a
   use from the holder whose use would lapse first; a cancel in time gives it back.
3. **See what is left.** A member reads their own and a linked child's (`mine`); staff read a
   person's (`holdings`).
4. **Give or void a pass by hand.** A person on the staff with `memberships:passes` gives a pass
   (`givePass`, with what its type pays for) or voids one (`voidPass`).
5. **Change, pause or cool off a membership.** A member upgrades or downgrades; staff pause it for
   a set time; a new member ends it within the cooling-off days for a refund a person approves.

## What is built

Stage 32b's steps 5 to 7, as the code has them: plans, memberships, pass types and passes, buying
and granting, spending by Bookings' bookings, plan changes, pauses, cooling off, the dashboard,
views, blocks and the section of My account. The section (`memberships-mine`) shows the member's
memberships and passes and each linked child's under the child's name, and their membership
subscriptions through My account's one subscriptions part (cancel, keep it going, change plan,
cool off); the card is My account's Payment method section, not this one. Since stage 49's step 5, plans and pass types say
whether they pay for classes, one-to-one sessions or both, and which services, and Bookings'
appointments spend them. Not in the code: showing members what a pass pays for in sessions
(stage 49's step 6), and the memberships import.
