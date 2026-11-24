# ADR 0628: The staff calendar feed and the shared calendar writer

Status: accepted, 2026-11-24 (stage 45, build step 5). Amends
[ADR 0571](0571-a-calendar-file-made-by-the-email-gatekeeper.md) (the calendar writer moves to a
package of its own). Builds on [ADR 0621](0621-the-staffed-behaviour-and-the-time-claim.md) (the
time claim), [ADR 0625](0625-restricted-pack-permissions.md) (the tool's verified caller) and
[ADR 0626](0626-the-rostering-pack-and-bookings-additions.md) (the Rostering pack). Follows
[ADR 0645](0645-the-copy-and-the-signed-pdf-host-mail-and-a-second-attachment.md)'s layering: a
format two Workers share is a zero-dependency package, never core depending on a gatekeeper.

## Context
Decision 4 of stage 45: staff add their own shifts to their phone's calendar. The spec chose a
private feed per staff account over an emailed file per change ("Staff's own calendar: a private
feed"). A calendar app polls a feed on its own schedule and cannot sign in, so the address itself
is the credential: a bearer secret. The only iCalendar writer was the email gatekeeper's (ADR
0571), which the app cannot import without depending on a gatekeeper Worker.

## Decision
- **The writer is its own package**, `@composable-os/calendar-file` (`packages/calendar-file`, no
  dependencies): CRLF, lines folded at 75 octets without splitting a character, text escaped
  (backslash, semicolon, comma, newlines) after every control character but a tab is removed, values
  that are not text (an address, a link) stripped of every control character, times as UTC
  instants (so no VTIMEZONE, and the instant is right across a clock change), the same bytes for the
  same values. So no text can end its line: a title or place holding CR or LF cannot start a property
  or an event. The email gatekeeper's `calendar.ts` keeps what an email's event holds and writes it
  with the package; its file is unchanged line for line (its tests pass as they were).
- **The feed**: `GET /api/v1/staffing/feed/<token>.ics` (HEAD too; the screens offer it as
  `webcal://`), served by cos-app before the HTTP surface (`apps/app/src/server/http/staffing-feed.ts`);
  every path under `/api/v1/staffing/feed/` is answered there, so nothing else is reachable through
  it, and the client-app binding never serves it. It shows `readStaffFeed`
  (`packages/core/src/staffing/feed.ts`): the account's own live shifts from 14 days back to 120
  days ahead (the longest horizon a setting may make shifts for), at most 500, soonest first (past
  the cap, the furthest shifts drop off), read from the time
  claims (`core_staff_time`, by account and end), so a cancelled shift, one in the Trash and one now
  someone else's drop out. One event per shift: `UID` the shift's id at the host's name (stable, so a
  calendar replaces rather than duplicates), `SUMMARY` its kind of work (a class type's or duty's
  name, else the object's label), `LOCATION` its place, `DTSTART`/`DTEND` in UTC, `DTSTAMP` the shift's own
  start (amended below: never the record's last change), no `LAST-MODIFIED`,
  `SEQUENCE:0`, `STATUS:CONFIRMED`; the calendar is named "Shifts" with a one-hour refresh hint.
  Nothing else: never a class's own title (a business may type a member's name there), notes,
  another person's name, a class list, bookings or places, unavailability, offers or pay.
- **The token** is 32 random bytes, written base64url (43 characters), made by
  `staffing.feed.rotate` and shown once in its answer; the host keeps only its SHA-256
  (`core_staff_feed`, migration 0814: one row per account, the hash, the tool that made it, when). A
  lookup is by the hash, and the stored hash is compared again in constant time. Rotating replaces
  the row; the old address is dead at once.
- **Who**: making or rotating it is the person's own act at the screen (the tool `humanOnly`, and the
  verified caller a person): never an assistant, an MCP client, an automation or anyone for someone
  else. Revoking: the person, or an admin for anyone (never making one for them, which would hand
  the admin a secret of someone else's). Whether one exists (`staffing.feed.status`) is open to an
  assistant; it never holds the address. All three are tool-only operations Rostering's `feed`,
  `feedRotate` and `feedRevoke` (the team's tools) call.
- **It answers only while it should**: the account is an active person who may still call the tool
  that made it, in an installed, active, shipped pack. Deactivation deletes the row in its own batch
  (and reactivating brings nothing back); a change of role, pack role or grants that takes the tool
  away deletes it in that change's batch (`feedRevocations`), so the address stays dead if the
  access comes back. No staff erase exists; `staffing.forget` (not built) will delete it too, and
  deactivation always comes first.
- **One answer for every failure**: a made-up, malformed, rotated or revoked token, a deactivated
  person's and one without the permission all get the HTTP surface's own 404 for a missing route,
  with the same body (other headers differ: the feed's are private and never cached). Any other
  method gets 405.
- **Limits**: per client address (hashed with the auth secret, before any lookup) and per token
  (keyed by its hash), Workers Rate Limiting bindings `STAFF_FEED_ADDRESS_RATE_LIMIT` (120 a minute:
  a calendar provider fetches many people's feeds from few addresses) and `STAFF_FEED_RATE_LIMIT`
  (10 a minute); over either, 429 with `Retry-After`. A missing binding limits nothing and warns
  once, as every limit here does.
- **Headers** on every answer: `Cache-Control: private, no-store`, `X-Robots-Tag: noindex,
  nofollow, noarchive`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`,
  `Content-Security-Policy: default-src 'none'; sandbox`.
- **The secret is kept nowhere**: not in the audit log (the rotation's summary is `{ feed:
  "rotated" }`; the tool's has no id, so none), a notice, a tool run's record (operation names and
  outcomes only) or an error, and the route's one log line names the kind of failure only. A tool
  may now declare `redactResult` (keys of its answer the host never keeps, like an operation's,
  ADR 0626's `redact` for input): Rostering's `feedRotate` declares `path`, so an approval's
  stored result never hold it, and the HTTP surface stores no response for it (amended below).
- **Access**: the path is under `/api/v1/*`, which Access bypasses already; it is listed on its own in
  `access-layout.ts` and `docs/deploying.md`, saying how it authenticates.

## Why
A private feed always shows the roster as it stands, the regular pattern included, with no mail per
change (the spec's comparison). Reading from the time claims makes the feed the exact set of shifts
the database says the person is on, and bounds a fetch by the window, not the history. Making the
address only at the person's own hand keeps it out of every conversation, run and queue.

## Consequences
- The feed is not an operation any caller can name, so `open-operations.json` is unchanged: it is a
  credential-authenticated read of a fixed shape, as a device token's lookup is.
- A calendar app refreshes on its own schedule, often hours apart; the app is the truth. A revoked or
  rotated address leaves whatever a calendar last fetched on the phone, and it gets no more (most
  apps show the subscription as failing; none is told to delete events).
- **Cloudflare's own request logs** record a request's URL when Workers Logs are on
  (`observability` in `wrangler.jsonc`), so an account member reading them can see feed addresses,
  as with the guest order page's link. The host's code never logs it. A deployment that wants none
  there turns invocation logs off, or the person rotates.
- Not verified in real calendar apps: the file is checked line by line against RFC 5545 here; how
  each common calendar app treats `REFRESH-INTERVAL`, `METHOD:PUBLISH` in a subscription and a
  dropped event has not been tried.

## Proof
`packages/calendar-file/test/calendar-file.test.ts` (the format, injection, folding, UTC, determinism);
`packages/gatekeeper-email-send/test/calendar.test.ts` (the email file unchanged);
`packages/core/test/staffing-feed.test.ts` (what it shows, the tokens, who, leaving and losing the
permission); `packages/core/test/staffing-feed-cost.test.ts` (3,000 past shifts cost what none do);
`packages/core/test/http-idempotency.test.ts` (a stored reply redacted);
`packages/sdk/test/tool-redact-result.test.ts`; `apps/app/test/staffing-feed.test.ts` (the route:
the file, the one 404, headers, limits, no log, not through the binding);
`apps/runner/test/rostering.test.ts` (the shipped pack's tools in the real sandbox).

## Amended 2026-11-24, after the security review of PR #295
- **A rotate never outlives a revocation.** The rotate checks the account may have a feed and writes,
  before its row, a guard (`core_staff_guard`) that the account is as it read it (active, its role,
  pack role, grants and support grant): a rotate racing a deactivation or a change of what the
  account holds fails whole. A change of role, pack role or grants writes a guard that the feed it
  read is still the one there (none, or the same tool's), so a rotate committed between its read and
  its batch fails the change, which is made again. `user.reactivate` deletes the account's feed in
  its batch, so reactivating never brings one back.
- **A secret is never replayed.** An operation's answer with `redactResult` keys is sent to its call
  only: the HTTP surface stores the idempotency key without a response, so a retry with the same key
  is answered 409 `idempotency_response_lost` ("applied, but its response was not kept"), never a 200
  with a placeholder. This holds for every such operation (`media.videoUpload`'s one-time address
  too).
- **The pack that made a feed.** Disabled or quarantined, its feeds are paused (rows kept, nothing
  answers) and resume when it is enabled. Upgraded to a manifest without the tool that made a feed,
  or removed, its feeds are deleted, by triggers on `core_extensions` (migration 0814), so the tool
  coming back never brings an old address back. (There is no uninstall operation today; the trigger
  covers any removal of the row.)
- **`redactResult` is a shipped pack's.** A runtime extension declaring it fails `cos ext check` and
  install (`outside_audience`) and has it ignored at run time; and it never names the audit
  summary's own keys (`id`, `count`, `records`): the SDK's check refuses them and the host drops them.
- **A support user** (ADR 0212) has a feed only while its support grant is approved and unexpired,
  checked on every fetch as on every signed-in request.
- **DTSTAMP is the shift's own start**, and there is no LAST-MODIFIED. A record's `updated_at` can be
  moved by writes that are not the shift's (from the code a booking writes `core_capacity`, not the
  class row, but not every path was proven), and it would have told the feed's holder when; the
  shift's start says nothing else, and the bytes stay the same while the shift does.
- **The UID is `<record id>@<hostname>`**, the hostname the feed was fetched through: subscribing to
  the same feed through a second hostname gives the same shifts a second time in a calendar app.

## Amended 2026-11-24 (stage 49 step 1, ADRs 0760 and 0761)
A claim may be widened by minutes kept free around its shift (ADR 0760); the feed shows the
shift's own start and end, the claim's less its margins. It shows no title, so a shift that may
name a client (`staffed.private`, ADR 0761) needs nothing more: the feed carries no client names.
