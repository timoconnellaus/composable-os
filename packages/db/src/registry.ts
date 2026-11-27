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
  /**
   * Written once when the client is added (migration 0792), never changed: bound into every
   * derived secret of the client (ADR 0616). Null only for a row the registry has not given one.
   */
  secretGeneration: string | null;
  /**
   * Added as an imported deployment (migration 0793), set once: only such a client's `imported`
   * secrets (its own old derivable secrets) are honoured (ADR 0616).
   */
  imported: boolean;
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

/**
 * A client's one name outside the host, `<environment>:<client>` (review of #522, M2): the creator
 * stamped on its videos and the key of the zone's shared caches. `clientStampOf` gives it for a
 * client's environment; the operator's commands (stage 66 step 7: an import re-stamping a client's
 * videos) give it for a registry row. The shape is decided here only.
 */
export function clientStamp(environment: ClientEnvironmentName | string, client: string): string {
  return `${environment}:${client}`;
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
  // The client's own name for the product (stage 66 step 9, ADR 0618 "The first client's day
  // one"): its staff screens and its mail say it; none, the deployment's label.
  COS_PRODUCT_LABEL: {
    absent: "inherit",
    what: "the product's name as the client's people read it",
  },
  // Who may make the client's first account, and the hash of the one setup link that lets them
  // (`firstAdminValue`): written only by `cos client add --admin` and `cos client first-admin`.
  COS_FIRST_ADMIN: { absent: "empty", what: "the first admin's address and setup link's hash" },
};

export function isClientSetting(name: string): boolean {
  return Object.hasOwn(CLIENT_SETTINGS, name);
}

// --- What the operator may change after `add` (stage 66 step 9, ADR 0618) ------------------------

/** An https origin with nothing after it (`https://www.example.com`), or null. */
function httpsOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    if (url.pathname !== "/" || url.search || url.hash || value.replace(/\/$/, "") !== url.origin) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

/** A list setting's entries, as the host's parsers split it (commas or spaces). */
function entriesOf(value: string): string[] {
  return value
    .split(/[\s,]+/)
    .map((v) => v.trim())
    .filter(Boolean);
}

const PACK_ID = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

/** What is wrong with a label a client's people read, or null. */
export function labelProblem(value: string): string | null {
  if (value !== value.trim()) return "no space before or after";
  if (value.length < 1 || value.length > 60) return "1 to 60 characters";
  // biome-ignore lint/suspicious/noControlCharactersInRegex: refusing them is the point.
  if (/[\u0000-\u001f\u007f<>]/.test(value)) return "no line breaks, control characters, < or >";
  return null;
}

/**
 * Where a setting is checked against: the client's own hostnames (verified or not) and the fleet's
 * registrable domain. A check that needs them refuses what it cannot check without them.
 */
export interface SettingContext {
  ownHostnames?: readonly string[];
  /** The fleet's registrable domain (`fleet.example`): no other client's hostname is under it. */
  fleetDomain?: string | null;
}

const isUnderDomain = (host: string, domain: string) =>
  host === domain || host.endsWith(`.${domain}`);

/** A native app's sign-in redirect's one shape: `<scheme>://staff-sign-in` (client-repo.ts). */
const APP_REDIRECT = /^([a-z][a-z0-9+.-]{1,40}):\/\/staff-sign-in$/;
/** The command-line tools' loopback sign-in (`cos … import`, ADR 0470): any port is allowed. */
const LOOPBACK_REDIRECTS = ["http://127.0.0.1/cos-sign-in", "http://[::1]/cos-sign-in"];
const NOT_APP_SCHEMES = new Set([
  "http",
  "https",
  "javascript",
  "data",
  "file",
  "blob",
  "about",
  "vbscript",
  "ftp",
  "ws",
  "wss",
  "mailto",
]);

/**
 * The settings the operator writes for a client, at `cos client add` and with `cos client
 * setting`, each with its check (null: the value is good). Every other client setting is refused
 * with the reason `NOT_OPERATOR_SETTINGS` gives: the deployment's value applies, or its own
 * command writes it. `setClientSetting` (registry-writes) holds the same list where the write is.
 * A changed setting is served within the registry's refresh (`REGISTRY_REFRESH_MS`, 10 seconds).
 */
export const OPERATOR_SETTINGS: Readonly<
  Record<string, { check: (value: string, context: SettingContext) => string | null; what: string }>
> = {
  COS_PACKS: {
    what: "the packs the client has, an explicit comma-separated list of pack ids, only ever wider",
    check: (value) => {
      // Always an explicit list: "*" (the release product's packs) is never a client's, and ""
      // is none (stage 66: every fleet client's packs are named).
      if (value.trim() === "*") return "an explicit list of pack ids, never *";
      if (value.trim() === "") return null;
      const ids = value.split(",").map((v) => v.trim());
      if (ids.some((id) => !PACK_ID.test(id))) {
        return "an explicit comma-separated list of pack ids (ticketing,content), or empty for none";
      }
      if (new Set(ids).size !== ids.length) return "a pack is named twice";
      return null;
    },
  },
  API_ALLOWED_ORIGINS: {
    what: "the origins of the client's own sites and apps that may call its API",
    check: (value, context) => {
      const entries = entriesOf(value);
      if (entries.length === 0 || entries.length > 20) return "1 to 20 https origins";
      for (const entry of entries) {
        const origin = httpsOrigin(entry);
        if (!origin) return `${entry} is not an https origin with nothing after it`;
        // Under the fleet's own domain only the client's own hostname: a sibling there is another
        // client's or the fleet's (stage 66 step 8, ADR 0619).
        const host = new URL(origin).hostname;
        if (
          context.fleetDomain &&
          isUnderDomain(host, context.fleetDomain) &&
          !(context.ownHostnames ?? []).includes(host)
        ) {
          return `${entry} is under the fleet's domain and is not this client's hostname`;
        }
      }
      return null;
    },
  },
  NATIVE_REDIRECT_URIS: {
    what: "the client's native app's sign-in redirects",
    check: (value, context) => {
      const entries = entriesOf(value);
      if (entries.length === 0 || entries.length > 20) return "1 to 20 redirect addresses";
      for (const entry of entries) {
        if (LOOPBACK_REDIRECTS.includes(entry)) continue;
        const app = APP_REDIRECT.exec(entry);
        if (app) {
          if (NOT_APP_SCHEMES.has(app[1] as string)) return `${entry} is not an app's scheme`;
          continue;
        }
        let url: URL;
        try {
          url = new URL(entry);
        } catch {
          return `${entry} is not an address`;
        }
        // An https redirect only on one of the client's own hostnames.
        if (
          url.protocol === "https:" &&
          !url.username &&
          !url.password &&
          !url.hash &&
          (context.ownHostnames ?? []).includes(url.hostname)
        ) {
          continue;
        }
        return `${entry}: a redirect is <scheme>://staff-sign-in (the client's app), http://127.0.0.1/cos-sign-in (cos's own), or https on the client's own hostname`;
      }
      return null;
    },
  },
  APPROVAL_EXPIRY_DAYS: {
    what: "days before a pending action expires",
    check: (value) =>
      /^\d{1,2}$/.test(value) && Number(value) >= 1 && Number(value) <= 90 ? null : "1 to 90",
  },
  COS_PRODUCT_LABEL: {
    what: "the product's name as the client's people read it (its mail and staff screens)",
    check: labelProblem,
  },
};

/** Why each other client setting is not written by the operator's settings. */
export const NOT_OPERATOR_SETTINGS: Readonly<Record<string, string>> = {
  APPROVAL_FLOOR:
    "the approval floor is policy: a client has the deployment's; a floor per client is a reviewed change of its own (a floor that does not parse stops every request of the client)",
  IDENTITY_PROVIDER:
    "the identity provider decides who every staff account is: a client has the deployment's",
  AUTH_ALLOW_SIGNUP:
    "open staff sign-up lets anyone who finds the client's staff hostname make an account: never on a fleet",
  COS_ORG_EXTENSIONS:
    "the hash of the client's own extensions is written by its repository's deploy",
  AI_MODEL_ROLES:
    "AI on a fleet is the fleet's choice at its first install (per-client AI waits for usage)",
  AI_PROVIDERS:
    "AI on a fleet is the fleet's choice at its first install (per-client AI waits for usage)",
  COS_FIRST_ADMIN: "written by cos client add --admin and cos client first-admin",
};

/** What is wrong with the operator setting `name` to `value` for a client, or null. */
export function operatorSettingProblem(
  name: string,
  value: string | null,
  context: SettingContext = {},
): string | null {
  const setting = Object.hasOwn(OPERATOR_SETTINGS, name) ? OPERATOR_SETTINGS[name] : undefined;
  if (!setting) {
    const why = Object.hasOwn(NOT_OPERATOR_SETTINGS, name) ? NOT_OPERATOR_SETTINGS[name] : null;
    return why
      ? `${name} is not set this way: ${why}`
      : `${name} is not a client setting (${Object.keys(OPERATOR_SETTINGS).join(", ")})`;
  }
  if (value === null) return null;
  const problem = setting.check(value, context);
  return problem ? `${name}: ${problem}` : null;
}

// --- The first admin (stage 66 step 9, ADR 0618 "The first client's day one") --------------------

/**
 * Who may make a client's first account on a host of many clients: one address, and the SHA-256
 * of the one setup link's token (the token itself is printed once to the operator and stored
 * nowhere), until it expires. The host refuses every other first account.
 */
export interface FirstAdmin {
  /** Lowercase. */
  email: string;
  /** The token's SHA-256, 64 lowercase hex characters. */
  sha256: string;
  /** An ISO timestamp. */
  expires: string;
}

/** How long a setup link works. */
export const FIRST_ADMIN_LINK_HOURS = 72;

/** The fragment of a setup link (`/sign-in#first-admin=<token>`): never sent to any server. */
export const FIRST_ADMIN_FRAGMENT = "first-admin";

const EMAIL = /^[^\s@,;<>"]{1,64}@[a-z0-9-]+(\.[a-z0-9-]+)+$/;

/** An address as the first admin's, lowercase, or null when it is not one. */
export function firstAdminEmail(value: string): string | null {
  const email = value.trim().toLowerCase();
  return email.length <= 254 && EMAIL.test(email) ? email : null;
}

/** The registry value of `COS_FIRST_ADMIN`. */
export function firstAdminValue(admin: FirstAdmin): string {
  return JSON.stringify({ email: admin.email, sha256: admin.sha256, expires: admin.expires });
}

/** `COS_FIRST_ADMIN` read back, or null when absent or not exactly its shape (fails closed). */
export function parseFirstAdmin(value: string | null | undefined): FirstAdmin | null {
  if (typeof value !== "string" || !value) return null;
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    const { email, sha256, expires } = parsed;
    if (typeof email !== "string" || firstAdminEmail(email) !== email) return null;
    if (typeof sha256 !== "string" || !/^[0-9a-f]{64}$/.test(sha256)) return null;
    if (typeof expires !== "string" || Number.isNaN(Date.parse(expires))) return null;
    return { email, sha256, expires };
  } catch {
    return null;
  }
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
   * Each client's verified sender domains (migration 0796), sorted: the only domains its email
   * is sent from on a host of many clients. A client with none has no entry.
   */
  senderDomains: ReadonlyMap<ClientId, readonly string[]>;
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
  secret_generation: string | null;
  imported: number;
}

/**
 * The whole registry in one batch of five statements, whatever the number of clients: no
 * statement binds a parameter or joins a compound SELECT, so D1's limits (100 bound parameters,
 * 5 terms a compound SELECT, 1,000 statements an invocation) hold with any number. A batch is one
 * transaction, so the stamp is the stamp of the rows read with it. A row the code would not
 * accept is left out and named in `problems`.
 */
export async function readRegistry(registry: D1Database): Promise<RegistrySnapshot> {
  const [meta, clients, settings, hostnames, senders] = await registry.batch([
    registry.prepare(STAMP_SQL),
    registry.prepare(
      "SELECT id, environment, status, tier, repository, location_hint, schema_version, secret_generation, imported FROM registry_clients",
    ),
    registry.prepare("SELECT client, name, value FROM registry_settings"),
    registry.prepare(
      "SELECT hostname, client, surface, verified, is_primary FROM registry_hostnames",
    ),
    registry.prepare("SELECT domain, client, verified FROM registry_sender_domains"),
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
      secretGeneration:
        typeof row.secret_generation === "string" && /^[0-9a-f]{32}$/.test(row.secret_generation)
          ? row.secret_generation
          : null,
      imported: Number(row.imported) === 1,
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
    senderDomains: readSenderDomains(
      (senders?.results ?? []) as SenderDomainRow[],
      clientMap,
      problems,
    ),
    problems,
  };
}

// --- Sender domains ------------------------------------------------------------------------

interface SenderDomainRow {
  domain: string;
  client: string;
  verified: number;
}

/**
 * A sender domain as the registry holds them (a hostname's shape, at least two labels), or null.
 * The operator's command writes only what this accepts (`registry-senders.ts`).
 */
export function canonicalSenderDomain(domain: string | null | undefined): string | null {
  const name = canonicalHostname(domain);
  if (!name || name !== String(domain).trim().toLowerCase()) return null;
  return name.includes(".") ? name : null;
}

/** Whether one of two domains is the other or under it. */
export function sameDomainTree(a: string, b: string): boolean {
  return a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`);
}

/**
 * Each client's verified sender domains. The registry's own rules (migration 0796: one client a
 * domain, no domain under or over another client's) are held here again, failing closed: a row
 * that breaks them is left out for both clients and named in `problems`, so no client sends from
 * a domain another may also claim.
 */
function readSenderDomains(
  rows: SenderDomainRow[],
  clients: ReadonlyMap<ClientId, ClientRecord>,
  problems: string[],
): ReadonlyMap<ClientId, readonly string[]> {
  const rowsKept: { domain: string; client: ClientId; verified: boolean }[] = [];
  for (const row of rows) {
    if (!isClientId(row.client) || !clients.has(row.client)) continue;
    if (canonicalSenderDomain(row.domain) !== row.domain) {
      problems.push(
        `sender domain ${JSON.stringify(row.domain)} of ${row.client} left out: not canonical`,
      );
      continue;
    }
    rowsKept.push({ domain: row.domain, client: row.client, verified: Number(row.verified) === 1 });
  }
  const shared = new Set<string>();
  for (const one of rowsKept) {
    for (const other of rowsKept) {
      if (one.client !== other.client && sameDomainTree(one.domain, other.domain)) {
        shared.add(one.domain);
      }
    }
  }
  const out = new Map<ClientId, string[]>();
  for (const { domain, client, verified } of rowsKept) {
    if (shared.has(domain)) {
      problems.push(
        `sender domain ${domain} of ${client} left out: another client holds a domain of its tree`,
      );
      continue;
    }
    if (!verified) continue;
    const list = out.get(client) ?? [];
    list.push(domain);
    out.set(client, list);
  }
  for (const list of out.values()) list.sort();
  return out;
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
