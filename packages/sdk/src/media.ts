// What a picture of the media library may be (stage 28, ADR 0444), as data and pure functions so
// the host and `cos content import` check one rule: the type is the file's first bytes, never its
// name or a client's word; only raster images the host recognises (JPEG, PNG, GIF, WebP, AVIF);
// no SVG, which can carry script; at most 10 MB.

/** The types the media library takes. */
export const MEDIA_TYPES = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/avif",
] as const;
export type MediaType = (typeof MEDIA_TYPES)[number];

/** The most an upload may be, in bytes. */
export const MEDIA_MAX_BYTES = 10 * 1024 * 1024;

const starts = (bytes: Uint8Array, at: number, ...values: number[]) =>
  values.every((v, i) => bytes[at + i] === v);
const ascii = (bytes: Uint8Array, at: number, text: string) =>
  [...text].every((c, i) => bytes[at + i] === c.charCodeAt(0));

/** The type the bytes are, or null when they are not a picture the library takes. */
export function sniffMediaType(bytes: Uint8Array): MediaType | null {
  if (starts(bytes, 0, 0xff, 0xd8, 0xff)) return "image/jpeg";
  if (starts(bytes, 0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
  if (ascii(bytes, 0, "GIF87a") || ascii(bytes, 0, "GIF89a")) return "image/gif";
  if (ascii(bytes, 0, "RIFF") && ascii(bytes, 8, "WEBP")) return "image/webp";
  if (ascii(bytes, 4, "ftyp") && (ascii(bytes, 8, "avif") || ascii(bytes, 8, "avis"))) {
    return "image/avif";
  }
  return null;
}

/** Why `bytes` cannot be uploaded, or null when they can. */
export function mediaProblem(bytes: Uint8Array): string | null {
  if (bytes.byteLength === 0) return "The file is empty";
  if (bytes.byteLength > MEDIA_MAX_BYTES) {
    return `The file is ${bytes.byteLength} bytes; a picture is at most ${MEDIA_MAX_BYTES}`;
  }
  if (!sniffMediaType(bytes)) {
    return "This is not a picture the library takes: JPEG, PNG, GIF, WebP or AVIF";
  }
  return null;
}
