// The secrets of an enrolled device and a desk signing session (stage 51 step 1 and stage 44 step
// 6, ADRs 0780 and 0649): enrolment codes, device credentials, session codes and session tokens.
// The host keeps each one only as an HMAC-SHA-256 under an env secret (DESK_SECRET, an auth
// secret, never in D1 or a setting), each under its own purpose, so a value for one is never
// accepted as another.
//
// A credential rotated by the host is derived from the one it replaces (`nextCredential`): the
// HMAC of the old credential under the secret. A retry of the rotating call within the grace
// window, with the old credential, gets the same new one, and the host stores no credential in the
// clear to make that so. Without the secret nobody can work out the next one.

/** What each kind of secret is HMACed as. */
export type SecretPurpose = "enrol" | "credential" | "code" | "token";

const encoder = new TextEncoder();
const keys = new Map<string, Promise<CryptoKey>>();

function keyFor(secret: string): Promise<CryptoKey> {
  let key = keys.get(secret);
  if (!key) {
    key = crypto.subtle.importKey(
      "raw",
      encoder.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    keys.set(secret, key);
  }
  return key;
}

async function sign(secret: string, message: string): Promise<Uint8Array> {
  const key = await keyFor(secret);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(message)));
}

const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

function base64url(bytes: Uint8Array): string {
  let text = "";
  for (const b of bytes) text += String.fromCharCode(b);
  return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** The stored form of a secret: 64 hex characters. */
export function secretHash(secret: string, purpose: SecretPurpose, value: string): Promise<string> {
  return sign(secret, `cos-desk:${purpose}:${value}`).then(hex);
}

/** 256 random bits, base64url: a device credential or a session token. */
export function randomSecret(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(32)));
}

/** The credential that replaces `old` when the host rotates it (see the header). */
export async function nextCredential(secret: string, old: string): Promise<string> {
  return base64url(await sign(secret, `cos-desk:next:${old}`));
}

/**
 * The token a claim gives for a session, from the credential the claim was made with: a retry of
 * the claim with that credential gets the same token (the 60-second grace).
 */
export async function sessionToken(
  secret: string,
  sessionId: string,
  credential: string,
): Promise<string> {
  return base64url(await sign(secret, `cos-desk:token:${sessionId}:${credential}`));
}

/** No 0/O, 1/I/L, 2/Z, 5/S or 8/B: a code read aloud or off a screen is typed as it was meant. */
export const CODE_ALPHABET = "34679ACDEFGHJKMNPQRTUVWXY";

/** A code of `length` characters from CODE_ALPHABET, with no bias. */
export function randomCode(length: number): string {
  const out: string[] = [];
  while (out.length < length) {
    for (const byte of crypto.getRandomValues(new Uint8Array(length * 2))) {
      // 250 is the largest multiple of the alphabet's 25 below 256: anything above is dropped.
      if (byte < 250 && out.length < length) out.push(CODE_ALPHABET[byte % 25] as string);
    }
  }
  return out.join("");
}

/** A code as typed (any case, spaces and dashes), as it is compared. */
export function normaliseCode(typed: string): string {
  return typed.toUpperCase().replace(/[\s-]+/g, "");
}

/** The enrolment code an admin is given: 10 characters, single use, 10 minutes. */
export const ENROL_CODE_LENGTH = 10;
/** The desk session's code: 8 characters, single use, 2 minutes until claimed. */
export const SESSION_CODE_LENGTH = 8;
