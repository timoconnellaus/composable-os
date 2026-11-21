// Publishing (ADR 0446, completed by stage 28's ADR 0441): the one module that writes
// core_publish_version and core_publish_schedule. The operations in operations/record-versions.ts
// call it; nothing else writes either table.
//
// A version is a snapshot of the object's content fields, taken when a person publishes or
// schedules. Scheduling takes it then, not when the cron runs, so what goes live is what the
// person decided on: an edit made afterwards (by anyone, the assistant included) waits for the
// next publish.
import { documentBytes } from "@composable-os/sdk";
import { CompiledQuery, sql } from "kysely";
import { ValidationError } from "../errors.ts";
import type { ObjectDefinition, PublishableDefinition } from "../fields/types.ts";
import type { HandlerContext } from "../operation.ts";

/** The most a version's content may be, in bytes of its JSON (a D1 row holds 2 MB). */
export const VERSION_MAX_BYTES = 1_048_576;

export type PublishableObject = ObjectDefinition & {
  titleField: string;
  publishable: PublishableDefinition;
};

interface RecordValues {
  values: Record<string, unknown>;
}

const empty = (value: unknown) => value === undefined || value === null || value === "";

/**
 * The content a version of `record` keeps, published (or to be published) at `at`: the content
 * fields as they are, with the object's `date` filled with `at` when it is empty (ADR 0441). The
 * fill is returned too, so the working copy gets the same date.
 */
export function snapshotOf(
  object: PublishableObject,
  record: RecordValues,
  at: string,
): { content: Record<string, unknown>; bytes: number; fill: Record<string, unknown> } {
  const { content: fields, slug, date } = object.publishable;
  if (slug && empty(record.values[slug])) {
    throw new ValidationError(`${object.label} needs an address (${slug}) to be published`, {
      field: slug,
      reason: "slug_required",
    });
  }
  const content: Record<string, unknown> = Object.fromEntries(
    fields.map((f) => [f, record.values[f] ?? null]),
  );
  const fill: Record<string, unknown> = {};
  if (date && empty(content[date])) {
    const type = object.fields.find((f) => f.name === date)?.type;
    fill[date] = type === "date" ? at.slice(0, 10) : at;
    content[date] = fill[date];
  }
  const bytes = documentBytes(content);
  if (bytes > VERSION_MAX_BYTES) {
    throw new ValidationError(
      `The content is ${bytes} bytes; a version holds at most ${VERSION_MAX_BYTES}`,
      { bytes, max: VERSION_MAX_BYTES },
    );
  }
  return { content, bytes, fill };
}

/** The number the record's next version takes. */
export async function nextVersion(ctx: HandlerContext, object: string, id: string) {
  const latest = await sql<{ version: number | null }>`
    SELECT max(version) AS version FROM core_publish_version
    WHERE object_type = ${object} AND record_id = ${id}
  `.execute(ctx.db);
  return Number(latest.rows[0]?.version ?? 0) + 1;
}

/**
 * The statements that make `content` the record's current version, numbered `version`, and drop
 * any scheduled publish of it. Racing publishes take the same number: the second batch fails on
 * the key, as a conflict (`published_meanwhile`).
 */
export function publishWrites(
  object: string,
  id: string,
  version: number,
  snapshot: { content: Record<string, unknown> | string; bytes: number },
  by: { at: string; user: string | null; note: string | null },
): CompiledQuery[] {
  const content =
    typeof snapshot.content === "string" ? snapshot.content : JSON.stringify(snapshot.content);
  return [
    CompiledQuery.raw(
      "UPDATE core_publish_version SET current = 0 WHERE object_type = ? AND record_id = ? AND current = 1",
      [object, id],
    ),
    CompiledQuery.raw(
      "INSERT INTO core_publish_version (object_type, record_id, version, content, bytes, current, published_at, published_by, note) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)",
      [object, id, version, content, snapshot.bytes, by.at, by.user, by.note],
    ),
    clearScheduleWrite(object, id),
  ];
}

/** No version is current: the public reads none of it. The versions are kept. */
export function unpublishWrites(object: string, id: string): CompiledQuery[] {
  return [
    CompiledQuery.raw(
      "UPDATE core_publish_version SET current = 0 WHERE object_type = ? AND record_id = ? AND current = 1",
      [object, id],
    ),
    clearScheduleWrite(object, id),
  ];
}

/** A publish of `content` at `at`, replacing any scheduled before. */
export function scheduleWrite(
  object: string,
  id: string,
  at: string,
  snapshot: { content: Record<string, unknown>; bytes: number },
  by: { now: string; user: string; note: string | null },
): CompiledQuery {
  return CompiledQuery.raw(
    "INSERT INTO core_publish_schedule (object_type, record_id, publish_at, content, bytes, note, scheduled_by, scheduled_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (object_type, record_id) DO UPDATE SET publish_at = excluded.publish_at, content = excluded.content, bytes = excluded.bytes, note = excluded.note, scheduled_by = excluded.scheduled_by, scheduled_at = excluded.scheduled_at",
    [object, id, at, JSON.stringify(snapshot.content), snapshot.bytes, by.note, by.user, by.now],
  );
}

export function clearScheduleWrite(object: string, id: string): CompiledQuery {
  return CompiledQuery.raw(
    "DELETE FROM core_publish_schedule WHERE object_type = ? AND record_id = ?",
    [object, id],
  );
}

/** The record's scheduled publish, if any. */
export async function scheduleOf(ctx: HandlerContext, object: string, id: string) {
  return (
    (await ctx.db
      .selectFrom("core_publish_schedule")
      .select(["publish_at", "scheduled_by", "note", "bytes", "content"])
      .where("object_type", "=", object)
      .where("record_id", "=", id)
      .executeTakeFirst()) ?? null
  );
}

/** Whether the record has a current version. */
export async function currentVersion(ctx: HandlerContext, object: string, id: string) {
  const row = await ctx.db
    .selectFrom("core_publish_version")
    .select("version")
    .where("object_type", "=", object)
    .where("record_id", "=", id)
    .where("current", "=", 1)
    .executeTakeFirst();
  return row ? Number(row.version) : null;
}

/** Scheduled publishes due at `now`, oldest first. */
export async function dueSchedules(ctx: HandlerContext, now: string, limit: number) {
  return ctx.db
    .selectFrom("core_publish_schedule")
    .selectAll()
    .where("publish_at", "<=", now)
    .orderBy("publish_at")
    .orderBy("object_type")
    .orderBy("record_id")
    .limit(limit)
    .execute();
}
