# ADR 0910: Locations, a base record inside the one organisation

Status: accepted, 2026-11-24 (stage 64, step 1). Amends ADRs
[0001](0001-self-hosted-single-org.md) and [0610](0610-three-homes-for-a-client-hosted-by-default.md)
with dated notes. Builds on ADRs [0444](0444-media-the-editor-and-the-content-pack.md) (a base record with its
own operations, as media is) and [0460](0460-time-zones-on-records.md) (a record's own zone).
Spec: [stage 64](../stages/64-multi-location.md).

## Context

A gym with a second studio across town wants one member list, one sign-in and one membership, with
each studio's timetable, rooms, staff and reports kept apart. The owner chose one system for every
location (stage 64, decision 1). Separate hosts stay the answer for franchises, where each location
has a different owner. Bookings, Rostering and Memberships each need to name a location, and none
of them depends on the others, so the location cannot belong to one of them.

## Decision

**A location is a base record in core** (`location`, `core_location`, migration 1390), with its own
`location.*` operations, beside orders and media in the registry's base objects. It is a record
inside the one organisation, never a tenant: nothing is keyed by it, and ADR 0001's "no tenant id"
stands.

Its fields: `name` (required, unique whatever the case), `shortName` (at most 16 characters, for a
badge), `address` (the business's, not personal data), `timezone` (required, the organisation's by
default), `public` (shown on the website and in the app, yes by default), `dropInPrice` (minor units,
empty: not set), `state` (`open` or `closed`) and `notes` (staff only).

**Every host has one location from the start, the main location.** Migration 1390 makes it from
the organisation's name and zone (`org_name`, `org_timezone`), or "Main location" in UTC on a host
whose setup wizard has not run. Every statement of the migration runs again without change. The
main location is the row with `main = 1`, with the id `loc_00000000000000000000000001` (a ULID of
time zero, so it sorts first); the database refuses changing which row is main. Its zone is the
organisation's: `settings.update` changes both, and `location.update` refuses a zone for the main
location. Its name follows the organisation's while it still has the one it was given (the earlier
organisation name, or the fallback) and no other location has the new one; a main location renamed
apart keeps its own name.

**Open and closed.** `location.close` and `location.reopen` are a person's only (`actors: ["human"]`,
not on MCP), with `settings:manage`. Closing does not cancel what is already made there. The last
open location cannot be closed: the handler says so, and a trigger on `core_location` refuses it for
every writer, so two closes at once of the last two open locations leave one open. Nothing deletes a
location.

**Operations.** `location.list` and `location.get` (any staff with `records:read`; the list is one
page, the main location first, and a host has at most 100 locations); `location.create` and
`location.update` (`settings:manage`; an AI's call always waits for a person, `alwaysReview` for the
assistant and MCP, because a location's name, zone, price and whether it is shown change what members
see). Every write is audited as a change of `location`.

## Consequences

- Later steps relate packs' objects to `location` (the `located` declaration, step 2), read its zone
  as the default zone of what is located there, and read its drop-in price in the price chain.
- `location.create` gains the coverage choices for plans and pass types when `covers` exists
  (step 4); until then nothing declares coverage, so it takes none.
- A pack-role account (a coach, the door) does not reach `location.list` yet: what a limited account
  reads of locations is the staff-limit step's (step 5).
- With one location nothing changes for a single-site business: no screen shows a location yet.
