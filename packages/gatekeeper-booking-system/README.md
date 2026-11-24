# @composable-os/gatekeeper-booking-system

The booking-system contract (stage 65, [ADR 0920](../../docs/adr/0920-the-booking-system-contract.md)):
what every booking-system gatekeeper serves, whatever system a business's members book in. Read
only: no write, no outbound action, nothing to approve. Not a gatekeeper of its own. It is read from
a system's API (a gatekeeper Worker built on this; none is planned) or from files a business
exported and a member of staff loads (the file source, below).

| File | What |
| --- | --- |
| `src/types.d.ts` | `BookingSystemSession` and its inputs and answers, served to agents as the resource's types |
| `src/validate.ts` | The hand-written input checks (ADR 0114), the contract's limits, and the shape every answer is copied into (`CONTRACT_KEYS`) |
| `src/refusal.ts` | `refuse(code, …)` and `refusalCode(message)`: why a read was refused |
| `src/reads.ts` | `checkedReads`: each input checked, each answer shaped, before a read is recorded |
| `src/session.ts` | `BookingSystemGatekeeper`, the facet a gatekeeper extends: each read an observation, no action kind |
| `src/system.ts` | `BookingSystem`, what a gatekeeper implements to talk to its system |
| `src/file-source.ts` | `parseCsv`, `loadFiles`, `dryRunFiles` and `FileBookingSystem`: the contract over loaded files |
| `src/match.ts` | `matchPeople`: an outside person to one Person by address, never merged, as the host and the dry run decide |
| `src/fake.ts` | `FakeBookingSystem`: an invented site in one plain state, with the controls a test needs |
| `src/conformance.ts` | The suite every implementation passes |
| `src/direct.ts` | The session's rules without a Worker, to run the suite against a system object |
| `src/fake-worker.ts`, `wrangler.fake.jsonc` | `cos-gatekeeper-booking-system-fake`, development and tests only, never released |

## The file source

A people file (one row per membership or pass) and, optionally, a class timetable, each a CSV with
its columns mapped by header:

```ts
const input = {
  site: { name: "Studio", timeZone: "Australia/Sydney" },
  people: {
    text: peopleCsv,
    mapping: {
      columns: { ref: "Client ID", email: "Email", givenName: "First", familyName: "Last",
        memberStatus: "Status", membershipType: "Plan", from: "Start", until: "End" },
      dateFormat: "DD/MM/YYYY",
    },
  },
  timetable: { text: timetableCsv, mapping: { columns: { title: "Class", startsAt: "Starts" } } },
};
const run = dryRunFiles(input, matchContext); // counts, refused rows, a sample, who would link
const session = directSession(new FileBookingSystem(loadFiles(input)));
```

Values are mapped onto the contract's words (common ones without a mapping; the file's own in
`mapping.values`). A row that cannot be used is left out and named; a file that cannot be read is
refused `invalid`. `describeSite().offers.source` is `file`: no calls, no hints, no change times.

## A system read through its API

1. A package `packages/gatekeeper-booking-system-<system>` with its own `wrangler.jsonc`,
   `deploy-inputs.json` (its secrets, set by a person) and a catalogue entry with
   `implements: "booking-system"`.
2. Implement `BookingSystem` against the system's API: map its records to the contract's types,
   count every call it makes by method (failed ones too; not one refused for rate or budget),
   refuse with `over_budget` once the month's budget is reached, and throw `refuse(code, …)` for
   every failure it can name. A read the contract allows but the API cannot do in one call is
   several calls.
3. Extend `BookingSystemGatekeeper` with its `system()` and `resourceUrl()`.
4. Pass the conformance suite: in tests against a stand-in of the system's API, and by hand against
   the system's sandbox site (`runConformance(target)`; it writes nothing but spends calls, so never
   against a business's site). Record the run in the package's README with the date and the calls
   it took.

## The fake booking system

In tests, run the suite in memory (`directSession(new FakeBookingSystem())`) or through the fake
gatekeeper. In development the CRM's dev server binds the fake to cos-runner as
`GATEKEEPER_BOOKING_SYSTEM_FAKE`: connect **Fake booking system (development)** for the org in
Settings → Integrations and bind `booking-system-fake://site/<name>`; each name is its own site,
with classes around the hour it was first read. cos-runner's tests reach its controls
(`FakeBookingSystemControl`) as `TEST_BOOKING_SYSTEM`: reset a site (on a clock of its own), change
or add a record (which records a hint), revoke the key, make the next call fail, spend the budget,
move the clock, give two people one address, and read the fake's own count of calls.
