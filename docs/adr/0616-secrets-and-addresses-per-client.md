# ADR 0616: Secrets and addresses per client; gatekeeper callbacks on one address

Status: accepted, 2026-11-26 (stage 66 step 6, `feat/stage-66-secrets-addresses`). Builds the
owner's decision 8 ("a client's given secrets may be stored encrypted in the registry ... auth
secrets are derived, not stored"), stage 66's "Secrets", "Addresses" and "Gatekeeper callbacks use
one address per deployment", on [ADR 0613](0613-the-registry-and-the-clients-environment.md)'s
registry and client's environment. Amends [ADR 0008](0008-identity-adapters.md),
[ADR 0151](0151-provider-keys-as-workers-secrets-or-byok.md) and
[ADR 0428](0428-buying-without-an-account.md) (their notes of 2026-11-26).

## Context
Step 3 left every secret and every address out of a client's environment (`per-client` in
`ENV_NAMES`), so the host failed closed. A single-client deployment holds them as Worker secrets
and vars of one deployment; a host that serves many clients cannot: one Worker secret is every
client's, and one address is nobody's. This step fills them, per client, and keeps a single-client
deployment exactly as it was.

## Decision

### The host's keys
Four names in `ENV_NAMES`, all `host` (never in a client's environment), set by the deploy engine
on a many-client deployment only (step 7), never committed to the single-client configuration:

| Name | What |
| --- | --- |
| `COS_ROOT_KEY` | the root key every derived secret comes from: 32 random bytes as base64url (`newHostKey()`) |
| `COS_SECRETS_KEY` | the key given secrets are sealed under: 32 random bytes as base64url |
| `COS_SECRETS_KEY_PREVIOUS` | the secrets key before a rotation, while the operator re-seals every row |
| `COS_CALLBACK_HOSTNAME` | the deployment's one callback hostname (below) |

Staging and live are two deployments with **different keys**, and the deployment's environment
(`COS_HOST_ENVIRONMENT`) is bound into every derivation and every sealed value besides, so a
staging secret never derives or opens on live. Only `packages/db` reads the keys:
`packages/db/test/secrets-unreachable.test.ts` fails when the app's, the runner's, packages/core's
or a pack's source names either key, `registry_secrets` or the secrets module.

### Derived secrets (`DERIVED_SECRETS`, `@composable-os/db/registry-secrets`)
Every secret the host signs or encrypts with for itself, derived per client, stored nowhere:

| Env name | Purpose | What it keys |
| --- | --- | --- |
| `BETTER_AUTH_SECRET` | `staff-auth` | staff sessions (better-auth); the **person-code keys** (cards, app codes, PINs: HKDF from it, ADR 0783); the key client addresses are HMACed with for rate limits (ADR 0940) |
| `CUSTOMER_AUTH_SECRET` | `customer-auth` | customer sessions; the practitioner session key (HKDF from it, ADR 0581) |
| `DESK_SECRET` | `desk` | every desk enrolment code, device credential, session code and token (ADRs 0649, 0780) |

- **HKDF-SHA-256** (WebCrypto `deriveBits`, 256 bits, written as 64 hex characters), keyed with
  `COS_ROOT_KEY`, a fixed public salt (`cos/client-secret/salt/v1`) and the info
  `cos/client-secret/v<version>/<environment>/<purpose>/<client>`. Every part is from a closed
  alphabet without `/`, so no two (version, environment, purpose, client) give the same info.
  HKDF's outputs for different infos are independent: one client's derived secret says nothing of
  another's or of the root, and a compromise of one purpose (a leaked desk secret) gives no other.
- **There is no other host key material to derive.** MCP's OAuth tokens and API tokens are random
  values kept hashed; support grants are verified with the operator's public key (shared); CSRF is
  same-origin checks against the request, not a secret.
- **What follows from deriving.** The person-code keys and the practitioner key are derived from
  the staff and customer secrets, as on a single-client deployment, so they are per client too
  ("the desk secret and the person-code keys included"). As on a single-client deployment, a leak
  of `BETTER_AUTH_SECRET` also gives that client's person-code keys: separating them is a change to
  packages/core for both kinds of deployment, not made here.
- **Rotation.** Each purpose carries a version in its info (`DERIVED_SECRETS`, all `1`). Bumping a
  purpose's version, or replacing `COS_ROOT_KEY`, changes that secret (or all) for every client at
  once, with the same effect as changing the Worker secret on a single-client deployment today:
  staff or customers sign in again, desk devices enrol again, and (for the staff secret) cards are
  issued again, app codes made again and PINs set again (ADR 0783's header). **Staying signed in
  across a rotation is not built**: it would need better-auth to verify with the previous secret
  while signing with the new one, and the person-code keys to try both; until then a rotation is a
  planned sign-out. A rotation for one client alone (a per-client generation bound into the info)
  is not built either: it needs a registry column and is step 7's to add if wanted.
- **No root key, no derived secret:** the names are left out (the client's sign-in fails closed
  with "BETTER_AUTH_SECRET is not set") and the directory warns once. A malformed root key throws
  when an environment is built, naming the variable, never its value.

### Given secrets (`GIVEN_SECRET_NAMES`, `AI_KEY_*`)
What a client supplies and the host cannot derive, sealed in `registry_secrets`:

| Name | Used by |
| --- | --- |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | the client's own Google staff sign-in (packages/auth `index.ts`) |
| `CF_ACCESS_TEAM_DOMAIN`, `CF_ACCESS_AUD` | the client's own Cloudflare Access (packages/auth `cloudflare-access.ts`) |
| `TYPESAFE_API_KEY` | the judge (packages/core `judge/jev.ts`, the app's `ai.ts`) |
| `TURNSTILE_SITE_KEY` | a public form's page (the app's `http/form-page.ts`) |
| `TURNSTILE_SECRET_KEY` | the public door's check (the runner's `executor/host.ts`, packages/core `intake/runtime.ts`) |
| `AI_KEY_<PROVIDER>` | the client's own AI provider keys (packages/core `ai/client.ts`, `ai/roles.ts`) |

- **Sealing.** AES-256-GCM (WebCrypto) with a fresh random 12-byte nonce per value and a 128-bit
  tag, under a key derived with HKDF from `COS_SECRETS_KEY` (info
  `cos/registry-secrets/aes-256-gcm/v1`); the key's public id (`k1-<16 hex>`) is derived with HKDF
  under its own info, so neither is the raw key and the id says nothing of it. The associated data
  is `cos/registry-secret/v1/<environment>/<client>/<name>/<key id>`: a ciphertext copied to
  another client's row, renamed, moved to the other environment or claimed under another key does
  not open. The row holds the ciphertext and tag, the nonce and the key id (migration 0790's
  columns). Values are 1 byte to 16 KiB of UTF-8.
- **A derived name is never a given one.** `sealClientSecret` and `readClientSecrets` refuse any
  name outside `GIVEN_SECRET_NAMES` and `AI_KEY_*`, and the builder takes a value from the given
  secrets only into a name `ENV_NAMES` marks `given` (and a derived value only into a `derived`
  one): auth secrets are derived, not stored, even if someone writes such a row by hand.
- **Rotation of the secrets key.** Set the new key as `COS_SECRETS_KEY` and the old as
  `COS_SECRETS_KEY_PREVIOUS`; rows open under either (by key id) and every write seals under the
  current one. Step 7's command re-seals every row (`openClientSecret` then `writeClientSecret`),
  then the previous key is removed; a row still under it then no longer opens.
- **Written only by the operator.** `writeClientSecret(registry, keyring, place, value)` and
  `removeClientSecret(registry, client, name)` are for `cos client secret set` and `remove`
  (step 7). No operation, route or tool writes or reads them: the module is
  `@composable-os/db/registry-secrets`, which packages/core and the packs cannot name (step 3's
  `registry-unreachable` test covers `@composable-os/db/registry*`) and which the app's and the
  runner's code does not name (`secrets-unreachable.test.ts`).
- **Read in one place.** `ClientDirectory`, as it builds a client's environment, reads that
  client's rows (one statement, `readClientSecrets`) and opens them. A row it cannot open (no
  secrets key, a key it does not hold, moved, renamed, tampered with, or a name that is not a given
  secret's) is left out and logged by client and name only.
- **Where the plaintext is, and for how long.** A derived or opened value exists in memory only
  (1) in the directory's `#secretsOf` on its way into the environment, for the length of that
  call, and (2) as a string property of that client's frozen environment, which the directory
  keeps per isolate until the registry's stamp changes (a write, change or removal of any secret
  moves it, and every environment is rebuilt) or the isolate ends. The registry snapshot the
  directory caches holds no secret material at all, sealed or open: sealed rows are read per
  client when its environment is built. The keys are imported as non-extractable `CryptoKey`s and
  kept per isolate. Nothing logs a value or puts one in an error: errors and warnings name the
  client and the secret's name only.
- **What stays the operator's** (stage 66, "Secrets"): the Stream token and signing key (kept
  apart by step 4's video-host wrapper), the Platform AI token, the AI Gateway token, and each
  gatekeeper's own OAuth app (`CLIENT_ID`/`CLIENT_SECRET` of the Google, Microsoft, Slack and
  ZoomInfo gatekeepers): shared Worker secrets, as before.

### Addresses
Each client's addresses come from its **verified hostnames in the registry**, never from a
request's Host header beyond step 3's exact lookup:

- **Which hostname is a surface's address.** Migration 0791 adds `registry_hostnames.is_primary`
  (at most one per client and surface, a unique partial index). A surface's address is its marked
  verified hostname, or its only verified one; with several and none marked, the surface has no
  address and `RegistrySnapshot.problems` says so. An unverified hostname is never an address.
  `readRegistry` computes them into `RegistrySnapshot.addresses` (`ClientAddresses`: `staff`,
  `web`, `desk`, and every verified hostname). Every origin is `https://<hostname>`.
- **What the client's environment gets:**

  | Env name | From | Read by |
  | --- | --- | --- |
  | `BETTER_AUTH_URL` | the staff address | packages/auth `index.ts` (staff sign-in's `baseURL`); the app's `media.ts` (the fake stream's base, Stream's allowed origins) |
  | `APP_ORIGIN` | the staff address | the runner's `notifications/deliver.ts` (links in notifications), `integrations/payments.ts` → packages/core `orders/events.ts` (the order link in a confirmation email), `integrations/host.ts` (a connect flow's hand-back when the app passed none) |
  | `MCP_RESOURCE` | the staff address + `/mcp` | the app's `mcp/handler.ts` (the resource an access token is issued for) |
  | `CUSTOMER_AUTH_URL` | the web address, else the staff address | packages/auth `index.ts` (customer and practitioner sign-in's `baseURL`); the app's `host-mail.ts` (links in customer emails), `media.ts` |
  | `DESK_HOSTNAME` | the desk address | the app's `desk.ts` (the desk origin), `http/desk.ts`; none until step 8 adds desk hostnames |
  | `STREAM_ALLOWED_ORIGINS` | every verified hostname's origin | packages/core `records/stream.ts` (the hostnames a video plays on) |
  | `NATIVE_REDIRECT_URIS` | a registry setting (`CLIENT_SETTINGS`, `empty`): not a hostname | the app's `http/native.ts` via packages/core `http/handoff.ts` |
  | `API_ALLOWED_ORIGINS` | a registry setting (step 3) | the app's `http/api.ts`, `media.ts` |

  A client with only a staff hostname has its customer sign-in at its staff address, as a
  single-client host with no web app does today. The host's own values of these names never reach
  a client.
- **Addresses read from the request** (unchanged here; on a many-client host each is the
  hostname step 3's directory matched exactly, so one of that client's verified hostnames, with
  the request's scheme and port): the app's `call-operation.ts` and `http/api.ts` (`appOrigin`:
  connect flows' hand-back, `host-mail.ts`'s staff invite link `<origin>/sign-in`, and
  `desk.ts`'s desk origin scheme), `mcp/handler.ts` (the MCP metadata's issuer and the default
  resource), `http/native.ts` (its own origin), and the same-origin checks in `staff-origin.ts`,
  `assistant/http.ts`, `mcp/consent.ts` and `http/desk.ts`, which compare the request with itself
  and hold no address. When better-auth's `baseURL` is unset it infers from the request; on a
  many-client host that happens only for a client with no staff address. Moving the invite link
  and the MCP issuer to the env addresses is step 4's (its files), listed below.
- **Cookies** are host-only (no `domain` is set anywhere), so a cookie set at one client's
  hostname is never sent to another's.
- **The browser's own address** (`window.location.origin` in the staff app's components) is the
  hostname the person is on, and is not a server address.

### Gatekeeper callbacks on one address
- **One address.** `COS_CALLBACK_HOSTNAME` (the host's own, on the fleet's domain; `callback`,
  `callbacks`, `webhook` and `webhooks` are reserved client ids) is where every OAuth redirect and
  webhook arrives: each gatekeeper's `BASE_URL` is `gatekeeperBaseUrl(env, vendor)`,
  `https://<callback hostname>/gatekeeper/<vendor>`, set by the deploy engine (step 7), and a
  provider's app is registered once with it. `@composable-os/db/callbacks`:
  `isCallbackRequest(env, url)` is true only for exactly that hostname and a
  `/gatekeeper/<vendor>/...` path, and `ClientDirectory` refuses the callback hostname as no
  client's, even one the registry names. The app's entry (step 4) checks it first and passes such
  a request to the gatekeeper with no client; any other path there is a 404.
- **The host chooses no client from a callback.** What a callback carries is checked by the
  gatekeeper against what it stored when the client's own integration host started the flow, and
  only then does the gatekeeper act, through the capability that integration host gave it. So a
  callback carrying client A's state can reach only client A's connection:
  - **OAuth `state`** (Google, Microsoft, Slack, ZoomInfo, the fake): it names the account object
    the flow created (a 256-bit object id from `newUniqueId`) and a single-use nonce (32 random
    bytes), lives 10 minutes (`OAUTH_NONCE_LIFETIME_MS`) and is claimed (deleted) when used, and is
    verified (in constant time, in Google's, Slack's and ZoomInfo's flows) before the code is
    exchanged. The fake gatekeeper's state is its account object id and a single-use nonce in the
    path; it is local only. The account then calls
    back through `ConnectCallback`, whose props (the connection) the client's own runner minted;
    it stages the account in that connection's integration host and hands a ticket back to the
    address that connection's flow started from. The ticket is redeemed only by the user who
    started the flow, with the nonce only their window holds, within 15 minutes, once: bound to
    the client and the user's session.
  - **Webhooks**: the endpoint the delivery names is the gatekeeper's object, holding the signing
    secret the client set and the hook the client's integration host bound; the signature is
    verified with that secret before anything is stored or delivered.
  - Tests: `apps/runner/test/callbacks-one-address.test.ts` (two clients' connections on the one
    address: A's state completes only A's connection and hands back to A's address, A's account
    with B's nonce does nothing, A's ticket does nothing to B's connection, a state works once, B's
    connection is untouched and its own state still works); the existing
    `integrations.test.ts` (another user, another window's nonce), `gatekeeper-kit`'s
    `connect-nonce` and `gatekeeper-google`'s `oauth-flow` tests (expiry, single use).

### Gatekeepers: which act for one client only today
A gatekeeper is a Worker of the deployment, reached only through service bindings from the host's
own Workers (none is public; their public routes arrive through the app's `/gatekeeper/*` proxy).
How each gets its credentials and the client it acts for:

| Gatekeeper | Credentials | Per account | On a many-client host |
| --- | --- | --- | --- |
| Google, Microsoft, Slack, Slack posting, ZoomInfo | the operator's OAuth app (shared, stage 66); each account's tokens in that account's object |
| MCP | what the person gives for the server they connect, in that account's object | yes: one object per connection, created for it | **shared** (`GATEKEEPER_*`) |
| Web search | none of a client's | yes | shared |
| Payments | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`: one deployment's | **no**: one events object per provider for the deployment, one webhook `/in/stripe` | **left out** |
| Text | the deployment's provider | **no**: one events object for the deployment | **left out** |
| Inbound webhooks | the secret each endpoint's owner sets | **no**: endpoint ids are chosen by the user and global to the deployment, so a second client could open another's endpoint | **left out** |
| Email (receiving) | none | **no**: one mailbox per local part for the deployment | **left out** |
| Email sending | Cloudflare Email Service | sender allowed by the deployment's `ALLOWED_SENDER_DOMAINS` | **left out** (one client could send as another's domain) |
| Accounting, booking system | fakes and contracts only | — | no real gatekeeper yet |

**Left out** means the binding is `kept-apart` with no wrapper (`ENV_NAME_PATTERNS`), so it is in
no client's environment and the feature fails closed: a client can never take money into the
operator's Stripe account, or read another's webhook events or mail. Each needs, inside the
gatekeeper (beyond this step, for the coordinator):

1. **Payments**: the client's Stripe keys as given secrets (`STRIPE_SECRET_KEY`,
   `STRIPE_WEBHOOK_SECRET` become names of the runner's environment and `GIVEN_SECRET_NAMES`),
   passed by the integration host when it provisions the account (`createAccount({ provider,
   secretKey, webhookSecret })` over the service binding, which only the host's Workers can call)
   and held in that account's object; `PaymentsEvents` per account, not per provider; the webhook
   at `/in/stripe/<endpoint id>`, the id 128+ random bits made when the account is provisioned,
   mapping to that one account, the signature checked with that account's webhook secret before
   anything is stored. Needed before step 9's test payment (criterion 15).
2. **Text**: the same shape: the client's provider credentials per account, events per account,
   the delivery route by endpoint id.
3. **Inbound webhooks**: the endpoint object named by the account and the endpoint
   (`<account>/<endpoint id>`), the public route `/in/<random endpoint key>`; a single-client
   deployment's existing endpoint URLs need a migration or to be kept as they are there.
4. **Email receiving**: mailboxes on each client's own receiving domain, the object named by the
   full address, and a domain allowed for one client only.
5. **Email sending**: the client's own sender domains, from its registry settings, passed when the
   account is provisioned; the deployment's `ALLOWED_SENDER_DOMAINS` no longer every client's.
6. **Gmail and Chat push** (`GmailHookDriver`, `ChatHookDriver` by mailbox and space): already
   keyed per account inside, not checked in depth here; to confirm before Google is offered to a
   second client.

The runner's side of every callback (`ConnectCallback`'s props, the integration host's object
name) gains the client in step 4 ("A gatekeeper calling back: the connection it was minted for").

### For step 4 (the entries)
These names are now filled in a client's environment, so a path step 4 made fail "naming step 6"
can pass: `BETTER_AUTH_SECRET`, `CUSTOMER_AUTH_SECRET`, `DESK_SECRET` (derived);
`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `CF_ACCESS_TEAM_DOMAIN`, `CF_ACCESS_AUD`,
`TYPESAFE_API_KEY`, `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY`, `AI_KEY_*` (given, when the
operator set them); `BETTER_AUTH_URL`, `APP_ORIGIN`, `MCP_RESOURCE`, `CUSTOMER_AUTH_URL`,
`DESK_HOSTNAME` (when the client has a desk hostname), `STREAM_ALLOWED_ORIGINS` (addresses);
`NATIVE_REDIRECT_URIS` (a setting). Also for step 4: answer `isCallbackRequest` before deciding a
client; take the staff invite link and the MCP issuer from `BETTER_AUTH_URL` / `MCP_RESOURCE`
rather than the request on a many-client host; and the client in `ConnectCallback`'s props.

### For step 7 (the operator's commands)
`newHostKey()` (the two keys, per deployment), `secretsKeyring(current, previous?)`,
`writeClientSecret`, `removeClientSecret`, `openClientSecret` (re-sealing after a rotation, and
`cos client export`), `gatekeeperBaseUrl` (each gatekeeper's `BASE_URL`), and the
`is_primary` column when it writes hostnames. `writeClientSecret` binds the ciphertext as a BLOB
through a `D1Database`; over D1's REST API the command writes it as a hex literal.

## Open question for the owner or coordinator
**Who can seal a given secret.** With AES-GCM under `COS_SECRETS_KEY`, as built, the machine that
runs `cos client secret set` must hold `COS_SECRETS_KEY` too, so the key is not literally "only in
the host's environment": the operator's machine (or the CI secret it runs under) holds it as well,
and anything that can seal can also open. The options:

1. **As built:** the operator's command holds the key (from the fleet's secret store); simple, one
   key, and the command can also export secrets (`cos client export`).
2. **Sealing to the host:** the host's environment holds a private key (ECDH P-256 or X25519) and
   the command holds only its public key; each value is sealed with a fresh ephemeral key, HKDF and
   AES-GCM (HPKE's construction, in WebCrypto), so only the host can open it and the operator's
   machine never can. Export would then go through the host. The write function's signature
   changes (a public key in place of the keyring); the row gains the ephemeral public key in its
   ciphertext column; reading is unchanged for the directory.

Step 7 builds the command, so the choice is needed before it.

## Consequences
- **A single-client deployment is unchanged:** no Worker of one binds `REGISTRY`, so nothing here
  is read; its Worker secrets and vars are exactly as before, and every existing test passes on D1.
- **A many-client host needs `COS_ROOT_KEY` for anyone to sign in**, `COS_SECRETS_KEY` for any
  given secret, and a verified staff hostname per client for its addresses.
- **Payments, text, inbound webhooks and email are off on a many-client host** until their
  gatekeepers are made per client (above).
- **A registry outage or a rotation** behaves as ADR 0613 and "Rotation" above say.
