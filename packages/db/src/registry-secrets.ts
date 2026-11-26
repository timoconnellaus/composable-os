// A client's secrets on a host that serves many clients: the host's side (stage 66 step 6, ADR
// 0616; the owner's decision 8). Internal to packages/db: not in the package's exports.
//
// - **Derived:** every secret the host signs or encrypts with for itself (`DERIVED_SECRETS`: the
//   staff and customer auth secrets, and so the person-code and practitioner keys derived from
//   them, the desk secret, the support cookie's key and the client-address key) is derived per
//   client from the root key, `COS_ROOT_KEY`, which only the host's environment holds:
//   HKDF-SHA-256, with an info that names the scheme's version, the environment, the purpose, the
//   client and the client's secret generation (written once when it was added). Never stored,
//   except as an imported override (below).
// - **Given:** a secret a client supplies is sealed to the host's public key by the operator's
//   command (registry-sealing.ts) and opened here, with `COS_SECRETS_PRIVATE_KEY`, only while the
//   directory builds that client's environment (`readClientSecrets`).
// - **Imported:** a deployment imported as a client brings its own derivable secrets, stored
//   sealed as `imported` rows; for that client each overrides derivation.
//
// The host's operator-only paths (stage 66 step 7 adds the way the operator reaches them; there
// is no route yet) are `exportClientSecrets` (a client's derived and given secrets, opened, for it
// to leave with) and `resealClientSecrets` (every row moved to the current key after a rotation).
// Nothing here logs a value or puts one in an error: an error names the client and the secret's
// name, never what it holds. A single-client deployment never reads this module.
import {
  type ClientEnvironmentName,
  type ClientId,
  type ClientRecord,
  validateClientId,
} from "./registry.ts";
import {
  hex,
  hostKeyBytes,
  hostKeyPair,
  SEALING_SUITE,
  type SealingPublicKey,
} from "./registry-hpke.ts";
import {
  DERIVED_SECRETS,
  isDerivedSecretName,
  isGivenSecretName,
  placeBytes,
  ROOT_KEY_VAR,
  SECRETS_PRIVATE_KEY_PREVIOUS_VAR,
  SECRETS_PRIVATE_KEY_VAR,
  type SealedSecret,
  type SecretKind,
  type SecretPlace,
  sealClientSecret,
} from "./registry-sealing.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });

/** What this module reads of a many-client host's `env`. */
export interface HostKeys {
  COS_ROOT_KEY?: string;
  COS_SECRETS_PRIVATE_KEY?: string;
  COS_SECRETS_PRIVATE_KEY_PREVIOUS?: string;
}

// --- Derived secrets ---------------------------------------------------------------------------

/** HKDF's salt: fixed, public, the scheme's own (RFC 5869 allows a constant salt). */
const DERIVATION_SALT = encoder.encode("cos/client-secret/salt/v1");

/**
 * The info string of one derived secret. Every part is from a closed alphabet (`[a-z0-9-]`), so
 * `/` separates them unambiguously and no two (version, environment, purpose, client, generation)
 * give the same string.
 */
export function derivationInfo(
  environment: ClientEnvironmentName,
  purpose: string,
  version: number,
  client: ClientId,
  generation: string,
): string {
  if (!/^[a-z][a-z-]*$/.test(purpose)) throw new RangeError("Not a purpose");
  if (!Number.isInteger(version) || version < 1) throw new RangeError("Not a version");
  if (!/^[0-9a-f]{32}$/.test(generation)) throw new RangeError("Not a secret generation");
  return `cos/client-secret/v${version}/${environment}/${purpose}/${client}/${generation}`;
}

/** The root key as imported, once per isolate (kept as the key: a promise is one request's). */
let importedRoot: { text: string; key: CryptoKey } | null = null;

async function rootKey(text: string): Promise<CryptoKey> {
  if (importedRoot?.text === text) return importedRoot.key;
  const bytes = hostKeyBytes(text, ROOT_KEY_VAR);
  const key = await crypto.subtle.importKey("raw", bytes, "HKDF", false, ["deriveBits"]);
  importedRoot = { text, key };
  return key;
}

/** Which client, environment and generation a derivation is for. */
export interface DerivationFor {
  environment: ClientEnvironmentName;
  client: ClientId;
  generation: string;
}

/** One derived secret: 32 bytes from HKDF-SHA-256, as 64 hex characters. */
export async function deriveClientSecret(
  root: string,
  of: DerivationFor,
  name: string,
): Promise<string> {
  const spec = isDerivedSecretName(name) ? DERIVED_SECRETS[name] : undefined;
  if (!spec) throw new RangeError(`${name} is not a derived secret`);
  const info = derivationInfo(
    of.environment,
    spec.purpose,
    spec.version,
    validateClientId(of.client),
    of.generation,
  );
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
  of: DerivationFor,
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const name of Object.keys(DERIVED_SECRETS)) {
    out[name] = await deriveClientSecret(root, of, name);
  }
  return out;
}

// --- Opening -----------------------------------------------------------------------------------

interface OpeningKey {
  id: string;
  privateKey: CryptoKey;
}

/** The host's keys for opening: the current private key, the one before, and the public key. */
export interface OpeningKeyring {
  readonly current: OpeningKey;
  readonly previous: OpeningKey | null;
  /** The current public key: what a re-seal seals to. */
  readonly publicKey: SealingPublicKey;
}

/** The keyring of a private key's text, and of the previous one during a rotation. */
export async function openingKeyring(current: string, previous?: string): Promise<OpeningKeyring> {
  const now = await hostKeyPair(current, SECRETS_PRIVATE_KEY_VAR);
  const before = previous ? await hostKeyPair(previous, SECRETS_PRIVATE_KEY_PREVIOUS_VAR) : null;
  return Object.freeze({
    current: { id: now.publicKey.id, privateKey: now.privateKey },
    previous: before ? { id: before.publicKey.id, privateKey: before.privateKey } : null,
    publicKey: now.publicKey,
  });
}

/** The keyring of a many-client host's `env`, or null when it holds no secrets private key. */
export async function openingKeyringOf(env: HostKeys): Promise<OpeningKeyring | null> {
  if (!env.COS_SECRETS_PRIVATE_KEY) return null;
  return openingKeyring(
    env.COS_SECRETS_PRIVATE_KEY,
    env.COS_SECRETS_PRIVATE_KEY_PREVIOUS || undefined,
  );
}

/** A sealed value that did not open. Its message names the client and the name, never a value. */
export class SecretUnreadable extends Error {
  constructor(place: SecretPlace, why: string) {
    super(`The ${place.name} secret of ${place.client} cannot be read: ${why}`);
    this.name = "SecretUnreadable";
  }
}

/** Opens one sealed value with the private key it was sealed to, checking where it belongs. */
export async function openClientSecret(
  keyring: OpeningKeyring,
  place: SecretPlace,
  sealed: SealedSecret,
): Promise<string> {
  const key = [keyring.current, keyring.previous].find((k) => k?.id === sealed.keyId);
  if (!key) throw new SecretUnreadable(place, "sealed to a key this host does not hold");
  let plain: ArrayBuffer;
  try {
    const bound = placeBytes(place, key.id);
    plain = await SEALING_SUITE.open(
      { recipientKey: key.privateKey, enc: sealed.enc.buffer, info: bound.buffer },
      sealed.ciphertext.buffer,
      bound.buffer,
    );
  } catch {
    // The library's own error says only that it failed; it is not passed on in any case.
    throw new SecretUnreadable(place, "it does not open here (another client, name, kind or key)");
  }
  try {
    return decoder.decode(plain);
  } catch {
    throw new SecretUnreadable(place, "it is not text");
  }
}

// --- The registry's rows -----------------------------------------------------------------------

/** Bytes as D1 or ClientDb return a BLOB (an ArrayBuffer, a view or an array of 0-255). */
function bytesOf(value: unknown): Uint8Array<ArrayBuffer> | null {
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  if (ArrayBuffer.isView(value)) {
    return Uint8Array.from(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
  }
  if (Array.isArray(value) && value.every((b) => Number.isInteger(b) && b >= 0 && b <= 255)) {
    return Uint8Array.from(value as number[]);
  }
  return null;
}

interface SecretRow {
  name: string;
  kind: string;
  enc: unknown;
  ciphertext: unknown;
  key_id: string;
}

/** A client's stored secrets, opened: given ones, imported overrides, and a line per row left out. */
export interface OpenedSecrets {
  given: Record<string, string>;
  imported: Record<string, string>;
  problems: string[];
}

/**
 * Reads and opens every stored secret of one client. The client directory calls it while it
 * builds that client's environment, and only then; what it returns goes into that environment and
 * nowhere else. A row it cannot open (no key, another key, moved from another client, name or
 * kind, tampered with), or whose name does not fit its kind, is left out and named in
 * `problems`, never with its value. An `imported` row is honoured only for a client added as
 * imported (`importedClient`, migration 0793): for any other it is left out and named, so an
 * auth secret cannot be pinned on an existing client by writing a row.
 */
export async function readClientSecrets(
  registry: D1Database,
  keyring: OpeningKeyring | null,
  environment: ClientEnvironmentName,
  client: ClientId,
  importedClient = false,
): Promise<OpenedSecrets> {
  const { results } = await registry
    .prepare("SELECT name, kind, enc, ciphertext, key_id FROM registry_secrets WHERE client = ?")
    .bind(validateClientId(client))
    .all<SecretRow>();
  const out: OpenedSecrets = { given: {}, imported: {}, problems: [] };
  for (const row of results) {
    const left = (why: string) =>
      out.problems.push(`secret ${row.name} of ${client} left out: ${why}`);
    const kind = row.kind as SecretKind;
    const fits =
      (kind === "given" && isGivenSecretName(row.name)) ||
      (kind === "imported" && isDerivedSecretName(row.name));
    if (!fits) {
      left(`not a ${kind === "imported" ? "derivable" : "given"} secret's name`);
      continue;
    }
    if (kind === "imported" && !importedClient) {
      left("an imported secret of a client not added as imported");
      continue;
    }
    if (!keyring) {
      left(`${SECRETS_PRIVATE_KEY_VAR} is not set`);
      continue;
    }
    const enc = bytesOf(row.enc);
    const ciphertext = bytesOf(row.ciphertext);
    if (!enc || !ciphertext) {
      left("its row is not bytes");
      continue;
    }
    try {
      const value = await openClientSecret(
        keyring,
        { environment, client, name: row.name, kind },
        { enc, ciphertext, keyId: String(row.key_id) },
      );
      (kind === "imported" ? out.imported : out.given)[row.name] = value;
    } catch (error) {
      left(error instanceof SecretUnreadable ? error.message : "it does not open");
    }
  }
  return out;
}

/**
 * The client's own secrets on its way out (the leaving promise, `cos client export`, stage 66
 * step 7): its derived secrets (an imported override where it has one), so its own install keeps
 * them as its Worker secrets and nobody is signed out, cards and PINs keep working and desk
 * devices stay enrolled; and its given secrets. Opened on the host, for the operator only: the
 * operator's way to call it (an operator-only path on the host) is step 7's, and nothing else
 * calls it. A row that does not open is named in `problems`.
 */
export async function exportClientSecrets(
  env: HostKeys & { REGISTRY: D1Database },
  client: Pick<ClientRecord, "id" | "environment" | "secretGeneration" | "imported">,
): Promise<{ derived: Record<string, string>; given: Record<string, string>; problems: string[] }> {
  const opened = await readClientSecrets(
    env.REGISTRY,
    await openingKeyringOf(env),
    client.environment,
    client.id,
    client.imported,
  );
  const derived: Record<string, string> = {};
  if (env.COS_ROOT_KEY && client.secretGeneration) {
    Object.assign(
      derived,
      await deriveClientSecrets(env.COS_ROOT_KEY, {
        environment: client.environment,
        client: client.id,
        generation: client.secretGeneration,
      }),
    );
  } else {
    opened.problems.push(`${client.id}: no derived secret (no root key or no secret generation)`);
  }
  return {
    derived: { ...derived, ...opened.imported },
    given: opened.given,
    problems: opened.problems,
  };
}

/**
 * Re-seals every stored secret of a client to the current public key, after a rotation (the
 * previous private key in `COS_SECRETS_PRIVATE_KEY_PREVIOUS`). Runs on the host, operator-only
 * (stage 66 step 7 adds the way to call it). Rows already under the current key are left as they
 * are; a row that does not open is left and named.
 */
export async function resealClientSecrets(
  registry: D1Database,
  keyring: OpeningKeyring,
  environment: ClientEnvironmentName,
  client: ClientId,
): Promise<{ resealed: number; problems: string[] }> {
  const { results } = await registry
    .prepare("SELECT name, kind, enc, ciphertext, key_id FROM registry_secrets WHERE client = ?")
    .bind(validateClientId(client))
    .all<SecretRow>();
  let resealed = 0;
  const problems: string[] = [];
  for (const row of results) {
    if (row.key_id === keyring.current.id) continue;
    const kind = row.kind as SecretKind;
    const place: SecretPlace = { environment, client, name: row.name, kind };
    const enc = bytesOf(row.enc);
    const ciphertext = bytesOf(row.ciphertext);
    try {
      if (!enc || !ciphertext) throw new SecretUnreadable(place, "its row is not bytes");
      const value = await openClientSecret(keyring, place, {
        enc,
        ciphertext,
        keyId: String(row.key_id),
      });
      const sealed = await sealClientSecret(keyring.publicKey, place, value);
      await registry
        .prepare(
          "UPDATE registry_secrets SET enc = ?, ciphertext = ?, key_id = ?, updated_at = CURRENT_TIMESTAMP WHERE client = ? AND name = ? AND key_id = ?",
        )
        .bind(sealed.enc, sealed.ciphertext, sealed.keyId, client, row.name, row.key_id)
        .run();
      resealed += 1;
    } catch (error) {
      problems.push(
        `secret ${row.name} of ${client} not re-sealed: ${error instanceof SecretUnreadable ? error.message : "it does not open"}`,
      );
    }
  }
  return { resealed, problems };
}
