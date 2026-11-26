// Saved replies (stage 36 step 3, ADR 0749): ready text for a reply, a staff member's own or
// shared by the whole inbox. Staff only (none is open to customers or the public, ADR 0402):
//
//   savedReply.list     staff (inbox:work)                      the shared ones and the caller's own
//   savedReply.create   staff (inbox:work, a person; shared: inbox:manage)
//   savedReply.update   staff (inbox:work, a person; shared: inbox:manage; own: its owner)
//   savedReply.archive  staff (inbox:work, a person; as update): no longer offered, or offered again
//   savedReply.fill     staff (inbox:work)                      its words for one conversation
//
// Who: everyone who works the inbox (admins and members) uses the shared ones and keeps their own;
// only those holding inbox:manage (admins) write the shared ones, which every reply may carry. A
// staff member's own are theirs alone: nobody else lists, reads or changes them, an admin
// included. Writing one is a person's (`actors: ["human"]`, off MCP): a saved reply is words the
// business sends in its name, and an AI caller reads inbound messages, which are attacker text.
// An AI caller may list them and fill one (read-only; the drafts of step 6 use them as examples).
import { sql } from "kysely";
import { z } from "zod";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../errors.ts";
import { newId } from "../ids.ts";
import { CONVERSATION_CHANNELS } from "../inbox/index.ts";
import {
  fillSlots,
  firstWord,
  MAX_SAVED_REPLY_BODY,
  MAX_SAVED_REPLY_TITLE,
  type SavedReply,
  type SavedReplySlot,
  savedReplySchema,
  slotsOf,
} from "../inbox/saved-replies.ts";
import { decodeCursor, encodeCursor, pageSchema } from "../list.ts";
import { defineOperation, type HandlerContext } from "../operation.ts";
import { holdsPermission } from "../principals.ts";
import { loadGeneralSettings } from "../settings.ts";
import { requireConversation } from "./inbox.ts";

const savedReplyId = z.string().startsWith("svr_").max(64).describe("Saved reply id (svr_…)");
const title = z.string().trim().min(1).max(MAX_SAVED_REPLY_TITLE);
const body = z
  .string()
  .trim()
  .min(1)
  .max(MAX_SAVED_REPLY_BODY)
  .describe(
    "Its words, plain text. Slots: {{person.firstName}}, {{staff.firstName}}, {{business.name}}",
  );
const channels = z
  .array(z.enum(CONVERSATION_CHANNELS))
  .min(1)
  .max(CONVERSATION_CHANNELS.length)
  .describe("The channels it fits");
const expectedVersion = z
  .number()
  .int()
  .min(0)
  .optional()
  .describe("The version you read: the write is refused if the saved reply changed since");

type Row = {
  id: string;
  title: string;
  body: string;
  channels: string;
  owner_id: string | null;
  owner_name: string | null;
  slots: string;
  archived_at: string | null;
  updated_at: string;
  version: number;
};

function managesShared(ctx: HandlerContext): boolean {
  return holdsPermission(ctx.user, ctx.permissionGrants, "inbox:manage");
}

/** The saved replies the caller may read: the shared ones and their own. */
function readable(ctx: HandlerContext) {
  return ctx.db
    .selectFrom("core_saved_reply as r")
    .leftJoin("core_user as u", "u.id", "r.owner_id")
    .select([
      "r.id",
      "r.title",
      "r.body",
      "r.channels",
      "r.owner_id",
      "u.name as owner_name",
      "r.slots",
      "r.archived_at",
      "r.updated_at",
      "r.version",
    ])
    .where(sql<boolean>`(+r.owner_id IS NULL OR +r.owner_id = ${ctx.user.id})`);
}

function toSavedReply(ctx: HandlerContext, row: Row): SavedReply {
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    channels: JSON.parse(row.channels) as SavedReply["channels"],
    shared: row.owner_id === null,
    owner: row.owner_id ? { id: row.owner_id, name: row.owner_name } : null,
    slots: JSON.parse(row.slots) as SavedReplySlot[],
    archived: row.archived_at !== null,
    archivedAt: row.archived_at,
    canEdit: row.owner_id === null ? managesShared(ctx) : row.owner_id === ctx.user.id,
    updatedAt: row.updated_at,
    version: row.version,
  };
}

/** The saved reply as the caller may read it, or not found (another's own). */
async function requireSavedReply(ctx: HandlerContext, id: string): Promise<Row> {
  const row = await readable(ctx).where("r.id", "=", id).executeTakeFirst();
  if (!row) throw new NotFoundError("savedReply", id);
  return row;
}

/** A shared one is changed only by those who hold inbox:manage; one's own only by its owner. */
function assertMayChange(ctx: HandlerContext, row: Row) {
  if (row.owner_id === null && !managesShared(ctx)) {
    throw new ForbiddenError("Only admins change the inbox's shared saved replies", {
      permission: "inbox:manage",
    });
  }
}

function checkVersion(row: Row, expected: number | undefined) {
  if (expected !== undefined && expected !== row.version) {
    throw new ConflictError("The saved reply changed since you read it. Read it again.", {
      reason: "saved_reply_changed",
      version: row.version,
    });
  }
}

async function readBack(ctx: HandlerContext, id: string): Promise<SavedReply> {
  return toSavedReply(ctx, await requireSavedReply(ctx, id));
}

/** What the audit log records of a saved reply: never its words. */
function snapshot(reply: {
  title: string;
  channels: readonly string[];
  shared: boolean;
  archived: boolean;
}) {
  return {
    title: reply.title,
    channels: reply.channels,
    shared: reply.shared,
    archived: reply.archived,
  };
}

const LIST_SORT = { field: "title", direction: "asc" } as const;

export const savedReplyList = defineOperation({
  name: "savedReply.list",
  description:
    "The inbox's saved replies the caller may use: the shared ones and their own (never " +
    "another staff member's own), by title, one page at a time. scope: 'all' (default), " +
    "'shared' or 'mine'. channel: only those that fit it. archived: true lists the archived " +
    "ones instead. Each says its slots and whether the caller may change it. Pass nextCursor " +
    "back as cursor for the next page. Read-only.",
  input: z.object({
    scope: z.enum(["all", "shared", "mine"]).default("all"),
    channel: z.enum(CONVERSATION_CHANNELS).optional(),
    archived: z.boolean().default(false),
    cursor: z.string().max(1000).optional(),
    limit: z.number().int().min(1).max(100).default(50),
  }),
  output: pageSchema(savedReplySchema),
  permission: "inbox:work",
  risk: "read",
  mcp: { idempotent: true },
  async handler(input, ctx) {
    // The filters are tested row by row (the unary +), so a page walks the title index
    // (core_saved_reply_title_idx) and stops at its limit.
    let query = readable(ctx).where(
      input.archived
        ? sql<boolean>`+r.archived_at IS NOT NULL`
        : sql<boolean>`+r.archived_at IS NULL`,
    );
    if (input.scope === "shared") query = query.where(sql<boolean>`+r.owner_id IS NULL`);
    if (input.scope === "mine") query = query.where(sql<boolean>`+r.owner_id = ${ctx.user.id}`);
    if (input.channel) {
      query = query.where(
        sql<boolean>`EXISTS (SELECT 1 FROM json_each(r.channels) ch WHERE ch.value = ${input.channel})`,
      );
    }
    if (input.cursor) {
      const cursor = decodeCursor(input.cursor, LIST_SORT);
      query = query.where(
        sql<boolean>`(r.title COLLATE NOCASE, r.id) > (${cursor.v} COLLATE NOCASE, ${cursor.id})`,
      );
    }
    const rows = await query
      .orderBy(sql`r.title COLLATE NOCASE`)
      .orderBy("r.id")
      .limit(input.limit + 1)
      .execute();
    const page = rows.slice(0, input.limit);
    const last = page.at(-1);
    return {
      items: page.map((row) => toSavedReply(ctx, row)),
      nextCursor:
        rows.length > input.limit && last
          ? encodeCursor({ f: LIST_SORT.field, d: "asc", v: last.title, id: last.id })
          : null,
    };
  },
});

export const savedReplyCreate = defineOperation({
  name: "savedReply.create",
  description:
    "Save a reply: a title, its words (plain text, with only the fixed slots " +
    "{{person.firstName}}, {{staff.firstName}} and {{business.name}}) and the channels it " +
    "fits. shared: true makes it the whole inbox's (admins only); otherwise it is the caller's " +
    "own. People only. Returns the saved reply.",
  input: z.object({
    title,
    body,
    channels: channels.default([...CONVERSATION_CHANNELS]),
    shared: z.boolean().default(false),
  }),
  output: savedReplySchema,
  permission: "inbox:work",
  risk: "write",
  actors: ["human"],
  mcp: { expose: false },
  redact: ["body"],
  async handler(input, ctx) {
    if (input.shared && !managesShared(ctx)) {
      throw new ForbiddenError("Only admins add the inbox's shared saved replies", {
        permission: "inbox:manage",
      });
    }
    const slots = slotsOf(input.body);
    const id = newId("savedReply");
    const used = [...new Set(input.channels)];
    ctx.write(
      ctx.db.insertInto("core_saved_reply").values({
        id,
        title: input.title,
        body: input.body,
        channels: JSON.stringify(used),
        owner_id: input.shared ? null : ctx.user.id,
        slots: JSON.stringify(slots),
        created_by: ctx.user.id,
        updated_by: ctx.user.id,
        created_at: ctx.now,
        updated_at: ctx.now,
        version: 0,
      }),
    );
    ctx.recordChange({
      object: "savedReply",
      id,
      action: "create",
      after: snapshot({
        title: input.title,
        channels: used,
        shared: input.shared,
        archived: false,
      }),
    });
    return ctx.afterCommit(() => readBack(ctx, id));
  },
});

export const savedReplyUpdate = defineOperation({
  name: "savedReply.update",
  description:
    "Change a saved reply's title, words or channels. One's own may be changed by its owner; " +
    "a shared one by an admin. Only what you pass changes. People only. Returns the saved reply.",
  input: z.object({
    id: savedReplyId,
    title: title.optional(),
    body: body.optional(),
    channels: channels.optional(),
    version: expectedVersion,
  }),
  output: savedReplySchema,
  permission: "inbox:work",
  risk: "write",
  actors: ["human"],
  mcp: { expose: false },
  redact: ["body"],
  async handler(input, ctx) {
    if (input.title === undefined && input.body === undefined && input.channels === undefined) {
      throw new ValidationError("Pass what to change: title, body or channels");
    }
    const row = await requireSavedReply(ctx, input.id);
    assertMayChange(ctx, row);
    checkVersion(row, input.version);
    const before = toSavedReply(ctx, row);
    const next = {
      title: input.title ?? row.title,
      body: input.body ?? row.body,
      channels: input.channels ? [...new Set(input.channels)] : before.channels,
    };
    ctx.write(
      ctx.db
        .updateTable("core_saved_reply")
        .set({
          title: next.title,
          body: next.body,
          channels: JSON.stringify(next.channels),
          slots: JSON.stringify(slotsOf(next.body)),
          updated_by: ctx.user.id,
          updated_at: ctx.now,
          version: row.version + 1,
        })
        .where("id", "=", row.id),
    );
    ctx.recordChange({
      object: "savedReply",
      id: row.id,
      action: "update",
      before: snapshot(before),
      after: {
        ...snapshot({ ...before, ...next }),
        ...(input.body !== undefined ? { bodyChanged: input.body !== row.body } : {}),
      },
    });
    return ctx.afterCommit(() => readBack(ctx, row.id));
  },
});

export const savedReplyArchive = defineOperation({
  name: "savedReply.archive",
  description:
    "Archive a saved reply (archived: true, the default): it is kept, and no longer offered in " +
    "the reply box; or bring an archived one back (archived: false). Who may: as for " +
    "savedReply.update. People only. Returns the saved reply.",
  input: z.object({
    id: savedReplyId,
    archived: z.boolean().default(true),
    version: expectedVersion,
  }),
  output: savedReplySchema,
  permission: "inbox:work",
  risk: "write",
  actors: ["human"],
  mcp: { expose: false },
  async handler(input, ctx) {
    const row = await requireSavedReply(ctx, input.id);
    assertMayChange(ctx, row);
    checkVersion(row, input.version);
    const before = toSavedReply(ctx, row);
    if (before.archived === input.archived) return before;
    ctx.write(
      ctx.db
        .updateTable("core_saved_reply")
        .set({
          archived_at: input.archived ? ctx.now : null,
          updated_by: ctx.user.id,
          updated_at: ctx.now,
          version: row.version + 1,
        })
        .where("id", "=", row.id),
    );
    ctx.recordChange({
      object: "savedReply",
      id: row.id,
      action: "update",
      before: snapshot(before),
      after: snapshot({ ...before, archived: input.archived }),
    });
    return ctx.afterCommit(() => readBack(ctx, row.id));
  },
});

export const savedReplyFill = defineOperation({
  name: "savedReply.fill",
  description:
    "A saved reply's words for one conversation, its slots filled by the host: the person's " +
    "first name, the caller's first name and the business's name. missing lists the slots " +
    "that had no value (left empty, to fix before sending). Refused when it does not fit the " +
    "conversation's channel, or is archived. Read-only: it sends nothing.",
  input: z.object({
    id: savedReplyId,
    conversationId: z.string().startsWith("cnv_").max(64).describe("Conversation id (cnv_…)"),
  }),
  output: z.object({
    title: z.string(),
    body: z.string().describe("Plain text, slots filled"),
    missing: z.array(z.string()).describe("Slots with no value, left empty"),
  }),
  permission: "inbox:work",
  risk: "read",
  mcp: { idempotent: true },
  async handler(input, ctx) {
    const [reply, conversation] = await Promise.all([
      requireSavedReply(ctx, input.id),
      requireConversation(ctx, input.conversationId),
    ]);
    const fits = JSON.parse(reply.channels) as string[];
    if (!fits.includes(conversation.channel)) {
      throw new ValidationError(`This saved reply does not fit ${conversation.channel}`, {
        field: "id",
        channel: conversation.channel,
      });
    }
    if (reply.archived_at !== null) {
      throw new ValidationError("This saved reply is archived", { field: "id" });
    }
    const slots = JSON.parse(reply.slots) as SavedReplySlot[];
    const business = slots.includes("business.name")
      ? (await loadGeneralSettings(ctx.db)).orgName
      : null;
    const filled = fillSlots(reply.body, {
      "person.firstName": conversation.person_id
        ? (conversation.person_given_name ?? firstWord(conversation.person_name))
        : null,
      "staff.firstName": firstWord(ctx.user.name),
      "business.name": business,
    });
    return { title: reply.title, ...filled };
  },
});

export const savedReplyOperations = [
  savedReplyList,
  savedReplyCreate,
  savedReplyUpdate,
  savedReplyArchive,
  savedReplyFill,
] as const;
