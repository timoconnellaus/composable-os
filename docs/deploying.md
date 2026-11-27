# Deploying

Deploying for the first time? Follow [first-deploy.md](first-deploy.md). This page is the reference.

One deployment = one Cloudflare account (ADR 0001), with one exception: a client repo's
environments (a staging host and a live host of one product) sit side by side in one account, each
with its own names (ADR 0450, [below](#environments)). A deployment has two Workers and one D1
database (the names here are a CRM install's; a client product's host is `<id>-app`, `<id>-runner`
and so on):

| Resource | Name | Notes |
| --- | --- | --- |
| Worker | `crm-app` | UI, server functions, `/api/*`. Public. |
| Worker | `crm-runner` | Workflows, Worker Loader, extension runtime. No public URL (`workers_dev: false`); reached only through `crm-app`'s `RUNNER` service binding. |
| D1 database | `crm` | Bound as `DB` to both Workers. Created by name on the first deploy. |
| R2 bucket | `crm-blobs` | Bound as `BLOBS` to both Workers: full bodies of synced email (stage 6a, ADR 0112). Created by name on the first deploy. |
| Gatekeeper Workers | `crm-gatekeeper-<name>` | Optional, one per integration you use; bound to `crm-runner` as `GATEKEEPER_<NAME>`. See [integrations.md](integrations.md). |

Workers Paid is required (Durable Objects with SQLite, Workflows, Worker Loader).

No account IDs or resource IDs are committed. Both `wrangler.jsonc` files name the database
(`database_name: "cos"`, which a deploy of the CRM renames to `crm`) without an ID; wrangler finds it by name, or creates it on the first
deploy.

## Configuration

`IDENTITY_PROVIDER`, `AUTH_ALLOW_SIGNUP`, `APPROVAL_FLOOR` and the approval and MCP settings below are plain vars in `apps/app/wrangler.jsonc`: change them
there (in your fork) to switch adapter. Everything else is a **secret** on `crm-app`, set with
`wrangler secret put <NAME> --name crm-app`, through the deploy script (below), or in the dashboard.
`apps/app/.dev.vars.example` lists the same names for local development.

| Name | Kind | Needed when | Purpose |
| --- | --- | --- | --- |
| `IDENTITY_PROVIDER` | var | always | `better-auth` (default) or `cloudflare-access` |
| `AUTH_ALLOW_SIGNUP` | var | Better Auth | `false` (default): only the first user can sign up; everyone else is invited (Settings → Users). `true`: open password and Google sign-up to anyone. Keep it `false` |
| `NATIVE_REDIRECT_URIS` | var | optional | The app addresses (`gymapp://signed-in`) a native app's browser-based staff sign-in may hand its code to, exactly, comma separated (ADR 0455), and `http://127.0.0.1/cos-sign-in`, `cos content import`'s door on any port (ADR 0470). `cos deploy` sets both (the app's only with a mobile app); the installer sets the loopback one when unset. The page asks the person to confirm before the code goes (ADR 0457). Empty: `/native/staff-sign-in` is not served |
| `APPROVAL_FLOOR` | var | optional | Approval-policy floor the org's preset can never loosen (ADR 0011/0018). JSON keyed by actor (`human`, `assistant`, `mcp`, `automation`, `extension` or `*`) then risk class (or `*`), with `auto`, `review`, `deny` or `{"autoUpTo": n, "above": "review"}`. Example: `{"*":{"destructive":"review"}}`. Empty: no floor. Malformed: every operation is refused |
| `APPROVAL_EXPIRY_DAYS` | var | optional | Days before a pending action (an AI change waiting for approval) expires. Default `7` |
| `API_ALLOWED_ORIGINS` | var | optional | Origins a browser may call the HTTP surface (`/api/v1`) from, comma separated, such as a client app's site, for its customers and the public only: a staff session from it is refused. Phones and servers send no origin and are not affected. Empty (default): none but the app's own |
| `DESK_HOSTNAME` | var | for desk signing | The desk origin's hostname, `desk.` before the host's (stage 44 step 6, ADR 0649): the business's enrolled tablet runs there, on the same Worker, which serves it only the tablet's pages and calls. `cos deploy` and the installer set it, and add the hostname as a custom domain, when the host is on a custom domain; empty (workers.dev, a hosted tenant): no desk signing and no enrolled devices. Locally `pnpm dev` sets `desk.localhost` |
| `DESK_SECRET` | secret | for desk signing | The key enrolment codes, enrolled devices' credentials, desk codes and desk session tokens are kept under (HMAC, ADR 0780). At least 32 random characters, different from every other secret; the installer and `cos deploy` make it once on a custom domain (a host updated only from Settings → Updates gets it at its next `cos deploy`, or by `wrangler secret put DESK_SECRET`). Changing it revokes every enrolled device in effect (their credentials no longer match): enrol them again |
| `CUSTOMER_AUTH_SECRET` | secret | for customers | Signs customer sessions (stage 22). Must differ from `BETTER_AUTH_SECRET`. Unset: no customer session exists, and every caller of the HTTP surface who is not staff is the public |
| `MCP_ACCESS_TOKEN_TTL` | var | optional | MCP access token lifetime in seconds. Default `3600`; refresh tokens last 30 days |
| `MCP_RESOURCE` | var | optional | The public `/mcp` URL tokens are bound to, e.g. `https://crm.example.com/mcp`. Default: the request's origin + `/mcp`. Set it when the app answers on several hostnames |
| `BETTER_AUTH_SECRET` | secret, **required** | always | Signs sessions. At least 32 random characters: `openssl rand -hex 32` |
| `BETTER_AUTH_URL` | secret | Better Auth, recommended | Public origin, e.g. `https://crm.example.com`. Inferred from requests when unset |
| `GOOGLE_CLIENT_ID` | secret | Google sign-in | OAuth client; redirect URI `<origin>/api/auth/callback/google` |
| `GOOGLE_CLIENT_SECRET` | secret | Google sign-in | |
| `CF_ACCESS_TEAM_DOMAIN` | secret | Cloudflare Access | `myteam` or `myteam.cloudflareaccess.com` |
| `CF_ACCESS_AUD` | secret | Cloudflare Access | The Access application's Audience (AUD) tag |
| `COS_UPDATE_TOKEN` | secret | optional | Scoped API token for in-app updates ([Updates](#updates)) |
| `COS_RELEASE_VERSION` | var | releases | The installed release; set by the release manifest, empty from source |
| `COS_RELEASE_REPO` | var | releases | GitHub repository releases are read from (default `timoconnellaus/composable-os`) |
| `COS_ACCOUNT_ID` | var | releases | The account the self-updater deploys to; set by the installer |

`BETTER_AUTH_SECRET` is declared in `secrets.required`, so wrangler refuses to deploy `crm-app`
without it. Set it even with Cloudflare Access (any random value): it keeps the config uniform.

### Local development

`pnpm dev` creates `apps/app/.dev.vars` from `.dev.vars.example`; put local secrets there,
including provider keys (`AI_KEY_DEEPSEEK`, `AI_KEY_OPENAI`, …), `TYPESAFE_API_KEY`,
`GOOGLE_CLIENT_*` and `CF_ACCESS_*`. Every name in the file reaches the Worker.

That needs one adjustment. Once a Worker declares `secrets`, Wrangler and the Vite plugin load
only the declared names from `.dev.vars` and silently drop the rest, and Wrangler has no list of
optional secrets. Listing the optional ones as `required` would make every deploy demand every
provider's key. So `vite dev` (only) widens the declaration to every name `.dev.vars` sets
(`apps/app/dev-secrets.ts`, through the Cloudflare plugin's `config` hook in `vite.config.ts`).
Builds and deploys read `wrangler.jsonc` unchanged, so a deploy still requires
`BETTER_AUTH_SECRET`, and `wrangler types` still generates `Env` from `secrets.required`. Optional
secrets are therefore not in the generated `Env`; code reads them as optional. `apps/app/test-node`
checks this against Wrangler's own loader. Plain `wrangler dev` on `apps/app` is not widened, so use
`pnpm dev`. `crm-runner` declares no secrets and loads all of its `.dev.vars`.

The first user of a deployment (Better Auth sign-up, or the first Cloudflare Access user to load
the app) becomes its admin; an installed pack's principal is not a user here. On a host of many
clients only the first admin the operator named, by the setup link (see "A client's first admin"
under "A host of many clients"). After that, an admin adds people on Settings → Users with an invite
(ADR 0455): the address, the role, and optionally a pack role or permissions the account holds from
the start. With Better Auth the person signs in on the sign-in page with "Email me a code"; the
code, and the invite email, go out from the host's mail connection (also on Settings → Users, the
same one customer codes use), and that connection's sends must be set to apply without review on
Settings → Integrations. Under Cloudflare Access, add the person to the Access policy: their first
visit makes the account with what the invite says. Without an invite, a first Access visit is a
member.

`crm-app` also binds a KV namespace, `OAUTH_KV`, for MCP OAuth clients, grants and hashed
tokens. Like the D1 database, wrangler provisions it by name on the first deploy. Connecting
Claude is described in [`mcp.md`](mcp.md).

### Rate limits

MCP and Code Mode are rate limited with the [Workers Rate Limiting
binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/) (ADR 0091),
declared under `ratelimits` in `apps/app/wrangler.jsonc`. It needs no account setup or D1 writes,
and it needs Wrangler 4.36.0 or later.

| Binding | Key | Default | Counts |
| --- | --- | --- | --- |
| `MCP_RATE_LIMIT` | connected app | 120 per 60 s | every `/mcp` request (HTTP 429 with `Retry-After` when over) |
| `MCP_WRITE_RATE_LIMIT` | connected app | 30 per 60 s | non-read operations over MCP (tool error `rate_limited`) |
| `CODE_MODE_RATE_LIMIT` | user | 10 per 60 s | Code Mode runs |
| `CUSTOMER_RATE_LIMIT` | customer account and operation | 60 per 60 s | a customer's calls over the HTTP surface (`rate_limited`, HTTP 429) |
| `CUSTOMER_CODE_RATE_LIMIT` | mailbox asked for (a `+tag`, and Gmail's dots, folded away) | 3 per 60 s | customer sign-in code requests |
| `CUSTOMER_CODE_ADDRESS_RATE_LIMIT` | client address, hashed (an IPv6 address by its /64) | 60 per 60 s | sign-in code requests and attempts, one count for staff, customer and practitioner sign-in (ADR 0940) |
| `STAFF_FEED_RATE_LIMIT` | a calendar feed, by a hash of its token | 10 per 60 s | fetches of a staff member's calendar feed (ADR 0628): 429 with `Retry-After` when over |
| `STAFF_FEED_ADDRESS_RATE_LIMIT` | client address, hashed | 120 per 60 s | calendar feed fetches from one address, before any token is looked up (a calendar provider fetches many people's feeds from few addresses) |
| `CUSTOMER_FEED_RATE_LIMIT` | a customer's calendar feed, by a hash of its token | 10 per 60 s | fetches of a customer's calendar feed (ADR 0890): 429 with `Retry-After` when over |
| `CUSTOMER_FEED_ADDRESS_RATE_LIMIT` | client address, hashed | 120 per 60 s | customer calendar feed fetches from one address, before any token is looked up |
| `PUBLIC_RATE_LIMIT` | client address (hashed, an IPv6 address by its /64, an IPv4-mapped one by its IPv4) and operation | 600 per 60 s | a call from outside the org to a public read, for floods only (ADR 0940) |
| `PUBLIC_WRITE_RATE_LIMIT` | client address and operation | 120 per 60 s | a public write; `contact.stop` counts only tokens that are not valid |
| `PUBLIC_ASSET_RATE_LIMIT` | client address and operation | 1200 per 60 s | `media.serve` and `media.play` (a page shows many pictures) |
| `PUBLIC_CALLER_RATE_LIMIT` | a signed-in account, or a guest's order or personal link, and the group | 10 per 60 s | order starts, `order.checkout`, `subscription.start`, `discount.check` with `order.applyCode`, `intake.submit`; also bound by cos-runner (same namespace) for a pack tool's calls |
| `PUBLIC_SHARED_RATE_LIMIT` | the client app and the operation | 6000 per 60 s | calls over the client-app binding whose Worker names no visitor address (an older template) |
| `PUBLIC_CODE_SURGE_RATE_LIMIT` | one key for the whole host | 30 per 10 s | promo code checks, only while wrong codes are over the hour's host-wide ceiling (2,000); also bound by cos-runner |
| `CUSTOMER_CODE_NEW_RATE_LIMIT` | one key for the whole host | 20 per 60 s | codes sent to addresses that only "anyone starting a subscription" lets sign in (ADR 0459); over it, nothing is sent, the answer is unchanged and admins are told once an hour. **Unlike the others, a missing binding sends no such code** (shut, not open) |

To change a limit, edit its `simple.limit` (any positive integer) or `simple.period` (`10` or
`60` seconds only) and redeploy. Limits are **approximate**: Cloudflare counts per location and
syncs counts eventually, so a client can briefly go over, and a client whose requests reach
several locations gets roughly the limit in each. That is enough to stop a runaway agent; it is
not an exact quota. Each `namespace_id` must be an integer that is unique in your account
(`4101`–`4115` by default): change them if another Worker in the account already uses those ids,
since bindings that share a namespace share counters. If a binding is missing, requests are not
limited and the Worker logs a warning. For the `PUBLIC_*` ones (ADR 0940) every call that could not
be counted is logged as an error (at most once a minute per isolate), the admins are told once a
day, and the status page's "Rate limits" line names the missing bindings; wrong promo codes are
still counted, in D1. Rate-limited requests show up in Workers Logs as 429s.

#### Public calls: the host's limits, and a rule at the edge

The host limits every call to an operation open to the public (ADR 0940), with the `PUBLIC_*`
bindings above: per client address for floods only, set high because many people share one address
(a venue's wifi, a gym's network, a carrier's NAT), and per caller (a signed-in account, a guest's
order) on what is costly or guessable. On the HTTP surface the address is the connection's; over
the client-app binding it is a forwarded `cf-connecting-ip`, else the visitor the web app names in
`cos-visitor-address` (the template does). Wrong promo codes are counted per caller in D1: 20 from
an account or guest order (50 from an address for a guest naming no order) in a quarter-hour, and
that caller's codes are refused for 15 minutes. Nothing needs setting up for this.

- **Leave Cloudflare's "Pseudo IPv4" on "Add header" or off, never "Overwrite headers"**: it puts a
  made-up IPv4 address for each IPv6 address in `cf-connecting-ip`, which defeats counting an IPv6
  client by its /64.
- **A server calling the public surface** (a Worker in another Cloudflare account, a back office)
  arrives from Cloudflare's or its host's address and shares one bucket with every other such
  caller. Give it the client-app binding, or sign it in.

A rule at the edge is still worth adding for volume, since it stops a flood before it reaches the
Worker. Keep it at a flood level too, or it locks out a shared network before the host would. A
Cloudflare rate limiting rule on the zone (Security → WAF → Rate limiting rules) counts per IP at
the edge and stores nothing in the deployment:

| Setting | Value |
| --- | --- |
| Expression | `(starts_with(http.request.uri.path, "/api/v1/op/") or starts_with(http.request.uri.path, "/api/customer-auth/") or starts_with(http.request.uri.path, "/f/") or http.request.uri.path eq "/form")` |
| Counting characteristic | IP (`ip.src`) |
| Period | 10 seconds |
| Requests | 300 |
| Action | Block, for 10 seconds (the client gets 429) |

A deployment on a `workers.dev` hostname has no zone and cannot add the rule; the host's own
limit holds there too.

#### Forms: Turnstile

A form the public answers (stage 29, ADR 0722) is checked with Cloudflare Turnstile before the host
keeps anything. Create a Turnstile widget (Cloudflare dashboard → Turnstile, managed mode) listing
the hostnames forms are drawn on: the host's own (its form page, `/f/<slug>`) and the business's
site (the same page through the web app's binding, and the `forms-form` block). Set its **secret
key** on cos-runner, where a pack's tool and the door (`intake.submit`) run, and its **site key** on
cos-app, which the form page draws the widget with (ADR 0728; not a secret, kept as one so it stays
out of `wrangler.jsonc`); a client app's own block takes the same site key in the app's widget:

```sh
wrangler secret put TURNSTILE_SECRET_KEY   # in apps/runner; scripts/deploy.mjs also reads it from the environment
wrangler secret put TURNSTILE_SITE_KEY     # in apps/app; scripts/deploy.mjs also reads it from the environment
```

It is an env-only secret: never in D1, an input or the audit log. Without it, forms take answers
from signed-in customers and staff only; every public answer is turned away and admins are told
once a day. A testing host uses Cloudflare's documented test keys (a secret that always passes).
The edge rule above counts the calls a form sends (`/api/v1/op/`) and the form page's own paths
(`/f/`, `/form`); a web app with Forms on names them in its own rule too (`cos create` prints it).
Without the site key, a public form's page says it cannot be sent there. `scripts/deploy.mjs`
refuses Cloudflare's test keys for either name. Local development and the
e2e suite use Cloudflare's test keys (`scripts/dev-setup.mjs`). Not yet tried with a real site key
on a live host.

#### Customer sign-in

Customers sign in at `/api/customer-auth/*` with a code sent by email. It needs
`CUSTOMER_AUTH_SECRET` (a secret, different from `BETTER_AUTH_SECRET`) and an org email-send
connection chosen for the host's mail (Settings → Users, "The host's mail"; or
`customer.settings.update` `emailConnectionId`). The host sends the codes itself, through that
connection, as the system user, as its own kind of send, "Send sign-in codes" (`email.signin`,
ADR 0456). A human admin turns on "Send sign-in codes without review" on Settings → Users (or that
kind's auto-approval on Settings → Integrations); it needs the Balanced approval policy, and an
`APPROVAL_FLOOR` that does not review automations' outbound sends. Until all of this holds, a code
request, customer's or staff member's, answers that sign-in is not set up, and no code is made:
a code that would wait for review is never sent. Only the host's fixed code email goes out this
way; every other email still follows the approval policy. `cos deploy` does not turn it on.

Who may sign in as a customer is a human admin's choice on Settings → Users ("Who can sign in as a
customer", `customer.settings.update` `signup`, ADR 0458): **only people you invite** (the
default), **people you invite and anyone who has bought** (the buyer's address of an order that was
paid, in full or in part, even if refunded since; a checkout only started does not count), or
**anyone**. A business that sells to guests and wants them to see their tickets later picks the
middle one. On top of any of them, **also anyone starting a subscription**
(`startingSubscription`, ADR 0459): while a plan is on sale to the public, any new address may get
a code, so a new visitor confirms their address and starts the plan signed in, with its free
trial. In effect anyone can make a customer account while a plan is on sale; codes this sends are
also limited for the whole host (`CUSTOMER_CODE_NEW_RATE_LIMIT`). It includes people already in
the records (a contact, a past buyer): confirming the address signs them in to that Person and its
own orders, tickets and subscriptions. Sign-up opens the moment a plan goes on sale, whoever
publishes or prices it; admins are told when it does. The limit's binding is part of the release,
so an existing host gets it at its next update; until then, no code goes out by this switch.
Every address is answered the
same whichever is chosen. `cos deploy` and `product.ts` never set any of it.

#### A company's web app on its own hostname (stage 24)

A client repo (`cos create`, `cos init`) deploys its host and its web app with `cos deploy`, which
does what follows. These are also the steps to wire a web app by hand. The web app is its
own Worker on the company's hostname (`shop.example.com`); the host keeps its own address, which
may be a subdomain (`admin.example.com`), and staff sign in there.

1. In the web app's wrangler config, one service binding to the host's app Worker and its
   `ClientApp` entrypoint, and no D1, R2, KV or secret of its own. The host of a client product
   `shop` is `shop-app` (`shop-staging-app` for its staging environment):
   ```jsonc
   "services": [{ "binding": "HOST", "service": "shop-app", "entrypoint": "ClientApp" }]
   ```
   The binding serves customer sign-in (`/api/customer-auth/*`), practitioner sign-in
   (`/api/practitioner-auth/*`, ADR 0581) and the HTTP surface (`/api/v1/op/*`,
   `/api/v1/manifest`) for customers, practitioners and the public only. It never reads a staff
   session and refuses a bearer token (ADR 0421).
2. On the host, `CUSTOMER_AUTH_URL` is the web app's origin (`https://shop.example.com`).
   Customer cookies are then for that origin (`__Secure-` and `Secure` on https), and Better Auth
   refuses a sign-in posted from any other page, the host's own included. `cos deploy` sets it,
   and makes `CUSTOMER_AUTH_SECRET` once per deployment ([below](#customer-sign-in-on-the-web-apps-hostname));
   the customer mail connection is set as in [Customer sign-in](#customer-sign-in).
3. The web app forwards its sign-in form to `HOST.fetch("https://host/api/customer-auth/...")`
   with the browser's `Origin` and its visitor's address, and passes the `Set-Cookie` it gets back
   to the browser unchanged: the cookie is host-only, so it is kept for the web app's hostname. Its
   operation calls go through the typed client with `fetch: (url, init) => env.HOST.fetch(url,
   init)` and `headers: () => forVisitor(request)` from `@composable-os/client`, which forwards
   the customer cookie (and no other) and the visitor's address in `cos-visitor-address`, which
   the host's limits key on (ADR 0940). **Never forward the browser's request headers as they
   came**: a `cos-visitor-address` the browser sent must not reach the host. A web app that sends
   no address is one shared bucket for all its visitors, and the admins are told once a day.
4. If you add the optional [edge rule for public calls](#public-calls-the-hosts-limits-and-a-rule-at-the-edge),
   add it on the web app's zone too: calls over a binding do not pass the host's zone, so the
   host's rule does not see them. The host's own limit per client address holds either way.
   **Scope it to the routes that
   reach the host** (the sign-in route, `/auth/` in the template, and the operation route,
   `/api/v1/op/` by default; `web.routes` in `product.ts` names others), which is the rule `cos`
   prints. A rule over the whole of `/api/` would, on a site with its own API, throttle the site's
   own routes for everyone behind one address (an office, a school, a phone network).
5. **Calls from the browser** (a web block in a page, an Astro site's React island) go to the web
   app's own `operationRoute(request, env, { allow })` (the template's host module): same origin
   only, JSON only, only the operations `allow` names, forwarding the customer's cookie and the
   `Idempotency-Key` and never an `Authorization` header (ADR 0451). In the browser,
   `createCustomerClient({ baseUrl: location.origin })` calls it.

#### Who a customer is, from the company's own server

A company that keeps records of its own (members, bookings) links them to a platform customer by
the address the customer signs in with. `me.get` returns it as `signInEmail` (with
`signInEmailVerified`): the address the emailed code was sent to and verified on. Link by it
alone. `primaryEmail` is the Person's contact address, which staff can change, and is not proof
of anything.

- **A browser on the web app:** the web app's Worker calls `me.get` over the binding with the
  customer's cookie, as in step 3 above.
- **A native app:** the app holds a device session's access token (ADR 0419), not a cookie. When
  it calls the company's own server, it sends that token; the server checks it by calling
  `me.get` on the host's **public HTTPS address** with `Authorization: Bearer <token>`
  (`POST https://<host>/api/v1/op/me.get`, body `{}`), and links by the `signInEmail` it gets
  back. A token that is not a live session answers 401. Do not send the token over the binding:
  the binding takes cookies only and refuses any bearer token (`binding_takes_cookies_only`,
  ADR 0421). The server never stores the token or uses it for anything but this check.

`crm-runner`'s only secrets are the AI ones ([In-app AI](#in-app-ai)). It runs extension code, which calls operations there, so set its
`APPROVAL_FLOOR` var (in `apps/runner/wrangler.jsonc`) to the same value as crm-app's. Shipped
extensions (packs, `packs/`) are installed through `extension.install` on the first request after a
deploy. AI (model roles for `codemode:ai`, "Describe a widget", summaries and semantic search) is
described in [In-app AI](#in-app-ai) below.

### Automations

Automations (stage 5, ADR 0130) need these bindings, all declared in the wrangler files and
provisioned by name on deploy:

| Binding | Worker | Purpose |
| --- | --- | --- |
| `AUTOMATION_EVENTS` (queue producer) | crm-app, crm-runner | Committed record changes and approval decisions, queue `crm-automation-events` |
| queue consumer | crm-runner | Starts runs: batches of up to 100, 5 s, 5 retries, then the dead-letter queue `crm-automation-events-dlq` |
| `ROUTINE_DELIVERY` (queue producer) | crm-runner | A routine's messages (ADR 0343), queue `crm-routine-delivery`: ids only |
| queue consumer | crm-app | Delivers each into its owner's assistant thread: batches of up to 10, 5 s, 3 retries, then the dead-letter queue `crm-routine-delivery-dlq` |
| `AUTOMATION_WORKFLOW` | crm-runner | Workflow `crm-automation` (class `AutomationWorkflow`), one instance per run |
| `AUTOMATION_RATE_LIMIT` | crm-runner | Runs per minute per automation (default 60 per 60 s, `namespace_id` 4201); above it the automation auto-pauses and admins are notified |
| cron `* * * * *` | crm-runner | Schedule triggers and the daily date-relative scan |

`pnpm run deploy` and `create-composable-os` create the four queues when they are missing; Workflows need no setup. Queues and Workflows are billed per use (see ADR 0130). The kill switch, the automation
timezone and the debounce window are in Settings → Automations; only human admins can engage the
kill switch.

Semantic search (ADR 0154) also consumes these events: the queue consumer embeds the records a
batch changed, so crm-runner gets the `vectorize` binding too (added by the deploy script; see
[In-app AI](#in-app-ai)).

Dashboard widget results are cached for 60 seconds in the Workers Cache API (ADR 0057). The Cache
API does nothing on `*.workers.dev` hostnames, so put crm-app on a custom domain to get the cache;
without it every widget view runs its query.

## A client repo: `cos create`, `cos init`, `cos deploy` (stage 24)

A company's own product lives in its own repository (ADR 0401, ADR 0422): `npm create
composable-os <dir>` starts one from the release's template, `cos init` adopts an existing one in
place. `product.ts` names the platform release the host is deployed from, its packs and its apps.

```sh
npm create composable-os shop -- --label "Shop" [--with-mobile]
cd shop && pnpm install
CLOUDFLARE_API_TOKEN=... pnpm cos deploy     # checks extensions/ and the apps first, then deploys
pnpm cos add web-sign-in                     # copies a block; pnpm cos diff web-sign-in later
pnpm cos diff web-sign-in --accept           # after merging its upstream changes by hand
pnpm cos upgrade                             # moves to a newer platform version; deploys nothing
                                             # (also replaces unedited host modules, and shows the
                                             # diff of edited ones: composable-os.lock.json)
pnpm install && pnpm cos upgrade             # then: install the new versions, and type-check
```

**`cos upgrade` in two steps.** It moves `platform.version`, the generated clients, the skills,
the host modules and every `@composable-os/*` dependency in the root's and each app's
`package.json` to the new version (keeping `^` or `~`; a tarball, path, workspace or override it
cannot safely rewrite is left and named). It never installs, and it type-checks the apps only
against packages installed at the new version: until they are, it says the type check was skipped
and prints the install command for the repo's package manager. Install, then run `cos upgrade`
again: on the version the repo is already on, it type-checks (and checks the host modules again).

`cos deploy` installs (or upgrades, or repairs) the host from the release in `product.ts` with the
product's packs (`COS_PACKS` on the runner) and the org's own extensions, which it checks with
`cos ext check` first, puts in the BLOBS bucket and pins by hash (`COS_ORG_EXTENSIONS`); the runner
installs them as shipped extensions, with no approval. A failed check, or a type error in an app,
stops it before anything in the account changes. Then it uploads the built web app with its one
binding, `HOST`, to the host's `ClientApp` entrypoint, and refuses a build with a database, bucket
or KV binding of its own. **What a person does by hand:** the DNS for the web app's custom
hostname (`web.hostname` in `product.ts`), the gatekeepers' secrets, and the edge rule below on the
web app's zone.

**The host is named for the product** (ADR 0422 as amended): a first install of product `shop`
makes `shop-app`, `shop-runner`, `shop-gatekeeper-…`, the `shop` database and `shop-…` resources,
and every screen says the product's `label`. A host deployed before client names keeps the
release's (`crm-app`); nothing deployed is ever renamed (ADR 0193).

**Where its data is stored**: `product.ts`'s `location` (for example `"oc"`, Oceania) is a
location hint sent when the first install creates the host's database and buckets; absent, none
is sent. It is a preference, not a guarantee, and a host that exists is never moved (see
[Where data is stored](#where-data-is-stored)).

### Packs
A release carries every pack in the platform repository (`packs/*`; ADR 0420 as amended), and its
client kit lists them in `packs.json`. `product.ts`'s `packs` chooses which the host installs
(`COS_PACKS`). `cos deploy` checks them against `packs.json` only, before any call to Cloudflare,
and refuses a pack the release does not carry, naming the pack and the release. A runner told to
install a pack it does not carry fails loudly: it logs it at start-up and its ping fails, so the
host's `/api/health` answers 503 with the reason, and nothing is installed from that list. A CRM
install (`COS_PACKS` `*`) installs the CRM's own packs, as before.

**A pack the product lists is installed in every deployment of it**, at the first boot after a
deploy, and on a later deploy that adds it; its objects, tools and public reads are there with no
admin step. A pack's `optional` (in its `package.json`) applies only to the release product's own
catalogue (`COS_PACKS` `*`), where an admin chooses: the CRM's lifecycle stage. **A product that
drops a pack** stops installing and updating it, and deletes nothing: the pack stays installed
with its records and keeps working at the version it last had. An admin who wants it gone
disables it (Settings → Extensions, `extension.disable`): its tools stop and its records stay.
No deploy deletes a pack's data.

**Locally,** `pnpm dev` runs the CRM (`COS_PACKS` `*`), with Ticketing, Programs and Content as
optional org extensions an admin installs (`extension.install { id, shipped: true }`, as their
e2e specs do). For a client-shaped host, list the packs:
`COS_DEV_PACKS=ticketing,content pnpm dev`. The local runner then has that `COS_PACKS`, installs
them at boot as a client's host does, and does not deliver them as org extensions: a pack and an
org extension cannot share an id. The CRM's own packs are not installed then unless listed.

### Environments
A product can declare environments (ADR 0450): a staging host and a live host, side by side in one
account, each with its own Workers, database, deployment state, secrets and addresses.

```ts
// product.ts
export const product = defineClientProduct({
  id: "gym",
  label: "Gym",
  platform: { version: "0.3.0", release: "crm", repository: "timoconnellaus/composable-os" },
  packs: ["ticketing"],
  web: { dir: ".", worker: "gym-site", deploy: "own" },
  environments: {
    staging: {
      live: false, // test settings allowed: the fake payment provider
      hostname: "admin.staging.gym.example", // the staff admin's address
      web: { hostname: "staging.gym.example", worker: "gym-site-staging" },
      gatekeepers: {
        "email-send": { ALLOWED_SENDER_DOMAINS: "staging.gym.example" },
        payments: { PAYMENTS_FAKE_PROVIDER: true },
      },
    },
    live: {
      hostname: "admin.gym.example",
      web: { hostname: "gym.example" },
      gatekeepers: {
        "email-send": { ALLOWED_SENDER_DOMAINS: "gym.example", INTERNAL_DOMAINS: "gym.example" },
        payments: {},
      },
    },
  },
});
```

- **Names.** An environment other than `live` is named from the id and its name: `gym-staging-app`,
  `gym-staging-runner`, `gym-staging-gatekeeper-…`, the `gym-staging` database, `gym-staging-…`
  resources, and the web app `<web.worker>-staging`. `live` keeps the names a product without
  environments has (`gym-app`), so a host deployed before environments is the live one. Each name
  can be overridden (`environments.<name>.names`, `.web.worker`); two environments may not share
  one.
- **`cos deploy --env <name>`** deploys that one. With several environments and no `--env` it
  refuses and lists them; with one it deploys it; with none declared it behaves as before, and
  `--env` is refused. Redeploying one never changes the other.
- **Each web app's `HOST`** points at its own environment's host, and each host's
  `CUSTOMER_AUTH_URL` at its own web app, and its `NATIVE_REDIRECT_URIS` at its own app build.
- **Under [Cloudflare Access](#cloudflare-access)** each environment's host is its own hostname,
  so each needs its own pair of Access applications: the one in front of the host, and the Bypass
  one over the paths in [What stays behind Access](#what-stays-behind-access-and-what-is-bypassed).
  The fake payment provider's page (`/gatekeeper/payments/fake/pay/*`) belongs only in an
  environment marked `live: false`; `cos deploy` refuses the fake provider anywhere else. Staff are
  invited per environment: an account on staging is not one on live.

**An adopted site** (`web.deploy: "own"`) keeps its own Worker and its own deploy. `cos deploy
--env <name>` deploys that environment's host and prints what the site's Worker config needs
there, for example:

```
Its Worker (gym-site-staging) in its staging environment needs this service binding, now that the host exists:
  "env": { "staging": { "services": [{ "binding": "HOST", "service": "gym-staging-app", "entrypoint": "ClientApp" }] } }
HOST's target is gym-staging-app, entrypoint ClientApp.
```

Wrangler does not carry `services` from the top level into an environment, so each environment of
the site's config names its own `HOST`. **Order matters:** add a binding only after that
environment's host exists. A site that deploys its main branch on every push would otherwise fail
its own deploy, binding to a Worker that is not there. That is why `cos init` never adds `HOST` to
the top level of an adopted site's config: with `--envs staging,live` it writes the binding under
a matching environment of the site's config (shown as a diff, applied with `--yes`), and prints the
rest, to add once that host is deployed.

**Choosing the site's environment at build time.** A Vite or Astro site built with the Cloudflare
Vite plugin picks its wrangler environment when it is built, from `CLOUDFLARE_ENV`, not with
`wrangler deploy --env`: the build writes the resolved config that the deploy then uses. Build
staging with `CLOUDFLARE_ENV=staging pnpm run build && wrangler deploy`, and live with no
`CLOUDFLARE_ENV` (or the name of its environment, if live has one). A staging site built without it
is bound to the live host.

### Customer sign-in on the web app's hostname
For a product with a web app, `cos deploy` sets the host's `CUSTOMER_AUTH_URL` to that
environment's web app origin (`https://<web.hostname>`, else its workers.dev address), and creates
`CUSTOMER_AUTH_SECRET` as a Worker secret on its first deploy: random, different from the staff
secret, never printed and never written to disk or the repository. A later deploy never changes it.
A product with no web app gets neither.

**What `cos deploy` does not do: sending the codes.** Sign-in codes (customers' and staff's, on the
web app and in the mobile app) go out only through the host's mail connection, and only once a
human admin of that environment's host has chosen it and turned on **Send sign-in codes without
review** for it in Settings → Users. Until then a code request answers `503`
(`sign_in_not_set_up`). It is a human admin's decision, per environment, and no deploy makes it.

**Rotating it** signs every customer out of that environment (their sessions no longer verify):
`pnpm cos deploy --env <name> --rotate-customer-auth-secret`, or by hand
`npx wrangler secret put CUSTOMER_AUTH_SECRET --name <id>-app` with a new random value
(`openssl rand -hex 32`). Do it when the secret may have leaked.

### Staff in the company's mobile app
A pack role (the door role, ADR 0436) can be used from the company's own app (ADR 0451):
`mobile: { dir, roles: ["ticketing.door"] }` in `product.ts` makes `cos client generate` write
`roles/ticketing.door.ts`, a client with only that role's operations, never the whole staff client.
Staff sign in with the template's `staffSession`, by an emailed code or in the system browser.
For the browser, `cos deploy` sets the host's `NATIVE_REDIRECT_URIS` to `<scheme>://staff-sign-in`,
the scheme being `mobile.scheme` (default the product's id; per environment,
`environments.<name>.mobile.scheme`), which the template's `app.config.ts` sets as `expo.scheme`
(an adopted app's `app.json` must match it). The
native sign-in routes the app uses are ADR 0455's (`/api/v1/auth/{customer,staff}/code` and
`/sign-in`, `/api/v1/auth/staff/exchange`, `/api/v1/auth/sign-out`); they answer with tokens and
never a cookie. Staff need an invite with the role first (Settings → Users).

### The mobile app in the phone app stores
The app's store identity is `mobile.app` in `product.ts` (stage 63, ADR 0900): its name, version,
store ids, icon, splash, colours and listing, per environment where it differs. `pnpm cos app
check` says what a store build still needs; the template's `.github/workflows/app.yml` builds,
signs and sends the app to the stores' testing tracks from the client's own store accounts, behind
protected CI environments a person approves, and records each build in the host
(`cos app record`). `pnpm cos app credentials` lists the secrets a person sets. A person releases
to the public. The runbook is [`docs/app-publishing.md`](app-publishing.md); none of it has been
tried on a real store account yet.

### Gatekeepers and their settings
`product.ts` names the gatekeepers a host installs and their settings, for the whole product
(`gatekeepers`) or per environment (`environments.<name>.gatekeepers`, over the product's), by the
gatekeeper's short name (ADR 0452). Each takes only the settings that gatekeeper declares in the
release; `cos deploy` refuses anything else before any call, and applies them as deploy-time
configuration (the verified release is deployed unchanged). Values the deploy can derive are
derived: payments' `BASE_URL` is `https://<the environment's host>/gatekeeper/payments`.

| Gatekeeper | Settings in `product.ts` | Secrets a person sets |
| --- | --- | --- |
| `email-send` | `ALLOWED_SENDER_DOMAINS`, `INTERNAL_DOMAINS`, `sendEmail: { allowedSenderAddresses, destinationAddress, allowedDestinationAddresses }` (the `send_email` binding's limits) | none |
| `payments` | `STRIPE_ACCOUNT`, `PAYMENTS_FAKE_PROVIDER` (only where `live: false`) | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` (`FAKE_WEBHOOK_SECRET` is generated by `cos deploy` where the fake is on) |
| `text` | `TEXT_PROVIDER` (`fake` only where `live: false`), `TEXT_SENDER_NUMBER` (the business's own number, international form) | the provider's keys (`FAKE_WEBHOOK_SECRET` is generated by `cos deploy` where the fake is on) |

Secrets never go in `product.ts`: `cos deploy` refuses one there. After a deploy it names each
missing secret and the command to set it, for example
`npx wrangler secret put STRIPE_SECRET_KEY --name gym-staging-gatekeeper-payments`. It never prints a
value. The fake payment provider, and the fake text provider, are refused in an environment that
is live (`live` itself, any environment not marked `live: false`, or a product without
environments).

#### Sending email (email-send)
1. In the Cloudflare dashboard, turn on Email Service for the sending domain (Email → Email
   Sending), and add the DNS records it asks for.
2. In `product.ts`, set `ALLOWED_SENDER_DOMAINS` to that domain and `INTERNAL_DOMAINS` to the org's
   own, and if you want the binding limited to some addresses, `sendEmail.allowedSenderAddresses`.
3. `pnpm cos deploy --env <name>`.
4. As a human admin on the host, Settings → Integrations: enable email sending, create the org
   connection, then on Settings → Users choose it as the host's mail and turn on "Send sign-in
   codes without review" (ADR 0456). Staff and customer sign-in codes go out from it, to any
   address; until it is on, sign-in by code says it is not set up. `cos deploy` never does
   this step, in any environment.

#### Stripe (payments), in a client repo
The design is ADR 0429; the platform's own test-mode run is
[payments-stripe-runbook.md](payments-stripe-runbook.md). In a client repo nothing is hand-edited:
1. Staging first: `payments: { PAYMENTS_FAKE_PROVIDER: true }` in an environment marked
   `live: false` lets people try checkout with no Stripe account. Deploy it. Since stage 32a
   (ADR 0485) the fake is on off localhost only when the gatekeeper has its own
   `FAKE_WEBHOOK_SECRET`: its default secret is public, and with it anyone could report a paid
   order. `cos deploy` generates that secret for an environment that turns the fake on, the first
   time, and keeps it on later deploys; it is never printed or written to the repo, and you never
   set it. A live environment is refused the fake, so it never gets one. Steps 2 to 4 move staging
   on to Stripe's test mode when you want to try the real provider.
2. In Stripe (test mode for staging, live mode for live), create a restricted key with write access
   to Checkout Sessions and Refunds and read access to Payment Intents. Set it on that
   environment's gatekeeper: `npx wrangler secret put STRIPE_SECRET_KEY --name <id>-staging-gatekeeper-payments`.
   For a Stripe Connect connected account, set `STRIPE_ACCOUNT` in `product.ts`.
3. Add a webhook endpoint in Stripe: `https://<the environment's host>/gatekeeper/payments/in/stripe`,
   with `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `refund.created`
   and `refund.updated`. Set its signing secret:
   `npx wrangler secret put STRIPE_WEBHOOK_SECRET --name <id>-staging-gatekeeper-payments`.
4. Take `PAYMENTS_FAKE_PROVIDER` out (or set it `false`) and `pnpm cos deploy --env staging`.
5. As an admin on the host, Settings → Integrations: enable Payments, create the org connection,
   add the resource Payment account → Stripe. Settings → Orders: the currency, and under "Sites a
   buyer may come back to" the web app's origin.
6. Then checks 2 to 11 of the platform runbook, on the web app. Repeat 2 to 5 for live with live
   keys, on `<id>-gatekeeper-payments`.
7. Tax at checkout (ADR 0479) stays off until the company has set up Stripe Tax in its own
   account (the runbook's "Tax at checkout" part: the head office address and a registration for
   each place it must collect). Then a human admin turns it on in Settings → Orders. A restricted
   key then also needs to create tax locations (for events) and read Checkout Session line items.

### Publishing to npm

The packages a client repo installs (`@composable-os/client`, `sdk`, `product`, `cli`, each
`pack-<id>`, and `create-composable-os`) are built from the release commit by
`scripts/release/npm-packages.ts`; `scripts/release/check-npm-packages.ts` installs them in a fresh
folder, runs `cos create` against the release built in the same run, and type-checks and builds
the result. The release workflow does both and runs `npm publish --dry-run` on every tarball on
each release. It publishes nothing until a person turns it on:

1. Claim the `@composable-os` organisation on npmjs.com, and the unscoped `create-composable-os`
   package name.
2. Publish each package once by hand. npm cannot attach a trusted publisher to a package that
   does not exist yet, so the first version comes from a person's own login: download the
   `npm-packages` artifact of a release run and, in that folder,
   `for t in *.tgz; do npm publish "$t" --access public --tag beta --provenance=false; done`.
   The packages ask for provenance (`publishConfig`), which only the workflow can produce, hence
   `--provenance=false` for this one publish. A new package can take a few minutes to show in the
   registry's listing; a second run answering "cannot publish over the previously published
   versions" means the first one worked.
3. For each package, add the trusted publisher: this repository, workflow `release.yml`, no
   environment, allowed to publish. On npmjs.com (the package's Settings), or with npm 11.15 or
   later: `npm trust github <package> --repo <owner>/<repo> --file release.yml --allow-publish`.
   It asks for two-factor approval in the browser. Publishing then uses GitHub's OIDC token and npm
   provenance; no npm token is created or stored.
4. Set the repository variable `NPM_PUBLISH` to `true` (Settings, Secrets and variables, Actions,
   Variables). The next release's `npm` job publishes the tarballs its `build` job made. Cut a
   release soon after step 3, so the first publish from the workflow follows it.

This was done for this repository on 2026-11-22; `v0.1.0-beta.8` was the first release the
workflow published. A package added later (a new pack) needs steps 2 and 3 once, before the
release that first carries it. The release workflow checks this in its `build` job, before the
release goes public, and stops naming each package that is not on npm yet.
`scripts/release/test/release-completeness.test.ts` fails when a folder under `packs/` is not
built as an npm package and carried by the bundle, or a folder under `blocks/` or
`packs/*/blocks/` is not a block in the client kit, unless its allow-list there says why.

**Dist-tags.** A beta release publishes with `--tag beta`, a stable one with `--tag latest`; the
workflow never moves a tag otherwise. npm gives a package's first version the `latest` tag too,
whatever `--tag` says, so until the first stable release `latest` stays on the version first
published by hand (`0.1.0-beta.7` for the packages of 2026-11-22, later for a pack added after)
while `beta` follows each beta. That is intended: `latest` is for stable releases. Ask for a beta
by its tag (`npx @composable-os/cli@beta`, `@composable-os/pack-<id>@beta`); a client repo pins
exact versions, so it is not affected.

## Option 1 (recommended): `npx @composable-os/cli install`

Installs a published, verified **release bundle** (ADR 0053, ADR 0160) with the Cloudflare API. No
checkout, no wrangler, no service of ours.

```sh
npx @composable-os/cli install            # the CRM (same as --product crm); or: pnpm dlx @composable-os/cli install
```

The CLI is on npm from `0.1.0-beta.7` (dist-tag `beta`). To run it from a checkout of this
repository instead:

```sh
pnpm install && pnpm --filter create-composable-os build
node packages/create-composable-os/dist/cli.js install    # or upgrade / rollback / status / uninstall
```

Everywhere this guide says `npx @composable-os/cli install`, use `node packages/create-composable-os/dist/cli.js install` for now.
Until the first stable release, `npx @composable-os/cli@beta install` gets the newest beta ("Dist-tags" under
"Publishing to npm" above).

It asks for, in order:

1. **A Cloudflare API token.** Create one at *My Profile → API Tokens → Create Token → Custom token*
   (or an account-owned token), limited to the account you install into, with these **account**
   permissions:

   | Permission | Why |
   | --- | --- |
   | Workers Scripts: Edit | upload Workers, versions, deployments, secrets, crons, workers.dev |
   | D1: Edit | create the `crm` database, run migrations, Time Travel bookmarks and restore |
   | Workers R2 Storage: Edit | create the `crm-blobs` bucket |
   | Workers KV Storage: Edit | create the `crm-app-oauth-kv` namespace |
   | Queues: Edit | queues and consumers, once a release declares them |
   | Vectorize: Edit | the `crm-records` index for semantic search (not needed with `--ai off`) |
   | Account Settings: Read | list the account |
   | AI Gateway: Edit | create the deployment's AI Gateway and its custom providers (not needed with `--ai off` or `--ai-gateway off`) |
   | Account API Tokens: Edit | generate the gateway's token (AI Gateway Run and Workers AI Read only), stored as `AI_GATEWAY_TOKEN` |
   | Secrets Store: Edit | only for `--provider-key`: store provider keys in the gateway (BYOK) |

   For a **custom hostname** also add, on that zone, **Zone: Read** and **Workers Routes: Edit**. The
   token is only used by the CLI unless you choose to store it for in-app updates (below). Pass it as
   `--token` or `CLOUDFLARE_API_TOKEN` to skip the prompt.
2. **The account** (asked only when the token sees several).
3. **The hostname:** `workers.dev` (gives `https://crm-app.<subdomain>.workers.dev`) or a hostname on
   one of your zones, e.g. `crm.example.com`, attached as a Worker custom domain.
4. **Sign-in:** Better Auth (email and password) or Cloudflare Access (then the Access team domain
   and AUD; see [Cloudflare Access](#cloudflare-access)).

Then it downloads the newest release on the channel (`--version`, `--channel beta` to choose),
**checks its sha256 against SHA256SUMS and its GitHub build attestation** (and runs
`gh attestation verify` too when the GitHub CLI is installed; `--require-gh` insists), and refuses
a bundle that fails. It creates or finds the D1 database, R2 bucket, KV namespace, queues and the
`crm-records` Vectorize index (with its `object` metadata index), runs the core migrations, uploads crm-runner then crm-app with their assets, generates `BETTER_AUTH_SECRET`, sets
`BETTER_AUTH_URL`, and prints the URL. Open `<url>/setup`: sign up (the first account is the admin)
and the setup wizard takes it from there.

Re-running `npx @composable-os/cli install` repairs an install: it changes only what is missing or wrong and keeps
secrets. Non-interactive use (CI):

```sh
npx @composable-os/cli install --yes --token "$CF_TOKEN" --account "$CF_ACCOUNT_ID" \
  --hostname crm.example.com --identity better-auth --gatekeepers google \
  --secret crm-gatekeeper-google:CLIENT_ID=… --secret crm-gatekeeper-google:CLIENT_SECRET=…
```

Gatekeepers (integrations, ADR 0169) are optional: add them with `--gatekeepers` (now or on a later
re-run) and enable them in Settings → Integrations.

`--location oc` asks Cloudflare to create the database and bucket in Oceania where it can: a
preference, not a guarantee, set at the first install only. See
[Where data is stored](#where-data-is-stored).

In-app AI is on by default: both Workers get the Workers AI and Vectorize bindings, as with
`pnpm run deploy` (see [In-app AI](#in-app-ai)). `--ai off` (or `COS_AI=off`) installs without
them; upgrades keep the choice, and re-running the install with `--ai on` turns it on (the index is
created then). With AI on, every model call goes through an **AI Gateway** that the install
creates for you (see [AI Gateway](#ai-gateway)). `--ai-gateway <id>` picks its id,
`--ai-gateway off` skips it, and `--provider-key deepseek=<key>` stores a provider key in it.
`--model-roles <preset|file|default>` sets this deployment's model roles (see
[Using DeepSeek for every role](#using-deepseek-for-every-role)).
`--ai-admin-token <t>` (or `COS_AI_ADMIN_TOKEN`) stores Settings → AI's token as crm-app's
`CLOUDFLARE_API_TOKEN`.

## Updates

New releases are listed in **Settings → Updates** (admins), from the public GitHub Releases of this
repository, with their changelogs. Pick the **channel** there: **stable** (default) or **beta**.

Every update runs the same procedure, whether from the app or the CLI (ADR 0164):

1. **Preflight:** checks runtime extensions against the new extension contract, and lists pending
   migrations, gatekeeper changes and new secrets. A blocker (an incompatible active extension, a
   missing required secret) stops it and says what to do.
2. Pause automations (the automations kill switch goes on, and goes back off afterwards unless an
   admin had already turned it on), take a **D1 Time Travel bookmark**, apply core migrations, switch all Workers
   to the new version, smoke-check `/api/health`, resume automations.
3. If a migration, the switch or the smoke check fails, the previous release is redeployed and the
   database is restored to the bookmark.

**From the app (one click):** store a scoped token as the `COS_UPDATE_TOKEN` secret on crm-app (with
the permissions above, including the AI Gateway ones, so updates can add the gateway and its
custom providers): `npx @composable-os/cli install --update-token <token>` (or `--store-update-token` to store
the install token), or `wrangler secret put COS_UPDATE_TOKEN --name crm-app`. Then Settings → Updates →
**Preflight** → **Update**. Only human admins can update; every update is audited and listed under
History.

**From your machine (no stored token):** Settings → Updates shows the command:

```sh
npx @composable-os/cli upgrade                  # newest release on the deployment's channel
npx @composable-os/cli upgrade --version 1.4.0
npx @composable-os/cli status                   # installed version, channel, available releases, history
```

### Upgrading past the dry-run fix (ADR 0022 amendment, 2026-11-22)

Release note: _A call waiting for approval no longer does anything before it is approved._ Up to
and including v0.1.0-beta.9, the approval queue's dry run ran an extension tool's code, so a tool
an AI assistant, an MCP client, an automation or another extension called, and the policy sent to
review, had already made its changes while it waited. Approving it made them again. The same was
true of an automation's test mode, and of core actions that start automation runs or an update.
From this release nothing runs until a person approves.

After upgrading, check **Approvals**. Migration 0600 marks every extension tool action that was
still pending at upgrade time. The inbox says its changes may already have been made, and that
approving would repeat them. It recommends rejecting it once you have checked the records it names.
Nothing is rejected for you.

### Upgrading past the business-day fix (ADR 0871, 2026-11-24)

Release note: _Dashboards now count days in your business's time zone._ Until this release every
dashboard's "today", "last 7 days", "this month" and the other date ranges started at midnight UTC,
and `:today` in a widget's SQL was the UTC date. They now start at midnight in the time zone set in
Settings → General (the first-run wizard's), and a day across a change of clocks is 23 or 25
hours. **Every dashboard's figures shift on the day you upgrade** if the business is not on UTC:
nothing in the data changes, only which day each record is counted on. A deployment with no time
zone set keeps UTC.

## Rollback

Settings → Updates → History → **Roll back** on the latest successful update, or:

```sh
npx @composable-os/cli rollback
```

It redeploys the release the update replaced and restores the database to the bookmark taken just
before it (D1 Time Travel keeps 30 days on Workers Paid). **Changes made since the update are lost.**
To undo a restore, use `wrangler d1 time-travel restore crm --bookmark <previous_bookmark>`.

## Privacy

There is no telemetry (ADR 0166). The CLI talks only to the Cloudflare API (with your token) and
GitHub Releases; a deployment only reads public GitHub Releases, when an admin opens Settings →
Updates (cached for an hour).

## Where data is stored

**By default the installer sends no location hint**, and Cloudflare decides where each store
lives (for D1, its API says: as close as possible to whoever creates it, here the machine running
the installer). A new install can ask for a region instead
([ADR 0580](adr/0580-a-location-hint-on-new-installs.md)):

```sh
npx @composable-os/cli install --location oc      # oc is Oceania
```

or, for a client repo, in `product.ts` (`cos deploy` passes it; an environment may set its own,
or `"none"`):

```ts
export const product = defineClientProduct({ id: "gym", /* … */ location: "oc" });
```

Run interactively, a first install asks (default: none). The values are the ones both D1 and R2
take: `wnam`, `enam`, `weur`, `eeur`, `apac`, `oc`. The choice is kept in the deployment state and
shown by `cos status`.

**What it is.** A **location hint**: a preference that Cloudflare follows where it can. It is
**not a guarantee** of where data is kept, and it is **not a promise that data stays in
Australia** (or in any one country). Cloudflare's documentation says so for each store, as read
on 2026-11-23.

**What it covers.**
- **The D1 database**: created with `primary_location_hint` (where the primary database runs).
- **The R2 buckets** (files, attachments, media, the org's extensions): created with
  `locationHint`.
- Only when they are **created**. Cloudflare honours a hint only at creation, so the installer
  sends it then and never to a database or bucket that exists. A release that adds a bucket
  later creates it, on upgrade, with the hint the install was made with.

**What it does not cover.**
- **KV, queues and Vectorize**: Cloudflare's API offers no location hint for them (KV and queues
  offer only a jurisdiction, below), so none is sent.
- **Durable Objects** (the assistant's threads, the runner's workspace, integrations): Cloudflare
  places each one near the first request that reaches it, and a hint is given in code, object by
  object. The host passes none; a business whose staff and customers are in Australia will
  mostly create them from there, but nothing promises it.
- **Logs, analytics, AI Gateway logs, Time Travel and backups, D1 read replicas** and anything
  Cloudflare keeps about the account: not verified to follow the hint. Cloudflare's D1 page says a
  read replica is made in every available region when replication is on (it is not turned on by
  the host).
- **Model providers** the business chooses for AI: wherever that provider runs.
- **Jurisdictions** (`eu`, `us`, `fedramp`), Cloudflare's hard limits, are a different setting
  and are not offered. There is no Australian jurisdiction.

**An existing install is never moved.** `cos install`, `cos deploy` and `cos upgrade` do nothing
to where data already is: a database or a bucket cannot be moved by a setting. Given a different
`--location` (or a `product.ts` location added later), they say so and carry on. Moving a host's
data is an export into a new install, which no command does.

**From a checkout** (`pnpm run deploy`, wrangler creates the database and bucket): no hint is
sent. To have one, create them first with wrangler's own flag, then deploy:
`wrangler d1 create crm --location oc` and `wrangler r2 bucket create crm-blobs --location oc`
(the CRM's names; another product's are in its `product.ts`).

## In-app AI

Model roles (ADR 0009, ADR 0150), summaries (ADR 0153) and semantic search (ADR 0154, ADR 0155).
Everything works without AI; each feature then says "AI is not configured".

**Bindings.** Workers AI (`"ai": { "binding": "AI" }`) and Vectorize
(`"vectorize": [{ "binding": "VECTORIZE", "index_name": "crm-records" }]`), both on crm-app and
crm-runner (whose automation events consumer embeds changed records), are
remote-only, so the committed `wrangler.jsonc` files leave them out (local development and tests
use stand-ins, ADR 0156). `pnpm run deploy` and `create-composable-os` add them from
`apps/app/deploy-inputs.json` and `apps/runner/deploy-inputs.json` (`features.ai`, and the
index's settings under `vectorize`). To do it by hand:

```sh
pnpm exec wrangler vectorize create crm-records --dimensions=384 --metric=cosine
pnpm exec wrangler vectorize create-metadata-index crm-records --property-name=object --type=string
# then add both bindings above to apps/app/wrangler.jsonc and apps/runner/wrangler.jsonc
```

The index's dimensions must match the `embed` role's model (384 for the shipped
`@cf/baai/bge-small-en-v1.5`) and the `VECTORIZE_DIMENSIONS` var. A model of another size needs a
new index. Existing records are embedded by the 10-minute cron after the first deploy (a one-time
backfill), new and changed ones by the automation events consumer seconds after each write.

**Variables** (in `apps/app/wrangler.jsonc`, and the model ones also in `apps/runner/wrangler.jsonc`):

| Name | Kind | Purpose |
| --- | --- | --- |
| `AI_GATEWAY_ID` | var | Send every model call through this AI Gateway (needed for usage and spend per role, and BYOK). Set by `create-composable-os` and the updater to the gateway they create |
| `CLOUDFLARE_ACCOUNT_ID` | var | Your account id: AI Gateway's unified endpoint for non-Workers-AI providers (without it they are called directly), and Settings → AI's Cloudflare API calls |
| `AI_MODEL_ROLES` | var | Deploy-config layer of the registry: JSON, e.g. `{"summarise":{"provider":"openai","model":"gpt-4.1-mini"}}`. Admin overrides in Settings → AI win over it. Set per deployment with `create-composable-os --model-roles` or `COS_AI_MODEL_ROLES` (a preset such as `deepseek-flash`, a JSON file or inline JSON); leave the committed value empty |
| `AI_PROVIDERS` | var | Base URL for `openai-compatible`: `{"openai-compatible":{"baseURL":"https://…/v1"}}` |
| `AI_GATEWAY_BYOK` | var | Providers whose key AI Gateway holds as BYOK, comma-separated, e.g. `deepseek`. Set by `create-composable-os --provider-key`, or `COS_AI_GATEWAY_BYOK` for `pnpm run deploy`. Names only, never keys |
| `VECTORIZE_DIMENSIONS` | var | The Vectorize index's size. Default `384` |
| `AI_SECRET_SCRIPTS` | var | Workers that Settings → AI stores provider keys on. Default `crm-app,crm-runner` |
| `CLOUDFLARE_API_TOKEN` | secret (crm-app) | Settings → AI's token (deploy script: set `COS_AI_ADMIN_TOKEN`). See permissions below |
| `AI_GATEWAY_TOKEN` | secret (both Workers) | The gateway's token (AI Gateway Run and Workers AI Read), sent as `cf-aig-authorization`, and as `Authorization` for Workers AI over REST. Generated by `create-composable-os` and the updater |
| `AI_GATEWAY_REST` | var | `true` when `AI_GATEWAY_TOKEN` can call Workers AI: Workers AI then goes over REST through the gateway with prompt and response logging off ([ADR 0330](adr/0330-self-hosted-workers-ai-over-rest.md)). Set by `create-composable-os` and the updater; empty keeps Workers AI on the binding |
| `AI_KEY_OPENAI`, `AI_KEY_GOOGLE`, `AI_KEY_OPENROUTER`, `AI_KEY_DEEPSEEK`, `AI_KEY_ANTHROPIC`, `AI_KEY_CUSTOM` | secrets (both Workers) | Provider keys, when not held by AI Gateway (BYOK, the default with a gateway). Sent as `Authorization: Bearer …`. Set from Settings → AI, or with `wrangler secret put` on both Workers. Never stored in D1 |
| `AI_KEY_ASSEMBLYAI` | secret (both Workers) | AssemblyAI's key, for the speech roles `transcribe` and `speak` ([ADR 0351](adr/0351-assistant-model-roles.md)). Voice is off until it is set; it does not make text AI "configured". Stored as a secret (AssemblyAI is called directly, not through AI Gateway). Set from Settings → AI or with `wrangler secret put`. Never stored in D1 |
| `TYPESAFE_API_KEY` | secret (both Workers) | The judge's key (Jev, [ADR 0230](adr/0230-jev-as-the-typed-judge.md)), when AI Gateway does not hold it. `wrangler secret put TYPESAFE_API_KEY` on both Workers, or Add key in Settings → AI's Judge section (needs the Cloudflare API access that provider keys need; [ADR 0234](adr/0234-judge-settings-spend-and-key.md)). Without it and without `JUDGE_BYOK`, the judge is off and nothing changes. Never stored in D1, logged or returned |
| `JUDGE_BYOK` | var | `true` when AI Gateway holds TypeSafe's key as BYOK under the custom provider `custom-typesafe` (installs create it, inert without a key). Set by `create-composable-os --provider-key typesafe=…` |
| `JUDGE_PLACEMENTS` | var | The deploy layer of the judge's placement switches, JSON, e.g. `{"summary.statements":true,"outbound.message":true,"sync.jobChange":true}` to turn on the placements that send record content (off in a fresh install; [ADR 0232](adr/0232-judge-defaults-and-user-decisions.md)). Set it on both Workers: crm-app checks summaries, crm-runner checks outbound messages and synced signatures. Ignored for record-content placements on a hosted deployment Admins override it in Settings → AI. TypeSafe processes in the US with zero retention only on request: ask for it before turning record-content placements on for anyone else's data |
| `AI_FAKE_VOICE` | var | Local development and e2e only (`.dev.vars`): stand-in speech providers, with no key and no network. Wins over `AI_KEY_ASSEMBLYAI`. Never set it in production |
| `AI_FAKE_MODEL` | var | Local development and e2e only (`.dev.vars`): deterministic stand-ins for every role and in-memory vectors when there is no `ai` binding. Never set it in production |

**Settings → AI's API token** (`CLOUDFLARE_API_TOKEN` on crm-app). Create a custom token scoped
to your account with:

- Account → **AI Gateway → Edit** and Account → **Secrets Store → Edit**: store keys in AI Gateway
  (BYOK). This is the key form's default when the deployment has a gateway;
- Account → **Workers Scripts → Edit**: store provider keys as Workers secrets instead (each save
  creates a new version of crm-app and crm-runner with the secret);
- Account → **AI Gateway → Read**: usage and spend per role.

Leave it unset and Settings → AI shows these instructions instead of the key form; keys can still
be set with `wrangler secret put AI_KEY_OPENAI --name crm-app` (and `--name crm-runner`).
No role defaults to a third-party provider: every shipped default is a Workers AI model, so a
deployment needs no third-party key.

### AI Gateway

All AI calls go through AI Gateway by default (ADR 0180), and provider keys are stored there as
BYOK. With AI on, `create-composable-os` (install and re-run), `cos upgrade` and Settings → Updates each
check the following and create whatever is missing:

- **A gateway per deployment**, named after the install (`crm` for `crm-app`; `--ai-gateway <id>`
  to choose). It has logging on and **authentication on**. An existing gateway with that id is
  reused, and its logging and authentication are turned on if they were off.
- **Custom providers** listed in `apps/app/deploy-inputs.json` under `aiGateway.customProviders`.
  None ship: the optional providers the registry knows (OpenAI, Google AI Studio, OpenRouter,
  DeepSeek, Anthropic) are built in to AI Gateway (ADR 0192).
- **`AI_GATEWAY_ID`** on crm-app and crm-runner, and **`AI_GATEWAY_TOKEN`** on both. The token is
  an account API token with only **AI Gateway Run** and **Workers AI Read**, scoped to the
  account, generated once and created again only if a Worker has lost it. A token generated
  before ADR 0330 (AI Gateway Run only) is replaced once, and the old one deleted after the new
  one is deployed. Other providers send it as `cf-aig-authorization`.
- **`AI_GATEWAY_REST=true`** on both, once the token can call Workers AI (ADR 0330). Workers AI
  (the default for every role) then goes over REST through the gateway with prompt and response
  logging off. Metadata, tokens and cost are still logged, so Settings → AI's usage works.

**How calls are routed** (ADR 0203, ADR 0330). Workers AI, with `AI_GATEWAY_REST`:
`https://api.cloudflare.com/client/v4/accounts/<account>/ai/v1/chat/completions` (and
`…/ai/v1/embeddings`) with `cf-aig-gateway-id: <gateway>`, `cf-aig-collect-log-payload: false`,
the role in `cf-aig-metadata` and the gateway token. Without it, the `ai` binding with its
`gateway` option, which logs prompts and responses in the gateway (the binding cannot turn off
payload logging alone). Other built-in providers: the gateway's unified endpoint
`https://gateway.ai.cloudflare.com/v1/<account>/<gateway>/compat/chat/completions`, with the model
as `provider/model` (`deepseek/deepseek-flash`, `openai/gpt-4.1-mini`,
`google-ai-studio/gemini-2.5-flash`). Embeddings from a third-party provider use its native
gateway path. Every gateway call carries `cf-aig-metadata: {"role": …}` for usage per role. With
BYOK no provider `Authorization` header is sent, so the gateway adds the stored key. With
`--ai-gateway off` (no `AI_GATEWAY_ID`) Workers AI is called over the binding directly and other
providers at their own URL, with a key from a Workers secret.

Permissions: the table in [Option 1](#option-1-recommended-npx-composable-oscli-install). If the token lacks
AI Gateway Edit, the install still finishes: it warns and calls Workers AI directly. If it lacks
Account API Tokens Edit, the gateway is still created, but you must set `AI_GATEWAY_TOKEN` yourself.
To do that, create a token with Account → **AI Gateway → Run** and Account → **Workers AI → Read**
and pass it with `--secret AI_GATEWAY_TOKEN=…` (it goes on both Workers). The installer checks a
supplied token by listing one Workers AI model with it: if that is refused, Workers AI stays on the
binding (prompts logged) and it says so. An upgrade whose token lacks Account API Tokens Edit
keeps an older Run-only token and Workers AI on the binding, with a warning. `--ai-gateway off` turns all of this off.
Uninstall deletes the gateway only if the install created it.

**Provider keys (BYOK).** A provider that AI Gateway supports natively, such as `deepseek`,
`openai` or `google-ai-studio`, needs only a key:

```sh
npx @composable-os/cli install --provider-key deepseek=<DEEPSEEK_API_KEY>   # re-run install; never printed
npx @composable-os/cli install --provider-key openai=<OPENAI_API_KEY>
```

This also adds the provider to `AI_GATEWAY_BYOK` on both Workers, so the model registry knows the
gateway holds its key. You can also add a key later in **Settings → AI** (it stores keys in the
gateway by default, the same way, and records the provider itself), or in the dashboard (AI
Gateway → your gateway → Provider keys). In the dashboard case, also add the provider to
`AI_GATEWAY_BYOK`. A key is replaced, never
duplicated, and is never written to D1, a Worker or the output. Code that needs to store a key
calls `setGatewayProviderKey(accountId, gatewayId, provider, key)` on `@composable-os/release`'s
`CloudflareClient`. Storing keys needs **Secrets Store: Edit** and **AI Gateway: Edit**.

**Adding a custom provider.** For a provider AI Gateway does not have built in, add an entry to
`aiGateway.customProviders` in `apps/app/deploy-inputs.json`, then build a release and upgrade:

```json
{ "slug": "example-llm", "name": "Example LLM", "baseUrl": "https://llm.example.com" }
```

The slug is lowercase, without the `custom-` prefix, and the base URL is the API root (`https://`
only): the gateway appends the request path to it. It is called as `custom-<slug>`, and
`--provider-key example-llm=<key>` stores its key under that name, and so does Settings → AI's key
form (provider "AI Gateway custom provider", slug `example-llm`). You can also create one by hand
in the dashboard (AI Gateway → Custom providers). In the model registry a role names it with the
provider `custom` and the gateway's model id, `custom-<slug>/<model>`, and declares the model's
capabilities (ADR 0203), e.g. in `AI_MODEL_ROLES`:

```json
{ "assistant.core": { "provider": "custom", "model": "custom-example-llm/some-model",
  "capabilities": { "chat": true, "toolUse": true, "jsonSchema": false, "jsonObject": true,
    "vision": false, "embedding": false, "contextTokens": 128000 } } }
```

A custom provider is reached only through the gateway (its key is always BYOK).

### Using DeepSeek for every role

The shipped defaults put every text role on Workers AI. One deployment can instead run every text
role on **DeepSeek V4.1 Flash** (`deepseek-flash`, on DeepSeek's own platform),
through AI Gateway, with each role's Workers AI default as its fallback. `embed` stays on Workers
AI (`bge-small-en-v1.5`, 384 dims), because DeepSeek has no embedding model, and the speech roles
stay on AssemblyAI. This is the
**`deepseek-flash` model role preset** (ADR 0192). It is per-deployment config: nothing is
committed and the shipped defaults do not change.

| Role | Model | Fallback | Thinking |
| --- | --- | --- | --- |
| build, summarise, extract, classify, vision, dictation.cleanup | deepseek-flash | the role's Workers AI default | off |
| assistant.core, assistant.subagent, review | deepseek-flash | the role's Workers AI default | on |
| embed | bge-small-en-v1.5 (Workers AI) | none | |
| transcribe, speak | AssemblyAI (needs `AI_KEY_ASSEMBLYAI`) | none | |

`AI_MODEL_ROLES` still accepts the old role name `assistant` and reads it as `assistant.core`,
with a deprecation warning in the logs ([ADR 0351](adr/0351-assistant-model-roles.md)). A layer
that sets `assistant.core` and not `assistant.subagent` or `dictation.cleanup` gives them the same
model (dictation keeps thinking off).

**With `create-composable-os`** (recommended). This needs a release that includes ADR 0192: an older
release's Workers do not know the `deepseek` provider and ignore the preset.

1. Create an API key on the DeepSeek platform (https://platform.deepseek.com).
2. Make sure the install token has **AI Gateway: Edit** and **Secrets Store: Edit** (the table in
   [Option 1](#option-1-recommended-npx-composable-oscli-install)).
3. Re-run the install against the deployment. A re-run repairs and keeps everything else, and on
   a new account it installs:

   ```sh
   npx @composable-os/cli install --model-roles deepseek-flash --provider-key deepseek="$DEEPSEEK_API_KEY"
   ```

   This does three things:
   - stores the key in the deployment's AI Gateway as BYOK, under the built-in `deepseek`
     provider;
   - sets `AI_GATEWAY_BYOK=deepseek` and the preset's `AI_MODEL_ROLES` on crm-app and crm-runner;
   - records both in the deployment state, so `cos upgrade` and Settings → Updates keep them.

   The key is never printed or written to D1 or a Worker.
4. Open **Settings → AI**. Each role except `embed` shows `deepseek-flash` with source
   "deploy", and DeepSeek shows as ready (BYOK). Press **Test** on a role to check it.

To go back to the shipped defaults, run `npx @composable-os/cli install --model-roles default`. The key stays in
the gateway until you delete it there. Settings → AI overrides still win role by role, and
`--model-roles` also takes a JSON file or inline JSON in the same shape as `AI_MODEL_ROLES`. It is
checked when you run it, and a model a role cannot use fails the command.

**With `pnpm run deploy`** (from a checkout). Put these in a git-ignored env file (for example
`.env.deploy`) and use it on **every** deploy, because a deploy without them resets the vars to
the committed empty values:

```sh
COS_AI_MODEL_ROLES=deepseek-flash   # becomes AI_MODEL_ROLES on both Workers
COS_AI_GATEWAY_BYOK=deepseek        # only when the key is in the gateway (below)
```

The deploy script does not create a gateway (ADR 0180), so choose one way to supply the key:
- **With a gateway, key in the gateway:** set `COS_AI_GATEWAY_ID`, `CLOUDFLARE_ACCOUNT_ID` and
  `AI_GATEWAY_TOKEN` in the env file. Add the DeepSeek key in the dashboard (AI Gateway → your
  gateway → Provider keys → DeepSeek), and keep `COS_AI_GATEWAY_BYOK=deepseek`.
- **Key as a Workers secret:** leave `COS_AI_GATEWAY_BYOK` unset and put `AI_KEY_DEEPSEEK` in the
  env file; the deploy sets it on both Workers. Calls go through the gateway if you set one, and
  straight to `https://api.deepseek.com` if not.

**Things to know.**
- **The `review` role is no longer independent.** The policy adjudicator (ADR 0031) is meant to
  judge with a different model from the assistant's. With this preset both are `deepseek-flash`.
  Before you switch the adjudicator from shadow to active, consider overriding `review` in
  Settings → AI (for example, back to `@cf/openai/gpt-oss-120b`).
- `deepseek-flash` is an alias that tracks DeepSeek's latest Flash model, so its behaviour can
  change under the same name.
- DeepSeek supports JSON mode but not `json_schema`, tool calls, image input and a
  1,048,576-token context. The JSON roles parse and validate their output, so JSON mode is
  enough (ADR 0192).
- If DeepSeek has no key (no BYOK and no `AI_KEY_DEEPSEEK`), its roles fail with "not
  configured" rather than falling back. The fallback is used when a DeepSeek call fails.

**Real-model checks.** The semantic search relevance set runs against the real embedding model
with `CLOUDFLARE_ACCOUNT_ID=… CLOUDFLARE_API_TOKEN=… pnpm --filter @composable-os/core relevance:real`
(a token with Workers AI Read). The eval harnesses in `evals/` take their default model from the
registry's `assistant.core` role.

## Option 2: Deploy to Cloudflare button

The button in the README forks the repository into your GitHub account, creates the `crm` D1
database, asks for the secrets in `apps/app/.dev.vars.example`, and connects Workers Builds.
Workers Builds then runs `apps/app`'s `deploy` script, which is the same deploy script as below:
it deploys `crm-runner`, applies migrations and deploys `crm-app`.

After it finishes, open `https://crm-app.<your-subdomain>.workers.dev/sign-in` and create the first
account: the page offers it until the deployment has a user, and that user is the only one allowed
to sign up while `AUTH_ALLOW_SIGNUP=false`.

## Option 3: From a checkout (manual)

```sh
pnpm install
pnpm exec wrangler login        # or set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID

export BETTER_AUTH_SECRET=$(openssl rand -hex 32)
export BETTER_AUTH_URL=https://crm-app.<your-subdomain>.workers.dev   # optional
pnpm run deploy
```

Use `pnpm run deploy`, not `pnpm deploy`: `deploy` is a built-in pnpm command, so the bare form
never reaches our script.

`scripts/deploy.mjs` runs, in order:

1. checks that a first deploy has `BETTER_AUTH_SECRET`, and builds crm-runner's generated modules;
2. creates what is missing: the four queues, the `crm-app-oauth-kv` namespace and, with AI on (the
   default; `COS_AI=off` skips it), the `crm-records` index and its `object` metadata index;
3. writes a `wrangler.deploy.jsonc` for each Worker, with the `ai` and `vectorize` bindings (see
   [In-app AI](#in-app-ai)), this deployment's AI vars, and without bindings for local development
   (`deploy-inputs.json` `devOnly`);
4. `wrangler deploy` for `crm-runner` (creates the `crm` D1 database and `crm-blobs`);
5. `wrangler d1 migrations apply DB --remote` (core migrations, tracked in `core_migrations`);
6. `vite build` and `wrangler deploy` for `crm-app`.

Secrets in the environment are passed with `--secrets-file`: the AI ones (`AI_GATEWAY_TOKEN`,
`AI_KEY_*`, `TYPESAFE_API_KEY`) to both Workers, and the rest to crm-app. Later deploys keep the
secrets already set. `COS_AI_GATEWAY_ID`, `CLOUDFLARE_ACCOUNT_ID`, `COS_AI_GATEWAY_REST`,
`COS_AI_MODEL_ROLES` and `COS_AI_GATEWAY_BYOK` become vars on both Workers, and `BETTER_AUTH_URL`
also sets crm-runner's `APP_ORIGIN`. A deploy without them resets those vars, so keep them in one
env file. Re-running after a failure is safe.

`pnpm run deploy -- --dry-run` builds and validates both Workers without touching an account.

Check the result with `node scripts/smoke-deployment.mjs https://crm-app.<subdomain>.workers.dev`,
which reads `/api/health`, the sign-in page and its static assets and changes nothing.

## Cloudflare Access

1. Create a self-hosted Access application for the app's hostname and copy its AUD tag.
2. Set `IDENTITY_PROVIDER` to `cloudflare-access` in `apps/app/wrangler.jsonc`.
3. Set the `CF_ACCESS_TEAM_DOMAIN` and `CF_ACCESS_AUD` secrets, then deploy.

Every request is then admitted only with a valid `Cf-Access-Jwt-Assertion` header (or
`CF_Authorization` cookie) signed by your team, for your application. Protect every hostname the
Worker answers on (including `workers.dev`, or turn it off), since requests without the JWT are
rejected but should never get that far.

The desk origin (`desk.` before the host's name, ADR 0649) is a hostname of its own: leave it out
of the Access application. The tablet holds no Access sign-in, and the desk origin's own handler
serves only the tablet's two pages and its calls (an enrolled device's credential and a session a
person on the staff started), never an admin page, and refuses a call that carries a staff
session.

### What stays behind Access, and what is bypassed

A host that only staff use needs only the MCP bypass below. A **client host** also serves
customers, the public, payment providers and other outside callers, who never pass Access. Add a
second Access application on the same hostname with a **Bypass** policy (Include: Everyone) for
the paths below; Access applies the most specific application's path, so everything else stays
behind the first application. The list is `apps/app/src/server/access-layout.ts`, and
`apps/app/test-node/access-layout.test.ts` fails when a route is added that it does not account
for.

| Path | When | How it authenticates without Access |
| --- | --- | --- |
| `/api/v1/*` | always | The HTTP surface decides the caller itself: a native app's bearer token (looked up by hash), a customer cookie signed with `CUSTOMER_AUTH_SECRET`, or an Access JWT verified against your team's keys, issuer and AUD, never trusted unverified. Anything else is the public. Browsers from other origins are refused unless in `API_ALLOWED_ORIGINS`, and a staff cookie from any origin but the host's own is refused there too (ADR 0660). Native sign-in routes take a code and store only hashes. `/api/v1/media/<id>` is a published post's picture for a phone or any outside caller: served only when content they may read shows it (`media.serve`). `POST /api/v1/media` is an upload by a staff device token only (`cos content import`, ADR 0470), and `POST /api/v1/media/<id>/captions` a video's captions the same way (`cos courses import`, ADR 0495): no cookie is taken there |
| `/api/v1/staffing/feed/*` | always (inside `/api/v1/*`; listed so it stays bypassed) | A staff member's private calendar feed (stage 45, ADR 0628), polled by a calendar app that cannot sign in: the 32-byte random token in the address is the credential, looked up by its SHA-256 (the host keeps nothing else of it); only that person's own shifts, while their account is active and holds the Rostering permission; any other token or path is a 404 like a missing route; limited per token and per address. Cloudflare's own request logs record URLs when Workers Logs are on, so an account member reading them could see a feed's address: turn invocation logs off if that matters, and a person can always rotate theirs |
| `/api/v1/me/feed/*` | always (inside `/api/v1/*`; listed so it stays bypassed) | A customer's private calendar feed (stage 62, ADR 0890), the same way: the token's SHA-256 looked up in its own table (a staff feed's token opens nothing here), answering only that customer's and their live dependants' bookings, read as the customer, while the account is active; any other token or path is a 404 like a missing route; limited per token and per address. The same note on request logs holds |
| `/api/customer-auth/*` | customers | Customer sign-in by emailed code, its own secret and tables |
| `/api/practitioner-auth/*` | outside practitioners | Practitioner sign-in by emailed code (stage 43, ADR 0581): invited or active accounts only, a key derived from `CUSTOMER_AUTH_SECRET`, its own tables |
| `/api/health` | always | Health and version only (`cos deploy` and monitors read it) |
| `/gatekeeper/payments/in/*` | payments | The provider's webhook signature (`STRIPE_WEBHOOK_SECRET`) |
| `/gatekeeper/text/in/*` | text messages | The text provider's webhook signature (receipts and STOP, START and HELP replies) |
| `/gatekeeper/webhook/in/*` | inbound webhooks | Each endpoint's own signing secret |
| `/gatekeeper/google/pubsub` | Gmail or Chat push | A Google-signed OIDC token for the configured service account |
| `/gatekeeper/microsoft/outlook/notifications/*` | Outlook push | The subscription's random `clientState` |
| `/mcp`, `/oauth/token`, `/oauth/register`, `/.well-known/*` | MCP clients | MCP's own OAuth 2.1 bearer tokens and PKCE codes |
| `/buy`, `/order/*`, `/_serverFn/*`, `/assets/*` | customers buy on the host's own pages | The guest pages call the surface as the public; an order page needs the order's token; a server function needs a verified staff principal unless it is in a `*.public.ts` file; assets are public |
| `/f/*` | the Forms pack is installed | A form's own page (stage 29, ADR 0728), for a link or a QR code: public by nature. Its calls go to the HTTP surface through the client-app binding's door, as a customer by their verified cookie or the public, never staff; the form door checks the form is open to them, Turnstile, the fill time and the caps. Never framed or cached, no cookie set |
| `/form` | the Forms pack is installed (personal links are emailed whatever else the host serves) | A personal link's page (ADR 0723), when Settings → Routine email names the host's own address as the business's site: the 32-byte random token in its address (only its SHA-256 kept) is the only credential, for one Person and one form, used once and only by the send. **Bypass it**: behind Access the token would go into Access's login redirect. Cloudflare's own request logs record the first request's address, token included, when Workers Logs are on, so an account member reading them could see an unused link: turn invocation logs off if that matters (on the host and on the web app's Worker, which serves the same page) |
| `/gatekeeper/payments/fake/pay/*` | test environments only | The fake provider's checkout page (`PAYMENTS_FAKE_PROVIDER=true`), never live |

Behind Access: the staff app (every page), `/sign-in`, `/api/auth/*`, the assistant
(`/api/assistant/*`), support access (`/support/*`), `/oauth/consent` (where a person signs in for
MCP), `/connect/handoff`, `/api/media/*` (the media library: staff upload and view pictures; a company's
site shows its pictures through its own `/api/media/<id>` route over the binding, and a phone asks
`/api/v1/media/<id>`), `/api/agreements/*` (staff download a signed agreement's PDF and a
version's blank form; a customer downloads their own at `/api/v1/agreements/…` or over the
binding), `/blocks` (development only; nothing there when deployed), `/native/staff-sign-in` (a native app's staff sign-in in the system
browser), and every other `/gatekeeper/*` route: OAuth callbacks and connect pages open in a staff
member's browser, which carries the Access cookie.

None of the bypassed paths reads an Access header it would no longer receive: only the identity
adapter reads `Cf-Access-Jwt-Assertion` or `CF_Authorization`, and only to verify it. On a
bypassed path a staff member's browser may still send the `CF_Authorization` cookie, which is
verified as anywhere else; a cross-site page cannot use it, because the surface refuses an origin
it does not list.

`cos content import`, `cos courses import` and the other import commands, `cos rostering import` among them ([docs/importing.md](importing.md)), sign staff in through the system browser
under Access: add `http://127.0.0.1/cos-sign-in` (no port) to `NATIVE_REDIRECT_URIS`, and the
command's one-time code comes back to whichever port it listens on.

Under Access, staff are added by invite as above (the invite sets the role; Access decides who gets
in), and a native app's staff sign-in uses the system browser: set `NATIVE_REDIRECT_URIS` to the
app's address.

## Upgrades from source

For the button and checkout installs: pull the new release (or merge upstream into your fork) and run
`pnpm run deploy` again (Workers Builds does this on push). Migrations apply before the new `crm-app`
is deployed, so `/api/health` reports `upToDate: true` once the deploy finishes. Settings → Updates
says the deployment is from source and does not offer in-app updates.

## Building a release yourself

```sh
node scripts/release/build-release.ts --version 1.2.3 --out release-out
node scripts/release/inspect-bundle.ts release-out/composable-os-crm-1.2.3.tar.gz
```

Releases are built by `.github/workflows/release.yml` on a `vX.Y.Z` / `vX.Y.Z-beta.N` tag; see
[`scripts/release/README.md`](../scripts/release/README.md).

## A host of many clients (stage 66 step 7)

One deployment of the host serving many clients, each with a database of its own (stage 66, ADRs
0613 to 0618). Live and staging are two deployments, each with its own Workers, registry, queues,
cos-client-db and keys. Nothing here changes a single-client install. Not yet run on Cloudflare:
every command below is proved locally and against the fake API only, until the staging check
([Proving a host of many clients on Cloudflare](#proving-a-host-of-many-clients-on-cloudflare-stage-66))
is run.

```sh
# Once per environment: the deployment's keys, into a file outside any repository (mode 0600).
cos fleet keys --env staging --out ~/fleet-keys/staging.json
# The host, its registry (migrated), cos-client-db, the operator's Worker, every fleet binding.
# --location <hint> and --ai off are chosen here, at the first install only.
cos fleet install --env staging --keys-file ~/fleet-keys/staging.json \
  --callback-hostname callback-staging.<fleet domain> --domain <fleet domain> --location oc
# A client: its registry rows, its database made and migrated, its hostnames. No upload.
cos client add gym-a --env staging --location oc --web-hostname staging.gym-a.example
cos client secret set gym-a GOOGLE_CLIENT_SECRET --env staging   # asked for, hidden; sealed
# Its sender domain: added unverified; verify once it is onboarded to Email Sending in this account.
cos client sender add gym-a gym-a.example --env staging
cos client sender verify gym-a gym-a.example --env staging
# A release across every client: staging first, then live.
cos fleet upgrade --env staging --keys-file ~/fleet-keys/staging.json --version 1.4.0
cos fleet upgrade --env live --keys-file ~/fleet-keys/live.json --version 1.4.0
# A leaving client takes its data and its secrets; its own install keeps them.
cos client export gym-a --out ./gym-a-export --leaving
cos install --import ./gym-a-export          # in the client's own account
cos client remove gym-a                      # export kept 90 days, then erased; id never reused
```

- **The keys file** holds the root key, the sealing key pair, the binding key and the props key.
  `cos fleet keys` writes it once, refuses a path inside a git working tree, and never prints a
  key; every `cos fleet install` and `upgrade` reads it (the props of the host's bindings are signed
  with the props key). It must be the file the fleet was installed with: `cos` compares it with the
  deployment's sealing public key and a fingerprint of its keys, and refuses any other with nothing
  changed. Losing it means a planned move of every client: keep it as you keep the account's
  token.
- **The operator's Worker** (`<prefix>operator`) is how `cos` reaches clients' databases. Each
  command sets it a fresh random token and replaces it at the end; it answers nobody else. Setting
  the token deploys a new version of the Worker, which takes a few seconds to reach every copy of
  it: a call a copy on the earlier version refuses ("not the operator", before it does anything)
  is tried again for up to a minute, and `cos` says so. `cos uninstall` and `cos rollback` refuse a
  fleet's deployment, as `cos install` and `cos upgrade` do. One command at a time uses it: a second command that needs it (`add`, `export`, `import`, `remove`,
  `fleet upgrade`) is refused, before it changes anything, while another runs. `list`, `secret` and
  `sender` do not use it and are safe to run beside one; `pause` and `resume` are refused while an
  update is unfinished (the update resumes every client it paused at its end). A running command
  keeps its hold alive however long it takes; one that was killed holds it for 30 minutes, and
  `--take-over` takes it sooner, when you know nothing else is running.
- **Every command that removes or overwrites** asks for the client's id (or `--yes`); every command
  takes `--dry-run`; every command that stops part-way is carried on (or, for an update, finished or
  undone) by running it again: `cos client list` shows what is part-way.
- **An update** pauses every client, bookmarks and migrates each, uploads the Workers once, checks
  them at the host's own health address (`https://<callback hostname>/api/health`, which answers
  while clients are paused) and resumes. A client whose migration fails is restored, and so
  is every client migrated before it; nothing is uploaded. A client's own extension on a contract
  the new release does not run stops the update before anything changes.
- **Export and import** carry the database, files and secrets, not videos: an import re-stamps the
  client's videos this account's Stream holds with its creator, and names any it does not (copying
  videos is issue #525). `cos client import <id> --from <dir>` adds a new client only; an existing
  id is refused, and so is an import while an update is unfinished.
- **What an export's checks catch:** its hashes catch a damaged or cut-short part or file, not a
  folder someone edited on purpose (the manifest is not signed): **import only an export you
  trust**. An import filters the SQL it carries (no view, no virtual table, nothing that names a
  core table), but that filter is no proof an export is harmless (ADR 0618; issue #532). A client
  on Bookings or Rostering cannot be imported yet: their triggers keep core tables, and the
  import refuses them.
  `secrets.json` is **unencrypted** JSON (mode 0600) holding the client's session keys and given
  secrets: keep it as a password, and delete it once imported.
- **A client's web app is on its own domain**, never under the fleet's domain beside the staff
  hostnames: `cos client add` names a web hostname only with `--web-hostname`, and refuses one
  anywhere under the fleet domain's registrable domain (it has no Public Suffix listing).
- **Email sending** is the one gatekeeper of a host of many clients: `cos fleet install` installs
  the email-send gatekeeper and `cos fleet upgrade` keeps it (a fleet installed without it gains it
  at its next upgrade); there is no flag for it (ADR 0618, "A fleet's gatekeepers"). It needs no
  secret: Cloudflare Email Service is a binding in the fleet's own account. Its `INTERNAL_DOMAINS`
  is always empty on a fleet. **A client's sign-in mail**, in order:
  1. The operator onboards the client's sending domain to Email Sending in the fleet's account
     (Email → Email Sending in the dashboard); every record it adds must show valid. **The domain
     must be exactly the domain of the From address**: verifying `gym.example` does not allow
     `hello@mail.gym.example`; register `mail.gym.example` itself for that.
  2. The operator runs `cos client sender add <id> <domain>`, then `cos client sender verify <id>
     <domain>`.
  3. The client's human admin, in the app: Settings → Integrations, turn on email sending and
     create the org connection; bind a sender address on the verified domain (`hello@<domain>`);
     then Settings → Users, choose that connection as "The host's mail" and turn on "Send sign-in
     codes without review". This needs the Balanced approval policy and an `APPROVAL_FLOOR` that
     does not review the host's sends ("Customer sign-in" above).

  Until all three are done, a sign-in code request answers 503 `sign_in_not_set_up` and no code is
  made. A client sends only from its own verified domains, never another client's or the fleet's
  own. A pause, an unverify or a removal reaches a running host within 10 seconds (its registry
  check, `REGISTRY_REFRESH_MS`); from then nothing is sent for that client while it is paused (a
  send queued before may still be approved once it is resumed), and nothing ever after it is
  removed.
- **A client's first day, in order** (stage 66 step 9; ADR 0618, "The first client's day one").
  The fleet's commands run in the operator's workflow, in a public repository whose logs anyone
  can read, so nothing that could make a client's first account is ever in it: only a hash.
  1. **The owner makes the setup token, on his own machine** (no Cloudflare token needed; refused
     in CI):
     ```sh
     cos client first-admin-token --staff-hostname gym-a-admin.<fleet domain>
     ```
     It prints the link (`https://gym-a-admin.<fleet domain>/sign-in#first-admin=<token>`) and the
     token's SHA-256. He keeps the link and gives the workflow only the hash.
  2. **The workflow adds the client with its first admin**, the hash as a plain input:
     ```sh
     cos client add gym-a --env staging --location oc --label "Gym A" \
       --admin owner@gym-a.example --admin-token-sha256 <sha256> --yes
     ```
     It prints neither a token, a link nor the address: only that the first admin is stored, and
     until when (72 hours). A new hash replaces the last:
     `cos client first-admin gym-a --email owner@gym-a.example --token-sha256 <sha256>`.
  3. **The owner sends the link to the client's admin himself.** Only that address, with that
     link, by password sign-up, before it expires, makes the client's first account, which is its
     admin. With no admin named, nobody can. The link does nothing once the client has an account;
     `first-admin` cannot tell whether it has one (the people are in the client's database, which
     these registry commands do not open), so naming one again then is harmless and does nothing.
  4. **The admin signs up** at the link, then sets up mail in the app (the sign-in mail steps
     above: the operator's `cos client sender add` and `verify`, then Settings → Integrations and
     Settings → Users).
  5. **Packs, origins and redirects** with `cos client setting` (below): the client's packs, its
     own site's origin, its app's sign-in redirect.

  `--print-link` (cos makes the token and prints the link once) is for a self-hosted operator at a
  terminal, and is refused when `CI` or `GITHUB_ACTIONS` is set. `cos client setting list` shows
  the first admin as set, with its expiry, and its address only with `--show-email`. A
  single-client install is as before: its installer signs up at `/setup` right after the deploy.
- **A running client's settings** (`cos client setting list|set|unset <id> [NAME] [value]`, and
  `cos client add --setting NAME=VALUE`): only `COS_PACKS`, `API_ALLOWED_ORIGINS`,
  `NATIVE_REDIRECT_URIS`, `APPROVAL_EXPIRY_DAYS` and `COS_PRODUCT_LABEL`, each value checked before
  it is written; replacing or removing one asks for the client's id (or `--yes`). Every other
  setting is refused, at `add` too, with the reason: the deployment's value applies
  (`APPROVAL_FLOOR`, `IDENTITY_PROVIDER`, the AI settings), its own command writes it
  (`COS_FIRST_ADMIN`; `COS_ORG_EXTENSIONS`, the client repository's deploy), or it is never right
  on a fleet (`AUTH_ALLOW_SIGNUP`). The registry's own write holds the same list. A change reaches
  a running host within 10 seconds (its registry refresh).
  - **`COS_PACKS` only widens**: every pack must be one the installed release carries, with the
    packs it requires named too (Courses: Programs and Content), and none of the client's own list
    taken out (a pack taken out stays installed and is no longer updated by a release). The host
    installs a newly listed pack, its objects and migrations, at the client's next staff or API
    request, as it installs a new release's packs; its customer and public tools are open from
    then on, its routine email off until the client's admin turns it on.
  - **`API_ALLOWED_ORIGINS`**: https origins only, and none under the fleet's own domain but the
    client's own hostnames (a sibling there is another client's or the fleet's).
  - **`NATIVE_REDIRECT_URIS`**: the client's app's `<scheme>://staff-sign-in` (the scheme its
    product.ts names for the environment, `nativeRedirectUri`), cos's own
    `http://127.0.0.1/cos-sign-in`, or an https address on one of the client's own hostnames.
  ```sh
  cos client setting set gym-a COS_PACKS ticketing,content --env staging --yes
  cos client setting set gym-a API_ALLOWED_ORIGINS https://www.gym-a.example --env staging
  cos client setting set gym-a NATIVE_REDIRECT_URIS gyma://staff-sign-in,http://127.0.0.1/cos-sign-in --env staging
  ```
- **A client's own label** (`COS_PRODUCT_LABEL`, `--label` at add or the setting): its staff
  screens, its sign-in page and every mail it sends name the product so, never the fleet's
  product or another client's. Without one, the deployment's own label.
- **Routine mail's reply address** is the client's admin's (Settings → Routine email, "Replies"):
  routine email (a booking's confirmation, a reminder) carries it as its Reply-To and still goes on
  its own. A Reply-To from anywhere else makes an email an ordinary send that waits for a person;
  sign-in codes never carry one.
- **Videos (Stream) on a fleet** use the operator's one Stream account for every client. The
  host keeps each client's part apart (ADR 0617): every upload and copy is stamped with the client
  as its creator; every call for a video (its details, securing it, captions, deleting it) and
  every playback token is refused unless Stream says this client made it; every video needs a
  signed URL, and a token names one video; nothing lists the account's videos. `cos fleet install`
  takes the account's settings (the [Stream runbook](stream-runbook.md), steps 1 and 2, says how
  to make the token and the signing key):
  ```sh
  cos fleet install --env staging --keys-file ~/fleet-keys/staging.json … \
    --stream-account-id <account id> --stream-customer-code <code> \
    --stream-signing-key-id <key id> \
    --stream-token-file "$RUNNER_TEMP/stream-token" --stream-jwk-file "$RUNNER_TEMP/stream-jwk"
  ```
  The three ids are kept in the deployment's state, so every later upload (`cos fleet upgrade`
  too) sets them again; the token and the key become the app Worker's secrets, which every later
  upload keeps (`keep_bindings`). The five go together, are checked (ids as 32 hex characters, the
  key a private RSA JWK), and nothing of the token or the key is printed. A re-run with them
  replaces them. They are the operator's, never a client's: `cos client secret` does not take them.
- **Payments, text, inbound webhooks and email receiving** are off for every client of a host of
  many clients until their gatekeepers are made per client (ADR 0616). A client's Stripe keys can
  already be stored (`cos client secret set <id> STRIPE_SECRET_KEY`), unused until then.

## Proving a client's database on Cloudflare (stage 66 step 1)

One host for many clients keeps each client's records in a Durable Object (`ClientDb`, ADR 0612)
instead of D1. Before more is built on it, the proof Worker (`apps/client-db-proof`) is deployed to
the fleet's account and measured against D1: a typical staff page and a customer checkout, warm;
the first staff page on a client's database that has been idle long enough to be evicted; how
many database calls one request can make; and every probe on which the two answer differently.
It is not the host and serves no one; it holds only its own seeded records.

**Where the clients' databases are** (since the first runs; ADR 0614, "Its own Worker"). The
`ClientDb` class is not in the proof Worker: it is in its own small Worker, `apps/client-db`,
deployed as `crm-client-db-proof-db` (45 KiB, against the proof Worker's 7.8 MB that carries the
host's code), exactly as the host will have it in `cos-client-db`. The proof Worker reaches the
clients' databases as the host will: the timed pages through the query-only service
(`CLIENT_DB_QUERIES`, `ClientDbQueries`), setup and the operator's probes through the class's
namespace by script name (`CLIENT_DB`). The first three runs had the class in the proof Worker
itself, so a cold object had to start that whole 7.7 MB Worker (wrangler printed a Worker Startup
Time of 501 ms); their cold first pages (949, 889 and 445 ms against D1's 246, 323 and 250) measure
that arrangement, not the design. The proof Worker's migration `v2` deletes that old class and
every object of it (seeded test data only). Going back to the old arrangement for a comparison
would need the class re-created under a new migration tag and the data seeded again, so it is not
offered as an input.

**Setup runs beside the databases.** Each setup call runs in the proof's timer object, placed by
the location hint, so its queries cross metres instead of the world (it took 17 minutes a database
from a runner, one call a migration across the Pacific): every migration in one call (inside the
object for a client's database), then up to five chunks of the seed. Work already done is skipped,
so a rerun's setup is a few seconds.

What it does not show: the test suites running deployed. Those run on `ClientDb` locally
(`pnpm test:client-db`); on Cloudflare the probes and the scenarios stand in for them (stage 66,
step 1's Status).

**What the owner sets up (done 2026-11-26):**

- Repository secrets `FLEET_CLOUDFLARE_API_TOKEN` and `FLEET_CLOUDFLARE_ACCOUNT_ID` (the account's
  id is a secret too, and is never written in a file).
- The token: account-owned, on the fleet's account, with Workers Scripts: Edit, D1: Edit, Workers
  KV Storage: Edit, Workers R2 Storage: Edit, Queues: Edit, Vectorize: Edit, AI Gateway: Edit and
  Account Settings: Read; and, on the zone `composableos.app` only, Zone: Read, Workers Routes:
  Edit, DNS: Edit, SSL and Certificates: Edit. **The proof needs only Workers Scripts: Edit** (the
  Worker, its Durable Object classes and its secret), **D1: Edit** (finding, creating and, in
  `remove` mode, deleting its own database) **and Account Settings: Read**. It uses no zone: it is
  served on `workers.dev`. A token with only those three would do, and is safer.
- A GitHub environment named **`fleet`** (Settings, Environments). The jobs that use the secrets
  run in it, so the owner can add required reviewers there: every run then waits for approval
  before the token is handed to it. The secrets may also be moved from the repository into the
  environment. Without the environment GitHub creates it, unprotected, on the first run.
- The account must have a `workers.dev` subdomain (Workers & Pages in the dashboard shows it; an
  account that has deployed to `workers.dev` before has one). Without it `wrangler deploy` asks for
  one and the run fails.

**How the token is handled:** only two steps have it in their environment, *Deploy*
(`scripts/deploy.mjs`) and, in `remove` mode, the deletion. Installing dependencies and the tests
run with no secret (the tests in a job of their own), so no install script or test can read it.
The step that compares and times the proof Worker has only the run's key. The workflow's inputs
are passed through the environment and checked (integers in a range, the hint from a fixed list)
before any job uses them.

**The Worker's address stays private.** It names the account's `workers.dev` subdomain, and the
repository's logs and artifacts are public. `deploy.mjs` masks it in the log before wrangler's
output is printed and hands it to the next step in a file; `time.mjs` never prints it, and the
summary and the artifact leave it out.

**What runs** (`Client database proof`, Actions, *Run workflow*, mode `prove`; it runs only by
hand, and with a secret missing it passes with a notice and deploys nothing):

1. The inputs are checked.
2. `pnpm --filter @composable-os/db test` and `pnpm --filter @composable-os/client-db-proof test`,
   without secrets: the probes on the local D1 and `ClientDb`, and every route of the proof.
3. In the `fleet` environment: a fresh random key for the run (masked), then `deploy.mjs`: the
   names come from the product (`crm-client-db-proof` for the proof Worker and the D1 database,
   `crm-client-db-proof-db` for the Worker of the clients' databases); the database is found by
   exact name or created with the location hint; `crm-client-db-proof-db` is deployed first (the
   proof Worker binds it by script name), then the proof Worker, with the key set as its
   `PROOF_KEY` secret. Wrangler's "Worker Startup Time" and upload size for each are kept for the
   summary.
4. `time.mjs`, which prints, in order:
   - **Deployed:** each Worker's startup time and size: the cold start of a client's database is
     the startup of the Worker its class is in.
   - **Setup:** each call's progress and time beside the database.
   - **Conformance:** every probe (those of `@composable-os/db/testing/conformance` and the
     proof's own, `src/probes.ts`), D1's answer beside the client's database's when they differ.
     The probes include how bound numbers are typed, the error text of a UNIQUE, a FOREIGN KEY and
     a trigger's `RAISE(ABORT)`, `changes` with triggers, FTS5 and JSON1, the 2 MB value and
     100-parameter limits, a batch sent in parts and a result over 32 MiB.
   - **Warm:** each scenario's median and p95, `near` (in a Durable Object beside the databases:
     read this one) and `edge` (where the request landed: mostly the runner's distance), for D1,
     for the client's database as the host reaches it (`client`, through the service) and for the
     same object through its namespace (`direct`), so the service's own cost shows. A database
     that fails a scenario (a limit on the service, say) is reported and the run goes on.
   - **Cold:** for each sample, a fresh client's database is set up, left idle for `cold_wait`
     seconds (Cloudflare evicts an idle object after 70 to 140 seconds, when the runtime decides,
     so 150 is the default: a shorter wait finds the object only hibernated, at best), then the
     first staff page is timed on it and on D1 after the same wait, in two parts: the very first
     query alone (on a cold object: its Worker's startup, the constructor, SQLite opening, the
     hop), then the rest of the page. Each sample says whether the object really had been
     restarted (its session id, read through the namespace after timing, changed): a sample that
     was not is not a cold start. D1 has no cold start per client, so this measures the cost a
     quiet client pays that a D1 host does not.
   - **Subrequests:** how many queries one request makes to each database (after 20 fetches)
     before a limit stops it, and the error then, for D1, the service and the namespace. Workers
     allow 10,000 subrequests an invocation on the paid plan; with ClientDb every query is a call
     to an object, and through the service also a call to `crm-client-db-proof-db`. Cloudflare's
     service-binding page also says "A single request has a maximum of 32 Worker invocations, and
     each call to a Service binding counts towards this limit": if that is a total and not a
     depth, the service shape fails past 32 queries a request, and this line shows it.
   - The verdict against the thresholds below is kept for the end of the run.
5. `step2.mjs` (stage 66 step 2, ADR 0614), after the timing (and even when the timing failed),
   with the address from the same file and the run's key only; each probe uses a fresh client of
   its own. Each probe is driven a call at a time: the Worker works about eight seconds at most,
   then answers its result or a cursor the script sends back, so no request comes near a limit
   (the first run on Cloudflare did `/step2/export` as one request, which outlasted the runner's
   five minutes). Every call's progress is printed; a probe not finished within ten minutes is
   reported with how far it got; one probe's failure never stops the others:
   - `/step2/pitr`: a bookmark, a write, a restore to the bookmark, then the undo, on a real object
     (point-in-time recovery does not exist locally), with how long each took, and whether a call
     made while the restore waits is refused.
   - `/step2/export`: the D1 database out as SQL into a client's database and out of that into a
     second one, every table compared with D1's. The other direction (a client's database onto a
     fresh D1) needs a second D1 database the proof does not have; it is proved locally.
   - `/step2/d1`: each feature the export and import use (the table-valued pragmas,
     `pragma_table_list`, `PRAGMA defer_foreign_keys` in a batch, the scratch table's appends,
     writing `sqlite_sequence`, an FTS5 rebuild, the count check), run on real D1 and rolled back.
   - `/step2/answers`: a 200,000-statement batch, a 40 MB read, and a 60 MB read, which must be
     refused cleanly ("read it in pages") and leave the object answering, not reset.
   - `/step2/size`: whether `databaseSize` falls after deletes, and what `VACUUM` answers
     (reported, not judged).
   After every probe has printed, the step fails if restore, the export, D1's features or the
   answers did not do what they should.
6. **The verdict**, last: the timing's verdict against the thresholds below, printed after step 2's
   probes, whatever they did.
7. The run's summary has the whole printout; the `client-db-proof` artifact has it and the JSON.
   A Worker for which wrangler printed no startup time reads "not printed by wrangler" (wrangler
   printed none for the 45 KiB Worker on 2026-11-27).

**When to stop and return to the owner** (from the review of PR #507; `time.mjs` prints the
verdict, and timing never fails the run):

- a `near` median for the staff list or a person's page over about 1.5x D1's, or more than about
  20 ms more;
- a checkout's `near` p95 over about 2x D1's;
- a cold first page more than a few hundred milliseconds (300) worse than D1's, or no cold sample
  that was really cold (run again with a longer wait);
- any conformance difference.

**A difference in the probes fails the run** (after everything has printed), unless the probe is
in `apps/client-db-proof/conformance-allow.json` with the reason. Each new difference is judged:
fixed in `ClientDb`, or allowed with its reason in a pull request. Today the list is empty
(the one known limit, a result over Workers RPC's 32 MiB a call, was answered by stage 66 step 2).

To time it from Australia, near the databases, set a key of your own (the workflow's is masked
and replaced on each run) and run the script against the deployed Worker:

```sh
pnpm --filter @composable-os/client-db-proof exec wrangler secret put PROOF_KEY --name crm-client-db-proof
PROOF_URL=https://crm-client-db-proof.<subdomain>.workers.dev PROOF_KEY=<that key> \
  pnpm --filter @composable-os/client-db-proof time:remote -- --skip-setup --runs 10 --rounds 5
```

**To remove the proof,** run the workflow with mode `remove`. It deletes the proof Worker
`crm-client-db-proof` first, then `crm-client-db-proof-db` (with every client's database in it),
then the D1 database `crm-client-db-proof`, each named exactly (the product's names), nothing
matched by a pattern, and nothing else: never a host's own `crm-client-db`. By hand, with the
fleet's token:

```sh
pnpm --filter @composable-os/client-db-proof exec node scripts/deploy.mjs --remove
```

## Proving a host of many clients on Cloudflare (stage 66)

`.github/workflows/fleet-staging-check.yml` (*Fleet staging check*) makes a **throwaway staging
fleet** on the fleet's account, runs every operator command of
[A host of many clients](#a-host-of-many-clients-stage-66-step-7) on it, and deletes it. It is
never live and never a real client. It is run by hand only (Actions, *Run workflow*); with
`FLEET_CLOUDFLARE_API_TOKEN` or `FLEET_CLOUDFLARE_ACCOUNT_ID` missing it passes with a notice and
makes nothing. Its logic is `scripts/fleet-staging-check.mjs`, tested against the fake Cloudflare
API (`scripts/fleet-staging-check.test.mjs`, run by `pnpm lint`).

```sh
# A check, with the fleet's hostnames under a spare zone of the account (see "The zone" below):
gh workflow run fleet-staging-check.yml -f mode=check -f location=oc -f zone=<spare zone>
# What a failed run left (its run id, from the run's page or `gh run list`):
gh workflow run fleet-staging-check.yml -f mode=remove -f target=<run id>
```

**Names.** Everything is named from one prefix, `cosstg-<run id>`. The two releases are built
from the commit for a throwaway product whose id is that prefix, so every Worker, database,
bucket, queue, namespace and Workflow is `cosstg-<run id>-…` (staging's names end in `-staging`),
and the hostnames are under `cosstg-<run id>.<zone>`. Nothing that exists can share the prefix,
and teardown deletes nothing else (see step 9).

**The two releases.** `0.1.0` is the commit as it is. `0.1.1` is the same commit with one more
core migration, `9000_staging_check_marker.sql` (a table `core_staging_check` and one row), written
into the runner's checkout for its build and removed after. So every upgrade really migrates each
client: a restore undoes something, and a success moves every client to schema 9000.

**What runs**, in order. Each step's result and time go in the job summary, and a failed step
does not stop the steps that do not need it. A step is `pass`, `fail`, `skipped` (what it needs
failed), `partial` (it ran and proved less than its name says, for want of a zone, say) or `not
checked` (something this check cannot check at all). **The summary opens with the verdict, and the
step fails unless every step passed**: a partial one fails it as a failure does, and a run with
no zone says first which steps are not proved.

0. The account: a `workers.dev` subdomain (the operator's Worker is reached there), the zone if
   one was given, every kind of resource listable, and nothing with the run's prefix there yet.
1. `cos fleet keys` (the keys file in the runner's temp folder, mode 0600, never printed), then
   `cos fleet install --env staging` of `0.1.0` with `--location <location>` and `--ai off`. The app
   Worker's deployed bindings must name `0.1.0`, and the runner's two Workflows must be listed in the account. The callback hostname is attached to the app
   Worker as a Workers Custom Domain, and the host's health is awaited there.
2. `cos client add alpha --web-hostname cosstg-<run id>-alpha.example` (a made-up domain, accepted
   without DNS: `cos` records a web hostname and attaches none), then `cos client add bravo`: both
   listed active, and the time each add takes, as `cos` reports it and for the whole command.
3. Requests: the app's `workers.dev` address (it answers the unknown hostname's 404: a client is
   decided only by its hostname); each client's staff sign-in page; a staff account signed up at
   each, whose session works at its own address and is answered at the other's as no session is
   (the same status and error code), and whose password at the other's is the wrong-password
   answer, 401; the host's health on the callback hostname; a picture uploaded at alpha, which must
   succeed, for the export to carry.
4. `cos client sender add`, `verify` and `unverify` for a made-up domain. Then (4a) the fleet's
   email-send gatekeeper, read from the account: `cosstg-<run id>-gatekeeper-email-send-staging` is
   deployed with `SENDER_DOMAINS_PER_CLIENT=true`, and the runner binds it as
   `GATEKEEPER_EMAIL_SEND`; checked again after the successful upgrade of step 5. **A send is not
   checked** (4b, see below).
5. `cos fleet upgrade` to `0.1.1` three times:
   - bravo's migration made to fail after alpha's migration has applied: the update must stop
     before any upload, name alpha and bravo restored, leave both at the schema and status they
     had, and leave the app Worker on `0.1.0` (read from its bindings, not from `cos`'s words);
   - the smoke check made to fail after the upload and after the real check passed: rolled back,
     both clients as they were, the app Worker on `0.1.0` again;
   - a real one: both clients at schema 9000 and served, the app Worker and the host's health on
     `0.1.1`.
6. `cos client export alpha --out`, `cos client import charlie` from it, and an export of charlie.
   Each export's part and file hashes are recomputed from its bytes on disk; the two exports'
   row counts and file hashes must be alike, the export must count rows, carry the picture of
   step 3 and, after a successful upgrade, the migration's row.
7. `cos client add delta`, and `cos client export bravo` started while the add holds the
   operator's Worker: the second is refused ("Another operator's command"), the first finishes. If
   the add finished before the export began, the two did not overlap and the step is partial.
8. `cos client remove alpha`: alpha's address answers the unknown hostname's 404 within the
   registry's refresh, bravo answers and its staff stay signed in.
9. **Teardown, always** (its own step, run after a failure, a timeout or a cancel too):
   - it lists the account under the prefix, every kind, the Durable Object namespaces of the
     run's Workers among them, and deletes what it finds by exact name (an id only as that listing
     gave it): first each of the run's queues' consumers (Cloudflare deletes neither a Worker that
     consumes a queue, 10064, nor a queue that is a consumer's dead-letter queue or that a Worker
     binds, 11005, even with `force`: the first real run, 45966813610, left 24 things so), then the
     Custom Domains, the Workers (their namespaces, every client's database and their secrets go
     with them), the queues, the Workflows, the buckets (each emptied first), the D1 databases
     (the registry and the deployment's), KV, Vectorize and AI Gateways, each tried twice; a delete
     answered "not found" counts as gone only if the listing after agrees;
   - of a kind the account cannot list, it deletes the names the run recorded as it went (a
     ledger in the runner's temp folder), only of the kinds deleted by name (Workers, Workflows,
     buckets, indexes, gateways), never by a recorded id it cannot check against its name;
   - then it lists the prefix again. **It fails if anything is left, if anything could not be
     deleted, or if any kind could not be listed** (said first: the account may still hold some);
     the summary lists what was deleted and what was not, with the account cut out of every error.
   - Then the runner's folder (the keys file, the exports with their `secrets.json`, the releases)
     is deleted.

**The switch that makes an upgrade fail** (step 5) is `COS_FLEET_FORCE_FAILURE`:
`migration:<client>` adds, to that client's migrate call only, a migration that fails inside its
database; `smoke` fails the smoke check after the real one has passed. `cos` refuses it, with
nothing done, unless the fleet is staging, the product is a throwaway one (its id starts with
`cosstg-` and every name with its id), and it runs in GitHub Actions in this workflow
(`GITHUB_ACTIONS` and `GITHUB_WORKFLOW_REF`). The other flags it uses are ordinary:
`--product-file` (the throwaway product defined in a JSON file, for a release built for it; any
other product is refused from a file), and `cos fleet install`'s `--location` and `--ai`, chosen at
a fleet's first install only. Every command already runs without prompts given `--yes` and the
token in the environment, so nothing about confirmations changed.

**AI is off, always.** An install with AI makes an account API token (for its AI Gateway) and
creates or changes the account's custom AI provider, which is shared by every deployment in the
account; no teardown deletes the one or puts the other back. The workflow has no `ai` input, and
the script refuses `--ai on`.

**The zone.** `cos` attaches no hostname to the host: a client's hostnames are recorded in the
registry, and routing them is stage 66's step 8 (`cos-front`). The app decides a client only by
the hostname a request reached, so on `workers.dev` alone no client can be reached. With `zone`
set to an active zone of the account on which the token has Zone Read, Workers Routes, DNS and SSL,
the check attaches the callback hostname and each staff hostname as Workers Custom Domains
(Cloudflare makes their DNS records and certificates, and removes them with the domain; it never
replaces a record that exists). **Use a spare zone, not a live site's**: the certificates'
hostnames stay in public certificate logs. Without one, steps 1, 3, 5, 6 and 8 are partial and the
run is not proved; what can run still runs.

**What it cannot check:** a send (4b). The fleet's email-send gatekeeper is installed and checked
(4a; its Worker and the Durable Object namespace it owns are deleted by the teardown with the run's
other Workers), but a real send needs a domain onboarded to Email Sending in the account and a
client's admin to connect it in the app, which this check does not do; the `sending_domain` input
is recorded and not used. A client's
web hostname (only recorded: its web app is step 8's). AI. A live fleet, a real client and the
first client's own steps (step 9). Payments, texts and webhooks (off for every client of a fleet).
Two endpoints are not proved against Cloudflare's own API before the first run: listing a bucket's
objects (`GET …/r2/buckets/<bucket>/objects`) and listing Workflows; if either is refused, the
teardown fails and says which, and `remove` (or the dashboard) finishes it.

**What the owner sets up first:**

- The token of [the proof above](#proving-a-clients-database-on-cloudflare-stage-66-step-1),
  with the zone's permissions for `zone`, and the account's `workers.dev` subdomain.
- **The `fleet` environment's protection** (recommended before the first run): move both secrets
  from the repository into the `fleet` environment, give it a deployment branch policy of `main`
  and a required reviewer. Every job of the workflow that reads the secrets runs in that
  environment, so it works with the secrets in either place; while they are repository secrets,
  any workflow run on any branch by someone with write access can read them, and the zone
  permissions widen what a leak would expose.

Where the install needs a feature the account does not have (Queues on its plan, a permission, the
zone), the failing step's note says which in plain words, and the teardown still runs.

**What a run costs, roughly:** the runner's time (about an hour and a half, most of it building the
two releases in full; Actions minutes are free on a public repository) and, on Cloudflare, a few
hundred Worker requests, a few thousand Durable Object, D1 and R2 operations, a few queue messages
and kilobytes of storage for under an hour: within the usage the Workers Paid plan includes, so
cents at most. A Custom Domain's certificate costs nothing.

## Manual end-to-end run (needs a human)

Stage 8 acceptance criterion 8. **Status: not yet run; needs a human with a Cloudflare account.**
Save a screenshot of each numbered step to `docs/stages/assets/stage-8-manual/NN-name.png`.

1. Create an API token with the permissions in [Option 1](#option-1-recommended-npx-composable-oscli-install).
2. `npx @composable-os/cli install` and answer the prompts (workers.dev, Better Auth). Screenshot the summary. (`01-install.png`)
3. Open the printed URL, sign up; the setup wizard opens. Walk every step: organisation (name, logo,
   currency, timezone), AI (check it states the deployment's real models and any missing key), a
   policy preset, skip connect, install sample data. (`02-wizard-*.png`)
4. Check People and Organisations show the "(sample)" records; remove them from Settings → General. (`03-sample.png`)
5. Connect Claude over MCP (`docs/mcp.md`) and create a person from Claude. (`04-mcp.png`)
6. Settings → Updates: version, channel, changelog; switch to beta and back. (`05-updates.png`)
7. When a newer release exists: Preflight, then `npx @composable-os/cli upgrade` (no stored token). (`06-upgrade-cli.png`)
8. Store a token (`npx @composable-os/cli install --update-token …`), then update or roll back from Settings →
   Updates. (`07-update-app.png`, `08-rollback.png`)
9. `npx @composable-os/cli status`. (`09-status.png`)
10. Tear down: `npx @composable-os/cli uninstall`.

The automated equivalent in a dedicated test account is `.github/workflows/install-test.yml`
(ADR 0168); create its secrets with `bash scripts/setup-ci-cloudflare.sh`.

### Verify on a real account: Workers AI over REST (ADR 0330)

**Status: not yet run.** The fakes cannot show these; check each on a real self-hosted install
before relying on "no prompts in AI Gateway logs".

1. **The token.** After an install, the dashboard (Manage account → Account API Tokens) shows
   `<gateway> AI Gateway (CRM)` with exactly **AI Gateway Run** and **Workers AI Read**
   on the account. If the install token could not create it (Cloudflare may require the creating
   token to hold Workers AI itself), the install says so: add **Workers AI: Read** to the install
   token, or supply one with `--secret AI_GATEWAY_TOKEN=…`.
2. **Chat over REST.** Settings → AI → Test on a Workers AI role answers `OK`. Then AI Gateway →
   your gateway → Logs shows the call with model `@cf/…`, tokens, cost and metadata
   `{"role": …}`, **and no request or response body**. A `401`/`403` from `api.cloudflare.com`
   means the token lacks Workers AI Read; an AI Gateway authentication error means the gateway
   also needs `cf-aig-authorization` in a form we do not send (we send it with the same token).
3. **Embeddings over REST.** Settings → AI → Test on `embed` answers `384-dimension vector`, and the
   gateway's logs show the embeddings call without its input. If embeddings reach Workers AI but
   are **not** in the gateway's logs, `cf-aig-gateway-id` is not honoured on `/ai/v1/embeddings`:
   the call still works and logs nothing, but usage for `embed` is missing.
4. **Usage.** Settings → AI → Usage shows Workers AI calls per role with tokens and cost.
5. **Upgrade of an older install.** On an install from before ADR 0330, `npx @composable-os/cli install
   upgrade` (or Settings → Updates) prints `AI_GATEWAY_TOKEN: replaced`; the old token is gone from
   the dashboard afterwards and `AI_GATEWAY_REST` is `true` on crm-app and crm-runner.
6. **`--ai-gateway off`.** Workers AI still answers (binding), and `AI_GATEWAY_REST` is empty.
