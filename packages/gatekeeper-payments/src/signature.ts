// The webhook signature both providers use: a header `t=<unix seconds>,v1=<hex>[,v1=<hex>…]`
// carrying HMAC-SHA256(secret, `${t}.${rawBody}`), which is Stripe's scheme. The fake provider signs
// its own deliveries the same way, so its route exercises the same check. `crypto.subtle.verify`
// compares in constant time.

/** How far a signed timestamp may be from now, in seconds (Stripe's recommendation). */
export const TIMESTAMP_TOLERANCE_SECONDS = 5 * 60;

/** At most this many `v1=` signatures are tried from one header. */
const MAX_SIGNATURES = 8;

/** Why a delivery was refused. Fixed strings: they quote nothing from the request. */
export type RejectionReason =
  | "not configured"
  | "missing signature"
  | "malformed signature"
  | "bad signature"
  | "missing timestamp"
  | "stale timestamp"
  | "malformed body";

export type SignatureCheck = { ok: true } | { ok: false; reason: RejectionReason };

/**
 * Verifies a `t=…,v1=…` signature header over `body`.
 * @param nowSeconds The current Unix time in seconds.
 */
export async function verifySignatureHeader(
  secret: string,
  header: string | undefined,
  body: Uint8Array,
  nowSeconds: number,
): Promise<SignatureCheck> {
  if (secret === "") return { ok: false, reason: "not configured" };
  if (header === undefined || header.trim() === "") {
    return { ok: false, reason: "missing signature" };
  }
  let timestamp: string | undefined;
  const signatures: Uint8Array[] = [];
  for (const part of header.split(",")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === "t") {
      if (timestamp !== undefined) return { ok: false, reason: "malformed signature" };
      timestamp = value;
    } else if (key === "v1" && signatures.length < MAX_SIGNATURES) {
      const bytes = parseSha256Hex(value);
      if (bytes) signatures.push(bytes);
    }
  }
  if (timestamp === undefined) return { ok: false, reason: "missing timestamp" };
  if (signatures.length === 0) return { ok: false, reason: "missing signature" };
  if (!/^\d{1,12}$/.test(timestamp)) return { ok: false, reason: "stale timestamp" };
  if (Math.abs(nowSeconds - Number(timestamp)) > TIMESTAMP_TOLERANCE_SECONDS) {
    return { ok: false, reason: "stale timestamp" };
  }
  const key = await hmacKey(secret);
  const signed = concat(`${timestamp}.`, body);
  for (const signature of signatures) {
    if (await crypto.subtle.verify("HMAC", key, signature, signed)) return { ok: true };
  }
  return { ok: false, reason: "bad signature" };
}

/**
 * The `t=…,v1=…` header value for `body` signed at `timestamp`. Used by the fake provider for its
 * own deliveries, and by tests to sign Stripe deliveries.
 */
export async function signatureHeader(
  secret: string,
  body: string,
  timestamp: number,
): Promise<string> {
  const key = await hmacKey(secret);
  const mac = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${timestamp}.${body}`)),
  );
  const hex = [...mac].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `t=${timestamp},v1=${hex}`;
}

function parseSha256Hex(value: string): Uint8Array | undefined {
  if (!/^[0-9a-fA-F]{64}$/.test(value)) return undefined;
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) bytes[i] = Number.parseInt(value.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

function concat(prefix: string, body: Uint8Array): Uint8Array {
  const head = new TextEncoder().encode(prefix);
  const out = new Uint8Array(head.byteLength + body.byteLength);
  out.set(head, 0);
  out.set(body, head.byteLength);
  return out;
}

/** A random id of `length` characters, with no run of digits long enough to look like a card. */
export function randomId(prefix: string, length = 24): string {
  // Few digits in the alphabet, so a long all-digit run is vanishingly unlikely.
  const alphabet = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  let id = "";
  for (const byte of bytes) id += alphabet[byte % alphabet.length];
  return `${prefix}${id}`;
}
