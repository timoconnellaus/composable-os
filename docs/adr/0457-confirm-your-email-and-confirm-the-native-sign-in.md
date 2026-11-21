# ADR 0457: Confirming your own email, and confirming a native sign-in before it is handed over

Status: accepted, 2026-11-22 (`fix/import-sign-in-on-client-hosts`). Builds on ADRs
[0455](0455-staff-invites-and-native-sign-in-by-tokens.md), [0456](0456-the-hosts-sign-in-mail.md)
and [0470](0470-the-import-door.md). Amends 0455 and 0470. Closes issue #165. Migration 0492.

## Context
The first client ran `cos content import` against a real host and found three things:
- **The first admin could never get a sign-in code.** A staff code goes only to a verified address
  (ADR 0455, `staffMayGetCode`), and the first admin signs up with a password at `/setup`, which
  leaves the address unverified. A code request answered as always and nothing was sent, so the
  import's `--email` (and the door scanner's sign-in) waited forever, on every new host.
- **The import's browser sign-in could not be set up on a client host.** `cos deploy` set
  `NATIVE_REDIRECT_URIS` to the mobile app's redirect only, on every deploy, so the import's
  loopback address could not be added and a hand edit was overwritten.
- **Issue #165.** `/native/staff-sign-in` minted a code on a bare GET. With the loopback door on
  every host, a link someone else made (their challenge, their redirect) opened in a signed-in
  browser would hand them a code.

## Decision

### Confirming your own address
- **`user.emailStatus`, `user.sendEmailConfirmation`, `user.confirmEmail { code }`**: the caller's
  own account only, `actors: ["human"]`, not on MCP, `bookkeeping` (never queued; a code that waits
  is no use). Not a support user.
- **The address is the account's, read from the account, never an input.** The code goes to it, so
  this cannot verify an address the person does not control. The code is stored as a hash bound to
  the account and to the address it was sent to (`core_email_confirmation`); if the account's
  address is no longer that one, the code confirms nothing, and the update that sets
  `email_verified` matches that address too. So it cannot change an address either.
- **Six digits, five minutes, three tries, a new code no sooner than 30 seconds after the last.**
  Sent as the host's sign-in mail (`HostMail.sendSignInCode`, the fixed code template, ADR 0456),
  before the row is written: a code that did not go out is never stored. While sign-in mail is not
  ready, it is refused with what to turn on, and nothing is sent.
- **Audited** as a change to the user (`emailVerified` false to true).
- **Shown where it matters:** the account menu offers "Confirm your email" while the address is
  unconfirmed, and Settings → Users (the host's mail card) shows an unconfirmed admin a plain
  notice with the action, since until then sign-in by code and the import's `--email` do not work
  for them.
- **Outsiders learn nothing new.** The code request routes answer as before, the same for every
  address. `cos content import --email` says, when it asks for the code, what to check on the host
  if none arrives (an invited or confirmed address; sign-in mail turned on) without the host
  saying anything about the address.

### The native sign-in asks before it hands a code over
- **GET issues nothing.** It checks the request as before (a listed redirect address, an S256
  challenge, a state), sends a signed-out browser to sign in, and, signed in, shows a confirm page:
  the account's name and address, where the sign-in will go (the app that opens `<scheme>://`
  links, or "a command-line tool on this computer" for loopback), and a Continue button.
- **The confirmed POST issues the code.** It must come from this page: the `Origin` header equal
  to the host's own, or with no `Origin`, `Sec-Fetch-Site: same-origin`; anything else is refused.
  It carries the page's one-time token (`core_native_sign_in_confirm`, hash only, five minutes),
  bound to the signed-in account and to the request's redirect address, challenge and state, and
  deleted when presented, right or wrong. Every request parameter is checked again. Only then is
  the handoff code issued and the browser sent (303) to the redirect address with it.
- **The page is never framed or cached:** `frame-ancestors 'none'` (and `X-Frame-Options: DENY`),
  `no-store`, no referrer, and `form-action` limited to the page itself and the one redirect
  address (a browser holds a form's redirects to it).
- The mobile template and the import change nothing: the system browser shows one more page.

### The import's loopback door on every host
- `cos deploy` sets `NATIVE_REDIRECT_URIS` to `http://127.0.0.1/cos-sign-in`, plus
  `<scheme>://staff-sign-in` when the product has a mobile app, for every environment, on every
  deploy. The CRM's own installer sets the loopback address when the deployment has no value of
  its own (a value set by hand is kept).

## Why
- Confirming one's own address by a code sent to it is the proof the code rule needs; reading the
  address from the account, and binding the code to it, keeps it from proving anything else.
- A consent step, a same-origin check and a token bound to the account and the request is the
  usual defence for a page that hands a credential to another program: the link alone is not
  enough, and a cross-site form or a replay gets nothing.

## Proof
`packages/core/test/user-email.test.ts`, `apps/app/test/native-sign-in.test.ts` (and
`staff-app.test.ts`, the mobile template through the confirm page),
`packages/create-composable-os/test/client-repo.test.ts` and `cli.test.ts`, and
`apps/app/test/content-import.test.ts`. Each check was removed and its test failed:

| Check removed | Test that fails |
| --- | --- |
| The code bound to the address it went to | a code sent to an address the account no longer has confirms nothing |
| Expiry | an expired code confirms nothing |
| The code compared | the right code confirms; three wrong tries end it |
| Tries counted | three wrong tries end the code |
| Refused while sign-in mail is not ready | refused, and sends nothing |
| A person only | refused to MCP, the assistant and automations |
| The wait between codes | asks a moment between codes |
| No code on GET | a bare GET issues nothing; a replayed confirmation issues nothing |
| The same-origin check | a POST from another site, or with no origin, issues nothing |
| The token checked | replayed, altered and another account's confirmations |
| The token bound to the account, the state, the challenge | the altered and another account's tests |
| The token spent when presented | the confirmation works once |
| `frame-ancestors 'none'` | the GET test |
| The POST's parameters checked again | never sends a code to an address the deployment does not list |
| Loopback in `cos deploy`'s list | three client-repo tests |
| The installer's default | installs a verified release |
| The import's note logic | a dry run says nothing of posts published here and unchanged |

## Consequences
- An admin who signed up with a password confirms their address once, from the account menu or
  Settings → Users, after turning sign-in mail on.
- Every host `cos deploy` makes accepts the import's browser sign-in; each one asks the person on
  the page first.

## Amended 2026-11-22 (beta.6: Continue answered 403 in a real browser)
The confirm page was served with `Referrer-Policy: no-referrer`, under which a browser sends
`Origin: null` on the page's own form POST (with `Sec-Fetch-Site: same-origin`). The same-origin
check compared any Origin that was present, so `null` was refused and both the import's and the
app's browser sign-in failed. The tests built the POST with the page's real origin, so they passed.
- **The rule.** An Origin that names a site must be the host's own. `Origin: null` names no site
  and proves nothing on its own, so it is treated as no Origin: only `Sec-Fetch-Site:
  same-origin` passes then, a header no page can set. A named origin that is not the host's is
  refused whatever the metadata says; `null` or no Origin with `cross-site`, `same-site` or no
  metadata is refused. This is Better Auth's own rule for its origin check.
- **The page's policy is `same-origin`**, so a browser sends the page's real Origin on its form
  POST, including browsers without Fetch metadata (Safari before 16.4, Firefox before 90): they
  pass by the named-Origin rule. Nothing goes to another site: the 303 with the code keeps
  `no-referrer`. A browser that sends neither a named Origin nor Fetch metadata is refused; the
  one-time token, bound to the account and the request, remains the real protection.
- **The tests send what a browser sends.** `apps/app/test/browser-sign-in.ts` derives the POST's
  Origin from the page's own Referrer-Policy as the Fetch standard does (`null` under
  `no-referrer`) and adds `Sec-Fetch-Site: same-origin`; a test that plays another site names its
  headers. `apps/app/e2e/native-sign-in.spec.ts` presses Continue in Chromium and follows the
  redirect to a loopback listener, and to an app scheme (the 303 the browser receives), and
  exchanges the code for tokens. With beta.6's page and rule it fails; with either fix alone it
  passes.
- **Every other Origin check was read for the same mistake** (the HTTP surface, the media routes,
  MCP consent, the assistant's routes and socket, the template web app's operation route and its
  sign-in forwarding, Better Auth's customer and staff routes): none accepts `null` on its own;
  each refuses an Origin that is present and not its own, `null` included.
- **The confirmation email keeps the sign-in code template** ("Your <product> sign-in code"): the
  sign-in mail kind is given to that one fixed template only (ADR 0456), and a second template
  would widen what counts as sign-in mail.

