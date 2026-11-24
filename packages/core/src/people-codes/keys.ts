// The keys and the arithmetic of a person's code (stage 51 step 3, ADR 0783).
//
// Three keys are derived from one env secret (the host's auth secret, BETTER_AUTH_SECRET) with
// HKDF, each for one purpose, so a key never serves two:
// - an HMAC key for card codes (only the HMAC of a card's code is kept);
// - an AES-GCM key for app secrets (the host must check a rotating code, so it can decrypt them);
// - an HMAC key the PIN is run through before PBKDF2, so a copy of the database alone cannot be
//   searched for 4-digit PINs (there are only ten thousand).
// Changing the auth secret therefore ends every card, app code and PIN: cards are issued again,
// app codes are made again at the next `me.code`, members set their PIN again.
//
// The rotating code is RFC 6238 (TOTP): HMAC-SHA1, a 30-second step, 8 digits, so the native app
// can make it offline with any TOTP implementation from the secret `me.code` gives it. The QR
// carries `<code id>.<8 digits>`; the host accepts this step and the one before, so a code is good
// for at most 60 seconds.
import { base64url, fromBase64url } from "../records/stream.ts";

const encoder = new TextEncoder();

/** The step of the rotating code, in seconds. */
export const APP_CODE_STEP_SECONDS = 30;
/** Digits of the rotating code. */
export const APP_CODE_DIGITS = 8;
/** PBKDF2 iterations for a PIN (the most Workers allow). */
export const PIN_ITERATIONS = 100_000;

/** What the host keeps codes and PINs with. Built once per request from the env secret. */
export interface PersonCodeKeys {
  /** HMAC-SHA256 of a card's normalised code, base64url: all the host keeps of it. */
  cardHmac(code: string): Promise<string>;
  /** An app secret, encrypted: `<iv>.<ciphertext>`, base64url. */
  encrypt(secret: Uint8Array): Promise<string>;
  decrypt(sealed: string): Promise<Uint8Array>;
  /** The PIN, keyed: what PBKDF2 is run over. */
  pinInput(pin: string): Promise<Uint8Array>;
}

async function derive(
  base: CryptoKey,
  info: string,
  algorithm:
    | { name: "HMAC"; hash: "SHA-256"; length: number }
    | { name: "AES-GCM"; length: number },
) {
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(32), info: encoder.encode(info) },
    base,
    algorithm,
    false,
    algorithm.name === "HMAC" ? ["sign"] : ["encrypt", "decrypt"],
  );
}

/** The keys for `secret` (the env secret). Each is derived on first use. */
export function personCodeKeys(secret: string): PersonCodeKeys {
  if (!secret) throw new Error("personCodeKeys needs the host's auth secret");
  let keys: Promise<{ card: CryptoKey; seal: CryptoKey; pin: CryptoKey }> | undefined;
  const load = () => {
    keys ??= (async () => {
      const base = await crypto.subtle.importKey("raw", encoder.encode(secret), "HKDF", false, [
        "deriveKey",
      ]);
      const hmac = { name: "HMAC", hash: "SHA-256", length: 256 } as const;
      return {
        card: await derive(base, "cos person-code card v1", hmac),
        seal: await derive(base, "cos person-code app secret v1", { name: "AES-GCM", length: 256 }),
        pin: await derive(base, "cos person-code pin v1", hmac),
      };
    })();
    return keys;
  };
  return {
    async cardHmac(code) {
      const mac = await crypto.subtle.sign("HMAC", (await load()).card, encoder.encode(code));
      return base64url(new Uint8Array(mac));
    },
    async encrypt(plain) {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const sealed = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv },
        (await load()).seal,
        plain as Uint8Array<ArrayBuffer>,
      );
      return `${base64url(iv)}.${base64url(new Uint8Array(sealed))}`;
    },
    async decrypt(sealed) {
      const [iv, data] = sealed.split(".");
      if (!iv || !data) throw new Error("not a sealed secret");
      const plain = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: fromBase64url(iv) },
        (await load()).seal,
        fromBase64url(data),
      );
      return new Uint8Array(plain);
    },
    async pinInput(pin) {
      return new Uint8Array(
        await crypto.subtle.sign("HMAC", (await load()).pin, encoder.encode(pin)),
      );
    },
  };
}

// --- The rotating code -----------------------------------------------------------------------------

/** A new app secret: 20 random bytes (RFC 4226's recommended length for HMAC-SHA1). */
export function newAppSecret(): Uint8Array<ArrayBuffer> {
  return crypto.getRandomValues(new Uint8Array(20));
}

/** The step a moment falls in. */
export function appCodeStep(now: Date): number {
  return Math.floor(now.getTime() / 1000 / APP_CODE_STEP_SECONDS);
}

/** The code for `step` (RFC 6238 over RFC 4226: HMAC-SHA1, dynamic truncation, 8 digits). */
export async function appCodeValue(secret: Uint8Array, step: number): Promise<string> {
  const counter = new Uint8Array(8);
  new DataView(counter.buffer).setBigUint64(0, BigInt(step));
  const key = await crypto.subtle.importKey(
    "raw",
    secret as Uint8Array<ArrayBuffer>,
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, counter));
  const offset = (mac[mac.length - 1] as number) & 0x0f;
  const binary =
    (((mac[offset] as number) & 0x7f) << 24) |
    ((mac[offset + 1] as number) << 16) |
    ((mac[offset + 2] as number) << 8) |
    (mac[offset + 3] as number);
  return String(binary % 10 ** APP_CODE_DIGITS).padStart(APP_CODE_DIGITS, "0");
}

/** What the QR carries: the code's id and the current value. */
export function appCodePayload(codeId: string, value: string): string {
  return `${codeId}.${value}`;
}

const APP_PAYLOAD_RE = /^(pc_[0-9A-HJKMNP-TV-Z]{26})\.(\d{8})$/;

/** An app code's id and value, or null for anything else (a card's code). */
export function parseAppPayload(text: string): { codeId: string; value: string } | null {
  const match = APP_PAYLOAD_RE.exec(text.trim());
  return match ? { codeId: match[1] as string, value: match[2] as string } : null;
}

/** RFC 4648 base32, no padding: how a TOTP secret is usually written (for the native app). */
export function base32(bytes: Uint8Array): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += alphabet[(value << (5 - bits)) & 31];
  return out;
}

// --- Cards -----------------------------------------------------------------------------------------

/** A card's code as compared: upper case, without spaces or hyphens (as Ticketing's codes). */
export function normaliseCardCode(code: string): string {
  return code.toUpperCase().replace(/[\s-]/g, "");
}

/** Why a card's code cannot be issued, or null. Long enough not to be guessed; not an app code. */
export function cardCodeProblem(normalised: string): string | null {
  if (normalised.length < 8) return "A card's code is at least 8 characters";
  if (normalised.length > 128) return "A card's code is at most 128 characters";
  if (!/^[\x21-\x7e]+$/.test(normalised)) return "A card's code is letters, digits and symbols";
  if (normalised.startsWith("PC_")) return "A card's code cannot start with pc_";
  return null;
}

// --- The PIN ---------------------------------------------------------------------------------------

/**
 * The most common 4-digit PINs, refused: every repeated digit, runs up and down, and the ones
 * most often chosen.
 */
export const COMMON_PINS: ReadonlySet<string> = new Set([
  ...Array.from({ length: 10 }, (_, d) => String(d).repeat(4)),
  "0123",
  "1234",
  "2345",
  "3456",
  "4567",
  "5678",
  "6789",
  "9876",
  "8765",
  "7654",
  "6543",
  "5432",
  "4321",
  "3210",
  "1212",
  "1122",
  "1313",
  "1010",
  "2000",
  "2001",
  "1004",
  "6969",
  "2580",
  "0852",
  "1230",
  "0007",
  "1369",
  "4545",
  "2020",
  "1221",
]);

/** Why a PIN cannot be set, or null. */
export function pinProblem(pin: string): string | null {
  if (!/^\d{4}$/.test(pin)) return "A PIN is 4 digits";
  if (COMMON_PINS.has(pin)) return "That PIN is too common: choose another";
  return null;
}

/** The PIN's slow hash with `salt`, base64url. */
export async function pinHash(
  keys: PersonCodeKeys,
  pin: string,
  salt: Uint8Array,
  iterations: number,
): Promise<string> {
  const material = await crypto.subtle.importKey(
    "raw",
    (await keys.pinInput(pin)) as Uint8Array<ArrayBuffer>,
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: salt as Uint8Array<ArrayBuffer>, iterations },
    material,
    256,
  );
  return base64url(new Uint8Array(bits));
}

/** A new salt for a PIN. */
export function newPinSalt(): Uint8Array<ArrayBuffer> {
  return crypto.getRandomValues(new Uint8Array(16));
}

/** Two strings compared in time that does not depend on where they differ. */
export function sameInConstantTime(a: string, b: string): boolean {
  const x = encoder.encode(a);
  const y = encoder.encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i += 1) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}
