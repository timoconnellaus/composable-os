// What each name in the host's environment becomes in a client's environment, on a host that
// serves many clients (stage 66 step 3, ADR 0613). `buildClientEnvironment()` reads this table; a
// name it does not list is left out of every client's environment, so a binding or a secret added
// to a Worker without a line here cannot reach one client with what belongs to another, or to the
// host. packages/db/test/client-env-names.test.ts fails when a name the app or the runner
// declares, reads, or is given at deploy time is not here, and when a name listed here is no
// longer declared, read or set anywhere.
//
// A single-client deployment never reads this table: there, the client's environment is the
// real `env`.

/** What a name of the host's environment becomes in a client's environment. */
export type EnvNameUse =
  /** The host's own: never in a client's environment. */
  | { use: "host"; why: string }
  /** The client's id (`COS_CLIENT_ID`), set by the builder: a many-client host's marker. */
  | { use: "client" }
  /** The client's database: `clientDatabase(CLIENT_DB, client)`. */
  | { use: "database" }
  /** A deploy-time setting, per client, from the registry (`CLIENT_SETTINGS`). */
  | { use: "setting" }
  /**
   * The client's own secret (stage 66 step 6, ADR 0616): `derived` from the host's root key for
   * this client and purpose (`DERIVED_SECRETS`, never stored), or `given` by the client and
   * opened from the registry (`GIVEN_SECRET_NAMES`). Left out when the host cannot supply it.
   */
  | { use: "per-client"; what: "secret"; from: "derived" | "given"; why: string }
  /**
   * The client's own address (ADR 0616), from its verified hostnames in the registry, never from
   * a request: `staff` (its staff origin, with `path` appended), `customer` (its web origin, or
   * its staff origin when it has no web hostname: where customers sign in today), `desk` (its
   * desk hostname, a bare hostname), `all` (every verified hostname's origin, comma separated).
   */
  | {
      use: "per-client";
      what: "address";
      from: "staff" | "customer" | "desk" | "all";
      path?: string;
      why: string;
    }
  /** A shared binding or credential with a part per client: in only once its wrapper exists. */
  | { use: "kept-apart"; by: string }
  /**
   * The same for every client, and nothing in it reaches one client's part: the operator's own
   * names and ids, flags, or a service that keeps nothing of a client between calls. `why` says
   * which. A cache keyed by a shared object is one cache for every client (step 5).
   */
  | { use: "shared"; why: string };

const DERIVED = (why: string): EnvNameUse => ({
  use: "per-client",
  what: "secret",
  from: "derived",
  why,
});
const GIVEN = (why: string): EnvNameUse => ({
  use: "per-client",
  what: "secret",
  from: "given",
  why,
});
const ADDRESS = (
  from: "staff" | "customer" | "desk" | "all",
  why: string,
  path?: string,
): EnvNameUse => ({ use: "per-client", what: "address", from, ...(path ? { path } : {}), why });
const APART = (by: string): EnvNameUse => ({ use: "kept-apart", by });
const SHARED = (why: string): EnvNameUse => ({ use: "shared", why });
const HOST = (why: string): EnvNameUse => ({ use: "host", why });

/** Every name of the app's and the runner's environments, by name. */
export const ENV_NAMES: Readonly<Record<string, EnvNameUse>> = {
  // --- The host's own -----------------------------------------------------------------------
  REGISTRY: HOST("the registry: the operator's only (stage 66)"),
  // A namespace of `ClientDb` in its own Worker (`cos-client-db`), bound by script name.
  CLIENT_DB: HOST("every client's database, the operator's raw namespace (step 7)"),
  CLIENT_DB_QUERIES: HOST("every client's database's query path: a client's is its DB alone"),
  COS_HOST_ENVIRONMENT: HOST("which environment the deployment holds; read by the directory"),
  // Each Worker's own fan-out queue (stage 66 step 4): a cron's one message per client.
  CLIENT_FANOUT: HOST("the crons' fan-out: one message per client, sent by the host"),
  // Each Worker's own parking queue and its ledgers (stage 66 step 4; #515, S5): a paused
  // client's messages wait apart from the crons' ticks, counted and capped per client.
  CLIENT_PARKING: HOST("every client's parked messages: the host's queue, never a client's"),
  CLIENT_PARKING_LEDGER: HOST("every client's parking ledger (client-parking.ts)"),
  // The host's two proof keys (client-proofs.ts; #515, S4): never in a client's environment.
  COS_BINDING_KEY: HOST("names every client's objects (client-proofs.ts): never rotated in place"),
  COS_PROPS_KEY: HOST("signs props and calls on cos-client-db for every client (client-proofs.ts)"),
  COS_PROPS_KEY_PREVIOUS: HOST("the props key before a rotation, still accepted, never used to sign"),
  CLOUDFLARE_API_TOKEN: HOST(
    "Settings → AI writes the deployment's Worker secrets with it, every client's at once (ADR 0151), and it can read AI Gateway's logs",
  ),
  AI_SECRET_SCRIPTS: HOST("the Workers CLOUDFLARE_API_TOKEN writes to"),
  COS_UPDATE_TOKEN: HOST(
    "the operator's update of the deployment; per client it runs through the registry (step 7)",
  ),
  COS_TENANT_ID: HOST("stage 10's hosted tenant: one per deployment, no client's"),
  COS_CONTROL_URL: HOST("stage 10's control plane, one per deployment"),
  COS_CONTROL_KEY: HOST("stage 10's control plane, one per deployment"),
  AI_CUSTOMER_GATEWAY: HOST("stage 10's customer gateway: one tenant's logs, not a client's"),
  // Stage 66 step 6 (ADR 0616): the host's two keys, set by the deploy engine on a many-client
  // deployment only (step 7), different on staging and live. Read by the directory alone.
  COS_ROOT_KEY: HOST("every client's derived secrets come from it (registry-secrets.ts)"),
  COS_SECRETS_PRIVATE_KEY: HOST(
    "opens every client's given secrets, sealed to its public key (registry-sealing.ts)",
  ),
  COS_SECRETS_PRIVATE_KEY_PREVIOUS: HOST(
    "the private key before a rotation, while the host re-seals every row",
  ),
  // The one address of the deployment's gatekeeper callbacks (OAuth redirects, webhooks): every
  // gatekeeper's BASE_URL is under it. Read by the app's entry (`isCallbackHostname`), no client's.
  COS_CALLBACK_HOSTNAME: HOST("the deployment's one callback address, no client's (callbacks.ts)"),

  // --- The client's database ----------------------------------------------------------------
  DB: { use: "database" },
  // Which client the environment is for: set by the builder alone, never from the host's env.
  COS_CLIENT_ID: { use: "client" },

  // --- Secrets, per client (ADR 0616: derived, or given and stored sealed) -------------------
  BETTER_AUTH_SECRET: DERIVED("staff sessions, and the person-code keys derived from it"),
  CUSTOMER_AUTH_SECRET: DERIVED("customer sessions, and the practitioner key derived from it"),
  DESK_SECRET: DERIVED("the desk's codes, device credentials and session tokens"),
  SUPPORT_COOKIE_SECRET: DERIVED("the support cookie's MAC, not the staff secret"),
  CLIENT_ADDRESS_SECRET: DERIVED("the HMAC of a client address for rate limits"),
  GOOGLE_CLIENT_ID: GIVEN("the client's own Google sign-in"),
  GOOGLE_CLIENT_SECRET: GIVEN("the client's own Google sign-in"),
  CF_ACCESS_TEAM_DOMAIN: GIVEN("the client's own Cloudflare Access"),
  CF_ACCESS_AUD: GIVEN("the client's own Cloudflare Access"),
  TYPESAFE_API_KEY: GIVEN("the client's own judge key"),
  TURNSTILE_SITE_KEY: GIVEN("a Turnstile widget lists the hostnames it answers on"),
  TURNSTILE_SECRET_KEY: GIVEN("a Turnstile widget lists the hostnames it answers on"),

  // --- Addresses, per client (ADR 0616: from the client's verified hostnames) ---------------
  BETTER_AUTH_URL: ADDRESS("staff", "staff sign-in's base URL, and the host's own links"),
  CUSTOMER_AUTH_URL: ADDRESS("customer", "customer sign-in's base URL, and links in its emails"),
  APP_ORIGIN: ADDRESS("staff", "the runner's links in notifications and connect hand-backs"),
  MCP_RESOURCE: ADDRESS("staff", "the MCP resource an access token is issued for", "/mcp"),
  DESK_HOSTNAME: ADDRESS("desk", "the client's desk hostname (step 8 adds them)"),
  STREAM_ALLOWED_ORIGINS: ADDRESS("all", "the client's own addresses play its videos"),

  // --- Shared bindings and credentials with a part per client (step 4's wrappers) ------------
  BLOBS: APART("a key prefix per client, added on write and removed on list"),
  OAUTH_KV: APART("a key prefix per client"),
  VECTORIZE: APART("a namespace per client"),
  AUTOMATION_EVENTS: APART("the client stamped on every message"),
  ROUTINE_DELIVERY: APART("the client stamped on every message"),
  AUTOMATION_WORKFLOW: APART("the client in the instance id and beside the params"),
  HELLO_WORKFLOW: APART("the client in the instance id and beside the params"),
  ASSISTANT: APART("the client in every object's name"),
  AGENT_JOB: APART("the client in every object's name"),
  EXTENSION_WORKSPACE: APART("the client in every object's name"),
  CODE_MODE_GATE: APART("the client in every object's name"),
  INTEGRATION_HOST: APART("the client in every object's name"),
  FAKE_ACCOUNT: APART("the client in every object's name"),
  FAKE_PROVIDER: APART("the client in every object's name"),
  RUNNER: APART("the app passes the client; the runner trusts only the app"),
  // The account's Stream token lists, deletes and uploads every video of the account, and the
  // signing key signs playback for any of them: in only through the video host's wrapper, which
  // stamps the client as `creator` and refuses another creator's video (stage 66, "Stream").
  STREAM_API_TOKEN: APART("the client as creator; another creator's video refused"),
  STREAM_SIGNING_JWK: APART("the client as creator; another creator's video refused"),
  STREAM_SIGNING_KEY_ID: APART("goes with STREAM_SIGNING_JWK"),

  // --- The same for every client ------------------------------------------------------------
  LOADER: SHARED(
    "Worker Loader itself; the client is part of every tool worker id it is asked for (stage 66 step 4, ADR 0615)",
  ),
  AI: SHARED("Workers AI inference: answers each call, keeps nothing of a client between calls"),
  IMAGES: SHARED("transforms the bytes it is given, keeps nothing"),
  AI_GATEWAY_ID: SHARED("the operator's gateway's name, not a credential"),
  AI_GATEWAY_TOKEN: SHARED(
    "generated with AI Gateway Run and Workers AI Read only (release/gateway.ts): it sends requests and cannot read the gateway's logs",
  ),
  AI_GATEWAY_REST: SHARED("a flag: Workers AI over REST through the gateway"),
  AI_GATEWAY_BYOK: SHARED("a flag: the gateway adds the operator's stored provider keys"),
  AI_PLATFORM_TOKEN: SHARED('the Platform AI token, the operator\'s own (stage 66, "Secrets")'),
  AI_PLATFORM_GATEWAY_ID: SHARED("the platform gateway's name"),
  AI_PLATFORM_ACCOUNT_ID: SHARED("the platform gateway's account id"),
  AI_FAKE_MODEL: SHARED("a test flag"),
  AI_FAKE_VOICE: SHARED("a test flag"),
  JUDGE_BYOK: SHARED("a flag: the judge's key is in the gateway"),
  JUDGE_PLACEMENTS: SHARED("where the product uses the judge"),
  VECTORIZE_DIMENSIONS: SHARED("the index's dimensions"),
  CLOUDFLARE_ACCOUNT_ID: SHARED("the account's id, not a credential"),
  STREAM_ACCOUNT_ID: SHARED("the account's id, not a credential"),
  STREAM_CUSTOMER_CODE: SHARED("the playback hostname's code, public in every video URL"),
  STREAM_FAKE: SHARED("a test flag"),
  COS_RELEASE_VERSION: SHARED("the release every client runs (no client is held back)"),
  COS_RELEASE_REPO: SHARED("where releases come from"),
  COS_ACCOUNT_ID: SHARED("the account's id, not a credential"),
  COS_SUPPORT_PUBLIC_KEY: SHARED(
    "verifies support grants, whose audience is the request's hostname, so one client's grant fails at another's",
  ),
  COS_PRODUCT_LABEL: SHARED(
    "the product's name; read once into a module-level label today, which step 5 makes per client",
  ),
  COS_DEV_ORG_PACKS: SHARED("a development flag"),
  MCP_ACCESS_TOKEN_TTL: SHARED("a duration"),
  INTEGRATIONS_FAKE_PROVIDER: SHARED("a test flag"),
  // Vite's development flag, read off `import.meta.env`, never a Worker's binding.
  DEV: SHARED("Vite's build flag"),
};

/** Names matched by their shape, after `ENV_NAMES` and the settings. */
export const ENV_NAME_PATTERNS: ReadonlyArray<{ pattern: RegExp; use: EnvNameUse }> = [
  { pattern: /^AI_KEY_[A-Z0-9_]+$/, use: GIVEN("the client's own AI provider keys") },
  // Gatekeepers whose Worker holds one deployment's credentials or state for every account, so
  // one client would act with another's (ADR 0616, "Gatekeepers"): left out of every client's
  // environment until each is made per client. Payments: one Stripe key and one events object per
  // provider. Text: one events object for the deployment. Webhook: endpoint ids chosen by the
  // user, one object each for the deployment. Email: one mailbox per local part for the
  // deployment. Email sending: the deployment's sender domains.
  {
    pattern: /^GATEKEEPER_(?:PAYMENTS|TEXT|WEBHOOK|EMAIL|EMAIL_SEND)$/,
    use: APART(
      "each client's own provider account, endpoints and mailboxes: the gatekeeper's work, listed in ADR 0616",
    ),
  },
  {
    pattern: /^GATEKEEPER_[A-Z0-9_]+$/,
    use: SHARED(
      "a gatekeeper Worker: called with a connection minted for one client, whose object is that client's; its OAuth app is the operator's own, and each account's tokens are in that account's object (stage 66, ADR 0616)",
    ),
  },
  { pattern: /^[A-Z0-9_]+_RATE_LIMIT$/, use: APART("the client in every key") },
];
