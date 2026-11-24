# ADR 0920: The booking-system contract: one read-only session, no outbound action, a Worker per system, a shared fake and conformance suite

Status: accepted, 2026-11-24 (stage 65 build, step 1). Builds on ADRs
[0007](0007-integrations-are-gatekeepers.md), [0050](0050-integration-host-and-connections.md),
[0114](0114-own-gatekeepers-pickers-and-host-modules.md) and
[0880](0880-the-accounting-contract.md) (the accounting contract, whose shape this copies). Spec:
[stage 65](../stages/65-booking-system-connection.md).

## Context
Stage 65 reads a business's members, memberships, timetable and bookings from the booking system it
keeps for a while, beside the new system. Core must never name a booking system, and nothing may
ever be written back (decision 2). Each booking system has its own key, staff sign-in, call limits
and terms, so each is its own gatekeeper Worker, as each accounting system is (ADR 0880).

## Decision

**One contract, `BookingSystemSession`, in `packages/gatekeeper-booking-system`.** Every method
is a read, recorded as an observation: `describeSite` (name, IANA time zone, locations, what the
system offers: `modifiedSince` for people and for classes, hints by webhooks or none, the largest
page; and this month's calls: used, by method, and the budget), `listPeople` (paged; by
`modifiedSince` or by at most 200 refs), `listMembershipTypes`, `listMemberships` (for 1 to 200
people), `listClassTypes`, `listClasses` (paged; a window of at most 35 days, and
`modifiedSince`), `listBookings` (for 1 to 50 classes), `listStaff`, `listVisits` (one person's
past bookings in their final states, paged, at most 366 days; for stage 33, never synced) and
`takeHints` (1 to 100 hints, each taken once). Times are ISO 8601 with an offset, dates
`YYYY-MM-DD`. Each item carries the system's `ref`, stable for the life of the record. A page is
`{ items, cursor }`, `cursor: null` on the last.

**What may leave the gatekeeper is the contract's shape and nothing else.** The shared reads
(`reads.ts`, `checkedReads`) check every input by hand (ADR 0114) and copy every answer key by key
into the contract's shape (`validate.ts`, `CONTRACT_KEYS`), cutting any text at 500 characters,
and answer memberships, bookings and visits only for the people and classes asked. Whatever a
system's API returns about a person (a postal address, a phone, a birth date, a card, notes), no
gatekeeper built on the package can pass it on. A person is a ref, an address, a given and family
name, the system's member status mapped (`member`, `not_member`, `suspended`, `expired`, `ended`,
`declined`), active, and `modifiedAt`; staff are a display name, an address where given, and
active.

**No write of any kind.** The session serves exactly these ten methods
(`BOOKING_SYSTEM_SESSION_METHODS`). The facet (`session.ts`, `BookingSystemGatekeeper`) declares
no action kind (`getAutoApprovableActions` answers none), journals nothing, and refuses
`applyAction`, `rejectAction` and `revertAction`: there is nothing to submit, approve or take
back. The conformance suite fails a gatekeeper that declares an action or offers a write.

**Refusals carry a reason code** at the front of the message, `[booking-system:<code>] `:
`unauthorised`, `not_activated`, `rate_limited`, `over_budget`, `unavailable`, `invalid`.
`rate_limited` and `unavailable` are transient (`TRANSIENT_REFUSALS`); `unauthorised` and
`not_activated` mean the connection no longer reaches the site (`EXPIRING_REFUSALS`), which the
host turns into an expired connection (step 3). A read refused by its input check is refused
before it is observed or reaches the system.

**Calls are counted by the gatekeeper.** A system counts every call it makes to its API, by
method, failed ones too; a rate-limited call and one refused over budget are not counted. Over the
month's budget every read is refused `over_budget`, but `describeSite` still answers (from what
the gatekeeper holds), so the host can always show the counter. Taking hints is not a call: they
arrived as webhooks and are held by the gatekeeper. A hint names what to read again, never the
data: a person, a membership's person, a class, a booking's class, a staff member, or the site.

**A Worker per system.** Each booking system is its own gatekeeper Worker,
`packages/gatekeeper-booking-system-<system>`, with its own secrets, installed only where it is
used, implementing `BookingSystem` (`system.ts`) and extending `BookingSystemGatekeeper`; the
catalogue marks it `implements: "booking-system"`. Core imports the contract's types, codes and
checks from `@composable-os/gatekeeper-booking-system` and never names a system.

**A fake and a conformance suite every implementation passes.** `FakeBookingSystem` (`fake.ts`)
keeps an invented site (people at `example.com`, one with no address; live, paused, ended and
cancelled memberships and passes; two classes a day for 7 days back and 28 ahead, with bookings;
staff) in one plain state object, on a clock of its own. A test can change any record (which
records a hint), revoke the key or leave the site not activated, make the next call fail with any
code, spend or set the budget, move the clock (the count starts again when the month turns), give
two people one address, and read its own count of calls. `conformance.ts` (`CONFORMANCE_CHECKS`,
`runConformance`) checks every read: paging to the end with each ref once, `modifiedSince`
answering what changed and nothing older (and refused where not offered), refs stable across
reads, the 200-people, 50-classes, 35-day and 366-day limits, hints taken once (none without
them), no action declared and no write, every refusal code, a revoked key and a site not activated,
over budget, two people on one address, every item's keys exactly the contract's, and the call
counter matching the fake's own count. It runs against the fake in memory (`directSession`), the
fake gatekeeper through its session, and, by hand, a real system's sandbox site; it writes nothing,
but spends calls. Checks that need the fake's controls are skipped without them.

**The fake gatekeeper is never released.** `cos-gatekeeper-booking-system-fake` (vendor
`booking-system-fake`, catalogue `devOnly`) has its config in `wrangler.fake.jsonc`, which no
release reads; only the CRM's dev server and cos-runner's tests run it, bound as
`GATEKEEPER_BOOKING_SYSTEM_FAKE` (and its controls as `TEST_BOOKING_SYSTEM` in tests). Each
resource, `booking-system-fake://site/<name>`, is its own site in its own Durable Object.

## Consequences
- Every answer is copied once more inside the gatekeeper. The pages are small (a few hundred
  items), so the cost is nothing beside the call.
- The contract's limits (200 people, 50 classes, 35 days) are the host's, not a system's: a
  connector whose API takes fewer splits the read into several calls, each counted.
- `describeSite` may answer from what the gatekeeper last read; a connector re-reads the site at
  connect and on the nightly pass, and says in its README which of its fields are cached.
- The host's own path to the session (the sync kind `booking-system`, hints from
  `core_integration_event`) and the rule that no other caller reaches a booking-system resource
  (`booking_system_host_only`) are step 3 (ADR 0922). Until then the fake is reachable like any
  dev-only gatekeeper; it holds only invented data.
- Settings → Integrations listing booking-system entries under their own heading, and at most one
  active booking-system connection per deployment, are not built in this step: the spec's build
  order gives step 1 only the catalogue's `implements`, so they come with the host path (step 3)
  or the admin screens (step 6).
