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

// --- Files and videos (stage 42, ADR 0475) ------------------------------------------------------
//
// A `file` item is a download (a PDF only, at first), kept in R2 like a picture and served by the
// same rule. Its type is read from its bytes too. A `video` item is held in Cloudflare Stream on
// the deployment's own account: the file goes from the staff browser straight to Stream, so the
// host only checks the size a person says it is, and Stream refuses what is not a video.

/** The kinds of item the media library holds. */
export const MEDIA_KINDS = ["image", "video", "file"] as const;
export type MediaKind = (typeof MEDIA_KINDS)[number];

/** The types a `file` item may be. */
export const MEDIA_FILE_TYPES = ["application/pdf"] as const;
export type MediaFileType = (typeof MEDIA_FILE_TYPES)[number];

/** The `type` the library records for a video (its bytes are Stream's, never the host's). */
export const MEDIA_VIDEO_TYPE = "video/stream" as const;

/** The most a downloadable file may be, in bytes. */
export const MEDIA_FILE_MAX_BYTES = 50 * 1024 * 1024;

/** The most a video may be, in bytes: under Stream's 30 GB. */
export const MEDIA_VIDEO_MAX_BYTES = 30 * 1000 * 1000 * 1000 - 1;

/** The longest a video may be, in seconds (Stream refuses an upload longer than it was told). */
export const MEDIA_VIDEO_MAX_SECONDS = 6 * 60 * 60;

/** The most a caption file may be (Stream's limit): WebVTT only. */
export const MEDIA_CAPTION_MAX_BYTES = 10 * 1024 * 1024;

/** The type a downloadable file's bytes are, or null when the library does not take it. */
export function sniffFileType(bytes: Uint8Array): MediaFileType | null {
  return ascii(bytes, 0, "%PDF-") ? "application/pdf" : null;
}

/** The kind and type an uploaded file is, from its bytes: a picture or a download. */
export function sniffUpload(
  bytes: Uint8Array,
): { kind: "image"; type: MediaType } | { kind: "file"; type: MediaFileType } | null {
  const image = sniffMediaType(bytes);
  if (image) return { kind: "image", type: image };
  const file = sniffFileType(bytes);
  return file ? { kind: "file", type: file } : null;
}

/** The most an upload of this kind may be. */
export function maxBytesOf(kind: "image" | "file"): number {
  return kind === "file" ? MEDIA_FILE_MAX_BYTES : MEDIA_MAX_BYTES;
}

/** Whether `bytes` are a WebVTT file (its header, after an optional byte order mark). */
export function isWebVtt(bytes: Uint8Array): boolean {
  const at = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
  if (!ascii(bytes, at, "WEBVTT")) return false;
  const next = bytes[at + 6];
  // "WEBVTT" alone on its line, or followed by a space or a tab and a header.
  return next === undefined || next === 0x0a || next === 0x0d || next === 0x20 || next === 0x09;
}

/** A caption's language: a BCP 47 tag as Stream takes it (`en`, `pt-BR`). */
export const CAPTION_LANGUAGE_RE = /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,2}$/;
