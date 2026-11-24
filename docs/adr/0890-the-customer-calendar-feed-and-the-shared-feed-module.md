# ADR 0890: The customer calendar feed and the shared feed module

Status: accepted, 2026-11-24 (stage 62, build step 1). Amends
[ADR 0628](0628-the-staff-calendar-feed-and-the-shared-calendar-writer.md) (the staff feed's route
and token code become one module both feeds use). Builds on
[ADR 0402](0402-staff-and-customers.md) (customers, opening an operation is a reviewed change),
[ADR 0540](0540-the-family-link.md) (the family link) and
[ADR 0891](0891-calendar-entry-packs-declare-what-a-customer-feed-shows.md) (what the feed shows).

## Context
Stage 62's first piece: a member adds one private link to their phone's calendar and sees every
class, session and ticket they and their children have booked, kept current as they book, move and
cancel. Stage 45 step 5 already built a private feed for staff (ADR 0628): a bearer token in the
address, kept as a hash, one 404 for every failure, two rate limits, private headers. The spec chose
to generalise that machine rather than build a second one, and to keep the staff feed's behaviour
and bytes unchanged.

## Decision
- **One feed module.** In core, `packages/core/src/feeds/token.ts`: the token (32 random bytes,
  base64url), its SHA-256, the lookup by hash compared again in constant time
  (`lookUpFeedToken`), the window (14 days back, 120 ahead) and the cap (500 events). In cos-app,
  `apps/app/src/server/http/calendar-feed.ts` (`serveFeed`): GET and HEAD only, the limits per
  client address (hashed, before any lookup) and per token (keyed by its hash), the one 404 with
  the HTTP surface's body, ADR 0628's headers, the calendar writer's call (`UID`
  `<uid>@<hostname>`, `DTSTAMP` the event's own start, `SEQUENCE:0`, a one-hour refresh hint), a
  log line naming only the kind of failure, a 503 that never carries the token. Each feed is a
  `FeedRoute`: its prefix, PRODID, name, two bindings, log line and its read. The staff feed's
  route is that module with its old values; its tests pass unchanged.
- **Tokens stay apart.** Each feed keeps its own table: `core_staff_feed` (migration 0814) and
  `core_customer_feed` (migration 1350: `customer_id` primary key, cascading from
  `core_customer`, `token_hash` unique, `created_at`). A route looks only in its own, so a customer
  token on the staff route, and a staff token on the customer's, gets the 404 (tested both ways).
- **The customer's feed**: `GET /api/v1/me/feed/<token>.ics` (HEAD too; `webcal://` on the
  screens), served by cos-app before the HTTP surface, listed in `access-layout.ts` as bypassed
  (a calendar app cannot sign in), never through the client-app binding. Its limits are its own
  bindings, `CUSTOMER_FEED_RATE_LIMIT` (10 a minute per feed) and
  `CUSTOMER_FEED_ADDRESS_RATE_LIMIT` (120 a minute per address), so the two feeds never share a
  bucket. The calendar is named "Bookings"; PRODID `-//Composable OS//Customer calendar feed//EN`.
- **Checked on every fetch**: the token in `core_customer_feed`; its account `active` and
  `linked` to a Person. Then the events are read as that customer through the visibility seam
  (ADR 0891): their own records and a live dependant's (the family link is read live, so ending
  it drops a child's events on the next fetch), the declared fields only. A dependant's event
  starts with the child's first name ("Ava: Junior swim"), so a parent tells two children apart;
  an event with no name is "Booking at <business>" (the organisation's name, else "Booking").
  `UID` is `<object>.<id>@<hostname>`: unique across every object a pack declares, so a moved
  booking (a new record) shows as itself and the old one drops.
- **The operations** (open to `customer`, a reviewed change; `hostInternal`, as the session
  operations are: account bookkeeping on the caller's own account, taken from the principal):
  `me.calendarFeed.status` (whether one exists, when made; never the address),
  `me.calendarFeed.rotate` (a new address, replacing the old, shown once: `actors: ["human"]`, so a
  pack's tool run for the customer cannot make one; `redactResult: ["path"]` and an audit summary
  of `{ feed: "rotated" }`, so the address is in no audit row and no stored reply; written only
  while the account is still active and linked, so a rotate racing a disable leaves nothing) and
  `me.calendarFeed.revoke`. Staff: `customer.revokeCalendarFeed` (`users:manage`, as every
  `customer.*` operation; never makes or rotates one, which would hand them someone's secret).
- **Revoked with the account**, in that change's batch: `customer.disable` (so enabling never
  brings an old address back), `me.deleteAccount`, an erase of the Person (`queueEraseCustomers`)
  and a merge that deletes an account (the kept account keeps its own). The cascade from
  `core_customer` is the backstop.

## Why
A feed always shows the bookings as they stand, those staff made and a child's included, with no
file per change (the booking email's file stays). One module means one place where a feed's
secret is handled, so the second feed cannot drift from the first's guarantees. Reading as the
customer through the seam makes the feed exactly what the customer could read in the app, and no
more.

## Consequences
- The spec named `people:write` for `customer.revokeCalendarFeed`; no such permission exists, so it
  takes `users:manage` like the other `customer.*` operations. It is not kept to humans: an
  assistant's call waits for a person under the policy, as the spec's table says.
- The organisation's setting to show "Booking at <business>" instead of names (decision 10's
  switch) is step 2's; until then names show, and "Booking at" is only the fallback for an event
  with no name.
- One statement per declaring object, plus the account, the family and the registry: a fetch's
  count does not grow with a customer's history or family (a test), and each statement binds a
  handful of values.
- Cloudflare's request logs record URLs when Workers Logs are on (ADR 0628's note holds here too).
- Not verified in real calendar apps; how they refresh a subscription is ADR 0628's open item.

## Proof
`packages/core/test/customer-calendar-feed.test.ts` (what it shows, the operations, revocation,
the check against another pack, statement counts); `apps/app/test/customer-feed.test.ts` (the
route: the file, the one 404 for every failure and for the other feed's tokens, headers, limits,
no log, not through the binding); `apps/app/test/staffing-feed.test.ts` (unchanged, on the shared
module); `apps/app/test-node/access-layout.test.ts`.
