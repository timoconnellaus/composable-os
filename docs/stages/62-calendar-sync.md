# Stage 62: Calendar sync

Read first: [`AGENTS.md`](../../AGENTS.md), [`docs/architecture.md`](../architecture.md)
(Integrations, Behaviours), [`CONTEXT.md`](../../CONTEXT.md) (Connection, Integration host, Sharing
level, Gatekeeper, Outbound action, Customer account, Guardian, Shift, Qualified and Unavailable,
Offer and Take, Calendar feed), ADRs
[0007](../adr/0007-integrations-are-gatekeepers.md),
[0050](../adr/0050-integration-host-and-connections.md),
[0051](../adr/0051-outbound-approvals.md),
[0052](../adr/0052-email-calendar-sync.md), [0110](../adr/0110-integration-host-per-connection.md),
[0112](../adr/0112-email-calendar-sync-service.md),
[0113](../adr/0113-inbound-webhooks-and-integration-events.md),
[0402](../adr/0402-staff-and-customers.md), [0436](../adr/0436-pack-roles-and-the-door-role.md),
[0540](../adr/0540-the-family-link.md),
[0571](../adr/0571-a-calendar-file-made-by-the-email-gatekeeper.md),
[0600](../adr/0600-a-pack-role-and-its-grants-add-up.md),
[0621](../adr/0621-the-staffed-behaviour-and-the-time-claim.md) to
[0624](../adr/0624-the-rosters-notices-uncovered-shifts-and-leaving.md),
[0628](../adr/0628-the-staff-calendar-feed-and-the-shared-calendar-writer.md),
[0762](../adr/0762-open-hours-and-free-times.md); stages [45](45-rostering.md) (decision 7 and
"Built in step 5"), [47](47-pack-screens.md), 48 (My account, on PR #311 until merged) and
[49](49-appointments.md) (free times); code: `packages/calendar-file`,
`apps/app/src/server/http/staffing-feed.ts`, `packages/core/src/staffing/` (`feed.ts`,
`eligibility.ts`, `week.ts`, `index.ts`, `hours.ts`), `packages/core/src/operations/staffing-feed.ts`,
`packages/core/src/operations/integration.ts`, `apps/runner/src/integrations/` (`host.ts`, `sync.ts`,
`fake.ts`), `packages/gatekeeper-google/src/resources.ts` and `calendar-types.d.ts`,
`packages/gatekeeper-microsoft/src/calendar-scope.ts` and `calendar-types.d.ts`.

Status: **spec agreed** (2026-11-24). The owner was not interviewed: every question the draft
raised was decided the same day as best practice (the owner's standing rule), recorded below as
decisions 1 to 10. Build may start with steps 1 and 3.

This stage **amends stage 45's decision 7** ("outside commitments are ignored for now") for staff
who choose to connect their own calendar, and does it inside stage 49's line "two-way sync with
someone's own calendar" is out of scope: nothing here is two-way. Busy times are read, and the
host's own feeds are written; the host never writes into anyone's calendar in this stage.

## Status

- **Step 1** — built — PR #433 — The shared feed module, `calendarEntry` and the customer's feed (branch
  `feat/stage-62-feed`): built. Migration 1350 (`core_customer_feed`), ADRs 0890 and 0891 (ADR
  0628 amended with a dated note). The staff feed's token code and route are one module
  (`packages/core/src/feeds/token.ts`, `apps/app/src/server/http/calendar-feed.ts`); the staff
  feed's tests pass unchanged on it. `calendarEntry` in the SDK
  (`packages/sdk/src/calendar-entry.ts`), checked within a pack by `cos ext check` and into other
  packs' objects by the host (`customers/calendar-entry-check.ts`), refused to a runtime extension.
  `GET /api/v1/me/feed/<token>.ics` with its own bindings (`CUSTOMER_FEED_RATE_LIMIT`,
  `CUSTOMER_FEED_ADDRESS_RATE_LIMIT`), read as the customer through the visibility seam (their own
  and live dependants' records, a child's first name, "Booking at <business>" for an event with no
  name). `me.calendarFeed.status`, `.rotate` (`actors: ["human"]`, `redactResult`), `.revoke`
  opened to customers; `customer.revokeCalendarFeed` for staff (`users:manage`: the spec's
  `people:write` does not exist). Revoked in the batch of `customer.disable`, `me.deleteAccount`,
  an erase and a merge that deletes the account. Left for step 2: packs declaring
  `calendarEntry`, the "Your calendar" section and the names setting (until then names always
  show). Not tried in real calendar apps or on a live host. After the review of PR #433: a title or
  place past its first field must be public or signedIn on the related object (checked, and held by
  the read); a child's prefix is their given name and never drops an event; rotate refuses an
  account no longer active.

- **Step 2** — not built — needs: step 1 — Bookings and Ticketing declare `calendarEntry`; the "Your
  calendar" section (web and native) and the names setting.

- **Step 3** — not built — Busy times: `core_staff_busy` (1351), the `busy` purpose and pass, adapters,
  `staffing.busy.*`; the Google and Microsoft free/busy bindings.

- **Step 4** — not built — needs: step 3 — Rostering's busy tools and the My calendar blocks gain the
  connection and the switch.

- **Step 5** — not built — needs: step 3, stage 49 step 4 — The seam: `busy_elsewhere` in checks and
  writes, offers and candidates; `staffing.free` and the customer's check.

- **Step 6** — not built — needs: step 1, step 2, step 3, step 4, step 5 — Leaving, isolation suite, e2e
  journeys, the site and `SITE.md`.

## Goal

A member adds one private link to their phone's calendar and sees every class, one-to-one session
and event ticket they and their children have booked, kept up to date as they book, move and
cancel. A coach connects their own calendar once, with their own sign-in, and from then on the
times they are busy there (another job, study, a school run) are not offered to members for
one-to-ones, offers of shifts are not sent to them then, and whoever rosters them is warned. The
business never learns what those commitments are: only that the person is busy from 14:00 to
15:30. Staff keep the private shifts feed they already have (stage 45 step 5); this stage builds on
it and adds no second staff feed.

## Who it is for

- **Gyms and studios (first).** Coaches are often part-time with another job or study; today a
  one-to-one booked into their other commitments is found out on the day. Members want classes in
  their phone calendar without adding each confirmation file by hand. Parents want their children's
  classes beside their own.
- **Services businesses (next).** A practitioner who keeps a personal calendar for everything else
  needs those busy times to block online booking. Clients want their appointments in their
  calendar; a business whose service names are sensitive on a shared family calendar can turn the
  names off (decision 10). A tradesperson's day is mostly outside the business's records, so the
  busy read matters most there.

## What exists today (from the code, re-checked 2026-11-24)

- **The shared calendar writer**, `packages/calendar-file` (ADR 0628): RFC 5545 text with control
  characters removed before escaping, UTC instants, the same bytes for the same values. Used by the
  email gatekeeper's booking file (`packages/gatekeeper-email-send/src/calendar.ts`, ADR 0571) and
  the staff feed.
- **The staff calendar feed** (stage 45 step 5, ADR 0628, migration `0814_staff_feed.sql`):
  `GET /api/v1/staffing/feed/<token>.ics`, served by cos-app before the HTTP surface
  (`apps/app/src/server/http/staffing-feed.ts`), read by `packages/core/src/staffing/feed.ts` from the
  time claims, 120 days ahead, at most 500 shifts, title the kind of work, location the place, `UID`
  `<record id>@<hostname>`, `DTSTAMP` the shift's start. A 32-byte token kept as its SHA-256 in
  `core_staff_feed`; made and rotated only by the person (`staffing.feed.rotate`, tool-only,
  `humanOnly`, `redactResult`); revoked by them, an admin, deactivation or losing the tool; one 404
  for every failure; rate limits per address and per token; private, never-cached headers. Stage
  49 keeps an appointment's client off it (`staffed.private`). Rostering ships `rostering-my-calendar`
  and `rostering-native-my-calendar` blocks for it. **No customer feed exists.**
- **Booking emails carry a calendar file** (ADRs 0571, 0590): a later `SEQUENCE` for a change,
  `METHOD:CANCEL` for a cancellation. They stay.
- **Connections** (`packages/core/src/operations/integration.ts`, ADRs 0050, 0110): personal or
  org; `connection.create`, `completeConnect` (the `/connect/handoff` ticket and nonce),
  `bindResource`, `setSync`, `disconnect`. All `actors: ["human"]` and `records:write`, so an
  account holding a pack role (a coach, a cleaner) is refused every one of them
  (`packages/core/src/pack-roles.ts`). The staff feed shows the way round this: its operations are
  **tool-only** and Rostering's tools call them under `rostering:team`.
- **The integration host** (`apps/runner/src/integrations/host.ts`, a Durable Object per
  connection) runs sync passes from alarms. Sync kinds are `mail` and `calendar` (`SyncKind`,
  `sync.ts`); a calendar pass reads whole events and writes CRM meetings through `sync.ingest`. That
  path is for CRM timelines and must not be used for busy times.
- **Free/busy in the calendar gatekeepers** (vendored, `UPSTREAMS.md`). The draft's account of these
  was partly wrong; corrected here:
  - **Google** (`packages/gatekeeper-google`): `checkAvailability` returns busy blocks only, with an
    `availabilityMode` of `thisCalendar` (the bound calendar) or `allVisible`
    (`calendar-types.d.ts`). But the calendar resource's grant (`resources.ts`) asks for
    `calendar.events` (read and write every event) as well as `calendar.events.freebusy`, and the
    session also lists events. So **today a Google calendar connection is never a free/busy-only
    consent**: a busy-times connection needs its own grant asking only for free/busy and the
    calendar list.
  - **Microsoft** (`packages/gatekeeper-microsoft`): a calendar binding already has a detail level
    `freeBusy` ("free/busy only (times, no titles)", `calendar-scope.ts`), enforced by the
    gatekeeper (`calendar-events.ts`, `calendar-session.ts`); the `availability` binding kind is
    the organisation's directory view ("when people in the organization are free or busy"). The
    provider's permission is `Calendars.Read` at least (`microsoft-env.ts`): it has no
    free/busy-only permission, so for this provider the guarantee is the gatekeeper's binding.
- **Neither calendar gatekeeper has change notifications for calendars**; only mail has hooks
  (`gmail-hooks.ts`, `outlook-hooks.ts`). The fake provider's `subscribeChanges`
  (`apps/runner/src/integrations/fake.ts`) is the only calendar hook.
- **Staffing** (`packages/core/src/staffing/`): time claims, `core_staff_away`, the warnings
  `unavailable`, `not_qualified`, `uncovered` (`index.ts`, `week.ts`; stage 49 adds `client_busy`
  and `outside_hours`), eligibility for an offer (`eligibility.ts`: qualified, active, a profile, not
  away, free; `eligibleAccounts` decides who an offer is sent to).
- **Stage 49, Appointments (spec agreed)**: step 3, open hours (`core_staff_hours`,
  `staffing.hours.*`, `hours.ts`, ADR 0762, migration 1090), is built. Step 4, free times
  (`staffing.free`, a new `free.ts`) and the customer's check on a free time, is not. That read is
  the seam this stage plugs into.
- **Stage 48, My account (on PR #311)**: anything a customer sees is a section in My account
  (`me.portal`) and, where they must act, an attention kind. The customer's feed is a section there.

## Decided (2026-11-24)

Decided as best practice without asking (the owner's standing rule; `new-calendar-sync.decided.md`):

| # | Decision |
| --- | --- |
| 1 | How coaches report outside commitments today, and whether their calendars are personal or another employer's, is **checked with the business during setup**; the design does not depend on it |
| 2 | **A coach's busy time is hidden from members**: members see only times the coach is really free, never why a time is not free |
| 3 | **Staff booking or rostering over a busy time is allowed, with a warning** that the person's own calendar shows them busy, as the warning for time off works today |
| 4 | **An offer of a shift is not sent to people busy then**, but anyone who finds it may still take it |
| 5 | **Whoever rosters sees only a warning on the shift they are placing** ("busy then in their own calendar"): no blocks on the week, never what the commitment is |
| 6 | **Shifts are not written straight into staff calendars now**: the existing private link is enough. Writing into someone's calendar is deferred until staff ask |
| 7 | **Busy times are at most 10 minutes out of date**: each connected calendar is read every 10 minutes |
| 8 | **The member's link includes** class bookings, one-to-one sessions, event tickets, and their children's bookings for parents |
| 9 | **A business cannot require staff to connect their calendar.** It is each person's choice; whether it may be a condition of work is for the business to confirm with its lawyer |
| 10 | **The member's link shows the class's or session's name** ("Strength"), not only "Booking at" the business |

## The design in one page

**Two pieces, each usable alone.**

1. **The customer's calendar feed.** The staff feed's machine, generalised into one feed module both
   routes use, for a customer account: one private address per account, made by the customer's own
   act in My account, shown once, kept as a hash. It lists the customer's own live bookings and
   those of the children they are a live guardian of, from 14 days back to 120 days ahead. Which
   records appear is **declared by packs**: a new manifest key, `calendarEntry`, says an object's
   records are events in its customer's feed (start, end, a public title, a public place, the live
   states). Bookings declares it on class bookings and appointments, Ticketing on tickets. An event
   shows the class type's or service's public name, the room and the time, never another person.

2. **Busy times from a staff member's own calendar.** A staff member makes a **personal connection
   of the purpose "busy times"** and turns on **Use my busy times**. The integration host reads
   **free/busy only** for that calendar, through the gatekeeper's free/busy read (never an event
   list), from now to 120 days ahead, every 10 minutes, and hands the blocks to one host-only
   operation that replaces that person's stored blocks (`core_staff_busy`: account, start, end;
   nothing else). The host's staffing rules then use them:
   - **Free times (stage 49)**: `staffing.free` subtracts them, so members and visitors never see
     those times as free. Free times = open hours − time off − time claims (with margins) − rooms
     taken − **busy elsewhere**.
   - **Staff writes**: a write that puts the person on a shift or appointment over a busy block
     succeeds with a new warning, `busy_elsewhere`, as `unavailable` does. It never refuses.
   - **Offers**: an offer is not sent to someone busy then; they sort last among candidates. They
     may still take it.
   Consent is the person's: only they connect or turn it on; they or an admin may turn it off or
   disconnect; nobody else can make one. Turning it off, disconnecting, a failed read past its grace,
   leaving or losing the team tool deletes their blocks at once.

**Nothing new reaches a pack.** Packs declare `calendarEntry`; they never see busy times, a
connection or a feed token. Busy blocks are a core table in no `rec_*` view.

### What was weighed and rejected

| Option | Why not |
| --- | --- |
| **A second staff feed**, or rebuilding it | Stage 45 step 5 ships one. This stage moves its route code into a shared feed module and leaves its behaviour unchanged |
| **Reuse the CRM calendar sync** (`setSync`) for busy times | It reads whole events and writes them as CRM meetings; titles would pass through the host even at sharing level `none` |
| **Reuse the existing Google calendar grant** | It asks for `calendar.events` (every event, read and write). A busy-times connection asks the provider for free/busy and the calendar list only |
| **Store each outside event with its title hidden** | The host would hold what it promised not to. Only start and end are kept, and overlapping blocks are merged |
| **Provider change notifications** for busy times | Both providers send them only to an app that may read events. Polling free/busy every 10 minutes is one small read per person and keeps the consent narrow |
| **One admin consent reading the whole team's free/busy** | The consent would be the admin's, and many coaches' calendars are personal. Each person connects their own |
| **Busy elsewhere refuses a staff write** | A stale outside calendar would block the desk (decision 3) |
| **Grey blocks on the week grid** | Draws a picture of someone's private life (decision 5) |
| **Loosening `pack-roles.ts` so a coach may call `connection.*`** (the draft's plan) | Opens the generic connection operations to every pack role. Tool-only `staffing.busy.*` operations called by Rostering's tools, as the staff feed does, give the coach exactly this connection and nothing else |
| **The customer feed hard-codes classes** | Tickets, appointments and later packs would each need core changes; a declared key lets a pack add itself |
| **Email a file per change instead of a feed** | The file exists and stays; a feed also carries bookings made by staff, a child's bookings and changes the member missed |
| **Writing shifts straight into staff calendars** | Deferred (decision 6): needs a wider permission than free/busy and is the largest piece. The draft's design (a calendar the host makes, routine writes amending ADR 0051) is kept under Out of scope for when staff ask |

## Platform work and pack work

| Piece | Platform or pack | Notes |
| --- | --- | --- |
| The feed module: token, hash, lookup, rate limits, headers, the 404, the writer call; both routes use it | **Platform** (`apps/app/src/server/http/`, `packages/core/src/staffing/feed.ts` split) | The staff feed's behaviour and bytes unchanged (its tests are the check) |
| `calendarEntry` manifest key (`packages/sdk`, a new `calendar-entry.ts`), checked by `cos ext check` | **Platform** | A declared read, not a behaviour that hooks writes |
| The customer feed: `core_customer_feed`, `GET /api/v1/me/feed/<token>.ics`, `me.calendarFeed.*`, `customer.revokeCalendarFeed` | **Platform** (migration, route, `open-operations.json`) | Opening `me.calendarFeed.*` to `customer` is a reviewed change (ADR 0402) |
| Feed revoked on `me.deleteAccount`, `customer.disable`, `person.erase`; a child's events drop when the guardian link ends (the read is live) | **Platform** | In those operations' own batches |
| A "Your calendar" base section in My account (`web-account`, `native-account`), shown when `me.portal` finds a record of a `calendarEntry` object for the caller or a live dependant | **Platform** (stage 48's shell, base-layer blocks) | No attention kind: nothing for the customer to act on |
| A connection purpose `busy` and a sync kind `busy` in the integration host, with adapters for the fake provider and both calendar gatekeepers using only their free/busy reads | **Platform** (`host.ts`, `sync.ts`, `fake.ts`) | Its own alarm; never `sync.ingest` |
| Google: a free/busy-only calendar grant (free/busy and the calendar list, no `calendar.events`) and a session that answers only `checkAvailability` in `thisCalendar` mode. Microsoft: bind the chosen calendar at `freeBusy` detail | **Platform** (vendored code changed deliberately, noted in `UPSTREAMS.md` with a proposed upstream change **V5**) | The guarantee is the provider's permission (Google) or the binding (Microsoft), and also the host adapter's |
| `core_staff_busy`, `core_staff_busy_source`; `staffing.busy.*` (tool-only, `humanOnly` where the person acts) | **Platform** (migration; in no `rec_*` view) | |
| `busy_elsewhere` in `staffing.check`, staffed writes, `staffing.week`'s placing answer, offers and candidates; busy blocks in `staffing.free` and the customer's check | **Platform** (`packages/core/src/staffing/`) | The seam with stage 49 step 4 |
| Bookings declares `calendarEntry` on `bookings.booking` and `bookings.appointment` (when stage 49 step 5 lands); Ticketing on `ticketing.ticket` | **Pack** | One manifest block each |
| Rostering's tools `busyConnect`, `busyComplete`, `busySet`, `busyStatus`, `busyClear` (`rostering:team`); the My calendar blocks (web and native) gain the connection and the switch | **Pack** (`packs/rostering`) | The existing `rostering-my-calendar` blocks; web and native share the hook |

## The model

### Words
A **customer calendar feed** is the private address a customer's calendar subscribes to. **Busy
times** ("busy elsewhere") are blocks when a staff member's own calendar shows them busy: a start
and an end, nothing else. **Use my busy times** is the person's switch. _Avoid_: "availability"
(stage 45 says "away"), "sync" for busy times (the CRM's calendar sync is different), "push" (stage
30's push is phone notifications).

### Tables
- `core_customer_feed` (`customer_id` primary key, `token_hash` unique, `created_at`). One per
  customer account.
- `core_staff_busy` (`account`, `connection_id`, `starts_at`, `ends_at`, unix seconds, half-open),
  indexed by account and end; replaced whole for the person and window on each read; never in a
  `rec_*` view, an export, the search index, an event payload or the audit log (the audit records
  "busy times read: 12 blocks").
- `core_staff_busy_source` (`account` primary key, `connection_id`, `calendar_ref`, `on_since`,
  `last_read_at`, `last_ok_at`, `last_error`): the switch, one connected calendar per person.
- No new extension records. Neither table touches `core_write_guard` or an `x_*` table.

### `calendarEntry`

```ts
calendarEntry: {
  starts: "class.startsAt",     // a datetime path: a field, or one relation to a field
  ends: "class.endsAt",
  title: "classType.name",       // must be a public field of the related object
  place?: "class.room.name",     // the same rule
  live: ["booked", "attended"],  // the states that show
}
```

- Only on an object with a `customer` key (whose customer is the feed's owner, and, where the object
  opens to guardians, a live dependant's guardian). Shipped packs only; a runtime extension declaring
  it fails `cos ext check`, as `portal` and `screens` do.
- Every path must end at a field the object's customer read list holds or the related object makes
  `public`; anything else fails the check. The feed never reads a field the customer could not read.
- A record in a live state shows; leaving the live states (cancelled, moved) drops it on the next
  fetch. Calendar apps replace by `UID` (`<object>.<id>@<hostname>`), so a move shows as the new
  record and the old one disappears.

### The customer feed
- `GET /api/v1/me/feed/<token>.ics` (also `webcal://`), served by cos-app through the shared feed
  module, from 14 days back to 120 days ahead, at most 500 events, soonest first.
- Each event: the title (the declared public name, or "Booking at <business>" when the
  organisation's setting is off, decision 10's switch), the place, start and end, `DTSTAMP` the
  event's start, `SEQUENCE:0`. No other person, no price, no note, no order. A dependant's event is
  prefixed with the child's first name ("Ava: Junior swim") so a parent can tell two children apart.
- Checked on every fetch: the account active and not disabled; dependants through the live guardian
  link (ADR 0540); each record through the visibility seam as the customer.
- The same 404 for unknown, malformed, rotated, revoked, disabled and deleted; the headers and rate
  limits of ADR 0628, with their own settings (`CUSTOMER_FEED_ADDRESS_RATE_LIMIT`,
  `CUSTOMER_FEED_RATE_LIMIT`). A staff token is never looked up on the customer route, nor the
  reverse (separate tables; a test).

### How the busy read works
1. In My calendar the person chooses their calendar provider and signs in with it (the usual
   connect handoff; the native app opens the system browser and returns), then picks one of their
   own calendars (their main calendar by default).
2. The host binds it free/busy only and records the switch. The integration host schedules a busy
   pass: read free/busy from now to 120 days ahead in 31-day chunks, merge overlaps, drop blocks
   under 5 minutes, cap at 2,000 blocks, and call `staffing.busy.replace`.
3. Passes repeat every 10 minutes (decision 7) and on "refresh now" from the person (at most once a
   minute). Whatever the provider reports as busy counts (tentative included); free does not.
4. A failed read keeps the last blocks for 24 hours, then deletes them and tells the person ("we
   can't read your calendar; members can book you at times you may be busy"); a rosterer sees only
   "busy times not current". An expired sign-in asks the person to sign in again.
5. Off, disconnect, deactivation, losing the team tool: the rows and the source are deleted in that
   change's batch.

### Writes and warnings
- **Customer appointment (stage 49)**: `staffing.free` never answers a time whose claim, with the
  service's margins, overlaps a busy block; the customer's check refuses one the same way, answering
  only that the time is no longer free.
- **Staff writes**: every staffed write (a class's coach, a duty, an appointment, assign, take) and
  `staffing.check` answer `busy_elsewhere` ("<name>'s own calendar shows them busy then") beside
  `unavailable`; never refused (ADR 0622's warnings).
- **Offers**: `eligibleAccounts` leaves out anyone busy over the shift; a named offer to a busy
  person warns the offerer; candidate lists sort busy people last. `staffing.take` by a busy person
  succeeds with the warning.
- **Generation** (recurring) is unchanged: it never fails on a clash and warns.

### Operations

| Name | Audience | Who may | Risk |
| --- | --- | --- | --- |
| `me.calendarFeed.rotate` | **customer** (opened, reviewed) | the signed-in customer, for their own account only, a person (`humanOnly`) | write; the address in the answer only (`redactResult`) |
| `me.calendarFeed.status`, `me.calendarFeed.revoke` | customer | the signed-in customer | read / write |
| `customer.revokeCalendarFeed` | staff | `people:write`; never makes or rotates one | write |
| `staffing.busy.connect`, `staffing.busy.complete` (a personal connection of purpose `busy`; wrappers over `connection.create`, `completeConnect` and `bindResource` with the purpose and the free/busy binding fixed) | staff, tool-only | the person themselves, `humanOnly`, pack-role accounts included through Rostering's tools | write |
| `staffing.busy.set { on }`, `staffing.busy.refresh` | staff, tool-only | the person themselves, `humanOnly` | write |
| `staffing.busy.replace` | none (host-only, the integration host's system caller) | the host | write |
| `staffing.busy.status` | staff, tool-only | the person (their blocks, last read); a rosterer (on or off, current or not; never the blocks); open to an assistant without the blocks | read |
| `staffing.busy.clear` | staff, tool-only | the person; an admin for anyone (turns off and disconnects; never connects) | destructive |
| `staffing.free`, `staffing.check`, `staffing.week`, offers, `staffing.take` | as stages 45 and 49 | unchanged | read / write |

Rostering's tools call them under `rostering:team`, so a coach, a cleaner and anyone with the team
role reach them in the app and in the admin (stage 47). The generic `connection.*` operations stay
refused to pack roles; Settings → Integrations lists the connection among the person's own.

### Screens
- **My calendar** (Rostering's existing blocks, web and native, a declared screen per stage 47):
  the staff feed as today; connect my calendar; use my busy times on or off; last read; refresh;
  disconnect; a line saying the business sees only that they are busy, never what.
- **Rosterers**: the assign panel shows `busy_elsewhere` on the shift being placed; the week grid
  shows it as a warning on a placed shift only.
- **Customers**: the "Your calendar" section in My account: make the link, copy it or open it as
  `webcal://`, make a new one (the old stops), turn off; a line saying it is private and anyone with
  it sees the bookings.
- **Settings**: the organisation's "show class and session names in members' calendars" (on).

### Notifications
- To the person (the host's staff notices): busy times could not be read (at most once a day); the
  calendar needs signing in again.
- To rosterers: none per block; the daily uncovered-shifts notice is unchanged.
- To customers: none (making a link is their own act on screen).

### What an AI may do

| Action | How |
| --- | --- |
| Read whether someone uses busy times and whether they are current | applied (the caller's reach) |
| See `busy_elsewhere` warnings and free times that exclude busy blocks | applied |
| Read anyone's busy blocks | never (the person only, on screen) |
| Connect a calendar, turn busy times on, make or rotate a feed | never (`humanOnly`) |
| Revoke a feed, turn busy times off, clear | waits for a person under Balanced |

### Privacy and erase
- **Busy blocks** are seen in detail only by the person. No title, place, attendee or description is
  ever requested, kept or logged.
- **The feeds** are bearer secrets: hashed, shown once, rate limited, one 404, ADR 0628's headers.
  Cloudflare's request logs record URLs when Workers Logs are on (ADR 0628 says so already).
- **Erase** of a customer's Person deletes their feed row in the erase batch. **Account deletion**
  and **disabling** delete it. **Merge** moves nothing (the surviving account keeps its own).
- **Leaving** (`user.deactivate`): busy rows and the source deleted, the connection disconnected, in
  that batch; the staff feed is revoked as today.
- **Audited**: connect, the switch, disconnect, clear, feed made, rotated and revoked (never the
  address), each busy read as a count.
- Whether the business must tell staff or customers anything about these reads is for the business
  to confirm with its lawyer.

## Out of scope (deferred)
- **Writing shifts straight into a staff member's calendar** (decision 6). When staff ask: a
  calendar the host makes in their account ("Work at <business>"), fixed-shape events only, sent
  without approval as routine writes (a new ADR amending 0051 as 0590 did), its own switch and a
  wider permission.
- Inbound change notifications from calendar providers (needs permission to read events).
- Customers connecting their calendar; writing bookings into a customer's calendar.
- Busy times for outside practitioners (stage 49 step 7 gives them accounts; they may use the same
  piece later, after stage 43's consent work) and for rooms.
- A team-wide connection reading everyone's free/busy; outside working hours as open hours.
- Several connected calendars per person; a feed per child.
- A public feed of the timetable or events (stage 57 defers it; it should reuse this stage's feed
  module, not build a third).

## Acceptance criteria
1. A customer makes a feed in My account; the address is shown once; the host keeps only its hash;
   the route returns their live bookings (classes and tickets; appointments once stage 49 step 5 is
   built) from 14 days back to 120 days ahead, with the public title and place only.
2. With the organisation's names setting off, every event's title is "Booking at <business>".
3. A guardian's feed includes a live dependant's bookings with the child's first name; ending the
   link drops them on the next fetch; the dependant's own account, if any, has its own feed.
4. A rotated, revoked, malformed, disabled or deleted account's token gets the same 404 as a
   missing route; limits and headers as ADR 0628; a customer token on the staff route, and the
   reverse, gets the 404.
5. The staff feed's tests pass unchanged on the shared feed module.
6. `calendarEntry` on an object without `customer`, on a runtime extension, or with a path to a
   field outside the customer's read list or the related object's public fields fails
   `cos ext check`.
7. A staff member, including one holding only a pack role, connects their own calendar and turns on
   busy times; nobody else can do either for them (an admin, the assistant, an MCP client, an
   automation); a pack-role account still cannot call `connection.*`.
8. The busy pass calls only the gatekeeper's free/busy read. A test with a fake provider whose
   events carry titles, places and attendees proves none reaches D1, logs, the audit log or an
   event (`core_integration_event` unchanged). The Google busy grant asks for no `calendar.events`
   scope.
9. A busy block hides every overlapping start time from `staffing.free`, and a customer's create at
   such a time is refused as no longer free.
10. A staff write over a busy block succeeds with `busy_elsewhere`; an offer is not sent to a busy
    person; a busy person may still take it.
11. A rosterer and the assistant can read whether busy times are on and current, never the blocks.
12. Turning off, disconnecting, deactivation, losing the team tool and a failed read past 24 hours
    each delete the person's busy rows in that change's batch.
13. The isolation suite covers both feeds and the busy tables; one e2e journey per side: a member
    adds the link; a coach connects (fake provider) and a member cannot book over their busy time.

## Dependencies
- **Built**: stage 6 (integrations, the integration host), 22 (customers), 31a (bookings, the family
  link), 45 (staffed, offers, the staff feed, the My calendar blocks), 47 (pack screens).
- **Stage 48, My account** (PR #311): the "Your calendar" section needs its shell and `me.portal`.
  Until then step 2's block ships in the Bookings pages it would sit beside.
- **Stage 49, Appointments**: the free-times half of step 5 waits for its step 4; appointments in
  the feed wait for its step 5. Nothing else here waits for it.
- **Real provider accounts**: the deployment's own app registration with each calendar provider,
  including any review of the free/busy permission by the provider.

## Migrations and numbers
Block **BX**: migrations **1350–1369**, ADRs **0890–0899**. Expected migrations: 1350
`core_customer_feed`; 1351 `core_staff_busy` and `core_staff_busy_source`. ADRs the build will need
(not written until built):
1. **0890** The customer calendar feed and the shared feed module (amends 0628).
2. **0891** `calendarEntry`: packs declare what appears in a customer's feed.
3. **0892** Busy times: the `busy` purpose, the free/busy-only grant and binding, polling, the
   person's consent, what is kept (amends 0050 and 0112; amends stage 45's decision 7 with a dated
   note).
4. **0893** Busy elsewhere in the staffing rules: free times, the warning, offers (amends 0622, 0623
   and 0762).
5. **0894** Connecting from a pack role through tool-only operations (amends 0436 and 0600).

## Suggested build order

| Step | What | Touches | Beside |
| --- | --- | --- | --- |
| 1 | The shared feed module; `calendarEntry` in the SDK and `cos ext check`; `core_customer_feed` (1350); `me.calendarFeed.*`, `customer.revokeCalendarFeed`; the route; revocation on deletion, disabling and erase | `packages/sdk`, `packages/extension-check`, `packages/core/src/staffing/feed.ts`, `packages/core/src/operations/` (`me.ts`, `customer.ts`), `apps/app/src/server/http/`, `open-operations.json` | 3. **Collides** with any staff feed change, and with erase or account-deletion work (the "erase completeness" area) |
| 2 | Bookings and Ticketing declare `calendarEntry`; the "Your calendar" section (web and native) and the names setting | `packs/bookings`, `packs/ticketing`, base-layer blocks | 3, 4. **Collides** with stage 49 steps 5 to 8 (`packs/bookings`) and stage 48's shell work |
| 3 | Busy times: `core_staff_busy` (1351), the `busy` purpose and pass, adapters (fake first), `staffing.busy.*`; the Google free/busy grant and the Microsoft `freeBusy` binding, noted in `UPSTREAMS.md` (V5) | `apps/runner/src/integrations/` (`host.ts`, `sync.ts`, `fake.ts`), `packages/core/src/operations/integration.ts`, `packages/core/src/staffing/`, `packages/gatekeeper-google`, `packages/gatekeeper-microsoft` | 1, 2. **Collides** with any integration host, sync service or vendored gatekeeper work |
| 4 | Rostering's busy tools and the My calendar blocks gain the connection and the switch | `packs/rostering` (tools, `rostering-my-calendar`, `rostering-native-my-calendar`) | 1, 2; after 3. Collides with Rostering block work and stage 58's screens in `packs/rostering` |
| 5 | The seam: `busy_elsewhere` in checks and writes, offers and candidates; then `staffing.free` and the customer's check once stage 49 step 4 lands | `packages/core/src/staffing/` (`index.ts`, `eligibility.ts`, `week.ts`, stage 49's `free.ts`), `operations/staffing.ts` | 1, 2; after 3. **Collides** with stage 49 steps 1 and 4 and stage 58 work in `staffing/` |
| 6 | Leaving, isolation suite, e2e journeys, the site and `SITE.md` | `staffing/leaving.ts`, tests, `apps/marketing` | after 1 to 5 |

**Size: medium.** Up to two build sessions at once: steps 1 and 3 can start now; then 2, 4 and 5.

## Decided by this spec, open to override
1. Busy times are read **free/busy only**, by polling; no provider change notifications.
2. **One connected calendar per person**, their main calendar by default; whatever the provider
   reports as busy counts, tentative included.
3. A failed read keeps the last blocks **24 hours**, then deletes them and tells the person.
4. Busy blocks under 5 minutes are dropped; at most 2,000 per person; 120 days ahead.
5. The customer feed is **made by the customer only** (staff may revoke, never make), covers 14 days
   back to 120 ahead, and is served at the host's address.
6. **Names on, with an organisation setting to turn them off** (decision 10 kept as the default; a
   clinic may want "Booking at <business>").
7. A dependant's events carry the child's first name.
8. Which records appear is declared by packs (`calendarEntry`), shipped packs only.
9. A coach connects through **tool-only `staffing.busy.*` operations** called by Rostering's tools,
   not by loosening `pack-roles.ts` (a correction of the draft).
10. The Google busy-times connection uses **its own grant** without `calendar.events`; Microsoft's
    uses the existing `freeBusy` detail level (a correction of the draft, which said the reverse).
11. The customer's link is a base section of My account with no attention kind.
12. "Refresh now" at most once a minute.

## Questions for the owner
None. Decision 1 (how coaches report outside commitments today) is checked with the business
during setup.

## Risks
- **Privacy**: the promise is "never titles". For Google the permission itself is free/busy only;
  for Microsoft the gatekeeper's binding holds it, so a mistake in our code could read more. The
  titled fake-provider test, the binding, and a security review of step 3 are required. Free times
  reveal when a coach is busy to anyone looking; rate limits and stage 49's bounded range limit it.
- **Security**: two bearer-secret feeds; a forwarded customer link shows their schedule and a
  child's. Rotation and revoke on screen; one 404; no other person's name.
- **Consent drift**: a coach who leaves must stop being read at once (step 6's test).
- **Money**: none moves. A busy block never cancels or refunds anything.
- **Needs real accounts and devices**: both providers' app registrations; how Microsoft's free/busy
  behaves for a personal (not work) account; how common calendar apps refresh a subscribed feed
  (ADR 0628's open item); the connect handoff from the native app.
- **Cost**: 30 staff read every 10 minutes is about 4,300 small reads a day, under each provider's
  per-user limits (to verify on a real account).
