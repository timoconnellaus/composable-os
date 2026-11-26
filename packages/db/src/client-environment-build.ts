// Building a client's environment (stage 66 step 3, ADR 0613). Internal to packages/db: it is
// not in the package's exports, so no entry can build an environment for a record of its own
// making. Only `ClientDirectory` (client-environment.ts) calls `buildClientEnvironment`, with a
// record it read from the registry and admitted. Tests import this file by its path.
import { type ClientDb, clientDatabase } from "./client-db.ts";
import { ENV_NAME_PATTERNS, ENV_NAMES, type EnvNameUse } from "./client-env-names.ts";
import { CLIENT_SETTINGS, type ClientId, type ClientRecord, isClientId } from "./registry.ts";

/** What this module needs of a Worker's `env`: its D1 binding, and on a many-client host more. */
export interface HostBindings {
  DB: D1Database;
  /** The registry. Bound only on a host that serves many clients. */
  REGISTRY?: D1Database;
  /**
   * Every client's database, one object each (ADR 0612). Bound with REGISTRY, as a Durable
   * Object namespace of the `ClientDb` class in its own rarely deployed Worker (`cos-client-db`,
   * by script name): deploying a class's Worker restarts every live object of it, so neither the
   * app nor the runner exports the class (ADR 0613).
   */
  CLIENT_DB?: DurableObjectNamespace<ClientDb>;
  /**
   * Which environment of its clients this deployment holds (`live` or `staging`). Required with
   * REGISTRY: the one source of the deployment's environment; a client of the other is unknown.
   */
  COS_HOST_ENVIRONMENT?: string;
}

/** What `name` of the host's environment becomes in a client's environment, or null: left out. */
export function envNameUse(name: string): EnvNameUse | null {
  if (Object.hasOwn(CLIENT_SETTINGS, name)) return { use: "setting" };
  if (Object.hasOwn(ENV_NAMES, name)) return ENV_NAMES[name] as EnvNameUse;
  for (const { pattern, use } of ENV_NAME_PATTERNS) if (pattern.test(name)) return use;
  return null;
}

/**
 * What every wrapper of a shared binding is: given the real binding and the client, a binding of
 * the same shape that reaches only that client's part (stage 66, "Shared bindings, kept apart").
 *
 * - It holds the real binding only in a closure or a `#private` field: no accessor, no `raw`,
 *   `unwrap` or `binding` property, no echo of its options.
 * - Every method that takes a key, name, id or prefix keeps it to the client's part; a method it
 *   does not implement is absent, never forwarded (no `Proxy` whose `get` passes through).
 * - It holds nothing of another client, nor anything of one request: it lives as long as the
 *   client's environment, which lives as long as the registry's stamp.
 * - Its result is frozen by `buildClientEnvironment`, so it must not need to change itself.
 * - It has behavioural tests (step 4): through every method, with another client's key, name or
 *   id, and with empty, `..` and over-long input, client A never reaches client B's part. The
 *   property walk in client-environment.test.ts does not prove this; it cannot see closures.
 */
export type BindingWrapper<B = unknown> = (binding: B, client: ClientId) => B;

/**
 * Workers Rate Limiting, kept apart: the client in every key, so one client's callers never use
 * up another's limit. A client id never holds `:`, so `<client>:<key>` is never another
 * client's key. The worked example of a wrapper; the others are step 4's.
 */
export const keepRateLimitApart: BindingWrapper<RateLimit> = (binding, client) => ({
  limit: (options: RateLimitOptions) =>
    binding.limit({ ...options, key: `${client}:${options.key}` }),
});

/**
 * The wrappers of the shared bindings, by the `by` of their entry in `ENV_NAMES` (or a pattern).
 * A kept-apart binding with no wrapper here is left out of every client's environment: code that
 * reaches for it fails, where an unwrapped binding would show one client another's part.
 */
export const BINDING_WRAPPERS: ReadonlyArray<{
  applies: (name: string) => boolean;
  wrap: BindingWrapper;
}> = Object.freeze([
  Object.freeze({
    applies: (name: string) => /^[A-Z0-9_]+_RATE_LIMIT$/.test(name),
    wrap: keepRateLimitApart as BindingWrapper,
  }),
]);

function wrapperFor(name: string): BindingWrapper | null {
  return BINDING_WRAPPERS.find((wrapper) => wrapper.applies(name))?.wrap ?? null;
}

/** Which client an environment built here is for. Keyed by the environment object itself. */
const clientOfEnvironment = new WeakMap<object, ClientId>();

/** The client an environment was built for, or null for a single-client deployment's `env`. */
export function clientOf(env: object): ClientId | null {
  return clientOfEnvironment.get(env) ?? null;
}

/** What the client's environment is built from: its registry row and its settings. */
export interface ClientPart {
  client: ClientRecord;
  settings: Readonly<Record<string, string>>;
}

/** A value made here for one client (its database, a wrapper's result): frozen. */
function frozen<T>(value: T): T {
  return value !== null && typeof value === "object" ? Object.freeze(value) : value;
}

/**
 * The client's environment on a host that serves many clients: a new, frozen object shaped like
 * `env`, holding only what `envNameUse` lets through.
 *
 * - `DB` is `clientDatabase(CLIENT_DB, client)`, created at the client's location hint.
 * - Each setting in `CLIENT_SETTINGS` is the client's from the registry; with no row, the
 *   deployment's own value (`inherit`) or nothing (`empty`).
 * - A shared value (`shared`) is the same object as in `env`, so a cache keyed by it (a WeakMap
 *   on `env.LOADER`, `env.AI`, a `GATEKEEPER_*` binding) is one cache for every client.
 * - A kept-apart binding is its wrapper's result, frozen, or left out when it has none.
 * - The host's own names, and the client's secrets and addresses that step 6 fills in, are left
 *   out, and so is any name `ENV_NAMES` does not list.
 *
 * The object and what is made here for it (`DB`, the wrappers' results) are frozen: it is shared
 * by every request of the client in the isolate, so a write below an entry throws (modules are
 * strict) instead of reaching the client's next request. Shared values are not frozen: they are
 * the host's own objects.
 */
export function buildClientEnvironment<E extends HostBindings>(env: E, part: ClientPart): E {
  const { client, settings } = part;
  if (!isClientId(client.id)) throw new RangeError("Not a client id");
  const namespace = env.CLIENT_DB;
  if (!namespace) throw new Error("No CLIENT_DB binding: a client's database cannot be opened");
  const out: Record<string, unknown> = {};
  for (const name of Object.keys(env)) {
    const use = envNameUse(name);
    if (!use) continue;
    const value = (env as unknown as Record<string, unknown>)[name];
    switch (use.use) {
      case "shared":
        out[name] = value;
        break;
      case "kept-apart": {
        const wrap = wrapperFor(name);
        if (wrap && value !== undefined && value !== null) {
          out[name] = frozen(wrap(value, client.id));
        }
        break;
      }
      // The settings are filled in below, whether or not `env` has them; the database too.
      case "setting":
      case "database":
      case "host":
      case "per-client":
        break;
    }
  }
  for (const [name, { absent }] of Object.entries(CLIENT_SETTINGS)) {
    const own = Object.hasOwn(settings, name) ? settings[name] : undefined;
    const value =
      own ?? (absent === "inherit" ? (env as unknown as Record<string, unknown>)[name] : undefined);
    if (typeof value === "string") out[name] = value;
  }
  out.DB = frozen(
    clientDatabase(
      namespace,
      client.id,
      client.locationHint ? { locationHint: client.locationHint } : undefined,
    ),
  );
  Object.freeze(out);
  clientOfEnvironment.set(out, client.id);
  return out as unknown as E;
}
