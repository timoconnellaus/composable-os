// The registry of a host that serves many clients (stage 66 step 3, ADR 0613): the host's own D1
// database (the REGISTRY binding) of its clients, their hostnames, settings and secrets. Its
// migrations are `registry-migrations/`, beside the host's. This module reads it; only the
// operator writes it, through `cos` (stage 66 step 7).
//
// It is exported as `@composable-os/db/registry` and never from `@composable-os/db`, and nothing
// in packages/core imports it (packages/core/test/registry-unreachable.test.ts): no operation,
// extension, tool or assistant reaches the registry.
import { CORE_SCHEMA_VERSION } from "./migrate.ts";

/** The registry's own bookkeeping table for its migrations (`applyMigrations(..., { table })`). */
export const REGISTRY_MIGRATIONS_TABLE = "registry_migrations";

declare const clientIdBrand: unique symbol;
/** A client's id, once checked by `validateClientId`. */
export type ClientId = string & { readonly [clientIdBrand]: true };

export type ClientStatus = "active" | "paused" | "moving";
export type ClientTier = "standard" | "bespoke";
/** Which of a client's environments a deployment holds (staging is a second deployment). */
export type ClientEnvironmentName = "live" | "staging";
/** What a hostname serves: the staff app, the client's web app, or its desk. */
export type HostnameSurface = "staff" | "web" | "desk";

/** A client's row in the registry. */
export interface ClientRecord {
  id: ClientId;
  environment: ClientEnvironmentName;
  status: ClientStatus;
  tier: ClientTier;
  /** The repository that may deploy the client (`owner/name`), or null. */
  repository: string | null;
  /** Where the client's database is created the first time it is reached. */
  locationHint: DurableObjectLocationHint | null;
  /** The client database's schema version as the operator's update last saw it. */
  schemaVersion: number | null;
}

export interface HostnameRecord {
  hostname: string;
  client: ClientId;
  surface: HostnameSurface;
}

// --- Client ids ----------------------------------------------------------------------------

/** The shortest and longest client id. */
export const CLIENT_ID_LENGTH = { min: 3, max: 30 } as const;

/**
 * Words no client may be called. A client id becomes a Durable Object name, the first label of
 * its hostnames on the fleet's domain and a key prefix, so it must not stand for the host, a
 * surface, an environment or a name the platform uses.
 */
export const RESERVED_CLIENT_IDS: ReadonlySet<string> = new Set([
  "admin",
  "api",
  "app",
  "apps",
  "assets",
  "auth",
  "cdn",
  "client",
  "clients",
  "composable",
  "composableos",
  "control",
  "cos",
  "customer",
  "default",
  "desk",
  "dev",
  "docs",
  "email",
  "fleet",
  "front",
  "help",
  "host",
  "internal",
  "live",
  "localhost",
  "mail",
  "mcp",
  "null",
  "oauth",
  "operator",
  "platform",
  "preview",
  "public",
  "registry",
  "root",
  "runner",
  "smtp",
  "staff",
  "staging",
  "static",
  "status",
  "support",
  "system",
  "test",
  "undefined",
  "web",
  "www",
]);

/**
 * Endings no client id may have: the fleet's hostnames add them to an id (`gym-a-admin`), so a
 * client called `gym-a-admin` would claim another's staff hostname.
 */
export const RESERVED_CLIENT_ID_SUFFIXES = ["-admin", "-desk", "-staff", "-staging", "-web"];

/** Beginnings no client id may have: the platform's Workers and punycode labels. */
export const RESERVED_CLIENT_ID_PREFIXES = ["cos-", "xn-"];

const CLIENT_ID_SHAPE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

/** Why `id` cannot be a client id, or null when it can. */
export function clientIdProblem(id: unknown): string | null {
  if (typeof id !== "string") return "a client id is a string";
  if (id.length < CLIENT_ID_LENGTH.min || id.length > CLIENT_ID_LENGTH.max) {
    return `a client id is ${CLIENT_ID_LENGTH.min} to ${CLIENT_ID_LENGTH.max} characters`;
  }
  if (!CLIENT_ID_SHAPE.test(id)) {
    return "a client id is lowercase letters, digits and single hyphens, starting with a letter";
  }
  if (RESERVED_CLIENT_IDS.has(id)) return `"${id}" is reserved`;
  for (const prefix of RESERVED_CLIENT_ID_PREFIXES) {
    if (id.startsWith(prefix)) return `a client id may not start with "${prefix}"`;
  }
  for (const suffix of RESERVED_CLIENT_ID_SUFFIXES) {
    if (id.endsWith(suffix)) return `a client id may not end with "${suffix}"`;
  }
  return null;
}

export function isClientId(id: unknown): id is ClientId {
  return clientIdProblem(id) === null;
}

/** `id` as a client id, or an error saying why it is not one. */
export function validateClientId(id: unknown): ClientId {
  const problem = clientIdProblem(id);
  if (problem) throw new RangeError(`Not a client id: ${problem}`);
  return id as ClientId;
}

// --- Hostnames -----------------------------------------------------------------------------

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * A request's hostname as the registry holds hostnames, or null when it is not a hostname. From
 * a Host header (or a URL's host), chosen by whoever sent the request: lowercased, the port and
 * one trailing dot removed, and refused unless it is a plain DNS name of ASCII labels. An IP
 * address, a bracketed IPv6 literal, an empty label, a character outside `a-z0-9.-` (a non-ASCII
 * name arrives as punycode or not at all) or more than 253 characters is not one. The result is
 * looked up exactly; nothing here derives a client from it.
 */
export function canonicalHostname(host: string | null | undefined): string | null {
  if (typeof host !== "string") return null;
  let name = host.trim().toLowerCase();
  const port = /:(\d{1,5})$/.exec(name);
  if (port) name = name.slice(0, port.index);
  if (name.endsWith(".")) name = name.slice(0, -1);
  if (name.length === 0 || name.length > 253) return null;
  const labels = name.split(".");
  if (!labels.every((label) => LABEL.test(label))) return null;
  // A dotted quad is an address, not a name: no client is reached by one.
  if (labels.length === 4 && labels.every((label) => /^\d+$/.test(label))) return null;
  return name;
}

// --- Settings ------------------------------------------------------------------------------

/** What a client with no row for a setting gets. */
export type SettingAbsent =
  /** The deployment's own value: the product's default, set when the host was deployed. */
  | "inherit"
  /** Nothing: the setting is only ever the client's own. */
  | "empty";

/**
 * The deploy-time settings a client has in the registry, by the env name each stands for. These
 * are the names of today's `env` that are policy, what is installed and AI choices (stage 66,
 * "The registry"); the registry is the deploy-time setting, per client, so the rules on them
 * stand: only the operator sets them, and an operation can never loosen them.
 */
export const CLIENT_SETTINGS: Readonly<Record<string, { absent: SettingAbsent; what: string }>> = {
  APPROVAL_FLOOR: { absent: "inherit", what: "the approval floor" },
  APPROVAL_EXPIRY_DAYS: { absent: "inherit", what: "days before a pending action expires" },
  IDENTITY_PROVIDER: { absent: "inherit", what: "the identity provider" },
  AUTH_ALLOW_SIGNUP: { absent: "inherit", what: "whether staff may sign up" },
  COS_PACKS: { absent: "inherit", what: "the product's packs, or a subset" },
  COS_ORG_EXTENSIONS: { absent: "empty", what: "the hash of the client's own extensions" },
  AI_MODEL_ROLES: { absent: "inherit", what: "the model roles" },
  AI_PROVIDERS: { absent: "inherit", what: "the optional AI providers" },
  API_ALLOWED_ORIGINS: { absent: "empty", what: "the origins allowed to call the API" },
};

export function isClientSetting(name: string): boolean {
  return Object.hasOwn(CLIENT_SETTINGS, name);
}

// --- Reading the registry ------------------------------------------------------------------

/** Every client of the registry, as one consistent read. */
export interface RegistrySnapshot {
  /** The registry's version stamp when this was read. */
  version: number;
  clients: ReadonlyMap<ClientId, ClientRecord>;
  /** Each client's settings that are in `CLIENT_SETTINGS`, by name. */
  settings: ReadonlyMap<ClientId, Readonly<Record<string, string>>>;
  /** Verified hostnames only, by hostname. */
  hostnames: ReadonlyMap<string, HostnameRecord>;
}

const VERSION_SQL = "SELECT value FROM registry_meta WHERE key = 'version'";

/** The registry's version stamp: one row read. */
export async function readRegistryVersion(registry: D1Database): Promise<number> {
  const row = await registry.prepare(VERSION_SQL).first<{ value: number }>();
  if (!row) throw new Error("The registry has no version stamp: its migrations have not run");
  return Number(row.value);
}

interface ClientRow {
  id: string;
  environment: string;
  status: string;
  tier: string;
  repository: string | null;
  location_hint: string | null;
  schema_version: number | null;
}

/**
 * The whole registry in one batch of four statements, whatever the number of clients: no
 * statement binds a parameter or joins a compound SELECT, so D1's limits (100 bound parameters,
 * 5 terms a compound SELECT, 1,000 statements an invocation) hold with any number. A batch is one
 * transaction, so the stamp is the stamp of the rows read with it. A row the code would not
 * accept (an id `validateClientId` refuses, a setting not in `CLIENT_SETTINGS`, a hostname that
 * is not canonical, one of a client not on this registry) is left out.
 */
export async function readRegistry(registry: D1Database): Promise<RegistrySnapshot> {
  const [version, clients, settings, hostnames] = await registry.batch([
    registry.prepare(VERSION_SQL),
    registry.prepare(
      "SELECT id, environment, status, tier, repository, location_hint, schema_version FROM registry_clients",
    ),
    registry.prepare("SELECT client, name, value FROM registry_settings"),
    registry.prepare("SELECT hostname, client, surface FROM registry_hostnames WHERE verified = 1"),
  ]);
  const stamp = (version?.results[0] as { value: number } | undefined)?.value;
  if (stamp === undefined) {
    throw new Error("The registry has no version stamp: its migrations have not run");
  }

  const clientMap = new Map<ClientId, ClientRecord>();
  for (const row of (clients?.results ?? []) as unknown as ClientRow[]) {
    if (!isClientId(row.id)) continue;
    clientMap.set(row.id, {
      id: row.id,
      environment: row.environment as ClientEnvironmentName,
      status: row.status as ClientStatus,
      tier: row.tier as ClientTier,
      repository: row.repository,
      locationHint: row.location_hint as DurableObjectLocationHint | null,
      schemaVersion: row.schema_version === null ? null : Number(row.schema_version),
    });
  }

  const settingMap = new Map<ClientId, Record<string, string>>();
  for (const row of (settings?.results ?? []) as {
    client: string;
    name: string;
    value: string;
  }[]) {
    if (!isClientId(row.client) || !clientMap.has(row.client)) continue;
    if (!isClientSetting(row.name)) continue;
    const own = settingMap.get(row.client) ?? {};
    own[row.name] = String(row.value);
    settingMap.set(row.client, own);
  }

  const hostnameMap = new Map<string, HostnameRecord>();
  for (const row of (hostnames?.results ?? []) as {
    hostname: string;
    client: string;
    surface: string;
  }[]) {
    if (!isClientId(row.client) || !clientMap.has(row.client)) continue;
    if (canonicalHostname(row.hostname) !== row.hostname) continue;
    hostnameMap.set(row.hostname, {
      hostname: row.hostname,
      client: row.client,
      surface: row.surface as HostnameSurface,
    });
  }

  return {
    version: Number(stamp),
    clients: clientMap,
    settings: settingMap,
    hostnames: hostnameMap,
  };
}

// --- A client whose schema is behind -------------------------------------------------------

/**
 * Whether a client's database is behind the code: its schema version as the registry last
 * recorded it is lower than the version this code expects, or was never recorded (the client
 * has not been migrated). The host refuses such a client's requests with a "being updated" page
 * (stage 66, "Adding, updating and removing"; the refusal is at the entries, step 4). A database
 * ahead of the code is not behind: during an update every client is migrated before the new
 * Workers are uploaded, and the old code goes on serving it.
 */
export function isSchemaBehind(
  client: Pick<ClientRecord, "schemaVersion">,
  codeVersion: number = CORE_SCHEMA_VERSION,
): boolean {
  return client.schemaVersion === null || client.schemaVersion < codeVersion;
}
