# ADR 0916: Public reads of locations

Status: accepted, 2026-11-24 (stage 64, step 1). An opening to the public under ADR
[0402](0402-staff-and-customers.md), through the public declaration of ADR
[0438](0438-the-public-scope.md). Spec: [stage 64](../stages/64-multi-location.md).

## Context

A member choosing where to train, and a visitor reading the timetable, need to know the business's
locations: a name, a short name for a badge, an address and the zone its times are in. A hidden
location (one being set up) and a closed one are not to be shown. A location's drop-in price, its
notes and its state are staff's.

## Decision

**`location` declares what the public may read**: `name`, `shortName`, `address` and `timezone`,
of the locations that are shown to the public and open. Nothing else of a location reaches the
public or a customer, and a hidden or closed location is not found, exactly as one that does not
exist.

The seam's public scope tests one select field. The two conditions are one column of the
`rec_location` view, `listed` (`yes` when `public = 1` and `state = 'open'`), a read-only field of
the registry. So the seam's `when` holds both, enforced at the one seam (ADR 0244) like any other
object's, with no change to the seam.

**The public reaches locations as it reaches any record**: through `public.list` and `public.get`,
which are tool-only, from a pack's tool the public or a customer calls (Bookings' timetable, stage 64
later steps). No new operation is opened, so `open-operations.json` does not change. The location
operations themselves are staff only.

## Consequences

- A test reads locations as the public through a tool and gets only the listed ones, with only the
  four fields.
- A customer reads the same as the public: `location` declares no customer.
- Showing more of a location to the public (its opening hours, a picture) is a change to this
  declaration, reviewed as an opening.
