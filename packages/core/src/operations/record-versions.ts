// Versions of a publishable record's content (stage 41, ADR 0446; completed by stage 28, ADR
// 0441), and creating many records of one object in one batch (stage 41, ADR 0448).
//
//   record.publish         a person with records:publish  snapshot the working copy as a version
//   record.schedulePublish a person with records:publish  snapshot it now, publish it at a time
//   record.cancelSchedule  a person with records:publish  drop a scheduled publish
//   record.unpublish       a person with records:publish  no version is read; versions are kept
//   record.publishDue      the minute cron (automation)   publish what a person scheduled, when due
//   record.versions        staff                          the versions, newest first
//   record.version         staff                          one version's content (default: current)
//   record.compareVersions staff                          what changed between two versions
//   record.restoreVersion  staff (records:write)          copy a version into the working copy
//   record.createMany      staff, extensions (bulk-write) up to 50 records of one object at once
//
// A publishable object's records are the working copy, which staff edit with record.update like
// any record. Publishing copies the object's content fields into the next row of
// core_publish_version and makes it current; only records/publish.ts writes there. What follows a
// version (a program's assignments) pins its number; the public reads the current one (stage 28,
// operations/content.ts). Restoring is an ordinary write to the working copy, through
// record.update's own code. A record's state (draft, scheduled, published, unpublished) is read
// from its versions and its schedule, never kept beside them.
import { sql } from "kysely";
import { z } from "zod";
import { NotFoundError, ValidationError } from "../errors.ts";
import { getObject } from "../fields/index.ts";
import type { ObjectDefinition } from "../fields/types.ts";
import { defineOperation, type HandlerContext } from "../operation.ts";
import {
  clearScheduleWrite,
  currentVersion,
  dueSchedules,
  nextVersion,
  type PublishableObject,
  publishWrites,
  scheduleOf,
  scheduleWrite,
  snapshotOf,
  unpublishWrites,
} from "../records/publish.ts";
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

export { VERSION_MAX_BYTES } from "../records/publish.ts";
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

function requirePublishable(name: string): PublishableObject {
  const object = requireExtensionObject(name);
  if (!object.publishable) {
    throw new ValidationError(`${object.label} is not publishable: it has no versions`, {
      object: name,
    });
  }
  return object as PublishableObject;
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
    const snapshot = snapshotOf(object, record, ctx.now);
    // An empty date is the day it goes live, in the working copy too (ADR 0441).
    if (Object.keys(snapshot.fill).length) await updateRecord(ctx, object, input.id, snapshot.fill);
    const version = await nextVersion(ctx, object.name, input.id);
    const note = input.note ?? null;
    // Racing publishes take the same number: the second batch fails on the key, as a conflict.
    ctx.write(
      ...publishWrites(object.name, input.id, version, snapshot, {
        at: ctx.now,
        user: ctx.user.id,
        note,
      }),
    );
    ctx.recordChange({
      object: object.name,
      id: input.id,
      action: "update",
      before: {
        publishedVersion: record.values.publishedVersion ?? null,
        publishAt: record.values.publishAt ?? null,
      },
      after: { publishedVersion: version, publishAt: null },
    });
    return {
      version,
      current: true,
      publishedAt: ctx.now,
      publishedBy: ctx.user.id,
      note,
      bytes: snapshot.bytes,
    };
  },
});

/** The furthest ahead a publish may be scheduled. */
export const SCHEDULE_MAX_DAYS = 366;
/** Scheduled publishes the cron publishes in one call; the rest wait a minute. */
export const PUBLISH_DUE_BATCH = 20;

const scheduleSummary = z.object({
  publishAt: z.string().describe("When it goes live (ISO-8601 UTC)"),
  scheduledBy: z.string(),
  note: z.string().nullable(),
  bytes: z.number().int(),
});

export const recordSchedulePublish = defineOperation({
  name: "record.schedulePublish",
  description:
    "Schedule a record of a publishable object to be published at a time: its content fields " +
    "as they are now are what goes live then (a later edit waits for the next publish). " +
    "Replaces any earlier schedule; publishing now or unpublishing drops it. Only a person with " +
    "the publish permission can do this, never an AI assistant. Returns the schedule.",
  input: z.object({
    object: objectName,
    id: recordId,
    at: z.iso.datetime({ offset: true }).describe("When to publish it (ISO-8601, in the future)"),
    note: z.string().trim().min(1).max(500).optional().describe("What changed, for the history"),
  }),
  output: scheduleSummary,
  permission: "records:publish",
  risk: "write",
  actors: ["human"],
  mcp: { expose: false },
  async handler(input, ctx) {
    const object = requirePublishable(input.object);
    const at = new Date(input.at);
    const now = new Date(ctx.now);
    if (at.getTime() <= now.getTime()) {
      throw new ValidationError("A scheduled publish is in the future: publish it now instead", {
        field: "at",
      });
    }
    if (at.getTime() > now.getTime() + SCHEDULE_MAX_DAYS * 86_400_000) {
      throw new ValidationError(`A publish is scheduled at most ${SCHEDULE_MAX_DAYS} days ahead`, {
        field: "at",
      });
    }
    const record = await requireRecord(ctx, object, input.id);
    const publishAt = at.toISOString();
    const snapshot = snapshotOf(object, record, publishAt);
    if (Object.keys(snapshot.fill).length) await updateRecord(ctx, object, input.id, snapshot.fill);
    const note = input.note ?? null;
    ctx.write(
      scheduleWrite(object.name, input.id, publishAt, snapshot, {
        now: ctx.now,
        user: ctx.user.id,
        note,
      }),
    );
    ctx.recordChange({
      object: object.name,
      id: input.id,
      action: "update",
      before: { publishAt: record.values.publishAt ?? null },
      after: { publishAt },
    });
    return { publishAt, scheduledBy: ctx.user.id, note, bytes: snapshot.bytes };
  },
});

export const recordCancelSchedule = defineOperation({
  name: "record.cancelSchedule",
  description:
    "Drop the scheduled publish of a record of a publishable object. What is live stays live. " +
    "Not found when nothing is scheduled.",
  input: z.object({ object: objectName, id: recordId }),
  output: z.object({ cancelled: z.string().describe("The time it was scheduled for") }),
  permission: "records:publish",
  risk: "write",
  actors: ["human"],
  mcp: { expose: false },
  async handler(input, ctx) {
    const object = requirePublishable(input.object);
    await requireRecord(ctx, object, input.id);
    const schedule = await scheduleOf(ctx, object.name, input.id);
    if (!schedule) throw new NotFoundError(`${object.name} schedule`, input.id);
    ctx.write(clearScheduleWrite(object.name, input.id));
    ctx.recordChange({
      object: object.name,
      id: input.id,
      action: "update",
      before: { publishAt: schedule.publish_at },
      after: { publishAt: null },
    });
    return { cancelled: schedule.publish_at };
  },
});

export const recordUnpublish = defineOperation({
  name: "record.unpublish",
  description:
    "Unpublish a record of a publishable object: the public no longer reads it (it answers as " +
    "a record that does not exist) and any scheduled publish is dropped. Its versions are kept " +
    "and it can be published again. Only a person with the publish permission can do this.",
  input: z.object({ object: objectName, id: recordId }),
  output: z.object({ unpublished: z.number().int().describe("The version that was live") }),
  permission: "records:publish",
  risk: "write",
  actors: ["human"],
  mcp: { expose: false },
  async handler(input, ctx) {
    const object = requirePublishable(input.object);
    const record = await requireRecord(ctx, object, input.id);
    const version = await currentVersion(ctx, object.name, input.id);
    if (version === null) {
      throw new ValidationError(`This ${object.label.toLowerCase()} is not published`, {
        reason: "not_published",
      });
    }
    ctx.write(...unpublishWrites(object.name, input.id));
    ctx.recordChange({
      object: object.name,
      id: input.id,
      action: "update",
      before: {
        publishedVersion: version,
        publishAt: record.values.publishAt ?? null,
      },
      after: { publishedVersion: null, publishAt: null },
    });
    return { unpublished: version };
  },
});

export const recordPublishDue = defineOperation({
  name: "record.publishDue",
  description:
    "Platform use only: publish the scheduled publishes whose time has come (the minute cron), " +
    "each as the snapshot the person who scheduled it took, in their name. A record deleted " +
    "meanwhile loses its schedule. Returns the records published.",
  input: z.object({
    limit: z.number().int().min(1).max(PUBLISH_DUE_BATCH).default(PUBLISH_DUE_BATCH),
  }),
  output: z.object({
    published: z.array(z.object({ object: z.string(), id: z.string(), version: z.number() })),
    dropped: z.number().int(),
  }),
  permission: "records:write",
  risk: "write",
  // Only what a person scheduled is published here: no input names a record or its content.
  actors: ["automation"],
  mcp: { expose: false },
  auditSummary: (output) => ({ count: output.published.length, dropped: output.dropped }),
  async handler(input, ctx) {
    const published: { object: string; id: string; version: number }[] = [];
    let dropped = 0;
    for (const due of await dueSchedules(ctx, ctx.now, input.limit)) {
      const object = getObject(due.object_type);
      const record = object?.publishable ? await loadRecord(ctx, object, due.record_id) : undefined;
      if (!object?.publishable || !record) {
        dropped += 1;
        ctx.write(clearScheduleWrite(due.object_type, due.record_id));
        continue;
      }
      const version = await nextVersion(ctx, object.name, due.record_id);
      ctx.write(
        ...publishWrites(object.name, due.record_id, version, due, {
          at: ctx.now,
          user: due.scheduled_by,
          note: due.note,
        }),
      );
      ctx.recordChange({
        object: object.name,
        id: due.record_id,
        action: "update",
        before: {
          publishedVersion: record.values.publishedVersion ?? null,
          publishAt: due.publish_at,
        },
        after: { publishedVersion: version, publishAt: null },
      });
      published.push({ object: object.name, id: due.record_id, version });
    }
    return { published, dropped };
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

export const recordCompareVersions = defineOperation({
  name: "record.compareVersions",
  description:
    "Compare two versions of a record of a publishable object, or a version and the working " +
    "copy: each content field that differs, with its value in both. `to` left out is the " +
    "working copy (what would be published now). Read-only.",
  input: z.object({
    object: objectName,
    id: recordId,
    from: z.number().int().min(1).describe("A version number"),
    to: z.number().int().min(1).optional().describe("A version number. Default: the working copy"),
  }),
  output: z.object({
    from: z.number().int(),
    to: z.number().int().nullable().describe("Null: the working copy"),
    changes: z.array(z.object({ field: z.string(), before: z.unknown(), after: z.unknown() })),
  }),
  permission: "records:read",
  risk: "read",
  mcp: { idempotent: true },
  async handler(input, ctx) {
    const object = requirePublishable(input.object);
    const record = await requireRecord(ctx, object, input.id);
    const from = JSON.parse(
      (await readVersion(ctx, object.name, input.id, input.from)).content ?? "{}",
    ) as Record<string, unknown>;
    const to =
      input.to === undefined
        ? Object.fromEntries(object.publishable.content.map((f) => [f, record.values[f] ?? null]))
        : (JSON.parse(
            (await readVersion(ctx, object.name, input.id, input.to)).content ?? "{}",
          ) as Record<string, unknown>);
    const fields = [...new Set([...object.publishable.content, ...Object.keys(from)])];
    const changes = fields
      .filter((f) => JSON.stringify(from[f] ?? null) !== JSON.stringify(to[f] ?? null))
      .map((field) => ({ field, before: from[field] ?? null, after: to[field] ?? null }));
    return { from: input.from, to: input.to ?? null, changes };
  },
});

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
  recordSchedulePublish,
  recordCancelSchedule,
  recordUnpublish,
  recordPublishDue,
  recordVersions,
  recordVersion,
  recordCompareVersions,
  recordRestoreVersion,
  recordCreateMany,
] as const;
