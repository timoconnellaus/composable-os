# ADR 0455: Staff invites, and native sign-in that answers with tokens

Status: accepted, 2026-11-21 (`fix/staff-invites-and-native-sign-in`, the first client's identity
gaps). Builds on ADRs [0402](0402-staff-and-customers.md),
[0419](0419-native-sessions-and-customer-sign-in.md),
[0421](0421-the-client-app-binding-and-customer-sign-in.md),
[0436](0436-pack-roles-and-the-door-role.md) and
[0449](0449-permissions-granted-one-by-one.md). Ahead of stage 14a
([ADR 0245](0245-roles-teams-and-identity-seams.md)), which builds on it.

## The routes (fixed first: the mobile template signs in against them)

All are under the HTTP surface, `POST`, JSON in and out, in the surface's envelope (`{ "data" }` or
`{ "error": { code, message, details } }`). **None of them sets a cookie, and none reads one.** A
request with an `Authorization` header is refused. They are not served over the client-app binding
(ADR 0421: the native token routes stay off it).

| Route | Body | 200 answer |
| --- | --- | --- |
| `/api/v1/auth/customer/code` | `{ email }` | `{ data: { ok: true } }` |
| `/api/v1/auth/customer/sign-in` | `{ email, code, deviceName }` | `{ data: { accessToken, refreshToken, accessExpiresAt, sessionId, account } }`, `account` is `"ready"` or `"needs_attention"` |
| `/api/v1/auth/staff/code` | `{ email }` | `{ data: { ok: true } }` |
| `/api/v1/auth/staff/sign-in` | `{ email, code, deviceName }` | `{ data: { accessToken, refreshToken, accessExpiresAt, sessionId } }` |
| `/api/v1/auth/staff/exchange` | `{ code, codeVerifier, redirectUri, deviceName }` | the staff tokens, as above |
| `/api/v1/auth/refresh` (ADR 0419, unchanged) | `{ refreshToken }` | the rotated tokens |
| `/api/v1/auth/sign-out` | `{ refreshToken }` | `{ data: { ok: true } }`, whether or not the token was a live session's |

`/auth/sign-out` ends that one device session (staff or customer) when the token is its current
refresh token or one already rotated past; the token is spent and cannot refresh. It is audited
(`core_audit`, operation `deviceSession.signOut`). It exists because an account with a pack role
may call no operation but its role's, so it cannot sign out with `deviceSession.revoke` or
`me.signOut`. Sign-in attempts, exchanges and sign-outs are limited per client address on the
`CUSTOMER_CODE_ADDRESS_RATE_LIMIT` binding (a hash of the address, key `auth-from:`).

Refusals:
- A code request answers `{ ok: true }` whoever the address is. Over a limit: `429 rate_limited`
  (`retryAfterSeconds`). Sign-in not set up (no mail connection; for customers also no
  `CUSTOMER_AUTH_SECRET`): `503`, code `forbidden`, `details.reason: "sign_in_not_set_up"`, the
  same for every address. A malformed body: `400 invalid_input`.
- A sign-in or exchange that fails for any reason (a wrong, expired, used or too-often-tried code,
  no account and no invite, a disabled account, a wrong verifier) answers `401 forbidden`,
  `details.reason: "invalid_code"`, one message.

And one page, for staff whose sign-in is browser-based (Google, Cloudflare Access):
`GET /native/staff-sign-in?redirect_uri=…&code_challenge=…&code_challenge_method=S256&state=…`.
It is a staff page (behind Access; with Better Auth it sends a signed-out browser to `/sign-in`
first). Signed in, it redirects to `redirect_uri?code=…&state=…`: a one-time code that lives 60
seconds. `redirect_uri` must be listed, exactly, in `NATIVE_REDIRECT_URIS` (a var; unset, the page
answers 404).

The runtime client wraps all of this: `tokenSession(...).requestCode(email, audience)`,
`.signInWithCode(email, code, deviceName, audience)`, `.signOut()` (posts `/auth/sign-out` with
the stored refresh token and clears the store even when the call fails), `startBrowserSignIn(...)`
and `.finishBrowserSignIn(...)` (`@composable-os/client`).

## Context
- A host on the built-in sign-in (Better Auth) had no way to add a second staff account without
  opening sign-up to anyone (`AUTH_ALLOW_SIGNUP=true`). The first client needs its owner as admin
  and its coaches as staff with a pack role.
- A native app signed in at the cookie routes and exchanged the cookie for tokens
  (`/api/v1/auth/token`). React Native's `fetch` may not expose `set-cookie`, and its cookie jar may
  then send the cookie on later calls. That is why "customer cookies never live on the host's
  address" rested on configuration (ADR 0421's amendment, issue #151).
- Disabling a staff account (`user.deactivate`) deleted its cookie sessions but not its device
  sessions: calls were refused while it was disabled, but reactivating it brought the old device
  sessions back to life.

## Decision

### Staff invites
- **`user.invite { email, role, packRole?, permissions? }`**, `user.invites`,
  `user.updateInvite { id, role, packRole?, permissions? }` and `user.revokeInvite { id }`:
  `users:manage`, `actors: ["human"]`, not on MCP, audited (object `user_invite`, before and after).
  The pack role and grants are checked as `user.setPackRole` and `user.setPermissions` check them; a
  pack role makes the role `viewer`, and an admin invite takes neither.
- **`core_user_invite`** (migration 0490): the address (lower case), the role, pack role and grants
  the account will hold from the start, who invited, when it expires (7 days), and when it was
  accepted or revoked. One pending invite per address (a partial unique index); inviting again
  replaces the pending one. An address that already has an account cannot be invited (`conflict`).
  The plan's user limit (ADR 0211) is checked at invite and again at accept.
- **The invite email holds no secret.** It says who invited them and where to sign in, and goes out
  after the invite is stored, from the host. The invite is bound to its address by the sign-in
  code, which only goes to that address.
- **Sign-in by an emailed code, for staff** (Better Auth's email OTP plugin on the staff
  configuration, codes hashed, six digits, five minutes, three tries):
  - A code is sent to an address with a **pending, unexpired invite and no account**, or to an
    **active account whose address is verified** (made by an invite, or by Google). Anyone else
    gets the same answer and no code is kept: an unverified password account, a deactivated or
    support account, an unknown address.
  - Signing in with an invite's code creates the account with the invite's role, pack role and
    grants in the same insert, and marks the invite accepted in the same check: an expired,
    revoked or accepted invite creates nothing. Only the code sign-in can create an account from an
    invite: password sign-up and Google sign-up stay closed (`AUTH_ALLOW_SIGNUP` stays `false`).
  - An invite never touches an existing account: it is refused when the address has one, and an
    account made meanwhile (by Google) is signed in to as itself, without the invite's role.
  - Only two of the plugin's routes are served: `/api/auth/email-otp/send-verification-otp` and
    `/api/auth/sign-in/email-otp`. Password reset and email change by code are not.
  - Every failed code sign-in answers one way (`INVALID_OTP`), so "expired" or "too many tries"
    never says a code existed. The customer routes answer the same way now.
  - Code requests are limited per address asked for and per client address, on the customer
    bindings and with the same keys for the address asked for: one inbox has one limit.
- **Who sends staff mail.** The host itself, through the email-send gatekeeper, as the system user
  (`hostMailCall`, origin `system.staff-mail`), on the one connection a human admin chose for the
  host's mail: the setting customer mail already uses (`customer.settings` `emailConnectionId`).
  One sender is simpler than two and gives one place to check and audit; the setting is shown as
  the host's mail connection in Settings → Users. Until it is set, a staff code request answers
  `sign_in_not_set_up` and `user.invite` says the invite email was not sent.
  The connection's send kind must apply without review (Settings → Integrations, outbound
  auto-approval). **A code whose send does not end as sent (queued for review, or failed) is
  deleted at once**, staff and customer alike, as for an address that may not get one: otherwise
  its text would sit in the Approvals preview, and whoever approved it could sign in as that
  address, under another person's name in the audit log. The answer is the same either way.
- **The code is not in the subject.** The send's title (`Send email: <subject>`) is kept in the
  audit row of `integration.outbound` for the audit retention, so the subject is "Your <product>
  sign-in code" and the code is in the body only.
- **Disabling ends every session.** `user.deactivate` deletes the account's device sessions with
  its cookie sessions, so reactivating does not revive them.
- **Under Cloudflare Access** Access decides who gets in and the host decides what they hold. An
  invite sends no code and no email (there is nothing to sign in to on the host): the person is
  added to the Access policy, and on their first request the account is made with the invite's
  role, pack role and grants (`resolveActingUser`), and the invite is accepted. Without an invite a
  first request is a member, as before.
- **Settings → Users** lists accounts and pending invites, and lets a human admin invite, change or
  revoke an invite, and set an account's pack role and grants (stage 41 left grants without a
  screen). If another branch adds a grants control there, this one stays.

### Native sign-in returns tokens
- The routes above verify the code through the same Better Auth configuration and hooks as the
  browser routes (who may get a code, linking a customer to their Person, the invite), then delete
  the cookie session that made and answer with a device session's tokens. No `Set-Cookie` is sent.
  The browser routes are unchanged and never answer with tokens.
- Everything ADR 0419 decided holds: only hashes are stored, every refresh rotates, a reused
  refresh token ends the session, the idle setting ends an unused one.
- **Browser-based staff sign-in** (Google, Access) runs in the system browser (an ephemeral
  `ASWebAuthenticationSession` or Custom Tab), never a web view: its cookies are the browser's,
  not the app's. The app makes a verifier, sends its S256 challenge to `/native/staff-sign-in`, and
  exchanges the code it is sent back, with the verifier, at `/api/v1/auth/staff/exchange`. The code
  is stored as a hash (`core_native_handoff`, migration 0490), is deleted when presented (right
  or wrong), lives 60 seconds, and is bound to the challenge and the redirect address. The runtime
  takes the app's `randomKey` and `sha256`: React Native has no `crypto`.
- `/api/v1/auth/token` (exchanging a cookie session for tokens) stays for apps already using it;
  new apps use the routes above.

## Why
- An invite is the smallest thing that adds a known person with a known role without opening
  sign-up. Binding it by the code sent to the address, not by a link token, means nothing secret is
  in the invite email and there is one way in.
- Using Better Auth's code plugin for staff keeps one session store, one cookie and one set of
  hooks; serving only two of its routes keeps its other flows closed.
- Answering a native sign-in with tokens removes the cookie from the app entirely, so cookies apart
  no longer rests on a phone's `fetch`.

## Stage 14a
Stage 14a's invites (`docs/stages/14-teams-permissions.md`) are these: it adds teams to an invite
(`core_user_invite` gains them) and its fuller roles replace `role` and `pack_role` on the invite as
they do on the account. Accepting stays the code sign-in, or the first request under Access. Seat
counting already happens at invite and accept.

## Proof
Tests: `packages/auth/test/staff-codes.test.ts` (the staff code sign-in through the real Better
Auth configuration), `packages/core/test/staff-invites.test.ts` (the operations, and Access),
`apps/app/test/native-sign-in.test.ts` (the native routes against the real host, with a phone that
has no cookie jar), `packages/client-gen/test/targets.test.ts` (the runtime in the stand-in React
Native context: only ECMAScript's globals, `fetch` and `setTimeout`, no `crypto`),
`apps/app/test-node/access-layout.test.ts` and the e2e `apps/app/e2e/staff-invite.spec.ts`.

Each refusal was checked by removing its check and running the test:

| Check removed | Test that fails |
| --- | --- |
| The pending invite's address condition | another address gets no code and no account from it |
| `accepted_at IS NULL` in the pending invite | an accepted invite whose account was removed makes no second account |
| `expires_at` in accepting | an invite that expires after the code makes nothing |
| `revoked_at` in accepting | a revoked invite makes nothing, even with a code sent before |
| The verified-account rule for codes | an unverified password account gets no code and keeps its role (no takeover) |
| The deactivated-account rule | a deactivated account gets no code |
| The user hook's code-only path | password sign-up is refused for an invited address (sign-up closed) |
| Making an account only from an invite | the expired and revoked invite tests |
| One answer for failed sign-ins | nine tests that expect the wrong-code answer |
| Serving only two code routes | the plugin's other routes answer 404 |
| `input: false` on the role field | a request cannot set the role itself |
| `actors: ["human"]` on the invite operations (and `mcp.expose`) | every AI and MCP actor refused per operation |
| The account-exists refusal in `user.invite` | an address with an account cannot be invited |
| The invite under Access | the first request makes the account with the invite's role |
| Deleting device sessions on deactivate | reactivating does not bring an old device session back |
| Deleting the browser session after a native sign-in | the customer's native sign-in leaves no browser session |
| Ending the session at `/auth/sign-out` | the door account's access token stops at once |
| The verifier, the redirect address, spending the handoff code | the browser sign-in test |
| The redirect allowlist | a code is never sent to an unlisted address |
| Refusing `Authorization` on native routes | a bearer token is refused |

`acceptInvite`'s own `accepted_at IS NULL` is defence in depth behind the pending check (two code
sign-ins cannot race on one address: a code is spent once); no test fails without it. "No cookie
is set" is observed, not removed: the phone in `native-sign-in.test.ts` records every `Set-Cookie`
the host sends and every cookie the runtime sends, and both lists stay empty.

## Consequences
- Only sends to colleagues are auto-approvable: email-send's `email.internal` (every recipient at
  its internal domains), and the fake outbox's `fake.internal` (every recipient at the outbox's own
  domain, which the fake now decides as email-send does). A code to any other address waits for
  review and so is deleted: customer codes to outside addresses, and staff whose address is not a
  colleague's, cannot be delivered by email-send today. This was already so for customer codes;
  a decision on host mail and review is filed separately.
- A send waiting for review holds back every later send on the same resource (the gatekeeper
  applies them in order), so one queued invite notice stops the codes after it until it is
  decided. The e2e journey approves the invite notice (it holds no secret) after letting colleague
  mail apply without review.
- After a sent code: the body, with the code, is in the gatekeeper's action record while the
  gatekeeper keeps it (email-send does not set `retainApplied`; the fake outbox's journal keeps it,
  dev only). A queued send's preview is kept on its pending action (full detail 30 days, then a
  summary), but that code was deleted when the send was queued.
- Seat limits count accounts, not pending invites.
- Erasing a person does not delete a staff invite to their address (the erase code is another
  build's); an invite expires in 7 days.
- Under Access, two first requests racing for one invited address can leave one of them acting as
  a member for that one request before the invite's role is written.

## Amended 2026-11-21 (ADR 0456)
Sign-in codes are now the host's own outbound kind, "Send sign-in codes" (`email.signin`),
decided by the gatekeeper from the host's queue and the fixed template, and turned on by a human
admin. Sign-in by code is not set up until it would go out at once, so a code to an outside address
is delivered, and the same-domain workaround in the fake outbox and the e2e journey is gone. A
send waiting for review never held back a code in email-send; the fake outbox now matches it.

## Amendment, 2026-11-22 (ADR 0470)
`NATIVE_REDIRECT_URIS` may list a loopback address with no port (`http://127.0.0.1/cos-sign-in`,
or `[::1]`): a code may then be sent to that address on any port (RFC 8252, 7.3), for a command
that listens on a port of its own (`cos content import`). Only those IP literals over http, the
listed path, no query, fragment or user; never `localhost`. See
[ADR 0470](0470-the-import-door.md).

## Amended 2026-11-22 (ADR 0457)
- A staff member confirms their own address (`user.sendEmailConfirmation`, `user.confirmEmail`):
  the first admin's password sign-up leaves it unverified, and a code goes only to a verified
  address, so until then they cannot sign in by code.
- `/native/staff-sign-in` no longer issues a code on GET: it shows a confirm page, and the code is
  issued on the confirmed, same-origin POST carrying a one-time token bound to the account and the
  request (issue #165).

## Amended 2026-11-24 (stage 60 step 6, ADR 0872): a device session's calls are marked
A staff call made with a device session carries `origin.staffDevice: true`, set by the HTTP surface
from the session (never from the request) and kept in the audit row's origin. `approval.approve`
refuses an `extension` or `schema` action under it, for an admin too (`details.reason:
"review_on_computer"`): a change to how the system is set up is reviewed in the web admin. The
routes, the tokens and the session table are unchanged.
