// The media library's rules (stage 28, ADR 0444): what an upload may be, read from its bytes; the
// store its originals live in; and which media items a version's content references.
//
// The type is the file's first bytes, never its name or what the client said. Only raster images
// the host recognises are taken: JPEG, PNG, GIF, WebP and AVIF. SVG is not (it can carry script),
// nor anything else. The size is checked before anything is read.
import {
  documentRefs,
  documentSchemaOf,
  MEDIA_MAX_BYTES,
  type MediaType,
  RICH_TEXT_MEDIA_OBJECT,
  sniffMediaType,
} from "@composable-os/sdk";
import type { ObjectDefinition } from "../fields/types.ts";

// The rule on what a picture may be is the SDK's, so `cos content import` checks the same one.
export { MEDIA_MAX_BYTES, sniffMediaType };
/** The widths a client may ask a picture in; anything else is the nearest one above. */
export const MEDIA_WIDTHS = [320, 640, 960, 1280, 1920] as const;
/** Where originals are kept in R2. */
export const MEDIA_PREFIX = "media/";

/** Where media originals are kept: the R2 bucket, in a Worker. */
export interface MediaStore {
  put(key: string, bytes: Uint8Array, type: string): Promise<void>;
  get(key: string): Promise<{ body: ReadableStream; size: number } | null>;
  delete(keys: string[]): Promise<void>;
}

/** Turns an original into a smaller one: Cloudflare Images, where the deployment binds it. */
export interface MediaResizer {
  resize(
    body: ReadableStream,
    options: { width: number; type: string },
  ): Promise<{ body: ReadableStream; type: string }>;
}

const u16be = (b: Uint8Array, at: number) => ((b[at] ?? 0) << 8) | (b[at + 1] ?? 0);
const u16le = (b: Uint8Array, at: number) => (b[at] ?? 0) | ((b[at + 1] ?? 0) << 8);
const u24le = (b: Uint8Array, at: number) => u16le(b, at) | ((b[at + 2] ?? 0) << 16);
const u32be = (b: Uint8Array, at: number) => u16be(b, at) * 65536 + u16be(b, at + 2);

const ascii = (bytes: Uint8Array, at: number, text: string) =>
  [...text].every((c, i) => bytes[at + i] === c.charCodeAt(0));

/** Width and height from the file's header, when the host can read them; else nulls. */
export function mediaDimensions(
  bytes: Uint8Array,
  type: MediaType,
): { width: number | null; height: number | null } {
  const none = { width: null, height: null };
  try {
    switch (type) {
      case "image/png":
        return { width: u32be(bytes, 16), height: u32be(bytes, 20) };
      case "image/gif":
        return { width: u16le(bytes, 6), height: u16le(bytes, 8) };
      case "image/webp": {
        if (ascii(bytes, 12, "VP8X")) {
          return { width: u24le(bytes, 24) + 1, height: u24le(bytes, 27) + 1 };
        }
        if (ascii(bytes, 12, "VP8L")) {
          const b0 = bytes[21] ?? 0;
          const b1 = bytes[22] ?? 0;
          const b2 = bytes[23] ?? 0;
          const b3 = bytes[24] ?? 0;
          return {
            width: 1 + (((b1 & 0x3f) << 8) | b0),
            height: 1 + (((b3 & 0xf) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6)),
          };
        }
        if (ascii(bytes, 12, "VP8 ")) {
          return { width: u16le(bytes, 26) & 0x3fff, height: u16le(bytes, 28) & 0x3fff };
        }
        return none;
      }
      case "image/jpeg": {
        // Walk the segments to the first start-of-frame marker.
        let at = 2;
        while (at + 9 < bytes.length) {
          if (bytes[at] !== 0xff) return none;
          const marker = bytes[at + 1] ?? 0;
          const length = u16be(bytes, at + 2);
          const frame =
            marker >= 0xc0 &&
            marker <= 0xcf &&
            marker !== 0xc4 &&
            marker !== 0xc8 &&
            marker !== 0xcc;
          if (frame) return { height: u16be(bytes, at + 5), width: u16be(bytes, at + 7) };
          if (length < 2) return none;
          at += 2 + length;
        }
        return none;
      }
      default:
        return none;
    }
  } catch {
    return none;
  }
}

/** The width a picture is served at for a client that asks for `asked`: the next one up. */
export function servedWidth(asked: number | null): number | null {
  if (asked === null || !Number.isFinite(asked) || asked <= 0) return null;
  return MEDIA_WIDTHS.find((w) => w >= asked) ?? MEDIA_WIDTHS[MEDIA_WIDTHS.length - 1] ?? null;
}

/**
 * The media items a version's content references, with the field each is in: every `media` ref
 * of its document-valued fields (a rich text picture, an `image` field), once per field.
 */
export function mediaUsesOf(
  object: ObjectDefinition,
  content: Record<string, unknown>,
): { media: string; field: string }[] {
  const uses = new Map<string, { media: string; field: string }>();
  for (const field of object.fields) {
    if (!Object.hasOwn(content, field.name)) continue;
    const schema = documentSchemaOf({
      type: field.fieldType,
      schema: field.options?.document?.schema,
    });
    const value = content[field.name];
    if (!schema || value === null || value === undefined) continue;
    for (const ref of documentRefs(schema, value)) {
      if (ref.to !== RICH_TEXT_MEDIA_OBJECT) continue;
      uses.set(`${ref.id}|${field.name}`, { media: ref.id, field: field.name });
    }
  }
  return [...uses.values()];
}
