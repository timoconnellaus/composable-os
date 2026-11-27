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

## Amended 2026-11-27: a refresh whose answer was lost (issue #540, review of #548)
A device whose refresh reached the host but whose answer did not (the app killed mid-request, the
network lost) still holds the token it sent, and its next refresh used to count as reuse and end
the session: an unexplained sign-out on a phone.

- **The grace:** for `REFRESH_GRACE_MS` (60 seconds) after a rotation, the one refresh token it
  rotated past is answered with **the same tokens** it was answered with: never a second rotation,
  never a parallel session. Only that one token, only while those tokens are still the session's
  (nothing has rotated since). A token two rotations back, or the previous one after the window,
  ends the session at once, as before. Two refreshes racing with one token now both get the one
  rotation's answer instead of ending the session.
- **Nothing is stored as given.** The answer is kept sealed (AES-GCM) under a key derived
  (HKDF-SHA256, salted with the session id) from the previous refresh token, which is stored only as
  its hash (migration 1505: `previous_refresh_hash`, `previous_rotated_at`, `successor_sealed`).
  Only someone presenting that token can open it; a copy of the database cannot, and a forged
  token cannot.
- **Why 60 seconds:** the client gives up on a refresh after 15 seconds and the next call tries
  again at once (`tokenSession`, 2026-11-27), so a lost answer is retried within seconds; 60 leaves
  room for a slow network and an app reopened straight away. A device killed for longer comes back
  to a `refresh_reused` as before. Longer would widen what an old token is worth (below) for no
  case worth covering.
- **What a stolen old token is worth.** Within the window, the token just rotated past gets exactly
  what the current one would: the tokens the device holds. That is no more than stealing the
  current token, which today gets a rotation of its own. After the window, and for any older
  token, it ends the session for both holders, unchanged. Two holders sharing one session can only
  outlast reuse detection by each refreshing within 60 seconds of the other's rotation, which a
  thief cannot time: a device refreshes when its own access token is near its end, minutes apart.
- **A constant, not a setting.** Identity and policy are not AI-configurable (AGENTS.md); changing
  the window is a code change and a review.
