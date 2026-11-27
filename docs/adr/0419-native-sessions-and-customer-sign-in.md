# ADR 0419: Sessions for native apps, and customer sign-in on the host

Status: accepted, 2026-11-21 (stage 23 build, step 5). Builds part of
[ADR 0403](0403-http-surface-and-typed-client.md) and [ADR 0402](0402-staff-and-customers.md).

## Context
The stage 23 spec decided that a native app exchanges its sign-in for a short-lived access token
and a refresh token that rotates on every use, that a reused one ends the whole session, that a
session ends after a period without use (a product setting, 90 days, human admins only), that
tokens are for one audience, and that staff and customers list and end their own sessions by
device name. Stage 22 built customer sign-in by an emailed code and left its routes, and who sends
the code, to this stage. The review decided that the host itself sends codes, through an email
connection an admin chooses, and that no staff user is the sender.

## Decision

### Device sessions
- **`core_device_session`** (migration 0411) holds one row per session: its audience (`staff`
  with a user, or `customer` with an account, never both), the device's name, SHA-256 hashes of
  the current access and refresh tokens, the refresh hashes already used, and when it was made and
  last used. No token and no client address is stored. Deleting the user or the account deletes
  its sessions.
- **The exchange:** `POST /api/v1/auth/token { deviceName }` with a sign-in (a staff session, or
  a customer session cookie) returns `{ accessToken, refreshToken, accessExpiresAt, sessionId }`.
  The access token lasts ten minutes. `POST /api/v1/auth/refresh { refreshToken }` rotates both.
- **Rotation and reuse:** a refresh token already rotated past ends the session for every
  holder (`refresh_reused`). Two refreshes racing with one token end it too: only one rotation can
  match the stored hash. A token that was never the session's is refused and ends nothing.
- **Idle sessions:** a session whose last refresh is older than `deviceSession.settings`
  `idleDays` (90 by default; admins only, humans only) is ended when it is next presented.
- **One audience:** a bearer access token is its session's caller. A customer's token is that
  customer, so a staff operation answers it exactly as it answers no token. A staff token is that
  user, with the context the UI builds. When a bearer token is sent, no cookie is read.
  A disabled customer or a deactivated user is refused (`account_unavailable`).
- **Refusals are 401 with a reason:** `token_expired` (refresh it), `token_invalid`,
  `session_ended`, `session_idle`, `refresh_reused`, `account_unavailable`. The runtime's
  `tokenSession` refreshes before expiry, one refresh at a time, and forgets a session the host
  ended.
- **Listing and ending:** staff use `deviceSession.list` and `deviceSession.revoke` (their own
  only). A customer's `me.sessions.list` shows browser and device sessions with the device's name,
  and `me.sessions.revoke` and `me.signOut` end either kind. Disabling, deleting or erasing a
  customer account ends its device sessions.

### Customer sign-in on the host
- **`/api/customer-auth/*` is served** by cos-app (`handleCustomerAuth`), the routes stage 22
  built. Without `CUSTOMER_AUTH_SECRET` it answers 503: there are no customers.
- **The host sends the codes.** `customer.settings` gains `emailConnectionId`: the org
  email-send connection customer mail goes out from, chosen by a human admin and checked to be
  one that can send. Codes (and a declined erase request) go through it, called by the system
  user (`SYSTEM_USER`, actor `automation`, origin `system.customer-mail`), as the scheduled jobs
  are. cos-runner's integration host accepts the system user, which has no `core_user` row; only
  host code names it.
- **Until the connection is chosen,** a code request answers 503 "Customer sign-in is not set
  up", the same for every address, before any code is made. The rest of the surface works.
- **Code requests are limited** per email address asked for (`CUSTOMER_CODE_RATE_LIMIT`) and per
  client address (`CUSTOMER_CODE_ADDRESS_RATE_LIMIT`), keyed by a hash of the address with the
  customer secret, so no address is passed on or stored.

## Why
- Opaque random tokens with stored hashes make revocation immediate (a deleted row) and leak
  nothing from the table. A lookup per call is one indexed read.
- Ending the whole session on reuse is what makes a stolen refresh token useless once the owner's
  app refreshes, and the owner learns of it by being signed out.
- The system user keeps "who sent this" honest: no staff member's name is on a customer's code.

## Consequences
- The exchange does not end the cookie session it was made from; a native app signs out of it
  with Better Auth's route when it no longer needs it.
- A session's use is recorded at refresh, every ten minutes or so while the app runs, not on
  every call: no D1 write per call.
- Staff device sessions do not set the call's `origin.sessionId` (it groups pending actions for
  MCP sessions), so `deviceSession.list` marks none as current over a staff token.
- The admin UI does not yet have a picker for the customer mail connection; it is set with
  `customer.settings.update`.

## Amended 2026-11-27: a refresh whose answer was lost (issue #540, reviews of #548 and #554)
A device whose refresh reached the host but whose answer did not (the network lost, a request
given up after the client's 15 second limit) still holds the token it sent, and its next refresh
counted as reuse and ended the session: an unexplained sign-out on a phone.

**The rule.** The refresh token a rotation rotated past is answered again with **the same tokens**
(never a second rotation, never a new session) only when all of these hold:
- it is the token the session's last rotation rotated past;
- within `REFRESH_GRACE_MS` (60 seconds) of that rotation;
- that rotation's answer is **unused**: neither its access token nor its refresh token has been
  presented. A device that received its answer uses the access token at once (it refreshed because
  a call was waiting), and that first use closes the grace;
- the session has **never** been answered again before: once in a session's life.

Every such answer writes an audit row, `deviceSession.refreshReplayed` (the account, the session,
when, how long after the rotation; no token), which admins see in Settings → Audit log. It does not
change the session's last use, which the rotation moments before has just set. Any other
presentation of a token rotated past (after the window, after the answer was used, a second time,
a second grace in the session, or any older token) ends the session as reuse always has. Nothing
matches on the client's address or network: a changed network is how answers get lost.

**How the answer is kept.** Never as given. It is sealed with AES-GCM under a key derived
(HKDF-SHA256, salted with the session id) from the previous refresh token, which is stored only as
its hash, and bound to the session id and that hash (migration 1505). A copy of the database alone
opens nothing. **A copy of the database together with the previous refresh token could open it
until it is cleared:** at the answer's first use, at the grace answer, by the next rotation, and by
the daily maintenance run once the window has passed (a device that never comes back). After that
the copy and the token are worth nothing, as before.

**What is no longer detected, and what a replayed previous token gets.** Before this amendment,
presenting a token already rotated past always ended the session. Now, for a token the device has
just refreshed with and whose answer it has not yet used, a replay inside 60 seconds gets the
device's own new tokens, and nothing is ended:
- A thief who captured the token in transit (a proxy, a logged request) sees when the device used
  it, so it can time its replay into that moment.
- If the device's answer was lost, the thief gets the tokens and the device's own retry then ends
  the session: detected, as before, a moment later.
- If the device got its answer but has not yet used it, the two now hold the same live tokens and
  nothing is ended at once. The session ends at the next rotation, when the holder that did not
  rotate next presents the old tokens, normally within one access token's life (ten minutes). Until
  then the sharing is not detected, and only the audit row records it.
- A thief can do this once a session: a second grace is refused and ends the session.
- Outside the window, after the device's first call, and for any older token, nothing changed.

**Why 60 seconds.** The client gives up on a refresh after 15 seconds and the next call retries at
once, so a lost answer is retried within seconds; 60 leaves room for a slow network. An app killed
and reopened minutes later is not covered: it is signed out, as before. The use-closes-it and
once-a-session rules limit what the window gives a thief more than its length does.

**A constant, not a setting.** Identity and policy are not AI-configurable (AGENTS.md): changing
the window or the rule is a code change and a review.
