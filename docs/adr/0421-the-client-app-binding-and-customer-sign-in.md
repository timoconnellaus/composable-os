# ADR 0421: The client-app binding, and customers signing in on the company's hostname

Status: accepted, 2026-11-21 (stage 24 build, step 2 and the sign-in part of step 5; accepted at
the review of the spine, 2026-11-21).
Builds part of [ADR 0401](0401-platform-packs-screens.md) on
[ADR 0415](0415-the-http-surface-as-built.md) and
[ADR 0419](0419-native-sessions-and-customer-sign-in.md).

## Context
ADR 0401 decided that a company's web app is its own Worker reaching the host over a service
binding, that customers sign in on the company's own domain through it, and that staff and customer
cookies are never on one hostname. The stage 24 spec added that the host exposes an entrypoint for
bound Workers that runs a call through `invoke()` as the HTTP surface does, and that the web app
holds no credential that grants more than its caller has. It did not say what the entrypoint
serves, what it reads from a request, or how the host's customer cookie reaches the web app's
hostname.

## Decision
- **cos-app exports a second entrypoint, `ClientApp`** (`apps/app/src/server/http/bound.ts`),
  with one method, `fetch`. A web app binds to it:
  `{ "binding": "HOST", "service": "<product>-app", "entrypoint": "ClientApp" }`. There is no RPC
  method that takes a caller or a principal.
- **It serves a narrower door than the public hostname:** customer sign-in
  (`/api/customer-auth/*`, the four routes stage 22 allows) and the HTTP surface (`/api/v<n>/op/*`,
  `/api/v<n>/manifest`), built by core's `createHttpSurface` with cos-app's own invoker, so every
  call is `invoke()`. Everything else answers 404: the staff UI, `/mcp`, the assistant, support
  access, and the native token routes (`/api/v1/auth/*`), which a web app has no use for.
- **The caller is decided by the host, from a credential it verifies, and is never staff.**
  - The bound context reads one thing: the customer session cookie the web app forwards. The
    request is cut down to its `cos-customer.*` cookies before the customer identity sees it. The
    cookie is Better Auth's signed session token: its signature is `CUSTOMER_AUTH_SECRET`'s, which
    the web app never holds, and the session must be a live row of an active account linked to its
    Person. Anything else is the public.
  - It never reads a staff session: not Better Auth's staff cookie, not a Cloudflare Access JWT,
    not support access. A forwarded staff cookie is ignored, so a staff operation answers exactly
    as it answers no session (`unknown_operation`).
  - A request with an `Authorization` header is refused (`forbidden`, 401,
    `binding_takes_cookies_only`): a bound Worker forwards the cookie its hostname holds, never a
    native app's token, staff or customer.
  - No header, claim or body field names the caller. The visibility seam then gives the customer
    their own rows only.
- **What the bound Worker is trusted to say:** which operation, its input and its
  `Idempotency-Key`, as any caller of the surface; the customer's cookie, as an opaque credential
  the host checks; `cf-connecting-ip`, used only for the per-address limit on code requests; and
  `Origin` on the sign-in routes, used only by Better Auth's cross-site check. **What it is not
  trusted to say:** who the caller is, in any form.
- **Customers sign in on the web app's hostname.** The web app shows the form and forwards the
  address, then the code, to `/api/customer-auth/*` over the binding with the browser's `Origin`.
  The host makes the session and answers with `Set-Cookie`; the web app passes it through. The
  cookie names no `Domain`, so the browser keeps it for the hostname that answered, the web app's.
  `CUSTOMER_AUTH_URL` is the web app's origin, which makes the cookie `__Secure-` and `Secure` on
  https, and makes Better Auth refuse a sign-in posted from any other page.
- **Staff keep the host's address.** Their Better Auth cookie is host-only on it. A browser page on
  the host's address cannot get a customer cookie there: with `CUSTOMER_AUTH_URL` naming the web
  app, Better Auth refuses the sign-in post for its origin. A native app sends no `Origin` and still
  signs in at the host and exchanges the session for tokens (ADR 0419).
- **Signing out** over the binding (`/api/customer-auth/sign-out`, or `me.signOut`) deletes the
  session row, so the cookie is dead wherever it was kept, and Better Auth's answer clears it in the
  browser through the web app. **Deleting the account** (`me.deleteAccount`) disables it and
  deletes every session at once (ADR 0402's as-built note); a disabled account is sent no code.
- **The runtime client helps the web app forward only what it should:** `customerSession(cookie)`
  and `customerCookies` in `@composable-os/client` pick the customer cookies out of the browser's
  `Cookie` header.

## Tests
`apps/app/test/client-binding.test.ts` calls the binding's handler with real D1, sessions and
the registry; `apps/app/test/company-web.test.ts` goes through a real service binding from a fixture
Worker standing in for a company's web app (`apps/app/test/fixtures/company-web`, its own Worker
with only the `HOST` binding, using a generated customer client) into the real `ClientApp` class.

| Refusal | Fails when |
| --- | --- |
| A real staff cookie forwarded: staff operations answer `unknown_operation`, the manifest is the public's; with both cookies the caller is the customer | the bound context reads staff sessions as the public hostname's does |
| Headers claiming a staff caller or another customer change nothing | the bound context takes a caller the Worker names |
| A staff device token, and any bearer token, is refused 401 | the bearer refusal is removed (still never staff then, but no longer refused outright) |
| Another customer's session token, unsigned, signed with a guessed secret, with another customer's signature, or a made-up token signed with the staff secret: the public | the token is looked up without the host's signature check |
| `my.get` of another customer's Person: `not_found`; `my.list`: only their own | the seam's customer filter is removed |
| Only sign-in and the surface are served: no `/`, `/mcp`, staff auth, support, or token exchange | the token routes are served over the binding |

Cutting the request down to customer cookies is defence in depth: no test fails without it, because
the customer identity reads only its own cookie anyway.

## Consequences
- A compromised web app can act as any customer who sends it their cookie, while that session
  lives. It cannot act as staff, cannot act as a customer who has not visited it signed in, cannot
  mint a session without the code emailed to the customer, and cannot read another customer's rows.
- Calls over a binding do not pass the host's zone, so the edge rule for public calls (ADR 0415)
  must be on the web app's zone too. `docs/deploying.md` says so.
- The binding gives no more than the public hostname gives the same caller; it gives less.
  Binding to cos-app's default entrypoint instead would give exactly the public hostname's door,
  which needs a staff credential the web app cannot have to be staff.
- Better Auth refreshes a session's expiry in the database when it is used after a day, but the
  surface does not pass that refresh's cookie on, so the browser's cookie would keep its first
  `Max-Age` (seven days).

## Amended 2026-11-21 (review of the spine)
- **Staying signed in.** `keepCustomerSignedIn` in `@composable-os/client` (used by the template
  web app's `withSessionKept`): once a day at most, on a page request with the customer's cookie,
  the web app asks `/api/customer-auth/get-session` over the binding and sets the same cookie
  again with a lifetime to the session's current expiry, with its own `cos-session-checked`
  marker. An ended session clears both. The HTTP surface is unchanged. Test: a session used on
  day 6 is still valid on day 8 (`apps/app/test/client-binding.test.ts`).
- **Cookies apart rests on configuration,** as stated above: `CUSTOMER_AUTH_URL` naming the web
  app. Native sign-in returning tokens with no cookie on the host's address is filed for later.
- **The edge rule** for the web app's zone is printed by `cos create`, `cos init` and `cos deploy`
  as a step a person does before opening the app to the public.
- **The native token routes stay off the binding.**

## Amended 2026-11-21 (client releases and environments)
`CUSTOMER_AUTH_URL` and `CUSTOMER_AUTH_SECRET` are set by `cos deploy` for a product with a web
app, per environment: the URL is that environment's web app origin, the secret is generated once
and never changed by a later deploy ([ADR 0450](0450-client-environments.md)).
