// Record files (stage 56 step 3, ADR 0834): a photo or a PDF attached to a note about a client,
// kept privately under its own R2 prefix and served only to the note's readers. Never the media
// library: no record file is listed by media.list, found by media.findByHash or deduplicated.
//
// What a file may be is the SDK's rule (`sniffRecordFile`, sdk/media.ts): its first bytes. This
// module then reads the whole file as what it says it is and writes it again without its
// metadata, a byte-level rewrite with no re-encoding: a JPEG keeps its frame, tables and scans
// (and its orientation, in an EXIF segment of that one tag), a PNG its image and colour chunks, a
// WebP its image, animation and colour chunks. Everything else goes: EXIF (location, camera,
// times), XMP, comments, text chunks, anything after the end of the image. A file that is not
// well formed is refused. PDFs are stored as sent (the spec: no PDF is rewritten), once they start
// and end as a PDF does.
import type { CoreDatabase } from "@composable-os/db";
import { RECORD_FILE_TYPES, RECORD_FILES_PER_NOTE, type RecordFileType } from "@composable-os/sdk";
import type { Kysely } from "kysely";
import { z } from "zod";
import { jsonList } from "./common.ts";
import { mediaDimensions } from "./media.ts";

/** A file as its note's readers see it: never its key, its digest or who may have it. */
export const recordFileSchema = z.object({
  id: z.string(),
  name: z.string().describe("The name it was uploaded with"),
  type: z.enum(RECORD_FILE_TYPES),
  bytes: z.number().int(),
  width: z.number().int().nullable(),
  height: z.number().int().nullable(),
  createdAt: z.string(),
});
export type RecordFile = z.infer<typeof recordFileSchema>;

/** A core_record_file row, as the operations read it. */
export interface RecordFileRow {
  id: string;
  note_id: string | null;
  key: string;
  name: string;
  type: RecordFileType;
  bytes: number;
  width: number | null;
  height: number | null;
  uploaded_by: string;
  created_at: string;
}

export const recordFileOut = (
  row: Pick<RecordFileRow, "id" | "name" | "type" | "bytes" | "width" | "height" | "created_at">,
): RecordFile => ({
  id: row.id,
  name: row.name,
  type: row.type,
  bytes: Number(row.bytes),
  width: row.width === null ? null : Number(row.width),
  height: row.height === null ? null : Number(row.height),
  createdAt: row.created_at,
});

/**
 * The files of these notes, by note: only for notes their reader already read through the seam.
 * One statement for a page of notes (their ids in one bound parameter), each note's at most
 * RECORD_FILES_PER_NOTE, oldest first.
 */
export async function filesOfNotes(
  db: Kysely<CoreDatabase>,
  noteIds: readonly string[],
): Promise<Map<string, RecordFile[]>> {
  const byNote = new Map<string, RecordFile[]>();
  if (!noteIds.length) return byNote;
  const rows = await db
    .selectFrom("core_record_file")
    .select(["id", "note_id", "name", "type", "bytes", "width", "height", "created_at"])
    .where("note_id", "in", jsonList(noteIds))
    .orderBy("note_id")
    .orderBy("created_at")
    .orderBy("id")
    .execute();
  for (const row of rows) {
    if (!row.note_id) continue;
    const list = byNote.get(row.note_id) ?? [];
    if (list.length < RECORD_FILES_PER_NOTE) list.push(recordFileOut(row));
    byNote.set(row.note_id, list);
  }
  return byNote;
}

/** Where record files are kept in R2: `files/<id>`, never under the library's `media/`. */
export const FILES_PREFIX = "files/";

/** How long an upload not yet attached to a note is kept before the daily purge deletes it. */
export const STAGED_FILE_HOURS = 24;

/** The most files one account may hold uploaded and not yet attached to a note. */
export const STAGED_FILES_PER_UPLOADER = 20;

/** The storage cap's default, in bytes: 10 GB (a human admin changes it). */
export const DEFAULT_FILES_CAP_BYTES = 10 * 1024 * 1024 * 1024;

/** The setting that holds the cap (core_settings). */
export const FILES_SETTING = "record_files";

/** Files the daily purge deletes in one round, and rounds in one run. */
export const FILE_PURGE_BATCH = 100;
export const FILE_PURGE_ROUNDS = 5;

const u16be = (b: Uint8Array, at: number) => ((b[at] ?? 0) << 8) | (b[at + 1] ?? 0);
const u32be = (b: Uint8Array, at: number) => u16be(b, at) * 65536 + u16be(b, at + 2);
const u32le = (b: Uint8Array, at: number) =>
  ((b[at] ?? 0) | ((b[at + 1] ?? 0) << 8) | ((b[at + 2] ?? 0) << 16)) + (b[at + 3] ?? 0) * 2 ** 24;
const ascii = (b: Uint8Array, at: number, text: string) =>
  [...text].every((c, i) => b[at + i] === c.charCodeAt(0));

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.byteLength;
  }
  return out;
}

// --- JPEG ----------------------------------------------------------------------------------------

/** The EXIF orientation (1 to 8) an APP1 segment's body holds, or null. */
function exifOrientation(body: Uint8Array): number | null {
  if (!ascii(body, 0, "Exif\0\0")) return null;
  const t = 6;
  const little = ascii(body, t, "II");
  if (!little && !ascii(body, t, "MM")) return null;
  const u16 = (at: number) =>
    little ? (body[t + at] ?? 0) | ((body[t + at + 1] ?? 0) << 8) : u16be(body, t + at);
  const u32 = (at: number) => (little ? u32le(body, t + at) : u32be(body, t + at));
  if (u16(2) !== 42) return null;
  const ifd = u32(4);
  if (ifd < 8 || t + ifd + 2 > body.length) return null;
  const count = u16(ifd);
  for (let i = 0; i < count; i++) {
    const entry = ifd + 2 + i * 12;
    if (t + entry + 12 > body.length) return null;
    if (u16(entry) === 0x0112 && u16(entry + 2) === 3) {
      const value = u16(entry + 8);
      return value >= 1 && value <= 8 ? value : null;
    }
  }
  return null;
}

/** An APP1 segment holding only an EXIF orientation: what a phone's photo needs to stand upright. */
function orientationSegment(orientation: number): Uint8Array {
  // FFE1, length 34: "Exif\0\0", a big-endian TIFF header, one IFD of one SHORT entry, no next IFD.
  return new Uint8Array([
    0xff,
    0xe1,
    0x00,
    0x22,
    0x45,
    0x78,
    0x69,
    0x66,
    0x00,
    0x00,
    0x4d,
    0x4d,
    0x00,
    0x2a,
    0x00,
    0x00,
    0x00,
    0x08,
    0x00,
    0x01,
    0x01,
    0x12,
    0x00,
    0x03,
    0x00,
    0x00,
    0x00,
    0x01,
    0x00,
    orientation,
    0x00,
    0x00,
    0x00,
    0x00,
    0x00,
    0x00,
  ]);
}

/** Whether a JPEG segment is kept: the image's own, and colour, never metadata. */
function keepJpegSegment(marker: number, body: Uint8Array): boolean {
  // APP0: the JFIF header (and its extension), nothing else that hides there.
  if (marker === 0xe0) return ascii(body, 0, "JFIF\0") || ascii(body, 0, "JFXX\0");
  // APP2: an ICC colour profile only (FlashPix and MPF go).
  if (marker === 0xe2) return ascii(body, 0, "ICC_PROFILE\0");
  // APP14: Adobe's colour transform flag, which CMYK and YCCK files need to decode.
  if (marker === 0xee) return ascii(body, 0, "Adobe");
  // APP1 (EXIF, XMP), the other APPn and comments: metadata.
  if (marker >= 0xe0 && marker <= 0xef) return false;
  if (marker === 0xfe) return false;
  // Frames and Huffman tables (C0 to CF); a scan, quantisation tables, lines, the restart
  // interval and the rest (DA to DF): the image.
  if (marker >= 0xc0 && marker <= 0xcf) return true;
  return marker >= 0xda && marker <= 0xdf;
}

/** The JPEG without its metadata, or null when it is not a well-formed JPEG. */
export function stripJpeg(bytes: Uint8Array): Uint8Array | null {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  const head: Uint8Array[] = [bytes.subarray(0, 2)];
  const rest: Uint8Array[] = [];
  let orientation: number | null = null;
  let frame = false;
  let scan = false;
  let jfif: Uint8Array | null = null;
  let at = 2;
  for (;;) {
    if (at >= bytes.length || bytes[at] !== 0xff) return null;
    while (bytes[at] === 0xff) at += 1;
    const marker = bytes[at];
    at += 1;
    if (marker === undefined || marker === 0x00) return null;
    if (marker === 0xd9) {
      // The end of the image: anything after it (a second file glued on) is dropped.
      rest.push(new Uint8Array([0xff, 0xd9]));
      break;
    }
    if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      rest.push(new Uint8Array([0xff, marker]));
      continue;
    }
    if (marker === 0xd8) return null;
    const length = u16be(bytes, at);
    if (length < 2 || at + length > bytes.length) return null;
    const body = bytes.subarray(at + 2, at + length);
    const segment = bytes.subarray(at - 2, at + length);
    at += length;
    if (marker === 0xe1) orientation ??= exifOrientation(body);
    if (marker === 0xe0 && !jfif && !frame && keepJpegSegment(marker, body)) {
      jfif = segment;
    } else if (keepJpegSegment(marker, body)) {
      rest.push(segment);
    }
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8) frame = true;
    if (marker === 0xda) {
      scan = true;
      // The entropy-coded data, to the next marker that is not a stuffed byte or a restart.
      let end = at;
      while (end < bytes.length) {
        if (bytes[end] === 0xff) {
          const next = bytes[end + 1];
          if (next === 0x00 || (next !== undefined && next >= 0xd0 && next <= 0xd7)) {
            end += 2;
            continue;
          }
          break;
        }
        end += 1;
      }
      rest.push(bytes.subarray(at, end));
      at = end;
    }
  }
  if (!frame || !scan) return null;
  if (jfif) head.push(jfif);
  if (orientation !== null && orientation !== 1) head.push(orientationSegment(orientation));
  return concat([...head, ...rest]);
}

// --- PNG -----------------------------------------------------------------------------------------

/** The PNG chunks kept: the image's, transparency, colour and pixel size, and animation's. */
const PNG_KEPT = new Set([
  "IHDR",
  "PLTE",
  "IDAT",
  "IEND",
  "tRNS",
  "gAMA",
  "cHRM",
  "sRGB",
  "iCCP",
  "sBIT",
  "pHYs",
  "bKGD",
  "hIST",
  "cICP",
  "mDCV",
  "cLLI",
  "acTL",
  "fcTL",
  "fdAT",
]);

/** The PNG without its text, EXIF and time chunks, or null when it is not a well-formed PNG. */
export function stripPng(bytes: Uint8Array): Uint8Array | null {
  const parts: Uint8Array[] = [bytes.subarray(0, 8)];
  let at = 8;
  let first = true;
  let image = false;
  for (;;) {
    if (at + 12 > bytes.length) return null;
    const length = u32be(bytes, at);
    const type = String.fromCharCode(...bytes.subarray(at + 4, at + 8));
    if (!/^[A-Za-z]{4}$/.test(type) || at + 12 + length > bytes.length) return null;
    if (first && type !== "IHDR") return null;
    first = false;
    const chunk = bytes.subarray(at, at + 12 + length);
    at += 12 + length;
    if (type === "IDAT") image = true;
    if (PNG_KEPT.has(type)) parts.push(chunk);
    // The end of the image: anything after it is dropped.
    if (type === "IEND") break;
  }
  return image ? concat(parts) : null;
}

// --- WebP ----------------------------------------------------------------------------------------

/** The WebP chunks kept: the image's, alpha, animation and its colour profile. */
const WEBP_KEPT = new Set(["VP8 ", "VP8L", "VP8X", "ALPH", "ANIM", "ANMF", "ICCP"]);
/** VP8X's flags for an EXIF and an XMP chunk, cleared when those chunks go. */
const WEBP_METADATA_FLAGS = 0x08 | 0x04;

/** The WebP without its EXIF and XMP chunks, or null when it is not a well-formed WebP. */
export function stripWebp(bytes: Uint8Array): Uint8Array | null {
  if (!ascii(bytes, 0, "RIFF") || !ascii(bytes, 8, "WEBP")) return null;
  const end = 8 + u32le(bytes, 4);
  if (end > bytes.length || end < 12) return null;
  const parts: Uint8Array[] = [];
  let at = 12;
  let image = false;
  while (at < end) {
    if (at + 8 > end) return null;
    const type = String.fromCharCode(...bytes.subarray(at, at + 4));
    const size = u32le(bytes, at + 4);
    const padded = size + (size % 2);
    if (at + 8 + size > end) return null;
    if (at === 12 && !["VP8 ", "VP8L", "VP8X"].includes(type)) return null;
    const chunk = bytes.subarray(at, Math.min(at + 8 + padded, end));
    at += 8 + padded;
    if (!WEBP_KEPT.has(type)) continue;
    if (type === "VP8X") {
      const copy = new Uint8Array(chunk);
      copy[8] = (copy[8] ?? 0) & ~WEBP_METADATA_FLAGS;
      parts.push(copy);
      continue;
    }
    if (type === "VP8 " || type === "VP8L" || type === "ANMF") image = true;
    parts.push(chunk);
  }
  if (!image) return null;
  const body = concat(parts);
  const header = new Uint8Array(12);
  header.set(bytes.subarray(0, 4), 0);
  const size = 4 + body.byteLength;
  header.set([size & 0xff, (size >> 8) & 0xff, (size >> 16) & 0xff, (size >>> 24) & 0xff], 4);
  header.set(bytes.subarray(8, 12), 8);
  return concat([header, body]);
}

// --- PDF -----------------------------------------------------------------------------------------

/** Whether the bytes start and end as a PDF does: its header, and `%%EOF` near the end. */
export function isWholePdf(bytes: Uint8Array): boolean {
  if (!ascii(bytes, 0, "%PDF-")) return false;
  const tail = bytes.subarray(Math.max(0, bytes.length - 1024));
  for (let i = tail.length - 5; i >= 0; i--) {
    if (ascii(tail, i, "%%EOF")) return true;
  }
  return false;
}

// --- The whole file ------------------------------------------------------------------------------

/** What is stored for an upload of `type`: its bytes without metadata, and its size in pixels. */
export interface PreparedFile {
  bytes: Uint8Array;
  width: number | null;
  height: number | null;
}

/** The file as it is kept, or null when its bytes are not a well-formed file of `type`. */
export function prepareRecordFile(bytes: Uint8Array, type: RecordFileType): PreparedFile | null {
  if (type === "application/pdf") {
    return isWholePdf(bytes) ? { bytes, width: null, height: null } : null;
  }
  const stripped =
    type === "image/jpeg"
      ? stripJpeg(bytes)
      : type === "image/png"
        ? stripPng(bytes)
        : stripWebp(bytes);
  if (!stripped) return null;
  return { bytes: stripped, ...mediaDimensions(stripped, type) };
}

const EXTENSION: Record<RecordFileType, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "application/pdf": "pdf",
};

/**
 * The name a served file is saved under: the uploaded name's last part, without control
 * characters or quotes, ending in its real type's extension (a PDF named `x.html` saves as
 * `x.html.pdf`, never as a page a browser would open).
 */
export function downloadName(name: string, type: RecordFileType): string {
  const ext = EXTENSION[type];
  const base =
    name
      .split(/[/\\]/)
      .pop()
      // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what go.
      ?.replace(/[\u0000-\u001f\u007f"<>:*?|;]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 120) ?? "";
  const stem = base.replace(new RegExp(`\\.(${type === "image/jpeg" ? "jpe?g" : ext})$`, "i"), "");
  return `${stem || "file"}.${ext}`;
}

/** A Content-Disposition value for `name`: `inline` or `attachment`, ASCII and UTF-8 forms. */
export function contentDisposition(kind: "inline" | "attachment", name: string): string {
  const fallback = name.replace(/[^A-Za-z0-9._ -]/g, "_");
  return `${kind}; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

// --- Deleting -----------------------------------------------------------------------------------
//
// A file row's delete queues its R2 object (core_blob_deletion, by trigger: migration 1233), so
// every path deletes rows and the drain deletes the bytes. There is no foreign key to
// core_activity, and nothing in migration 1233 names that table: migration 1430 remakes it, and a
// cascade or a trigger would then delete every file, or break the remake on a fresh database. So
// the paths that hard-delete notes (the Trash purge, erase) delete their files in the same batch,
// by the notes' ids (test/record-files.test.ts holds every such path to it).

/** Deletes the files of these notes: for a path that hard-deletes them, or erases them. */
export function deleteFilesOfNotes(db: Kysely<CoreDatabase>, noteIds: readonly string[]) {
  return db.deleteFrom("core_record_file").where("note_id", "in", jsonList(noteIds));
}

/**
 * The daily purge of record files (stage 56 step 3): uploads never attached to a note within
 * STAGED_FILE_HOURS. A bounded number per round, FILE_PURGE_ROUNDS rounds; what is left waits for
 * the next day. Their R2 objects are queued by trigger and drained by the 10-minute cron.
 */
export async function purgeRecordFiles(
  db: Kysely<CoreDatabase>,
  now: Date = new Date(),
): Promise<{ deleted: number; more: boolean }> {
  const before = new Date(now.getTime() - STAGED_FILE_HOURS * 3_600_000).toISOString();
  let deleted = 0;
  for (let round = 0; round < FILE_PURGE_ROUNDS; round++) {
    const due = await db
      .selectFrom("core_record_file")
      .select("id")
      .where("note_id", "is", null)
      .where("created_at", "<", before)
      .orderBy("created_at")
      .limit(FILE_PURGE_BATCH)
      .execute();
    if (!due.length) return { deleted, more: false };
    await db
      .deleteFrom("core_record_file")
      .where("note_id", "is", null)
      .where("id", "in", jsonList(due.map((r) => r.id)))
      .execute();
    deleted += due.length;
    if (due.length < FILE_PURGE_BATCH) return { deleted, more: false };
  }
  return { deleted, more: true };
}
