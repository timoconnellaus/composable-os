# ADR 0692: One person per folded address

Status: accepted, 2026-11-24 (stage 34, build step 2; decision 7 of the stage's interview; issue
[#225](https://github.com/timoconnellaus/composable-os/issues/225)). Amends ADRs
[0489](0489-one-free-trial-per-person-per-plan.md) (one free trial per Person per plan object) and
[0512](0512-one-per-person-and-tools-only-a-person-may-call.md) (things a Person may buy once).
Migration 0955. Spec: [stage 34](../stages/34-offers.md).

## Context
The one-per-Person rules count a Person record. Most mail services deliver `name+anything@` to
`name@`, so one person signing in as `name+1@` and then `name+2@` becomes two People, and each got
a free trial and an intro offer (ADR 0489 accepted this "until staff merge them"). The owner
decided that `name+1@` and `name+2@` count as the same person, so nobody gets a free trial, an
intro deal, a one-per-person code or a referral reward twice that way (decision 7). The sign-in
code limit already folds tags for counting sends (`mailboxKey`, ADR 0459), but only as a rate
limit key, and it also folds Gmail's dots, which the spec decided not to do here.

## Decision
**The folded address** is the address trimmed and lower-cased, with everything from the first
`+` of the local part to the `@` dropped, on every domain. Dots are not folded (`a.b@x` and
`ab@x` stay two, on Gmail too): a dot is part of the address on most services, and a wrong merge
of two real people costs one of them their trial. A `+` that starts the local part is kept.

**"The same person" is every live Person sharing a folded address.** For a Person P, the People a
one-per-Person rule counts are P and every live (not deleted) Person with an address whose folded
form is the folded form of one of P's live addresses (`samePeople` in `customers/accounts.ts`, a
subquery, so its bound values do not grow with the number of People). It is never an identity:
the Person, the customer account and the address mailed stay as typed, and nothing is merged.

**Kept by the database.** `core_person_emails.folded` (migration 0955) is written by triggers from
`email` on insert and update, so no writer of addresses has to know about it, with an index over
live rows. `foldAddress` is the same rule in code; a test holds the two together.

**Applied to the rules that exist now:**
- **Free trials** (ADR 0489): a trial used, a subscription opened with the plan's trial, an
  unreleased hold (asked of the provider as before) or a continuation, by any of the People,
  gives no trial (`used`, `held`, `continuation`). A page is still handed back only to whoever
  opened it, so `+2` never gets `+1`'s page. A confirmation that still comes through (a page that
  lapsed) tells staff of a second trial, as before.
- **Things sold once per Person** (ADR 0512): an order held or paid by any of the People refuses
  the line (`held`, `used`), for a signed-in customer and for staff buying for them alike; a late
  payment staff honour is refused when any of them has had one since.
- **Two starts at once**: as the unique index (one Person) and migration 0531's trigger (one
  Person) refuse a second hold, migration 0955's triggers refuse a hold while another Person
  sharing a folded address has one held or used on the same object (a trial: unreleased or used).
  The losing batch fails whole and its caller gets the same conflict as today.
- **The later steps of stage 34** (a per-person code's uses, the new-customer check, a referral's
  "the friend is not the member") read the same `samePeople`.

**A pass given by hand stays per Person.** A person on the staff giving an intro pass by hand
(ADR 0513, `memberships:passes`) is checked for that Person only, and the trigger does not refuse
it: it is a person's deliberate act, recorded with who gave it, and the override for a family that
shares one mailbox with tags (`parent+child@`). It still counts against the others.

## Consequences
- A family whose People share one mailbox by tags gets one trial and one intro offer between them,
  unless staff give the pass by hand. A trial has no override in this step: staff who mean to give
  a second one change that Person's address so it no longer folds with the other's.
- A domain that does not deliver tags to the bare address (rare) is folded anyway: two different
  people `a+1@` and `a+2@` there count as one. Accepted (the spec: "applies to every domain").
- A Person merged away no longer counts for anyone (its addresses are not live), but its rows move
  to the survivor (ADRs 0489, 0512), so nothing is lost.
- An erased Person's addresses and rows go with them (the cascade), as before.
- What a customer is told stays about "this person": the answer for `+2` when `+1` had the intro
  offer is "it has been bought for this person already". Only a signed-in customer (their address
  proved by a code) or staff ever get it; a guest is still refused with one answer for every
  address.
- Different addresses (`b@` for `a@`) and different cards are not caught here; stage 34's
  referrals add the card fingerprint, and caps per member limit the rest.
