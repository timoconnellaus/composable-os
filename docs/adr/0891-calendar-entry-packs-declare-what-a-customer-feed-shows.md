# ADR 0891: `calendarEntry`: packs declare what appears in a customer's feed

Status: accepted, 2026-11-24 (stage 62, build step 1). Builds on
[ADR 0402](0402-staff-and-customers.md) (an object's customer), [ADR 0438](0438-the-public-scope.md)
(what the public reads), [ADR 0439](0439-what-a-customer-reads-through-their-own-records.md) (what a customer reads through their own
records), [ADR 0540](0540-the-family-link.md) (guardians) and
[ADR 0890](0890-the-customer-calendar-feed-and-the-shared-feed-module.md) (the feed).

## Context
The customer's calendar feed must show class bookings, appointments, event tickets and whatever a
later pack books, without core knowing any of them. Hard-coding classes would need a core change
per pack. The feed must also never show a field the customer could not read in the app: a class's
title may name another member, a room has a door code.

## Decision
- **A manifest key on an object**, `calendarEntry`:
  ```ts
  calendarEntry: {
    starts: "klass.startsAt",   // a datetime path
    ends: "klass.endsAt",
    title: "kind.name",         // a text or select path
    place?: "klass.room.name",  // the same
    live: ["booked", "attended"],
  }
  ```
  A path is a field of the object, or up to two relations and a field. A record in a `live` state
  of the object's `states`, out of the Trash, is an event; leaving the live states drops it.
- **The contract** (`packages/sdk/src/calendar-entry.ts`, run by `cos ext check` and install):
  the object declares a `customer`; its customer's read list holds the states field and each
  path's first field; every later field is one the customer reads of that object: its `public`
  or `signedIn` read, or, one relation away, its `customerVia` read from this object (what the
  seam's `via` scope reaches); a path never passes through another object that declares a
  customer; `starts`, `ends` end at a datetime, `title`, `place` at text or a select (shown by its
  label). The SDK checks a path as far as the pack's own objects; a path into another pack's
  object (a booking's class type in Programs) is checked by the host against the registry with the
  same walker (`packages/core/src/customers/calendar-entry-check.ts`).
- **Shipped packs only.** A runtime extension declaring it fails the check (`outside_audience`),
  as `customer`, `public` and `screens` do; and the feed reads only objects of installed, active,
  shipped extensions.
- **Read as the customer.** The host never trusts the check alone: the feed compiles each path
  against `visibleObject` and joins `visibleSource` for every object on the way, as that customer,
  so a field the seam does not give them is not in the query at all, and an object whose path
  names one is skipped (fails closed). Whose record it is comes from the seam too
  (`ownReadSource`: their own Person's and a live dependant's, never one only shared with every
  signed-in customer).
- **A declared read, not a behaviour.** It hooks no write and keeps no table; nothing is copied
  into the feed. Packs declare it in step 2 (Bookings on bookings and appointments, Ticketing on
  tickets).

## Why
Each pack knows which of its records are a customer's appointments; the host knows what a customer
may read. A declaration lets a pack add itself to the feed while the seam keeps the feed inside
what the app already shows the customer.

## Consequences
- An object without a `customer` cannot be in a feed: who it belongs to is the customer field.
- A pack that wants a field shown must first make it readable (public, signedIn or customerVia),
  which is itself a reviewed change.
- Times are compared in SQL as instants (`strftime('%s', …)`), so a value written with an offset
  is placed correctly; the index on the time is not used, but the read starts from the customer's
  own records.

## Proof
`packages/sdk/test/calendar-entry.test.ts` (the contract inside one pack);
`packages/core/test/customer-calendar-feed.test.ts` (refused to a runtime extension, a path into
another pack, what the feed reads through the seam).
