// Building a client's environment (stage 66 step 3, ADR 0613). Internal to packages/db: it is
// not in the package's exports, so no entry can build an environment for a record of its own
// making. Only `ClientDirectory` (client-environment.ts) calls `buildClientEnvironment`, with a
// record it read from the registry and admitted. Tests import this file by its path.
import {
  type ClientObjectNamer,
  clientObjectNamer,
  keepBucketApart,
  keepKeyValueApart,
  keepLoaderApart,
  keepObjectsApart,
  keepQueueApart,
  keepRunnerApart,
  keepVectorsApart,
  keepWorkflowApart,
} from "./client-bindings.ts";
import { type ClientDb, clientDatabaseService } from "./client-db.ts";
import type { ClientDbQueryService } from "./client-db-service.ts";
import { hostPropsKey, PROOF, PROPS_KEY, propsProof } from "./client-proofs.ts";

/** The names a wrapper applies to. */
const named =
  (...names: string[]) =>
  (name: string) =>
    names.includes(name);

import { ENV_NAME_PATTERNS, ENV_NAMES, type EnvNameUse } from "./client-env-names.ts";
import {
  CLIENT_SETTINGS,
  type ClientAddresses,
  type ClientId,
  type ClientRecord,
  isClientId,
} from "./registry.ts";

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
   * The query path of every client's database (stage 66 step 2): a service binding to
   * `cos-client-db`'s `ClientDbQueries`, which serves queries only. What the app and the runner
   * bind on a many-client host; the raw namespace (`CLIENT_DB`) is the operator's (step 7).
   */
  CLIENT_DB_QUERIES?: ClientDbQueryService;
  /**
   * Which environment of its clients this deployment holds (`live` or `staging`). Required with
   * REGISTRY: the one source of the deployment's environment; a client of the other is unknown.
   */
  COS_HOST_ENVIRONMENT?: string;
  /** The root key of every client's derived secrets (ADR 0616). The host's own. */
  COS_ROOT_KEY?: string;
  /** The private key every client's given secrets are sealed to, and the one before (ADR 0616). */
  COS_SECRETS_PRIVATE_KEY?: string;
  COS_SECRETS_PRIVATE_KEY_PREVIOUS?: string;
  /** The deployment's one callback hostname (ADR 0616). The host's own. */
  COS_CALLBACK_HOSTNAME?: string;
  /** The key that names clients' objects (client-proofs.ts). The host's own. */
  COS_BINDING_KEY?: string;
  /** The key props and cos-client-db's calls are signed with, and the one before (#515, S4). */
  COS_PROPS_KEY?: string;
  COS_PROPS_KEY_PREVIOUS?: string;
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
export type BindingWrapper<B = unknown> = (
  binding: B,
  client: ClientId,
  context: WrapperContext,
) => B;

/**
 * What the directory hands a wrapper beside the binding and the client: only what that client's
 * part needs, made for that client (never the host's `env` or a key; #515, S2).
 */
export interface WrapperContext {
  /** Names this client's objects (`keepObjectsApart`). */
  objectNamer: ClientObjectNamer;
}

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
}> = Object.freeze(
  [
    {
      applies: (name: string) => /^[A-Z0-9_]+_RATE_LIMIT$/.test(name),
      wrap: keepRateLimitApart as BindingWrapper,
    },
    // Stage 66 step 4 (client-bindings.ts, ADR 0615).
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
      wrap: ((namespace: DurableObjectNamespace, client: ClientId, context: WrapperContext) =>
        keepObjectsApart(namespace, client, context.objectNamer)) as BindingWrapper,
    },
    { applies: named("RUNNER"), wrap: keepRunnerApart as BindingWrapper },
    // Review of #520, M3: the client in every Worker Loader id.
    { applies: named("LOADER"), wrap: keepLoaderApart as BindingWrapper },
  ].map((entry) => Object.freeze(entry)),
);

/** Whether a kept-apart `name` has a wrapper (packages/db/test/client-bindings.test.ts). */
export function hasBindingWrapper(name: string): boolean {
  return wrapperFor(name) !== null;
}

function wrapperFor(name: string): BindingWrapper | null {
  return BINDING_WRAPPERS.find((wrapper) => wrapper.applies(name))?.wrap ?? null;
}

/** Which client an environment built here is for. Keyed by the environment object itself. */
const clientOfEnvironment = new WeakMap<object, ClientId>();
/** Which of its environments (live, staging) an environment built here is the client's. */
const environmentNameOf = new WeakMap<object, string>();

/**
 * The views of a client's environment an object's base class holds (client-objects.ts), each with
 * how to read the environment it shows now. Registered only by packages/db's own modules: this
 * file is not in the package's exports, and a view resolves only to an environment built here.
 */
const environmentOfView = new WeakMap<object, () => object>();

/** Registers `view` as showing `current()`, an environment built here (client-objects.ts). */
export function registerEnvironmentView(view: object, current: () => object): void {
  environmentOfView.set(view, current);
}

/**
 * The client an environment was built for, or null for a single-client deployment's `env`. A
 * view an object holds answers as the environment it shows (review of #520, M1), and as no
 * client before that is decided or after a refusal.
 */
export function clientOf(env: object): ClientId | null {
  const own = clientOfEnvironment.get(env);
  if (own) return own;
  const current = environmentOfView.get(env);
  if (!current) return null;
  try {
    return clientOfEnvironment.get(current()) ?? null;
  } catch {
    return null;
  }
}

/**
 * The one name a client's environment goes by outside the host, where a client's id alone would
 * be shared by its live and its staging environment: `<environment>:<client>` (review of #522,
 * M2). It is the creator stamped on the client's videos, and what the zone's shared caches (the
 * widget cache, public content) key the client by. The shape is decided here and nowhere else.
 * Null for a single-client deployment's `env`.
 */
export function clientStampOf(env: object): string | null {
  const client = clientOf(env);
  if (!client) return null;
  let own: object | undefined = clientOfEnvironment.has(env) ? env : undefined;
  if (!own) {
    try {
      own = environmentOfView.get(env)?.();
    } catch {
      return null;
    }
  }
  const environment = own ? environmentNameOf.get(own) : undefined;
  if (!environment) return null;
  return `${environment}:${client}`;
}

/**
 * What the client's environment is built from: its registry row and its settings, and (step 6,
 * ADR 0616) its secrets and addresses. `derived` is what `deriveClientSecrets` gave for this
 * client, `given` what `readClientSecrets` opened for it, `addresses` its verified hostnames'
 * addresses from the registry. Each is used only for the names `ENV_NAMES` says it fills; with
 * one left out, those names are left out.
 */
export interface ClientPart {
  client: ClientRecord;
  settings: Readonly<Record<string, string>>;
  derived?: Readonly<Record<string, string>>;
  given?: Readonly<Record<string, string>>;
  /** Derivable secrets a deployment imported as this client brought: they override `derived`. */
  imported?: Readonly<Record<string, string>>;
  addresses?: ClientAddresses;
  /** Its verified sender domains (`RegistrySnapshot.senderDomains`): `COS_SENDER_DOMAINS`. */
  senderDomains?: readonly string[];
}

/** The value of an address name for a client, or undefined when it has no such address. */
function addressValue(
  use: Extract<EnvNameUse, { what: "address" }>,
  addresses: ClientAddresses,
): string | undefined {
  const origin = (hostname: string | null) => (hostname ? `https://${hostname}` : undefined);
  switch (use.from) {
    case "staff": {
      const staff = origin(addresses.staff);
      return staff ? `${staff}${use.path ?? ""}` : undefined;
    }
    case "customer":
      return origin(addresses.web ?? addresses.staff);
    case "desk":
      return addresses.desk ?? undefined;
    case "all":
      return addresses.hostnames.length > 0
        ? addresses.hostnames.map((hostname) => `https://${hostname}`).join(",")
        : undefined;
  }
}

/** Every name, listed or matched, that a part of the client's own may fill. */
function perClientUse(name: string): Extract<EnvNameUse, { use: "per-client" }> | null {
  const use = envNameUse(name);
  return use?.use === "per-client" ? use : null;
}

/**
 * A client's database, the one place it is opened: through `cos-client-db`'s query-only service
 * (`CLIENT_DB_QUERIES`, stage 66 step 2), never the raw namespace, which is the operator's.
 */
function openClientDatabase(env: HostBindings, client: ClientRecord): D1Database {
  const service = env.CLIENT_DB_QUERIES;
  if (!service) {
    throw new Error("No CLIENT_DB_QUERIES binding: a client's database cannot be opened");
  }
  // Each call carries the host's proof of the client in the host's environment, made here with
  // the props key (#515, S1; review of #520, M4): cos-client-db answers a call for a client only
  // with it, so the service binding alone, without the key, opens no client's database, and a
  // staging host's proof opens no live one.
  if (!hostPropsKey(env)) {
    throw new Error(`No ${PROPS_KEY}: a client's database cannot be opened`);
  }
  return clientDatabaseService(service, client.id, {
    ...(client.locationHint ? { locationHint: client.locationHint } : {}),
    proof: propsProof(env, PROOF.clientDb, client.id),
  });
}

/** A value made here for one client (its database, a wrapper's result): frozen. */
function frozen<T>(value: T): T {
  return value !== null && typeof value === "object" ? Object.freeze(value) : value;
}

/**
 * The client's environment on a host that serves many clients: a new, frozen object shaped like
 * `env`, holding only what `envNameUse` lets through.
 *
 * - `DB` is `clientDatabaseService(CLIENT_DB_QUERIES, client)`, at the client's location hint.
 * - Each setting in `CLIENT_SETTINGS` is the client's from the registry; with no row, the
 *   deployment's own value (`inherit`) or nothing (`empty`).
 * - A shared value (`shared`) is the same object as in `env`, so a cache keyed by it (a WeakMap
 *   on `env.LOADER`, `env.AI`, a `GATEKEEPER_*` binding) is one cache for every client.
 * - A kept-apart binding is its wrapper's result, frozen, or left out when it has none.
 * - The client's secrets are its derived and given ones (`part.derived`, `part.given`), and its
 *   addresses come from its verified hostnames (`part.addresses`); the host's own value of such a
 *   name is never used, and with no part for it the name is left out (step 6, ADR 0616).
 * - The host's own names are left out, and so is any name `ENV_NAMES` does not list.
 *
 * The object and what is made here for it (`DB`, the wrappers' results) are frozen: it is shared
 * by every request of the client in the isolate, so a write below an entry throws (modules are
 * strict) instead of reaching the client's next request. Shared values are not frozen: they are
 * the host's own objects.
 */
export function buildClientEnvironment<E extends HostBindings>(env: E, part: ClientPart): E {
  const { client, settings } = part;
  if (!isClientId(client.id)) throw new RangeError("Not a client id");
  const out: Record<string, unknown> = {};
  const context: WrapperContext = Object.freeze({
    objectNamer: clientObjectNamer(env, client.id, client.secretGeneration),
  });
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
          out[name] = frozen(wrap(value, client.id, context));
        }
        break;
      }
      // The settings are filled in below, whether or not `env` has them; the database too.
      case "setting":
      case "database":
      case "host":
      case "per-client":
      case "client":
        break;
    }
  }
  for (const [name, { absent }] of Object.entries(CLIENT_SETTINGS)) {
    const own = Object.hasOwn(settings, name) ? settings[name] : undefined;
    const value =
      own ?? (absent === "inherit" ? (env as unknown as Record<string, unknown>)[name] : undefined);
    if (typeof value === "string") out[name] = value;
  }
  // The client's own secrets: each only into a name `ENV_NAMES` says that kind fills, so a
  // derived name never takes a given value (auth secrets are derived, not stored) and the other
  // way round. Never the host's own value of the name, which is not read here at all.
  // An imported value (a deployment imported as a client brought its own) wins over the derived
  // one for a derivable name, and is taken for no other name.
  for (const [kind, values] of [
    ["derived", part.derived],
    ["derived", part.imported],
    ["given", part.given],
  ] as const) {
    for (const [name, value] of Object.entries(values ?? {})) {
      const use = perClientUse(name);
      if (use?.what === "secret" && use.from === kind && typeof value === "string" && value) {
        out[name] = value;
      }
    }
  }
  // Which client this environment is for, so code below an entry can tell a many-client host
  // (its session cookies are `__Host-` prefixed, ADR 0616) without the registry.
  out.COS_CLIENT_ID = client.id;
  // The client's own addresses, from its verified hostnames: every address name `ENV_NAMES`
  // lists, whether or not the host's env has it.
  if (part.addresses) {
    for (const name of Object.keys(ENV_NAMES)) {
      const use = perClientUse(name);
      if (use?.what !== "address") continue;
      const value = addressValue(use, part.addresses);
      if (value !== undefined) out[name] = value;
    }
  }
  // Its verified sender domains, the only ones its email is sent from; with none the name is left
  // out, and the email-send gatekeeper refuses every send of the client.
  for (const name of Object.keys(ENV_NAMES)) {
    if (perClientUse(name)?.what !== "senders") continue;
    const domains = (part.senderDomains ?? []).filter((d) => typeof d === "string" && d);
    if (domains.length > 0) out[name] = domains.join(",");
  }
  out.DB = frozen(openClientDatabase(env, client));
  Object.freeze(out);
  clientOfEnvironment.set(out, client.id);
  environmentNameOf.set(out, client.environment);
  return out as unknown as E;
}

/**
 * A client's environment with the OAuth library's helpers beside it (stage 66 step 4, ADR 0615).
 * `@cloudflare/workers-oauth-provider` puts its helpers on the `env` it is handed
 * (`env.OAUTH_PROVIDER = ...`) when there are none, which a frozen environment refuses; the app
 * makes them for the client (over the client's own OAUTH_KV) and hands the library this copy:
 * frozen too, the same client, and nothing else added. The helpers reach only what the client's
 * environment already reaches.
 */
export function withOAuthHelpers<E extends object>(env: E, helpers: unknown): E {
  const client = clientOf(env);
  if (!client) throw new Error("Not a client's environment");
  if ("OAUTH_PROVIDER" in env) throw new Error("This environment has OAuth helpers already");
  const out = Object.freeze({ ...env, OAUTH_PROVIDER: helpers });
  clientOfEnvironment.set(out, client);
  const environment = environmentNameOf.get(env);
  if (environment) environmentNameOf.set(out, environment);
  return out as E;
}
