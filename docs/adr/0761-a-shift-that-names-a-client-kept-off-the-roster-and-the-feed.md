# ADR 0761: A shift that names a client, kept off the roster and the feed

Status: accepted, 2026-11-24 (stage 49, build step 1). Amends
[ADR 0626](0626-the-rostering-pack-and-bookings-additions.md) (the roster read) and
[ADR 0628](0628-the-staff-calendar-feed-and-the-shared-calendar-writer.md) (the feed), and
[ADR 0623](0623-offers-and-takes-the-race-and-the-cut-off.md) (offers). Stage 49's spec named this
piece in its ADR "0764"; it is written here, in the numbers given to step 1.

## Context
An appointment is a shift whose title is naturally its client ("Personal training: Sam"). The
roster (`staffing.week`) is read by every team member through Rostering's grant, and shows each
shift's title; a double-booking's answer names the other shift by its title, to whoever writes;
an offer is sent to every eligible colleague with the shift's title. An appointment's client
would leak to all of them. The calendar feed is a bearer link that a calendar app polls, so it
must carry no client names at all.

## Decision
- **`staffed.private: true`** says a shift's title may name a client. Then:
  - **The roster** shows its kind's name (the service) as its title to anyone but its own person
    (the provider) and those who roster (admins and rosterers, ADR 0625), who see the title. The
    shift is still on the roster for everyone, with its times, place and person: a colleague sees
    the coach is busy with an assessment, never with whom.
  - **A clash answer** (`double_booked`'s `other`, `staffing.check`'s clash, a series date left
    uncovered) names a private shift by its kind, whoever is answered: a member booking online in
    a later step must never learn another client's name from a refusal.
  - **It is never offered** (`staffing.offer` answers `conflict`, `rule: "offer_private"`): an
    offer shows the shift to others, and a client chose their coach (stage 49 decision 7: a
    rosterer reassigns it).
- **The feed needs nothing new.** It already shows each shift as its kind, its place and its
  times, never a title (ADR 0628), so it carries no client names for any shift.
- The notices to a shift's own person (put on, taken off, moved) keep its title: they go to the
  provider. Notices to rosterers keep it too.

## Consequences
- Appointments (step 5) declare `private: true`; classes and duties do not, and look as before.
- Whoever may read the record itself (staff with Bookings' record permissions) still sees its
  title there: this hides the client from the roster, the feed and other people's answers, not
  from the business's own records.
- Not here: the coach role's reach to its own shifts beyond today (step 6, ADR 0553 amended) and
  a practitioner's own day (step 7).
