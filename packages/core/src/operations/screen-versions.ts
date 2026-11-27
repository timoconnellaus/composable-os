// The screen version store's operations (stage 75 step 3, ADR 0961). A version gets in three
// steps, so no operation ever carries a file's bytes as a parameter:
//
//   screens.versionBegin  a person   open a version; says which of its files the client holds
//   screens.versionPut    a person   one file, by its hash (bytes from the upload route)
//   screens.versionSeal   a person   the manifest: checked, then the version never changes
//   screens.versionList   staff      the client's versions, newest first
//   screens.versionGet    staff      one version, with its files
//
// The bytes of a file come from the upload route (`PUT /api/v1/screens/versions/<id>/files/<sha>`,
// a staff device token only: http/screen-versions.ts) as `ctx.upload`, as a picture's do. Each is
// hashed on arrival and refused unless it is the hash it was sent as. The seal checks the
// manifest (its shape, every path, the limits, the entry) and that every file it names is one the
// client holds at that size; the version's files are then exactly the manifest's, and a file it
// was sent that the manifest does not name is no part of it (the sweep removes it). Content types
// are the host's, from each path's extension.
//
// Who may: `screens:upload` (admins; grantable to a member who builds the screens). People only:
// an assistant, MCP, an automation or an extension cannot store a version. Storing a draft is
// lower risk than publishing (it changes nothing anyone sees), but versions come from a client's
// repository and its CI, sent by `cos` with a person's staff device token (step 7), so an AI
// caller has no file to send and nothing needs it to. Publishing is step 4's `screens.publish`,
// with its own permission. Staff only: no customer or public caller is told these exist.
import {
  canonicalScreenVersionManifest,
  SCREEN_VERSION_KINDS,
  SCREEN_VERSION_LIMITS,
  type ScreenVersionManifest,
  SHA256_HEX,
  screenContentType,
  screenVersionManifestSchema,
} from "@composable-os/sdk";
import { sql } from "kysely";
import { z } from "zod";
import { sha256Hex } from "../digest.ts";
import { ConflictError, NotFoundError, OperationError, ValidationError } from "../errors.ts";
import { newId } from "../ids.ts";
import { defineOperation, type HandlerContext } from "../operation.ts";
import {
  MAX_OPEN_VERSIONS,
  OPEN_VERSION_HOURS,
  screenObjectKey,
} from "../screen-versions/store.ts";

const versionId = z
  .string()
  .regex(/^scv_[0-9A-HJKMNP-TV-Z]{26}$/, "a screen version's id")
  .describe("The version's id (scv_…)");
const kind = z
  .enum(SCREEN_VERSION_KINDS)
  .describe("What the version is the built output of: web, a client's web app");
const sha256 = z.string().regex(SHA256_HEX, "a SHA-256 in lowercase hex");

const limitsOut = z.object({
  maxFiles: z.number().int(),
  maxFileBytes: z.number().int(),
  maxTotalBytes: z.number().int(),
  maxPathLength: z.number().int(),
  maxPathDepth: z.number().int(),
});

const versionOut = z.object({
  id: z.string(),
  kind,
  state: z.enum(["open", "sealed"]),
  createdAt: z.string(),
  createdBy: z.string().describe("The staff user who began it"),
  expiresAt: z.string().nullable().describe("Open: when it is swept unless sealed"),
  sealedAt: z.string().nullable(),
  sealedBy: z.string().nullable().describe("The staff user who sealed it"),
  entry: z.string().nullable(),
  contract: z.string().nullable().describe("The API contract version it was built against"),
  buildTool: z.string().nullable(),
  fileCount: z.number().int().nullable(),
  totalBytes: z.number().int().nullable(),
  manifestSha256: z.string().nullable().describe("The SHA-256 of its canonical manifest"),
});
export type ScreenVersionSummary = z.infer<typeof versionOut>;

type VersionRow = {
  id: string;
  kind: "web";
  state: "open" | "sealed";
  created_at: string;
  created_by: string;
  expires_at: string | null;
  sealed_at: string | null;
  sealed_by: string | null;
  entry: string | null;
  contract: string | null;
  build_tool: string | null;
  file_count: number | null;
  total_bytes: number | null;
  manifest_sha256: string | null;
};

const SUMMARY_COLUMNS = [
  "id",
  "kind",
  "state",
  "created_at",
  "created_by",
  "expires_at",
  "sealed_at",
  "sealed_by",
  "entry",
  "contract",
  "build_tool",
  "file_count",
  "total_bytes",
  "manifest_sha256",
] as const;

function summary(row: VersionRow): ScreenVersionSummary {
  return {
    id: row.id,
    kind: row.kind,
    state: row.state,
    createdAt: row.created_at,
    createdBy: row.created_by,
    expiresAt: row.expires_at,
    sealedAt: row.sealed_at,
    sealedBy: row.sealed_by,
    entry: row.entry,
    contract: row.contract,
    buildTool: row.build_tool,
    fileCount: row.file_count,
    totalBytes: row.total_bytes,
    manifestSha256: row.manifest_sha256,
  };
}

async function findVersion(ctx: HandlerContext, id: string): Promise<VersionRow> {
  const row = await ctx.db
    .selectFrom("core_screen_version")
    .select(SUMMARY_COLUMNS)
    .where("id", "=", id)
    .executeTakeFirst();
  if (!row) throw new NotFoundError("screen version", id);
  return row as VersionRow;
}

/** An open version not past its time, or why not. */
async function openVersion(ctx: HandlerContext, id: string): Promise<VersionRow> {
  const row = await findVersion(ctx, id);
  if (row.state === "sealed") {
    throw new ConflictError("This version is sealed: a sealed version is never changed", {
      rule: "screen_version",
      reason: "sealed",
    });
  }
  if ((row.expires_at ?? "") <= ctx.now) {
    throw new ConflictError(
      `This upload was not sealed within ${OPEN_VERSION_HOURS} hours: begin a new version`,
      { rule: "screen_version", reason: "expired" },
    );
  }
  return row;
}

/** A refusal the database made at commit (migration 1490's triggers), said plainly. */
async function explainStoreFailure(error: OperationError): Promise<OperationError | null> {
  const message = error.message;
  if (message.includes("core_screen_version_sealed")) {
    return new ConflictError("A sealed version is never changed", {
      rule: "screen_version",
      reason: "sealed",
    });
  }
  if (message.includes("core_screen_version_file_refused")) {
    return new ConflictError(
      "A file of the manifest is not one this host holds at that size, or the version is no longer open: put it again",
      { rule: "screen_version", reason: "missing_files" },
    );
  }
  if (message.includes("core_screen_version_not_open")) {
    return new ConflictError("This version is no longer open", {
      rule: "screen_version",
      reason: "not_open",
    });
  }
  if (message.includes("core_screen_version_seal_mismatch")) {
    return new ConflictError("The seal does not match the version's files", {
      rule: "screen_version",
      reason: "seal_mismatch",
    });
  }
  return null;
}

export const screenVersionBegin = defineOperation({
  name: "screens.versionBegin",
  description:
    "Begin storing a new version of the client's screens (a build made outside the host, by its " +
    "repository's CI or a person's machine). Returns the open version's id, when it is swept " +
    "unless sealed (24 hours), the limits of a version, and which of the files' hashes you name " +
    "the client already holds, so those are not sent again. Then send each other file to the " +
    "upload route (screens.versionPut) and seal it with its manifest (screens.versionSeal). " +
    "Changes nothing anyone sees: a version is published only by screens.publish.",
  input: z.object({
    kind: kind.default("web"),
    sha256: z
      .array(sha256)
      .max(SCREEN_VERSION_LIMITS.maxFiles)
      .default([])
      .describe("The hashes of the build's files, to learn which the client already holds"),
  }),
  output: z.object({
    id: z.string(),
    kind,
    expiresAt: z.string(),
    limits: limitsOut,
    held: z.array(z.string()).describe("The hashes given that the client holds: do not send them"),
  }),
  permission: "screens:upload",
  risk: "write",
  actors: ["human"],
  mcp: { expose: false },
  explainFailure: explainStoreFailure,
  async handler(input, ctx) {
    const open = await ctx.db
      .selectFrom("core_screen_version")
      .select(({ fn }) => fn.countAll<number>().as("n"))
      .where("kind", "=", input.kind)
      .where("state", "=", "open")
      .where("expires_at", ">", ctx.now)
      .executeTakeFirst();
    if (Number(open?.n ?? 0) >= MAX_OPEN_VERSIONS) {
      throw new ConflictError(
        `${MAX_OPEN_VERSIONS} versions of this kind are being uploaded already: seal one, or wait until one is swept`,
        { rule: "screen_version", reason: "too_many_open", max: MAX_OPEN_VERSIONS },
      );
    }
    const id = newId("screenVersion");
    const expiresAt = new Date(Date.parse(ctx.now) + OPEN_VERSION_HOURS * 3_600_000).toISOString();
    const wanted = [...new Set(input.sha256)];
    const held = wanted.length
      ? await ctx.db
          .selectFrom("core_screen_blob")
          .select(["sha256", "size"])
          .where("sha256", "in", wanted)
          .execute()
      : [];
    ctx.write(
      ctx.db.insertInto("core_screen_version").values({
        id,
        kind: input.kind,
        state: "open",
        created_at: ctx.now,
        created_by: ctx.user.id,
        expires_at: expiresAt,
      }),
    );
    // What it holds is claimed for this version at once, so the sweep leaves it while it is open.
    if (held.length) {
      ctx.write(
        ctx.db.insertInto("core_screen_version_upload").values(
          held.map((h) => ({
            version_id: id,
            sha256: h.sha256,
            size: h.size,
            received_at: ctx.now,
          })),
        ),
      );
    }
    return {
      id,
      kind: input.kind,
      expiresAt,
      limits: { ...SCREEN_VERSION_LIMITS },
      held: held.map((h) => h.sha256).sort(),
    };
  },
});

export const screenVersionPut = defineOperation({
  name: "screens.versionPut",
  description:
    "Store one file of an open screen version, named by the SHA-256 of its bytes (lowercase " +
    "hex). The file comes from the upload route, never this input; it is hashed on arrival and " +
    "refused unless it is that hash, or past a version's limits (a file at most 25 MB, a version " +
    "at most 1000 files and 50 MB). A file the client holds already is not stored again. Putting " +
    "the same file twice is harmless.",
  input: z.object({ version: versionId, sha256: sha256.describe("The file's SHA-256") }),
  output: z.object({
    sha256: z.string(),
    size: z.number().int(),
    stored: z.boolean().describe("False when the client held this file already"),
  }),
  permission: "screens:upload",
  risk: "write",
  actors: ["human"],
  mcp: { expose: false },
  // The bytes are the request's, never the input's: a pending action could not hold them, so a
  // call the policy or the deploy floor would make wait is refused instead.
  neverQueued: true,
  redact: ["sha256"],
  auditSummary: (out, input) => ({ version: input.version, sha256: out.sha256, size: out.size }),
  explainFailure: explainStoreFailure,
  async handler(input, ctx) {
    const bytes = ctx.upload?.bytes;
    if (!bytes) {
      throw new ValidationError(
        "Send the file itself to the upload route (PUT /api/v1/screens/versions/<id>/files/<sha256>): this takes no file",
        { reason: "no_file" },
      );
    }
    if (bytes.byteLength > SCREEN_VERSION_LIMITS.maxFileBytes) {
      throw new ValidationError(
        `A file is at most ${SCREEN_VERSION_LIMITS.maxFileBytes} bytes; this is ${bytes.byteLength}`,
        { reason: "too_large", max: SCREEN_VERSION_LIMITS.maxFileBytes, httpStatus: 413 },
      );
    }
    const actual = await sha256Hex(new Uint8Array(bytes));
    if (actual !== input.sha256) {
      throw new ValidationError("The file is not the one named: its SHA-256 differs", {
        field: "sha256",
        reason: "hash_mismatch",
        sha256: actual,
      });
    }
    await openVersion(ctx, input.version);
    const sent = await ctx.db
      .selectFrom("core_screen_version_upload")
      .select(({ fn }) => [
        fn.countAll<number>().as("files"),
        fn.coalesce(fn.sum<number>("size"), sql<number>`0`).as("bytes"),
      ])
      .where("version_id", "=", input.version)
      .executeTakeFirst();
    const already = await ctx.db
      .selectFrom("core_screen_version_upload")
      .select("sha256")
      .where("version_id", "=", input.version)
      .where("sha256", "=", actual)
      .executeTakeFirst();
    if (!already) {
      if (Number(sent?.files ?? 0) + 1 > SCREEN_VERSION_LIMITS.maxFiles) {
        throw new ValidationError(
          `A version holds at most ${SCREEN_VERSION_LIMITS.maxFiles} files`,
          { reason: "too_many_files", max: SCREEN_VERSION_LIMITS.maxFiles },
        );
      }
      if (Number(sent?.bytes ?? 0) + bytes.byteLength > SCREEN_VERSION_LIMITS.maxTotalBytes) {
        throw new ValidationError(
          `A version's files are at most ${SCREEN_VERSION_LIMITS.maxTotalBytes} bytes together`,
          { reason: "too_large", max: SCREEN_VERSION_LIMITS.maxTotalBytes, httpStatus: 413 },
        );
      }
    }
    const held = await ctx.db
      .selectFrom("core_screen_blob")
      .select("sha256")
      .where("sha256", "=", actual)
      .executeTakeFirst();
    let stored = false;
    if (!held) {
      if (!ctx.media) throw new OperationError("config", "File storage is not configured here");
      const key = screenObjectKey(actual, input.version);
      // Stored before its row commits: a batch that then fails leaves an object no row names,
      // which the sweep deletes once this version is no longer open; never a row with no object.
      if (!ctx.simulation) await ctx.media.put(key, bytes, "application/octet-stream");
      ctx.write(
        ctx.db
          .insertInto("core_screen_blob")
          .values({
            sha256: actual,
            size: bytes.byteLength,
            object_key: key,
            stored_at: ctx.now,
            last_put_at: ctx.now,
          })
          .onConflict((oc) => oc.column("sha256").doNothing()),
      );
      stored = true;
    } else {
      ctx.write(
        ctx.db
          .updateTable("core_screen_blob")
          .set({ last_put_at: ctx.now })
          .where("sha256", "=", actual),
      );
    }
    ctx.write(
      ctx.db
        .insertInto("core_screen_version_upload")
        .values({
          version_id: input.version,
          sha256: actual,
          size: bytes.byteLength,
          received_at: ctx.now,
        })
        .onConflict((oc) => oc.columns(["version_id", "sha256"]).doNothing()),
    );
    return { sha256: actual, size: bytes.byteLength, stored };
  },
});

export const screenVersionSeal = defineOperation({
  name: "screens.versionSeal",
  description:
    "Seal an open screen version with its manifest: the files (each path, SHA-256 and size), " +
    "the entry (an .html file among them), the API contract version it was built against (v1) " +
    "and what built it from what (a tool, and a repository, commit or ref; never a person's " +
    "name). The host checks every path (relative, no . or .. part, no two differing only in " +
    "case, an extension it serves), the limits, the entry, and that every file named is one the " +
    "client holds at that size. Sealed, the version is exactly its manifest's files and never " +
    "changes; a file it was sent that the manifest does not name is no part of it. Sealing " +
    "publishes nothing (screens.publish does).",
  input: z.object({
    version: versionId,
    manifest: screenVersionManifestSchema.describe("The manifest the build wrote"),
  }),
  output: versionOut.extend({
    unused: z
      .array(z.string())
      .describe("Hashes the version was sent that the manifest does not name: not part of it"),
  }),
  permission: "screens:upload",
  risk: "write",
  actors: ["human"],
  mcp: { expose: false },
  auditSummary: (out) => ({
    version: out.id,
    manifestSha256: out.manifestSha256,
    files: out.fileCount,
    bytes: out.totalBytes,
    contract: out.contract,
  }),
  explainFailure: explainStoreFailure,
  async handler(input, ctx) {
    const manifest: ScreenVersionManifest = input.manifest;
    const canonical = canonicalScreenVersionManifest(manifest);
    await openVersion(ctx, input.version);
    const hashes = [...new Set(manifest.files.map((f) => f.sha256))];
    const held = new Map(
      (
        await ctx.db
          .selectFrom("core_screen_blob")
          .select(["sha256", "size"])
          .where(sql<boolean>`sha256 IN (SELECT value FROM json_each(${JSON.stringify(hashes)}))`)
          .execute()
      ).map((b) => [b.sha256, b.size]),
    );
    const missing = manifest.files.filter((f) => !held.has(f.sha256));
    if (missing.length) {
      throw new ConflictError(
        `${missing.length} file(s) of the manifest were never sent: put them, then seal again`,
        {
          rule: "screen_version",
          reason: "missing_files",
          missing: missing.slice(0, 20).map((f) => ({ path: f.path, sha256: f.sha256 })),
        },
      );
    }
    const changed = manifest.files.filter((f) => held.get(f.sha256) !== f.size);
    if (changed.length) {
      throw new ValidationError(
        "A file's size in the manifest is not the size of the file sent with that hash",
        {
          field: "manifest",
          reason: "size_mismatch",
          files: changed.slice(0, 20).map((f) => f.path),
        },
      );
    }
    const files = manifest.files.map((f) => ({
      path: f.path,
      sha256: f.sha256,
      size: f.size,
      // The host's, from the path: screenVersionManifestSchema has refused any other extension.
      type: screenContentType(f.path) as string,
    }));
    const total = files.reduce((sum, f) => sum + f.size, 0);
    const manifestSha256 = await sha256Hex(canonical);
    const sent = await ctx.db
      .selectFrom("core_screen_version_upload")
      .select("sha256")
      .where("version_id", "=", input.version)
      .execute();
    const named = new Set(hashes);
    const unused = sent
      .map((s) => s.sha256)
      .filter((h) => !named.has(h))
      .sort();
    // One statement for every file (json_each: the manifest is one parameter), then the seal,
    // which its trigger checks against those files; then what it was sent is no longer claimed.
    ctx.write(
      sql`INSERT INTO core_screen_version_file (version_id, path, sha256, size, content_type)
        SELECT ${input.version}, json_extract(j.value, '$.path'), json_extract(j.value, '$.sha256'),
          json_extract(j.value, '$.size'), json_extract(j.value, '$.type')
        FROM json_each(${JSON.stringify(files)}) j`.compile(ctx.db),
      ctx.db
        .updateTable("core_screen_version")
        .set({
          state: "sealed",
          expires_at: null,
          sealed_at: ctx.now,
          sealed_by: ctx.user.id,
          manifest: canonical,
          manifest_sha256: manifestSha256,
          entry: manifest.entry,
          contract: manifest.contract,
          build_tool: manifest.build.tool,
          file_count: files.length,
          total_bytes: total,
        })
        .where("id", "=", input.version)
        .where("state", "=", "open"),
      ctx.db.deleteFrom("core_screen_version_upload").where("version_id", "=", input.version),
    );
    const row = await findVersion(ctx, input.version);
    return {
      ...summary({
        ...row,
        state: "sealed",
        expires_at: null,
        sealed_at: ctx.now,
        sealed_by: ctx.user.id,
        entry: manifest.entry,
        contract: manifest.contract,
        build_tool: manifest.build.tool,
        file_count: files.length,
        total_bytes: total,
        manifest_sha256: manifestSha256,
      }),
      unused,
    };
  },
});

export const screenVersionList = defineOperation({
  name: "screens.versionList",
  description:
    "The client's screen versions of one kind (web: its web app), newest first: each one's state (open while its files are " +
    "uploaded, sealed once it is checked and fixed), who began and sealed it, its entry, the API " +
    "contract version it was built against, its file count and size, and its manifest's hash. " +
    "Read-only. The last ten sealed versions of a kind are always kept, and any version held.",
  input: z.object({
    kind: kind.default("web"),
    state: z.enum(["open", "sealed"]).optional().describe("Only versions in this state"),
    limit: z.number().int().min(1).max(100).default(50),
  }),
  output: z.object({ versions: z.array(versionOut) }),
  permission: "screens:upload",
  risk: "read",
  async handler(input, ctx) {
    let query = ctx.db
      .selectFrom("core_screen_version")
      .select(SUMMARY_COLUMNS)
      .where("kind", "=", input.kind);
    if (input.state) query = query.where("state", "=", input.state);
    const rows = await query
      .orderBy("created_at", "desc")
      .orderBy("id", "desc")
      .limit(input.limit)
      .execute();
    return { versions: (rows as VersionRow[]).map(summary) };
  },
});

export const screenVersionGet = defineOperation({
  name: "screens.versionGet",
  description:
    "One screen version: what screens.versionList says of it, and for a sealed version its " +
    "manifest and its files (each path, SHA-256, size and the content type the host serves it " +
    "with); for an open one, the files it has been sent so far. Read-only.",
  input: z.object({ version: versionId }),
  output: versionOut.extend({
    manifest: z.unknown().nullable().describe("The canonical manifest, once sealed"),
    files: z.array(
      z.object({
        path: z.string(),
        sha256: z.string(),
        size: z.number().int(),
        contentType: z.string(),
      }),
    ),
    received: z.array(z.object({ sha256: z.string(), size: z.number().int() })),
  }),
  permission: "screens:upload",
  risk: "read",
  async handler(input, ctx) {
    const row = await findVersion(ctx, input.version);
    const full = await ctx.db
      .selectFrom("core_screen_version")
      .select("manifest")
      .where("id", "=", input.version)
      .executeTakeFirst();
    const files =
      row.state === "sealed"
        ? await ctx.db
            .selectFrom("core_screen_version_file")
            .select(["path", "sha256", "size", "content_type"])
            .where("version_id", "=", input.version)
            .orderBy("path")
            .execute()
        : [];
    const received =
      row.state === "open"
        ? await ctx.db
            .selectFrom("core_screen_version_upload")
            .select(["sha256", "size"])
            .where("version_id", "=", input.version)
            .orderBy("sha256")
            .execute()
        : [];
    return {
      ...summary(row),
      manifest: full?.manifest ? (JSON.parse(full.manifest) as unknown) : null,
      files: files.map((f) => ({
        path: f.path,
        sha256: f.sha256,
        size: f.size,
        contentType: f.content_type,
      })),
      received,
    };
  },
});

export const screenVersionOperations = [
  screenVersionBegin,
  screenVersionPut,
  screenVersionSeal,
  screenVersionList,
  screenVersionGet,
] as const;
