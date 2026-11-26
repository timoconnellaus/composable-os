// The client's environment (stage 66 step 3, ADR 0613): given the real `env` of a Worker and a
// client, an object shaped like that `env` for that client. `DB` is the client's database, its
// settings come from the registry, and each shared binding is in it only through a wrapper that
// reaches that client's part alone. Everything below an entry reads `env` as it does today.
//
// With no registry bound (no REGISTRY), the deployment serves one client, as every deployment
// did before stage 66: the client's environment IS the real `env`, `DB` is its D1 binding, and
// nothing here is read. A self-hosted install and a client in its own account run that way.
//
// On a many-client host, refusal is the default: an environment is handed out only with
// `served: true`, for a client the registry has, of this deployment's environment, `active`,
// with its schema not behind the code, reached on a verified hostname. Every other answer is
// `served: false` with the reason and no environment at all.
//
// Exported as `@composable-os/db/client-environment`, never from `@composable-os/db`. Building an
// environment (client-environment-build.ts) is internal: only the directory does it.
import {
  BINDING_WRAPPERS,
  type BindingWrapper,
  buildClientEnvironment,
  clientOf,
  envNameUse,
  type HostBindings,
  keepRateLimitApart,
} from "./client-environment-build.ts";
import { CORE_SCHEMA_VERSION } from "./migrate.ts";
import {
  CLIENT_ENVIRONMENTS,
  type ClientEnvironmentName,
  type ClientId,
  type ClientRecord,
  canonicalHostname,
  type HostnameSurface,
  isClientId,
  isSchemaBehind,
  type RegistrySnapshot,
  readRegistry,
  readRegistryStamp,
} from "./registry.ts";

export type { BindingWrapper, HostBindings };
export { BINDING_WRAPPERS, clientOf, envNameUse, keepRateLimitApart };

type ManyClientBindings = HostBindings & {
  REGISTRY: D1Database;
  CLIENT_DB: NonNullable<HostBindings["CLIENT_DB"]>;
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

/** The deployment's own environment, from `COS_HOST_ENVIRONMENT`; required on a many-client host. */
export function hostEnvironment(env: object): ClientEnvironmentName {
  const value = (env as Partial<HostBindings>).COS_HOST_ENVIRONMENT;
  if (!CLIENT_ENVIRONMENTS.includes(value as ClientEnvironmentName)) {
    throw new Error(
      `COS_HOST_ENVIRONMENT must be "live" or "staging" on a host with a registry (got ${JSON.stringify(value ?? null)})`,
    );
  }
  return value as ClientEnvironmentName;
}

// --- What the directory answers ------------------------------------------------------------

/**
 * Why a client is not served. `unknown`: no such client on this deployment (or one of the other
 * environment); `unverified`: a hostname the registry holds but has not verified; `paused`;
 * `moving` (never served: writes during an export would be lost); `schema-behind` (its database
 * is behind the code: the "being updated" page). An entry answers every refusal but
 * `schema-behind` the same as an unknown hostname.
 */
export type Refusal = "unknown" | "unverified" | "paused" | "moving" | "schema-behind";

/** A client by id: its environment only when served. */
export type ClientAdmission<E> =
  | { served: true; client: ClientRecord; env: E }
  | { served: false; refused: Refusal; client: ClientRecord | null };

/** A request's client by hostname: its environment only when served. */
export type HostnameAdmission<E> =
  | { served: true; client: ClientRecord; surface: HostnameSurface; env: E }
  | { served: false; refused: Refusal; client: ClientRecord | null };

// --- The directory: the registry as a host reads it ----------------------------------------

/** How often, at most, a directory reads the registry's version stamp. */
export const REGISTRY_REFRESH_MS = 10_000;

export interface ClientDirectoryOptions {
  /** How long a read of the registry is used before its stamp is read again. */
  refreshMs?: number;
  now?: () => number;
  /** The schema version this code expects (tests). */
  codeSchemaVersion?: number;
}

/**
 * The registry as one isolate of a many-client host reads it: the whole registry held in memory,
 * read again only when its stamp has changed, and the stamp read at most once every
 * `refreshMs`. A hostname is matched exactly, in memory, so an unknown hostname costs the
 * registry nothing. Each served client's environment is built once per stamp and is then the
 * same frozen object for every request (auth's caches are keyed by the `env` object).
 *
 * What it holds is keyed by client id (environments) or by exact hostname (the match): nothing
 * of one client is ever answered for another. Only clients of the deployment's environment
 * (`COS_HOST_ENVIRONMENT`) are found.
 *
 * A failed read of the registry fails the call: the directory never serves a stale copy, so a
 * registry outage stops every client of the deployment (ADR 0613, "Availability").
 */
export class ClientDirectory<E extends HostBindings = HostBindings> {
  readonly #env: E & ManyClientBindings;
  readonly #environment: ClientEnvironmentName;
  readonly #refreshMs: number;
  readonly #now: () => number;
  readonly #codeSchemaVersion: number;
  #snapshot: RegistrySnapshot | null = null;
  #checkedAt = Number.NEGATIVE_INFINITY;
  /** Each refresh takes a ticket; a refresh older than the last one applied is discarded. */
  #tickets = 0;
  #applied = 0;
  readonly #environments = new Map<ClientId, E>();

  constructor(env: E, options: ClientDirectoryOptions = {}) {
    if (hostMode(env) !== "many") throw new Error("No REGISTRY binding: one client, no directory");
    this.#env = env as E & ManyClientBindings;
    this.#environment = hostEnvironment(env);
    this.#refreshMs = options.refreshMs ?? REGISTRY_REFRESH_MS;
    this.#now = options.now ?? Date.now;
    this.#codeSchemaVersion = options.codeSchemaVersion ?? CORE_SCHEMA_VERSION;
  }

  /** The deployment's environment, the only one this directory finds clients of. */
  get environment(): ClientEnvironmentName {
    return this.#environment;
  }

  /** The registry as last read, read again when its stamp has changed. */
  async snapshot(): Promise<RegistrySnapshot> {
    const now = this.#now();
    if (this.#snapshot && now - this.#checkedAt < this.#refreshMs) return this.#snapshot;
    // Each request reads for itself: a promise of one request's I/O cannot be awaited by another
    // in the Workers runtime, so two requests arriving together each read the stamp once.
    return this.#refresh(now);
  }

  async #refresh(now: number): Promise<RegistrySnapshot> {
    const ticket = ++this.#tickets;
    const current = this.#snapshot;
    let next: RegistrySnapshot;
    if (current && (await readRegistryStamp(this.#env.REGISTRY)) === current.stamp) {
      next = current;
    } else {
      next = await readRegistry(this.#env.REGISTRY);
    }
    // A read that started before one already applied is older: it never replaces it (otherwise a
    // removed client could come back until the next check).
    if (ticket < this.#applied) return this.#snapshot ?? next;
    this.#applied = ticket;
    this.#checkedAt = now;
    if (next !== current) {
      this.#snapshot = next;
      // A changed registry may have changed any client's settings: every environment is rebuilt.
      this.#environments.clear();
      if (next.problems.length > 0) {
        console.warn(
          `registry ${next.stamp}: ${next.problems.length} row(s) left out: ${next.problems.join("; ")}`,
        );
      }
    }
    return next;
  }

  #ofThisDeployment(client: ClientRecord | undefined): ClientRecord | null {
    return client && client.environment === this.#environment ? client : null;
  }

  /** A client's record by id (no environment), or null when this deployment has none. */
  async client(id: string): Promise<ClientRecord | null> {
    if (!isClientId(id)) return null;
    return this.#ofThisDeployment((await this.snapshot()).clients.get(id));
  }

  #admit(snapshot: RegistrySnapshot, record: ClientRecord | null): ClientAdmission<E> {
    if (!record) return { served: false, refused: "unknown", client: null };
    if (record.status === "moving") return { served: false, refused: "moving", client: record };
    if (record.status !== "active") return { served: false, refused: "paused", client: record };
    if (isSchemaBehind(record, this.#codeSchemaVersion)) {
      return { served: false, refused: "schema-behind", client: record };
    }
    let built = this.#environments.get(record.id);
    if (!built) {
      built = buildClientEnvironment(this.#env, {
        client: record,
        settings: snapshot.settings.get(record.id) ?? {},
      }) as E;
      this.#environments.set(record.id, built);
    }
    return { served: true, client: record, env: built };
  }

  /**
   * The client a request is for, from its hostname (`new URL(request.url).hostname`, or a
   * hostname a web app passes): the verified hostname equal to it, once canonical. Never a
   * suffix, a pattern or a client named in the hostname. Served only as `environmentFor` serves.
   */
  async clientForHostname(host: string | null | undefined): Promise<HostnameAdmission<E>> {
    const hostname = canonicalHostname(host);
    if (!hostname) return { served: false, refused: "unknown", client: null };
    const snapshot = await this.snapshot();
    const match = snapshot.hostnames.get(hostname);
    if (!match) {
      const refused = snapshot.unverified.has(hostname) ? "unverified" : "unknown";
      return { served: false, refused, client: null };
    }
    const admission = this.#admit(
      snapshot,
      this.#ofThisDeployment(snapshot.clients.get(match.client)),
    );
    return admission.served ? { ...admission, surface: match.surface } : admission;
  }

  /** The client's environment, by id: the same object until the registry changes. */
  async environmentFor(id: string): Promise<ClientAdmission<E>> {
    const snapshot = await this.snapshot();
    if (!isClientId(id)) return { served: false, refused: "unknown", client: null };
    return this.#admit(snapshot, this.#ofThisDeployment(snapshot.clients.get(id)));
  }

  /** Every active client's id, for a cron's fan-out (one message per client, step 4). */
  async activeClients(): Promise<ClientId[]> {
    const snapshot = await this.snapshot();
    return [...snapshot.clients.values()]
      .filter((client) => this.#ofThisDeployment(client) && client.status === "active")
      .map((client) => client.id);
  }
}

/** One directory per real `env` object (one per isolate), made the first time it is asked for. */
const directories = new WeakMap<object, ClientDirectory<HostBindings>>();

/**
 * The directory of a many-client host's `env`, or null on a single-client deployment. It takes
 * no options: the deployment's environment is read from `env` itself (`COS_HOST_ENVIRONMENT`),
 * so every caller gets the same directory with the same filter.
 */
export function hostDirectory<E extends HostBindings>(env: E): ClientDirectory<E> | null {
  if (hostMode(env) === "single") return null;
  let directory = directories.get(env) as ClientDirectory<E> | undefined;
  if (!directory) {
    directory = new ClientDirectory(env);
    directories.set(env, directory as unknown as ClientDirectory<HostBindings>);
  }
  return directory;
}

// --- What the entries call (step 4) --------------------------------------------------------

/** A single-client deployment: every request is its one client's, with the real `env`. */
export interface SingleClient<E> {
  mode: "single";
  served: true;
  env: E;
}

/** Which client a request is for, and its environment only when it is served. */
export type RequestClient<E> = SingleClient<E> | ({ mode: "many" } & HostnameAdmission<E>);

/** The environment for a client an entry already knows, only when it is served. */
export type EnvironmentAdmission<E> = SingleClient<E> | ({ mode: "many" } & ClientAdmission<E>);

/**
 * The client a request is for, from its hostname, and that client's environment when it is
 * served. On a single-client deployment the hostname is not read, and `env` is the real one,
 * unchanged. On a many-client host, anything but `served: true` is refused (step 4 answers an
 * unknown hostname's 404, or for `schema-behind` the "being updated" page).
 */
export async function clientForRequest<E extends HostBindings>(
  env: E,
  hostname: string | null | undefined,
): Promise<RequestClient<E>> {
  const directory = hostDirectory(env);
  if (!directory) return { mode: "single", served: true, env };
  return { mode: "many", ...(await directory.clientForHostname(hostname)) };
}

/**
 * The environment for `client`, given by an entry that already knows it (the runner called by the
 * app, a queue message's stamp, a Durable Object's name: step 4). On a single-client deployment
 * there is no client to name: `client` must be null, and the real `env` comes back unchanged. On
 * a many-client host, served only as the directory serves.
 */
export async function environmentFor<E extends HostBindings>(
  env: E,
  client: string | null,
): Promise<EnvironmentAdmission<E>> {
  const directory = hostDirectory(env);
  if (!directory) {
    if (client !== null) {
      throw new Error("A client was named on a single-client deployment, which has no registry");
    }
    return { mode: "single", served: true, env };
  }
  if (client === null) throw new Error("A many-client host needs the client for its environment");
  return { mode: "many", ...(await directory.environmentFor(client)) };
}
