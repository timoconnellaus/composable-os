// Publishing (ADR 0446, completed by stage 28's ADR 0441): the one module that writes
// core_publish_version and core_publish_schedule. The operations in operations/record-versions.ts
// call it; nothing else writes either table.
//
// A version is a snapshot of the object's content fields, taken when a person publishes or
// schedules. Scheduling takes it then, not when the cron runs, so what goes live is what the
// person decided on: an edit made afterwards (by anyone, the assistant included) waits for the
// next publish.
//
// An AI actor may ask for any of the four publish operations (ADR 0480). Its request always waits
// for a person (the operations' `alwaysReview`), shows what would go live against what is live
// (`publishDiff`), and applies only while the working copy is exactly what was asked for (the
// fingerprint under DRAFT_KEY, which the pipeline compares on approval).
import { documentBytes } from "@composable-os/sdk";
import { CompiledQuery, sql } from "kysely";
import { type FieldDiff, valuesEqual } from "../diff.ts";
import { ConflictError, ValidationError } from "../errors.ts";
import type { ObjectDefinition, PublishableDefinition } from "../fields/types.ts";
import type { HandlerContext } from "../operation.ts";
import type { Actor } from "../principals.ts";
import { mediaUsesOf } from "./media.ts";

/** The operations that change what the public reads; only a person approves an AI's request. */
export const PUBLISH_OPERATIONS: ReadonlySet<string> = new Set([
  "record.publish",
  "record.schedulePublish",
  "record.unpublish",
  "record.cancelSchedule",
]);

/**
 * The actors whose publish requests always wait for a person (ADR 0480): every actor that is not
 * a person. No policy preset, floor, agent grant or adjudicator lets one through.
 */
export const ALWAYS_REVIEWED_PUBLISHERS: readonly Actor[] = [
  "assistant",
  "mcp",
  "automation",
  "extension",
];

/**
 * The key of a publish's diff that holds the working copy's fingerprint: on approval the pipeline
 * refuses the request as stale when the working copy is no longer what was asked for. The
 * approvals inbox does not show it.
 */
export const DRAFT_KEY = "draftFingerprint";

/** Who publishes: the person, or for an approved request the approver, and who asked. */
export function publisherOf(ctx: HandlerContext): {
  user: string;
  requestedBy: string | null;
  requestedVia: Actor | null;
} {
  return ctx.approval
    ? { user: ctx.approval.approvedBy, requestedBy: ctx.user.id, requestedVia: ctx.actor }
    : { user: ctx.user.id, requestedBy: null, requestedVia: null };
}

/** SHA-256 of the record's content fields as they are in the working copy (before any fill). */
export async function draftFingerprint(
  object: PublishableObject,
  record: RecordValues,
): Promise<string> {
  const content = object.publishable.content.map((f) => [f, record.values[f] ?? null]);
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(content)),
  );
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Applying an approved request: the working copy must be the one that was asked for, the one the
 * approver saw, and what is live and scheduled what it was then. Anything else (an edit since, by
 * anyone, or a publish meanwhile) is refused as a conflict, and the request is asked for again.
 * `now` holds the working copy's fingerprint under DRAFT_KEY and the values the request's diff
 * starts from (`publishedVersion`, `publishAt`). A person's own publish is not a request and skips
 * this. The pipeline's own check (assertUnchangedSincePreview) reads only the first change of a
 * record, which is the date filled in when a publish fills one; this reads the publish's own.
 */
export function assertAskedFor(
  ctx: HandlerContext,
  object: string,
  id: string,
  now: Record<string, unknown>,
): void {
  if (!ctx.approval) return;
  const asked = ctx.approval.preview.find(
    (p) => p.object === object && p.id === id && DRAFT_KEY in p.diff,
  )?.diff;
  const changed = asked
    ? Object.keys(now).find((key) => key in asked && !valuesEqual(asked[key]?.before, now[key]))
    : DRAFT_KEY;
  if (changed) {
    throw new ConflictError(
      `The ${object} ${id} changed after this publish was asked for (${changed}), so what would ` +
        "go live is not what was approved. Ask for the publish again.",
      { object, id, field: changed, reason: "changed_since_request" },
    );
  }
}

/** The longest a value is shown in a publish's diff; a longer one is shown as its start. */
const SUMMARY_CHARS = 280;

/** The words of a document (rich text, a layout): every `text` in it, in order. */
function documentWords(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) documentWords(item, out);
  } else if (value && typeof value === "object") {
    for (const [key, v] of Object.entries(value)) {
      if (key === "text" && typeof v === "string") out.push(v);
      else documentWords(v, out);
    }
  }
  return out;
}

/** A field's value as a reviewer reads it in a publish's diff: short, never a whole document. */
export function summaryOf(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  const cut = (text: string) =>
    text.length > SUMMARY_CHARS ? `${text.slice(0, SUMMARY_CHARS).trimEnd()}…` : text;
  if (typeof value === "string") return cut(value);
  if (typeof value !== "object") return value;
  const words = documentWords(value).join(" ").replace(/\s+/g, " ").trim();
  return words ? cut(words) : `(${documentBytes(value)} bytes)`;
}

/**
 * The diff of a publish (or a scheduled one): `extra` (the version, the schedule), each content
 * field whose working value differs from the live one, as summaries (live before, working after),
 * and the working copy's fingerprint.
 */
export function publishDiff(
  object: PublishableObject,
  live: Record<string, unknown> | null,
  working: RecordValues,
  fingerprint: string,
  extra: FieldDiff,
): FieldDiff {
  const diff: FieldDiff = { ...extra };
  for (const field of object.publishable.content) {
    const before = live ? (live[field] ?? null) : null;
    const after = working.values[field] ?? null;
    if (valuesEqual(before, after)) continue;
    const b = summaryOf(before);
    let a = summaryOf(after);
    // Two long values that start alike: say it changed further on.
    if (valuesEqual(b, a)) a = `${String(a)} (changed further on)`;
    diff[field] = { before: b, after: a };
  }
  diff[DRAFT_KEY] = { before: fingerprint, after: fingerprint };
  return diff;
}

/** The record's current version and its content, or null when it is not published. */
export async function liveContent(
  ctx: HandlerContext,
  object: string,
  id: string,
): Promise<{ version: number; content: Record<string, unknown> } | null> {
  const row = await ctx.db
    .selectFrom("core_publish_version")
    .select(["version", "content"])
    .where("object_type", "=", object)
    .where("record_id", "=", id)
    .where("current", "=", 1)
    .executeTakeFirst();
  return row
    ? { version: Number(row.version), content: JSON.parse(row.content) as Record<string, unknown> }
    : null;
}

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
  definition: ObjectDefinition,
  id: string,
  version: number,
  snapshot: { content: Record<string, unknown> | string; bytes: number },
  by: {
    at: string;
    user: string | null;
    note: string | null;
    requestedBy?: string | null;
    requestedVia?: string | null;
  },
): CompiledQuery[] {
  const object = definition.name;
  const content =
    typeof snapshot.content === "string" ? snapshot.content : JSON.stringify(snapshot.content);
  const values =
    typeof snapshot.content === "string"
      ? (JSON.parse(snapshot.content) as Record<string, unknown>)
      : snapshot.content;
  return [
    // The media the new current version references (ADR 0444): what the public may be served.
    ...publishedMediaWrites(object, id, mediaUsesOf(definition, values)),
    CompiledQuery.raw(
      "UPDATE core_publish_version SET current = 0 WHERE object_type = ? AND record_id = ? AND current = 1",
      [object, id],
    ),
    CompiledQuery.raw(
      "INSERT INTO core_publish_version (object_type, record_id, version, content, bytes, current, published_at, published_by, note, requested_by, requested_via) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)",
      [
        object,
        id,
        version,
        content,
        snapshot.bytes,
        by.at,
        by.user,
        by.note,
        by.requestedBy ?? null,
        by.requestedVia ?? null,
      ],
    ),
    clearScheduleWrite(object, id),
  ];
}

/** No version is current: the public reads none of it. The versions are kept. */
export function unpublishWrites(object: string, id: string): CompiledQuery[] {
  return [
    ...publishedMediaWrites(object, id, []),
    CompiledQuery.raw(
      "UPDATE core_publish_version SET current = 0 WHERE object_type = ? AND record_id = ? AND current = 1",
      [object, id],
    ),
    clearScheduleWrite(object, id),
  ];
}

/** The record's rows of core_published_media, replaced by `media`. */
function publishedMediaWrites(
  object: string,
  id: string,
  uses: { media: string; field: string }[],
): CompiledQuery[] {
  return [
    CompiledQuery.raw("DELETE FROM core_published_media WHERE object_type = ? AND record_id = ?", [
      object,
      id,
    ]),
    ...uses.map((use) =>
      CompiledQuery.raw(
        "INSERT OR IGNORE INTO core_published_media (media_id, object_type, record_id, field) VALUES (?, ?, ?, ?)",
        [use.media, object, id, use.field],
      ),
    ),
  ];
}

/** A publish of `content` at `at`, replacing any scheduled before. */
export function scheduleWrite(
  object: string,
  id: string,
  at: string,
  snapshot: { content: Record<string, unknown>; bytes: number },
  by: {
    now: string;
    user: string;
    note: string | null;
    requestedBy: string | null;
    requestedVia: string | null;
  },
): CompiledQuery {
  return CompiledQuery.raw(
    "INSERT INTO core_publish_schedule (object_type, record_id, publish_at, content, bytes, note, scheduled_by, scheduled_at, requested_by, requested_via) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (object_type, record_id) DO UPDATE SET publish_at = excluded.publish_at, content = excluded.content, bytes = excluded.bytes, note = excluded.note, scheduled_by = excluded.scheduled_by, scheduled_at = excluded.scheduled_at, requested_by = excluded.requested_by, requested_via = excluded.requested_via",
    [
      object,
      id,
      at,
      JSON.stringify(snapshot.content),
      snapshot.bytes,
      by.note,
      by.user,
      by.now,
      by.requestedBy,
      by.requestedVia,
    ],
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
      .select([
        "publish_at",
        "scheduled_by",
        "note",
        "bytes",
        "content",
        "requested_by",
        "requested_via",
      ])
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
