// SHA-256 and hex: what the host hashes tokens, cache keys, inputs and files with. One helper for
// what was written out wherever a hash was needed.

/** Bytes as lowercase hex, two characters a byte. */
export function toHex(bytes: ArrayBuffer | Uint8Array): string {
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** The SHA-256 of `data` (text is hashed as UTF-8), as 64 lowercase hex characters. */
export async function sha256Hex(data: string | BufferSource): Promise<string> {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  return toHex(await crypto.subtle.digest("SHA-256", bytes));
}
