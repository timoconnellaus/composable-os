// Record files (stage 56 step 3, ADR 0834): a photo or a PDF attached to a note about a client.
// Staff only (none is open to a customer or the public, ADR 0402; a customer's upload is step 6),
// a person only (no AI actor uploads, is served a file's bytes, or deletes one), and not on MCP:
//
//   file.checkUpload    staff (records:write)   may this upload go ahead: asked before its bytes
//   file.upload         staff (records:write)   store an uploaded file (bytes from the route)
//   file.serve          staff (records:read)    may the caller be served this file now, and how
//   file.delete         staff (records:write)   remove a file from its note, at once
//   file.storage.get    staff (notes:manage)    how much the files take, and the cap
//   file.storage.setCap staff (settings:manage) change the cap
//
// A file's readers are exactly its note's, at every moment: `file.serve` reads the note through
// the visibility seam on every call (its level, a private activity's owner, the Trash), so a file
// of a note the caller may not read, of a note in the Trash, of no note yet, or of no file at all
// is the one not-found. Serves of a file on a `coaches` or `sensitive` note are audited, ids only.
//
// The bytes never pass through an operation's input: the route (`/api/files`, http/files.ts)
// reads the body and hands it to `file.upload` as `ctx.upload`, as `media.upload` does. They are
// stored in R2 after the file's row commits (a batch that fails stores nothing), so no object is
// ever left that no row names; an upload never attached to its note is purged the next day.
// The audit log holds a file's id, type and size, never its name or its bytes.
import type { CoreDatabase } from "@composable-os/db";
import {
  RECORD_FILE_MAX_BYTES,
  RECORD_FILE_TYPES,
  RECORD_FILES_PER_NOTE,
  recordFileMaxBytes,
  sniffRecordFile,
} from "@composable-os/sdk";
import { type Kysely, sql } from "kysely";
import { z } from "zod";
import { sha256Hex } from "../digest.ts";
import { ForbiddenError, NotFoundError, OperationError, ValidationError } from "../errors.ts";
import { newId } from "../ids.ts";
import { notifyStatements } from "../notifications/send.ts";
import { defineOperation, type HandlerContext } from "../operation.ts";
import {
  DEFAULT_FILES_CAP_BYTES,
  downloadName,
  FILES_PREFIX,
  FILES_SETTING,
  prepareRecordFile,
  type RecordFileRow,
  recordFileOut,
  recordFileSchema,
  STAGED_FILE_HOURS,
  STAGED_FILES_PER_UPLOADER,
} from "../records/files.ts";
import { type Activity, assertMayChange, levelOf, loadActivity } from "./activity.ts";
import { loadNoteKind } from "./note-kind.ts";

const fileId = z.string().startsWith("fil_").max(64).describe("A record file's id (fil_…)");
const noteId = z.string().startsWith("act_").max(64).describe("The note (act_…)");

/** The one answer for a file the caller may not have: the same, whatever the reason. */
export const fileNotFound = () => new OperationError("not_found", "Not found", { object: "file" });

/** The cap a human admin set, or the default. */
export async function filesCapBytes(db: Kysely<CoreDatabase>): Promise<number> {
  const row = await db
    .selectFrom("core_settings")
    .select("value")
    .where("key", "=", FILES_SETTING)
    .executeTakeFirst();
  try {
    const cap = row ? (JSON.parse(row.value) as { capBytes?: unknown }).capBytes : undefined;
    return typeof cap === "number" && Number.isInteger(cap) && cap > 0
      ? cap
      : DEFAULT_FILES_CAP_BYTES;
  } catch {
    return DEFAULT_FILES_CAP_BYTES;
  }
}

/** What every record file takes now, from the size index. */
async function filesUsage(db: Kysely<CoreDatabase>): Promise<{ bytes: number; files: number }> {
  const row = await db
    .selectFrom("core_record_file")
    .select([sql<number>`coalesce(sum(bytes), 0)`.as("bytes"), sql<number>`count(*)`.as("files")])
    .executeTakeFirst();
  return { bytes: Number(row?.bytes ?? 0), files: Number(row?.files ?? 0) };
}

/** A guard row for the batch: it fails whole, naming `rule`, when `ok` is false at commit. */
function fileGuard(rule: "cap" | "note" | "staged", ok: ReturnType<typeof sql>) {
  return sql`INSERT INTO core_record_file_guard (rule, ok) SELECT ${rule}, ${ok}`;
}

const storageFull = (cap: number) =>
  new ValidationError(
    "The business's file storage is full: nothing was stored. An admin can make room or raise the limit in Settings → Notes",
    { reason: "storage_full", cap, httpStatus: 413 },
  );

/**
 * The note an upload goes on, checked: the caller may read it (the seam) and change it (its
 * author, or notes:manage), it is a note of a kind that takes files, not a conversation's, and
 * has room for one more.
 */
async function noteForFiles(ctx: HandlerContext, id: string, adding: number): Promise<Activity> {
  const note = await loadActivity(ctx, id, { unlock: true });
  if (note?.type !== "note" || (note.private && note.authorUserId !== ctx.user.id)) {
    throw new NotFoundError("activity", id);
  }
  if (note.conversationId) {
    throw new ValidationError("A note in a conversation takes no files", { field: "note" });
  }
  assertMayChange(ctx, note);
  await assertKindTakesFiles(ctx, note.kind?.id);
  const held = await ctx.db
    .selectFrom("core_record_file")
    .select(sql<number>`count(*)`.as("n"))
    .where("note_id", "=", id)
    .executeTakeFirst();
  if (Number(held?.n ?? 0) + adding > RECORD_FILES_PER_NOTE) {
    throw new ValidationError(`A note has at most ${RECORD_FILES_PER_NOTE} files`, {
      reason: "too_many",
      max: RECORD_FILES_PER_NOTE,
    });
  }
  return note;
}

/** A kind that does not take files refuses them (Settings → Notes, ADR 0833). */
export async function assertKindTakesFiles(
  ctx: HandlerContext,
  kindId: string | undefined,
): Promise<void> {
  const kind = kindId ? await loadNoteKind(ctx, kindId) : null;
  if (!kind?.filesAllowed) {
    throw new ValidationError(
      "Notes of this kind take no files: an admin can allow them in Settings → Notes",
      { field: "files", rule: "kind_no_files" },
    );
  }
}

/** The uploads waiting for their note that this account holds now. */
async function stagedCount(ctx: HandlerContext): Promise<number> {
  const row = await ctx.db
    .selectFrom("core_record_file")
    .select(sql<number>`count(*)`.as("n"))
    .where("note_id", "is", null)
    .where("uploaded_by", "=", ctx.user.id)
    .where("created_at", ">=", stagedSince(ctx.now))
    .executeTakeFirst();
  return Number(row?.n ?? 0);
}

const stagedSince = (now: string) =>
  new Date(Date.parse(now) - STAGED_FILE_HOURS * 3_600_000).toISOString();

/**
 * Everything an upload is held to except its bytes: the note (when given), the account's uploads
 * waiting for their note, and the storage cap. Asked before the route reads the body (with the
 * size it was told) and again once the bytes are in (with their stored size).
 */
async function assertMayUpload(
  ctx: HandlerContext,
  note: string | undefined,
  size: number,
): Promise<{ note: Activity | null; cap: number; used: number }> {
  const found = note ? await noteForFiles(ctx, note, 1) : null;
  if (!found && (await stagedCount(ctx)) >= STAGED_FILES_PER_UPLOADER) {
    throw new ValidationError(
      `At most ${STAGED_FILES_PER_UPLOADER} files wait for their note at once: save the note first`,
      { reason: "too_many", max: STAGED_FILES_PER_UPLOADER },
    );
  }
  const cap = await filesCapBytes(ctx.db);
  const used = (await filesUsage(ctx.db)).bytes;
  if (used + size > cap) throw storageFull(cap);
  return { note: found, cap, used };
}

const nameSchema = z.string().trim().min(1).max(200).describe("The file's name, as uploaded");

export const fileCheckUpload = defineOperation({
  name: "file.checkUpload",
  description:
    "Whether an upload of a file of this size may go ahead: onto this note (its author or " +
    "someone allowed to manage notes, a kind that takes files, at most 20 files a note), or " +
    "waiting for a note not yet saved; and within the business's storage. The upload route asks " +
    "it before reading the file. Read-only.",
  input: z.object({
    note: noteId.optional(),
    bytes: z.number().int().min(0).describe("The size the upload says it is"),
  }),
  output: z.object({ ok: z.literal(true) }),
  permission: "records:write",
  risk: "read",
  actors: ["human"],
  mcp: { expose: false },
  async handler(input, ctx) {
    if (input.bytes > RECORD_FILE_MAX_BYTES) {
      throw new ValidationError(`A file is at most ${RECORD_FILE_MAX_BYTES} bytes`, {
        reason: "too_large",
        max: RECORD_FILE_MAX_BYTES,
        httpStatus: 413,
      });
    }
    await assertMayUpload(ctx, input.note, input.bytes);
    return { ok: true as const };
  },
});

export const fileUpload = defineOperation({
  name: "file.upload",
  description:
    "Store a photo or PDF a person uploaded to attach to a note: a JPEG, PNG or WebP picture " +
    "(at most 10 MB) or a PDF (at most 20 MB), typed from its bytes, never its name; location, " +
    "camera and other metadata are removed from a picture before it is kept. With a note, it is " +
    "attached to that note at once (its author or someone allowed to manage notes; a kind that " +
    "takes files; at most 20 a note). Without one, it waits for the note it goes with " +
    "(activity.log's files) and is deleted if no note takes it within a day. The file comes " +
    "from the upload route, not from this input. A person only.",
  input: z.object({ name: nameSchema, note: noteId.optional() }),
  output: recordFileSchema.extend({ note: z.string().nullable() }),
  permission: "records:write",
  risk: "write",
  actors: ["human"],
  mcp: { expose: false },
  // A file's name is a client's detail: never in an audit row.
  auditRedact: ["name"],
  async handler(input, ctx) {
    const bytes = ctx.upload?.bytes;
    if (!bytes) {
      throw new ValidationError("Upload the file itself to /api/files: this takes no file", {
        reason: "no_file",
      });
    }
    if (bytes.byteLength === 0) throw new ValidationError("The file is empty", { reason: "empty" });
    if (bytes.byteLength > RECORD_FILE_MAX_BYTES) {
      throw new ValidationError(`A file is at most ${RECORD_FILE_MAX_BYTES} bytes`, {
        reason: "too_large",
        max: RECORD_FILE_MAX_BYTES,
        httpStatus: 413,
      });
    }
    const type = sniffRecordFile(bytes);
    if (!type) {
      throw new ValidationError(
        "This is not a file a note takes: a JPEG, PNG or WebP picture, or a PDF",
        { reason: "type" },
      );
    }
    const max = recordFileMaxBytes(type);
    if (bytes.byteLength > max) {
      throw new ValidationError(
        `The file is ${bytes.byteLength} bytes; ${type === "application/pdf" ? "a PDF" : "a picture"} is at most ${max}`,
        { reason: "too_large", bytes: bytes.byteLength, max, httpStatus: 413 },
      );
    }
    const prepared = prepareRecordFile(bytes, type);
    if (!prepared) {
      throw new ValidationError(
        "The file is damaged or not what it starts as, so it was not kept",
        {
          reason: "type",
        },
      );
    }
    const size = prepared.bytes.byteLength;
    const { note, cap, used } = await assertMayUpload(ctx, input.note, size);
    if (!ctx.media) throw new OperationError("config", "File storage is not configured here");
    const store = ctx.media;
    const id = newId("recordFile");
    const key = `${FILES_PREFIX}${id}`;
    const row = {
      id,
      note_id: note?.id ?? null,
      key,
      name: input.name,
      type,
      bytes: size,
      width: prepared.width,
      height: prepared.height,
      sha256: await sha256Hex(new Uint8Array(prepared.bytes)),
      uploaded_by: ctx.user.id,
      created_at: ctx.now,
      attached_at: note ? ctx.now : null,
    };
    // Held at commit, whatever another upload did meanwhile: the note's room, the account's
    // waiting uploads, the cap. A batch that fails stores nothing (the bytes go after it).
    const room = note
      ? fileGuard(
          "note",
          sql`(SELECT count(*) < ${RECORD_FILES_PER_NOTE} FROM core_record_file WHERE note_id = ${note.id})`,
        )
      : fileGuard(
          "staged",
          sql`(SELECT count(*) < ${STAGED_FILES_PER_UPLOADER} FROM core_record_file WHERE note_id IS NULL AND uploaded_by = ${ctx.user.id} AND created_at >= ${stagedSince(ctx.now)})`,
        );
    ctx.write(
      room.compile(ctx.db),
      fileGuard(
        "cap",
        sql`(SELECT coalesce(sum(bytes), 0) + ${size} <= ${cap} FROM core_record_file)`,
      ).compile(ctx.db),
      ctx.db.insertInto("core_record_file").values(row),
    );
    ctx.recordChange({
      object: "recordFile",
      id,
      action: "create",
      after: { note: row.note_id, type, bytes: size },
      restricted: true,
    });
    // Admins are told when the files pass nine tenths of the cap: once a day while they do.
    if (used + size >= cap * 0.9) {
      const plan = await notifyStatements(
        ctx.db,
        {
          to: [{ role: "admin" }],
          type: "system.message",
          title: "File storage is nearly full",
          body:
            "Files attached to notes take nine tenths or more of the storage limit. When it is " +
            "full, uploads are refused. See the totals and the limit in Settings → Notes.",
          dedupeKey: `files.storage:${ctx.now.slice(0, 10)}`,
          source: { actor: "system" },
        },
        ctx.now,
      );
      ctx.write(...plan.statements);
    }
    return ctx.afterCommit(async () => {
      // Stored once its row commits: a failed batch leaves nothing in R2. A failed store leaves
      // the row named by no one, deleted here (or by the purge, if this isolate ends first).
      if (!ctx.simulation) {
        try {
          await store.put(key, prepared.bytes, type);
        } catch (error) {
          await ctx.db
            .deleteFrom("core_record_file")
            .where("id", "=", id)
            .execute()
            .catch(() => {});
          throw new OperationError("internal", "The file could not be stored: try again", {
            cause: error instanceof Error ? error.name : "error",
          });
        }
      }
      return { ...recordFileOut(row), note: row.note_id };
    });
  },
});

export const fileServe = defineOperation({
  name: "file.serve",
  description:
    "Whether the caller may be served one record file now, and how: only a person who may read " +
    "the note it is attached to, at this moment (its level, a private note's owner), and never " +
    "a note in the Trash. Anything else is not found. Serves of a file on a note kept from the " +
    "whole staff are recorded in the audit log. The file route (`/api/files/<id>`) streams it. " +
    "Read-only.",
  input: z.object({ id: fileId }),
  output: z.object({
    id: z.string(),
    key: z.string(),
    type: z.enum(RECORD_FILE_TYPES),
    bytes: z.number().int(),
    filename: z.string().describe("The name to save it under, ending in its type's extension"),
  }),
  permission: "records:read",
  risk: "read",
  actors: ["human"],
  mcp: { expose: false },
  async handler(input, ctx) {
    const row = (await ctx.db
      .selectFrom("core_record_file")
      .select(["id", "note_id", "key", "name", "type", "bytes"])
      .where("id", "=", input.id)
      .where("note_id", "is not", null)
      .executeTakeFirst()) as
      | Pick<RecordFileRow, "id" | "note_id" | "key" | "name" | "type" | "bytes">
      | undefined;
    if (!row?.note_id) throw fileNotFound();
    // Its note, through the seam, now: its level and the caller's rights, a private activity's
    // owner, the Trash. Not readable: the same not-found as no file at all.
    const note = await loadActivity(ctx, row.note_id);
    if (note?.type !== "note" || (note.private && note.authorUserId !== ctx.user.id)) {
      throw fileNotFound();
    }
    if (levelOf(note) !== "staff") ctx.auditRead?.({ files: [row.id], notes: [note.id] });
    return {
      id: row.id,
      key: row.key,
      type: row.type,
      bytes: Number(row.bytes),
      filename: downloadName(row.name, row.type),
    };
  },
});

export const fileDelete = defineOperation({
  name: "file.delete",
  description:
    "Remove a file from its note, at once and for good (it does not go to the Trash): its " +
    "note's author or someone allowed to manage notes, or the person who uploaded it while it " +
    "waits for its note. A person only. Returns the file's id.",
  input: z.object({ id: fileId }),
  output: z.object({ id: z.string() }),
  permission: "records:write",
  risk: "destructive",
  actors: ["human"],
  mcp: { expose: false },
  async handler(input, ctx) {
    const row = await ctx.db
      .selectFrom("core_record_file")
      .select(["id", "note_id", "uploaded_by"])
      .where("id", "=", input.id)
      .executeTakeFirst();
    if (!row) throw fileNotFound();
    if (row.note_id === null) {
      if (row.uploaded_by !== ctx.user.id) throw fileNotFound();
    } else {
      const note = await loadActivity(ctx, row.note_id, { unlock: true });
      if (!note || (note.private && note.authorUserId !== ctx.user.id)) throw fileNotFound();
      assertMayChange(ctx, note);
    }
    // Its R2 object is queued by trigger in this batch (migration 1233).
    ctx.write(ctx.db.deleteFrom("core_record_file").where("id", "=", row.id));
    ctx.recordChange({
      object: "recordFile",
      id: row.id,
      action: "delete",
      diff: {},
      restricted: true,
    });
    return { id: row.id };
  },
});

const storageOut = z.object({
  usedBytes: z.number().int().describe("What every file attached to notes takes"),
  files: z.number().int(),
  capBytes: z.number().int().describe("The limit: uploads past it are refused"),
});

export const fileStorageGet = defineOperation({
  name: "file.storage.get",
  description:
    "How much storage the files attached to notes take, how many there are, and the limit past " +
    "which uploads are refused. People allowed to manage notes. Read-only.",
  input: z.object({}),
  output: storageOut,
  permission: "notes:manage",
  risk: "read",
  actors: ["human"],
  mcp: { expose: false },
  async handler(_input, ctx) {
    const usage = await filesUsage(ctx.db);
    return { usedBytes: usage.bytes, files: usage.files, capBytes: await filesCapBytes(ctx.db) };
  },
});

const GB = 1024 * 1024 * 1024;

export const fileStorageSetCap = defineOperation({
  name: "file.storage.setCap",
  description:
    "Change the limit on what the files attached to notes may take, in bytes (1 GB to 10 TB; " +
    "default 10 GB). Uploads past it are refused; nothing already kept is deleted. A human " +
    "admin in the app only.",
  input: z.object({
    capBytes: z
      .number()
      .int()
      .min(GB)
      .max(10 * 1024 * GB),
  }),
  output: storageOut.extend({ previousCapBytes: z.number().int() }),
  permission: "settings:manage",
  risk: "write",
  actors: ["human"],
  mcp: { expose: false },
  async handler(input, ctx) {
    if (ctx.actor !== "human") throw new ForbiddenError("A person changes the storage limit");
    const previous = await filesCapBytes(ctx.db);
    const value = JSON.stringify({ capBytes: input.capBytes });
    ctx.write(
      ctx.db
        .insertInto("core_settings")
        .values({ key: FILES_SETTING, value, updated_at: ctx.now, updated_by: ctx.user.id })
        .onConflict((oc) =>
          oc.column("key").doUpdateSet({ value, updated_at: ctx.now, updated_by: ctx.user.id }),
        ),
    );
    ctx.recordChange({
      object: "settings",
      id: FILES_SETTING,
      action: "update",
      before: { capBytes: previous },
      after: { capBytes: input.capBytes },
    });
    const usage = await filesUsage(ctx.db);
    return {
      usedBytes: usage.bytes,
      files: usage.files,
      capBytes: input.capBytes,
      previousCapBytes: previous,
    };
  },
});

export const fileOperations = [
  fileCheckUpload,
  fileUpload,
  fileServe,
  fileDelete,
  fileStorageGet,
  fileStorageSetCap,
] as const;
