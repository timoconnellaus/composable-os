# ADR 0616: Secrets and addresses per client; gatekeeper callbacks on one address

Status: accepted, 2026-11-26 (stage 66 step 6, `feat/stage-66-secrets-addresses`); revised
2026-11-27 after its security review: given secrets sealed to the host's public key (HPKE), `__Host-`
session cookies on a many-client host, a key per purpose for the support cookie and client
addresses, a secret generation per client, and imported secrets. Builds the owner's decision 8 ("a
client's given secrets may be stored encrypted in the registry: under a key only the host's
environment holds ... auth secrets are derived, not stored"), stage 66's "Secrets", "Addresses" and
"Gatekeeper callbacks use one address per deployment", on
[ADR 0613](0613-the-registry-and-the-clients-environment.md)'s registry and client's environment.
Amends [ADR 0008](0008-identity-adapters.md),
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
| `COS_ROOT_KEY` | the root key every derived secret comes from |
| `COS_SECRETS_PRIVATE_KEY` | the private key given secrets are sealed to (HPKE; its public key is the operator's) |
| `COS_SECRETS_PRIVATE_KEY_PREVIOUS` | the private key before a rotation, while the host re-seals every row |
| `COS_CALLBACK_HOSTNAME` | the deployment's one callback hostname (below) |

- **Each key is 32 random bytes as canonical base64url** (43 characters; `newHostKeys()` makes the
  root key, the private key and its public key). Refused, naming the variable and never the value:
  any other length or alphabet, a text that is not the canonical encoding of its bytes (the last
  character carries two bits no key has, so two texts would name one key), and a key of fewer than
  16 distinct byte values (all zeros, a repeated pattern).
- **Staging and live are two deployments with different keys**, and the deployment's environment
  is bound into every derivation and every sealed value besides, so a staging secret never derives
  or opens on live.
- **Only `packages/db` reads the keys.** The protection is structural: a client's environment
  never holds a `host` name nor any name `ENV_NAMES` does not list (tested in
  `client-environment.test.ts` and `client-secrets.test.ts`), the opening side
  (`src/registry-secrets.ts`) is not in the package's exports at all, and below an entry code is
  handed only the client's environment. `packages/db/test/secrets-unreachable.test.ts` adds a
  textual scan of the app's, the runner's, packages/auth's, packages/core's and every pack's
  source for the secrets modules, `registry_secrets` and the key names; being textual, it is
  passed by computed access (`env["COS_" + "ROOT_KEY"]`, `Object.entries(env)`) or a computed
  import, so it is a tripwire, not the control.

### Derived secrets (`DERIVED_SECRETS`)
Every secret the host signs or encrypts with for itself, derived per client, stored nowhere
(except as an imported override, below). Every key the host uses for a client, and its purpose:

| Env name | Purpose | What it keys |
| --- | --- | --- |
| `BETTER_AUTH_SECRET` | `staff-auth` | staff sessions (better-auth); the **person-code keys** derived from it with HKDF, one info each (card HMAC, app-secret AES-GCM, PIN pre-hash; ADR 0783) |
| `CUSTOMER_AUTH_SECRET` | `customer-auth` | customer sessions; the practitioner session key derived from it (ADR 0581) |
| `DESK_SECRET` | `desk` | every desk enrolment code, device credential, session code and token (ADRs 0649, 0780) |
| `SUPPORT_COOKIE_SECRET` | `support-cookie` | the support cookie's HMAC (ADR 0212): on a many-client host never the staff secret |
| `CLIENT_ADDRESS_SECRET` | `client-address` | the HMAC of a client address for rate limits (ADR 0940): never the staff secret there either |

- **HKDF-SHA-256** (WebCrypto `deriveBits`, 256 bits, written as 64 hex characters), keyed with
  `COS_ROOT_KEY`, a fixed public salt (`cos/client-secret/salt/v1`) and the info
  `cos/client-secret/v<version>/<environment>/<purpose>/<client>/<generation>`. Every part is from
  a closed alphabet without `/`, so no two give the same info; HKDF's outputs for different infos
  are independent, so one client's derived secret says nothing of another's or of the root, and a
  compromise of one purpose gives no other.
- **The secret generation** (`registry_clients.secret_generation`, migration 0792): 128 random bits
  the registry writes once when a client is added (a trigger) and refuses to change (another), bound
  into every derivation. A client id removed and added again gets new secrets, never the ones it
  had. A client with no generation gets no derived secret (and the directory says so).
- **One key, one purpose.** On a single-client deployment the support cookie is still MACed with
  `BETTER_AUTH_SECRET` and the client-address key is `"client-address\n" + BETTER_AUTH_SECRET`
  (unchanged, so nobody's state is lost). On a many-client host (`COS_CLIENT_ID` in the
  environment) the support cookie uses `SUPPORT_COOKIE_SECRET` only and the client-address key
  `CLIENT_ADDRESS_SECRET` only, never falling back to the staff secret.
- **There is no other host key material to derive.** MCP's OAuth tokens and API tokens are random
  values kept hashed; support grants are verified with the operator's public key (shared); CSRF is
  same-origin checks against the request, not a secret.
- **Rotation.** Each purpose carries a version in its info (all `1`). Bumping one, or replacing
  `COS_ROOT_KEY`, changes that secret (or all) for every client at once, with the same effect as
  changing the Worker secret on a single-client deployment today: staff or customers sign in again,
  desk devices enrol again, and (for the staff secret) cards are issued again, app codes made again
  and PINs set again. **Staying signed in across a rotation is not built**: it would need
  better-auth to verify with the previous secret while signing with the new one, and the person-code
  keys to try both; until then a rotation is a planned sign-out.
- **No root key, no derived secret:** the names are left out (sign-in fails closed with
  "BETTER_AUTH_SECRET is not set") and the directory warns once.

### A client's derived secrets follow it (imported secrets and the export)
- **Leaving** (decision 9's leaving promise, `cos client export`, step 7): `exportClientSecrets(env,
  client)` returns the client's derived secrets (or its imported overrides) and its given secrets,
  opened on the host for the operator only. Its own install sets them as its Worker secrets, so
  sessions, cards, PINs, app codes and desk enrolments carry on.
- **Coming in** (`cos client import` of an existing single-client deployment, step 7): its existing
  derivable secrets are stored with `writeImportedSecret` as `imported` rows (sealed like a given
  secret, the kind bound into the seal), and for that client each overrides derivation. The import
  path is the only way a derivable name is stored: `writeClientSecret` refuses one, a row of kind
  `given` with a derivable name is left out, and the builder takes an imported value only into a
  derivable name. A moved client that returns comes in the same way.
- **Only for a client added as imported** (migration 0793, 2026-11-27): `registry_clients.imported`
  is set when the client is added and never changed (a trigger), and the registry refuses an
  `imported` row for any other client (triggers on insert and update); the directory honours one
  only for an imported client besides. So an auth secret cannot be pinned on an existing client
  by writing a row. An imported secret is only as secret as the old deployment was (its former
  operator still holds it): `dropImportedSecrets(registry, client)` removes the overrides, after
  which every secret of the client is derived (a planned sign-out, and cards, PINs, app codes and
  desk enrolments issued again). The secret generation is the registry's own: an INSERT that
  supplies one is refused, so a removed client id cannot come back with its old secrets.

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

- **Sealed to the host: HPKE** (RFC 9180), base mode, DHKEM(X25519, HKDF-SHA256), HKDF-SHA256,
  AES-256-GCM, through `@hpke/core` 1.9.0 (MIT; WebCrypto's X25519, HKDF and AES-GCM underneath;
  nothing of HPKE's labelled extract and expand is written here). The host's environment holds the
  private key: the 32-byte `COS_SECRETS_PRIVATE_KEY`, from which RFC 9180's `DeriveKeyPair` makes
  the key pair. The operator's command holds only the public key (`sealingPublicKey(text)`, its
  id `k2-` and 16 hex characters of its SHA-256). Each value gets a fresh encapsulation; its place,
  `cos/registry-secret/v2/<kind>/<environment>/<client>/<name>/<key id>`, is both HPKE's `info`
  and the AEAD's associated data, so a sealed value copied to another client, renamed, moved to
  the other environment, relabelled as another kind or claimed under another key does not open.
  The row (migration 0792, which rebuilt the table nothing had written) holds the kind, `enc` (the
  32-byte encapsulated key), the ciphertext with its tag, and the key id. The library is checked
  against the CFRG's published vector for this suite (`test/fixtures/hpke-x25519-sha256-aes256gcm.json`).
- **Who can write the registry is root over every client's identity** (corrected 2026-11-27).
  The public key is treated as public: base-mode HPKE has no sender authentication, so anyone who
  holds it and can write the registry can seal any value for any client. They can replace a
  client's sign-in provider (`GOOGLE_CLIENT_*`), its Cloudflare Access team and audience (and so
  sign in as any of its staff), its Turnstile secret (switching bot checks off) and its AI keys;
  for a client added as imported, its imported auth secrets too (and so forge its sessions). What
  they **cannot** do is read a sealed value or a derived secret (the private key and the root key
  are only in the host's environment). The integrity of `registry_secrets` therefore rests on who
  can write the registry's D1 database, not on the seal; that holder (the Cloudflare token that
  writes it) can in any case write each client's data and redeploy the host. **For step 7:**
  authenticated sealing (an operator signature over the place, `enc` and ciphertext, or HPKE's
  auth mode) is decided together with the signed audit of the operator's writes; it adds
  something only once the signing key lives apart from the Cloudflare token. The two private keys
  pass through the machine that makes them once, at the deployment's creation, as any Worker
  secret does.
- **Values** are 1 byte to 16 KiB of UTF-8, and well-formed text: a value with a lone surrogate
  is refused, never silently changed.
- **Rotation of the secrets key** happens on the host. Set the new private key as
  `COS_SECRETS_PRIVATE_KEY` and the old as `COS_SECRETS_PRIVATE_KEY_PREVIOUS`; rows open under
  either (by key id). `resealClientSecrets(registry, keyring, environment, client)` (operator-only,
  on the host) opens each row still under the old key and seals it to the new public key; then the
  previous key is removed. The operator's command gets the new public key.
- **Written only by the operator.** `writeClientSecret`, `writeImportedSecret` and
  `removeClientSecret` are in `@composable-os/db/registry-sealing`, the package's only secrets
  export. It cannot open because only the host's environment holds the private key; it also
  exports no opening function, no private-key helper and not the HPKE suite (those are internal:
  `registry-hpke.ts`, `registry-secrets.ts`). No operation, route or tool writes or
  reads them: packages/core and the packs cannot name `@composable-os/db/registry*` (step 3's
  `registry-unreachable`), and the app's, the runner's and packages/auth's code does not
  (`secrets-unreachable`). A running host serves a removed or changed value for up to
  `REGISTRY_REFRESH_MS` (10 seconds) more, until its next stamp check; the operator's command says
  so when it writes.
- **Read in one place.** `ClientDirectory`, as it builds a client's environment, reads that
  client's rows (one statement, `readClientSecrets`) and opens them. A row it cannot open (no
  private key, a key it does not hold, moved, renamed, relabelled, tampered with, or a name that
  does not fit its kind) is left out and logged by client and name only.
- **Where the plaintext is, and for how long.** A derived or opened value exists in memory only
  (1) in the directory's `#secretsOf` on its way into the environment, for the length of that call,
  and (2) as a string property of that client's frozen environment, which the directory keeps per
  isolate until the registry's stamp changes (a write, change or removal of any secret moves it,
  and every environment is rebuilt) or the isolate ends. The registry snapshot holds no secret
  material at all, sealed or open. The keys are imported once per isolate as `CryptoKey`s.
  Nothing logs a value or puts one in an error: errors and warnings name the client and the
  secret's name only. A provider that echoes a key in its error is cut out too, by the one
  redactor of provider text (packages/core `ai/redact.ts`, below).
- **What stays the operator's** (stage 66, "Secrets"): the Stream token and signing key (kept
  apart by step 4's video-host wrapper), the Platform AI token, the AI Gateway token, and each
  gatekeeper's own OAuth app (`CLIENT_ID`/`CLIENT_SECRET` of the Google, Microsoft, Slack and
  ZoomInfo gatekeepers): shared Worker secrets, as before.

### Provider text, redacted (every deployment, 2026-11-27)
A provider, or a proxy in front of it, may echo the key it was sent in its error. Every place
provider text leaves the model runner goes through one redactor, packages/core `ai/redact.ts`,
before it is returned, logged, stored or sent to a model again. This holds on a single-client
deployment as on a many-client host.

- **What it cuts** (revised 2026-11-27, issue #517): every credential the Worker holds
  (`credentialsOf(env)`: `AI_KEY_*` and every name ending in `_TOKEN`, `_SECRET`, `_KEY`,
  `_PASSWORD`, `_JWK`, `_PRIVATE_KEY` and the like, never `_PUBLIC_KEY`, `_SITE_KEY` or `_KEY_ID`;
  every string inside a JSON credential value; of `AI_CUSTOMER_GATEWAY` only its `token`), in each
  form it can come back in: plain, URL-encoded, JSON-escaped (with `\/` too), base64 and base64url
  at any alignment (a Basic `user:key` header); and any run of 12 or more characters found anywhere
  in one of those forms (its start, its middle, its end, and the rest of a key split by a line
  break or a space), so that at most a piece under 12 characters (the last 4 a provider shows) may
  stay. A 12-character piece that is word-like (letters of one case with punctuation, no digit) or
  the head of a URL is not looked for on its own, so a credential holding an ordinary word or
  `https://` never blanks ordinary text. A `Bearer` or `Basic` scheme is cut only before a
  token-shaped value ("Basic auth is disabled" stays). A value shorter than 8 characters is not
  redacted, by rule. It reads the text at every sixth character for a 6-character anchor and grows
  each hit, so a 200 KB adversarial text takes 1 to 3 ms (a test holds it under 40 ms).
  `packages/core/test/redact-env-names.test.ts` fails when a name the Workers declare looks secret
  and is neither collected nor listed as not a secret.
- **Where:**
  - **The model runner** (`ai/client.ts`): every error `run`, `embed` and `test` throw, and the
    fallback's warning, is redacted, so summaries, routines, the adjudicator, digests, dictation
    clean-up, search indexing, hybrid search, dashboard building, extensions' AI and
    `ai.testRole` all get clean text.
  - **Each chat model** the runner hands out carries its `redact`. `runTurn` (packages/agent-core)
    applies it to the error event, `result.error`, the stored note "(This answer failed: …)" and
    its log line, and to a **tool's error text**: a tool that throws, or a tool result marked
    `isError` (an MCP server's), is redacted before the model, the `tool-result` event and the
    stored response see it. A successful tool result is the tool's own data and is passed on as it
    is. The assistant's turns, its compaction and its jobs all run through `runTurn`.
  - **The assistant's and the jobs' own failure paths** (`agent.ts`, `job.ts`) redact what they
    show, log and store, with the env's redactor.
  - **The judge's** `redactor` is the same code.
  - **Gatekeepers** hold their own credentials (OAuth refresh tokens, client secrets), which the
    host never sees, so each scrubs its own where it knows them, with
    `@composable-os/gatekeeper-kit/upstream-error`: an upstream failure is quoted as the HTTP
    status, the provider's error code and its description scrubbed of what was sent, never the raw
    body. Google (token exchange and refresh, Calendar, BigQuery), Microsoft (Graph's message, the
    token endpoint through the kit's OAuth client), Slack and Slack posting (an error code only),
    ZoomInfo (token endpoint and API, no raw body kept on the error), payments (Stripe's type and
    code only when each is an identifier), web search (the status only) and MCP (its own
    `redactSecrets` of the credential it sent and the OAuth client's secret) each have an echoing
    upstream test. Email receiving, email sending (Cloudflare's binding), text and inbound webhooks
    call no upstream with a credential of theirs.
- **Notes already stored with a key in them** (on any existing deployment): no scrub is run. When
  a stored conversation is read back into a turn, `runTurn` redacts every failure note before the
  history is sent to a model, so an old stored key is never re-sent. Only credentials still in the
  environment are known: a note quoting a key since rotated keeps it (except where the bearer and
  header rules catch it), and a rotation has made that key dead. The note stays in the stored
  thread; erasing it is the thread's own deletion.
- **Other routes checked** (issue #517): the audit log's `error` holds an operation's typed error,
  whose text comes from the sources above (the runner, the gatekeepers, the host's own
  operations); notifications and emails that quote an error (routine deliveries, agent jobs,
  connection errors, the outbox) store text from those same sources; MCP tool results returned to
  an outside MCP client carry `Internal error` for an unexpected failure and an operation's own
  message otherwise; `errorForLog` logs the message and five stack frames, never `cause`, and
  every log of a model error goes through the redactor first.


### Addresses
Each client's addresses come from its **verified hostnames in the registry**, never from a
request's Host header beyond step 3's exact lookup:

- **Which hostname is a surface's address.** Migration 0791 adds `registry_hostnames.is_primary`:
  at most one per client and surface (a unique partial index), and only on a verified hostname
  (the column's check). A surface's address is its marked hostname, or its only verified one; with
  several and none marked, the surface has no address and `RegistrySnapshot.problems` says so.
  `readRegistry` computes them into `RegistrySnapshot.addresses`. Every origin is
  `https://<hostname>`.
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
  | `COS_CLIENT_ID` | the client's id, set by the builder alone | packages/auth and the app's `support.ts`: a many-client host's marker (cookies, keys) |

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
- **The browser's own address** (`window.location.origin` in the staff app's components) is the
  hostname the person is on, and is not a server address.

### Cookies
- **What host-only means, and what it does not.** No cookie sets `Domain`, so a cookie set at one
  client's hostname is never *sent* to another's. That alone does not stop a page on a sibling
  hostname of the fleet's domain (`gym-a.composableos.app`) from *setting* a cookie for the whole
  domain (`Domain=composableos.app`) under the name of another client's session cookie, as long as
  the domain is not a public suffix: a login CSRF or session fixation across clients, or at least a
  sign-out.
- **On a many-client host every session cookie is `__Host-` prefixed** (Secure, `Path=/`, no
  `Domain`): browsers refuse a `__Host-` cookie that names a domain, and the host reads only the
  prefixed name, so a planted cookie is never read. Staff (`__Host-better-auth.*`), customer
  (`__Host-cos-customer.*`) and practitioner (`__Host-cos-practitioner.*`) sign-in set every cookie
  of theirs this way (`cookieOptions` in packages/auth), the support cookie is
  `__Host-cos_support`, and the desk's were already `__Host-`. Not changed here: a client web app
  that keeps a customer signed in over the binding (`keepCustomerSignedIn`, packages/client) sets
  the cookie back with `Secure` only for a `__Secure-` name, so a `__Host-` one's refresh would be
  refused by the browser (the original cookie stands); step 8, which puts client web apps against
  a many-client host, adds `__Host-` there (a change that redraws the web blocks' pictures). A
  single-client deployment keeps today's names (`__Secure-…`, `cos_support`),
  so nobody is signed out. Tests: `packages/auth/test/host-cookies.test.ts`,
  `apps/app/test/support.test.ts`.
- **For step 8:** client-controlled web code is never served on the fleet's staff domain: a
  client's web app is on its own domain, or on a registrable domain apart from the staff hostnames;
  and the fleet's domain is submitted to the Public Suffix List (its private section; allow weeks),
  so a sibling cannot set a cookie for the whole domain at all.

### Gatekeeper callbacks on one address
- **One address.** `COS_CALLBACK_HOSTNAME` (the host's own, on the fleet's domain; `callback`,
  `callbacks`, `webhook` and `webhooks` are reserved client ids) is where every OAuth redirect and
  webhook arrives: each gatekeeper's `BASE_URL` is `gatekeeperBaseUrl(env, vendor)`,
  `https://<callback hostname>/gatekeeper/<vendor>`, set by the deploy engine (step 7), and a
  provider's app is registered once with it. `@composable-os/db/callbacks`:
  `isCallbackRequest(env, url)` is true only for exactly that hostname and a
  `/gatekeeper/<vendor>/...` path, and `ClientDirectory` refuses the callback hostname as no
  client's, even one the registry names. A callback hostname that is not canonical fails once,
  with one message, where the directory is made (not on every request); step 7's deploy checks it
  before it sets it. The app's entry (step 4) checks `isCallbackRequest` first and passes such a
  request to the gatekeeper with no client; any other path there is a 404.
- **The host chooses no client from a callback.** What a callback carries is checked by the
  gatekeeper against what it stored when the client's own integration host started the flow, and
  only then does the gatekeeper act, through the capability that integration host gave it. So a
  callback carrying client A's state can reach only client A's connection:
  - **OAuth `state`** (Google, Microsoft, Slack, ZoomInfo through the shared kit): it names the
    account object the flow created (a 256-bit object id) and a single-use nonce (32 random bytes),
    lives 10 minutes and is claimed when used, and is compared in constant time before the code is
    exchanged (Microsoft adds PKCE). The fake gatekeeper's state is its account object id and a
    single-use 144-bit nonce; it is local only. The account calls back through `ConnectCallback`,
    whose props (the connection) the client's own runner minted; it stages the account in that
    connection's integration host and hands a ticket back to the address that flow started from.
    The ticket is redeemed only by the user who started the flow, with the nonce only their window
    holds, within 15 minutes, once: bound to the client and the user's session.
  - **Webhooks**: the endpoint the delivery names is the gatekeeper's object, holding the signing
    secret the client set and the hook the client's integration host bound; the signature is
    verified with that secret before anything is stored or delivered.
  - Tests: `apps/runner/test/callbacks-one-address.test.ts` (two clients' connections on the one
    address: each state hands back to its own client's address with a ticket for its own
    connection, A's account with B's nonce does nothing, A's ticket is refused at B's connection
    (which ends B's flow, failing closed, and B never holds A's account), A's connection completes
    with its own ticket and nonce, a state works once); the existing `integrations.test.ts`
    (another user, another window's nonce), `gatekeeper-kit`'s `connect-nonce` and
    `gatekeeper-google`'s `oauth-flow` tests (expiry, single use).

### Gatekeepers: which act for one client only today
A gatekeeper is a Worker of the deployment, reached only through service bindings from the host's
own Workers (none is public; their public routes arrive through the app's `/gatekeeper/*` proxy).
How each gets its credentials and the client it acts for:

| Gatekeeper | Credentials | Per account | On a many-client host |
| --- | --- | --- | --- |
| Google | the operator's OAuth app; each account's tokens in its own object | the account, yes; **Gmail push and Chat drivers are named by mailbox and by space for the whole deployment** (`gmail-hooks.ts`, `chat-hooks.ts`) | shared (see 6 below) |
| Microsoft | the operator's OAuth app; tokens per account | yes (Outlook drivers by account and mailbox) | shared |
| Slack, Slack posting | the operator's Slack app; tokens per account | the account, yes; **Events delivery routing not checked** | shared (see 7 below) |
| ZoomInfo | the operator's OAuth app; tokens per account | yes | shared |
| MCP | what the person gives for the server they connect, in that account's object | yes | shared |
| Web search | none of a client's | yes | shared |
| Payments | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`: one deployment's | **no**: one events object per provider, one webhook `/in/stripe` | **left out** |
| Text | the deployment's provider | **no**: one events object for the deployment | **left out** |
| Inbound webhooks | the secret each endpoint's owner sets | **no**: endpoint ids chosen by the user, global to the deployment | **left out** |
| Email (receiving) | none | **no**: one mailbox per local part for the deployment | **left out** |
| Email sending | Cloudflare Email Service | sender allowed by the deployment's `ALLOWED_SENDER_DOMAINS` | **left out** (one client could send as another's domain) |
| The fake gatekeeper | none | one fake book for the deployment, a fixed local signing secret | **refused**: a directory will not start with `INTEGRATIONS_FAKE_PROVIDER` on or `GATEKEEPER_FAKE` bound |
| Accounting, booking system | fakes and contracts only | — | no real gatekeeper yet |

**Left out** means the binding is `kept-apart` with no wrapper (`ENV_NAME_PATTERNS`), so it is in
no client's environment and the feature fails closed. Each needs, inside the gatekeeper (beyond
this step, for the coordinator):

1. **Payments: the owner's decision between two shapes.**
   - **Per-client Stripe accounts, keys passed per call, sealed to the gatekeeper.** The client's
     Stripe keys are given secrets; they are never copied into the gatekeeper's Durable Object in
     plaintext. The gatekeeper has its own HPKE key pair (its private key a Worker secret of the
     gatekeeper alone); the host seals the client's key to the gatekeeper's public key and passes
     the sealed value with each call that needs it, and the gatekeeper opens it for that call only.
     `PaymentsEvents` per account; the webhook at `/in/stripe/<endpoint id>` (128+ random bits,
     made when the account is provisioned, mapping to one account), its signature checked with
     that client's webhook secret (passed the same way) before anything is stored. One webhook
     endpoint per client in Stripe.
   - **Stripe Connect** (the alternative for a shared host): the operator's platform account and
     one secret key (a Worker secret of the gatekeeper, the operator's own), each client a
     connected account addressed with `Stripe-Account`; Connect webhooks carry the `account`, so
     one webhook address per deployment, matching "one address per deployment", and no client's
     Stripe secret is held at all. The gatekeeper maps a connected account id to exactly one
     account (set when the client's account is provisioned) and refuses an event for any other.
     Costs: Connect's onboarding and fees, and the platform's responsibilities to Stripe.
2. **Text**: the same shape as the first option: the client's provider credentials passed per
   call sealed to the gatekeeper, events per account, the delivery route by endpoint id.
3. **Inbound webhooks**: the endpoint object named by the account and the endpoint
   (`<account>/<endpoint id>`), the public route `/in/<random endpoint key>`; a single-client
   deployment's existing endpoint URLs are kept as they are there.
4. **Email receiving**: mailboxes on each client's own receiving domain, the object named by the
   full address, and a domain allowed for one client only.
5. **Email sending**: the client's own sender domains, from its registry settings, passed when the
   account is provisioned; the deployment's `ALLOWED_SENDER_DOMAINS` no longer every client's.
6. **Gmail push and Chat**: the drivers are named per mailbox and per space for the whole
   deployment, so two clients connecting one mailbox or space would share a driver: name them by
   account (or by client and mailbox), and confirm a push reaches only the accounts that asked,
   before Google is offered to a second client.
7. **Slack Events**: how an event is routed to an account was not checked; check it is by the
   account's own team and app installation before Slack is offered to a second client.

**What the first client needs** (step 9):
- **Before a test payment** (criterion 15): payments per client (1, first shape) or Stripe Connect
  (1, second shape). Neither is built.
- **Before a sign-in code can be emailed** to its staff or customers: a connected Gmail or Outlook
  mailbox of its own (shared OAuth apps, which work on a many-client host; Gmail needs Google's
  verification of the operator's app for its restricted scope), or email sending per client (5).

The runner's side of every callback (`ConnectCallback`'s props, the integration host's object
name) gains the client in step 4 ("A gatekeeper calling back: the connection it was minted for").

### For step 4 (the entries)
These names are now filled in a client's environment, so a path step 4 made fail "naming step 6"
can pass: `BETTER_AUTH_SECRET`, `CUSTOMER_AUTH_SECRET`, `DESK_SECRET`, `SUPPORT_COOKIE_SECRET`,
`CLIENT_ADDRESS_SECRET` (derived, or imported); `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`,
`CF_ACCESS_TEAM_DOMAIN`, `CF_ACCESS_AUD`, `TYPESAFE_API_KEY`, `TURNSTILE_SITE_KEY`,
`TURNSTILE_SECRET_KEY`, `AI_KEY_*` (given, when the operator set them); `BETTER_AUTH_URL`,
`APP_ORIGIN`, `MCP_RESOURCE`, `CUSTOMER_AUTH_URL`, `DESK_HOSTNAME` (when the client has one),
`STREAM_ALLOWED_ORIGINS` (addresses); `NATIVE_REDIRECT_URIS` (a setting); `COS_CLIENT_ID`. Also for
step 4: answer `isCallbackRequest` before deciding a client; take the staff invite link and the MCP
issuer from `BETTER_AUTH_URL` / `MCP_RESOURCE` rather than the request on a many-client host; and
the client in `ConnectCallback`'s props.

### For step 7 (the operator's commands)
From `@composable-os/db/registry-sealing` (the operator's side, which cannot open):
- `newHostKeys(): Promise<{ rootKey; secretsPrivateKey; secretsPublicKey }>`: a deployment's keys;
  the two private ones go only to the host's Worker secrets.
- `publicKeyOf(privateText): Promise<SealingPublicKey>` and `sealingPublicKey(text)`.
- `writeClientSecret(registry, publicKey, { environment, client, name }, value)`: was
  `(registry, keyring, place, value)`; now takes the public key.
- `writeImportedSecret(registry, publicKey, { environment, client, name }, value)`: new, for
  `cos client import` of a single-client deployment; only for a client added with
  `imported = 1` (migration 0793).
- `dropImportedSecrets(registry, client): Promise<number>`: removes a client's imported overrides.
- Adding a client: `imported` set then, never after; `secret_generation` never supplied.
- `removeClientSecret(registry, client, name)`, unchanged.
- The registry's writes: `is_primary` only on a verified hostname; `secret_generation` is written
  by the registry itself and never by the command.

On the host, operator-only (internal to packages/db; step 7 adds the operator's way to reach them
and their export, with no route before then):
- `exportClientSecrets(env, client): Promise<{ derived; given; problems }>` (the leaving promise).
- `resealClientSecrets(registry, keyring, environment, client): Promise<{ resealed; problems }>`
  (after a rotation), with `openingKeyring(current, previous?)`.

Also for step 7: `gatekeeperBaseUrl(env, vendor)` for each gatekeeper's `BASE_URL`; check
`COS_CALLBACK_HOSTNAME` is canonical before setting it; a supplied AI Gateway token with AI Gateway
Read refused (ADR 0613); `writeClientSecret` binds the sealed bytes as BLOBs through a
`D1Database` (over D1's REST API, hex literals); the command says that a running host serves the
old value for up to 10 seconds.

### Payments: the owner chose (2026-11-27)
*Added 2026-11-27 (stage 66 step 7).* Of the two shapes under "Gatekeepers" item 1, the owner chose
the first: **each client's own Stripe account, its keys passed per call sealed to the payments
gatekeeper**, not Stripe Connect (Connect may be added later for clients who prefer it). The
gatekeeper's change is a later step. Step 7 makes the commands ready for it: `STRIPE_SECRET_KEY`
and `STRIPE_WEBHOOK_SECRET` are given secrets (`GATEKEEPER_HELD_SECRET_NAMES`), stored with `cos
client secret set` sealed like every other, carried by a leaving client's export, and in no
client's environment (no `ENV_NAMES` entry names them, so the builder takes neither), until the
gatekeeper is made per client.

### Authenticated sealing: decided by step 7 (2026-11-27), open to the owner's override
*Added 2026-11-27.* "For step 7: authenticated sealing … is decided together with the signed audit
of the operator's writes". Decided: **not added now**; base-mode HPKE stays. A signature adds
something only when its key is held apart from the Cloudflare token that can write the registry and
redeploy the host, and today the operator holds both. The signed audit and a signing key held apart
(a hardware key or the control plane) come together, as one later step. ADR 0617.

## Consequences
- **A single-client deployment is unchanged:** no Worker of one binds `REGISTRY`, so nothing here
  is read; its Worker secrets, cookie names and vars are exactly as before, and every existing test
  passes on D1.
- **A many-client host needs `COS_ROOT_KEY` for anyone to sign in**, `COS_SECRETS_PRIVATE_KEY` for
  any given secret, and a verified staff hostname per client for its addresses.
- **Payments, text, inbound webhooks and email are off on a many-client host** until their
  gatekeepers are made per client (above), and the fake gatekeeper cannot run there.
- **One new dependency**, `@hpke/core` (with `@hpke/common`), in packages/db.
- **A registry outage or a rotation** behaves as ADR 0613 and "Rotation" above say.
