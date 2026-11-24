// Bytes as text (hex and base64url) and SHA-256: what the host hashes and writes tokens, cache
// keys, inputs and files with. One helper for what was written out wherever one was needed.

/** Bytes as lowercase hex, two characters a byte. */
export function toHex(bytes: ArrayBuffer | Uint8Array): string {
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** base64url of bytes (RFC 4648 section 5), no padding. */
export function base64url(bytes: ArrayBuffer | Uint8Array): string {
  let binary = "";
  for (const b of new Uint8Array(bytes)) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Bytes of base64url (or base64) text, padded or not. */
export function fromBase64url(text: string): Uint8Array<ArrayBuffer> {
  const b64 = text.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

/** The SHA-256 of `data` (text is hashed as UTF-8), as 64 lowercase hex characters. */
export async function sha256Hex(data: string | BufferSource): Promise<string> {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  return toHex(await crypto.subtle.digest("SHA-256", bytes));
}
