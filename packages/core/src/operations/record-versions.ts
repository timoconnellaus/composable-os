// Versions of a publishable record's content (stage 41, ADR 0446), and creating many records of
// one object in one batch (stage 41, ADR 0448).
//
//   record.publish        a person with records:publish   snapshot the working copy as a version
//   record.versions       staff                           the versions, newest first
//   record.version        staff                           one version's content (default: current)
//   record.restoreVersion staff (records:write)           copy a version into the working copy
//   record.createMany     staff, extensions (bulk-write)  up to 50 records of one object at once
//
// A publishable object's records are the working copy, which staff edit with record.update like
// any record. Publishing copies the object's content fields into the next row of
// core_publish_version and makes it current; nothing else ever changes a version. What follows a
// version (a program's assignments) pins its number. Restoring is an ordinary write to the
// working copy, through record.update's own code. Stage 28 adds the public half: slugs, the
// public reading the current version through the public scope, scheduling, unpublishing and
// preview links.
import { documentBytes } from "@composable-os/sdk";
import { CompiledQuery, sql } from "kysely";
import { z } from "zod";
import { NotFoundError, ValidationError } from "../errors.ts";
import type { ObjectDefinition } from "../fields/types.ts";
import { defineOperation, type HandlerContext } from "../operation.ts";
import type { StageCache } from "../records/stages.ts";
import {
  createRecord,
  loadRecord,
  recordSchema,
  requireExtensionObject,
  updateRecord,
} from "./record.ts";

const objectName = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[a-z][a-z0-9]*\.[a-z][a-z0-9]*$/)
  .describe("An extension object (`<extension>.<object>`, see schema.objects)");
const recordId = z.string().min(1).max(64).describe("Record id");

/** The most a version's content may be, in bytes of its JSON (a D1 row holds 2 MB). */
export const VERSION_MAX_BYTES = 1_048_576;
/** The most records one record.createMany makes: see ADR 0448 for the statements each costs. */
export const CREATE_MANY_MAX = 50;

const versionSummary = z.object({
  version: z.number().int(),
  current: z.boolean().describe("The version readers are given"),
  publishedAt: z.string(),
  publishedBy: z.string().nullable().describe("The staff user who published it"),
  note: z.string().nullable(),
  bytes: z.number().int(),
});

function requirePublishable(name: string): ObjectDefinition & {
  titleField: string;
  publishable: NonNullable<ObjectDefinition["publishable"]>;
} {
  const object = requireExtensionObject(name);
  if (!object.publishable) {
    throw new ValidationError(`${object.label} is not publishable: it has no versions`, {
      object: name,
    });
  }
  return object as ObjectDefinition & {
    titleField: string;
    publishable: NonNullable<ObjectDefinition["publishable"]>;
  };
}

async function requireRecord(ctx: HandlerContext, object: ObjectDefinition, id: string) {
  const record = await loadRecord(ctx, object, id);
  if (!record) throw new NotFoundError(object.name, id);
  return record;
}

interface VersionRow {
  version: number;
  current: number;
  content?: string;
  bytes: number;
  published_at: string;
  published_by: string | null;
  note: string | null;
}

const summaryOf = (row: VersionRow) => ({
  version: Number(row.version),
  current: Number(row.current) === 1,
  publishedAt: row.published_at,
  publishedBy: row.published_by,
  note: row.note,
  bytes: Number(row.bytes),
});

export const recordPublish = defineOperation({
  name: "record.publish",
  description:
    "Publish a record of a publishable object (see schema.objects): its content fields as they " +
    "are now become its next version, and the version readers are given. Editing the record " +
    "afterwards changes no version until it is published again; what follows a version (a " +
    "program's assignments) keeps the one it pinned. Only a person with the publish permission " +
    "can do this, never an AI assistant: draft the changes and ask a person to publish. Returns " +
    "the new version.",
  input: z.object({
    object: objectName,
    id: recordId,
    note: z.string().trim().min(1).max(500).optional().describe("What changed, for the history"),
  }),
  output: versionSummary,
  permission: "records:publish",
  risk: "write",
  actors: ["human"],
  mcp: { expose: false },
  async handler(input, ctx) {
    const object = requirePublishable(input.object);
    const record = await requireRecord(ctx, object, input.id);
    const content = Object.fromEntries(
      object.publishable.content.map((field) => [field, record.values[field] ?? null]),
    );
    const bytes = documentBytes(content);
    if (bytes > VERSION_MAX_BYTES) {
      throw new ValidationError(
        `The content is ${bytes} bytes; a version holds at most ${VERSION_MAX_BYTES}`,
        { bytes, max: VERSION_MAX_BYTES },
      );
    }
    const latest = await sql<{ version: number | null }>`
      SELECT max(version) AS version FROM core_publish_version
      WHERE object_type = ${object.name} AND record_id = ${input.id}
    `.execute(ctx.db);
    const previous = latest.rows[0]?.version ?? null;
    const version = Number(previous ?? 0) + 1;
    const published = record.values.publishedVersion ?? null;
    // Racing publishes take the same number: the second batch fails on the key, as a conflict.
    ctx.write(
      CompiledQuery.raw(
        "UPDATE core_publish_version SET current = 0 WHERE object_type = ? AND record_id = ? AND current = 1",
        [object.name, input.id],
      ),
      CompiledQuery.raw(
        "INSERT INTO core_publish_version (object_type, record_id, version, content, bytes, current, published_at, published_by, note) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)",
        [
          object.name,
          input.id,
          version,
          JSON.stringify(content),
          bytes,
          ctx.now,
          ctx.user.id,
          input.note ?? null,
        ],
      ),
    );
    ctx.recordChange({
      object: object.name,
      id: input.id,
      action: "update",
      before: { publishedVersion: published },
      after: { publishedVersion: version },
    });
    return {
      version,
      current: true,
      publishedAt: ctx.now,
      publishedBy: ctx.user.id,
      note: input.note ?? null,
      bytes,
    };
  },
});

export const recordVersions = defineOperation({
  name: "record.versions",
  description:
    "The published versions of a record of a publishable object, newest first: number, when, " +
    "who, the note, size, and which one is current (what readers are given). Read one with " +
    "record.version. Read-only.",
  input: z.object({
    object: objectName,
    id: recordId,
    limit: z.number().int().min(1).max(200).default(50),
  }),
  output: z.object({ items: z.array(versionSummary) }),
  permission: "records:read",
  risk: "read",
  mcp: { idempotent: true },
  async handler(input, ctx) {
    const object = requirePublishable(input.object);
    await requireRecord(ctx, object, input.id);
    const rows = await sql<VersionRow>`
      SELECT version, current, bytes, published_at, published_by, note FROM core_publish_version
      WHERE object_type = ${object.name} AND record_id = ${input.id}
      ORDER BY version DESC LIMIT ${input.limit}
    `.execute(ctx.db);
    return { items: rows.rows.map(summaryOf) };
  },
});

export const recordVersion = defineOperation({
  name: "record.version",
  description:
    "One published version of a record of a publishable object: its content fields as they " +
    "were published. Without `version`, the current one (what readers are given). Not found " +
    "when the record has never been published. Read-only.",
  input: z.object({
    object: objectName,
    id: recordId,
    version: z.number().int().min(1).optional().describe("Default: the current version"),
  }),
  output: versionSummary.extend({ values: z.record(z.string(), z.unknown()) }),
  permission: "records:read",
  risk: "read",
  mcp: { idempotent: true },
  async handler(input, ctx) {
    const object = requirePublishable(input.object);
    await requireRecord(ctx, object, input.id);
    const row = await readVersion(ctx, object.name, input.id, input.version);
    return {
      ...summaryOf(row),
      values: JSON.parse(row.content ?? "{}") as Record<string, unknown>,
    };
  },
});

async function readVersion(
  ctx: HandlerContext,
  object: string,
  id: string,
  version: number | undefined,
): Promise<VersionRow> {
  const which = version === undefined ? sql`current = 1` : sql`version = ${version}`;
  const rows = await sql<VersionRow>`
    SELECT version, current, content, bytes, published_at, published_by, note
    FROM core_publish_version WHERE object_type = ${object} AND record_id = ${id} AND ${which}
  `.execute(ctx.db);
  const row = rows.rows[0];
  if (!row) {
    throw new NotFoundError(
      `${object} version`,
      version === undefined ? `${id} (never published)` : `${id} v${version}`,
    );
  }
  return row;
}

export const recordRestoreVersion = defineOperation({
  name: "record.restoreVersion",
  description:
    "Copy a published version's content back into the record's working copy, as an ordinary " +
    "edit (validated, audited, undoable by editing again). No version changes and nothing is " +
    "published: publish afterwards to make it what readers are given. A content field the " +
    "object no longer has is left out and listed in `skipped`. Returns the record.",
  input: z.object({ object: objectName, id: recordId, version: z.number().int().min(1) }),
  output: z.object({ record: recordSchema, skipped: z.array(z.string()) }),
  permission: "records:write",
  risk: "write",
  async handler(input, ctx) {
    const object = requirePublishable(input.object);
    await requireRecord(ctx, object, input.id);
    const row = await readVersion(ctx, object.name, input.id, input.version);
    const stored = JSON.parse(row.content ?? "{}") as Record<string, unknown>;
    const content = new Set(object.publishable.content);
    const values = Object.fromEntries(Object.entries(stored).filter(([f]) => content.has(f)));
    const skipped = Object.keys(stored).filter((f) => !content.has(f));
    await updateRecord(ctx, object, input.id, values);
    return ctx.afterCommit(async () => ({
      record: await requireRecord(ctx, object, input.id),
      skipped,
    }));
  },
});

export const recordCreateMany = defineOperation({
  name: "record.createMany",
  description:
    `Create up to ${CREATE_MANY_MAX} records of one extension object at once, in one batch: ` +
    "all of them or none (a value one record cannot take refuses the whole call, naming its " +
    "index). Each is validated and recorded exactly as record.create does it. For generated " +
    "records (the dated sessions of a program); one at a time is record.create. Returns the ids " +
    "in the order given.",
  input: z.object({
    object: objectName,
    records: z
      .array(z.record(z.string().max(80), z.unknown()))
      .min(1)
      .max(CREATE_MANY_MAX)
      .describe("Field values by registry field name, one object per record"),
  }),
  output: z.object({ ids: z.array(z.string()) }),
  permission: "records:write",
  risk: "bulk-write",
  bulkSize: (input) => input.records.length,
  auditSummary: (output, input) => ({ object: input.object, count: output.ids.length }),
  async handler(input, ctx) {
    const object = requireExtensionObject(input.object);
    const cache: StageCache = new Map();
    const ids: string[] = [];
    for (const [index, values] of input.records.entries()) {
      try {
        ids.push(await createRecord(ctx, object, values, { cache }));
      } catch (error) {
        if (error instanceof ValidationError) {
          throw new ValidationError(`Record ${index}: ${error.message}`, {
            index,
            ...(error.details && typeof error.details === "object" ? error.details : {}),
          });
        }
        throw error;
      }
    }
    return { ids };
  },
});

export const recordVersionOperations = [
  recordPublish,
  recordVersions,
  recordVersion,
  recordRestoreVersion,
  recordCreateMany,
] as const;
