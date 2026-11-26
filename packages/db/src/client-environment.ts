// The client's environment (stage 66 step 3, ADR 0613): the one function that, given the real
// `env` of a Worker and a client, returns an object shaped like that `env` for that client. `DB`
// is the client's database, its settings come from the registry, and each shared binding is in
// it only through a wrapper that reaches that client's part alone. Everything below an entry
// reads `env` as it does today.
//
// With no registry bound (no REGISTRY), the deployment serves one client, as every deployment
// did before stage 66: the client's environment IS the real `env`, `DB` is its D1 binding, and
// nothing here is read. A self-hosted install and a client in its own account run that way.
//
// No entry calls this yet: deciding the client at the app's and the runner's entries is step 4.
// Exported as `@composable-os/db/client-environment`, never from `@composable-os/db`.
import {
  keepBucketApart,
  keepKeyValueApart,
  keepObjectsApart,
  keepQueueApart,
  keepRunnerApart,
  keepVectorsApart,
  keepWorkflowApart,
} from "./client-bindings.ts";
import { type ClientDb, clientDatabase } from "./client-db.ts";
import { ENV_NAME_PATTERNS, ENV_NAMES, type EnvNameUse } from "./client-env-names.ts";
import {
  CLIENT_SETTINGS,
  type ClientEnvironmentName,
  type ClientId,
  type ClientRecord,
  canonicalHostname,
  type HostnameSurface,
  isClientId,
  type RegistrySnapshot,
  readRegistry,
  readRegistryVersion,
} from "./registry.ts";

/** What this module needs of a Worker's `env`: its D1 binding, and on a many-client host two more. */
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
}

type ManyClientBindings = HostBindings & {
  REGISTRY: D1Database;
  CLIENT_DB: DurableObjectNamespace<ClientDb>;
};

/** One client, or many: whether REGISTRY is bound. */
export type HostMode = "single" | "many";

export function hostMode(env: object): HostMode {
  const bindings = env as Partial<HostBindings>;
  if (!bindings.REGISTRY) return "single";
  // Fail closed: a registry with nowhere to open clients' databases is a broken deployment,
  // never a reason to serve every client from the one D1 database.
  if (!bindings.CLIENT_DB) {
    throw new Error("REGISTRY is bound without CLIENT_DB: no client's database can be opened");
  }
  return "many";
}

// --- What each name becomes ----------------------------------------------------------------

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
 * It must hold nothing of another client, must not hand the real binding out through any
 * property, and must refuse, not pass through, a call it cannot keep to the client's part. It is
 * called once per client's environment, which lives as long as the registry's version stamp, so
 * it must not hold anything that belongs to one request.
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

/** The names each wrapper of step 4 (client-bindings.ts, ADR 0615) applies to. */
const named =
  (...names: string[]) =>
  (name: string) =>
    names.includes(name);

/**
 * The wrappers of the shared bindings, by the `by` of their entry in `ENV_NAMES` (or a pattern).
 * A kept-apart binding with no wrapper here is left out of every client's environment: code that
 * reaches for it fails, where an unwrapped binding would show one client another's part.
 * packages/db/test/client-bindings.test.ts fails when a kept-apart name has none.
 */
export const BINDING_WRAPPERS: ReadonlyArray<{
  applies: (name: string) => boolean;
  wrap: BindingWrapper;
}> = [
  {
    applies: (name) => /^[A-Z0-9_]+_RATE_LIMIT$/.test(name),
    wrap: keepRateLimitApart as BindingWrapper,
  },
  { applies: named("BLOBS"), wrap: keepBucketApart as BindingWrapper },
  { applies: named("OAUTH_KV"), wrap: keepKeyValueApart as BindingWrapper },
  { applies: named("VECTORIZE"), wrap: keepVectorsApart as BindingWrapper },
  {
    applies: named("AUTOMATION_EVENTS", "ROUTINE_DELIVERY"),
    wrap: keepQueueApart as BindingWrapper,
  },
  {
    applies: named("AUTOMATION_WORKFLOW", "HELLO_WORKFLOW"),
    wrap: keepWorkflowApart as BindingWrapper,
  },
  {
    applies: named(
      "ASSISTANT",
      "AGENT_JOB",
      "EXTENSION_WORKSPACE",
      "CODE_MODE_GATE",
      "INTEGRATION_HOST",
      "FAKE_ACCOUNT",
      "FAKE_PROVIDER",
    ),
    wrap: keepObjectsApart as BindingWrapper,
  },
  { applies: named("RUNNER"), wrap: keepRunnerApart as BindingWrapper },
];

/** Whether a kept-apart `name` has a wrapper (a test holds every one to it). */
export function hasBindingWrapper(name: string): boolean {
  return wrapperFor(name) !== null;
}

function wrapperFor(name: string): BindingWrapper | null {
  return BINDING_WRAPPERS.find((wrapper) => wrapper.applies(name))?.wrap ?? null;
}

// --- Building a client's environment -------------------------------------------------------

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

/**
 * The client's environment on a host that serves many clients: a new object shaped like `env`,
 * holding only what `envNameUse` lets through.
 *
 * - `DB` is `clientDatabase(CLIENT_DB, client)`, created at the client's location hint.
 * - Each setting in `CLIENT_SETTINGS` is the client's from the registry; with no row, the
 *   deployment's own value (`inherit`) or nothing (`empty`).
 * - A shared value (`shared`) is the same object as in `env`.
 * - A kept-apart binding is its wrapper's result, or left out when it has none (step 4).
 * - The host's own names, and the client's secrets and addresses that step 6 fills in, are left
 *   out, and so is any name `ENV_NAMES` does not list.
 *
 * Nothing in the result leads to the registry, to `CLIENT_DB`, to the real `env` or to another
 * client's database (packages/db/test/client-environment.test.ts walks it).
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
        if (wrap && value !== undefined && value !== null) out[name] = wrap(value, client.id);
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
  out.DB = clientDatabase(
    namespace,
    client.id,
    client.locationHint ? { locationHint: client.locationHint } : undefined,
  );
  clientOfEnvironment.set(out, client.id);
  return out as unknown as E;
}

// --- The directory: the registry as a host reads it ----------------------------------------

/** How often, at most, a directory reads the registry's version stamp. */
export const REGISTRY_REFRESH_MS = 10_000;

export interface ClientDirectoryOptions {
  /** Only clients of this environment are found (the deployment's own); all when omitted. */
  environment?: ClientEnvironmentName;
  /** How long a read of the registry is used before its stamp is read again. */
  refreshMs?: number;
  now?: () => number;
}

/** A request's client, from its hostname. */
export interface HostnameMatch {
  client: ClientRecord;
  surface: HostnameSurface;
}

/**
 * The registry as one isolate of a many-client host reads it: the whole registry held in memory,
 * read again only when its version stamp has changed, and the stamp read at most once every
 * `refreshMs`. A hostname is matched exactly, in memory, so an unknown hostname costs the
 * registry nothing. Each client's environment is built once per stamp and is then the same
 * object for every request (auth's caches are keyed by the `env` object).
 *
 * What it holds is keyed by client id (environments) or by exact hostname (the match): nothing
 * of one client is ever answered for another. The instance is the cache; `hostDirectory()` keeps
 * one per real `env` object.
 */
export class ClientDirectory<E extends HostBindings = HostBindings> {
  readonly #env: E & ManyClientBindings;
  readonly #options: Required<Omit<ClientDirectoryOptions, "environment">> & {
    environment?: ClientEnvironmentName;
  };
  #snapshot: RegistrySnapshot | null = null;
  #checkedAt = Number.NEGATIVE_INFINITY;
  readonly #environments = new Map<ClientId, E>();

  constructor(env: E, options: ClientDirectoryOptions = {}) {
    if (hostMode(env) !== "many") throw new Error("No REGISTRY binding: one client, no directory");
    this.#env = env as E & ManyClientBindings;
    this.#options = {
      refreshMs: options.refreshMs ?? REGISTRY_REFRESH_MS,
      now: options.now ?? Date.now,
      ...(options.environment ? { environment: options.environment } : {}),
    };
  }

  /** The registry as last read, read again when its stamp has changed. */
  async snapshot(): Promise<RegistrySnapshot> {
    const now = this.#options.now();
    if (this.#snapshot && now - this.#checkedAt < this.#options.refreshMs) return this.#snapshot;
    // Each request reads for itself: a promise of one request's I/O cannot be awaited by another
    // in the Workers runtime, so two requests arriving together each read the stamp once.
    return this.#refresh(now);
  }

  async #refresh(now: number): Promise<RegistrySnapshot> {
    const current = this.#snapshot;
    if (current && (await readRegistryVersion(this.#env.REGISTRY)) === current.version) {
      this.#checkedAt = now;
      return current;
    }
    const next = await readRegistry(this.#env.REGISTRY);
    this.#snapshot = next;
    this.#checkedAt = now;
    // A changed registry may have changed any client's settings: every environment is rebuilt.
    this.#environments.clear();
    return next;
  }

  #found(client: ClientRecord | undefined): ClientRecord | null {
    if (!client) return null;
    const { environment } = this.#options;
    return environment && client.environment !== environment ? null : client;
  }

  /** A client by id, or null when the registry has none of this deployment's environment. */
  async client(id: string): Promise<ClientRecord | null> {
    if (!isClientId(id)) return null;
    return this.#found((await this.snapshot()).clients.get(id));
  }

  /**
   * The client a request is for, from its hostname (the Host header, or a hostname a web app
   * passes): the verified hostname equal to it, once canonical, or null. Never a suffix, a
   * pattern or a client named in the hostname.
   */
  async clientForHostname(host: string | null | undefined): Promise<HostnameMatch | null> {
    const hostname = canonicalHostname(host);
    if (!hostname) return null;
    const snapshot = await this.snapshot();
    const match = snapshot.hostnames.get(hostname);
    if (!match) return null;
    const client = this.#found(snapshot.clients.get(match.client));
    return client ? { client, surface: match.surface } : null;
  }

  /** Every active client's id, for a cron's fan-out (one message per client, step 4). */
  async activeClients(): Promise<ClientId[]> {
    const snapshot = await this.snapshot();
    return [...snapshot.clients.values()]
      .filter((client) => this.#found(client) && client.status === "active")
      .map((client) => client.id);
  }

  /** The client's environment, the same object until the registry changes; null if unknown. */
  async environmentFor(id: string): Promise<E | null> {
    const snapshot = await this.snapshot();
    if (!isClientId(id)) return null;
    const client = this.#found(snapshot.clients.get(id));
    if (!client) return null;
    let built = this.#environments.get(client.id);
    if (!built) {
      built = buildClientEnvironment(this.#env, {
        client,
        settings: snapshot.settings.get(client.id) ?? {},
      }) as E;
      this.#environments.set(client.id, built);
    }
    return built;
  }
}

/** One directory per real `env` object (one per isolate), made the first time it is asked for. */
const directories = new WeakMap<object, ClientDirectory<HostBindings>>();

/** The directory of a many-client host's `env`, or null on a single-client deployment. */
export function hostDirectory<E extends HostBindings>(
  env: E,
  options?: ClientDirectoryOptions,
): ClientDirectory<E> | null {
  if (hostMode(env) === "single") return null;
  let directory = directories.get(env) as ClientDirectory<E> | undefined;
  if (!directory) {
    directory = new ClientDirectory(env, options);
    directories.set(env, directory as unknown as ClientDirectory<HostBindings>);
  }
  return directory;
}

// --- What the entries call (step 4) --------------------------------------------------------

/** Which client a request is for. */
export type RequestClient<E> =
  /** A single-client deployment: every request is its one client's, with the real `env`. */
  | { mode: "single"; env: E }
  /** A known, verified hostname of one client. */
  | { mode: "many"; client: ClientRecord; surface: HostnameSurface; env: E }
  /** A hostname the registry does not have: a 404, before any other code (step 4). */
  | { mode: "many"; client: null };

/**
 * The client a request is for, from its hostname, and that client's environment. On a
 * single-client deployment the hostname is not read, and `env` is the real one, unchanged.
 */
export async function clientForRequest<E extends HostBindings>(
  env: E,
  hostname: string | null | undefined,
): Promise<RequestClient<E>> {
  const directory = hostDirectory(env);
  if (!directory) return { mode: "single", env };
  const match = await directory.clientForHostname(hostname);
  if (!match) return { mode: "many", client: null };
  const clientEnv = await directory.environmentFor(match.client.id);
  if (!clientEnv) return { mode: "many", client: null };
  return { mode: "many", client: match.client, surface: match.surface, env: clientEnv };
}

/**
 * The environment for `client`, given by an entry that already knows it (the runner called by the
 * app, a queue message's stamp, a Durable Object's name: step 4). On a single-client deployment
 * there is no client to name: `client` must be null, and the real `env` comes back unchanged. On
 * a many-client host, null when the registry does not have the client.
 */
export async function environmentFor<E extends HostBindings>(
  env: E,
  client: string | null,
): Promise<E | null> {
  const directory = hostDirectory(env);
  if (!directory) {
    if (client !== null) {
      throw new Error("A client was named on a single-client deployment, which has no registry");
    }
    return env;
  }
  if (client === null) throw new Error("A many-client host needs the client for its environment");
  return directory.environmentFor(client);
}
