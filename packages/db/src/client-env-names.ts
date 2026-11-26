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
  /** The client's database: `clientDatabase(CLIENT_DB, client)`. */
  | { use: "database" }
  /** A deploy-time setting, per client, from the registry (`CLIENT_SETTINGS`). */
  | { use: "setting" }
  /** The client's own, filled in by a later step; left out until then. */
  | { use: "per-client"; step: 6; what: "secret" | "address"; why: string }
  /** A shared binding or credential with a part per client: in only once its wrapper exists. */
  | { use: "kept-apart"; by: string }
  /**
   * The same for every client, and nothing in it reaches one client's part: the operator's own
   * names and ids, flags, or a service that keeps nothing of a client between calls. `why` says
   * which. A cache keyed by a shared object is one cache for every client (step 5).
   */
  | { use: "shared"; why: string };

const SECRET = (why: string): EnvNameUse => ({ use: "per-client", step: 6, what: "secret", why });
const ADDRESS = (why: string): EnvNameUse => ({ use: "per-client", step: 6, what: "address", why });
const APART = (by: string): EnvNameUse => ({ use: "kept-apart", by });
const SHARED = (why: string): EnvNameUse => ({ use: "shared", why });
const HOST = (why: string): EnvNameUse => ({ use: "host", why });

/** Every name of the app's and the runner's environments, by name. */
export const ENV_NAMES: Readonly<Record<string, EnvNameUse>> = {
  // --- The host's own -----------------------------------------------------------------------
  REGISTRY: HOST("the registry: the operator's only (stage 66)"),
  // A namespace of `ClientDb` in its own Worker (`cos-client-db`), bound by script name.
  CLIENT_DB: HOST("every client's database: a client's is its DB alone"),
  COS_HOST_ENVIRONMENT: HOST("which environment the deployment holds; read by the directory"),
  // Each Worker's own fan-out queue (stage 66 step 4): a cron's one message per client.
  CLIENT_FANOUT: HOST("the crons' fan-out: one message per client, sent by the host"),
  COS_BINDING_KEY: HOST("signs what the host hands a client by a name or props (client-proofs.ts)"),
  COS_CALLBACK_HOSTNAME: HOST("the deployment's one callback address, no client's (callbacks.ts)"),
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

  // --- The client's database ----------------------------------------------------------------
  DB: { use: "database" },

  // --- Secrets, per client (step 6: derived, or given and stored encrypted) ------------------
  BETTER_AUTH_SECRET: SECRET("derived per client from the host's master secret"),
  CUSTOMER_AUTH_SECRET: SECRET("derived per client from the host's master secret"),
  DESK_SECRET: SECRET("derived per client (the desk's signing secret)"),
  GOOGLE_CLIENT_ID: SECRET("the client's own Google sign-in"),
  GOOGLE_CLIENT_SECRET: SECRET("the client's own Google sign-in"),
  CF_ACCESS_TEAM_DOMAIN: SECRET("the client's own Cloudflare Access"),
  CF_ACCESS_AUD: SECRET("the client's own Cloudflare Access"),
  TYPESAFE_API_KEY: SECRET("the client's own judge key"),
  TURNSTILE_SITE_KEY: SECRET("a Turnstile widget lists the hostnames it answers on"),
  TURNSTILE_SECRET_KEY: SECRET("a Turnstile widget lists the hostnames it answers on"),

  // --- Addresses, per client (step 6: from the client's hostnames) --------------------------
  BETTER_AUTH_URL: ADDRESS("the client's staff address"),
  CUSTOMER_AUTH_URL: ADDRESS("the client's web address"),
  APP_ORIGIN: ADDRESS("the client's staff address"),
  MCP_RESOURCE: ADDRESS("the client's staff address"),
  DESK_HOSTNAME: ADDRESS("the client's desk hostname (step 8)"),
  NATIVE_REDIRECT_URIS: ADDRESS("the client's own native app"),
  STREAM_ALLOWED_ORIGINS: ADDRESS("the client's own addresses play its videos"),

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
    "Worker Loader itself; the client is part of every tool worker id it is asked for (ADR 0613, step 4)",
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
  { pattern: /^AI_KEY_[A-Z0-9_]+$/, use: SECRET("the client's own AI provider keys") },
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
