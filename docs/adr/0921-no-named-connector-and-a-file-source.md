# ADR 0921: No named connector, and a file source first for a business's booking system

Status: accepted, 2026-11-24 (stage 65, step 2; the owner's change of decisions 4 and 5 the same
day). Keeps the owner's rule of 2026-11-22 recorded in `scripts/check-stray-names.mjs`. Builds on
ADRs [0400](0400-a-general-host-and-products.md) (the stray-names lint),
[0020](0020-query-sql-validator-and-csv-import.md) (the stateless CSV import) and
[0880](0880-the-accounting-contract.md) (a contract, a fake, a conformance suite). Spec:
[stage 65](../stages/65-booking-system-connection.md).

## Context

The repository is public. On 2026-11-22 the owner decided it names none of a client's suppliers,
and the stray-names lint fails on the booking system's, the course platform's and the CMS's names
in every file but the lint and its tests. Read beside what a business is doing (keeping its booking
system for months, then leaving it), a supplier's name says who the business is.

Stage 65's spec, as first agreed, planned an API connector for the first client's booking system,
named in its package, its ADR, the spec, the integrations guide, the catalogue and the site. Its
pull request added an exception to the lint for the spec. The same day the owner found that the
system's developer terms bar use of its API in a product that competes with it. No connector for it
will be built.

## Decision

**No named connector.** The repository names no booking system. The lint's rule for the booking
system is allowed only in `scripts/check-stray-names.mjs` and its tests, as on 2026-11-22. The
exception for stage 65's spec is removed, and the spec names no outside product. The tests build
the name from parts, so no tracked file spells it. The course platform and CMS rules are unchanged.

**No API connection to the first client's booking system; a file first.** A business exports a list
from its own booking system and a member of staff with `bookingSystem:manage` loads it: map the
columns, see a dry run, load. Never an AI. A load replaces the list of its kind. A loaded list is as
old as its file: it carries its export date, every screen shows it, and a members' list stops
counting for members' prices and programs once it is older than the largest age (31 days by
default).

**The generic read-only contract stays.** `BookingSystemSession` (ADR 0920) is still the one seam.
The file source answers it as a pure session over the loaded rows, so the core copy, the matching
and stage 33's move are the same for a file and for any system connected later. A system whose terms
allow an API connection can be connected later, as its own gatekeeper in its own stage.

## Consequences

- Members' prices, a members' program, Your membership and the read-only timetable come from a list
  as old as its file, not from reads every hour. The date is always shown, and the largest age
  bounds how stale a membership can be.
- The spec's API-only parts are gone: webhooks as hints, hourly and nightly passes, the monthly call
  budget, the host-only rule for a booking-system connection and the named connector's steps. They
  come back, for a system that allows them, in that system's own stage.
- Whether a business may export and use its own data this way is set by its booking system's terms.
  The load screen says so and the business confirms it. That is not something code decides.
- The repository's history still holds the name in the commits of the spec's first pull request.
  Removing it from history would need a rewrite of `main`, which this repository does not do. Only
  the files on `main` are kept clean.
