# ADR 0619: Hostnames, a client's own domain, and cos-front

Status: accepted, 2026-11-27 (stage 66 step 8, reduced; `feat/stage-66-hostnames`). Builds on
[ADR 0613](0613-the-registry-and-the-clients-environment.md) (the registry's verified hostnames),
[ADR 0615](0615-every-entry-decides-the-client.md) (every entry decides the client),
[ADR 0616](0616-secrets-and-addresses-per-client.md) ("Cookies", amended the same day) and
[ADR 0618](0618-the-operators-commands-for-a-host-of-many-clients.md) (the operator's commands).
Leaves to stage 75 ([ADR 0960](0960-screens-as-published-versions-and-one-desktop-app.md)) how a
client's web app is served.

## Context

Step 7 wrote every hostname into the registry and attached none: the staging check attached
Custom Domains itself. A client's own domain had no way in, nothing answered for it, and the
spec's step 8 rested on a Public Suffix List listing of the fleet's domain so that a client's code
on one hostname could not set cookies for another's.

**The owner changed step 8 on 2026-11-27:**

1. **No Public Suffix List submission** (it would be declined at our size). In its place three
   rules: (a) client-written web code runs only on the client's own domain, never on any hostname
   under the fleet's registrable domain; (b) a state-changing request is refused unless it comes
   from the exact same origin; (c) a many-client host reads no cookie without the `__Host-`
   prefix.
2. **The Workers for Platforms namespace is not built in this step.** How a client's web app is
   served waits for stage 75's step 1 spike (Worker Loader or a namespace upload). So: no
   namespace, no upload of a client's web Worker, no `ClientApp` props at upload.

## Decision

### The fleet's own hostnames: a Custom Domain each by default, a wildcard route where it fits

A client's staff hostname (`<id>-admin.<domain>`), its desk hostname (`<id>-desk.<domain>`, with
`--desk`) and the deployment's callback hostname are on the fleet's domain and served by cos-app,
which decides the client from the registry. `cos fleet install` learns the **zone** the domain is
on (the account's zone it equals or is under, the longest; or `--zone`) and records it in the
deployment's state with the mechanism (`--attach`):

- **`custom-domains` (the default):** `cos client add` (and `import`) puts a Workers Custom Domain
  for each of the client's staff and desk hostnames on cos-app (`PUT
  /accounts/{id}/workers/domains`); `cos client remove` deletes them; `cos fleet install` puts the
  callback hostname's. One API call a hostname, nothing else per client. Cloudflare's
  documentation: "Cloudflare will create DNS records and issue necessary certificates on your
  behalf", the certificate covering "multi-level subdomains such as `realms.app.example.com`"; and
  "Custom domains per zone: 100"
  ([Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/),
  [limits](https://developers.cloudflare.com/workers/platform/limits/)).
- **`wildcard`:** one proxied `*.<domain>` record and one route `*.<domain>/*` to cos-app, made at
  install; nothing per client, the registry deciding every name (an unknown one is the plain 404).
  The limits page itself says "If you require more than 100 custom domains per zone, consider using
  a wildcard route", and "the most specific route pattern wins"
  ([routes](https://developers.cloudflare.com/workers/configuration/routing/routes/)). Refused
  unless `--domain` is its zone's apex, because Universal SSL's coverage "is limited to the root
  domain" and first-level names: "Deeper subdomains — such as dev.www.example.com … — are not
  covered" ([Universal SSL limitations](https://developers.cloudflare.com/ssl/edge-certificates/universal-ssl/limitations/)),
  and because `*` "matches zero or more of any character", so the route takes every name of a zone
  that must be the fleet's alone.

**Why the default is Custom Domains.** Both keep only our Workers on the fleet's hostnames, which is
what the cookie rules need: with Custom Domains an unattached name has no record and reaches
nothing; with a wildcard every name reaches cos-app, which serves none but a registry's verified
staff, desk or callback hostname. Neither puts any client's code under the fleet's domain, and rule
(c) means a cookie planted there is never read anyway. Custom Domains work at any depth (a staging
fleet on `staging.<domain>`, the staging check's `cosstg-<run>.<zone>`) with no paid certificate,
and touch nothing else in a shared zone. The wildcard is the least to manage once there are more
than about 50 clients with desks on one zone (100 Custom Domains), on a zone that is the fleet's
alone with its domain at the apex, which is what `composableos.app` is (stage 46, decision 13):
the live fleet can switch to it with `cos fleet install --attach wildcard` (a re-run), and a
client's hostnames then need nothing.

**Pause and remove.** `cos client pause` leaves the hostnames attached: the host answers them "being
updated", and `resume` is instant. `cos client remove` detaches every one (and each own domain's
route and custom hostname) after its stores are erased and before its rows go, in its own recorded
step, so a re-run finds what is left.

### A client's own domain: a Cloudflare for SaaS custom hostname, proved by its CNAME and named by a TXT record

`cos client hostname add|verify|remove <id> <hostname>` (and `list <id>`; `cos client add
--web-hostname` does `add`):

- **add** writes the hostname to the registry **unverified** (served nowhere), makes a custom
  hostname on the fleet's zone (`POST /zones/{zone}/custom_hostnames`, `ssl: { method: "http" }`),
  and prints the client's two DNS records (below). Refused: anywhere under the fleet's registrable
  domain (rule (a)); a bare domain (below); the CNAME target; a hostname another client holds (the
  registry's primary key); a domain another client already has a hostname under (whoever holds a
  domain's DNS holds every name under it); a second web hostname for the client; and on a fleet
  whose zone is unknown.
- **verify** needs both:
  - **Cloudflare has proved it:** the custom hostname's `status` and `ssl.status` are both
    `active`, which real-time validation gives once the client's CNAME exists;
  - **the domain names this client:** its TXT `_cos-client.<hostname>` holds
    `cos-client=<environment>:<client id>`, which `cos` reads itself over DNS over HTTPS (Cloudflare's public
    resolver). A TXT naming another client refuses with that client named; a failed lookup refuses.

  Only then does it put the route `<hostname>/*` on cos-front and mark the registry's row verified
  (and the client's web address, when it has none). Otherwise it says what is missing, prints the
  records again, and changes nothing.
- **remove** asks for the client's id; it removes the registry's row, then the route and the custom
  hostname. A re-run after a crash finishes Cloudflare's side.

**What the client does in its DNS** (printed by `add`):

| Record | Name | Value | Why |
| --- | --- | --- | --- |
| CNAME | `<hostname>` (a subdomain: `www.<domain>`) | `clients.<fleet domain>` | sends its visitors to the host. **DNS only (grey cloud), not proxied** |
| TXT | `_cos-client.<hostname>` | `cos-client=<environment>:<client id>` (`cos-client=live:gym-a`) | says which client, of which environment, the domain is for |

The client redirects its bare domain to the subdomain in its own DNS (a Cloudflare zone does this
with a redirect rule).

**Revised the same day (2026-11-27, before merge), for a client whose domain is a zone on
Cloudflare in another account (the first client's).** The first version created the custom hostname
with `ssl: { method: "txt" }` and asked for Cloudflare's ownership TXT and the certificate's TXT
before the CNAME (pre-validation). Cloudflare's documentation, read again:

- Pre-validation does not work there: "Pre-validation (TXT and HTTP token methods) is not supported
  when the custom hostname belongs to a zone" that is "already on Cloudflare — also known as an
  Orange-to-Orange (O2O) setup", and the page says to "use a real-time validation method instead"
  ([pre-validation](https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/domain-support/hostname-validation/pre-validation/)).
  It does not say whether a DNS-only CNAME from such a zone counts; the command does not depend on
  it.
- Real-time validation "occurs automatically when your customer adds their DNS routing record",
  for example "`mystore.com CNAME customers.saasprovider.com`"
  ([real-time validation](https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/domain-support/hostname-validation/realtime-validation/)).
  So the custom hostname is made with an HTTP-validated certificate and turns active once the
  CNAME exists, whatever DNS provider the client has. Cloudflare's ownership TXT is no longer asked
  for.
- **DNS only, not proxied.** A proxied CNAME from a Cloudflare zone makes the setup
  Orange-to-Orange: "your zone contains a proxied DNS record matching the custom hostname … then
  O2O will be enabled", in which "Your zone's settings are applied first, and then the SaaS
  provider's zone settings" ([how it works](https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/saas-customers/how-it-works/)),
  "As a general rule, settings on the customer zone will override settings on the SaaS zone", and
  WebSockets are "No" on both zones
  ([product compatibility](https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/saas-customers/product-compatibility/)).
  The host's own WebSocket (the assistant's, `/api/assistant/socket`) is on the staff hostname,
  never on a client's own domain, and the holding page has none; but a client's published web app
  (stage 75) may, and a client zone's settings (a cache rule, a WAF rule, a Worker on the
  hostname) would come before ours. So the instructions say DNS only. A proxied CNAME is not
  refused (nothing can see it before traffic arrives, beyond `cf-connecting-o2o: 1`); the route
  `clients.<domain>/*` to cos-front stays for it.
- **No bare domain.** A CNAME at a zone's apex is what "Most DNS providers don't allow"; apex
  proxying is the way round it, and "Only certain customers have access to this feature"
  ([apex proxying](https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/start/advanced-settings/apex-proxying/)).
  `add` refuses a bare domain (a registrable domain, `gym.example` or `gym.co.uk`) and asks for a
  subdomain. This departs from stage 46's decision 15 ("its site answers on the bare domain"):
  the bare domain redirects to `www` in the client's own zone, which stage 46 already allowed
  "where a provider cannot". _The owner accepted this, 2026-11-27 (below)._
- **No takeover.** With real-time validation, Cloudflare's proof is only that the hostname points
  at the fleet's target: if client B's domain already CNAMEs to `clients.<fleet domain>`, a custom
  hostname made for it, for client A, would turn active just the same. The registry already gives
  a hostname, and a domain, to one client; the `_cos-client` TXT closes the rest: only whoever
  holds the domain's DNS can say which client it is for, `verify` refuses a hostname whose TXT
  names another client or none, and nothing is routed or served before `verify`. A custom hostname
  that is active at Cloudflare but not verified has no route of ours, so its requests reach no
  Worker of the fleet.

**Why Cloudflare for SaaS, and the documentation relied on.** A domain whose DNS is in the client's
own account (the first client's, stage 46 decision 15) cannot carry a Custom Domain or a route of
ours; a custom hostname on our zone is how its traffic and its certificate come to our account. A
TXT check of our own proves which client a domain is for and still serves nothing, so it is the
second half of `verify`, not the whole. Production traffic needs "`status: active`" and
"`ssl.status: active`"
([hostname validation](https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/domain-support/hostname-validation/)).
The fallback origin is "where Cloudflare will route traffic sent to your custom hostnames (must be
proxied)", and customers point a CNAME at a target such as `customers.saasprovider.com`
([getting started](https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/start/getting-started/)):
`cos fleet install` makes `clients.<domain>` a proxied placeholder record (`AAAA 100::`) and sets
it as the zone's fallback origin, unless the zone already has another (a shared zone's is not the
fleet's to change; each verified hostname's own route reaches cos-front before any origin). A Worker serves custom hostnames by a route: "Use a route for the
specific custom hostname, such as `vanity.customer.com`", or `*/*`, which "matches all traffic
entering your zone"; and where customers proxy their CNAME, "add the route
`service.saasprovider.com/*`"
([Worker as origin](https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/start/advanced-settings/worker-as-origin/)).
So each verified hostname gets its own route (never `*/*`, which would take a shared zone's other
sites and the fleet's own hostnames), and `clients.<domain>/*` goes to cos-front too. Pricing: on
the Free, Pro and Business plans "Included hostnames: 100", "Price per additional hostname: $0.10",
"Maximum: 50,000"
([plans](https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/plans/)).
Certificates are Cloudflare's.

### cos-front

`apps/front`, a release's `fleet` Worker named `cos-front` (a release renames it from the
product's definition, like every `cos-*` Worker), off workers.dev, reached only by the routes cos
puts on the fleet's zone. Its code is `@composable-os/db/front`:

- **The client is the registry's.** The request's hostname, made canonical, is looked up exactly
  among verified `web` hostnames of an active client of this deployment's environment. Anything
  else (unknown, unverified, another environment's, a staff or desk hostname, the CNAME target,
  anything under the fleet's registrable domain even if the registry named it, a fleet with no
  domain set) is the one plain 404 (criterion 8); a paused or moving client "being updated"; a
  registry failure the same 503 with nothing of it told.
- **It holds nothing of a client's.** Bindings: `REGISTRY`, `COS_HOST_ENVIRONMENT`,
  `COS_FLEET_DOMAIN` (packages/release `fleetBindings`). No client's database, no secret, no key.
- **Headers that could name a client are removed** before the target sees the request: every
  `cos-…` and `x-cos-…` header, `Forwarded`, `X-Forwarded-Host`, `X-Forwarded-Server`, `X-Host`,
  `X-Original-Host`, `X-Original-Url`, `X-Rewrite-Url`.
- **Security headers on everything it answers** (`withFrontHeaders`): `X-Content-Type-Options:
  nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `X-Frame-Options: DENY`, and a
  content security policy of `frame-ancestors 'none'` when the answer has none. Its own pages (the
  holding page, the 404, "being updated") carry `default-src 'none'; style-src '<sha256 of its one
  style>'; img-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`. A target's
  own policy is kept; cos-front adds and never loosens.
- **The one target in this step is the holding page:** "Coming soon", nothing of the client in it,
  GET and HEAD only.

**The interface stage 75 step 5 implements:**

```ts
interface FrontClient { readonly id: ClientId; readonly environment: "live" | "staging"; readonly hostname: string }
interface WebTarget {
  readonly name: string;
  serve(request: Request, client: FrontClient): Promise<Response>;
}
frontFetch(request, env, target)   // the lookup, the header removal, the target, the headers
```

A target takes the client from `client` only (the request's client-naming headers are already
gone), reaches no other client's data, holds no secret of ours and opens no database. Stage 75
step 5 writes the target that serves the client's published version, by Worker Loader (the
version's code under an id made from the client and the version, its files from the version
store, the host reached through a `ClientApp` stub minted with the client fixed in its props) or
by the client's namespace Worker (uploaded at publish with the client fixed on its `HOST`
binding), as the spike decides, and passes it to `frontFetch` in `apps/front/src/worker.ts`.
Whichever it is, it puts a CPU and subrequest limit on the client's code (the spec's "with a CPU
and subrequest limit").

### The three rules that replace the suffix list

- **(a) Client code only on the client's own domain.** Step 7's refusal of a web hostname under the
  fleet domain's registrable domain stands, and holds for `cos client hostname add` too
  (`hostnameProblem`); staff and desk hostnames, our code only, must be on the fleet's domain;
  cos-front refuses anything under it whatever the registry says. The spec's alternative "a
  registrable domain apart from the staff hostnames" is withdrawn.
- **(b) A state-changing request only from the exact same origin**
  (`apps/app/src/server/same-origin-writes.ts`). On a many-client host, after the client is
  decided and before any route runs, every method but GET, HEAD and OPTIONS (operations, the staff,
  customer and practitioner auth routes, uploads, MCP consent, the desk, TanStack Start's server
  functions, the assistant) is refused with 403 unless its `Origin` is exactly the request's own
  origin, or, with no `Origin` or `Origin: null`, `Sec-Fetch-Site: same-origin`. What CSRF was
  before, and still is on a single-client deployment: per route (TanStack Start's server-function
  rule; `staffCookieAllowed` wherever a staff cookie is read, `staff-origin.ts`; same-origin checks
  in `assistant/http.ts`, `mcp/consent.ts`, `http/desk.ts`, `http/native.ts` and the form page;
  the HTTP surface's `API_ALLOWED_ORIGINS` check; Better Auth's own check against its trusted
  origins). Rule (b) puts one check in front of all of them on a many-client host, so a route that
  lacks one, or a cookie call a route lets in from an allowed origin, cannot be reached from a
  sibling. The exceptions that existed stay:
  - a request carrying `Authorization` and no `Cookie` (a token: native apps, `cos`, MCP clients,
    the browser build's token calls) uses no ambient credential; the HTTP surface's own origin
    check still decides which origins may read its answers;
  - a customer-facing route (`/api/v<n>/…`, customer and practitioner sign-in) from the client's
    own web address or an origin in its `API_ALLOWED_ORIGINS`, never one under the fleet's
    registrable domain even if listed (a sibling is not the client's site);
  - OAuth's `/oauth/token` and `/oauth/register` with no `Cookie` (a code and its PKCE verifier,
    or a registration, never a session);
  - with neither `Origin` nor `Sec-Fetch-Site` and no `Cookie`, a caller that is not a browser
    (a native app, a provider);
  - gatekeeper callbacks on the callback hostname, answered before any client is decided.
  The same holds for reading: the client's environment never carries an origin under the fleet's
  registrable domain in `API_ALLOWED_ORIGINS` (`withoutFleetOrigins`, packages/db), so the HTTP
  surface's CORS check (`apiOriginCheck`), the media routes and the video host never let a
  sibling in either. A single-client deployment never runs it; its rules are unchanged. The agreement PDF's GET and
  OPTIONS are untouched (another change gives them CORS, issue #540).
- **(c) No cookie without `__Host-`** (`scripts/check-host-cookies.mjs`, in `pnpm lint`). Every
  place the app's and auth's code reads a request's cookies is listed with how it reads only
  `__Host-` names on a many-client host and its test; a new read fails the lint until listed, a
  listed one that reads none fails too. Two places changed: the form page passes only
  `isSessionCookie(…, hostOnly)` customer cookies, and Cloudflare Access reads only its
  `Cf-Access-Jwt-Assertion` header on a many-client host, never the `CF_Authorization` cookie.

### keepCustomerSignedIn

`packages/client`'s `keepCustomerSignedIn` takes a `__Host-cos-customer.session_token` before any
other, never an unprefixed one beside it, and sets it back Secure with `Path=/` and no `Domain` (the
`__Host-` rules; before, a `__Host-` refresh was refused by the browser). Its marker beside a
`__Host-` session is `__Host-cos-session-checked`. The web blocks' pictures were redrawn.

### Desk hostnames

cos-app now serves the `desk` surface on a many-client host (`APP_SURFACES`): a client's desk
hostname, from `DESK_HOSTNAME` in its environment, serves its desk's pages and calls only, as on a
single-client deployment.

## Not in this step

The namespace and a client's web Worker; serving a published version (stage 75 step 5); the
standard web app; gatekeepers in a fleet; usage; the first real client (step 9).

## Consequences

- `cos` attaches and detaches every hostname the registry records, and the staging check no longer
  needs to.
- A client's own domain is served only once Cloudflare reports it proved, and only by cos-front.
- A fleet installed before step 8 has no zone in its state: the commands write the registry and say
  that nothing was attached until `cos fleet install` runs again.
- Beyond 100 included custom hostnames a zone, each costs $0.10 a month.
- **Not verified on Cloudflare:** every call here (Custom Domains, routes, DNS records, the
  fallback origin, custom hostnames and their real-time validation from a DNS-only CNAME in a
  Cloudflare zone of another account, the `_cos-client` lookup over DNS over HTTPS, a route on a
  custom hostname reaching
  cos-front, a proxied CNAME from a client's own Cloudflare zone) is tested against the fake
  Cloudflare API only, as Cloudflare's documentation describes it. A Free zone does need Cloudflare
  for SaaS enabled first: the fleet's real zone answered 1456 and 1404 without it (below).

## After the review of #543 (2026-11-27)

### One deployment never takes another's (M1)

A live fleet and a staging fleet may share one zone (`composableos.app` holds
`<id>-admin.composableos.app` and `<id>-admin.staging.composableos.app`), and each has a registry of
its own with the same client ids. The first version found a custom hostname or a route by its name
and took it, so staging could re-point a live client's domain to its own cos-front, or delete it.
Now:

- **A custom hostname is this deployment's only by its id in this deployment's registry**
  (registry migration 0799, `registry_hostnames.custom_hostname_id`, written as soon as `add` has
  made it). Cloudflare's custom metadata, which could carry an owner, is Enterprise only. `add`
  refuses a custom hostname already on the zone that its registry did not make ("never taken over");
  `verify` reads the state only of the recorded one; `remove` and `cos client remove` delete only the
  recorded one. After a crash between making one and recording its id, `cos client hostname add
  --adopt` (the client's id typed) takes it.
- **A route is this deployment's only while its Worker is this deployment's cos-front.**
  `putRoute` never re-points a route of another Worker (`RouteTakenError`); `verify` refuses then,
  and `remove` deletes a route only when it is its own cos-front's. The install's route of
  `clients.<domain>` and the callback hostname's Custom Domain are refused the same way when
  another Worker holds them; `cos client remove` detaches a staff or desk Custom Domain only from its
  own cos-app.
- **The TXT names the environment:** `_cos-client.<hostname>` = `cos-client=<environment>:<client
  id>` (the client's stamp, `clientStamp`). A staging verify never passes on live's record, and a
  record naming the other environment refuses like one naming another client.
- Tested with a live and a staging fleet on one zone, the same client id and the same hostname: add,
  verify, remove and `cos client remove` in staging leave live's custom hostname, route and Custom
  Domains as they were.
- **`--adopt` takes only a custom hostname that is provably this deployment's** (re-review, N1):
  the domain's `_cos-client` TXT must already say only `cos-client=<this environment>:<id>`, and no
  other Worker (another deployment's cos-front) may hold its route. Otherwise it is refused and
  nothing is written, so a staging `--adopt` can never record live's id and later delete it.
- **A zone left with no fallback origin** (a throwaway run's teardown after live installed) is
  set back to `clients.<domain>` by the next `cos client hostname add` or `verify`, which says so
  (re-review, F1). One already set is left alone.

### A zone without Cloudflare for SaaS (M3)

Checked on the fleet's real zone (`composableos.app`, Free plan, 2026-11-27, read-only): Cloudflare
for SaaS is not enabled there; `GET …/custom_hostnames/fallback_origin` answers 401 with 1456
("Access to configure this resource has not been granted for this zone. This feature is available
with SSL for SaaS.") and `GET …/custom_hostnames` 403 with 1404 ("No quota has been allocated for
this zone or for this account"). It is enabled in the dashboard only ("go to the **Custom
Hostnames** page", "Select **Enable**"; non-enterprise zones "Enter payment information":
https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/start/enable/).

- **`cos fleet install` works there.** It attaches the callback hostname and finds Cloudflare for
  SaaS off (`saasEnabled`: 1456 and 1404 mean "not enabled", never an error). Then it makes nothing
  of `clients.<domain>` (no record, no fallback origin, no route), says what to do, and records
  `clientDomains: false` in the deployment's state. cos-front is deployed with the release either
  way and is reached by nothing until then. A re-run after enabling sets it all up and records
  `true`; re-runs converge either way.
- **The fleet's own hostnames work there:** each client's staff and desk hostnames, Custom Domains
  of cos-app. That is all the first client's line needs.
- **A client's own domain is refused there**, before anything is written: `cos client add
  --web-hostname` and `cos client hostname add` name the dashboard step and the re-run of `cos fleet
  install`. A state that says it is set up while Cloudflare answers 1456 or 1404 is refused the
  same way.
- **The staging check's step 3b is partial, not failed,** on such a zone. It still checks the
  same-origin rule.

### Also (S1, S3, S4, F5)

- **A fallback origin whose record is gone** (a deleted fleet's, a staging check's) is replaced by
  `cos fleet install`, and it says so. One whose record is on the zone stays. The staging check's
  teardown resets the zone's fallback origin when it is the run's own target.
- **`check-host-cookies.mjs`** scans packages/core, packages/db and the packs too. It counts reads
  per function, so a second read inside a listed function fails.
- **The fake API is stricter, as the docs describe:**
  - a route needs an existing Worker and a hostname of the zone (or one of its custom hostnames);
  - the fallback origin needs a proxied record;
  - an address record clashing with a CNAME is refused;
  - a Custom Domain makes its own read-only record and refuses a hostname with a CNAME;
  - custom hostnames page, and filter by a part of the name (`findCustomHostname` now reads every
    page);
  - a zone without Cloudflare for SaaS answers 1456 and 1404.

  The codes it uses beyond those seen (10007, 10022, 1550, 81053, 100117, 1061) are as the docs or
  error catalogue suggest, not seen on the account.
- **The staging check's teardown deletes Custom Domains before DNS records** (F5).

### A new hostname takes minutes to answer (the staging check's third real run, 2026-11-27)

In run 45983992806 (before this PR) the second client's staff hostname answered its sign-in page
(after a wait in step 3, which took 193 s in all) and then gave no answer at all (status 0) to a
request seconds later. By step 8 it answered steadily. The callback hostname had taken about 155 s
in step 1. Both staff hostnames were attached back to back, in one call after both adds, so alpha
was not attached earlier than bravo: each Custom Domain's DNS and certificate reach Cloudflare's
edges on their own time, and a first answer from one edge says nothing of the next. So:

- `cos client add`, `import` and `hostname verify` say that a new hostname can take a few minutes,
  and wait (`reachable`) until each answers over HTTPS (any HTTP status) three times running, up to
  15 minutes. If one still does not, they say so; the command has still succeeded. `--no-wait`
  skips the wait.
- The staging check passes `--no-wait` and measures each new staff hostname itself (`settled`,
  three answers running), reporting the seconds in step 2. A hostname that never settles fails
  that step, named, instead of a status 0 on a later assertion.
- Its operation reads (`staffOp`) ask again on no answer at all, twice.

### The bare domain, accepted (2026-11-27)

The owner accepts that a bare domain is refused. The first client's site stays in its own account
for now. Later it is `www` through cos-front, with the apex redirected in the client's own zone.
Stage 66's criterion 15 and stage 46's decision 15 carry the dated amendment.

### Follow-ups (not built)

F1: a verified hostname is never checked again (status and TXT), so a lapsed domain keeps being
served. F3: the 100-a-zone Custom Domain limit and the route limit are not checked before an add.
F4: `--attach wildcard` checks the domain is the zone's apex, not that the zone is the fleet's
alone. Recorded in the spec's Status.
