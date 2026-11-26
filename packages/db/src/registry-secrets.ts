// A client's secrets on a host that serves many clients (stage 66 step 6, ADR 0616; the owner's
// decision 8). Two kinds, and nothing else:
//
// - **Derived:** every secret the host signs or encrypts with for itself (the staff and customer
//   auth secrets, and so the practitioner key and the person-code keys derived from them, and the
//   desk secret) is derived per client from the root key, `COS_ROOT_KEY`, which only the host's
//   environment holds. HKDF-SHA-256, with an info string that names the scheme's version, the
//   deployment's environment, the purpose and the client. Never stored anywhere.
// - **Given:** a secret a client supplies and the host cannot derive (its own sign-in provider,
//   its Turnstile widget, its judge and AI keys) is stored in `registry_secrets`, sealed with
//   AES-256-GCM under a key derived from `COS_SECRETS_KEY`, which only the host's environment
//   holds: a fresh 12-byte nonce per value, and the scheme's version, the environment, the client,
//   the name and the key's id bound in as associated data, so a ciphertext moved to another
//   client, name, environment or key does not open.
//
// Only the operator writes given secrets (`writeClientSecret`, called by `cos client secret set`,
// stage 66 step 7). The host only reads them, in one place: the client directory, as it builds
// that client's environment (client-environment.ts). No operation, route, tool, extension or
// assistant reaches this module: packages/core and the packs never name it
// (packages/core/test/registry-unreachable.test.ts covers `@composable-os/db/registry*`), and a
// client's environment holds neither key.
//
// Nothing here logs a value or puts one in an error: an error names the client and the secret's
// name, never what it holds.
//
// A single-client deployment never reads this module: it keeps its Worker secrets as today.
import { type ClientEnvironmentName, type ClientId, validateClientId } from "./registry.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });

// --- The host's two keys ---------------------------------------------------------------------

/** The root key every derived secret comes from: the host's own, never in a client's env. */
export const ROOT_KEY_VAR = "COS_ROOT_KEY";
/** The key given secrets are sealed under: the host's own, never in a client's env. */
export const SECRETS_KEY_VAR = "COS_SECRETS_KEY";
/** The previous secrets key, while the operator re-seals every row after a rotation. */
export const SECRETS_KEY_PREVIOUS_VAR = "COS_SECRETS_KEY_PREVIOUS";

/** What this module reads of a many-client host's `env`. */
export interface HostKeys {
  COS_ROOT_KEY?: string;
  COS_SECRETS_KEY?: string;
  COS_SECRETS_KEY_PREVIOUS?: string;
}

/** Each key is 32 random bytes, written as base64url without padding (43 characters). */
export const HOST_KEY_BYTES = 32;

/** A new key for `COS_ROOT_KEY` or `COS_SECRETS_KEY` (the deploy engine's, stage 66 step 7). */
export function newHostKey(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(HOST_KEY_BYTES)));
}

/** The key's bytes, or an error naming the variable (never the value). */
function hostKeyBytes(text: string, name: string): Uint8Array<ArrayBuffer> {
  const bytes = /^[A-Za-z0-9_-]{43}$/.test(text) ? fromBase64url(text) : null;
  if (!bytes || bytes.length !== HOST_KEY_BYTES) {
    throw new Error(`${name} is not ${HOST_KEY_BYTES} bytes written as base64url (43 characters)`);
  }
  return bytes;
}

// --- Derived secrets -------------------------------------------------------------------------

/**
 * The secrets derived per client, by the env name each fills, with the purpose and version bound
 * into the derivation. Bumping a version changes that secret for every client (see ADR 0616,
 * "Rotation"); the purposes never change. Every name here is `per-client` and `derived` in
 * `ENV_NAMES`.
 */
export const DERIVED_SECRETS: Readonly<Record<string, { purpose: string; version: number }>> =
  Object.freeze({
    // Signs staff sessions (better-auth); the person-code keys are derived from it (ADR 0783).
    BETTER_AUTH_SECRET: { purpose: "staff-auth", version: 1 },
    // Signs customer sessions; the practitioner key is derived from it (ADR 0581).
    CUSTOMER_AUTH_SECRET: { purpose: "customer-auth", version: 1 },
    // HMACs every desk enrolment code, device credential, session code and token (ADR 0780).
    DESK_SECRET: { purpose: "desk", version: 1 },
  });

/** HKDF's salt: fixed, public, the scheme's own (RFC 5869 allows a constant salt). */
const DERIVATION_SALT = encoder.encode("cos/client-secret/salt/v1");

/**
 * The info string of one derived secret. Every part is from a closed alphabet (`[a-z0-9-]`), so
 * `/` separates them unambiguously and no two (environment, purpose, client, version) give the
 * same string.
 */
export function derivationInfo(
  environment: ClientEnvironmentName,
  purpose: string,
  version: number,
  client: ClientId,
): string {
  if (!/^[a-z][a-z-]*$/.test(purpose)) throw new RangeError("Not a purpose");
  if (!Number.isInteger(version) || version < 1) throw new RangeError("Not a version");
  return `cos/client-secret/v${version}/${environment}/${purpose}/${client}`;
}

/** The root key as imported, once per isolate (kept as the key: a promise is one request's). */
let importedRoot: { text: string; key: CryptoKey } | null = null;

/** The root key as a non-extractable HKDF key. */
async function rootKey(text: string): Promise<CryptoKey> {
  if (importedRoot?.text === text) return importedRoot.key;
  const bytes = hostKeyBytes(text, ROOT_KEY_VAR);
  const key = await crypto.subtle.importKey("raw", bytes, "HKDF", false, ["deriveBits"]);
  // One deployment has one root key; another (a test's) replaces it.
  importedRoot = { text, key };
  return key;
}

/** One derived secret: 32 bytes from HKDF-SHA-256, as 64 hex characters. */
export async function deriveClientSecret(
  root: string,
  environment: ClientEnvironmentName,
  client: ClientId,
  name: string,
): Promise<string> {
  const spec = Object.hasOwn(DERIVED_SECRETS, name) ? DERIVED_SECRETS[name] : undefined;
  if (!spec) throw new RangeError(`${name} is not a derived secret`);
  const info = derivationInfo(environment, spec.purpose, spec.version, validateClientId(client));
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: DERIVATION_SALT, info: encoder.encode(info) },
    await rootKey(root),
    256,
  );
  return hex(new Uint8Array(bits));
}

/** Every derived secret of a client, by env name. */
export async function deriveClientSecrets(
  root: string,
  environment: ClientEnvironmentName,
  client: ClientId,
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const name of Object.keys(DERIVED_SECRETS)) {
    out[name] = await deriveClientSecret(root, environment, client, name);
  }
  return out;
}

// --- Given secrets ---------------------------------------------------------------------------

/**
 * The names a client's given secret may have: each is `per-client` and `given` in `ENV_NAMES`
 * (or matches `AI_KEY_*`). A derived name is never one: auth secrets are derived, not stored.
 */
export const GIVEN_SECRET_NAMES: ReadonlySet<string> = new Set([
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "CF_ACCESS_TEAM_DOMAIN",
  "CF_ACCESS_AUD",
  "TYPESAFE_API_KEY",
  "TURNSTILE_SITE_KEY",
  "TURNSTILE_SECRET_KEY",
]);

/** The client's own AI provider keys (ADR 0151). */
export const GIVEN_SECRET_PATTERN = /^AI_KEY_[A-Z0-9_]{1,32}$/;

export function isGivenSecretName(name: unknown): name is string {
  return (
    typeof name === "string" && (GIVEN_SECRET_NAMES.has(name) || GIVEN_SECRET_PATTERN.test(name))
  );
}

/** The longest given secret, in bytes once UTF-8 (a JSON key file fits; a mistake does not). */
export const GIVEN_SECRET_MAX_BYTES = 16 * 1024;

interface SealingKey {
  id: string;
  key: CryptoKey;
}

/** The keys given secrets are sealed and opened with: the current one, and the one before. */
export interface SecretsKeyring {
  readonly current: SealingKey;
  readonly previous: SealingKey | null;
}

/**
 * A sealing key from a `COS_SECRETS_KEY` value: the AES-256-GCM key and the key's public id are
 * each derived from it with HKDF under their own info, so neither is the raw key and the id says
 * nothing of the key.
 */
async function sealingKey(text: string, name: string): Promise<SealingKey> {
  const base = await crypto.subtle.importKey("raw", hostKeyBytes(text, name), "HKDF", false, [
    "deriveKey",
    "deriveBits",
  ]);
  const hkdf = (info: string) => ({
    name: "HKDF",
    hash: "SHA-256",
    salt: new Uint8Array(32),
    info: encoder.encode(info),
  });
  const key = await crypto.subtle.deriveKey(
    hkdf("cos/registry-secrets/aes-256-gcm/v1"),
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
  const id = await crypto.subtle.deriveBits(hkdf("cos/registry-secrets/key-id/v1"), base, 64);
  return { id: `k1-${hex(new Uint8Array(id))}`, key };
}

/** The keyring of a `COS_SECRETS_KEY` value, and of the previous one during a rotation. */
export async function secretsKeyring(current: string, previous?: string): Promise<SecretsKeyring> {
  return Object.freeze({
    current: await sealingKey(current, SECRETS_KEY_VAR),
    previous: previous ? await sealingKey(previous, SECRETS_KEY_PREVIOUS_VAR) : null,
  });
}

/** The keyring of a many-client host's `env`, or null when `COS_SECRETS_KEY` is not set. */
export async function secretsKeyringOf(env: HostKeys): Promise<SecretsKeyring | null> {
  if (!env.COS_SECRETS_KEY) return null;
  return secretsKeyring(env.COS_SECRETS_KEY, env.COS_SECRETS_KEY_PREVIOUS || undefined);
}

/** Where a sealed value belongs: what is bound into it as associated data. */
export interface SecretPlace {
  environment: ClientEnvironmentName;
  client: ClientId;
  name: string;
}

/** A sealed value, as `registry_secrets` holds it. */
export interface SealedSecret {
  /** The AES-GCM ciphertext with its 16-byte tag. */
  ciphertext: Uint8Array<ArrayBuffer>;
  /** The 12-byte nonce, fresh for every value. */
  iv: Uint8Array<ArrayBuffer>;
  /** Which key sealed it (`SecretsKeyring.current.id` at the time). */
  keyId: string;
}

/**
 * The associated data of a sealed value: the scheme's version, the environment, the client, the
 * name and the key's id. Every part is from a closed alphabet without `/`.
 */
export function associatedData(place: SecretPlace, keyId: string): Uint8Array<ArrayBuffer> {
  validateClientId(place.client);
  if (!isGivenSecretName(place.name)) throw new RangeError(`${place.name} is not a given secret`);
  if (!/^k1-[0-9a-f]{16}$/.test(keyId)) throw new RangeError("Not a key id");
  return new Uint8Array(
    encoder.encode(
      `cos/registry-secret/v1/${place.environment}/${place.client}/${place.name}/${keyId}`,
    ),
  );
}

/** Seals one given secret under the current key. */
export async function sealClientSecret(
  keyring: SecretsKeyring,
  place: SecretPlace,
  value: string,
): Promise<SealedSecret> {
  if (typeof value !== "string" || value.length === 0) {
    throw new RangeError(`The value of ${place.name} for ${place.client} is empty`);
  }
  const plain = encoder.encode(value);
  if (plain.length > GIVEN_SECRET_MAX_BYTES) {
    throw new RangeError(
      `The value of ${place.name} for ${place.client} is over ${GIVEN_SECRET_MAX_BYTES} bytes`,
    );
  }
  const { id, key } = keyring.current;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: associatedData(place, id), tagLength: 128 },
    key,
    plain,
  );
  return { ciphertext: new Uint8Array(ciphertext), iv, keyId: id };
}

/** A sealed value that did not open. Its message names the client and the name, never a value. */
export class SecretUnreadable extends Error {
  constructor(place: SecretPlace, why: string) {
    super(`The ${place.name} secret of ${place.client} cannot be read: ${why}`);
    this.name = "SecretUnreadable";
  }
}

/** Opens one given secret with the key that sealed it, checking where it belongs. */
export async function openClientSecret(
  keyring: SecretsKeyring,
  place: SecretPlace,
  sealed: SealedSecret,
): Promise<string> {
  const key = [keyring.current, keyring.previous].find((k) => k?.id === sealed.keyId);
  if (!key) throw new SecretUnreadable(place, "sealed under a key this host does not hold");
  if (sealed.iv.length !== 12) throw new SecretUnreadable(place, "its nonce is not 12 bytes");
  let plain: ArrayBuffer;
  try {
    plain = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: sealed.iv,
        additionalData: associatedData(place, key.id),
        tagLength: 128,
      },
      key.key,
      sealed.ciphertext,
    );
  } catch {
    // WebCrypto's own error says only that it failed; it is not passed on in any case.
    throw new SecretUnreadable(place, "it does not open here (another client, name or key)");
  }
  try {
    return decoder.decode(plain);
  } catch {
    throw new SecretUnreadable(place, "it is not text");
  }
}

// --- The registry's rows ---------------------------------------------------------------------

/** Bytes as D1 or ClientDb return a BLOB (an ArrayBuffer, a view or an array of 0-255). */
function bytesOf(value: unknown): Uint8Array<ArrayBuffer> | null {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return Uint8Array.from(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
  }
  if (Array.isArray(value) && value.every((b) => Number.isInteger(b) && b >= 0 && b <= 255)) {
    return Uint8Array.from(value as number[]);
  }
  return null;
}

/**
 * Writes (or replaces) one given secret of a client: sealed here, so the registry only ever holds
 * the ciphertext. The operator's command calls it (`cos client secret set`, stage 66 step 7);
 * nothing in a host's Worker does. The client must be in the registry (its row's foreign key).
 */
export async function writeClientSecret(
  registry: D1Database,
  keyring: SecretsKeyring,
  place: SecretPlace,
  value: string,
): Promise<{ keyId: string }> {
  const sealed = await sealClientSecret(keyring, place, value);
  await registry
    .prepare(
      `INSERT INTO registry_secrets (client, name, ciphertext, iv, key_id) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (client, name) DO UPDATE SET ciphertext = excluded.ciphertext,
         iv = excluded.iv, key_id = excluded.key_id, updated_at = CURRENT_TIMESTAMP`,
    )
    .bind(place.client, place.name, sealed.ciphertext, sealed.iv, sealed.keyId)
    .run();
  return { keyId: sealed.keyId };
}

/** Removes one given secret of a client (`cos client secret remove`, stage 66 step 7). */
export async function removeClientSecret(
  registry: D1Database,
  client: ClientId,
  name: string,
): Promise<void> {
  await registry
    .prepare("DELETE FROM registry_secrets WHERE client = ? AND name = ?")
    .bind(validateClientId(client), name)
    .run();
}

/** A client's given secrets, opened, and a line for each row left out (names only). */
export interface OpenedSecrets {
  values: Record<string, string>;
  problems: string[];
}

/**
 * Reads and opens every given secret of one client. The client directory calls it while it
 * builds that client's environment, and only then; what it returns goes into that environment and
 * nowhere else. A row it cannot open (no key, another key, moved from another client or name,
 * tampered with), or with a name that is not a given secret's, is left out and named in
 * `problems`, never with its value.
 */
export async function readClientSecrets(
  registry: D1Database,
  keyring: SecretsKeyring | null,
  environment: ClientEnvironmentName,
  client: ClientId,
): Promise<OpenedSecrets> {
  const { results } = await registry
    .prepare("SELECT name, ciphertext, iv, key_id FROM registry_secrets WHERE client = ?")
    .bind(validateClientId(client))
    .all<{ name: string; ciphertext: unknown; iv: unknown; key_id: string }>();
  const values: Record<string, string> = {};
  const problems: string[] = [];
  for (const row of results) {
    if (!isGivenSecretName(row.name)) {
      problems.push(`secret ${row.name} of ${client} left out: not a given secret's name`);
      continue;
    }
    const place: SecretPlace = { environment, client, name: row.name };
    if (!keyring) {
      problems.push(`secret ${row.name} of ${client} left out: ${SECRETS_KEY_VAR} is not set`);
      continue;
    }
    const ciphertext = bytesOf(row.ciphertext);
    const iv = bytesOf(row.iv);
    if (!ciphertext || !iv) {
      problems.push(`secret ${row.name} of ${client} left out: its row is not bytes`);
      continue;
    }
    try {
      values[row.name] = await openClientSecret(keyring, place, {
        ciphertext,
        iv,
        keyId: String(row.key_id),
      });
    } catch (error) {
      problems.push(
        `secret ${row.name} of ${client} left out: ${error instanceof SecretUnreadable ? error.message : "it does not open"}`,
      );
    }
  }
  return { values, problems };
}

// --- Encoding --------------------------------------------------------------------------------

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function base64url(bytes: Uint8Array): string {
  let text = "";
  for (const b of bytes) text += String.fromCharCode(b);
  return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64url(text: string): Uint8Array<ArrayBuffer> | null {
  try {
    const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
    return Uint8Array.from(binary, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}
