// The HPKE suite and the host's key handling for a client's given secrets (stage 66 step 6, ADR
// 0616). Internal to packages/db: not in the package's exports. The operator's side
// (`registry-sealing.ts`, exported) seals with a public key; the host's side (`registry-secrets.ts`,
// not exported) opens with the private key. "Can seal, cannot open" holds because only the host's
// environment holds the private key; this module keeps the suite's `open` and the private-key
// helpers out of the exported module besides.
import { Aes256Gcm, CipherSuite, DhkemX25519HkdfSha256, HkdfSha256 } from "@hpke/core";

/** The suite every given secret is sealed with: RFC 9180 base mode, X25519, SHA-256, AES-256-GCM. */
export const SEALING_SUITE = new CipherSuite({
  kem: new DhkemX25519HkdfSha256(),
  kdf: new HkdfSha256(),
  aead: new Aes256Gcm(),
});

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

/** The key pair a private key's text stands for: HPKE's DeriveKeyPair from its 32 bytes. */
export async function keyPairOf(text: string, name: string): Promise<CryptoKeyPair> {
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
  /** The key as text (43 characters of base64url), to show or store. It is treated as public. */
  readonly text: string;
}

/** The host's public key from its text (the deploy engine prints it; the operator keeps it). */
export async function sealingPublicKey(text: string): Promise<SealingPublicKey> {
  const raw = hostKeyBytes(text, "The secrets public key");
  const key = await SEALING_SUITE.kem.deserializePublicKey(raw.buffer);
  return Object.freeze({ id: await keyIdOf(raw), key, text });
}

/** A private key's text as its key pair's private key and public key (the host's keyring). */
export async function hostKeyPair(
  privateText: string,
  name: string,
): Promise<{ privateKey: CryptoKey; publicKey: SealingPublicKey }> {
  const pair = await keyPairOf(privateText, name);
  const raw = new Uint8Array(await SEALING_SUITE.kem.serializePublicKey(pair.publicKey));
  return { privateKey: pair.privateKey, publicKey: await sealingPublicKey(base64url(raw)) };
}

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
