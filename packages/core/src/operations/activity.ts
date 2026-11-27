// activity.* operations: log notes, emails, calls and meetings on any records' timelines, edit and
// soft-delete them, and read a record's timeline. `system` activities are written only by the
// pipeline (field changes, job changes, task completion), never through activity.log.
//
// A note has a level (stage 56, ADR 0830): `staff` (every staff account, as every activity was),
// `coaches` or `sensitive`. The seam leaves out of every read here the notes the caller may not
// read (`visibleTable(ctx, "activity")`, visibility/notes.ts); a sensitive one is listed as a
// locked row, its text read by `note.open`. Who may change, delete or lower a note is decided here
// (ADR 0832): its author, or `notes:manage` (with `notes:sensitive` for a sensitive one), and a
// level is changed and a note deleted by a person only.
import type { CoreDatabase } from "@composable-os/db";
import { type Compilable, type CompiledQuery, type Kysely, type Selectable, sql } from "kysely";
import { z } from "zod";
import { enqueueEmbeddings } from "../ai/embedding.ts";
import { deleteSummariesStatement } from "../ai/summaries.ts";
import { diffRecords } from "../diff.ts";
import { ForbiddenError, NotFoundError, ValidationError } from "../errors.ts";
import { activityObject } from "../fields/activity.ts";
import { getObject } from "../fields/index.ts";
import { newId } from "../ids.ts";
import { activityConversationReadable, type InboxViewer } from "../inbox/index.ts";
import {
  decodeCursor,
  encodeCursor,
  listInputSchema,
  pageSchema,
  runListQuery,
  selectFields,
} from "../list.ts";
import { defineOperation, type HandlerContext, type RecordChange } from "../operation.ts";
import { jsonList } from "../records/common.ts";
import {
  assertLinkTargets,
  linkedRecordSchema,
  linkKeys,
  loadLinks,
  recordRefSchema,
  uniqueRefs,
} from "../records/links.ts";
import {
  NOTE_LEVELS,
  type NoteLevel,
  type NoteViewer,
  noteLevelGuard,
  noteRights,
  type Reader,
  visibleTable,
} from "../visibility/index.ts";
import {
  assertKindLevel,
  assertNoRequiredSections,
  DEFAULT_NOTE_KIND,
  type FilledSection,
  filledSectionInput,
  filledSectionSchema,
  fillTemplate,
  LEVEL_RANK,
  loadNoteKind,
  MAX_NOTE_BODY,
  type NoteKind,
  requireUsableKind,
} from "./note-kind.ts";
import { TRASH_RETENTION_DAYS } from "./person.ts";

// --- Schemas -----------------------------------------------------------------------------------

const activityId = z.string().startsWith("act_").max(64).describe("Activity id (act_…)");
const isoDateTime = z.iso
  .datetime({ offset: true })
  .transform((value) => new Date(value).toISOString())
  .describe("ISO-8601 timestamp");

const emailAddressSchema = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email().max(320)),
  name: z.string().trim().max(200).optional(),
});

/** Typed payload per activity type. `system` payloads are written by the pipeline only. */
export const activityPayloadSchemas = {
  note: z.object({}).strict(),
  email: z
    .object({
      direction: z.enum(["inbound", "outbound"]),
      from: emailAddressSchema.optional(),
      to: z.array(emailAddressSchema).max(100).default([]),
      cc: z.array(emailAddressSchema).max(100).default([]),
      messageId: z.string().max(500).optional().describe("RFC 5322 Message-ID, for dedupe"),
      threadId: z.string().max(500).optional(),
    })
    .strict(),
  call: z
    .object({
      direction: z.enum(["inbound", "outbound"]).optional(),
      durationSeconds: z.number().int().min(0).max(86_400).optional(),
      outcome: z.enum(["connected", "no_answer", "voicemail", "busy", "other"]).optional(),
      phoneNumber: z.string().trim().max(50).optional(),
    })
    .strict(),
  meeting: z
    .object({
      startsAt: isoDateTime.optional(),
      endsAt: isoDateTime.optional(),
      location: z.string().trim().max(500).optional(),
      url: z.url().max(1000).optional(),
      attendees: z
        .array(
          z.object({
            email: z.string().trim().toLowerCase().pipe(z.email().max(320)).optional(),
            name: z.string().trim().max(200).optional(),
            personId: z.string().startsWith("per_").max(64).optional(),
          }),
        )
        .max(200)
        .default([]),
    })
    .strict(),
} as const;
export type HumanActivityType = keyof typeof activityPayloadSchemas;
export const HUMAN_ACTIVITY_TYPES = Object.keys(activityPayloadSchemas) as HumanActivityType[];
/** `chat`: a chat message in a conversation, written by the inbox only (stage 36, ADR 0740). */
export const ACTIVITY_TYPES = ["note", "email", "call", "meeting", "system", "chat"] as const;

const commonLogFields = {
  subject: z.string().trim().max(500).nullish().describe("Headline: email subject, call topic"),
  body: z
    .string()
    .max(MAX_NOTE_BODY)
    .nullish()
    .describe("Markdown body: the note, email text, notes"),
  occurredAt: isoDateTime.optional().describe("When it happened. Defaults to now."),
  links: z
    .array(recordRefSchema)
    .min(1)
    .max(50)
    .describe("Records whose timelines show this activity (people, organisations, tasks)"),
};

const levelSchema = z
  .enum(NOTE_LEVELS)
  .describe(
    "Who may read the note: staff (every staff account, the default), coaches (its author, the " +
      "staff who look after the one Person it is about, and managers) or sensitive (its author " +
      "and the people the business named one by one; every opening is recorded). A note at " +
      "coaches or sensitive is about exactly one Person. Notes only.",
  );

const kindIdSchema = z
  .string()
  .startsWith("nkd_")
  .max(64)
  .describe("The kind of note (note.kinds.list). Default: Note");
const sectionsSchema = z
  .array(filledSectionInput)
  .max(12)
  .describe(
    "A note from its kind's template: each section's key and text. The body is made from them; " +
      "give one or the other. A kind with a required section takes its sections.",
  );

const logInputSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("note"),
    ...commonLogFields,
    payload: activityPayloadSchemas.note.default({}),
    kindId: kindIdSchema.optional(),
    sections: sectionsSchema.optional(),
    level: levelSchema
      .optional()
      .describe(
        `${levelSchema.description} Default: the kind's own; never below the kind's lowest.`,
      ),
  }),
  z.object({ type: z.literal("email"), ...commonLogFields, payload: activityPayloadSchemas.email }),
  z.object({
    type: z.literal("call"),
    ...commonLogFields,
    payload: activityPayloadSchemas.call.default({}),
  }),
  z.object({
    type: z.literal("meeting"),
    ...commonLogFields,
    payload: activityPayloadSchemas.meeting.default({ attendees: [] }),
  }),
]);

export const activitySchema = z.object({
  id: z.string(),
  type: z.enum(ACTIVITY_TYPES),
  subject: z.string().nullable(),
  body: z.string().nullable(),
  payload: z.record(z.string(), z.unknown()),
  occurredAt: z.string(),
  authorUserId: z.string().nullable(),
  authorName: z.string().nullable(),
  authorActor: z.string(),
  links: z.array(linkedRecordSchema),
  createdAt: z.string(),
  updatedAt: z.string(),
  deletedAt: z.string().nullable(),
  /** Synced from a mailbox or calendar (stage 6a, ADR 0112). */
  synced: z.boolean().optional(),
  /** Marked private: only its owner (the mailbox's owner) sees it. */
  private: z.boolean().optional(),
  /** For synced activities: what was disclosed (full content or metadata only). */
  disclosure: z.enum(["full", "metadata"]).nullable().optional(),
  /** The full email body is in blob storage: read it with activity.getBody. */
  hasFullBody: z.boolean().optional(),
  /** The email conversation it belongs to. */
  threadKey: z.string().nullable().optional(),
  /** The inbox conversation a message or staff note belongs to (stage 36, ADR 0740). */
  conversationId: z.string().nullable().optional(),
  /** A note kept from the whole staff (stage 56): its level. Absent: `staff`. */
  level: z.enum(["coaches", "sensitive"]).optional(),
  /** A sensitive note listed without its text: open it with note.open (every opening recorded). */
  locked: z.boolean().optional(),
  /** A note's kind (stage 56, ADR 0833). */
  kind: z.object({ id: z.string(), name: z.string() }).optional(),
  /** A note written from its kind's template: the sections filled in, as their labels were. */
  sections: z.array(filledSectionSchema).nullable().optional(),
});
export type Activity = z.infer<typeof activitySchema>;

// --- Reading -----------------------------------------------------------------------------------

type ActivityRow = {
  id: string;
  type: Activity["type"];
  subject: string | null;
  body: string | null;
  payload: string;
  occurred_at: string;
  author_user_id: string | null;
  author_actor: string;
  author_name: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  external_key: string | null;
  private_to: string | null;
  body_ref: string | null;
  disclosure: "full" | "metadata" | null;
  thread_key: string | null;
  conversation_id: string | null;
  level: NoteLevel;
  kind_id: string | null;
  kind_name: string | null;
  sections: string | null;
};

/**
 * Private activities are visible only to the user they were made private for, and the messages
 * and notes of a private conversation only to admins and whoever has it (ADR 0740).
 */
export function visibleTo(user: InboxViewer) {
  return sql<boolean>`((a.private_to IS NULL OR a.private_to = ${user.id}) AND ${activityConversationReadable(user, "a")})`;
}

/** The staff account reading, for `visibleTo`. Anyone else reads no table (visibleTable). */
function viewerOf(reader: Reader): InboxViewer {
  const { principal } = reader;
  return principal.kind === "staff"
    ? { id: principal.userId, role: principal.role }
    : { id: "", role: "viewer" };
}

function activityQuery(reader: Reader) {
  return (
    reader.db
      .selectFrom(visibleTable(reader, "activity", "a"))
      .where(visibleTo(viewerOf(reader)))
      .leftJoin("core_user as u", "u.id", "a.author_user_id")
      // A note held from before kinds, or written by a path that names none, is a Note.
      .leftJoin("core_note_kind as k", (join) =>
        join.on(
          "k.id",
          "=",
          sql<string>`coalesce(a.kind_id, CASE WHEN a.type = 'note' THEN ${DEFAULT_NOTE_KIND} END)`,
        ),
      )
      .select([
        "a.id",
        "a.type",
        "a.subject",
        "a.body",
        "a.payload",
        "a.occurred_at",
        "a.author_user_id",
        "a.author_actor",
        "u.name as author_name",
        "a.created_at",
        "a.updated_at",
        "a.deleted_at",
        "a.external_key",
        "a.private_to",
        "a.body_ref",
        "a.disclosure",
        "a.thread_key",
        "a.level",
        "k.id as kind_id",
        "k.name as kind_name",
        "a.sections",
        "a.conversation_id",
      ])
  );
}

/**
 * Activities from rows the seam returned. A sensitive note is a locked row (its kind, author and
 * date, no text) unless `unlock`: only `note.open` and a write reading its own snapshot pass it.
 */
async function toActivities(
  db: Kysely<CoreDatabase>,
  rows: ActivityRow[],
  { unlock = false } = {},
): Promise<Activity[]> {
  const links = await loadLinks(
    db,
    "core_activity_links",
    rows.map((r) => r.id),
  );
  return rows.map((row) => {
    const locked = row.level === "sensitive" && !unlock;
    return {
      ...activityOf(row, links.get(row.id) ?? []),
      ...(locked ? { subject: null, body: null, payload: {}, sections: null, locked: true } : {}),
    };
  });
}

function activityOf(row: ActivityRow, links: Activity["links"]): Activity {
  return {
    id: row.id,
    type: row.type,
    subject: row.subject,
    body: row.body,
    payload: JSON.parse(row.payload) as Record<string, unknown>,
    occurredAt: row.occurred_at,
    authorUserId: row.author_user_id,
    authorName: row.author_name,
    authorActor: row.author_actor,
    links,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
    synced: row.external_key !== null,
    private: row.private_to !== null,
    disclosure: row.disclosure,
    hasFullBody: row.body_ref !== null,
    threadKey: row.thread_key,
    conversationId: row.conversation_id,
    ...(row.level !== "staff" ? { level: row.level } : {}),
    ...(row.kind_id && row.kind_name ? { kind: { id: row.kind_id, name: row.kind_name } } : {}),
    ...(row.type === "note"
      ? { sections: row.sections ? (JSON.parse(row.sections) as FilledSection[]) : null }
      : {}),
  };
}

/** A note's level: absent on the activity means `staff`. */
export function levelOf(activity: Pick<Activity, "level">): NoteLevel {
  return activity.level ?? "staff";
}

export async function loadActivity(
  reader: Reader,
  id: string,
  { includeDeleted = false, unlock = false } = {},
): Promise<Activity | null> {
  let query = activityQuery(reader).where("a.id", "=", id);
  if (!includeDeleted) query = query.where("a.deleted_at", "is", null);
  const row = await query.executeTakeFirst();
  if (!row) return null;
  const [activity] = await toActivities(reader.db, [row], { unlock });
  return activity ?? null;
}

async function requireActivity(
  reader: Reader,
  id: string,
  options?: { includeDeleted?: boolean; unlock?: boolean },
): Promise<Activity> {
  const activity = await loadActivity(reader, id, options);
  if (!activity) throw new NotFoundError("activity", id);
  return activity;
}

function activitySnapshot(
  a: Pick<Activity, "subject" | "body" | "payload" | "occurredAt">,
  links: string[],
) {
  return {
    subject: a.subject,
    body: a.body,
    payload: a.payload,
    occurredAt: a.occurredAt,
    links,
  };
}

/**
 * A read that returned the text of `coaches` notes is audited, one row per call naming their ids
 * and no text (stage 56, ADR 0830). Sensitive notes are locked here; `note.open` audits those.
 */
export function auditNoteReads(ctx: HandlerContext, activities: readonly Activity[]): void {
  const notes = activities.filter((a) => a.level === "coaches").map((a) => a.id);
  if (notes.length) ctx.auditRead?.({ notes });
}

const REDACTED = "[redacted]";
const TEXT_FIELDS = ["subject", "body"] as const;

/**
 * The audit diff of a change to a note kept from the whole staff: the fields that changed, never
 * their text (ADR 0019's redaction at write). Null for a `staff` note: the pipeline diffs it.
 */
function restrictedChange(
  levels: readonly NoteLevel[],
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
): Pick<RecordChange, "diff" | "restricted"> | null {
  if (levels.every((level) => level === "staff")) return null;
  const diff = diffRecords(before, after);
  for (const field of TEXT_FIELDS) {
    const entry = diff[field];
    if (!entry) continue;
    diff[field] = {
      before: entry.before === null ? null : REDACTED,
      after: entry.after === null ? null : REDACTED,
    };
  }
  return { diff, restricted: true };
}

/** A note at `coaches` or `sensitive` is about exactly one Person, so "whose" has one answer. */
function assertOnePerson(level: NoteLevel, links: readonly { object: string }[]): void {
  if (level === "staff") return;
  if (links.filter((link) => link.object === "person").length !== 1) {
    throw new ValidationError(
      "A note kept to a client's coaches, or sensitive, is about exactly one person: link it to one",
      { field: "links", rule: "note_one_person" },
    );
  }
}

/**
 * Who may change or delete a note (ADR 0832): its author, or `notes:manage` (and, for a sensitive
 * note, `notes:sensitive`), which give an AI actor nothing. Other activity types are unchanged.
 */
function assertMayChange(ctx: HandlerContext, activity: Activity): void {
  if (activity.type !== "note" || activity.authorUserId === ctx.user.id) return;
  const rights = noteRights(ctx as NoteViewer);
  if (rights?.manage && (levelOf(activity) !== "sensitive" || rights.sensitive)) return;
  throw new ForbiddenError(
    "Only the note's author, or someone allowed to manage notes, can change or delete it",
    { permission: "notes:manage", rule: "note_author" },
  );
}

/**
 * What a level change takes with it (ADR 0830). Its vector is queued to be dropped or made again
 * (a kept note has none), whatever path embeds: a kept note's change is no record event. Raised
 * from `staff`, the copies of its text made while every staff account read it go: the cached
 * summaries built from it, and its text in the audit log, by ADR 0019's sanctioned redaction
 * (a marker per row, naming this operation, which keeps the field names).
 */
function levelChangeStatements(
  ctx: HandlerContext,
  id: string,
  beforeLevel: NoteLevel,
): (Compilable | CompiledQuery)[] {
  const out: (Compilable | CompiledQuery)[] = [];
  const queued = enqueueEmbeddings(ctx.db, [{ object: "activity", id }], ctx.now);
  if (queued) out.push(queued);
  if (beforeLevel !== "staff") return out;
  out.push(
    deleteSummariesStatement(ctx.db, [id]),
    sql`INSERT INTO core_audit_redactions (change_id, object_type, record_id, operation, user_id, at)
      SELECT c.id, 'activity', ${id}, ${ctx.operation}, ${ctx.user.id}, ${ctx.now}
      FROM core_audit_changes c
      WHERE c.object_type = 'activity' AND c.record_id = ${id}
        AND NOT EXISTS (SELECT 1 FROM core_audit_redactions r WHERE r.change_id = c.id)`.compile(
      ctx.db,
    ),
    sql`INSERT INTO core_audit_redactions (audit_id, object_type, record_id, operation, user_id, at)
      SELECT a.id, 'activity', ${id}, ${ctx.operation}, ${ctx.user.id}, ${ctx.now}
      FROM core_audit a
      WHERE a.id IN (SELECT c.audit_id FROM core_audit_changes c
                     WHERE c.object_type = 'activity' AND c.record_id = ${id})
        AND a.operation IN ('activity.log', 'activity.update', 'activity.proposeNote')
        AND NOT EXISTS (SELECT 1 FROM core_audit_redactions r WHERE r.audit_id = a.id)`.compile(
      ctx.db,
    ),
  );
  return out;
}

function queueLinks(
  ctx: HandlerContext,
  activityId: string,
  refs: z.infer<typeof recordRefSchema>[],
) {
  ctx.write(ctx.db.deleteFrom("core_activity_links").where("activity_id", "=", activityId));
  if (refs.length) {
    ctx.write(
      ctx.db.insertInto("core_activity_links").values(
        refs.map((ref) => ({
          activity_id: activityId,
          object_type: ref.object,
          record_id: ref.id,
        })),
      ),
    );
  }
}

function requireContent(type: string, subject: string | null, body: string | null) {
  if (type === "note" && !body?.trim()) {
    throw new ValidationError("A note needs a body", { field: "body" });
  }
  if (!subject?.trim() && !body?.trim()) {
    throw new ValidationError("An activity needs a subject or a body", { field: "subject" });
  }
}

/**
 * A note's kind, level and text from what was given (ADR 0833): the kind given (or Note), a level
 * given or the kind's own and never below its lowest, and the body made from the template's
 * sections when they are given. A kind with a required section takes its sections.
 */
async function noteOfKind(
  ctx: HandlerContext,
  input: {
    kindId?: string | undefined;
    level?: NoteLevel | undefined;
    sections?: { key: string; text: string }[] | undefined;
    body?: string | null | undefined;
  },
): Promise<{
  kind: NoteKind;
  level: NoteLevel;
  sections: FilledSection[] | null;
  body: string | null;
}> {
  const kind = await requireUsableKind(ctx, input.kindId ?? DEFAULT_NOTE_KIND);
  const level = input.level ?? kind.defaultLevel;
  assertKindLevel(kind, level);
  if (input.sections) {
    if (input.body?.trim()) {
      throw new ValidationError("A note from a template is written in its sections, not a body", {
        field: "body",
        rule: "note_sections_or_body",
      });
    }
    const filled = fillTemplate(kind, input.sections);
    return { kind, level, sections: filled.sections, body: filled.body || null };
  }
  assertNoRequiredSections(kind);
  return { kind, level, sections: null, body: input.body?.trim() ? input.body : null };
}

// --- Operations --------------------------------------------------------------------------------

export const activityLog = defineOperation({
  name: "activity.log",
  description:
    "Log a note, email, call or meeting on one or more records' timelines (people, " +
    "organisations, tasks). Each type takes a typed payload: email needs a direction and " +
    "optional from/to/cc; call takes direction, durationSeconds and outcome; meeting takes " +
    "startsAt/endsAt, location, url and attendees; note takes none. A note has a kind " +
    "(note.kinds.list; default Note) and a level (default the kind's, never below its lowest); " +
    "a kind with a template takes its sections instead of a body. Notes need a body or " +
    "sections. occurredAt defaults to now. System activities cannot be logged; the CRM posts " +
    "them itself. Returns the activity with its links.",
  input: logInputSchema,
  output: activitySchema,
  permission: "records:write",
  risk: "write",
  // The text is in the change's diff for a staff note, and in no audit row for any other level.
  auditRedact: ["subject", "body", "sections"],
  mcp: { curated: true },
  async handler(input, ctx) {
    const subject = input.subject?.trim() || null;
    const note = input.type === "note" ? await noteOfKind(ctx, input) : null;
    const body = note ? note.body : input.body?.trim() ? input.body : null;
    requireContent(input.type, subject, body);
    const links = uniqueRefs(input.links);
    const level: NoteLevel = note?.level ?? "staff";
    if (level !== "staff" && ctx.actor !== "human") {
      // An AI drafts a note with activity.proposeNote; a note kept from the staff is a person's.
      throw new ForbiddenError(
        "Only a person writes a note kept to a client's coaches or sensitive",
        {
          rule: "note_level_person",
        },
      );
    }
    assertOnePerson(level, links);
    await assertLinkTargets(ctx.db, links, ctx.simulation);

    const id = newId("activity");
    const occurredAt = input.occurredAt ?? ctx.now;
    const payload = input.payload as Record<string, unknown>;
    ctx.write(
      ctx.db.insertInto("core_activity").values({
        id,
        type: input.type,
        subject,
        body,
        payload: JSON.stringify(payload),
        occurred_at: occurredAt,
        author_user_id: ctx.user.id,
        author_actor: ctx.actor === "extension" ? "system" : ctx.actor,
        level,
        ...(note
          ? {
              kind_id: note.kind.id,
              sections: note.sections ? JSON.stringify(note.sections) : null,
              evidence: note.kind.evidence ? 1 : 0,
            }
          : {}),
        created_at: ctx.now,
        updated_at: ctx.now,
      }),
    );
    queueLinks(ctx, id, links);
    const after = {
      type: input.type,
      ...activitySnapshot({ subject, body, payload, occurredAt }, linkKeys(links)),
      ...(note ? { kind: note.kind.id } : {}),
      ...(level !== "staff" ? { level } : {}),
    };
    ctx.recordChange({
      object: "activity",
      id,
      action: "create",
      ...(restrictedChange([level], null, after) ?? { after }),
    });
    return ctx.afterCommit(() => requireActivity(ctx, id));
  },
});

export const activityProposeNote = defineOperation({
  name: "activity.proposeNote",
  description:
    "Propose a note on a record for the person to OK, instead of adding it straight away. Use it " +
    "for a fact about a customer the person wants kept: memory.propose refuses those, and this " +
    "puts them on the record, where the team can see them. It always waits in the person's " +
    "approvals, with Approve and Reject shown right here, and nothing is added until then.",
  input: z.object({
    record: z
      .object({ object: z.string().min(1).max(100), id: z.string().min(1).max(100) })
      .describe("The record the note goes on, e.g. { object: 'person', id: 'per_…' }"),
    body: z.string().trim().min(1).max(10_000).describe("The note, in plain words"),
  }),
  output: activitySchema,
  permission: "records:write",
  risk: "write",
  alwaysReview: true,
  async handler(input, ctx) {
    return activityLog.handler(
      activityLog.input.parse({ type: "note", body: input.body, links: [input.record] }),
      ctx,
    );
  },
});

export const activityGet = defineOperation({
  name: "activity.get",
  description:
    "Get one activity by id with its payload, author and linked records. Deleted activities " +
    "are not found unless includeDeleted is true. Read-only.",
  input: z.object({ id: activityId, includeDeleted: z.boolean().default(false) }),
  output: activitySchema,
  permission: "records:read",
  risk: "read",
  // Its rows name notes kept from the staff: they are for people (stage 56, ADR 0830).
  auditForPeople: true,
  mcp: { idempotent: true },
  async handler(input, ctx) {
    // Private ones, and a private conversation's, are not found for anyone else (visibleTo).
    const activity = await requireActivity(ctx, input.id, {
      includeDeleted: input.includeDeleted,
    });
    if (activity.private && activity.authorUserId !== ctx.user.id) {
      throw new NotFoundError("activity", input.id);
    }
    auditNoteReads(ctx, [activity]);
    return activity;
  },
});

export const activityUpdate = defineOperation({
  name: "activity.update",
  description:
    "Edit a note, email, call or meeting: subject, body, occurredAt, payload (validated for the " +
    "activity's type, replacing the old payload), links (replacing the list), or a note's level, " +
    "kind (kindId) and template sections (which remake its body). The type cannot change. " +
    "System activities cannot be edited. A note is changed by its author or someone allowed to " +
    "manage notes; lowering a level is a person's, with that permission, and never below the " +
    "kind's lowest. Returns the updated activity.",
  input: z.object({
    id: activityId,
    subject: commonLogFields.subject,
    body: commonLogFields.body,
    occurredAt: isoDateTime.optional(),
    payload: z.record(z.string(), z.unknown()).optional().describe("Typed by the activity's type"),
    links: commonLogFields.links.optional(),
    level: levelSchema.optional(),
    kindId: kindIdSchema.optional(),
    sections: sectionsSchema.optional(),
  }),
  output: activitySchema,
  permission: "records:write",
  risk: "write",
  auditRedact: ["subject", "body", "sections"],
  async handler(input, ctx) {
    const before = await requireActivity(ctx, input.id, { unlock: true });
    if (before.type === "system") {
      throw new ValidationError("System activities are written by the host and cannot be edited");
    }
    if (before.conversationId || before.type === "chat") {
      throw new ValidationError(
        "A message or note in a conversation is the inbox's and cannot be edited",
      );
    }
    assertMayChange(ctx, before);
    const beforeLevel = levelOf(before);
    const level = input.level ?? beforeLevel;
    if (level !== beforeLevel) {
      if (before.type !== "note") {
        throw new ValidationError("Only a note has a level", { field: "level" });
      }
      if (ctx.actor !== "human") {
        throw new ForbiddenError("Only a person changes a note's level", {
          rule: "note_level_person",
        });
      }
      const rights = noteRights(ctx as NoteViewer);
      if (
        LEVEL_RANK[level] < LEVEL_RANK[beforeLevel] &&
        !(rights?.manage && (beforeLevel !== "sensitive" || rights.sensitive))
      ) {
        throw new ForbiddenError("Lowering a note's level needs permission to manage notes", {
          permission: "notes:manage",
          rule: "note_level_lower",
        });
      }
    }
    if (before.type !== "note" && (input.kindId !== undefined || input.sections !== undefined)) {
      throw new ValidationError("Only a note has a kind and sections", { field: "kindId" });
    }
    // A note is held to its kind (ADR 0833): a kind it moves to is one in use, its level never
    // below the kind's lowest, and sections given remake its body from the kind's template.
    const beforeKindId = before.kind?.id ?? DEFAULT_NOTE_KIND;
    const kindId = input.kindId ?? beforeKindId;
    if (kindId !== beforeKindId && ctx.actor !== "human") {
      // A kind decides where a note starts and, with stage 56 step 7, whether an erase keeps it
      // as evidence: moving a note to another is a person's act, as changing its level is.
      throw new ForbiddenError("Only a person moves a note to another kind", {
        rule: "note_kind_person",
      });
    }
    const kind =
      before.type !== "note"
        ? null
        : kindId !== beforeKindId
          ? await requireUsableKind(ctx, kindId)
          : level !== beforeLevel || input.sections !== undefined
            ? await loadNoteKind(ctx, kindId)
            : null;
    if (kind && (kindId !== beforeKindId || level !== beforeLevel)) assertKindLevel(kind, level);
    let sections: FilledSection[] | null | undefined;
    let templateBody: string | null | undefined;
    if (input.sections !== undefined && kind) {
      if (input.body?.trim()) {
        throw new ValidationError("A note from a template is written in its sections, not a body", {
          field: "body",
          rule: "note_sections_or_body",
        });
      }
      const filled = fillTemplate(kind, input.sections);
      sections = filled.sections;
      templateBody = filled.body || null;
    } else {
      // Moved to another kind with no sections given: held to that kind's template as a new
      // note is, and the old kind's sections leave it (its body stays the note).
      if (kind && kindId !== beforeKindId) assertNoRequiredSections(kind);
      if (before.sections?.length && (input.body !== undefined || kindId !== beforeKindId)) {
        // A body written over a template note is the note now: its sections no longer say it.
        sections = null;
      }
    }
    const subject = input.subject === undefined ? before.subject : input.subject?.trim() || null;
    const body =
      templateBody !== undefined
        ? templateBody
        : input.body === undefined
          ? before.body
          : input.body?.trim()
            ? input.body
            : null;
    requireContent(before.type, subject, body);
    let payload = before.payload;
    if (input.payload !== undefined) {
      const parsed = activityPayloadSchemas[before.type].safeParse(input.payload);
      if (!parsed.success) {
        throw new ValidationError(`Invalid ${before.type} payload`, {
          issues: parsed.error.issues,
        });
      }
      payload = parsed.data as Record<string, unknown>;
    }
    const occurredAt = input.occurredAt ?? before.occurredAt;
    const beforeLinks = linkKeys(before.links);
    let afterLinks = beforeLinks;
    if (input.links !== undefined) {
      const links = uniqueRefs(input.links);
      assertOnePerson(level, links);
      await assertLinkTargets(ctx.db, links, ctx.simulation);
      queueLinks(ctx, input.id, links);
      afterLinks = linkKeys(links);
    } else {
      assertOnePerson(level, before.links);
    }
    ctx.write(
      // Planned from the level read above: a level changed meanwhile fails the batch whole, so a
      // stale edit never puts back a level someone raised, nor lowers one it was not judged on.
      noteLevelGuard(input.id, beforeLevel).compile(ctx.db),
      ctx.db
        .updateTable("core_activity")
        .set({
          subject,
          body,
          payload: JSON.stringify(payload),
          occurred_at: occurredAt,
          ...(level !== beforeLevel ? { level } : {}),
          ...(kind && kindId !== beforeKindId
            ? // Evidence is copied from the kind at write and never taken away (step 7).
              { kind_id: kindId, evidence: sql<0 | 1>`max(evidence, ${kind.evidence ? 1 : 0})` }
            : {}),
          ...(sections !== undefined
            ? { sections: sections ? JSON.stringify(sections) : null }
            : {}),
          updated_at: ctx.now,
        })
        .where("id", "=", input.id),
    );
    if (level !== beforeLevel) ctx.write(...levelChangeStatements(ctx, input.id, beforeLevel));
    const beforeSnapshot = {
      ...activitySnapshot(before, beforeLinks),
      ...(before.type === "note" ? { kind: beforeKindId } : {}),
      ...(beforeLevel !== "staff" ? { level: beforeLevel } : {}),
    };
    const afterSnapshot = {
      ...activitySnapshot({ subject, body, payload, occurredAt }, afterLinks),
      ...(before.type === "note" ? { kind: kindId } : {}),
      ...(level !== "staff" ? { level } : {}),
    };
    ctx.recordChange({
      object: "activity",
      id: input.id,
      action: "update",
      ...(restrictedChange([beforeLevel, level], beforeSnapshot, afterSnapshot) ?? {
        before: beforeSnapshot,
        after: afterSnapshot,
      }),
    });
    return ctx.afterCommit(() => requireActivity(ctx, input.id));
  },
});

export const activityDelete = defineOperation({
  name: "activity.delete",
  description:
    "Move an activity to Trash (soft delete). It disappears from every linked record's timeline " +
    `and from search, and can be restored with activity.restore for ${TRASH_RETENTION_DAYS} days.`,
  input: z.object({ id: activityId }),
  output: z.object({ id: z.string(), deletedAt: z.string(), restorableUntil: z.string() }),
  permission: "records:write",
  risk: "destructive",
  async handler(input, ctx) {
    const activity = await requireActivity(ctx, input.id);
    if (activity.type === "note" && ctx.actor !== "human") {
      // An AI never deletes a note (stage 56, ADR 0832), whoever approves.
      throw new ForbiddenError("Only a person deletes a note", { rule: "note_delete_person" });
    }
    assertMayChange(ctx, activity);
    ctx.write(
      ctx.db
        .updateTable("core_activity")
        .set({ deleted_at: ctx.now, deleted_by: ctx.user.id, updated_at: ctx.now })
        .where("id", "=", input.id),
    );
    ctx.recordChange({
      object: "activity",
      id: input.id,
      action: "delete",
      diff: { deletedAt: { before: null, after: ctx.now } },
      ...(levelOf(activity) !== "staff" ? { restricted: true as const } : {}),
    });
    const until = new Date(Date.parse(ctx.now) + TRASH_RETENTION_DAYS * 86_400_000);
    return { id: input.id, deletedAt: ctx.now, restorableUntil: until.toISOString() };
  },
});

export const activityRestore = defineOperation({
  name: "activity.restore",
  description:
    "Restore an activity from Trash, putting it back on its linked records' timelines. " +
    "Returns the restored activity.",
  input: z.object({ id: activityId }),
  output: activitySchema,
  permission: "records:write",
  risk: "write",
  async handler(input, ctx) {
    const activity = await requireActivity(ctx, input.id, { includeDeleted: true });
    if (!activity.deletedAt) throw new ValidationError("This activity is not in Trash");
    assertMayChange(ctx, activity);
    ctx.write(
      ctx.db
        .updateTable("core_activity")
        .set({ deleted_at: null, deleted_by: null, updated_at: ctx.now })
        .where("id", "=", input.id),
    );
    ctx.recordChange({
      object: "activity",
      id: input.id,
      action: "restore",
      diff: { deletedAt: { before: activity.deletedAt, after: null } },
      ...(levelOf(activity) !== "staff" ? { restricted: true as const } : {}),
    });
    return ctx.afterCommit(() => requireActivity(ctx, input.id));
  },
});

const TIMELINE_SORT = { field: "occurredAt", direction: "desc" } as const;

export const activityListForRecord = defineOperation({
  name: "activity.listForRecord",
  description:
    "A record's timeline: live activities linked to the record, newest first (by occurredAt), " +
    "one page at a time. Filter by types (e.g. ['note', 'email']); include 'system' to see " +
    "field changes and job changes. Pass nextCursor back as cursor for the next page. Read-only.",
  input: z.object({
    object: recordRefSchema.shape.object,
    recordId: recordRefSchema.shape.id,
    types: z.array(z.enum(ACTIVITY_TYPES)).min(1).max(5).optional(),
    cursor: z.string().max(1000).optional(),
    limit: z.number().int().min(1).max(100).default(25),
  }),
  output: pageSchema(activitySchema),
  permission: "records:read",
  risk: "read",
  auditForPeople: true,
  mcp: { curated: true, idempotent: true },
  async handler(input, ctx) {
    let query = activityQuery(ctx)
      .where("a.deleted_at", "is", null)
      .where("a.id", "in", (eb) =>
        eb
          .selectFrom("core_activity_links")
          .select("activity_id")
          .where("object_type", "=", input.object)
          .where("record_id", "=", input.recordId),
      );
    if (input.types) query = query.where("a.type", "in", jsonList(input.types));
    if (input.cursor) {
      const cursor = decodeCursor(input.cursor, TIMELINE_SORT);
      query = query.where(
        sql<boolean>`(a.occurred_at < ${cursor.v} OR (a.occurred_at = ${cursor.v} AND a.id < ${cursor.id}))`,
      );
    }
    const rows = await query
      .orderBy("a.occurred_at", "desc")
      .orderBy("a.id", "desc")
      .limit(input.limit + 1)
      .execute();
    const page = rows.slice(0, input.limit);
    const last = page.at(-1);
    const items = await toActivities(ctx.db, page);
    auditNoteReads(ctx, items);
    return {
      items,
      nextCursor:
        rows.length > input.limit && last
          ? encodeCursor({ f: TIMELINE_SORT.field, d: "desc", v: last.occurred_at, id: last.id })
          : null,
    };
  },
});

const ACTIVITY_FIELDS = Object.keys(activitySchema.shape);

export const activityList = defineOperation({
  name: "activity.list",
  description:
    "List live activities across all records (the Activity feed), newest first by default, one " +
    "page at a time. Filter with structured filter JSON over activity fields, e.g. { field: " +
    "'type', op: 'in', value: ['note', 'call'] }, { field: 'authorUserId', op: 'eq', value: " +
    "'usr_…' } or { field: 'occurredAt', op: 'gte', value: '2026-01-01' }; linkedRecordId " +
    "finds activities on a record (for one record's timeline prefer activity.listForRecord). " +
    "Each item includes its linked records. Pass nextCursor back as cursor for the next page. " +
    "Read-only.",
  input: listInputSchema,
  output: pageSchema(activitySchema.partial().required({ id: true })),
  permission: "records:read",
  risk: "read",
  mcp: { idempotent: true },
  async handler(input, ctx) {
    const page = await runListQuery<Selectable<CoreDatabase["rec_activity"]>>(
      ctx,
      getObject("activity") ?? activityObject,
      input,
    );
    const ids = page.rows.map((row) => row.id);
    const rows = ids.length
      ? await activityQuery(ctx).where("a.id", "in", jsonList(ids)).execute()
      : [];
    const byId = new Map(rows.map((row) => [row.id, row]));
    const ordered = ids.flatMap((id) => {
      const row = byId.get(id);
      return row ? [row] : [];
    });
    const items = await toActivities(ctx.db, ordered);
    return {
      items: selectFields(items, input.fields, ACTIVITY_FIELDS),
      nextCursor: page.nextCursor,
    };
  },
});

export const activitySetPrivate = defineOperation({
  name: "activity.setPrivate",
  description:
    "Mark a synced email or meeting private (only you see it: it leaves everyone else's " +
    "timelines, search and SQL views) or shared again. Only the owner of the mailbox or " +
    "calendar it was synced from can do this. People only.",
  input: z.object({ id: activityId, private: z.boolean() }),
  output: activitySchema,
  permission: "records:write",
  risk: "write",
  actors: ["human"],
  mcp: { expose: false },
  async handler(input, ctx) {
    const row = await ctx.db
      .selectFrom(visibleTable(ctx, "activity"))
      .select(["id", "external_key", "author_user_id", "private_to", "conversation_id"])
      .where("id", "=", input.id)
      .where("deleted_at", "is", null)
      .executeTakeFirst();
    if (!row || (row.private_to !== null && row.private_to !== ctx.user.id)) {
      throw new NotFoundError("activity", input.id);
    }
    if (row.external_key === null || row.conversation_id !== null) {
      throw new ValidationError(
        "Only synced emails and meetings can be marked private (a conversation is marked private as a whole)",
      );
    }
    if (row.author_user_id !== ctx.user.id) {
      throw new ForbiddenError("Only the owner of the mailbox it came from can change this");
    }
    const privateTo = input.private ? ctx.user.id : null;
    ctx.write(
      ctx.db
        .updateTable("core_activity")
        .set({ private_to: privateTo, updated_at: ctx.now })
        .where("id", "=", row.id),
    );
    // A summary built from it would keep serving its words to everyone (stage 36 review).
    if (input.private) ctx.write(deleteSummariesStatement(ctx.db, [row.id]));
    ctx.recordChange({
      object: "activity",
      id: row.id,
      action: "update",
      before: { private: row.private_to !== null },
      after: { private: input.private },
    });
    return ctx.afterCommit(() => requireActivity(ctx, row.id));
  },
});

export const activityGetBody = defineOperation({
  name: "activity.getBody",
  description:
    "The full body of a synced email whose mailbox shares full content (kept in blob " +
    "storage; timelines show a snippet). Falls back to the stored snippet. Read-only.",
  input: z.object({ id: activityId }),
  output: z.object({ id: z.string(), body: z.string().nullable(), full: z.boolean() }),
  permission: "records:read",
  risk: "read",
  auditForPeople: true,
  mcp: { idempotent: true },
  async handler(input, ctx) {
    const row = await ctx.db
      .selectFrom(visibleTable(ctx, "activity", "a"))
      .select(["a.id", "a.body", "a.body_ref", "a.level"])
      .where("a.id", "=", input.id)
      .where("a.deleted_at", "is", null)
      .where(visibleTo(ctx.user))
      .executeTakeFirst();
    if (!row) throw new NotFoundError("activity", input.id);
    // A sensitive note's text is read with note.open, each opening recorded.
    if (row.level === "sensitive") return { id: row.id, body: null, full: false };
    if (row.level === "coaches") ctx.auditRead?.({ notes: [row.id] });
    if (row.body_ref && ctx.blobs) {
      const body = await ctx.blobs.get(row.body_ref);
      if (body !== null) return { id: row.id, body, full: true };
    }
    return { id: row.id, body: row.body, full: false };
  },
});

export const activityOperations = [
  activitySetPrivate,
  activityGetBody,
  activityLog,
  activityProposeNote,
  activityGet,
  activityUpdate,
  activityDelete,
  activityRestore,
  activityListForRecord,
  activityList,
] as const;
