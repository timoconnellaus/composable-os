// Videos in the media library (stage 42, ADR 0475, ADR 0476): held in Cloudflare Stream on the
// deployment's own account, uploaded from the staff browser straight to Stream, and played only
// with a short-lived token the host signs for a caller the host has decided may play it.
//
//   media.videoUpload     a person   a one-time direct upload address for one video file
//   media.videoRefresh    staff      ask Stream how the video is: processing, ready or failed
//   media.captionUpload   a person   a WebVTT caption track (bytes from the upload route)
//   media.captionGenerate a person   Stream generates one, when an admin has turned that on
//   media.captionDelete   staff      remove a track
//   media.settings.get    staff      whether generated captions are on
//   media.settings.update an admin   turn them on or off (a person only)
//   media.play            anyone     a token for one video, or the one not-found
//
// The file never passes through an operation's input or a Worker body: the browser sends it to
// the address Stream gave. A record may name a video only once it is ready (record.ts).
import {
  CAPTION_LANGUAGE_RE,
  isWebVtt,
  MEDIA_CAPTION_MAX_BYTES,
  MEDIA_VIDEO_MAX_BYTES,
  MEDIA_VIDEO_MAX_SECONDS,
  MEDIA_VIDEO_TYPE,
} from "@composable-os/sdk";
import { z } from "zod";
import { NotFoundError, ValidationError } from "../errors.ts";
import { newId } from "../ids.ts";
import { defineOperation, type HandlerContext } from "../operation.ts";
import { loadSetting } from "../orders/settings.ts";
import {
  PLAYBACK_MAX_SECONDS,
  requireVideoHost,
  type StreamVideoDetails,
  UPLOAD_ADDRESS_SECONDS,
} from "../records/stream.ts";
import { orgReader } from "../visibility/index.ts";
import {
  liveMedia,
  type MediaRow,
  mediaOut,
  notServed,
  out,
  outsiderShown,
  requireMedia,
} from "./media.ts";

const mediaId = z.string().min(1).max(64).describe("A media item's id");
const language = z
  .string()
  .regex(CAPTION_LANGUAGE_RE)
  .describe("The caption's language, a BCP 47 tag: en, pt-BR");

/** The setting that lets staff ask Stream to generate captions (off until an admin turns it on). */
export const MEDIA_GENERATED_CAPTIONS_SETTING = "media_generated_captions";

async function requireVideo(
  ctx: HandlerContext,
  id: string,
): Promise<MediaRow & { stream_uid: string }> {
  const row = await requireMedia(ctx, id);
  if (row.kind !== "video" || !row.stream_uid) {
    throw new ValidationError(`${id} is not a video`, { reason: "not_video" });
  }
  return row as MediaRow & { stream_uid: string };
}

const captionOut = z.object({
  language: z.string(),
  label: z.string(),
  generated: z.boolean(),
  state: z.enum(["processing", "ready", "failed"]),
});

async function captionsOf(ctx: HandlerContext, id: string) {
  const rows = await ctx.db
    .selectFrom("core_media_caption")
    .select(["language", "label", "generated", "state"])
    .where("media_id", "=", id)
    .orderBy("language")
    .execute();
  return rows.map((r) => ({
    language: r.language,
    label: r.label,
    generated: Number(r.generated) === 1,
    state: r.state,
  }));
}

/**
 * A video's name in the library for a re-run (stage 42's import, ADR 0495): the SHA-256 the
 * uploader worked out from the file's bytes, or of the address Stream copies from. The host keeps
 * it to find the same video again (`media.findByHash`); it never trusts it as the file's type or
 * size, which are Stream's to say.
 */
const sha256Input = z
  .string()
  .regex(/^[0-9a-f]{64}$/)
  .describe("SHA-256 (hex) of the file's bytes, or of the address it is copied from");

export const mediaVideoUpload = defineOperation({
  name: "media.videoUpload",
  description:
    "Ask for a one-time address to upload one video to the media library, held in Cloudflare " +
    "Stream: the admin's browser sends the file there itself (resumable for a large file), " +
    "never through this operation. The item is `uploading` until Stream has the file, then " +
    "`processing`, and a record can show it only once it is `ready` (media.videoRefresh asks). " +
    "Every video needs a token the host signs to play. A person only.",
  input: z.object({
    name: z.string().trim().min(1).max(200).describe("The file's name, for the library"),
    bytes: z
      .number()
      .int()
      .min(1)
      .max(MEDIA_VIDEO_MAX_BYTES)
      .describe("The file's size in bytes (under 30 GB): Stream takes no more than this"),
    sha256: sha256Input.optional(),
  }),
  output: z.object({
    item: mediaOut,
    upload: z
      .object({
        url: z.string(),
        protocol: z.enum(["tus", "post"]).describe("tus: resumable PATCHes; post: one form post"),
        chunkBytes: z.number().int(),
        expiresAt: z.string(),
      })
      .nullable()
      .describe("Where to send the file; null in a dry run"),
  }),
  permission: "records:write",
  risk: "write",
  actors: ["human"],
  mcp: { expose: false },
  // The one-time address is the uploader's alone: never kept in the audit log.
  redactResult: ["url"],
  async handler(input, ctx) {
    const host = requireVideoHost();
    const id = newId("media");
    const expiresAt = new Date(Date.parse(ctx.now) + UPLOAD_ADDRESS_SECONDS * 1000).toISOString();
    // A dry run asks Stream for nothing.
    const upload = ctx.simulation
      ? null
      : await host.provider.createUpload({
          name: input.name,
          bytes: input.bytes,
          maxDurationSeconds: MEDIA_VIDEO_MAX_SECONDS,
          allowedOrigins: host.allowedOrigins,
          expiresAt,
        });
    const row = {
      id,
      kind: "video" as const,
      key: null,
      name: input.name,
      type: MEDIA_VIDEO_TYPE as "video/stream",
      bytes: input.bytes,
      width: null,
      height: null,
      alt: null,
      stream_uid: upload?.uid ?? `simulated_${id}`,
      state: "uploading" as const,
      state_reason: null,
      duration: null,
      created_at: ctx.now,
      created_by: ctx.user.id,
      updated_at: ctx.now,
      updated_by: ctx.user.id,
      sha256: input.sha256 ?? null,
    };
    ctx.write(ctx.db.insertInto("core_media").values(row));
    const item = out(row);
    // The address is one-time and not kept: the audit log holds the item, never the address.
    ctx.recordChange({ object: "media", id, action: "create", after: { ...item } });
    return {
      item,
      upload: upload
        ? { url: upload.url, protocol: upload.protocol, chunkBytes: upload.chunkBytes, expiresAt }
        : null,
    };
  },
});

export const mediaVideoFromUrl = defineOperation({
  name: "media.videoFromUrl",
  description:
    "Add a video to the media library by Stream copying it from an address (https only): a file " +
    "the old platform or a Vimeo or Wistia account serves. Stream fetches it; the item is " +
    "`processing` until Stream says ready (media.videoRefresh). Every video needs a token to " +
    "play. A person only: an import runs it (cos courses import).",
  input: z.object({
    name: z.string().trim().min(1).max(200),
    url: z
      .string()
      .url()
      .max(2000)
      .refine((u) => u.startsWith("https://"), { message: "An https address" }),
    sha256: sha256Input.optional(),
  }),
  output: z.object({ item: mediaOut }),
  permission: "records:write",
  risk: "write",
  actors: ["human"],
  mcp: { expose: false },
  async handler(input, ctx) {
    const host = requireVideoHost();
    const id = newId("media");
    const copied = ctx.simulation
      ? { uid: `simulated_${id}` }
      : await host.provider.copyFromUrl({
          url: input.url,
          name: input.name,
          allowedOrigins: host.allowedOrigins,
        });
    const row = {
      id,
      kind: "video" as const,
      key: null,
      name: input.name,
      type: MEDIA_VIDEO_TYPE as "video/stream",
      // Stream does not say the size of a copy before it has it: one byte stands for unknown.
      bytes: 1,
      width: null,
      height: null,
      alt: null,
      stream_uid: copied.uid,
      state: "processing" as const,
      state_reason: null,
      duration: null,
      created_at: ctx.now,
      created_by: ctx.user.id,
      updated_at: ctx.now,
      updated_by: ctx.user.id,
      sha256: input.sha256 ?? null,
    };
    ctx.write(ctx.db.insertInto("core_media").values(row));
    const item = out(row);
    ctx.recordChange({ object: "media", id, action: "create", after: { ...item } });
    return { item };
  },
});

/** The row's columns for what Stream says. */
function stateOf(details: StreamVideoDetails | null) {
  if (!details)
    return { state: "failed" as const, state_reason: "gone_from_stream", duration: null };
  return {
    state: details.state,
    state_reason: details.state === "failed" ? (details.reason ?? "unknown") : null,
    duration: details.duration,
    width: details.width,
    height: details.height,
  };
}

export const mediaVideoRefresh = defineOperation({
  name: "media.videoRefresh",
  description:
    "Ask Cloudflare Stream how one video is (processing, ready or failed, its length and size) " +
    "and keep the answer on the item, with its captions' states. If anything had made the video " +
    "playable without a token, it is made to require one again.",
  input: z.object({ id: mediaId }),
  output: mediaOut.extend({ captions: z.array(captionOut) }),
  permission: "records:write",
  risk: "write",
  mcp: { idempotent: true },
  async handler(input, ctx) {
    const host = requireVideoHost();
    const row = await requireVideo(ctx, input.id);
    const details = await host.provider.details(row.stream_uid);
    // Never playable without a token, whatever was done to it in Stream's dashboard.
    if (details && !details.requireSignedURLs && !ctx.simulation) {
      await host.provider.secure(row.stream_uid, host.allowedOrigins);
    }
    const next = stateOf(details);
    ctx.write(
      ctx.db
        .updateTable("core_media")
        .set({ ...next, updated_at: ctx.now, updated_by: ctx.user.id })
        .where("id", "=", row.id)
        .where("deleted_at", "is", null),
    );
    // Generated captions take a while: their states are Stream's.
    const captions = await captionsOf(ctx, row.id);
    if (captions.some((c) => c.state === "processing")) {
      const stream = await host.provider.listCaptions(row.stream_uid);
      for (const caption of captions) {
        const now = stream.find((c) => c.language === caption.language);
        const state = now?.state ?? "failed";
        if (state === caption.state) continue;
        caption.state = state;
        ctx.write(
          ctx.db
            .updateTable("core_media_caption")
            .set({ state })
            .where("media_id", "=", row.id)
            .where("language", "=", caption.language),
        );
      }
    }
    if (next.state !== row.state) {
      ctx.recordChange({
        object: "media",
        id: row.id,
        action: "update",
        before: { state: row.state },
        after: { state: next.state },
      });
    }
    return { ...out({ ...row, ...next }), captions };
  },
});

export const mediaCaptionUpload = defineOperation({
  name: "media.captionUpload",
  description:
    "Add or replace one video's caption track in a language, from a WebVTT file a person " +
    "uploaded (at most 10 MB; an .srt is converted first). The file comes from the upload " +
    "route, not from this input.",
  input: z.object({
    id: mediaId,
    language,
    label: z.string().trim().min(1).max(100).optional().describe("Shown in the player: English"),
  }),
  output: captionOut,
  permission: "records:write",
  risk: "write",
  actors: ["human"],
  mcp: { expose: false },
  async handler(input, ctx) {
    const host = requireVideoHost();
    const bytes = ctx.upload?.bytes;
    if (!bytes) {
      throw new ValidationError("Upload the caption file itself: this takes no file", {
        reason: "no_file",
      });
    }
    if (bytes.byteLength > MEDIA_CAPTION_MAX_BYTES) {
      throw new ValidationError(`A caption file is at most ${MEDIA_CAPTION_MAX_BYTES} bytes`, {
        reason: "too_large",
      });
    }
    if (!isWebVtt(bytes)) {
      throw new ValidationError("Captions are WebVTT files (they start with WEBVTT)", {
        reason: "type",
      });
    }
    const row = await requireVideo(ctx, input.id);
    if (!ctx.simulation) await host.provider.uploadCaption(row.stream_uid, input.language, bytes);
    const caption = {
      language: input.language,
      label: input.label ?? input.language,
      generated: false,
      state: "ready" as const,
    };
    writeCaption(ctx, row.id, caption);
    return caption;
  },
});

function writeCaption(
  ctx: HandlerContext,
  mediaId: string,
  caption: z.infer<typeof captionOut>,
): void {
  const values = {
    label: caption.label,
    generated: caption.generated ? 1 : 0,
    state: caption.state,
    created_at: ctx.now,
    created_by: ctx.user.id,
  };
  ctx.write(
    ctx.db
      .insertInto("core_media_caption")
      .values({ media_id: mediaId, language: caption.language, ...values })
      .onConflict((oc) => oc.columns(["media_id", "language"]).doUpdateSet(values)),
  );
  ctx.recordChange({
    object: "media",
    id: mediaId,
    action: "update",
    after: { caption: caption.language },
  });
}

export const mediaCaptionGenerate = defineOperation({
  name: "media.captionGenerate",
  description:
    "Ask Cloudflare Stream to generate a caption track for a ready video in a language it " +
    "supports. Stream charges for it, so it is refused until an admin has turned generated " +
    "captions on (media.settings.update). The track is `processing` until media.videoRefresh " +
    "finds it ready. A person only.",
  input: z.object({ id: mediaId, language }),
  output: captionOut,
  permission: "records:write",
  risk: "write",
  actors: ["human"],
  mcp: { expose: false },
  async handler(input, ctx) {
    const host = requireVideoHost();
    if (!(await loadSetting(ctx.db, MEDIA_GENERATED_CAPTIONS_SETTING, z.boolean()))) {
      throw new ValidationError(
        "Generated captions are off: an admin turns them on in the media settings",
        { reason: "generated_captions_off" },
      );
    }
    const row = await requireVideo(ctx, input.id);
    if (row.state !== "ready") {
      throw new ValidationError("Captions are generated for a ready video", {
        reason: "not_ready",
      });
    }
    const made = ctx.simulation
      ? {
          language: input.language,
          label: input.language,
          generated: true,
          state: "processing" as const,
        }
      : await host.provider.generateCaption(row.stream_uid, input.language);
    const caption = { ...made, language: input.language, generated: true };
    writeCaption(ctx, row.id, caption);
    return caption;
  },
});

export const mediaCaptionDelete = defineOperation({
  name: "media.captionDelete",
  description: "Remove one video's caption track in a language.",
  input: z.object({ id: mediaId, language }),
  output: z.object({ id: z.string(), language: z.string() }),
  permission: "records:write",
  risk: "destructive",
  async handler(input, ctx) {
    const host = requireVideoHost();
    const row = await requireVideo(ctx, input.id);
    const had = (await captionsOf(ctx, row.id)).some((c) => c.language === input.language);
    if (!had) throw new NotFoundError("caption", `${input.id}/${input.language}`);
    if (!ctx.simulation) await host.provider.deleteCaption(row.stream_uid, input.language);
    ctx.write(
      ctx.db
        .deleteFrom("core_media_caption")
        .where("media_id", "=", row.id)
        .where("language", "=", input.language),
    );
    ctx.recordChange({
      object: "media",
      id: row.id,
      action: "update",
      before: { caption: input.language },
    });
    return { id: row.id, language: input.language };
  },
});

const mediaSettings = z.object({
  generatedCaptions: z
    .boolean()
    .describe("Staff may ask Stream to generate captions (Stream charges for them)"),
});

export const mediaSettingsGet = defineOperation({
  name: "media.settings.get",
  description: "Get the media library's settings: whether generated captions are on. Read-only.",
  input: z.object({}),
  output: mediaSettings,
  permission: "records:read",
  risk: "read",
  mcp: { idempotent: true },
  async handler(_input, ctx) {
    return {
      generatedCaptions:
        (await loadSetting(ctx.db, MEDIA_GENERATED_CAPTIONS_SETTING, z.boolean())) ?? false,
    };
  },
});

export const mediaSettingsUpdate = defineOperation({
  name: "media.settings.update",
  description:
    "Turn generated captions on or off for the media library. Admins only, and only a human " +
    "can call it: AI assistants, MCP clients, automations and extensions are refused.",
  input: mediaSettings,
  output: mediaSettings.extend({ previous: mediaSettings }),
  permission: "settings:manage",
  risk: "write",
  actors: ["human"],
  mcp: { expose: false },
  async handler(input, ctx) {
    const previous = {
      generatedCaptions:
        (await loadSetting(ctx.db, MEDIA_GENERATED_CAPTIONS_SETTING, z.boolean())) ?? false,
    };
    const value = JSON.stringify(input.generatedCaptions);
    ctx.write(
      ctx.db
        .insertInto("core_settings")
        .values({
          key: MEDIA_GENERATED_CAPTIONS_SETTING,
          value,
          updated_at: ctx.now,
          updated_by: ctx.user.id,
        })
        .onConflict((oc) =>
          oc.column("key").doUpdateSet({ value, updated_at: ctx.now, updated_by: ctx.user.id }),
        ),
    );
    ctx.recordChange({
      object: "settings",
      id: MEDIA_GENERATED_CAPTIONS_SETTING,
      action: "update",
      before: previous,
      after: { generatedCaptions: input.generatedCaptions },
    });
    return { ...input, previous };
  },
});

export const mediaPlay = defineOperation({
  name: "media.play",
  description:
    "A short-lived token to play one ready video, and where it plays (HLS, DASH, Stream's " +
    "player), signed by the host: staff may play any; a customer or the public only a video " +
    "that a published record they may read shows, in a part they may read (a lesson's video " +
    "only for a holder of access to its course, a trailer for anyone). Anything else, and a " +
    "made-up id, is not found. The token is for this video only, lives at most an hour, and " +
    "never allows a download. Read-only.",
  input: z.object({
    id: mediaId,
    record: z
      .object({ object: z.string().max(81), id: z.string().max(64) })
      .optional()
      .describe("The record that shows it, to look only there"),
    field: z.string().max(40).optional().describe("The field of that record that shows it"),
    purpose: z
      .enum(["stream"])
      .default("stream")
      .describe("stream: to watch. (A download for offline viewing is not offered yet.)"),
    seconds: z
      .number()
      .int()
      .min(60)
      .max(PLAYBACK_MAX_SECONDS)
      .optional()
      .describe("How long the token lives; at most, and by default, an hour"),
  }),
  output: z.object({
    id: z.string(),
    token: z.string(),
    expiresAt: z.string(),
    hls: z.string(),
    dash: z.string(),
    iframe: z.string(),
    poster: z.string().describe("The poster frame Stream made, with the token"),
    duration: z.number().nullable(),
    captions: z.array(z.object({ language: z.string(), label: z.string() })),
  }),
  permission: "records:read",
  risk: "read",
  audiences: ["staff", "customer", "public"],
  // It reads which records show the video (core_published_media) beside the records.
  hostInternal: true,
  mcp: { expose: false },
  // A token is the caller's alone: an audited call keeps no token and no address with one.
  redactResult: ["token", "hls", "dash", "iframe", "poster"],
  async handler(input, ctx) {
    const caller = ctx.onBehalfOf ?? ctx.principal;
    // The item is read org-wide (outsiders read no media record); whether to play it is decided
    // below. Every refusal is the same not-found: nothing says the video exists.
    const row = await liveMedia(orgReader(ctx.db), input.id);
    if (!row || row.kind !== "video" || !row.stream_uid || row.state !== "ready") {
      throw notServed();
    }
    if (caller.kind !== "staff") {
      const within = {
        object: input.record?.object,
        record: input.record?.id,
        field: input.field,
      };
      if (!(await outsiderShown(ctx, caller, row.id, within))) throw notServed();
    }
    const host = requireVideoHost();
    const seconds = Math.min(input.seconds ?? PLAYBACK_MAX_SECONDS, PLAYBACK_MAX_SECONDS);
    const expiresAt = new Date(Date.parse(ctx.now) + seconds * 1000);
    // Bound to this video (`sub`), expiring within the hour, with no `downloadable` claim.
    const token = await host.signer.sign({ uid: row.stream_uid, expiresAt });
    const where = host.playback(token);
    const captions = (await captionsOf(ctx, row.id))
      .filter((c) => c.state === "ready")
      .map(({ language, label }) => ({ language, label }));
    return {
      id: row.id,
      token,
      expiresAt: expiresAt.toISOString(),
      hls: where.hls,
      dash: where.dash,
      iframe: where.iframe,
      poster: where.thumbnail,
      duration: row.duration === null ? null : Number(row.duration),
      captions,
    };
  },
});

export const mediaVideoOperations = [
  mediaVideoUpload,
  mediaVideoFromUrl,
  mediaVideoRefresh,
  mediaCaptionUpload,
  mediaCaptionGenerate,
  mediaCaptionDelete,
  mediaSettingsGet,
  mediaSettingsUpdate,
  mediaPlay,
] as const;
