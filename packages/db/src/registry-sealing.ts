// Sealing a client's given secrets to the host (stage 66 step 6, ADR 0616; the owner's decision
// 8: "under a key only the host's environment holds").
//
// HPKE (RFC 9180), base mode, with DHKEM(X25519, HKDF-SHA256), HKDF-SHA256 and AES-256-GCM, through
// `@hpke/core` (WebCrypto underneath; nothing of HPKE is written here). The host's environment
// holds the private key (`COS_SECRETS_PRIVATE_KEY`); the operator's command holds only the public
// key, so it can seal (and so overwrite) a value but never open one. Each value is sealed with a
// fresh encapsulation, and its place (the scheme's version, its kind, the environment, the client,
// the name and the key's id) is HPKE's `info` and the AEAD's associated data, so a sealed value
// moved to another client, name, environment, kind or key does not open.
//
// This module is the operator's side and is exported as `@composable-os/db/registry-sealing`: it
// can seal and write, never read. Opening is the host's alone (registry-secrets.ts, not exported).
// packages/core and the packs never name it (`registry-unreachable`), nor do the app's and the
// runner's sources (`secrets-unreachable`). Nothing here logs a value or puts one in an error.
import { Aes256Gcm, CipherSuite, DhkemX25519HkdfSha256, HkdfSha256 } from "@hpke/core";
import { type ClientEnvironmentName, type ClientId, validateClientId } from "./registry.ts";

const encoder = new TextEncoder();

/** The suite every given secret is sealed with. */
export const SEALING_SUITE = new CipherSuite({
  kem: new DhkemX25519HkdfSha256(),
  kdf: new HkdfSha256(),
  aead: new Aes256Gcm(),
});

// --- Keys --------------------------------------------------------------------------------------

/** The root key every derived secret comes from: the host's own, never in a client's env. */
export const ROOT_KEY_VAR = "COS_ROOT_KEY";
/** The private key given secrets are sealed to: the host's own, never in a client's env. */
export const SECRETS_PRIVATE_KEY_VAR = "COS_SECRETS_PRIVATE_KEY";
/** The private key before a rotation, while the host re-seals every row to the new one. */
export const SECRETS_PRIVATE_KEY_PREVIOUS_VAR = "COS_SECRETS_PRIVATE_KEY_PREVIOUS";

/** Each key is 32 bytes, written as canonical base64url without padding (43 characters). */
export const HOST_KEY_BYTES = 32;

/**
 * A key's bytes, or an error naming the variable (never the value). Refused: anything but 43
 * base64url characters; a text that is not the canonical encoding of its bytes (its last
 * character carries 2 bits no key has, so two texts would name one key); a key of fewer than 16
 * distinct byte values (all zeros, a repeated pattern: never 32 random bytes).
 */
export function hostKeyBytes(text: string, name: string): Uint8Array<ArrayBuffer> {
  const bad = () =>
    new Error(`${name} is not ${HOST_KEY_BYTES} random bytes written as base64url (43 characters)`);
  if (typeof text !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(text)) throw bad();
  const bytes = fromBase64url(text);
  if (!bytes || bytes.length !== HOST_KEY_BYTES || base64url(bytes) !== text) throw bad();
  if (new Set(bytes).size < 16) throw bad();
  return bytes;
}

/** The public key a private key's text stands for: HPKE's DeriveKeyPair from its 32 bytes. */
async function keyPairOf(text: string, name: string): Promise<CryptoKeyPair> {
  return SEALING_SUITE.kem.deriveKeyPair(hostKeyBytes(text, name).buffer);
}

/** The id of a public key: `k2-` and the first 8 bytes of its SHA-256, in hex. */
async function keyIdOf(raw: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", raw));
  return `k2-${hex(digest.subarray(0, 8))}`;
}

/** What the operator's command holds: the host's public key, and its id. */
export interface SealingPublicKey {
  readonly id: string;
  readonly key: CryptoKey;
  /** The key as text (43 characters of base64url), to show or store. */
  readonly text: string;
}

/** The host's public key from its text (the deploy engine prints it; the operator keeps it). */
export async function sealingPublicKey(text: string): Promise<SealingPublicKey> {
  const raw = hostKeyBytes(text, "The secrets public key");
  const key = await SEALING_SUITE.kem.deserializePublicKey(raw.buffer);
  return Object.freeze({ id: await keyIdOf(raw), key, text });
}

/** The public key of a private key's text, as the operator's command will hold it. */
export async function publicKeyOf(privateText: string): Promise<SealingPublicKey> {
  const pair = await keyPairOf(privateText, SECRETS_PRIVATE_KEY_VAR);
  const raw = new Uint8Array(await SEALING_SUITE.kem.serializePublicKey(pair.publicKey));
  return sealingPublicKey(base64url(raw));
}

/** A private key's text as its key pair and public key (the host's side builds its keyring on it). */
export async function hostKeyPair(
  privateText: string,
  name: string,
): Promise<{ privateKey: CryptoKey; publicKey: SealingPublicKey }> {
  const pair = await keyPairOf(privateText, name);
  const raw = new Uint8Array(await SEALING_SUITE.kem.serializePublicKey(pair.publicKey));
  return { privateKey: pair.privateKey, publicKey: await sealingPublicKey(base64url(raw)) };
}

/**
 * New keys for a deployment (the deploy engine's, stage 66 step 7): the root key and the secrets
 * private key, each 32 random bytes, for the host's environment only, and the public key the
 * operator keeps. The private keys pass through the machine that makes them once, as any Worker
 * secret does; nothing else ever needs them.
 */
export async function newHostKeys(): Promise<{
  rootKey: string;
  secretsPrivateKey: string;
  secretsPublicKey: string;
}> {
  const make = () => {
    for (;;) {
      const text = base64url(crypto.getRandomValues(new Uint8Array(HOST_KEY_BYTES)));
      try {
        hostKeyBytes(text, "a new key");
        return text;
      } catch {
        // Fewer than 16 distinct bytes in 32 random ones: astronomically rare; draw again.
      }
    }
  };
  const rootKey = make();
  const secretsPrivateKey = make();
  const secretsPublicKey = (await publicKeyOf(secretsPrivateKey)).text;
  return { rootKey, secretsPrivateKey, secretsPublicKey };
}

// --- Names -------------------------------------------------------------------------------------

/**
 * The secrets derived per client, by the env name each fills, with the purpose and version bound
 * into the derivation (registry-secrets.ts). Every name here is `per-client` and `derived` in
 * `ENV_NAMES`. Only the import path (`writeImportedSecret`) may store one of these names.
 */
export const DERIVED_SECRETS: Readonly<Record<string, { purpose: string; version: number }>> =
  Object.freeze({
    // Signs staff sessions (better-auth); the person-code keys are derived from it (ADR 0783).
    BETTER_AUTH_SECRET: { purpose: "staff-auth", version: 1 },
    // Signs customer sessions; the practitioner key is derived from it (ADR 0581).
    CUSTOMER_AUTH_SECRET: { purpose: "customer-auth", version: 1 },
    // HMACs every desk enrolment code, device credential, session code and token (ADR 0780).
    DESK_SECRET: { purpose: "desk", version: 1 },
    // MACs the support cookie (ADR 0212): on a many-client host not the staff secret.
    SUPPORT_COOKIE_SECRET: { purpose: "support-cookie", version: 1 },
    // Keys the HMAC of a client address for rate limits (ADR 0940): not the staff secret either.
    CLIENT_ADDRESS_SECRET: { purpose: "client-address", version: 1 },
  });

export function isDerivedSecretName(name: unknown): name is string {
  return typeof name === "string" && Object.hasOwn(DERIVED_SECRETS, name);
}

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

/** How a row came to be: a given secret, or a derivable one imported with a deployment. */
export type SecretKind = "given" | "imported";

/** The longest value, in bytes once UTF-8 (a JSON key file fits; a mistake does not). */
export const SECRET_MAX_BYTES = 16 * 1024;

// --- Sealing -----------------------------------------------------------------------------------

/** Where a sealed value belongs: what is bound into it. */
export interface SecretPlace {
  environment: ClientEnvironmentName;
  client: ClientId;
  name: string;
  kind: SecretKind;
}

/** A sealed value, as `registry_secrets` holds it. */
export interface SealedSecret {
  /** HPKE's encapsulated key (32 bytes). */
  enc: Uint8Array<ArrayBuffer>;
  /** The AES-256-GCM ciphertext with its tag. */
  ciphertext: Uint8Array<ArrayBuffer>;
  /** Which public key it was sealed to. */
  keyId: string;
}

/**
 * HPKE's `info` and the AEAD's associated data for a place: the scheme's version, the kind, the
 * environment, the client, the name and the key's id. Every part is from a closed alphabet
 * without `/`, and the kind decides which names are allowed.
 */
export function placeBytes(place: SecretPlace, keyId: string): Uint8Array<ArrayBuffer> {
  validateClientId(place.client);
  if (place.environment !== "live" && place.environment !== "staging") {
    throw new RangeError("Not an environment");
  }
  if (place.kind === "given") {
    if (!isGivenSecretName(place.name)) throw new RangeError(`${place.name} is not a given secret`);
  } else if (place.kind === "imported") {
    if (!isDerivedSecretName(place.name)) {
      throw new RangeError(`${place.name} is not a derivable secret, so it is never imported`);
    }
  } else {
    throw new RangeError("Not a kind of secret");
  }
  if (!/^k2-[0-9a-f]{16}$/.test(keyId)) throw new RangeError("Not a key id");
  return new Uint8Array(
    encoder.encode(
      `cos/registry-secret/v2/${place.kind}/${place.environment}/${place.client}/${place.name}/${keyId}`,
    ),
  );
}

/** A UTF-16 surrogate with no partner: text UTF-8 cannot carry (it would become U+FFFD). */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** The value's bytes, refused when empty, over-long or not well-formed text (lone surrogates). */
function valueBytes(place: SecretPlace, value: string): Uint8Array<ArrayBuffer> {
  if (typeof value !== "string" || value.length === 0) {
    throw new RangeError(`The value of ${place.name} for ${place.client} is empty`);
  }
  if (LONE_SURROGATE.test(value)) {
    throw new RangeError(`The value of ${place.name} for ${place.client} is not well-formed text`);
  }
  const bytes = new Uint8Array(encoder.encode(value));
  if (bytes.length > SECRET_MAX_BYTES) {
    throw new RangeError(
      `The value of ${place.name} for ${place.client} is over ${SECRET_MAX_BYTES} bytes`,
    );
  }
  return bytes;
}

/** Seals one value to the host's public key: a fresh encapsulation every time. */
export async function sealClientSecret(
  publicKey: SealingPublicKey,
  place: SecretPlace,
  value: string,
): Promise<SealedSecret> {
  const bound = placeBytes(place, publicKey.id);
  const plain = valueBytes(place, value);
  const sealed = await SEALING_SUITE.seal(
    { recipientPublicKey: publicKey.key, info: bound.buffer },
    plain.buffer,
    bound.buffer,
  );
  return {
    enc: new Uint8Array(sealed.enc),
    ciphertext: new Uint8Array(sealed.ct),
    keyId: publicKey.id,
  };
}

const UPSERT = `INSERT INTO registry_secrets (client, name, kind, enc, ciphertext, key_id)
  VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT (client, name) DO UPDATE SET kind = excluded.kind, enc = excluded.enc,
    ciphertext = excluded.ciphertext, key_id = excluded.key_id, updated_at = CURRENT_TIMESTAMP`;

async function writeSealed(
  registry: D1Database,
  publicKey: SealingPublicKey,
  place: SecretPlace,
  value: string,
): Promise<{ keyId: string }> {
  const sealed = await sealClientSecret(publicKey, place, value);
  await registry
    .prepare(UPSERT)
    .bind(place.client, place.name, place.kind, sealed.enc, sealed.ciphertext, sealed.keyId)
    .run();
  return { keyId: sealed.keyId };
}

/**
 * Writes (or replaces) one given secret of a client, sealed to the host's public key: the
 * operator's `cos client secret set` (stage 66 step 7). It can overwrite a value, never read one.
 * A running host serves the old value for up to `REGISTRY_REFRESH_MS` (10 seconds) more.
 */
export function writeClientSecret(
  registry: D1Database,
  publicKey: SealingPublicKey,
  place: Omit<SecretPlace, "kind">,
  value: string,
): Promise<{ keyId: string }> {
  return writeSealed(registry, publicKey, { ...place, kind: "given" }, value);
}

/**
 * Stores a derivable secret of a deployment imported as a client (`cos client import` of a
 * single-client deployment, stage 66 step 7): its existing `BETTER_AUTH_SECRET` and the rest, so
 * its sessions, cards, PINs, app codes and desk enrolments carry on. For that client the stored
 * value overrides derivation. This is the only way a derivable name is ever stored.
 */
export function writeImportedSecret(
  registry: D1Database,
  publicKey: SealingPublicKey,
  place: Omit<SecretPlace, "kind">,
  value: string,
): Promise<{ keyId: string }> {
  return writeSealed(registry, publicKey, { ...place, kind: "imported" }, value);
}

/** Removes one stored secret of a client (`cos client secret remove`, stage 66 step 7). */
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

// --- Encoding ----------------------------------------------------------------------------------

export function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function base64url(bytes: Uint8Array): string {
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
