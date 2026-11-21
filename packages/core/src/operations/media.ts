// The media library (stage 28, ADR 0444): pictures staff upload, which rich text and `image`
// fields name by id, and which the public is served only while published content references
// them.
//
//   media.upload   a person          store an uploaded picture (bytes from the upload route)
//   media.list     staff             the library, newest first
//   media.get      staff             one item
//   media.update   staff             its name and alt text
//   media.delete   staff             to the Trash (the purge deletes its R2 object)
//   media.restore  staff             back from the Trash
//   media.serve    anyone            may this caller be served this picture, and how
//
// The bytes never pass through an operation's input: the upload route (`/api/media`, cos-app)
// reads the request's body and hands it to `media.upload` as `ctx.upload`, so no MCP client,
// import or extension can store a file, and the audit log holds what was stored, not the file.
import type { Kysely } from "kysely";
import { z } from "zod";
import { NotFoundError, OperationError, ValidationError } from "../errors.ts";
import { getObject } from "../fields/index.ts";
import { mediaObject } from "../fields/media.ts";
import type { ObjectDefinition } from "../fields/types.ts";
import { filterSchema } from "../filter.ts";
import { newId } from "../ids.ts";
import { LIST_MAX_LIMIT, sortSchema } from "../list.ts";
import { defineOperation, type HandlerContext } from "../operation.ts";
import {
  MEDIA_MAX_BYTES,
  MEDIA_PREFIX,
  mediaDimensions,
  servedWidth,
  sniffMediaType,
} from "../records/media.ts";
import {
  orgReader,
  type Reader,
  visibleObject,
  visibleSource,
  visibleTable,
} from "../visibility/index.ts";
import { listVisible } from "../visibility/records.ts";

const mediaId = z.string().min(1).max(64).describe("A media item's id");

const mediaOut = z.object({
  id: z.string(),
  name: z.string(),
  type: z.string(),
  bytes: z.number().int(),
  width: z.number().int().nullable(),
  height: z.number().int().nullable(),
  alt: z.string().nullable(),
  createdAt: z.string(),
  createdBy: z.string().nullable(),
});
type MediaOut = z.infer<typeof mediaOut>;

interface MediaRow {
  id: string;
  name: string;
  type: string;
  bytes: number;
  width: number | null;
  height: number | null;
  alt: string | null;
  created_at: string;
  created_by: string | null;
  key: string;
}

const out = (row: MediaRow): MediaOut => ({
  id: row.id,
  name: row.name,
  type: row.type,
  bytes: Number(row.bytes),
  width: row.width === null ? null : Number(row.width),
  height: row.height === null ? null : Number(row.height),
  alt: row.alt,
  createdAt: row.created_at,
  createdBy: row.created_by,
});

/** A live media item, through the seam. */
async function liveMedia(ctx: Reader, id: string): Promise<MediaRow | null> {
  return ((await ctx.db
    .selectFrom(visibleSource(ctx, mediaObject))
    .selectAll()
    .where("id", "=", id)
    .executeTakeFirst()) ?? null) as MediaRow | null;
}

async function requireMedia(ctx: HandlerContext, id: string): Promise<MediaRow> {
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
    "Store a picture a person uploaded in the media library (JPEG, PNG, GIF, WebP or AVIF, at " +
    "most 10 MB; the type is read from the file, never its name). The file comes from the " +
    "upload route, not from this input. Returns the item, which rich text and image fields " +
    "name by id.",
  input: z.object({
    name: mediaName.describe("The file's name, for the library"),
    alt: altText.optional().describe("What the picture shows"),
  }),
  output: mediaOut,
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
    if (bytes.byteLength > MEDIA_MAX_BYTES) {
      throw new ValidationError(
        `The file is ${bytes.byteLength} bytes; a picture is at most ${MEDIA_MAX_BYTES}`,
        { reason: "too_large", bytes: bytes.byteLength, max: MEDIA_MAX_BYTES },
      );
    }
    const type = sniffMediaType(bytes);
    if (!type) {
      throw new ValidationError(
        "This is not a picture the library takes: JPEG, PNG, GIF, WebP or AVIF",
        { reason: "type" },
      );
    }
    if (!ctx.media) throw new OperationError("config", "Media storage is not configured here");
    const { width, height } = mediaDimensions(bytes, type);
    const id = newId("media");
    const key = `${MEDIA_PREFIX}${id}`;
    // A dry run stores nothing; a real call stores the original before its row commits (a batch
    // that then fails leaves an object no row names, never a row with no object).
    if (!ctx.simulation) await ctx.media.put(key, bytes, type);
    const row = {
      id,
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
    };
    ctx.write(ctx.db.insertInto("core_media").values(row));
    const result = out(row);
    ctx.recordChange({ object: "media", id, action: "create", after: { ...result } });
    return result;
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

/** The answer for a picture the caller may not be served: the same, whatever the reason. */
const notServed = () => new OperationError("not_found", "Not found", { object: "media" });

export const mediaServe = defineOperation({
  name: "media.serve",
  description:
    "Whether the caller may be served one picture, and at what width: staff any live one; a " +
    "customer or the public only one that a published record they may read shows. Anything " +
    "else is not found. The media route (`/api/media/<id>`) streams it. Read-only.",
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
  // It reads which records reference the item (core_published_media) beside the records.
  hostInternal: true,
  mcp: { expose: false },
  async handler(input, ctx) {
    const caller = ctx.onBehalfOf ?? ctx.principal;
    // The item itself is read org-wide (outsiders read no media record): whether to serve it is
    // decided below, from the records the public reads.
    const row = await liveMedia(orgReader(ctx.db), input.id);
    if (!row) throw notServed();
    const answer = (isPublic: boolean) => ({
      id: row.id,
      key: row.key,
      type: row.type,
      bytes: Number(row.bytes),
      width: servedWidth(input.width ?? null),
      public: isPublic,
    });
    if (caller.kind === "staff") return answer(false);
    // Outsiders: only while a record they may read now shows it in a field they may read (its
    // current version names it there, and the record is in their source: published, live,
    // meeting its `when`). One read per object that uses it, however many records do.
    const reader: Reader = { db: ctx.db, principal: caller };
    const objects = await ctx.db
      .selectFrom("core_published_media")
      .select("object_type")
      .distinct()
      .where("media_id", "=", input.id)
      .execute();
    for (const { object_type } of objects) {
      const definition = getObject(object_type);
      if (!definition) continue;
      let visible: ObjectDefinition;
      try {
        visible = visibleObject(reader, definition);
      } catch {
        continue; // An object the caller reads nothing of.
      }
      const readable = visible.fields.map((f) => f.name).filter((name) => name !== "id");
      if (!readable.length) continue;
      const shown = await (ctx.db as unknown as Kysely<Record<string, Record<string, unknown>>>)
        .selectFrom(visibleSource(reader, visible))
        .select("id")
        .where(
          "id",
          "in",
          ctx.db
            .selectFrom("core_published_media")
            .select("record_id")
            .where("media_id", "=", input.id)
            .where("object_type", "=", object_type)
            .where("field", "in", readable),
        )
        .limit(1)
        .executeTakeFirst();
      if (shown) return answer(true);
    }
    throw notServed();
  },
});

export const mediaOperations = [
  mediaUpload,
  mediaList,
  mediaGet,
  mediaUpdate,
  mediaDelete,
  mediaRestore,
  mediaServe,
] as const;
