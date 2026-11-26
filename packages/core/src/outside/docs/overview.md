---
id: outside
title: Booking system copy
summary: The host's read-only copy of a business's booking system, loaded as lists, matched to People by address and never merged.
stage: 65
spec: docs/stages/65-booking-system-connection.md
adrs: [0920, 0921, 0922, 0926]
operations: [outside.]
---

## What it is for

A business that keeps its booking system for a while still wants the new system to know who its
members are. The booking system's data reaches the host as **lists** read through the read-only
booking-system contract: a `members` list (people with their memberships and passes) and a
`timetable` list (classes, their bookings and their coaches). The host keeps a copy of each and
never writes anything back.

It is a core capability, not a pack: several packs read who is a member, and what is kept, who is
linked and what a customer may see are rules of the host.

## Concepts

- **List**: one load of one kind, with the date its file was exported. A load replaces the copy of
  its kind. A `members` list older than the largest age (31 days by default) is "too old to count".
- **Outside person**, **outside membership**, **outside class**, **outside booking**, **outside
  staff**: the copies. An outside person is kept only while they are a member, hold a live pass,
  are booked in the timetable, or are linked by staff. No phone, postal address, birth date, card
  or note is kept.
- **Linked (by address)**: an outside person matched to the one live Person holding the same
  address (`+tags` dropped). Nothing on the Person changes; their timeline gets one line. When two
  Persons, or two outside people, share an address, nobody is linked and they wait in **To match**.
  Someone who gets the address later (a sign-up, an import, a restore, staff) is linked then.
- **Linked by hand**: a person with `bookingSystem:manage` links an outside person to a Person, or
  a coach to a staff account, with why; or says "nobody here". Both hold across loads.
- **Suppressed**: the refs and addresses of an erased Person's own outside rows, kept as hashes
  keyed with the deployment's salt, never the values. No later list keeps anything they name, and
  nobody can link them by hand, until an admin allows the address back on consent or a person
  lifts a ref the booking system gave to someone new (it needs records:erase too). A plus-tag or
  dotted spelling of an erased address is the same address to the matching, a different one to
  mail sync's erased-address list.

## How the pieces fit

- `outside/ingest.ts` reads any booking-system session (the file source, the fake, a system
  connected later) and plans one batch that replaces the copy of a kind, written set based within
  D1's limits.
- `outside/match.ts` holds the host's side of matching: which live Persons and staff accounts hold
  an address, the erased-address list and the suppressed refs, and the links already held. The
  rules themselves are the contract package's `matchPeople`.
- `outside/erase.ts` is how an erase, a merge and a purge reach the copy; `outside/remove.ts`
  plans a list's removal in bounded passes.
- `operations/outside.ts` is how anything reads or changes the copy.

## Main flows

1. A list is read through the contract and planned: who is kept and why, who links, who waits.
   The batch replaces the copy of that kind and adds one timeline line per Person linked.
2. A Person is created, given an address, restored or imported: an unlinked outside person with
   that address is linked then, or waits if another Person holds it too.
3. Staff open To match (`outside.matches`) and link (`outside.link`) or say "nobody here"
   (`outside.unlink`), with why.
4. `outside.status` shows each list's date, its age, and whether it still counts.
5. A Person is erased (`person.erase`): rows linked to them go, and rows linked to nobody on an
   address only they hold (a household's unmatched copies), and coaches on their address with no
   staff account, with their memberships, passes, bookings and To match. Their addresses are
   suppressed unless someone else holds one; refs and names only of the rows linked to them. A row
   linked to anyone else, or waiting because another Person holds the address, stays. The result
   always says what happened, and that a copy remains in the booking system.
6. Two People are merged: links move to the survivor, and someone who waited only because the two
   were two People is linked to the survivor. A purge drops a purged Person's links.
7. A person removes a list, or both (`outside.lists.remove`): it stops counting at once and its
   rows go, in passes; a copy bigger than one call's is finished by the daily maintenance. Settings,
   suppressions, unlink decisions, the lists' log and the timeline stay.

## Who may do what

- `bookingSystem:manage` (admins, grantable one by one, never to a pack's fixed role) reads the
  lists' state, To match and the settings. Linking, unlinking and removing a list are a person's
  only, never an AI's, an MCP client's, an extension's or an automation's.
- The settings (on or off, which types make a member, the two links, the largest age) are a human
  admin's (`settings:manage`).
- The copy is in no `rec_*` view: no SQL, export, search, dashboard or AI record read reaches it.

## What is built

The tables, the settings, the lists' ages, the ingest plan, matching and linking by hand, erase,
merge, purge and removal, and the operations above. Loading a list from a file and the screens are
not built yet.
