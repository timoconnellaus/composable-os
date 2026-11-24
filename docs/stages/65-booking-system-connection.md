# Stage 65: Booking system connection

Read first: [`AGENTS.md`](../../AGENTS.md), [`docs/architecture.md`](../architecture.md)
(Integrations, Identity, the visibility seam), [`CONTEXT.md`](../../CONTEXT.md) (Gatekeeper,
Connection, Integration host, Person, Customer account, Sign-in address, Erase, Allowance, Pack
role, Grant), [`docs/integrations.md`](../integrations.md); ADRs
[0007](../adr/0007-integrations-are-gatekeepers.md),
[0050](../adr/0050-integration-host-and-connections.md),
[0110](../adr/0110-integration-host-per-connection.md),
[0113](../adr/0113-inbound-webhooks-and-integration-events.md) (an inbound endpoint and its signing secret),
[0114](../adr/0114-own-gatekeepers-pickers-and-host-modules.md),
[0151](../adr/0151-provider-keys-as-workers-secrets-or-byok.md) (secrets never in D1),
[0169](../adr/0169-gatekeepers-in-releases.md) and
[0452](../adr/0452-gatekeeper-settings-in-product-ts.md) (gatekeeper secrets set by a person),
[0247](../adr/0247-duplicate-rules-and-scan.md) (`checkPerson`), [0320](../adr/0320-erase-reaches-every-store.md) (the
erased-address list), [0402](../adr/0402-staff-and-customers.md),
[0421](../adr/0421-the-client-app-binding-and-customer-sign-in.md) (linking by verified email),
[0449](../adr/0449-permissions-granted-one-by-one.md),
[0457](../adr/0457-confirm-your-email-and-confirm-the-native-sign-in.md),
[0500](../adr/0500-recurring-a-weekly-rule-in-local-time.md) (the Worker budgets),
[0621](../adr/0621-the-staffed-behaviour-and-the-time-claim.md) and
[0880](../adr/0880-the-accounting-contract.md) (the pattern this stage copies: a contract package,
a fake, a conformance suite, then a named connector); the specs of stages
[29](29-forms.md) (an address on file is not proof), [31](31-bookings.md),
[32](32-memberships.md), [34](34-offers.md) (members' prices), [41](41-programs.md),
[44](44-agreements.md), [45](45-rostering.md), [47](47-pack-screens.md),
[48](48-my-account.md) and [61](61-accounting-sync.md); `packages/gatekeeper-accounting/`,
`packages/core/src/integrations/catalogue.ts`, `runtime.ts`, `apps/runner/src/integrations/host.ts`
and `sync.ts`, `packages/core/src/sync/ingest.ts`, `packages/core/src/customers/accounts.ts`
(`linkCustomer`, `sameEmailPeople`), `packages/core/src/records/erase.ts` and `erase-stores.ts`,
`scripts/check-stray-names.mjs`.

Status: **spec agreed** (owner interviewed 2026-11-24: decisions 1 to 5). Steps 1 and 2 may start
now. Two questions stay open (at the end): connecting a real business's data waits for question 1;
question 2 sets a default and blocks nothing.

**This is not legal advice.** The booking system's own terms of use limit what may be done with
what its API returns (below, "The outside system's terms"). Whether a business's use is within them
is for the business and its lawyer, or the booking system's support, to confirm. The connect screen
says so.

## Goal

A business that keeps its booking system for months still gets the new system's worth from the
first day, beside it. Event tickets, the online program, training programs logged in the app, the
blog and the site, and staff checklists run on the new system. Members and whether their membership
is live are read from the booking system on their own, so a member pays the members' price for a
ticket, opens the members' program and sees "your membership is managed in your booking system" in
My account, without anyone typing a list in twice. The timetable and who is booked are shown in the
new system, read only, so coaches and the desk see the day in one place; booking still happens in
the booking system. Nothing is ever written back. With no connection at all, every one of those
pieces still works: people are just people with accounts.

The first connector is for **Mindbody** (decision 5). Core never names it: it speaks one
booking-system contract, and Mindbody's gatekeeper is the first that implements it. When a business
later leaves its booking system (stage 33), the same connector reads what the move needs, so
nothing is built twice.

## Who it is for

- **A gym or studio staying on its booking system for a while**, with memberships, passes and its
  timetable there, and new things (tickets, an online program, logged training, content,
  checklists) on the new system.
- **Its members**, who keep booking where they always have and find the new system already knows
  they are members.
- **Its coaches and desk**, who see today's classes and who is booked beside the new system's own
  work, and (later) the roster with every class on it.
- **What all of them share:** the booking system stays the only place memberships and bookings are
  made and changed. The new system shows what it read, how old it is, and never pretends to be the
  booking system.

## What exists today (from the code)

| Piece | Where | What this stage uses |
| --- | --- | --- |
| Gatekeepers, accounts, resources, sessions, observations | `packages/gatekeeper-interface/src/gatekeeper.ts` (vendored), `packages/gatekeeper-kit/src/` | The contract's session runs on these unchanged |
| A contract package with a fake, a conformance suite and a dev-only fake Worker | `packages/gatekeeper-accounting/` (`session.ts`, `fake.ts`, `fake-worker.ts`, `conformance.ts`, `direct.ts`, `wrangler.fake.jsonc`); ADR 0880 | The shape copied one for one |
| The catalogue, enabled per deployment, with `implements` | `packages/core/src/integrations/catalogue.ts` (`CatalogueEntry.implements?: "accounting"`, `devOnly`, `sync?`) | Gains `"booking-system"` |
| Sync on the integration host's alarm, cursors in Durable Object storage, adapters that pull pages | `apps/runner/src/integrations/host.ts` (`alarm`, `#syncPass`, `SYNC_PAGE`, `SyncState`), `apps/runner/src/integrations/sync.ts` (`SyncAdapter.pull`, `PullResult`), `SyncKind = "mail" \| "calendar"` | A third kind, `booking-system` |
| Ingest as the host, in slices, dropping erased addresses first | `packages/core/src/sync/ingest.ts` (`sync.ingest`, `SYNC_BATCH_MAX = 50`, `erasedAddresses`, `withoutErased`) | The model for `outside.ingest` |
| Inbound webhooks to a gatekeeper on a public path, events polled on the minute cron | `packages/gatekeeper-webhook/src/worker.ts` (`/gatekeeper/webhook/in/<id>`), `core_integration_event`, `pollIntegrationEvents` (ADR 0173), `apps/app/src/server/access-layout.ts` | The connector's change hints |
| Matching a Person by address | `linkCustomer` and `sameEmailPeople` in `packages/core/src/customers/accounts.ts`, `checkPerson` in `duplicates/check.ts`, `normaliseCustomerEmail`; `resolveBuyer` in `orders/guests.ts` | The same rule, one Person or none |
| An address on file is not proof (certainty `address`) | Stage 29, decision 7 and its "certainty" rules | An outside person links with certainty `address` |
| A customer's verified sign-in address | `me.get` (`signInEmail`, `signInEmailVerified`), ADR 0421's amendment | What a members' price and a members' program check |
| Erase, the erased-address list, erase of other stores | `person.erase` (`operations/person.ts`), `records/erase.ts`, `records/erase-stores.ts`, `core_erased_address`, `erasedAddressHash` | Outside copies go; the outside id is suppressed |
| Bookings: classes, the coach, the coach role, the timetable reads and blocks | `packs/bookings` (`class`, `booking`, `coach`, `roles.coach`, tools `timetable`, `day`, `roster`, `classList`; blocks `bookings-timetable`, `bookings-native-timetable`, `bookings-class-list`) | Outside classes shown beside them, read only |
| Allowances: only a declared spender spends | `packages/core/src/allowance/`, `bookings.booking`'s `allowance.spends` | Outside bookings declare nothing, so never spend |
| Memberships and their statuses | `packs/memberships` (`membership` `trialing` … `ended`, `pass`) | The words an outside membership maps onto |
| Programs assigned to a person or a class type | `packs/programs` (`programs.assignment`, `kind` `personal` or `class`), the coach's client screen (`programs-coach-client`) | A third kind, to members; the coach's client list |
| Rostering's time claim and week read | `packages/core/src/staffing/`, ADR 0621, `staffing.week` | Outside classes on the roster (a later step) |
| Checklists in core | `core_checklist*`, ADR 0650 | Used on their own (the follow-on recorded in stage 45) |
| The stray-names lint | `scripts/check-stray-names.mjs` (rule "a client's booking system", `/mind\s?body/i`, allowed only in the script) | Changed by step 2 |

Not built, specced: stage 34's discounts and `priceLines` rules (no `packs/offers` yet), stage 48's
`me.portal` and `me.attention`, stage 61 step 3's host-only rule (`accounting_host_only`), stage 33
(not specced).

## Decided at the interview (2026-11-24)

The owner's reason for the stage: a business may stay on its current booking system for months. The
new system must be useful beside it, with or without a connection, and must not need memberships or
bookings moved over.

| # | Decision |
| --- | --- |
| 1 | **The first things on the new system while the booking system stays**: event tickets, the online program, training programs logged in the app, the blog and site content, and staff checklists. Checklists come on their own first; the roster and hours can follow |
| 2 | **The new system reads members and whether their membership is live from the booking system, on its own**, and never writes anything back |
| 3 | **The timetable and who is booked show in the new system, read only.** Booking still happens in the booking system |
| 4 | **The connection lives in this public repository as a named connector**, as the accounting one does, and no file says which business uses it |
| 5 | **The first connector is for Mindbody.** A business gets access to its booking system's API as a key; the build does not wait for one |

## The design in one page

- **One read-only contract, many booking systems.** `BookingSystemSession` is a small typed session
  every booking-system gatekeeper implements: who the people are, their memberships and passes with
  status and dates, class types, scheduled classes, who is booked and who attended, staff. It has
  **no write of any kind**: no outbound action, no action kind, nothing to approve. Each system is
  its own gatekeeper Worker, installed only where it is used, with its own secrets. They share
  `packages/gatekeeper-booking-system` (the contract, input checks, a fake booking system and a
  conformance suite). The first is `packages/gatekeeper-booking-system-mindbody`.
- **Core owns the copy, not a pack** (`packages/core/src/outside/`). What is read touches several
  packs at once (Offers' prices, Agreements, Programs, Bookings, Rostering, My account), and the
  rules about it (who counts as a member, what a customer may see, what is kept and for how long)
  are the host's. Packs show it through their blocks and read it through host operations; no pack
  hooks a write.
- **What the host keeps is a copy that expires.** Outside people, memberships, classes, bookings
  and staff are core rows, each with the time it was last read. A row not confirmed by a read in
  **48 hours** is deleted (the outside system's terms, below). Until then it is shown with its age
  ("as of 40 minutes ago").
- **An outside person is matched to a Person by address, never merged.** Exactly one live Person
  with the same address: linked, with certainty `address` (stage 29): nothing on the Person is
  changed and nothing is sent to them. None: the outside person stays in the copy, unlinked, and no
  Person is made for them. Several, or several outside people with one address: nobody is linked
  and staff choose. A customer gets anything from the link (a members' price, a members' program,
  My account) only when the address is their **verified sign-in address**.
- **An outside membership is a source of truth the host trusts**, while it is fresh: for members'
  prices (stage 34), for who is a member for agreements and programs, and for My account, where a
  member sees it "managed in your booking system", with a link the business sets.
- **Outside classes are shown, never bookable here.** Bookings' timetable, the coach's and the
  desk's day and (later) the roster show them, marked with the booking system's name and a link
  where to book. They are not records of `bookings.class`, take no place, and never spend an
  allowance.
- **Sync is hints, an hourly pass and a nightly pass.** The booking system's webhooks, where it has
  them, are hints that say what to read again; an hourly pass reads what changed; a nightly pass
  reads everything kept and refreshes it. Every call counts against a monthly call budget the host
  keeps (Mindbody charges per call over a free allowance).
- **When the connection is down or the key is revoked, the platform keeps working.** The copy is
  shown with its age, the admins are told once, and after 48 hours the copy is gone and outside
  memberships stop counting. Nothing else stops.
- **Secrets are env-only; connecting is a human admin's act.** The API key and the read-only staff
  login are Worker secrets set by a person at deploy. A human admin enables the gatekeeper and
  chooses the site in Settings → Integrations. An AI never connects, disconnects or changes it,
  and the connection is the host's alone: not callable through `integration.call`, Code Mode or an
  extension.
- **No connection is a normal state.** Every first-wave piece works with none; every outside read
  answers empty. A member list from a file is a later fallback with the same shape.
- **Stage 33 reuses it.** The move reads through the same session, the same links and the same
  fake, and writes stage 31's and 32's import folders.

### What was weighed and rejected

| Option | Why not |
| --- | --- |
| **Writing bookings back** (book in the new system, pushed to the booking system) | Decision 2. Two places to book makes two sources of places and two sets of rules, and a failed push loses a member's place. Booking stays where it is |
| **Making a Person for every outside client** | Copies thousands of people (leads, lapsed members) the new system does not need, for good, against the outside terms' 48-hour limit. A Person is made as today: a sign-in, a purchase, staff, or (later) a file the business loads |
| **Merging on a matching address** | Shared family addresses and typing mistakes are common in booking systems. A link by address changes nothing on the Person; several candidates wait for a person |
| **Outside classes as `bookings.class` records** | They would claim places, take bookings, spend allowances and fire Bookings' messages; every rule would need an "unless outside" exception. A read-only core copy shown beside them keeps the pack's rules whole |
| **A pack ("Booking system pack")** | What is read spans six packs and core; who is a member and what a customer sees are host rules (ADRs 0401, 0404) |
| **One Worker with every booking system behind it** | Each system has its own key, sign-in, limits and terms. Separate Workers keep secrets apart; the shared package keeps one contract and one fake (ADR 0880's reasoning) |
| **Polling every few minutes, without hints** | Costs calls (Mindbody charges per call over its free allowance) and still lags. Webhooks are free there and say what changed |
| **Trusting webhook bodies as the data** | Not ordered, not exactly once, and stop after hours of failure (Mindbody's own documentation). A hint says what to read; the read is the truth |
| **Keeping the copy for ever, marked stale** | Against the outside terms' 48-hour limit, and a revoked key would leave members' details behind with nobody reading them again |
| **The members' price on any matching address** | An address typed in the booking system proves nothing. The price goes to the account that proved the mailbox, or to staff selling to that Person |

## Platform work and pack work

| Piece | Kind | What |
| --- | --- | --- |
| The booking-system contract, checks, fake, conformance suite, dev-only fake Worker | **Platform** (new package) | `packages/gatekeeper-booking-system/` |
| The Mindbody gatekeeper | **Platform** (new gatekeeper) | `packages/gatekeeper-booking-system-mindbody/`: its API mapped to the contract, the staff token, webhooks as hints, the call counter, `deploy-inputs.json`, README; passes the conformance suite against Mindbody's sandbox site |
| Catalogue: `implements: "booking-system"` | **Platform** | `CatalogueEntry.implements` widened; Settings → Integrations lists such entries under Booking system; at most one active booking-system connection per deployment |
| The connection is the host's alone | **Platform** (integrations) | The host-only rule (`booking_system_host_only`), the sync kind `booking-system`, hints from `core_integration_event` |
| The `outside` core module: settings, the copy, matching, ingest, freshness, who is a member | **Platform** (new) | `packages/core/src/outside/`, `operations/outside.ts`, migration 1410 (new tables only) |
| A core permission | **Platform** | `bookingSystem:manage` (`principals.ts`): admins by default, granted one by one (ADR 0449); never to a pack role |
| Members' prices on outside memberships | **Platform** (host pricing) and **pack** (Offers' discount field) | `discount.who` gains outside membership types; the check is the host's in `priceLines` |
| A members' program | **Platform** (a read scope) and **pack** (Programs) | `programs.assignment` gains `kind: "members"`; the host decides who reads it |
| My account | **Platform** (a base section) | "Your membership" from the booking system, web and native base-layer blocks |
| Bookings | **Pack** (blocks and tools) | The timetable blocks and the coach's and desk's day show outside classes, read only, through `outside.*` reads |
| The coach's client list | **Pack** (Programs' coach screen) over a host read | People booked into the coach's outside classes |
| The roster | **Platform** (the time claim, read only) and **pack** (Rostering's week) | A later step (decision 1) |
| The naming rule | **Repository** | `scripts/check-stray-names.mjs` and its tests (step 2) |

No new behaviour. No pack hooks a write. No `x_*` table is touched by a migration.

## The model

### Words (for `CONTEXT.md`)

- **Booking system**: an outside system where a business's members book classes and hold
  memberships. Avoid: provider (that is payments'), source.
- **Booking system connection**: the one connection a deployment has to its booking system,
  through a gatekeeper that implements the booking-system contract. Read only.
- **Outside person**, **outside membership**, **outside class**, **outside booking**, **outside
  staff**: the host's copies of what the booking system says. Each has a **read at** time and an
  **age**. Avoid: synced member, imported member (an import makes records that stay).
- **Linked (by address)**: an outside person matched to one Person by the same address. Not a
  merge, not proof that the Person is them.
- **Member**: a Person with a live membership here (stage 32) or a fresh live outside membership of
  a type the business counts (below). One host question answers it everywhere.
- **Hint**: a message from the booking system saying something changed; it makes the host read
  again and is never itself the data.

### The contract (`BookingSystemSession`)

Every method is a read, recorded as an observation. Times are ISO 8601 with an offset; a date is
`YYYY-MM-DD`; a time zone is IANA. Each item carries the system's `ref` (a string, stable for the
life of the record) and `modifiedAt` where the system has one.

| Method | Answers |
| --- | --- |
| `describeSite()` | The site's name, time zone, locations (ref, name), and what this system offers: `modifiedSince` per kind, `hints` (webhooks or none), the largest page, the call budget and calls used this month |
| `listPeople({ modifiedSince?, refs?, cursor? })` | A page of people: ref, email, given and family name, the system's own member status mapped (`member`, `not_member`, `suspended`, `expired`, `ended`, `declined`), active or not, `modifiedAt`. Never an address, a phone, a birth date, a card or notes |
| `listMembershipTypes()` | What the business sells that grants membership or uses: ref, name, kind (`membership` or `pass`), active |
| `listMemberships({ people })` | For at most 200 people: each membership and pass they hold: ref, person, type ref, name, kind, status (`live`, `paused`, `ended`, `cancelled`), from, until, uses total and left (passes), renews (whether it charges again) |
| `listClassTypes()` | ref, name, short description, active |
| `listClasses({ from, until, modifiedSince?, cursor? })` | A page of classes from `from` to `until` (at most 35 days): ref, class type ref, title, starts and ends, location ref, staff ref, places, booked, waiting, cancelled, `modifiedAt` |
| `listBookings({ classes })` | For at most 50 classes: each booking: ref, class, person, state (`booked`, `waiting`, `attended`, `late_cancelled`, `no_show`, `cancelled`), `modifiedAt` |
| `listStaff()` | ref, display name, email where the system gives it, active. Nothing else about them |
| `listVisits({ person, from, until, cursor? })` | A person's past bookings in their final states. Used by stage 33 only; the sync never calls it |
| `takeHints({ max })` | Hints received since the last take: kind (`person`, `membership`, `class`, `booking`, `staff`, `site`) and refs; none for a system without them |

The session serves exactly these methods (`BOOKING_SYSTEM_SESSION_METHODS`) and declares **no
outbound actions**: its action set is empty, so nothing can be submitted, journalled or approved
through it. A gatekeeper that adds a write fails the conformance suite.

**Refusals carry a reason code** at the front of the message, `[booking-system:<code>] `:
`unauthorised` (the key or the staff login is wrong or revoked), `not_activated` (the site has not
granted access), `rate_limited`, `over_budget` (the month's call budget is spent), `unavailable`,
`invalid`. `rate_limited` and `unavailable` are transient; `unauthorised` and `not_activated` mark
the connection expired (`credentialsChanged`).

**The fake** (`FakeBookingSystem`, `fake.ts`) holds invented people, types, memberships, classes,
bookings and staff in one plain state object, and lets a test: change anything and record a hint;
revoke the key; make the next call fail (transient or not); spend the budget; move the clock;
share one address between two people; count every call by method. **The conformance suite**
(`conformance.ts`, `runConformance`) runs every read against any target: paging to the end,
`modifiedSince` returning what changed and nothing older, refs stable across reads, the 200-people
and 50-classes limits refused above them, every refusal code, no outbound action declared, no
field outside the contract returned (checked by key), and the call counter matching the calls
made. Checks needing the fake's controls are skipped without them. It runs against the fake in
memory, the fake gatekeeper through its session, and, by hand, a real system's sandbox site.

**The fake gatekeeper is never released** (`cos-gatekeeper-booking-system-fake`, vendor
`booking-system-fake`, catalogue `devOnly`, config in `wrangler.fake.jsonc`), as the accounting
fake.

### The Mindbody gatekeeper (decision 5)

Designed against Mindbody's Public API v6 and Webhooks API as documented on 2026-11-24 (sources at
the end). The build confirms each point against the sandbox and records it in the README.

- **Secrets, env-only** (`deploy-inputs.json`, set by a person with `wrangler secret put` or the
  installer's `--secret`; `cos deploy` names each missing one and never prints a value, ADR 0452):
  `API_KEY` (the `Api-Key` header), `STAFF_USERNAME` and `STAFF_PASSWORD`. Reading clients needs a
  staff user token ("This endpoint requires staff user credentials", `GET /client/clients`), issued
  by `POST /usertoken/issue` and renewed by `POST /usertoken/renew`. The setup guide tells the
  business to make **a staff login used only by this connection**, with only the permissions to
  view clients, their memberships, the schedule and staff, because a token returns what its staff
  member may see. The token is held in the gatekeeper's Durable Object storage, never in D1, the
  audit log or a response.
- **Whose key**: the business's own developer account (decision 5: the business gets an API key).
  Its calls are billed to that account. A platform-wide developer account is not used in this stage
  (question 2's note).
- **The site**: `SiteId` is not a secret. A human admin connects in Settings → Integrations and
  chooses the site in the gatekeeper's picker (`GET /site/sites` lists the sites the key reaches).
  Access exists only once the site's owner has activated the developer account (an activation link
  or code, entered under the site's API integrations); until then every call is `not_activated` and
  the connect screen says what to do. The sandbox site (`-99`) needs no activation and its calls
  are free.
- **How it meets the contract** (to confirm at build):

  | Contract | Mindbody |
  | --- | --- |
  | `listPeople` | `GET /client/clients` with `limit` (at most 200) and `offset`, `lastModifiedDate` for `modifiedSince`, `clientIDs` (at most 20) for `refs`. `ref` is the client's `UniqueId` (system-made, never changes), not `Id` (set by the business, may change). Member status from `Status` (Declined, Non-Member, Active, Expired, Suspended, Terminated) |
  | `listMembershipTypes` | `GET /site/memberships` and `GET /sale/services` (pricing options, kind `pass`) |
  | `listMemberships` | `GET /client/activeclientsmemberships` (up to 200 clients a call) for memberships; `GET /client/clientservices` (`ClientIds`, `ShowActiveOnly`) for passes: `Count`, `Remaining`, `ActiveDate`, `ExpirationDate`; `GET /client/clientcontracts` for whether a contract renews (`AutopayStatus`, `AutoRenewing`), read only for people the copy keeps |
  | `listClassTypes` | `GET /class/classdescriptions` |
  | `listClasses` | `GET /class/classes` with `StartDateTime`, `EndDateTime`, `LastModifiedDate`; the response carries `Visits`, so a class and its bookings come in one call |
  | `listBookings` | The visits on `listClasses`; `GET /class/classvisits` (`ClassID`, `LastModifiedDate`) for one class after a hint. States from `SignedIn`, `LateCancelled`, `Missed` |
  | `listStaff` | `GET /staff/staff` (with the token; without one only names and ids come back) |
  | `listVisits` | `GET /client/clientvisits` (`StartDate`, `EndDate`) |
  | `takeHints` | Webhooks (below) |

- **What Mindbody does not offer, and how the design meets it**: no modified-since filter on
  memberships, passes or contracts (they are read in full for the people kept, nightly, and after a
  hint); no webhook for a pass (`classRosterBooking.created` carries `clientPassSessionsRemaining`,
  which is a hint only); no endpoint to erase a client (requests go to Mindbody's support: the
  erase result says so); no documented largest date range for classes (the contract's 35 days, cut
  smaller if the sandbox refuses); whether class times carry an offset is not confirmed (if they do
  not, the site's time zone from `describeSite` is applied, and a test covers a daylight-saving
  change).
- **Webhooks as hints**: subscriptions are made through the Webhooks API
  (`https://mb-api.mindbodyonline.com/push/api/v1`, `POST /subscriptions`, then `PATCH` to Active)
  with the same key, for `client.created`, `client.updated`, `client.deactivated`,
  `clientProfileMerger.created`, `clientMembershipAssignment.created`,
  `clientMembershipAssignment.cancelled`, `clientContract.created`, `clientContract.updated`,
  `clientContract.cancelled`, `classRosterBooking.created`, `classRosterBooking.cancelled`,
  `classRosterBookingStatus.updated`, `class.updated`, `classSchedule.created`,
  `classSchedule.updated`, `classSchedule.cancelled`, `classDescription.updated`, `staff.created`,
  `staff.updated`, `staff.deactivated`. They arrive at
  `POST /gatekeeper/booking-system-mindbody/in/<connection>`; each is checked against
  `X-Mindbody-Signature` (`sha256=` and the base64 HMAC-SHA256 of the raw body with the
  subscription's `messageSignatureKey`, returned only when the subscription is made and kept in the
  gatekeeper's storage), and one whose `siteId` is not the connection's is dropped (a subscription
  belongs to the developer account, not to one site). A checked hint is stored for `takeHints` and
  answered 2xx at once; nothing is read inside the request. A subscription Mindbody deactivated
  after failed deliveries is noticed by the nightly pass (`GET /subscriptions`) and the admins are
  told; the sync carries on hourly.
- **Calls and budget**: Mindbody charges per call once a month passes 5,000 calls, and then for
  every call that month; failed calls count, 429 answers do not, webhooks are free; it asks for no
  more than 2,000 calls a minute. The gatekeeper counts every call it makes (month to date, by
  method), refuses with `over_budget` once the month's budget (a setting, below) is reached, spaces
  calls to at most 10 a second, and on a 429 backs off (1, 5, 30 minutes) as `rate_limited`.

### The outside system's terms

Mindbody's API Terms of Use (last updated 2023-09-30) say a developer may not "cache (in excess of
48 hours), collect, compile, store, transfer or utilize Mindbody Data" (§8.19), may not "use the
API in a product or service that competes with products or services offered by Mindbody" (§8.5),
and may not "use the API on behalf of any third party" (§8.11). The design keeps within the first
as far as code can: every copied row is read again at least daily and deleted when 48 hours pass
without a read, and nothing is kept that the first wave does not use. Whether a business's use of
its own data, through its own developer account, inside the platform is within §8.5 and §8.11 is
not for code to decide: it is question 1, and **no real business is connected until it is
answered**. The build and its tests run against the fake and the sandbox site meanwhile.

### Records

Core tables (migration 1410), in no `rec_*` view, `query.sql`, export, search or dashboard; read
only through `outside.*` operations:

- **`core_outside_settings`** (one row; human admin, `actors: ["human"]`): the connection and site;
  on or off; the **member types** (which outside membership and pass types make a Person a member:
  by default every type of kind `membership`, no pass); the **links** the business sets (where a
  member manages their membership, where to book a class: each an `https` address, shown as is);
  the **class window** (7 days back, 28 ahead by default; at most 35 in all); the **monthly call
  budget** (4,500 by default, question 2); the nightly pass's hour (03:00 in the organisation's zone).
- **`core_outside_person`**: connection, ref, address (normalised by `normaliseCustomerEmail`),
  given and family name, member status, active, `modified_at`, `read_at`; the **link**: Person (or
  none), how (`address` or `staff`, with who), when; `why_kept` (a member, holds a live pass, booked
  in the window, or staff). Unique by (connection, ref).
- **`core_outside_membership_type`**: ref, name, kind, active, `read_at`.
- **`core_outside_membership`**: ref, outside person, type, name, kind, status, from, until, uses
  total and left, renews, `read_at`.
- **`core_outside_class_type`**, **`core_outside_class`** (ref, type, title, starts, ends, location
  name, outside staff, places, booked, waiting, cancelled, `read_at`),
  **`core_outside_booking`** (ref, class, outside person, state, `read_at`),
  **`core_outside_staff`** (ref, display name, address, active, the staff account it is linked to or
  none, `read_at`).
- **`core_outside_match`**: an outside person or outside staff waiting for a person to link: the
  candidates (Persons, or staff accounts) and why (`several_people`, `shared_address`,
  `no_address`). Kept while the outside row is.
- **`core_outside_suppressed`**: the hash of (connection, ref) for an erased Person's outside person,
  so the next read keeps nothing of them (as `core_erased_address` does for mail).
- **`core_outside_run`**: each pass: kind (`hint`, `hourly`, `nightly`), started, finished, calls
  made, rows written and removed, the error code if any. Kept 30 days. It is how the screens say
  "last read 40 minutes ago".

**What is kept is the least the first wave uses.** An outside person is kept only while they are a
member, hold a live pass, are booked in the class window, or are staff-linked; anyone else read in a
pass is dropped in the same pass. No address, phone, birth date, card, note, visit history before
the window, sale or price is copied.

### Matching (never merged)

For each outside person kept, on every pass, in order:

1. The ref is suppressed (an erased Person): keep nothing.
2. The address is on the erased-address list: keep nothing.
3. A link already held whose Person still has that address live: keep it. A link made by staff is
   kept whatever the address.
4. Exactly one live Person has the address among their live addresses (`checkPerson`), and no other
   kept outside person shares it: link, how `address`. Nothing on the Person changes: no name,
   address or phone is written, no customer account is touched, nothing is sent (stage 29's
   certainty `address`). The timeline gets one activity, "linked to the booking system", naming no
   address.
5. Several Persons have the address, or several outside people share it (a family on one address):
   link nobody; a `core_outside_match` row lists the candidates for staff.
6. No Person has it: stay unlinked. A Person who later appears with the address (a sign-in, a
   purchase, staff) is linked on the next pass.

A link whose Person no longer has the address is dropped and matched again. **Staff link by hand**
(`outside.link`, a person with `bookingSystem:manage`): any outside person to any Person, or an
outside staff member to a staff account, with why; and unlink. Never an AI. **A merge** in the host
moves links to the survivor; two outside people linked to one Person are kept apart and both shown.
**Staff** are matched the same way, to staff accounts by their address, so a coach's classes are
theirs here.

### Who is a member (one host question)

`memberOf(db, person, now)` answers, for one Person: their live memberships here (stage 32's
`membership` in `trialing`, `active` or `past_due`) and their live outside memberships: linked,
status `live`, today within from and until, of a member type, and read within 48 hours. Every
consumer below calls it; none works it out again.

- **Members' prices (stage 34).** A discount's `who` gains "holders of chosen outside membership
  types" beside "members of chosen plans". In `priceLines` the host applies it to a **signed-in
  customer** only when their verified sign-in address (`signInEmailVerified`) equals the linked
  outside person's address, or a link made by staff; and to **staff buying for a Person** who is a
  member by `memberOf` (the staff member sees "member in the booking system, as of …"). A guest
  never qualifies (stage 34's rule 2). The one-deal rule (decision 9 there) is unchanged.
- **Agreements (stage 44).** The Due list's "members with a live membership" counts outside
  members. Points and enforcement are unchanged: they fire on what is bought or booked here.
- **Programs (stage 41).** `programs.assignment` gains `kind: "members"` (optionally limited to
  chosen plans or outside types). The host decides who reads it: a signed-in customer for whom
  `memberOf` is true by the same verified-address rule. A new read scope in the visibility seam,
  `member`, beside `signedIn` (ADR 0447).
- **The coach's client list.** `outside.clientsOf { staff }` lists the people booked into, or who
  attended, that coach's outside classes in the class window: name, the Person when linked, the next
  class. Programs' coach client screen shows it, with "no account here yet" for the unlinked. A
  coach sees only their own classes' people; `bookingSystem:manage` and the desk see everyone's.
- **My account (stage 48).** A base section, **Your membership**, shown when the caller has a fresh
  outside membership (by the verified-address rule): each membership and pass, its status, until,
  uses left, "Managed in your booking system", the business's link, and "as of …". Base-layer
  blocks `account-outside-membership` (web and native). No attention item comes from outside data:
  the booking system tells its own members. A guardian's view of a child is not in this stage.

### Outside classes (read only)

- **The timetable.** `outside.timetable { from, until }` (customer and **public**: newly opened, a
  reviewed change, ADR 0402) answers outside classes in the window that are not cancelled: class
  type, title, starts, ends, location, the coach's display name, places left (as Bookings shows its
  own, `show: "exact"`), and the business's booking link. Never who is booked. Bookings'
  `bookings-timetable` and `bookings-native-timetable` blocks merge them in by time, each marked
  "Book in your booking system" with the link and no Book button. With no connection the read is
  empty and the blocks show only Bookings' own classes.
- **The desk's and the coach's day.** `outside.day { date }` (staff: `bookings:coach` or
  `bookings:desk`, as Bookings' `day`) answers that day's outside classes with who is booked and who
  attended (names from the copy, the Person when linked). Shown in `bookings-class-list` beside the
  pack's classes, marked read only: no mark attended, no move, no cancel. A coach's own classes are
  those whose outside staff is linked to them.
- **Never spending.** Outside classes and bookings are core rows, not records of `bookings.class`
  or `bookings.booking`. They declare no behaviour, take no place in `capacity`, and never touch
  `core_allowance_use`. A test proves a member's allowance is the same before and after a pass that
  writes their outside bookings.
- **The roster (a later step, decision 1).** Rostering's week shows outside classes with their
  coach, read only. The coach is the booking system's: a substitute made there arrives with the
  next pass; a class whose outside staff is not linked to a staff account shows "coach not linked"
  and a rosterer links them once (`outside.link`). Each class with a linked coach enters the time
  claim as a read-only claim (kind `outside`), so a duty shift overlapping a class the person
  teaches is a **warning** (ADR 0622), never refused: the booking system can move a class at any
  time and the roster must not then refuse its own reconcile.

### Sync

The integration host runs it as a third sync kind, `booking-system`, on its alarm, with its cursors
in Durable Object storage, as mail and calendar sync do. The adapter calls the session and hands
the results to `outside.ingest` (as the host, `actors: ["automation"]`, `mcp.expose: false`) in
slices.

| Pass | When | Reads |
| --- | --- | --- |
| **Hint** | Within 2 minutes of a hint, at most once per record in 5 minutes | Only what the hint names: a person and their memberships, one class and its bookings, one staff member |
| **Hourly** | Every hour, on the hour plus a minute per connection to spread hosts | People changed since the last pass; classes in the window changed since the last pass, with their bookings |
| **Nightly** | At the settings' hour | Everything kept: types, staff, every class in the window with its bookings, every member and pass holder and their memberships; rows not seen are removed; every row read gets a new `read_at` |

- **Freshness.** Every screen showing outside data shows its age from `core_outside_run`. A row
  whose `read_at` is more than 48 hours old is deleted by the minute cron (not only hidden), and
  with it its links and matches. An outside membership older than 48 hours never counts for
  `memberOf` even in the instant before it is deleted.
- **When the connection is down.** Transient errors (`rate_limited`, `unavailable`) retry the pass
  at 1, 5 and 30 minutes, then wait for the next. `unauthorised` or `not_activated` marks the
  connection expired, stops passes, and tells the admins once. The copy stays, aged, for 48 hours,
  then is gone; the admins are told again the day before ("the booking system's copy will be
  removed tomorrow; members' prices from it will stop"). Nothing outside this module stops: tickets
  sell (at the full price for an outside member), programs open by their other kinds, content and
  checklists run.
- **The call budget.** The nightly pass comes first. When the month's calls so far, plus the rest of
  the month's nightly passes at the last one's size, would pass the budget, hourly passes become
  three-hourly; when the nightly pass alone would, it reads members' memberships every other night
  and the admins are told. At `over_budget` every pass stops until the month turns or a human admin
  raises the budget, and the copy ages as when down. Hints cost a call each and are debounced.
  Rough sizes for a studio with 800 members and 3,000 clients, 15 classes a day (to confirm against
  the sandbox): nightly about 15 calls for clients, 4 for memberships, up to 40 for passes, 3 for
  classes with their visits, 2 for types and staff, so about 65; hourly about 3; hints a few dozen a
  day. That is about 2,000 + 2,200 + 900, so about 5,000 a month: right at the free allowance, so
  the default budget (4,500) makes hourly passes three-hourly late in the month. Question 2 decides.
- **Statements and subrequests per call.** A pass's slice is at most 10 calls to the booking system
  and at most 250 D1 statements (the repository's ceiling for one call; ADR 0500's budgets: 1,000
  queries an invocation, 10,000 subrequests, 100 bound parameters a statement). `outside.ingest`
  writes rows set-based, a list as one `json_each(?)` parameter, at most 100 rows a statement, so a
  slice of 200 people with their memberships is under 20 statements. The 48-hour purge deletes in
  chunks of 500 a statement, at most 10 statements a minute.
- **D1.** Rows are small (no text over 500 characters is copied; a title or description longer is
  cut). Expected size: a few thousand people, ten thousand bookings, well under a megabyte. Indexes:
  person by (connection, ref) and by address; class by starts; booking by class and by person.

### Operations

| Operation | Audience | Who may | Risk |
| --- | --- | --- | --- |
| `outside.settings.get` | staff | `bookingSystem:manage` | read |
| `outside.settings.update` (on and off, member types, links, window, budget, hour) | staff | human admin (`settings:manage`, `actors: ["human"]`) | write |
| `outside.status` (last passes, ages, calls this month, the budget, hints on or off) | staff | `bookingSystem:manage` | read |
| `outside.matches`, `outside.link`, `outside.unlink` (with why) | staff | `bookingSystem:manage`, human only for link and unlink | read / write |
| `outside.person` (a Person's outside memberships and upcoming outside bookings) | staff | anyone who may read the Person | read |
| `outside.day`, `outside.clientsOf` | staff | `bookings:coach` (own classes) or `bookings:desk`; `bookingSystem:manage` | read |
| `outside.timetable` | customer, **public** | anyone, rate limited | read |
| `outside.mine` (Your membership) | customer | the signed-in customer, by the verified-address rule | read |
| `outside.ingest`, `outside.purge` | host (`automation` actor) | the host | write |

None writes to the booking system, a Person's fields, an order, a membership here, a booking here
or an allowance. `outside.timetable` opening to the public is called out for review (ADR 0402).

### Screens

- **Web admin, Settings → Booking system** (core, `bookingSystem:manage`): Connect (links to Settings
  → Integrations; the terms notice above); Settings (member types from the booking system's own
  list, the two links, the window, the budget); Status (last passes and their ages, calls this
  month against the budget, hints received, the connection's state); To match (outside people and
  staff waiting, with their candidates; link, or leave).
- **Person page**: an "In the booking system" panel: linked how, outside memberships with status and
  dates, upcoming outside bookings, "as of …".
- **Bookings' blocks**: the timetable, the desk's and the coach's day (above). **Programs' coach
  client screen**: the coach's client list. **Rostering's week**: later.
- **My account**: Your membership (above).
- Every screen says "read from your booking system", shows the age, and has no control that would
  change outside data.

### Notifications

To `bookingSystem:manage` holders: at once when the connection expires or is not activated; the day
before the copy would be removed; when the month's budget slows passes or stops them; when the
booking system deactivated the hints. A daily digest line when people wait in To match. Nothing to
customers.

### What an AI may do

- **May**: read outside data only where the same caller may read the record it belongs to, through
  the same operations (a staff assistant reading a Person sees the panel staff see; a coach's
  assistant sees their own classes' people). Explain the status and why someone is waiting to be
  matched.
- **May not**, whatever is granted: connect or disconnect, set secrets, change settings, link or
  unlink, or reach the booking-system connection through `integration.call`, Code Mode or an
  extension (`booking_system_host_only`). The outside tables are in no `rec_*` view, so no
  dashboard, `query.sql` or export reaches them. Nothing is shown to an AI beyond what the record
  shows a person in the same seat.

### Privacy, audit and erase

- **What is read and kept**: names, an address, member status, memberships and passes (names,
  status, dates, uses), classes, bookings and attendance in the window, staff names and addresses.
  The least the first wave uses; nothing else is copied; everything goes 48 hours after it was last
  read, and at once when the connection is removed.
- **Who sees**: staff who may read the Person (their panel); coaches their own classes' people; the
  desk the day; customers only their own memberships (by the verified-address rule) and the public
  timetable (no names).
- **Audit**: every settings change, connect and disconnect, link and unlink (with why); each pass as
  the host's (counts and outcome, never names or addresses). Never a key, a password or a token.
- **Erase**: erasing a Person deletes their outside person, memberships, bookings, links and
  matches, and suppresses the ref (`core_outside_suppressed`), so the next pass keeps nothing of
  them; their addresses are already on the erased-address list. The erase result says "a copy
  remains in the booking system": the host cannot remove it there (Mindbody has no erase endpoint;
  requests go to its support), and staff deal with it there. Erasing a staff account unlinks its
  outside staff.
- **Removing the connection** deletes every outside row and the run log at once.

### Working without a connection

Each first-wave piece is built and tested with no booking-system connection: tickets (members'
prices from memberships here only), the online program (its other assignment kinds), logged
training, content and the site, checklists (stage 45's follow-on). Every `outside.*` read answers
empty, `memberOf` answers memberships here only, and no screen shows a booking-system panel. A
**member list from a file** (a CSV of address, name, membership type, until, loaded by a human
admin, kept until replaced and not subject to the 48-hour rule) is a later fallback with the same
`core_outside_*` shape and source `file`; it is not built in this stage.

### What stage 33 reuses

Stage 33 (leaving the booking system) reads through the same contract and connector, with
`listVisits` for history, and writes the import folders stages 31 and 32 already define
(`cos bookings import`, `cos memberships import`), with the booking system's refs as import keys.
The matching rules above decide which Person each outside person becomes, and links already made
carry over. Its one-off read runs under the same budget, the same secrets and the same fake. What
stage 33 decides (the switch, billing and stored cards, which the API does not return, and whether
the terms allow the move) stays stage 33's.

## Out of scope

- Any write to a booking system: bookings, cancellations, attendance, people, memberships, sales.
- Appointments, Pick a Spot, waitlist order, sales and prices from the booking system.
- A guardian's view of a child's outside membership; attention items from outside data.
- More than one booking-system connection per deployment, or several sites of one system.
- The member list from a file (later), a second booking system (each its own small stage), the
  move itself (stage 33).
- The roster's outside classes ship in this stage's later step, not the first wave (decision 1).

## Acceptance criteria

1. The conformance suite passes against the fake in memory and through the fake gatekeeper: every
   read, paging, `modifiedSince`, stable refs, the limits, every refusal code, no outbound action
   declared, no field outside the contract.
2. The Mindbody gatekeeper passes the conformance suite against the sandbox site (by hand, recorded
   in its README with the date and the calls it took).
3. A webhook with a wrong signature, or another site's id, is refused or dropped and stores no hint;
   a good one is answered 2xx without a call to the booking system and leads to one targeted read.
4. Matching: one Person with the address links (by address) and changes no field on the Person; two
   Persons, or two outside people on one address, link nobody and wait in To match; no Person stays
   unlinked and links on the pass after a Person with that address signs up; an erased address keeps
   nothing.
5. A signed-in customer whose verified sign-in address matches a fresh live outside membership of a
   member type gets the members' price on an event ticket; the same address unverified, a guest, an
   outside membership 49 hours old, or of a type not counted, does not.
6. A members' program opens to such a customer and to no one else.
7. Your membership in My account shows the outside membership, "managed in your booking system",
   the business's link and its age; nothing shows for a customer without one.
8. Outside classes appear on the timetable blocks with the booking link and no Book button, and on
   the coach's and desk's day with who is booked; nothing on them can be changed; a member's
   allowances are unchanged by any pass.
9. Freshness: every screen shows the age; a row not read in 48 hours is deleted by the cron; the
   admins are told the day before.
10. Down: a revoked key marks the connection expired, tells the admins once, stops passes, and
    tickets, programs, content and checklists keep working; with no connection at all, every
    first-wave journey passes.
11. Budget: passes slow at the projected limit and stop at the budget, the nightly pass first; the
    call counter equals the fake's count.
12. Cost: a nightly pass over the fixture (800 members, 3,000 people read, 28 days of classes) stays
    within 250 D1 statements and 10 booking-system calls per slice (statement-count test).
13. Erase removes every outside row for the Person, suppresses the ref so the next pass keeps
    nothing, and the result names the copy in the booking system.
14. An AI actor, an MCP client and an extension are refused every write here, and `integration.call`
    or `codemode` on the booking-system resource is refused for every caller
    (`booking_system_host_only`).
15. No key, password or token appears in any D1 row, audit row or response (every table read, as
    ADR 0151's test).
16. `node scripts/check-stray-names.mjs` passes with the connector named in its package, its ADR,
    this spec, `docs/integrations.md`, the catalogue and the site's list of connections, and fails
    on the name anywhere else, and on any file that names the connector together with a client.
17. E2E, one per journey: an admin connects the fake, a member's price applies to a ticket, the
    coach's day shows outside classes; and the same ticket journey with no connection.

## Dependencies

- **Built**: stage 6 (integrations, the integration host, sync, the catalogue), stage 22 and 23
  (customers, verified sign-in), stage 25 (orders), stage 31a (Bookings), stage 32b (Memberships),
  stage 41 (Programs), stage 45 (Rostering, checklists), stage 61 step 1 (the contract pattern,
  `implements`).
- **Not built, needed for one step each**: stage 34's Offers spine (members' prices, step 7), stage
  48's `me.portal` (Your membership, step 7), stage 61 step 3's host-only rule (made general here or
  there, whichever builds first, step 3).
- **Not needed**: stage 33, stage 30 (notices use today's), stage 47 (the screens are core admin and
  existing pack blocks).
- **Needs a person**: a Mindbody developer account and its sandbox for step 9; for a real business,
  its own developer account approved for live access, the site owner's activation, a read-only
  staff login, the secrets set on its host, and question 1 answered.

## Migrations and numbers

Block **CA** in [`parallel-work.md`](../parallel-work.md): migrations 1410–1429, ADRs 0920–0929.

- Migration 1410: `core_outside_settings`, `core_outside_person`, `core_outside_membership_type`,
  `core_outside_membership`, `core_outside_class_type`, `core_outside_class`,
  `core_outside_booking`, `core_outside_staff`, `core_outside_match`, `core_outside_suppressed`,
  `core_outside_run` (step 4).
- Migration 1411: the read-only `outside` claim kind for the time claim (step 11), if ADR 0621's
  tables need one; otherwise unused.
- New tables only; no `x_*` table and no `core_write_guard` kind; `bookingSystem:manage` is code in
  `principals.ts`.

ADRs the build writes:

1. **ADR 0920**: the booking-system contract: one read-only session, no outbound action, a Worker
   per system, the shared fake and conformance suite (step 1).
2. **ADR 0921**: names of the systems a business uses: a connector's name where it is defined,
   documented and listed, and never beside which business uses it (step 2). Amends the owner's rule
   of 2026-11-22 recorded in `scripts/check-stray-names.mjs`.
3. **ADR 0922**: the connection is the host's alone: secrets env-only, connecting a human admin's,
   the host-only rule, the sync kind (step 3).
4. **ADR 0923**: the outside copy: what is kept, 48 hours, its age, matching by address with no
   merge, the verified-address rule, suppression on erase (step 4).
5. **ADR 0924**: sync: hints, hourly and nightly passes, the call budget, down and revoked (step 5).
6. **ADR 0925**: outside memberships as a source of truth: `memberOf`, members' prices, members'
   programs and the `member` read scope, My account (step 7).
7. **ADR 0926**: outside classes: shown read only, never bookable here, never spending; the roster's
   read-only claim (steps 8 and 11).
8. **ADR 0927**: the Mindbody gatekeeper: how it meets the contract, the staff token, webhooks as
   hints, its limits and terms (step 9).
9. ADRs 0928 and 0929 stay free.

## Suggested build order

| Step | What | Files and areas | Beside what (collides with) |
| --- | --- | --- | --- |
| 1 | **The contract, fake and conformance suite** | `packages/gatekeeper-booking-system/` (new), the fake bound in the runner for dev and tests, `catalogue.ts` (`implements`) | Beside anything; `catalogue.ts` is one line |
| 2 | **The naming rule** | `scripts/check-stray-names.mjs`, `check-stray-names.test.mjs` | Beside anything. Before step 9 merges |
| 3 | **The host path**: sync kind `booking-system`, hints from events, the host-only rule | `apps/runner/src/integrations/host.ts`, `sync.ts`, `packages/core/src/integrations/runtime.ts` | After 1. **Collides with any integrations runtime work**, stage 61 step 3 above all (one shared host-only rule over `implements`) |
| 4 | **Core records, settings, matching, ingest, `bookingSystem:manage`** | migration 1410, `packages/core/src/outside/`, `operations/outside.ts`, `principals.ts` | Beside 1 to 3. Collides with **`principals.ts`** and the operations registry |
| 5 | **The passes, freshness and the budget** | `apps/runner/src/integrations/booking-system.ts`, `outside/purge.ts`, the minute cron | After 3 and 4 |
| 6 | **Admin screens and the Person panel** | `apps/app/src/routes/_app/settings/booking-system*`, the Person page | After 4. Collides with the Settings index |
| 7 | **Members**: `memberOf`, members' prices, the `member` scope and Programs' `members` kind, Your membership | `outside/members.ts`, `orders/` pricing, `visibility/`, `packs/programs`, base-layer blocks | After 4. Prices wait for stage 34's spine; Your membership for stage 48. **`visibility/` is reserved** (stage 22, 14): coordinate |
| 8 | **Outside classes** in Bookings' blocks and the coach's client list | `packs/bookings` blocks and tools, `packs/programs` coach screen | After 4. Beside 7 |
| 9 | **The Mindbody gatekeeper** | `packages/gatekeeper-booking-system-mindbody/`, `deploy-inputs.json`, `docs/integrations.md` | After 1 and 2; beside 3 to 8. Needs a person with a Mindbody developer account and the sandbox |
| 10 | **E2E, the site and `SITE.md`** | `apps/app/e2e/`, `apps/marketing`, `SITE.md` | After 5 to 8 |
| 11 | **The roster** (later, decision 1) | `packages/core/src/staffing/`, migration 1411, `packs/rostering` week | After 8. Collides with staffing work |
| 12 | **Erase, merge, removal** | `records/erase.ts`, `erase-stores.ts`, `person.merge` | Last. **Erase is reserved** (`docs/parallel-work.md`) |

Steps 1 and 2 start first and beside each other; then three sessions can run: the host path and
core (3 to 5), the Mindbody gatekeeper against the sandbox (9), and the screens and pack reads (6,
8) once 4 is merged.

## The naming rule (step 2)

Today `scripts/check-stray-names.mjs` refuses `/mind\s?body/i` in every file but itself ("the
repository does not name a client's suppliers", the owner's decision of 2026-11-22). Decision 4
changes it: a connector may be named where it is **defined, documented and listed**, and **no file
may say which business uses, used or is leaving any system**. The build changes the script so:

- The rule for the booking system gains an `allow` list of exactly: the connector's package
  (`^packages/gatekeeper-booking-system-mindbody/`), its ADR (`^docs/adr/0927-`), this spec
  (`^docs/stages/65-`), `^docs/integrations\.md$`, the catalogue
  (`^packages/core/src/integrations/catalogue\.ts$`) and the site's list of connections
  (`^apps/marketing/` and `^apps/marketing/SITE\.md$`). Everywhere else it fails as today; the
  course platform and CMS rules are unchanged.
- **A new rule, "a business named beside a system"**: in any file the supplier rules allow, a line
  that names a client fails. Clients are the labels in `products/*/product.ts` and a list in the
  script for clients with no product here; so does a phrase that points at one client (the words
  "first" or "our" just before "client"). So the connector's own files never say who uses it.
- Tests (`check-stray-names.test.mjs`): the name passes in each allowed path and fails one directory
  outside it; a client's name in an allowed file fails; a client's name with no supplier name in an
  ordinary file passes (the roadmap may name clients); the repository's rules are well formed.

This spec's own pull request adds only `^docs/stages/65-` to that rule's `allow`, with a test, so
the Documents check passes; step 2 makes the rest.

## Decided by this spec, open to override

- One read-only contract with no outbound action, a Worker per booking system, a shared package with
  the fake and conformance suite (ADR 0880's shape); Mindbody named only where the naming rule
  allows.
- Core owns the copy and the rules; packs show it.
- No Person is made from the booking system; a link by address changes nothing on the Person; a
  customer benefits only through their verified sign-in address; staff link by hand; never merged.
- The copy is deleted 48 hours after its last read, not only marked stale; outside memberships stop
  counting at the same moment.
- Member types default to every membership type and no pass; the business changes it.
- Webhooks are hints, never data; an hourly and a nightly pass; the nightly pass is never skipped
  for the budget.
- The coach of an outside class is the booking system's, shown on the roster read only; a clash
  with a duty is a warning, never a refusal.
- No attention items and no child's view from outside data in this stage.
- The public timetable shows outside classes with places left and no names (a reviewed change).
- The class window is 7 days back and 28 ahead.
- The business's own developer account and key, not a platform-wide one.

## Questions for the owner

1. **The booking system's terms.** Mindbody's API terms bar caching its data for more than 48 hours
   (§8.19), using the API in a product that competes with Mindbody (§8.5), and using it on behalf of
   a third party (§8.11). The design keeps within the first; the other two are a reading of the
   terms, not code. Options: **(a)** ask Mindbody's API support in writing, describing this use (the
   business's own developer account reading its own members into its own other system, kept no more
   than 48 hours, nothing written back), and connect a real business only on a yes; **(b)** have a
   lawyer read the terms and decide; **(c)** connect when the business has its key and accept the
   risk that Mindbody cuts access. **Recommended: (a)**, building and testing against the fake and
   the sandbox meanwhile, which needs nothing from Mindbody. Stage 33's one-off read for a move has
   the same question.
2. **Paying for calls.** Mindbody bills the developer account per call once a month passes 5,000
   calls, and then for all of them ($0.002 a call: about $10 for 5,000). The rough size above is
   about 5,000 a month for a mid-sized studio. Options: **(a)** a budget of 4,500 so it stays free,
   with hourly passes slowing to three-hourly late in a busy month (webhooks still bring changes in
   minutes); **(b)** a budget of 15,000 (about $30 a month at most), hourly all month; **(c)** no
   budget. **Recommended: (a)** as the default, which a human admin can raise per business. Whose
   account pays is the business's (decision 5) unless you would rather the platform hold one
   developer account for every business, which also needs Mindbody's live-access approval of the
   platform.

## Risks

- **Terms**: access could be cut by the booking system (question 1). Nothing in the first wave
  depends on the connection, so losing it costs members' prices and the shown timetable only.
- **A wrong link** gives one person's member status to another. Mitigations: links by address change
  nothing, benefits need the verified sign-in address, shared addresses wait for staff, the Person
  panel shows how each link was made.
- **Stale truth**: a cancelled member keeps a members' price until the next read (minutes with
  webhooks, at most a day without, never past 48 hours). The money is small; the age is shown to
  staff.
- **Cost**: a busy month can pass the free allowance; the budget and the counter bound it.
- **Security**: the staff login can read the business's members. It is the gatekeeper's alone,
  env-only, read-only by the business's own permissions, and the connection is the host's.
- **The outside API changes**: the conformance suite against the sandbox, run by hand at each
  connector change, catches a broken mapping before a business does.

## Sources

Read 2026-11-24, in this repository: `AGENTS.md`, `CONTEXT.md`, `docs/architecture.md`,
`CONTRIBUTING.md` (Working in parallel), `docs/roadmap.md` (stage 33's row), `docs/parallel-work.md`,
stages 29, 31, 32, 34, 41, 44, 45, 47, 48 and 61, ADRs 0457 and 0880, and the code named in "What
exists today". There is no stage 33 spec yet.

Mindbody, read 2026-11-24 (the v6 documentation is a script-rendered site; per-endpoint parameters
and fields were taken from Mindbody's own SDK documentation, generated from the same API
description):

- Public API v6 documentation: authentication (API keys, `SiteId`, user tokens), base URL,
  pagination (`limit` default 100, at most 200), handling errors (429, at most 2,000 calls a
  minute), testing (sandbox site `-99`), accessing business data (live access, activation code and
  link), frequently asked questions (5,000 free calls a month then $0.002 a call for every call,
  webhooks free, failed calls counted, right-to-be-forgotten requests to support, v6 the current
  version): <https://developers.mindbodyonline.com/ui/documentation/public-api>
- Webhooks API (base URL, subscriptions, event types, `X-Mindbody-Signature`, delivery and retries,
  a daily full read recommended): <https://developers.mindbodyonline.com/ui/documentation/webhooks-api>
  and <https://developers.mindbodyonline.com/WebhooksDocumentation>
- SDK documentation (`doc/controllers/client.md`, `class.md`, `staff.md`, `site.md`, `sale.md`,
  `user-token.md`; `doc/models/client.md`, `class.md`, `visit.md`):
  <https://github.com/mindbody/Mindbody-API-SDKs>
- API Terms of Use, last updated 2023-09-30, §8.5, §8.11, §8.19:
  <https://developers.mindbodyonline.com/Resources/DeveloperAgreement>
- Release notes (no v7, no v6 deprecation): <https://developers.mindbodyonline.com/Resources/ApiReleaseNotes>

Not confirmed, and checked at build: whether reads other than clients and full staff work without a
user token; the user token's first lifetime (`Expires` is read); the largest `ClientIds` list on
`clientservices`; the largest date range on `class/classes`; whether class times carry an offset;
that one webhook subscription covers every site the developer account is activated on (inferred
from the payload's `siteId`).
