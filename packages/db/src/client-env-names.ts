// What each name in the host's environment becomes in a client's environment, on a host that
// serves many clients (stage 66 step 3, ADR 0613). `clientEnvironment()` reads this table; a name
// it does not list is left out of every client's environment, so a binding or a secret added to a
// Worker without a line here cannot reach one client with what belongs to another, or to the host.
// packages/db/test/client-env-names.test.ts fails when a name the app or the runner declares or
// reads is not here, and when a name listed here is no longer declared or read anywhere.
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
  /** A shared binding with a part per client: in only once its wrapper exists (step 4). */
  | { use: "kept-apart"; by: string }
  /** The same for every client: the operator's own, or code with no client's data in it. */
  | { use: "shared" };

const SECRET = (why: string): EnvNameUse => ({ use: "per-client", step: 6, what: "secret", why });
const ADDRESS = (why: string): EnvNameUse => ({ use: "per-client", step: 6, what: "address", why });
const APART = (by: string): EnvNameUse => ({ use: "kept-apart", by });
const SHARED: EnvNameUse = { use: "shared" };

/** Every name of the app's and the runner's environments, by name. */
export const ENV_NAMES: Readonly<Record<string, EnvNameUse>> = {
  // --- The host's own -----------------------------------------------------------------------
  REGISTRY: { use: "host", why: "the registry: the operator's only (stage 66)" },
  // A namespace of `ClientDb` in its own Worker (`cos-client-db`), bound by script name.
  CLIENT_DB: { use: "host", why: "every client's database: a client's is its DB alone" },
  CLOUDFLARE_API_TOKEN: {
    use: "host",
    why: "Settings → AI writes the deployment's Worker secrets with it: every client's at once (ADR 0151)",
  },
  AI_SECRET_SCRIPTS: { use: "host", why: "the Workers CLOUDFLARE_API_TOKEN writes to" },
  COS_UPDATE_TOKEN: {
    use: "host",
    why: "the operator's update of the deployment; per client it runs through the registry (step 7)",
  },
  COS_TENANT_ID: { use: "host", why: "stage 10's hosted tenant: one per deployment, no client's" },
  COS_CONTROL_URL: { use: "host", why: "stage 10's control plane, one per deployment" },
  COS_CONTROL_KEY: { use: "host", why: "stage 10's control plane, one per deployment" },

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

  // --- Shared bindings with a part per client (step 4's wrappers) ----------------------------
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

  // --- The same for every client ------------------------------------------------------------
  LOADER: SHARED, // Worker Loader ids are not per client (stage 66, "Decided by this spec")
  AI: SHARED,
  IMAGES: SHARED,
  AI_GATEWAY_ID: SHARED,
  AI_GATEWAY_TOKEN: SHARED,
  AI_GATEWAY_REST: SHARED,
  AI_GATEWAY_BYOK: SHARED,
  AI_CUSTOMER_GATEWAY: SHARED,
  AI_PLATFORM_TOKEN: SHARED,
  AI_PLATFORM_GATEWAY_ID: SHARED,
  AI_PLATFORM_ACCOUNT_ID: SHARED,
  AI_FAKE_MODEL: SHARED,
  AI_FAKE_VOICE: SHARED,
  JUDGE_BYOK: SHARED,
  JUDGE_PLACEMENTS: SHARED,
  VECTORIZE_DIMENSIONS: SHARED,
  CLOUDFLARE_ACCOUNT_ID: SHARED,
  STREAM_ACCOUNT_ID: SHARED,
  STREAM_CUSTOMER_CODE: SHARED,
  STREAM_SIGNING_KEY_ID: SHARED,
  STREAM_SIGNING_JWK: SHARED,
  STREAM_API_TOKEN: SHARED, // one holder of the token, the host (stage 66, "Stream")
  STREAM_FAKE: SHARED,
  COS_RELEASE_VERSION: SHARED,
  COS_RELEASE_REPO: SHARED,
  COS_ACCOUNT_ID: SHARED,
  COS_SUPPORT_PUBLIC_KEY: SHARED,
  COS_DEV_ORG_PACKS: SHARED,
  MCP_ACCESS_TOKEN_TTL: SHARED,
  INTEGRATIONS_FAKE_PROVIDER: SHARED,
  // Vite's development flag, read off `import.meta.env`, never a Worker's binding.
  DEV: SHARED,
};

/** Names matched by their shape, after `ENV_NAMES` and the settings. */
export const ENV_NAME_PATTERNS: ReadonlyArray<{ pattern: RegExp; use: EnvNameUse }> = [
  { pattern: /^AI_KEY_[A-Z0-9_]+$/, use: SECRET("the client's own AI provider keys") },
  { pattern: /^GATEKEEPER_[A-Z0-9_]+$/, use: SHARED }, // the connection says whose (stage 66)
  { pattern: /^[A-Z0-9_]+_RATE_LIMIT$/, use: APART("the client in every key") },
];
