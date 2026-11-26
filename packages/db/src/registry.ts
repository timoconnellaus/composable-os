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
export const CLIENT_ENVIRONMENTS: readonly ClientEnvironmentName[] = ["live", "staging"];
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
  /** Marked as its surface's address (migration 0791); only a verified hostname is one. */
  primary: boolean;
}

/**
 * A client's addresses, from its verified hostnames only (stage 66 step 6, ADR 0616): each
 * surface's marked hostname, or its only verified one; null when it has none, or several and none
 * marked. Never from a request's Host header.
 */
export interface ClientAddresses {
  staff: string | null;
  web: string | null;
  desk: string | null;
  /** Every verified hostname of the client, sorted. */
  hostnames: readonly string[];
}

// --- Client ids ----------------------------------------------------------------------------

/** The shortest and longest client id. */
export const CLIENT_ID_LENGTH = { min: 3, max: 30 } as const;

/**
 * Words no client may be called. A client id becomes a Durable Object name, the first label of
 * its hostnames on the fleet's domain and a key prefix, so it must not stand for the host, a
 * surface, an environment or a name the platform uses, nor for a label the fleet's own domain is
 * likely to need (gatekeeper callbacks and webhooks, sign-in, files and media, billing). Step 8
 * checks the labels it picks against this list.
 */
export const RESERVED_CLIENT_IDS: ReadonlySet<string> = new Set([
  "account",
  "accounts",
  "admin",
  "api",
  "app",
  "apps",
  "assets",
  "auth",
  "billing",
  "callback",
  "callbacks",
  "cdn",
  "client",
  "clients",
  "composable",
  "composableos",
  "connect",
  "control",
  "cos",
  "customer",
  "dashboard",
  "default",
  "desk",
  "dev",
  "docs",
  "download",
  "downloads",
  "email",
  "files",
  "fleet",
  "front",
  "help",
  "host",
  "images",
  "img",
  "internal",
  "link",
  "links",
  "live",
  "localhost",
  "login",
  "logout",
  "mail",
  "mcp",
  "media",
  "null",
  "oauth",
  "oidc",
  "operator",
  "pay",
  "payments",
  "platform",
  "portal",
  "preview",
  "public",
  "registry",
  "root",
  "runner",
  "saml",
  "share",
  "signin",
  "signup",
  "smtp",
  "sso",
  "staff",
  "staging",
  "static",
  "status",
  "store",
  "stream",
  "support",
  "system",
  "test",
  "undefined",
  "upload",
  "uploads",
  "video",
  "videos",
  "web",
  "webhook",
  "webhooks",
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
 * a Host header (or a URL's hostname), chosen by whoever sent the request: lowercased and one
 * trailing dot removed, and refused unless it is a plain DNS name of ASCII labels. Refused: any
 * port (pass `new URL(request.url).hostname`, which has none); anything numeric-looking (a last
 * label of digits only, as in `127.0.0.1`, `127.1` or `0x7f.1`, since no top-level domain is
 * numeric, or a single label in hex, as in `0x7f000001`); a bracketed or bare IPv6 literal; an
 * empty or over-long label; a character outside `a-z0-9.-` (a non-ASCII name arrives as punycode
 * or not at all); more than 253 characters. The result is looked up exactly; nothing here
 * derives a client from it.
 */
export function canonicalHostname(host: string | null | undefined): string | null {
  if (typeof host !== "string") return null;
  let name = host.trim().toLowerCase();
  if (name.endsWith(".")) name = name.slice(0, -1);
  if (name.length === 0 || name.length > 253) return null;
  const labels = name.split(".");
  if (!labels.every((label) => LABEL.test(label))) return null;
  // An address, not a name: no client is reached by one.
  if (/^\d+$/.test(labels.at(-1) as string)) return null;
  if (labels.length === 1 && /^0x[0-9a-f]+$/.test(name)) return null;
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
  // An address that is not a hostname (stage 66 step 6, ADR 0616): the client's own native app's
  // sign-in redirects (`<scheme>://staff-sign-in`), never another client's.
  NATIVE_REDIRECT_URIS: { absent: "empty", what: "the client's native app's sign-in redirects" },
};

export function isClientSetting(name: string): boolean {
  return Object.hasOwn(CLIENT_SETTINGS, name);
}

// --- Reading the registry ------------------------------------------------------------------

/** Every client of the registry, as one consistent read. */
export interface RegistrySnapshot {
  /** The registry's change counter when this was read. */
  version: number;
  /**
   * The registry's stamp: the counter and a random value every change writes (`<n>:<nonce>`).
   * After a restore the counter can come back with other rows; the nonce does not, so a stamp
   * that is equal means rows that are equal.
   */
  stamp: string;
  clients: ReadonlyMap<ClientId, ClientRecord>;
  /** Each client's settings that are in `CLIENT_SETTINGS`, by name. */
  settings: ReadonlyMap<ClientId, Readonly<Record<string, string>>>;
  /** Verified hostnames, by hostname. */
  hostnames: ReadonlyMap<string, HostnameRecord>;
  /** Hostnames the registry holds but has not verified: refused as such, never served. */
  unverified: ReadonlySet<string>;
  /** Each client's addresses, from its verified hostnames (`ClientAddresses`). */
  addresses: ReadonlyMap<ClientId, ClientAddresses>;
  /**
   * Rows the code would not accept and so left out, one line each, for the operator: an id
   * `validateClientId` refuses, a setting not in `CLIENT_SETTINGS`, a hostname that is not
   * canonical. A host logs them once per stamp; `cos` (step 7) shows them.
   */
  problems: readonly string[];
}

const STAMP_SQL = "SELECT value, nonce FROM registry_meta WHERE key = 'version'";

const NO_STAMP = "The registry has no version stamp: its migrations have not run";

function stampOf(row: { value: number; nonce: string } | null | undefined): {
  version: number;
  stamp: string;
} {
  if (!row) throw new Error(NO_STAMP);
  return { version: Number(row.value), stamp: `${Number(row.value)}:${row.nonce}` };
}

/** The registry's change counter: one row read. */
export async function readRegistryVersion(registry: D1Database): Promise<number> {
  return stampOf(await registry.prepare(STAMP_SQL).first()).version;
}

/** The registry's stamp (`RegistrySnapshot.stamp`): one row read. */
export async function readRegistryStamp(registry: D1Database): Promise<string> {
  return stampOf(await registry.prepare(STAMP_SQL).first()).stamp;
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
 * accept is left out and named in `problems`.
 */
export async function readRegistry(registry: D1Database): Promise<RegistrySnapshot> {
  const [meta, clients, settings, hostnames] = await registry.batch([
    registry.prepare(STAMP_SQL),
    registry.prepare(
      "SELECT id, environment, status, tier, repository, location_hint, schema_version FROM registry_clients",
    ),
    registry.prepare("SELECT client, name, value FROM registry_settings"),
    registry.prepare(
      "SELECT hostname, client, surface, verified, is_primary FROM registry_hostnames",
    ),
  ]);
  const { version, stamp } = stampOf(
    meta?.results[0] as { value: number; nonce: string } | undefined,
  );
  const problems: string[] = [];

  const clientMap = new Map<ClientId, ClientRecord>();
  for (const row of (clients?.results ?? []) as unknown as ClientRow[]) {
    const problem = clientIdProblem(row.id);
    if (problem) {
      problems.push(`client ${JSON.stringify(row.id)} left out: ${problem}`);
      continue;
    }
    const id = row.id as ClientId;
    clientMap.set(id, {
      id,
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
    if (!isClientSetting(row.name)) {
      problems.push(`setting ${row.name} of ${row.client} left out: not a client setting`);
      continue;
    }
    const own = settingMap.get(row.client) ?? {};
    own[row.name] = String(row.value);
    settingMap.set(row.client, own);
  }

  const hostnameMap = new Map<string, HostnameRecord>();
  const unverified = new Set<string>();
  for (const row of (hostnames?.results ?? []) as {
    hostname: string;
    client: string;
    surface: string;
    verified: number;
    is_primary: number;
  }[]) {
    if (!isClientId(row.client) || !clientMap.has(row.client)) continue;
    if (canonicalHostname(row.hostname) !== row.hostname) {
      problems.push(
        `hostname ${JSON.stringify(row.hostname)} of ${row.client} left out: not canonical`,
      );
      continue;
    }
    if (Number(row.verified) !== 1) {
      unverified.add(row.hostname);
      continue;
    }
    hostnameMap.set(row.hostname, {
      hostname: row.hostname,
      client: row.client,
      surface: row.surface as HostnameSurface,
      primary: Number(row.is_primary) === 1,
    });
  }

  const byClient = new Map<ClientId, HostnameRecord[]>();
  for (const record of hostnameMap.values()) {
    const list = byClient.get(record.client) ?? [];
    list.push(record);
    byClient.set(record.client, list);
  }
  const addressMap = new Map<ClientId, ClientAddresses>();
  for (const id of clientMap.keys()) {
    const own = byClient.get(id) ?? [];
    const pick = (surface: HostnameSurface): string | null => {
      const on = own.filter((h) => h.surface === surface);
      const marked = on.find((h) => h.primary);
      if (marked) return marked.hostname;
      if (on.length === 1) return (on[0] as HostnameRecord).hostname;
      if (on.length > 1) {
        problems.push(
          `${id} has ${on.length} verified ${surface} hostnames and none marked as its address: no ${surface} address`,
        );
      }
      return null;
    };
    addressMap.set(id, {
      staff: pick("staff"),
      web: pick("web"),
      desk: pick("desk"),
      hostnames: own.map((h) => h.hostname).sort(),
    });
  }

  return {
    version,
    stamp,
    clients: clientMap,
    settings: settingMap,
    hostnames: hostnameMap,
    unverified,
    addresses: addressMap,
    problems,
  };
}

// --- A client whose schema is behind -------------------------------------------------------

/**
 * Whether a client's database is behind the code: its schema version as the registry last
 * recorded it is lower than the version this code expects, or was never recorded (the client
 * has not been migrated). The directory refuses such a client (`refused: "schema-behind"`); the
 * entries answer with a "being updated" page (step 4). A database ahead of the code is not
 * behind: during an update every client is migrated before the new Workers are uploaded, and the
 * old code goes on serving it.
 */
export function isSchemaBehind(
  client: Pick<ClientRecord, "schemaVersion">,
  codeVersion: number = CORE_SCHEMA_VERSION,
): boolean {
  return client.schemaVersion === null || client.schemaVersion < codeVersion;
}
