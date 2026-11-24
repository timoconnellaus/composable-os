// Journeys (stage 53 step 3, ADR 0800): messages that go out on their own to one person at a time
// because of what they did or stopped doing. A journey's working copy is written by staff (and the
// assistant for them); a person publishes it as a version nobody can change, after seeing every
// message filled in for a sample Person. Only a published version runs. Nothing here sends: the
// engine and the send decision are step 4.
//
//   journey.list / get / version / preview     staff (journeys:read): read
//   journey.create, update, archive            staff (journeys:manage): the working copy; the
//                                              assistant may write it, through the gate
//   journey.publish                            staff (journeys:publish): a person publishes; an AI's
//                                              call is a request only a person with the right
//                                              approves (ADR 0480), never the adjudicator
//   journey.goLive, resume                     staff (journeys:manage), a person only
//   journey.pause                              staff (journeys:manage), any actor
//   journey.enter                              staff (journeys:manage), bulk-write, up to 500
//   journey.stop                               staff (records:write): one entry, or a Person's
//   journey.entries, log                       staff: journeys:read, or a Person's own for anyone
//                                              who reads the Person
//   journey.settings, settings.update          read: journeys:read; update: a human admin, not on MCP
//
// Staff audience only: nothing here is open to customers or the public.
import { sql } from "kysely";
import { z } from "zod";
import { ADJUDICATOR_PRINCIPAL } from "../adjudicator/review.ts";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../errors.ts";
import { getObject, listObjects } from "../fields/index.ts";
import { newId } from "../ids.ts";
import {
  allowedReplyTo,
  definitionSchema,
  ENTRY_EXCLUSIONS,
  ENTRY_STATES,
  enterStatements,
  entryCandidates,
  JOURNEY_KINDS,
  JOURNEY_SETTING,
  JOURNEY_STATUSES,
  JOURNEY_WEEK_CAP,
  type JourneyDefinition,
  type JourneyKind,
  journeyHash,
  journeyProblems,
  journeySummary,
  LIVE_ENTRY_STATES,
  loadJourneySettings,
  MAX_MANUAL_ENTRY,
  type Problem,
  parseDefinition,
  renderJourney,
  type SampleValues,
  signalsNamed,
} from "../journeys/index.ts";
import { defineOperation, type HandlerContext } from "../operation.ts";
import { holdsPermission } from "../principals.ts";
import { jsonList } from "../records/common.ts";
import { ALWAYS_REVIEWED_PUBLISHERS } from "../records/publish.ts";
import { loadRoutineMailSettings } from "../routine-mail/index.ts";
import { loadGeneralSettings } from "../settings.ts";
import { GUARDIAN_LINK } from "../visibility/guardians.ts";

/** Journeys a page of journey.list holds. */
const LIST_PAGE = 100;

const journeyId = z.string().min(1).max(64).describe("The journey's id (jny_…)");

type JourneyRow = {
  id: string;
  name: string;
  kind: JourneyKind;
  status: (typeof JOURNEY_STATUSES)[number];
  owner_id: string | null;
  draft: string;
  draft_rev: number;
  draft_updated_at: string;
  draft_updated_by: string;
  draft_updated_via: string;
  draft_ai: number;
  current_version_id: string | null;
  starter: string | null;
  created_at: string;
  created_by: string;
  status_at: string | null;
  status_by: string | null;
};

type VersionRow = {
  id: string;
  journey_id: string;
  number: number;
  definition: string;
  summary: string;
  hash: string;
  draft_rev: number;
  drafted_by: "person" | "assistant";
  published_at: string;
  published_by: string;
  requested_by: string | null;
  requested_via: string | null;
};

const countsSchema = z.object({
  active: z.number(),
  waiting: z.number(),
  held: z.number(),
  finished: z.number(),
  stopped: z.number(),
});

const versionRef = z.object({ id: z.string(), number: z.number() }).nullable();

const journeySummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.enum(JOURNEY_KINDS),
  status: z.enum(JOURNEY_STATUSES),
  ownerId: z.string().nullable(),
  starter: z.string().nullable().describe("The starter the host seeded it from, if any"),
  current: versionRef.describe("The newest published version: new entries start on it"),
  unpublishedChanges: z.boolean().describe("The working copy differs from the newest version"),
  counts: countsSchema.describe("Entries by state"),
  draftUpdatedAt: z.string(),
});

const problemSchema = z.object({ path: z.string(), message: z.string() });

const versionSchema = z.object({
  id: z.string(),
  journeyId: z.string(),
  number: z.number(),
  definition: z.unknown(),
  summary: z.string(),
  hash: z.string(),
  intact: z.boolean().describe("The hash recomputed from the stored definition matches"),
  draftedBy: z.enum(["person", "assistant"]),
  publishedAt: z.string(),
  publishedBy: z.string(),
  requestedBy: z.string().nullable(),
  requestedVia: z.string().nullable(),
});

const entrySchema = z.object({
  id: z.string(),
  journeyId: z.string(),
  journeyName: z.string(),
  versionNumber: z.number(),
  personId: z.string(),
  state: z.enum(ENTRY_STATES),
  step: z.string(),
  nextAt: z.string().nullable(),
  enteredAt: z.string(),
  enteredBy: z.enum(["signal", "scan", "birthday", "person"]),
  causeStanding: z.enum(["person", "host", "ai"]),
  endedAt: z.string().nullable(),
  stoppedBy: z.string().nullable(),
  stopReason: z.string().nullable(),
});

async function loadJourney(ctx: HandlerContext, id: string): Promise<JourneyRow> {
  const row = await ctx.db
    .selectFrom("core_journey")
    .selectAll()
    .where("id", "=", id)
    .executeTakeFirst();
  if (!row) throw new NotFoundError("journey", id);
  return row as JourneyRow;
}

async function versionsOf(ctx: HandlerContext, id: string): Promise<VersionRow[]> {
  return (await ctx.db
    .selectFrom("core_journey_version")
    .selectAll()
    .where("journey_id", "=", id)
    .orderBy("number")
    .execute()) as VersionRow[];
}

async function currentVersion(ctx: HandlerContext, row: JourneyRow): Promise<VersionRow | null> {
  if (!row.current_version_id) return null;
  return ((await ctx.db
    .selectFrom("core_journey_version")
    .selectAll()
    .where("id", "=", row.current_version_id)
    .executeTakeFirst()) ?? null) as VersionRow | null;
}

const emptyCounts = () => ({ active: 0, waiting: 0, held: 0, finished: 0, stopped: 0 });

async function countsOf(
  ctx: HandlerContext,
  ids: string[],
): Promise<Map<string, z.infer<typeof countsSchema>>> {
  const out = new Map<string, z.infer<typeof countsSchema>>();
  if (!ids.length) return out;
  const rows = await ctx.db
    .selectFrom("core_journey_entry")
    .select(["journey_id", "state", (eb) => eb.fn.countAll<number>().as("n")])
    // One bound JSON value whatever the number of journeys (D1: 100 bound variables a statement).
    .where("journey_id", "in", jsonList(ids))
    .groupBy(["journey_id", "state"])
    .execute();
  for (const row of rows) {
    const counts = out.get(row.journey_id) ?? emptyCounts();
    counts[row.state as keyof typeof counts] = Number(row.n);
    out.set(row.journey_id, counts);
  }
  return out;
}

function summarise(
  row: JourneyRow,
  current: { id: string; number: number; hash: string } | null,
  draftHash: string,
  counts: z.infer<typeof countsSchema> | undefined,
): z.infer<typeof journeySummarySchema> {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    status: row.status,
    ownerId: row.owner_id,
    starter: row.starter,
    current: current ? { id: current.id, number: current.number } : null,
    unpublishedChanges: !current || current.hash !== draftHash,
    counts: counts ?? emptyCounts(),
    draftUpdatedAt: row.draft_updated_at,
  };
}

/** The working copy, parsed; a stored copy that no longer parses is shown as a problem. */
function draftOf(row: JourneyRow): JourneyDefinition | null {
  return parseDefinition(row.draft);
}

/** The staff accounts (people, not extensions, not deactivated) among `ids`. */
async function staffAmong(ctx: HandlerContext, ids: readonly string[]): Promise<Set<string>> {
  const unique = [...new Set(ids)].filter((id) => id !== "owner");
  if (!unique.length) return new Set();
  const rows = await ctx.db
    .selectFrom("core_user")
    .select("id")
    .where("id", "in", unique)
    .where("kind", "=", "human")
    .where("deactivated_at", "is", null)
    .execute();
  return new Set(rows.map((r) => r.id));
}

/** What stops the working copy from being published, with the context the checks need. */
async function problemsOf(
  ctx: HandlerContext,
  row: JourneyRow,
  definition: JourneyDefinition | null,
): Promise<Problem[]> {
  if (!definition) {
    return [{ path: "", message: "The working copy cannot be read: save it again" }];
  }
  const assignees = definition.steps.flatMap((s) => (s.type === "task" ? [s.assignee] : []));
  const problems = journeyProblems(definition, row.kind, {
    allowedReplyTo: await allowedReplyTo(ctx.db),
    staffIds: await staffAmong(ctx, assignees),
  });
  if (assignees.includes("owner") && !row.owner_id) {
    problems.push({
      path: "ownerId",
      message: "A task goes to the owner: choose the journey's owner",
    });
  }
  return problems;
}

/** A reply-to that is not an allowed address is refused on save (criterion 17), not only at publish. */
async function refuseReplyTo(ctx: HandlerContext, definition: JourneyDefinition): Promise<void> {
  if (!definition.replyTo) return;
  const allowed = await allowedReplyTo(ctx.db);
  if (!allowed.includes(definition.replyTo.trim().toLowerCase())) {
    throw new ValidationError(
      "Replies can only go to an address a human admin allowed in Settings → Journeys",
      { rule: "journey_reply_to" },
    );
  }
}

async function refuseOwner(ctx: HandlerContext, ownerId: string | null | undefined) {
  if (!ownerId) return;
  if (!(await staffAmong(ctx, [ownerId])).has(ownerId)) {
    throw new ValidationError("A journey's owner is a member of staff", { rule: "journey_owner" });
  }
}

const draftChanged = () =>
  new ConflictError(
    "The journey's working copy changed since it was read. Read it again and try again.",
    { rule: "journey_draft_changed" },
  );

function refuseArchived(row: JourneyRow) {
  if (row.status === "archived") {
    throw new ConflictError("This journey is archived: it no longer changes", {
      rule: "journey_archived",
    });
  }
}

/** Whether the caller may read every journey's entries (else only a Person's they ask for). */
const readsJourneys = (ctx: HandlerContext) =>
  holdsPermission(ctx.user, ctx.permissionGrants, "journeys:read");

async function toVersion(
  row: VersionRow,
  kind: JourneyKind,
): Promise<z.infer<typeof versionSchema>> {
  let definition: unknown = null;
  try {
    definition = JSON.parse(row.definition);
  } catch {
    definition = null;
  }
  return {
    id: row.id,
    journeyId: row.journey_id,
    number: row.number,
    definition,
    summary: row.summary,
    hash: row.hash,
    intact: (await journeyHash(kind, row.definition)) === row.hash,
    draftedBy: row.drafted_by,
    publishedAt: row.published_at,
    publishedBy: row.published_by,
    requestedBy: row.requested_by,
    requestedVia: row.requested_via,
  };
}

export const journeyList = defineOperation({
  name: "journey.list",
  description:
    "List the business's journeys (messages that go out on their own to one person at a time: a " +
    "welcome series, a nudge when someone stops coming): each with its kind (service or " +
    "promotional), status (draft, live, paused, archived), newest published version, whether the " +
    "working copy has unpublished changes, and how many entries are active, waiting, held, " +
    "finished and stopped. The four starter journeys are seeded as drafts. 100 a page (nextCursor). Read-only.",
  input: z.object({
    archived: z.boolean().default(false).describe("Include archived journeys"),
    cursor: z.string().max(200).optional().describe("The previous page's nextCursor"),
  }),
  output: z.object({
    items: z.array(journeySummarySchema),
    nextCursor: z.string().nullable().describe("Pass it back for the next page; null: no more"),
  }),
  permission: "journeys:read",
  risk: "read",
  mcp: { idempotent: true },
  async handler(input, ctx) {
    let query = ctx.db
      .selectFrom("core_journey as j")
      .leftJoin("core_journey_version as v", "v.id", "j.current_version_id")
      .selectAll("j")
      .select(["v.number as current_number", "v.hash as current_hash"]);
    if (!input.archived) query = query.where("j.status", "!=", "archived");
    const after = input.cursor ? input.cursor.split("|") : null;
    if (after?.length === 2) {
      const [at, id] = after as [string, string];
      query = query.where((eb) =>
        eb.or([
          eb("j.created_at", ">", at),
          eb.and([eb("j.created_at", "=", at), eb("j.id", ">", id)]),
        ]),
      );
    }
    const page = await query
      .orderBy("j.created_at")
      .orderBy("j.id")
      .limit(LIST_PAGE + 1)
      .execute();
    const rows = page.slice(0, LIST_PAGE);
    const counts = await countsOf(
      ctx,
      rows.map((r) => r.id),
    );
    const last = rows.at(-1);
    return {
      items: await Promise.all(
        rows.map(async (row) =>
          summarise(
            row as JourneyRow,
            row.current_version_id && row.current_number !== null && row.current_hash !== null
              ? { id: row.current_version_id, number: row.current_number, hash: row.current_hash }
              : null,
            await journeyHash(row.kind, row.draft),
            counts.get(row.id),
          ),
        ),
      ),
      nextCursor: page.length > LIST_PAGE && last ? `${last.created_at}|${last.id}` : null,
    };
  },
});

export const journeyGet = defineOperation({
  name: "journey.get",
  description:
    "One journey: its summary, the working copy (entry rule, conditions, exits, re-entry rule, " +
    "reply-to and steps with their words), its rev and hash, whether an AI wrote it since the " +
    "last publish, what stops it from being published, the plain-words summary, and its " +
    "versions, newest first, without their steps (journey.version reads one). Read-only.",
  input: z.object({ id: journeyId }),
  output: journeySummarySchema.extend({
    draft: z.unknown().describe("The working copy (null when it cannot be read)"),
    draftRev: z.number(),
    draftHash: z.string(),
    draftUpdatedBy: z.string(),
    draftUpdatedVia: z.string(),
    draftedByAssistant: z.boolean().describe("An AI wrote the working copy since the last publish"),
    problems: z.array(problemSchema).describe("Why it cannot be published yet (empty: it can)"),
    summary: z.string().nullable().describe("The working copy in plain words"),
    versions: z.array(versionSchema.omit({ definition: true, summary: true })),
  }),
  permission: "journeys:read",
  risk: "read",
  mcp: { idempotent: true },
  async handler(input, ctx) {
    const row = await loadJourney(ctx, input.id);
    const versions = await versionsOf(ctx, row.id);
    const draft = draftOf(row);
    const draftHash = await journeyHash(row.kind, row.draft);
    const current = versions.find((v) => v.id === row.current_version_id) ?? null;
    const counts = (await countsOf(ctx, [row.id])).get(row.id);
    return {
      ...summarise(row, current, draftHash, counts),
      draft,
      draftRev: row.draft_rev,
      draftHash,
      draftUpdatedBy: row.draft_updated_by,
      draftUpdatedVia: row.draft_updated_via,
      draftedByAssistant: row.draft_ai === 1,
      problems: await problemsOf(ctx, row, draft),
      summary: draft ? journeySummary(draft, row.kind) : null,
      versions: (
        await Promise.all(
          versions.map(async (v) => {
            const { definition: _d, summary: _s, ...rest } = await toVersion(v, row.kind);
            return rest;
          }),
        )
      ).reverse(),
    };
  },
});

export const journeyVersionGet = defineOperation({
  name: "journey.version",
  description:
    "One published version of a journey, exactly as it runs: its steps and words, the plain-words " +
    "summary its publisher was shown, who published it (and, for an AI's request, who asked), and " +
    "whether an AI drafted it. A version never changes. Read-only.",
  input: z.object({ id: z.string().min(1).max(64).describe("The version's id (jnv_…)") }),
  output: versionSchema,
  permission: "journeys:read",
  risk: "read",
  mcp: { idempotent: true },
  async handler(input, ctx) {
    const row = await ctx.db
      .selectFrom("core_journey_version")
      .selectAll()
      .where("id", "=", input.id)
      .executeTakeFirst();
    if (!row) throw new NotFoundError("journey version", input.id);
    const journey = await loadJourney(ctx, row.journey_id);
    return toVersion(row as VersionRow, journey.kind);
  },
});

const DEFAULT_DEFINITION: z.input<typeof definitionSchema> = {
  entry: { type: "manual" },
  steps: [{ id: "end", type: "end" }],
};

export const journeyCreate = defineOperation({
  name: "journey.create",
  description:
    "Start a new journey as a draft: its name, kind (service: about something the member has or " +
    "did; promotional: needs the Person's recorded yes, never about a child; fixed once made), " +
    "and optionally its owner and a first working copy. Nothing is sent and nobody enters until " +
    "a person publishes it and sets it live. The reply-to must be an address a human admin " +
    "allowed. The assistant may create one for someone who holds journeys:manage.",
  input: z.object({
    name: z.string().trim().min(1).max(120),
    kind: z.enum(JOURNEY_KINDS),
    ownerId: z.string().min(1).max(64).nullable().optional(),
    definition: definitionSchema.optional(),
  }),
  output: z.object({ id: z.string(), draftRev: z.number() }),
  permission: "journeys:manage",
  risk: "write",
  async handler(input, ctx) {
    const definition = input.definition ?? definitionSchema.parse(DEFAULT_DEFINITION);
    await refuseReplyTo(ctx, definition);
    await refuseOwner(ctx, input.ownerId);
    const id = newId("journey");
    ctx.write(
      ctx.db.insertInto("core_journey").values({
        id,
        name: input.name,
        kind: input.kind,
        owner_id: input.ownerId ?? null,
        draft: JSON.stringify(definition),
        draft_updated_at: ctx.now,
        draft_updated_by: ctx.user.id,
        draft_updated_via: ctx.actor,
        draft_ai: ctx.actor === "human" ? 0 : 1,
        created_at: ctx.now,
        created_by: ctx.user.id,
      }),
    );
    return { id, draftRev: 0 };
  },
});

export const journeyUpdate = defineOperation({
  name: "journey.update",
  description:
    "Change a journey: its name, its owner (who gets tasks assigned to the owner; a person only), " +
    "or its working " +
    "copy, given whole: entry rule, conditions, exits, re-entry rule, includeBulk, the reply-to " +
    "(an address a human admin allowed) and the steps (send, wait, branch, task, end) with their " +
    "words. It changes no published version and sends nothing: a person publishes. draftRev, " +
    "when given, is the copy's rev the change was made against: a copy saved since is refused. " +
    "The assistant may write it for someone who holds journeys:manage; the publish dialog then " +
    "says it was drafted by the assistant.",
  input: z.object({
    id: journeyId,
    draftRev: z.number().int().min(0).optional(),
    name: z.string().trim().min(1).max(120).optional(),
    ownerId: z.string().min(1).max(64).nullable().optional(),
    definition: definitionSchema.optional(),
  }),
  output: z.object({ id: z.string(), draftRev: z.number(), draftHash: z.string() }),
  permission: "journeys:manage",
  risk: "write",
  async handler(input, ctx) {
    const row = await loadJourney(ctx, input.id);
    refuseArchived(row);
    if (input.draftRev !== undefined && input.draftRev !== row.draft_rev) throw draftChanged();
    if (input.ownerId !== undefined && input.ownerId !== row.owner_id) {
      // The owner gets the "owner" task steps of every published version, which no publish
      // covers: who they go to is a person's choice, never an AI's.
      if (ctx.actor !== "human") {
        throw new ForbiddenError("A person chooses a journey's owner", { rule: "journey_owner" });
      }
      await refuseOwner(ctx, input.ownerId);
    }
    const set: Record<string, unknown> = {};
    if (input.name !== undefined) set.name = input.name;
    if (input.ownerId !== undefined) set.owner_id = input.ownerId;
    let draft = row.draft;
    let rev = row.draft_rev;
    if (input.definition) {
      await refuseReplyTo(ctx, input.definition);
      draft = JSON.stringify(input.definition);
      rev = row.draft_rev + 1;
      Object.assign(set, {
        draft,
        // Compare-and-set: the trigger refuses anything but the stored rev plus one.
        draft_rev: rev,
        draft_updated_at: ctx.now,
        draft_updated_by: ctx.user.id,
        draft_updated_via: ctx.actor,
        draft_ai: ctx.actor === "human" ? row.draft_ai : 1,
      });
    }
    if (Object.keys(set).length) {
      ctx.write(ctx.db.updateTable("core_journey").set(set).where("id", "=", row.id));
    }
    return { id: row.id, draftRev: rev, draftHash: await journeyHash(row.kind, draft) };
  },
});

export const journeyArchive = defineOperation({
  name: "journey.archive",
  description:
    "Archive a journey: it stops for good, every entry on it is stopped, and it no longer " +
    "changes; it cannot be undone. Its versions and log are kept. Sends nothing. A person only: " +
    "an AI may pause a journey, never archive one. Needs journeys:manage. Audited.",
  input: z.object({ id: journeyId }),
  output: z.object({ id: z.string(), stopped: z.number().describe("Entries stopped") }),
  permission: "journeys:manage",
  risk: "write",
  // It cannot be undone (the triggers refuse every change of an archived journey, and journeys
  // are never deleted), and the spec lets an AI pause, not end, a journey.
  actors: ["human"],
  mcp: { expose: false },
  async handler(input, ctx) {
    if (ctx.actor !== "human") throw new ForbiddenError("Only a person archives a journey");
    const row = await loadJourney(ctx, input.id);
    refuseArchived(row);
    const live = await ctx.db
      .selectFrom("core_journey_entry")
      .select((eb) => eb.fn.countAll<number>().as("n"))
      .where("journey_id", "=", row.id)
      .where("state", "in", LIVE_ENTRY_STATES)
      .executeTakeFirst();
    ctx.write(
      ctx.db
        .updateTable("core_journey_entry")
        .set({
          state: "stopped",
          next_at: null,
          ended_at: ctx.now,
          stopped_by: ctx.user.id,
          stop_reason: "archived",
        })
        .where("journey_id", "=", row.id)
        .where("state", "in", LIVE_ENTRY_STATES),
      ctx.db
        .updateTable("core_journey")
        .set({ status: "archived", status_at: ctx.now, status_by: ctx.user.id })
        .where("id", "=", row.id),
    );
    return { id: row.id, stopped: Number(live?.n ?? 0) };
  },
});

const messageSchema = z.object({
  subject: z.string(),
  body: z.string(),
  holds: z.array(z.string()).describe("Why this message would be held for a person (empty: none)"),
});

export const journeyPreview = defineOperation({
  name: "journey.preview",
  description:
    "Render every message of a journey for a sample Person, as the publish dialog shows them: " +
    "the working copy (or a published version by number), each send step's subject and body " +
    "filled in for the Person (and, where the step has one, the guardian's version), with what " +
    "would hold a message for a person; the plain-words summary; what stops it from being " +
    "published; whether an AI drafted it; and the draftHash, draftRev and number to pass to " +
    "journey.publish. personId left out: sample values. Sends nothing. Read-only.",
  input: z.object({
    id: journeyId,
    version: z.number().int().min(1).optional().describe("A published version's number"),
    personId: z.string().min(1).max(64).optional().describe("The sample Person (per_…)"),
    record: z
      .object({ object: z.string().min(1).max(80), id: z.string().min(1).max(64) })
      .optional()
      .describe("A sample record for {record} (the record whose signal started the entry)"),
  }),
  output: z.object({
    number: z.number().describe("The version a publish now would make, or the one shown"),
    draftHash: z.string().nullable(),
    draftRev: z.number().nullable(),
    draftedByAssistant: z.boolean(),
    summary: z.string(),
    problems: z.array(problemSchema),
    person: z.object({ id: z.string(), name: z.string() }).nullable(),
    messages: z.array(
      z.object({
        step: z.string(),
        position: z.number(),
        member: messageSchema,
        guardian: messageSchema.nullable(),
      }),
    ),
  }),
  permission: "journeys:read",
  risk: "read",
  mcp: { idempotent: true },
  async handler(input, ctx) {
    const row = await loadJourney(ctx, input.id);
    const versions = await versionsOf(ctx, row.id);
    let definition: JourneyDefinition | null;
    let shown: VersionRow | null = null;
    if (input.version !== undefined) {
      shown = versions.find((v) => v.number === input.version) ?? null;
      if (!shown) throw new NotFoundError("journey version", String(input.version));
      definition = parseDefinition(shown.definition);
    } else definition = draftOf(row);
    if (!definition) {
      throw new ValidationError("The working copy cannot be read: save it again", {
        rule: "journey_unreadable",
      });
    }
    const general = await loadGeneralSettings(ctx.db);
    const { siteOrigin } = await loadRoutineMailSettings(ctx.db);
    let person: { id: string; name: string } | null = null;
    const member: SampleValues = { firstName: "Alex", business: general.orgName, record: null };
    const guardian: SampleValues = {
      firstName: "Sam",
      business: general.orgName,
      record: null,
      member: "Alex",
    };
    if (input.personId) {
      // Through the visibility seam: the Person as this caller may read them.
      const read = await ctx.records.get("person", input.personId);
      const text = (v: unknown) => (typeof v === "string" && v.trim() ? v : null);
      person = { id: input.personId, name: text(read.values.displayName) ?? input.personId };
      member.firstName = text(read.values.givenName);
      guardian.member = member.firstName;
      // The guardian's version is shown for the first live guardian, where there is one: the
      // link is a part of the Person read above; the guardian is read through the seam too.
      const link = await ctx.db
        .selectFrom("core_person_link")
        .select("guardian_id")
        .where("dependant_id", "=", person.id)
        .where("kind", "=", GUARDIAN_LINK)
        .where("ended_at", "is", null)
        .orderBy("created_at")
        .executeTakeFirst();
      const g = link ? await ctx.records.get("person", link.guardian_id).catch(() => null) : null;
      if (g) guardian.firstName = text(g.values.givenName);
    }
    if (input.record) {
      // The sample record as this caller may read it, by its object's title field.
      const object = getObject(input.record.object);
      const read = object
        ? await ctx.records.get(object.name, input.record.id).catch(() => null)
        : null;
      const title = read
        ? ([object?.titleField, "displayName", "name", "title", "subject"]
            .map((f) => (f ? read.values[f] : undefined))
            .find((v) => typeof v === "string" && v.trim()) as string | undefined)
        : undefined;
      member.record = title?.trim().slice(0, 200) ?? null;
      guardian.record = member.record;
    } else {
      member.record = "(the record that started it)";
      guardian.record = member.record;
    }
    const messages = renderJourney(definition, { member, guardian }, siteOrigin);
    return {
      number: shown ? shown.number : (versions.at(-1)?.number ?? 0) + 1,
      draftHash: shown ? null : await journeyHash(row.kind, row.draft),
      draftRev: shown ? null : row.draft_rev,
      draftedByAssistant: shown ? shown.drafted_by === "assistant" : row.draft_ai === 1,
      summary: shown ? shown.summary : journeySummary(definition, row.kind),
      problems: shown ? [] : await problemsOf(ctx, row, definition),
      person,
      messages,
    };
  },
});

/** The words of each message, keyed by step, as a reviewer reads them. */
function messagesOf(definition: JourneyDefinition | null): Map<string, string> {
  const out = new Map<string, string>();
  for (const step of definition?.steps ?? []) {
    if (step.type !== "send") continue;
    out.set(
      step.id,
      [
        `Subject: ${step.subject}`,
        step.body,
        ...(step.guardian
          ? ["", `To a child's guardians: ${step.guardian.subject}`, step.guardian.body]
          : []),
      ].join("\n"),
    );
  }
  return out;
}

/**
 * A publish's diff: the version it makes, who drafted it, the plain-words summary, and every
 * message's exact words (slots and all) against the newest version's. An AI's request is
 * approved on this, in the Approvals inbox (ADR 0800).
 */
function publishDiffOf(
  latest: VersionRow | null,
  version: VersionRow,
  definition: JourneyDefinition,
): Record<string, { before: unknown; after: unknown }> {
  const before = messagesOf(latest ? parseDefinition(latest.definition) : null);
  const after = messagesOf(definition);
  const diff: Record<string, { before: unknown; after: unknown }> = {
    version: { before: latest?.number ?? null, after: version.number },
    draftedBy: { before: latest?.drafted_by ?? null, after: version.drafted_by },
    summary: { before: latest?.summary ?? null, after: version.summary },
  };
  let n = 0;
  for (const [step, words] of after) {
    n += 1;
    diff[`message ${n} (${step})`] = { before: before.get(step) ?? null, after: words };
  }
  for (const [step, words] of before) {
    if (!after.has(step)) diff[`removed message (${step})`] = { before: words, after: null };
  }
  return diff;
}

export const journeyPublish = defineOperation({
  name: "journey.publish",
  description:
    "Publish a journey's working copy as its next version: the approval of its wording. Only a " +
    "published version runs, and its messages then go out without anyone approving each send " +
    "(once a human admin turned journeys on). draftHash, draftRev and number are journey.preview's: " +
    "a copy changed since is refused. moveEntries moves people already on it to the new version " +
    "where their step is still in it; otherwise they carry on with the version they started on. " +
    "Needs journeys:publish. An AI's call (the assistant, an MCP client) is a request that always " +
    "waits for a person who holds journeys:publish; the adjudicator never approves one. Audited.",
  input: z.object({
    id: journeyId,
    draftHash: z.string().regex(/^[0-9a-f]{64}$/),
    draftRev: z.number().int().min(0),
    number: z.number().int().min(1).describe("The version number the preview showed"),
    moveEntries: z.boolean().default(false),
  }),
  output: z.object({ version: versionSchema, moved: z.number() }),
  permission: "journeys:publish",
  risk: "write",
  alwaysReview: ALWAYS_REVIEWED_PUBLISHERS,
  auditSummary: (output) => ({
    journeyId: output.version.journeyId,
    versionId: output.version.id,
    number: output.version.number,
    hash: output.version.hash,
    draftedBy: output.version.draftedBy,
  }),
  async handler(input, ctx) {
    // Who publishes: the person, or for an AI's approved request the person who approved it. The
    // adjudicator never approves one (the request's review source is `always`); refused here too.
    // (The approval queue's dry run of a request is a simulation: nothing it writes commits.)
    if (ctx.actor !== "human" && !ctx.approval && !ctx.simulation) {
      throw new ForbiddenError("An AI asks to publish a journey; a person approves it");
    }
    if (ctx.approval?.approvedBy === ADJUDICATOR_PRINCIPAL) {
      throw new ForbiddenError(
        "A journey's wording is approved by a person, never the adjudicator",
      );
    }
    const publishedBy = ctx.approval ? ctx.approval.approvedBy : ctx.user.id;
    const row = await loadJourney(ctx, input.id);
    refuseArchived(row);
    const draftHash = await journeyHash(row.kind, row.draft);
    if (draftHash !== input.draftHash || row.draft_rev !== input.draftRev) throw draftChanged();
    const definition = draftOf(row);
    const problems = await problemsOf(ctx, row, definition);
    if (!definition || problems.length) {
      throw new ValidationError(
        `This journey cannot be published yet: ${problems.map((p) => p.message).join("; ")}`,
        { rule: "journey_incomplete", problems },
      );
    }
    const versions = await versionsOf(ctx, row.id);
    const latest = versions.at(-1);
    // The number the person was shown: another publish in between makes this something else.
    if (input.number !== (latest?.number ?? 0) + 1) throw draftChanged();
    if (latest && latest.hash === draftHash) {
      throw new ConflictError(
        `Nothing changed since version ${latest.number}: there is nothing to publish.`,
        { rule: "journey_unchanged" },
      );
    }
    const version: VersionRow = {
      id: newId("journeyVersion"),
      journey_id: row.id,
      number: (latest?.number ?? 0) + 1,
      // The stored working copy as it is: the insert trigger compares it at commit.
      definition: row.draft,
      summary: journeySummary(definition, row.kind),
      hash: draftHash,
      draft_rev: input.draftRev,
      drafted_by: row.draft_ai === 1 ? "assistant" : "person",
      published_at: ctx.now,
      published_by: publishedBy,
      requested_by: ctx.approval ? ctx.user.id : null,
      requested_via: ctx.approval ? ctx.actor : null,
    };
    ctx.write(
      ctx.db.insertInto("core_journey_version").values(version),
      // The reviewed rev is spent, and the next copy starts as a person's until an AI writes it.
      ctx.db
        .updateTable("core_journey")
        .set({ draft_rev: input.draftRev + 1, draft_ai: 0, current_version_id: version.id })
        .where("id", "=", row.id),
    );
    // What the approver of an AI's request sees (its preview is this change), and what the audit
    // keeps: every message's exact words beside the newest version's, and the summary.
    ctx.recordChange({
      object: "journey",
      id: row.id,
      action: "update",
      diff: publishDiffOf(latest ?? null, version, definition),
    });
    let moved = 0;
    if (input.moveEntries && row.current_version_id) {
      const steps = definition.steps.map((s) => s.id);
      const count = await ctx.db
        .selectFrom("core_journey_entry")
        .select((eb) => eb.fn.countAll<number>().as("n"))
        .where("journey_id", "=", row.id)
        .where("state", "in", LIVE_ENTRY_STATES)
        .where("step", "in", steps)
        .executeTakeFirst();
      moved = Number(count?.n ?? 0);
      ctx.write(
        ctx.db
          .updateTable("core_journey_entry")
          .set({ version_id: version.id })
          .where("journey_id", "=", row.id)
          .where("state", "in", LIVE_ENTRY_STATES)
          .where("step", "in", steps),
      );
    }
    return { version: await toVersion(version, row.kind), moved };
  },
});

const statusOutput = z.object({ id: z.string(), status: z.enum(JOURNEY_STATUSES) });

/** Before going live or resuming: a published version whose reply-to is still allowed. */
async function refuseNotRunnable(ctx: HandlerContext, row: JourneyRow): Promise<void> {
  const current = await currentVersion(ctx, row);
  const definition = current ? parseDefinition(current.definition) : null;
  if (!current || !definition) {
    throw new ConflictError("Publish the journey before setting it live", {
      rule: "journey_unpublished",
    });
  }
  if (current.hash !== (await journeyHash(row.kind, current.definition))) {
    throw new ConflictError("The published version does not match its hash", {
      rule: "journey_not_intact",
    });
  }
  // Every signal it names is one an installed shipped pack declares (stage 53 step 2, ADR 0802):
  // a journey listening for a signal nothing records would wait for ever.
  const declared = new Set(listObjects().flatMap((o) => (o.signals ?? []).map((s) => s.id)));
  const missing = signalsNamed(definition).filter((signal) => !declared.has(signal));
  if (missing.length) {
    throw new ConflictError(
      `No installed pack declares ${missing.join(", ")}: install it, or publish the journey without it`,
      { rule: "journey_signal", missing },
    );
  }
  const allowed = await allowedReplyTo(ctx.db);
  if (!definition.replyTo || !allowed.includes(definition.replyTo.toLowerCase())) {
    throw new ConflictError(
      "The journey's reply-to is no longer an address an admin allows: publish it with another",
      { rule: "journey_reply_to" },
    );
  }
  const usesOwner = definition.steps.some((s) => s.type === "task" && s.assignee === "owner");
  if (usesOwner && !(row.owner_id && (await staffAmong(ctx, [row.owner_id])).has(row.owner_id))) {
    throw new ConflictError("A task goes to the owner: choose the journey's owner first", {
      rule: "journey_owner",
    });
  }
}

export const journeyGoLive = defineOperation({
  name: "journey.goLive",
  description:
    "Set a published journey live: from now on, people who meet its entry rule enter it (nobody " +
    "who already qualified before is added; add them with journey.enter if you choose). Every " +
    "signal it names must be one an installed pack declares. A person only: an AI may never set " +
    "a journey live. Needs journeys:manage. Audited.",
  input: z.object({ id: journeyId }),
  output: statusOutput,
  permission: "journeys:manage",
  risk: "write",
  actors: ["human"],
  mcp: { expose: false },
  async handler(input, ctx) {
    if (ctx.actor !== "human") throw new ForbiddenError("Only a person sets a journey live");
    const row = await loadJourney(ctx, input.id);
    refuseArchived(row);
    if (row.status !== "draft") {
      throw new ConflictError(`This journey is ${row.status}`, { rule: "journey_status" });
    }
    await refuseNotRunnable(ctx, row);
    ctx.write(
      ctx.db
        .updateTable("core_journey")
        .set({ status: "live", status_at: ctx.now, status_by: ctx.user.id })
        .where("id", "=", row.id),
    );
    return { id: row.id, status: "live" as const };
  },
});

export const journeyPause = defineOperation({
  name: "journey.pause",
  description:
    "Pause a live journey: nobody enters it and its entries wait where they are until a person " +
    "resumes it. The assistant may pause one. Sends nothing.",
  input: z.object({ id: journeyId }),
  output: statusOutput,
  permission: "journeys:manage",
  risk: "write",
  async handler(input, ctx) {
    const row = await loadJourney(ctx, input.id);
    if (row.status !== "live") {
      throw new ConflictError(`This journey is ${row.status}, not live`, {
        rule: "journey_status",
      });
    }
    ctx.write(
      ctx.db
        .updateTable("core_journey")
        .set({ status: "paused", status_at: ctx.now, status_by: ctx.user.id })
        .where("id", "=", row.id),
    );
    return { id: row.id, status: "paused" as const };
  },
});

export const journeyResume = defineOperation({
  name: "journey.resume",
  description:
    "Resume a paused journey: its entries carry on and people enter it again. A person only: an " +
    "AI may never resume one. Needs journeys:manage. Audited.",
  input: z.object({ id: journeyId }),
  output: statusOutput,
  permission: "journeys:manage",
  risk: "write",
  actors: ["human"],
  mcp: { expose: false },
  async handler(input, ctx) {
    if (ctx.actor !== "human") throw new ForbiddenError("Only a person resumes a journey");
    const row = await loadJourney(ctx, input.id);
    if (row.status !== "paused") {
      throw new ConflictError(`This journey is ${row.status}, not paused`, {
        rule: "journey_status",
      });
    }
    await refuseNotRunnable(ctx, row);
    ctx.write(
      ctx.db
        .updateTable("core_journey")
        .set({ status: "live", status_at: ctx.now, status_by: ctx.user.id })
        .where("id", "=", row.id),
    );
    return { id: row.id, status: "live" as const };
  },
});

export const journeyEnter = defineOperation({
  name: "journey.enter",
  description:
    "Add people to a live journey by hand (one, a selection, or a saved view's people; up to " +
    "500 at a time), at its first step on the newest version. Leaves out, and says why, anyone " +
    "not found or in the trash, a minor on a promotional journey, anyone already on it, and " +
    "anyone its re-entry rule keeps off. A bulk write: an AI's call waits for review under " +
    "Balanced, and its entries' messages are held for a person unless a person approved it.",
  input: z.object({
    id: journeyId,
    personIds: z.array(z.string().min(1).max(64)).min(1).max(MAX_MANUAL_ENTRY),
  }),
  output: z.object({
    entered: z.array(z.object({ personId: z.string(), entryId: z.string() })),
    excluded: z.array(z.object({ personId: z.string(), why: z.enum(ENTRY_EXCLUSIONS) })),
  }),
  permission: "journeys:manage",
  risk: "bulk-write",
  bulkSize: (input) => input.personIds.length,
  auditSummary: (output, input) => ({
    journeyId: input.id,
    entered: output.entered.length,
    excluded: output.excluded.length,
  }),
  async handler(input, ctx) {
    const row = await loadJourney(ctx, input.id);
    if (row.status !== "live") {
      throw new ConflictError(`This journey is ${row.status}: people enter only a live one`, {
        rule: "journey_status",
      });
    }
    const current = await currentVersion(ctx, row);
    const definition = current ? parseDefinition(current.definition) : null;
    const first = definition?.steps[0];
    if (!current || !definition || !first) {
      throw new ConflictError("The journey's published version cannot be read", {
        rule: "journey_unpublished",
      });
    }
    const { add, excluded } = await entryCandidates(ctx.db, {
      journeyId: row.id,
      kind: row.kind,
      reentry: definition.reentry,
      personIds: input.personIds,
      now: ctx.now,
    });
    // A person's entry, or an AI's that a person approved; an AI's that no person approved (an
    // autonomous preset, the adjudicator) is the AI's, and step 4 holds its messages.
    const standing =
      ctx.actor === "human" ||
      (ctx.approval !== undefined && ctx.approval.approvedBy !== ADJUDICATOR_PRINCIPAL)
        ? "person"
        : "ai";
    const rows = add.map((personId) => ({
      personId,
      entryId: newId("journeyEntry"),
      logId: newId("journeyStepLog"),
    }));
    const statements = enterStatements(ctx.db, {
      journeyId: row.id,
      versionId: current.id,
      firstStep: first.id,
      rows,
      userId: ctx.user.id,
      standing,
      now: ctx.now,
    });
    if (statements.length) ctx.write(...statements);
    return {
      entered: rows.map((r) => ({ personId: r.personId, entryId: r.entryId })),
      excluded,
    };
  },
});

export const journeyStop = defineOperation({
  name: "journey.stop",
  description:
    "Stop a Person's journey: one entry (entryId), or every journey they are on (personId, " +
    "optionally only journeyId's). They get nothing more from it; what was sent stays in the log. " +
    "Anyone who may update the Person; the assistant may stop one.",
  input: z
    .object({
      entryId: z.string().min(1).max(64).optional(),
      personId: z.string().min(1).max(64).optional(),
      journeyId: journeyId.optional(),
      reason: z.string().trim().max(200).optional(),
    })
    .refine((v) => Boolean(v.entryId) !== Boolean(v.personId), "Give entryId or personId"),
  output: z.object({ stopped: z.array(z.string()).describe("The entries stopped") }),
  permission: "records:write",
  risk: "write",
  async handler(input, ctx) {
    let query = ctx.db
      .selectFrom("core_journey_entry")
      .select("id")
      .where("state", "in", LIVE_ENTRY_STATES);
    if (input.entryId) query = query.where("id", "=", input.entryId);
    if (input.personId) query = query.where("person_id", "=", input.personId);
    if (input.journeyId) query = query.where("journey_id", "=", input.journeyId);
    const ids = (await query.limit(200).execute()).map((r) => r.id);
    if (input.entryId && !ids.length) throw new NotFoundError("live journey entry", input.entryId);
    if (ids.length) {
      ctx.write(
        ctx.db
          .updateTable("core_journey_entry")
          .set({
            state: "stopped",
            next_at: null,
            ended_at: ctx.now,
            stopped_by: ctx.user.id,
            stop_reason: input.reason ?? "staff",
          })
          .where("id", "in", ids)
          .where("state", "in", LIVE_ENTRY_STATES),
      );
    }
    return { stopped: ids };
  },
});

export const journeyEntries = defineOperation({
  name: "journey.entries",
  description:
    "The entries of a journey (journeyId) or of a Person (personId): who is on it, at which step, " +
    "when they are next looked at, how they entered and whether they finished or were stopped. " +
    "A Person's entries for anyone who reads the Person; a journey's for journeys:read. Newest " +
    "first, at most 100. Read-only.",
  input: z
    .object({
      journeyId: journeyId.optional(),
      personId: z.string().min(1).max(64).optional(),
      state: z.enum(ENTRY_STATES).optional(),
      limit: z.number().int().min(1).max(100).default(50),
    })
    .refine((v) => v.journeyId || v.personId, "Give journeyId or personId"),
  output: z.object({ items: z.array(entrySchema) }),
  permission: "records:read",
  risk: "read",
  mcp: { idempotent: true },
  async handler(input, ctx) {
    if (!input.personId && !readsJourneys(ctx)) {
      throw new ForbiddenError("Reading a journey's entries needs journeys:read", {
        permission: "journeys:read",
      });
    }
    let query = ctx.db
      .selectFrom("core_journey_entry as e")
      .innerJoin("core_journey as j", "j.id", "e.journey_id")
      .innerJoin("core_journey_version as v", "v.id", "e.version_id")
      .selectAll("e")
      .select(["j.name as journey_name", "v.number as version_number"]);
    if (input.journeyId) query = query.where("e.journey_id", "=", input.journeyId);
    if (input.personId) query = query.where("e.person_id", "=", input.personId);
    if (input.state) query = query.where("e.state", "=", input.state);
    const rows = await query
      .orderBy("e.entered_at", "desc")
      .orderBy("e.id", "desc")
      .limit(input.limit)
      .execute();
    return {
      items: rows.map((r) => ({
        id: r.id,
        journeyId: r.journey_id,
        journeyName: r.journey_name,
        versionNumber: r.version_number,
        personId: r.person_id,
        state: r.state,
        step: r.step,
        nextAt: r.next_at,
        enteredAt: r.entered_at,
        enteredBy: r.entered_by,
        causeStanding: r.cause_standing,
        endedAt: r.ended_at,
        stoppedBy: r.stopped_by,
        stopReason: r.stop_reason,
      })),
    };
  },
});

export const journeyLog = defineOperation({
  name: "journey.log",
  description:
    "What happened at each step of one journey entry, in order: entered, sent (with the message " +
    "row), held, skipped and why, waited until, the branch taken, the task made. Never the words: " +
    "the message log keeps what it keeps. For journeys:read, or anyone who reads the Person " +
    "when they name them. Read-only.",
  input: z.object({
    entryId: z.string().min(1).max(64),
    personId: z.string().min(1).max(64).optional(),
  }),
  output: z.object({
    items: z.array(
      z.object({ step: z.string(), at: z.string(), what: z.string(), detail: z.unknown() }),
    ),
  }),
  permission: "records:read",
  risk: "read",
  mcp: { idempotent: true },
  async handler(input, ctx) {
    const entry = await ctx.db
      .selectFrom("core_journey_entry")
      .select(["id", "person_id"])
      .where("id", "=", input.entryId)
      .executeTakeFirst();
    if (!entry) throw new NotFoundError("journey entry", input.entryId);
    if (!readsJourneys(ctx) && input.personId !== entry.person_id) {
      throw new ForbiddenError("Reading a journey's log needs journeys:read", {
        permission: "journeys:read",
      });
    }
    const rows = await ctx.db
      .selectFrom("core_journey_step_log")
      .selectAll()
      .where("entry_id", "=", entry.id)
      .orderBy("at")
      .orderBy("id")
      .limit(500)
      .execute();
    return {
      items: rows.map((r) => {
        let detail: unknown = null;
        try {
          detail = r.detail === null ? null : JSON.parse(r.detail);
        } catch {
          detail = null;
        }
        return { step: r.step, at: r.at, what: r.what, detail };
      }),
    };
  },
});

const settingsOutput = z.object({
  sendOnOwn: z
    .boolean()
    .describe("Journeys send on their own (off on deploy until a human admin turns it on)"),
  weekCap: z.number().describe("Journey messages a Person gets in 7 days, across journeys"),
  dayCap: z.number().describe("Journey messages a Person gets in a day (fixed at 1)"),
  replyTo: z.array(
    z.object({
      address: z.string(),
      userId: z.string(),
      current: z.boolean().describe("The account still has this address and is active"),
    }),
  ),
});

async function settingsView(ctx: HandlerContext): Promise<z.infer<typeof settingsOutput>> {
  const settings = await loadJourneySettings(ctx.db);
  const allowed = await allowedReplyTo(ctx.db, settings);
  return {
    sendOnOwn: settings.sendOnOwn,
    weekCap: settings.weekCap,
    dayCap: 1,
    replyTo: settings.replyTo.map((r) => ({
      ...r,
      current: allowed.includes(r.address.trim().toLowerCase()),
    })),
  };
}

export const journeySettings = defineOperation({
  name: "journey.settings",
  description:
    "Journeys' settings: whether journeys send on their own (off until a human admin turns it " +
    "on), the cap per Person (at most 3 a week and 1 a day), and the addresses a journey's " +
    "replies may go to (staff accounts' addresses: for those who write journeys). Read-only.",
  input: z.object({}),
  output: settingsOutput,
  permission: "journeys:manage",
  risk: "read",
  mcp: { idempotent: true },
  async handler(_input, ctx) {
    return settingsView(ctx);
  },
});

export const journeySettingsUpdate = defineOperation({
  name: "journey.settings.update",
  description:
    "Change journeys' settings: whether they send on their own, the weekly cap (1 to 3), and " +
    "which staff accounts' addresses a journey's replies may go to (replyToUserIds, given whole). " +
    "A human admin only, never an AI, not on MCP. Audited.",
  input: z.object({
    sendOnOwn: z.boolean().optional(),
    weekCap: z.number().int().min(1).max(JOURNEY_WEEK_CAP).optional(),
    replyToUserIds: z.array(z.string().min(1).max(64)).max(50).optional(),
  }),
  output: settingsOutput,
  permission: "settings:manage",
  risk: "write",
  actors: ["human"],
  mcp: { expose: false },
  async handler(input, ctx) {
    if (ctx.actor !== "human") throw new ForbiddenError("Only a person changes journeys' settings");
    const settings = await loadJourneySettings(ctx.db);
    let replyTo = settings.replyTo;
    if (input.replyToUserIds) {
      const ids = [...new Set(input.replyToUserIds)];
      const users = ids.length
        ? await ctx.db
            .selectFrom("core_user")
            .select(["id", "email"])
            .where("id", "in", ids)
            .where("kind", "=", "human")
            .where("deactivated_at", "is", null)
            .where("support_grant_id", "is", null)
            .execute()
        : [];
      if (users.length !== ids.length) {
        throw new ValidationError("Each reply-to is an active staff account's own address", {
          rule: "journey_reply_to",
        });
      }
      replyTo = users.map((u) => ({ address: u.email.trim().toLowerCase(), userId: u.id }));
    }
    const next = {
      sendOnOwn: input.sendOnOwn ?? settings.sendOnOwn,
      weekCap: input.weekCap ?? settings.weekCap,
      replyTo,
    };
    // Only the keys given change, in one statement over the stored value: two admins' saves never
    // put back what the other changed (a stale read of "send on their own" included).
    const changes: [string, unknown][] = [
      ...(input.sendOnOwn !== undefined
        ? [["$.sendOnOwn", input.sendOnOwn] as [string, unknown]]
        : []),
      ...(input.weekCap !== undefined ? [["$.weekCap", input.weekCap] as [string, unknown]] : []),
      ...(input.replyToUserIds !== undefined ? [["$.replyTo", replyTo] as [string, unknown]] : []),
      ["$.updatedAt", ctx.now],
      ["$.updatedBy", ctx.user.id],
    ];
    const args = sql.join(
      changes.map(([path, value]) => sql`${path}, json(${JSON.stringify(value)})`),
    );
    ctx.write(
      ctx.db
        .insertInto("core_settings")
        .values({ key: JOURNEY_SETTING, value: "{}", updated_at: ctx.now, updated_by: ctx.user.id })
        .onConflict((oc) => oc.column("key").doNothing()),
      ctx.db
        .updateTable("core_settings")
        .set({
          value: sql<string>`json_set(CASE WHEN json_valid(value) THEN value ELSE '{}' END, ${args})`,
          updated_at: ctx.now,
          updated_by: ctx.user.id,
        })
        .where("key", "=", JOURNEY_SETTING),
    );
    ctx.recordChange({
      object: "settings",
      id: JOURNEY_SETTING,
      action: "update",
      diff: Object.fromEntries(
        (["sendOnOwn", "weekCap", "replyTo"] as const)
          .filter((key) => JSON.stringify(settings[key]) !== JSON.stringify(next[key]))
          .map((key) => [key, { before: settings[key], after: next[key] }]),
      ),
    });
    const allowed = new Set(replyTo.map((r) => r.address));
    return {
      sendOnOwn: next.sendOnOwn,
      weekCap: next.weekCap,
      dayCap: 1,
      replyTo: replyTo.map((r) => ({ ...r, current: allowed.has(r.address) })),
    };
  },
});

export const journeyOperations = [
  journeyList,
  journeyGet,
  journeyVersionGet,
  journeyCreate,
  journeyUpdate,
  journeyArchive,
  journeyPreview,
  journeyPublish,
  journeyGoLive,
  journeyPause,
  journeyResume,
  journeyEnter,
  journeyStop,
  journeyEntries,
  journeyLog,
  journeySettings,
  journeySettingsUpdate,
] as const;
