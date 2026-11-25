// The media library (stage 28, ADR 0444): pictures staff upload, which rich text and `image`
// fields name by id, and which the public is served only while published content references
// them. Stage 42 (ADR 0475) adds downloadable files (a PDF, in R2 and served as a picture is) and
// videos (in Cloudflare Stream, played only with a token `media.play` signs: media-video.ts).
//
//   media.upload   a person          store an uploaded picture (bytes from the upload route)
//   media.list     staff             the library, newest first
//   media.get      staff             one item
//   media.update   staff             its name and alt text
//   media.delete   staff             to the Trash (the purge deletes its R2 object)
//   media.restore  staff             back from the Trash
//   media.serve    anyone            may this caller be served this picture or file, and how
//
// The bytes never pass through an operation's input: the upload route (`/api/media`, cos-app)
// reads the request's body and hands it to `media.upload` as `ctx.upload`, so no MCP client,
// import or extension can store a file, and the audit log holds what was stored, not the file.

import { MEDIA_FILE_MAX_BYTES, maxBytesOf, sniffUpload } from "@composable-os/sdk";
import { type Kysely, type SqlBool, sql } from "kysely";
import { z } from "zod";
import { sha256Hex } from "../digest.ts";
import { NotFoundError, OperationError, ValidationError } from "../errors.ts";
import { getObject } from "../fields/index.ts";
import { mediaObject } from "../fields/media.ts";
import type { ObjectDefinition } from "../fields/types.ts";
import { filterSchema } from "../filter.ts";
import { newId } from "../ids.ts";
import { LIST_MAX_LIMIT, sortSchema } from "../list.ts";
import { defineOperation, type HandlerContext } from "../operation.ts";
import { MEDIA_PREFIX, mediaDimensions, servedWidth } from "../records/media.ts";
import { holdsAccess } from "../visibility/access.ts";
import {
  orgReader,
  type Reader,
  visibleObject,
  visibleSource,
  visibleTable,
} from "../visibility/index.ts";
import { listVisible } from "../visibility/records.ts";

const mediaId = z.string().min(1).max(64).describe("A media item's id");

export const mediaOut = z.object({
  id: z.string(),
  kind: z.enum(["image", "video", "file"]).describe("A picture, a video or a downloadable file"),
  name: z.string(),
  type: z.string(),
  bytes: z.number().int(),
  width: z.number().int().nullable(),
  height: z.number().int().nullable(),
  alt: z.string().nullable(),
  state: z
    .enum(["uploading", "processing", "ready", "failed"])
    .nullable()
    .describe("A video: uploading, processing (Stream is encoding it), ready to play, or failed"),
  stateReason: z.string().nullable().describe("A failed video: Stream's reason"),
  duration: z.number().nullable().describe("A video's length in seconds"),
  createdAt: z.string(),
  createdBy: z.string().nullable(),
});
type MediaOut = z.infer<typeof mediaOut>;

export interface MediaRow {
  id: string;
  kind: "image" | "video" | "file";
  name: string;
  type: string;
  bytes: number;
  width: number | null;
  height: number | null;
  alt: string | null;
  stream_uid: string | null;
  state: "uploading" | "processing" | "ready" | "failed" | null;
  state_reason: string | null;
  duration: number | null;
  created_at: string;
  created_by: string | null;
  key: string | null;
}

export const out = (row: MediaRow): MediaOut => ({
  id: row.id,
  kind: row.kind ?? "image",
  name: row.name,
  type: row.type,
  bytes: Number(row.bytes),
  width: row.width === null ? null : Number(row.width),
  height: row.height === null ? null : Number(row.height),
  alt: row.alt,
  state: row.state ?? null,
  stateReason: row.state_reason ?? null,
  duration: row.duration === null || row.duration === undefined ? null : Number(row.duration),
  createdAt: row.created_at,
  createdBy: row.created_by,
});

/** A live media item, through the seam. */
export async function liveMedia(ctx: Reader, id: string): Promise<MediaRow | null> {
  return ((await ctx.db
    .selectFrom(visibleSource(ctx, mediaObject))
    .selectAll()
    .where("id", "=", id)
    .executeTakeFirst()) ?? null) as MediaRow | null;
}

export async function requireMedia(ctx: HandlerContext, id: string): Promise<MediaRow> {
  const row = await liveMedia(ctx, id);
  if (!row) throw new NotFoundError("media", id);
  return row;
}

const altText = z
  .string()
  .trim()
  .max(500)
  .refine((v) => !/<[A-Za-z!/?]|&(?:#[0-9]+|#[xX][0-9A-Fa-f]+|[A-Za-z][A-Za-z0-9]*);/.test(v), {
    message: "Alt text is words, not markup",
  });
const mediaName = z.string().trim().min(1).max(200);

export const mediaUpload = defineOperation({
  name: "media.upload",
  description:
    "Store a picture or a downloadable file a person uploaded in the media library: a picture " +
    "is JPEG, PNG, GIF, WebP or AVIF, at most 10 MB; a file is a PDF, at most 50 MB; the type is " +
    "read from the file, never its name. The file comes from the upload route, not from this " +
    "input. A video is not uploaded here (media.videoUpload). Returns the item, which rich " +
    "text, image fields and documents name by id.",
  input: z.object({
    name: mediaName.describe("The file's name, for the library"),
    alt: altText.optional().describe("What the picture shows"),
  }),
  output: mediaOut.extend({
    existing: z.boolean().describe("The library had this file already: that item, not a new one"),
  }),
  permission: "records:write",
  risk: "write",
  actors: ["human"],
  mcp: { expose: false },
  async handler(input, ctx) {
    const bytes = ctx.upload?.bytes;
    if (!bytes) {
      throw new ValidationError("Upload the file itself to /api/media: this takes no file", {
        reason: "no_file",
      });
    }
    if (bytes.byteLength === 0) throw new ValidationError("The file is empty", { reason: "empty" });
    if (bytes.byteLength > MEDIA_FILE_MAX_BYTES) {
      throw new ValidationError(
        `The file is ${bytes.byteLength} bytes; a file is at most ${MEDIA_FILE_MAX_BYTES}`,
        {
          reason: "too_large",
          bytes: bytes.byteLength,
          max: MEDIA_FILE_MAX_BYTES,
          httpStatus: 413,
        },
      );
    }
    const sniffed = sniffUpload(bytes);
    if (!sniffed) {
      throw new ValidationError(
        "This is not a file the library takes: a picture (JPEG, PNG, GIF, WebP or AVIF) or a PDF",
        { reason: "type" },
      );
    }
    const { kind, type } = sniffed;
    const max = maxBytesOf(kind);
    if (bytes.byteLength > max) {
      throw new ValidationError(
        `The file is ${bytes.byteLength} bytes; a ${kind === "image" ? "picture" : "file"} is at most ${max}`,
        { reason: "too_large", bytes: bytes.byteLength, max, httpStatus: 413 },
      );
    }
    // The same file again (a re-run of an import): the item the library has, nothing stored.
    const sha256 = await sha256Hex(new Uint8Array(bytes));
    const same = await liveByHash(ctx, [sha256]);
    if (same[0]) return { ...out(same[0]), existing: true };
    if (!ctx.media) throw new OperationError("config", "Media storage is not configured here");
    const { width, height } =
      sniffed.kind === "image"
        ? mediaDimensions(bytes, sniffed.type)
        : { width: null, height: null };
    const id = newId("media");
    const key = `${MEDIA_PREFIX}${id}`;
    // A dry run stores nothing; a real call stores the original before its row commits (a batch
    // that then fails leaves an object no row names, never a row with no object).
    if (!ctx.simulation) await ctx.media.put(key, bytes, type);
    const row = {
      id,
      kind,
      key,
      name: input.name,
      type,
      bytes: bytes.byteLength,
      width,
      height,
      alt: input.alt ?? null,
      created_at: ctx.now,
      created_by: ctx.user.id,
      updated_at: ctx.now,
      updated_by: ctx.user.id,
      sha256,
    };
    ctx.write(ctx.db.insertInto("core_media").values(row));
    const result = out({
      ...row,
      stream_uid: null,
      state: null,
      state_reason: null,
      duration: null,
    });
    ctx.recordChange({ object: "media", id, action: "create", after: { ...result } });
    return { ...result, existing: false };
  },
});

/** The live items with these hashes, through the seam's staff table door. */
async function liveByHash(
  ctx: HandlerContext,
  hashes: string[],
): Promise<(MediaRow & { sha256: string })[]> {
  if (!hashes.length) return [];
  return (await ctx.db
    .selectFrom(visibleTable(ctx, mediaObject))
    .selectAll()
    .where(sql<SqlBool>`deleted_at IS NULL`)
    .where("sha256", "in", hashes)
    .execute()) as unknown as (MediaRow & { sha256: string })[];
}

export const mediaFindByHash = defineOperation({
  name: "media.findByHash",
  description:
    "Which of these files the media library has already, by the SHA-256 of their bytes (hex): " +
    "the item for each one it has. An import asks this before uploading, so a re-run uploads " +
    "nothing twice. Read-only.",
  input: z.object({
    sha256: z
      .array(z.string().regex(/^[0-9a-f]{64}$/))
      .min(1)
      .max(200),
  }),
  output: z.object({ items: z.array(mediaOut.extend({ sha256: z.string() })) }),
  permission: "records:read",
  risk: "read",
  mcp: { idempotent: true },
  async handler(input, ctx) {
    const rows = await liveByHash(ctx, [...new Set(input.sha256)]);
    return { items: rows.map((row) => ({ ...out(row), sha256: row.sha256 })) };
  },
});

export const mediaList = defineOperation({
  name: "media.list",
  description:
    "The media library, newest first: each picture's name, type, size, dimensions and alt " +
    "text. Filter and sort on those; pass nextCursor back as cursor. Read-only.",
  input: z.object({
    filter: filterSchema.optional(),
    sort: sortSchema.optional(),
    cursor: z.string().max(1000).optional(),
    limit: z.number().int().min(1).max(LIST_MAX_LIMIT).default(50),
  }),
  output: z.object({
    items: z.array(
      z.object({ object: z.string(), id: z.string(), values: z.record(z.string(), z.unknown()) }),
    ),
    nextCursor: z.string().nullable(),
  }),
  permission: "records:read",
  risk: "read",
  mcp: { idempotent: true },
  async handler(input, ctx) {
    const page = await listVisible(ctx, mediaObject, input);
    return { items: page.items, nextCursor: page.nextCursor };
  },
});

export const mediaGet = defineOperation({
  name: "media.get",
  description: "One picture of the media library. Read-only.",
  input: z.object({ id: mediaId }),
  output: mediaOut,
  permission: "records:read",
  risk: "read",
  mcp: { idempotent: true },
  async handler(input, ctx) {
    return out(await requireMedia(ctx, input.id));
  },
});

export const mediaUpdate = defineOperation({
  name: "media.update",
  description: "Change a picture's name or alt text. The picture itself never changes.",
  input: z.object({ id: mediaId, name: mediaName.optional(), alt: altText.nullable().optional() }),
  output: mediaOut,
  permission: "records:write",
  risk: "write",
  async handler(input, ctx) {
    const before = await requireMedia(ctx, input.id);
    const set = {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.alt !== undefined ? { alt: input.alt } : {}),
    };
    if (!Object.keys(set).length) return out(before);
    ctx.write(
      ctx.db
        .updateTable("core_media")
        .set({ ...set, updated_at: ctx.now, updated_by: ctx.user.id })
        .where("id", "=", input.id)
        .where("deleted_at", "is", null),
    );
    const after = { ...before, ...set };
    ctx.recordChange({
      object: "media",
      id: input.id,
      action: "update",
      before: { name: before.name, alt: before.alt },
      after: { name: after.name, alt: after.alt },
    });
    return out(after);
  },
});

export const mediaDelete = defineOperation({
  name: "media.delete",
  description:
    "Move a picture to the Trash. Published content that shows it stops showing it to the " +
    "public; it can be restored for 30 days, after which the purge deletes the file.",
  input: z.object({ id: mediaId }),
  output: z.object({ id: z.string() }),
  permission: "records:write",
  risk: "destructive",
  async handler(input, ctx) {
    await requireMedia(ctx, input.id);
    ctx.write(
      ctx.db
        .updateTable("core_media")
        .set({ deleted_at: ctx.now, deleted_by: ctx.user.id })
        .where("id", "=", input.id)
        .where("deleted_at", "is", null),
    );
    ctx.recordChange({ object: "media", id: input.id, action: "delete", diff: {} });
    return { id: input.id };
  },
});

export const mediaRestore = defineOperation({
  name: "media.restore",
  description: "Bring a picture back from the Trash (within 30 days of its deletion).",
  input: z.object({ id: mediaId }),
  output: mediaOut,
  permission: "records:write",
  risk: "write",
  async handler(input, ctx) {
    const row = (await ctx.db
      .selectFrom(visibleTable(ctx, mediaObject))
      .selectAll()
      .where("id", "=", input.id)
      .executeTakeFirst()) as (MediaRow & { deleted_at: string | null }) | undefined;
    if (!row) throw new NotFoundError("media", input.id);
    if (row.deleted_at === null) throw new ValidationError(`${input.id} is not in Trash`);
    ctx.write(
      ctx.db
        .updateTable("core_media")
        .set({ deleted_at: null, deleted_by: null })
        .where("id", "=", input.id),
    );
    ctx.recordChange({ object: "media", id: input.id, action: "restore", diff: {} });
    return out(row);
  },
});

/** The answer for an item the caller may not be served: the same, whatever the reason. */
export const notServed = () => new OperationError("not_found", "Not found", { object: "media" });

/** Narrows `outsiderShown` to one record, or one field of it. */
export interface ShownWithin {
  object?: string | undefined;
  record?: string | undefined;
  field?: string | undefined;
}

/**
 * Whether someone outside the org may be shown a media item (stage 28, ADR 0444; stage 42,
 * ADR 0477): only while a record they may read now shows it, in its current version, in a field
 * their scope lets them read, and in a part of that field they read. A `private` part is no
 * outsider's; a `holders` part is only a holder's, by the seam's one question (`holdsAccess`).
 * One read per object that uses the item, however many records do, and the access question once
 * for the records that show it to holders only.
 */
export async function outsiderShown(
  ctx: HandlerContext,
  caller: Reader["principal"],
  mediaId: string,
  within: ShownWithin = {},
): Promise<boolean> {
  const reader: Reader = { db: ctx.db, principal: caller };
  let objects = ctx.db
    .selectFrom("core_published_media")
    .select("object_type")
    .distinct()
    .where("media_id", "=", mediaId)
    .where("reach", "in", ["all", "holders"]);
  if (within.object) objects = objects.where("object_type", "=", within.object);
  if (within.record) objects = objects.where("record_id", "=", within.record);
  if (within.field) objects = objects.where("field", "=", within.field);
  const db = ctx.db as unknown as Kysely<Record<string, Record<string, unknown>>>;
  for (const { object_type } of await objects.execute()) {
    const definition = getObject(object_type);
    if (!definition) continue;
    let visible: ObjectDefinition;
    try {
      visible = visibleObject(reader, definition);
    } catch {
      continue; // An object the caller reads nothing of.
    }
    const readable = visible.fields
      .map((f) => f.name)
      .filter((name) => name !== "id" && (!within.field || name === within.field));
    if (!readable.length) continue;
    const uses = (reach: "all" | "holders") => {
      let q = ctx.db
        .selectFrom("core_published_media")
        .select("record_id")
        .where("media_id", "=", mediaId)
        .where("object_type", "=", object_type)
        .where("field", "in", readable)
        .where("reach", "=", reach);
      if (within.record) q = q.where("record_id", "=", within.record);
      return q;
    };
    // Shown to everyone who reads the field: one record they read is enough.
    const open = await db
      .selectFrom(visibleSource(reader, visible))
      .select("id")
      .where("id", "in", uses("all"))
      .limit(1)
      .executeTakeFirst();
    if (open) return true;
    // Shown to holders only: a record they read and hold access to.
    if (!definition.access || caller.kind !== "customer") continue;
    const candidates = (
      await db
        .selectFrom(visibleSource(reader, visible))
        .select("id")
        .where("id", "in", uses("holders"))
        .limit(100)
        .execute()
    ).map((r) => String(r.id));
    if (candidates.length && (await holdsAccess(reader, definition, candidates)).size) return true;
  }
  return false;
}

export const mediaServe = defineOperation({
  name: "media.serve",
  description:
    "Whether the caller may be served one picture or downloadable file, and at what width: " +
    "staff any live one; a customer or the public only one that a published record they may " +
    "read shows in a part they may read. Anything else is not found, and so is a video (it " +
    "plays with media.play). The media route (`/api/media/<id>`) streams it. Read-only.",
  input: z.object({
    id: mediaId,
    width: z.number().int().min(1).max(10_000).optional().describe("The width asked for"),
  }),
  output: z.object({
    id: z.string(),
    key: z.string(),
    type: z.string(),
    bytes: z.number().int(),
    width: z.number().int().nullable().describe("The width to serve; null for the original"),
    public: z.boolean().describe("Served because published content shows it"),
  }),
  permission: "records:read",
  risk: "read",
  audiences: ["staff", "customer", "public"],
  // A page shows many pictures: the asset tier (ADR 0940).
  publicLimit: { tier: "asset" },
  // It reads which records reference the item (core_published_media) beside the records.
  hostInternal: true,
  mcp: { expose: false },
  async handler(input, ctx) {
    const caller = ctx.onBehalfOf ?? ctx.principal;
    // The item itself is read org-wide (outsiders read no media record): whether to serve it is
    // decided below, from the records the caller reads.
    const row = await liveMedia(orgReader(ctx.db), input.id);
    // A video is never in R2: it plays with a token (media.play) and is never served.
    if (!row || !row.key || row.kind === "video") throw notServed();
    const key = row.key;
    const answer = (isPublic: boolean) => ({
      id: row.id,
      key,
      type: row.type,
      bytes: Number(row.bytes),
      width: row.kind === "image" ? servedWidth(input.width ?? null) : null,
      public: isPublic,
    });
    if (caller.kind === "staff") return answer(false);
    if (await outsiderShown(ctx, caller, input.id)) return answer(true);
    throw notServed();
  },
});

export const mediaOperations = [
  mediaUpload,
  mediaFindByHash,
  mediaList,
  mediaGet,
  mediaUpdate,
  mediaDelete,
  mediaRestore,
  mediaServe,
] as const;
