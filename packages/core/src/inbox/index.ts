// The shared inbox (stage 36, ADR 0740): conversations and their messages.
//
// A conversation (core_conversation) is one exchange with one person on one channel. Its messages
// are `email` and `chat` activities on the person's timeline, and its staff notes `note`
// activities on the conversation only; each carries `conversation_id`. The host writes messages
// (`messageStatements`): the inbound gatekeeper's hook and the customer's chat operations in later
// steps, the reply operations of staff. Nothing else writes them: `activity.update` refuses them.
//
// Who reads (decision 4): every staff account holding `inbox:read` (admins, members, viewers);
// a private conversation, with its messages and notes, only admins and whoever has it. The rule is
// here once, as SQL over a conversation (`conversationReadable`) and over an activity
// (`activityConversationReadable`), and every read path takes it: the inbox's operations, the
// timelines and activity reads (operations/activity.ts), summaries and embeddings (which read as
// nobody and so leave a private conversation out), and the rec_* views and search, which leave
// private conversations' messages out for everyone (migration 1050), as for a private activity.
import type { CoreDatabase } from "@composable-os/db";
import { type Compilable, type Kysely, type RawBuilder, type Selectable, sql } from "kysely";
import { z } from "zod";
import { newId } from "../ids.ts";
import { notifyStatements } from "../notifications/send.ts";
import type { Role } from "../principals.ts";
import { chunk, jsonList } from "../records/common.ts";

export const CONVERSATION_CHANNELS = ["email", "chat"] as const;
export type ConversationChannel = (typeof CONVERSATION_CHANNELS)[number];
export const CONVERSATION_STATUSES = ["open", "waiting", "closed"] as const;
export type ConversationStatus = (typeof CONVERSATION_STATUSES)[number];
/** The activity types a conversation holds: its messages, and staff notes. */
export const MESSAGE_TYPES = ["email", "chat"] as const;
export type MessageType = (typeof MESSAGE_TYPES)[number];

/** A snippet of a message kept in D1 (the full body of an email lives in R2, as synced mail). */
export const MESSAGE_SNIPPET_CHARS = 10_000;

export type ConversationRow = Selectable<CoreDatabase["core_conversation"]>;

/** Who is reading: the staff account's id and role. */
export interface InboxViewer {
  readonly id: string;
  readonly role: Role;
}

/** Admins read every conversation, private ones included. */
export function readsEveryConversation(viewer: InboxViewer): boolean {
  return viewer.role === "admin";
}

/** The viewer may read this conversation: it is not private, or they are an admin or have it. */
export function mayRead(
  viewer: InboxViewer,
  row: Pick<ConversationRow, "private_at" | "assignee_id">,
): boolean {
  return row.private_at === null || readsEveryConversation(viewer) || row.assignee_id === viewer.id;
}

/** SQL over a conversation aliased `alias`: one the viewer may read. */
export function conversationReadable(viewer: InboxViewer, alias = "c"): RawBuilder<boolean> {
  if (readsEveryConversation(viewer)) return sql<boolean>`1 = 1`;
  return sql<boolean>`(${sql.ref(`${alias}.private_at`)} IS NULL OR ${sql.ref(`${alias}.assignee_id`)} = ${viewer.id})`;
}

/**
 * SQL over an activity aliased `alias`: it is not a message or note of a private conversation the
 * viewer may not read. One primary-key lookup per conversation activity.
 */
export function activityConversationReadable(
  viewer: InboxViewer,
  alias = "a",
): RawBuilder<boolean> {
  if (readsEveryConversation(viewer)) return sql<boolean>`1 = 1`;
  return sql<boolean>`(${sql.ref(`${alias}.conversation_id`)} IS NULL OR NOT EXISTS (SELECT 1 FROM core_conversation pc WHERE pc.id = ${sql.ref(`${alias}.conversation_id`)} AND pc.private_at IS NOT NULL AND (pc.assignee_id IS NULL OR pc.assignee_id <> ${viewer.id})))`;
}

/** SQL over an activity aliased `alias`: not in any private conversation (for reads as nobody). */
export function notInPrivateConversation(alias = "a"): RawBuilder<boolean> {
  return sql<boolean>`(${sql.ref(`${alias}.conversation_id`)} IS NULL OR NOT EXISTS (SELECT 1 FROM core_conversation pc WHERE pc.id = ${sql.ref(`${alias}.conversation_id`)} AND pc.private_at IS NOT NULL))`;
}

/** The SHA-256 of an address, lower-cased: how an unknown sender's conversation is found again. */
export async function senderHash(address: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(address.trim().toLowerCase()),
  );
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// --- Writing ----------------------------------------------------------------------------------

export interface NewConversation {
  channel: ConversationChannel;
  /** The Person, or null for an unknown sender (email only). */
  personId: string | null;
  /** An unknown sender's address (required when personId is null). */
  senderAddress?: string | null;
  inboxAddress?: string | null;
  subject?: string | null;
  senderUnverified?: boolean;
  about?: { object: string; id: string } | null;
  now: string;
}

/** The insert of a new open conversation, and its id. The caller commits it in its batch. */
export async function newConversationStatement(
  db: Kysely<CoreDatabase>,
  input: NewConversation,
): Promise<{ id: string; statement: Compilable }> {
  const id = newId("conversation");
  const address = input.personId ? null : (input.senderAddress?.trim() ?? null);
  if (!input.personId && (!address || input.channel !== "email")) {
    throw new Error("A conversation without a Person is an email from an unknown address");
  }
  return {
    id,
    statement: db.insertInto("core_conversation").values({
      id,
      person_id: input.personId,
      sender_address: address,
      sender_hash: address ? await senderHash(address) : null,
      channel: input.channel,
      inbox_address: input.inboxAddress ?? null,
      subject: input.subject?.trim().slice(0, 500) || null,
      status: "open",
      sender_unverified: input.senderUnverified ? 1 : 0,
      about_object: input.about?.object ?? null,
      about_id: input.about?.id ?? null,
      opened_at: input.now,
      created_at: input.now,
      updated_at: input.now,
      version: 0,
    }),
  };
}

export interface NewMessage {
  /** The conversation as read; its version guards the update (a write from an older read fails). */
  conversation: Pick<ConversationRow, "id" | "version" | "person_id" | "assignee_id" | "status">;
  type: MessageType;
  direction: "inbound" | "outbound";
  subject?: string | null;
  /** The message's text (the snippet when the full body is in R2). */
  body: string | null;
  /** Typed per type: an email's headers; a chat message's nothing more. */
  payload?: Record<string, unknown>;
  /** `email:<Message-ID>` or `chat:<id>`: dedupe across deliveries. */
  externalKey?: string | null;
  /** The R2 key of an email's full body. */
  bodyRef?: string | null;
  /** The staff account that wrote an outbound message. Null for an inbound one. */
  authorUserId?: string | null;
  authorActor?: "human" | "system";
  /**
   * The Person's name, for the assignee's notice of an inbound message. Never an address or the
   * message's words: a notice may go out by email or Slack (ADR 0740).
   */
  senderName?: string | null;
  now: string;
}

/**
 * Writes one message into a conversation: the activity (on the Person's timeline when there is
 * one), and the conversation's times and status. An inbound message reopens a waiting or closed
 * conversation and tells whoever has it (`inbox.reply`); an outbound one records the reply.
 * Returns the statements for the caller's batch, the activity's id and the conversation's new
 * version.
 */
export async function messageStatements(
  db: Kysely<CoreDatabase>,
  input: NewMessage,
): Promise<{ activityId: string; statements: Compilable[]; version: number }> {
  const { conversation, now } = input;
  const activityId = newId("activity");
  const body = input.body === null ? null : input.body.slice(0, MESSAGE_SNIPPET_CHARS);
  const statements: Compilable[] = [
    db.insertInto("core_activity").values({
      id: activityId,
      type: input.type,
      subject: input.subject?.trim().slice(0, 500) || null,
      body,
      payload: JSON.stringify({ ...input.payload, direction: input.direction }),
      occurred_at: now,
      author_user_id: input.authorUserId ?? null,
      author_actor: input.authorActor ?? (input.direction === "inbound" ? "system" : "human"),
      created_at: now,
      updated_at: now,
      external_key: input.externalKey ?? null,
      body_ref: input.bodyRef ?? null,
      disclosure: input.bodyRef ? "full" : null,
      conversation_id: conversation.id,
    }),
  ];
  if (conversation.person_id) {
    statements.push(
      db.insertInto("core_activity_links").values({
        activity_id: activityId,
        object_type: "person",
        record_id: conversation.person_id,
      }),
    );
  }
  const version = conversation.version + 1;
  if (input.direction === "inbound") {
    statements.push(
      db
        .updateTable("core_conversation")
        .set({
          last_inbound_at: now,
          status: "open",
          closed_at: null,
          closed_by: null,
          updated_at: now,
          version,
        })
        .where("id", "=", conversation.id),
    );
    if (conversation.assignee_id) {
      const notice = await notifyStatements(
        db,
        {
          to: [{ userId: conversation.assignee_id }],
          type: "inbox.reply",
          title: input.senderName ? `${input.senderName} replied` : "A new reply",
          link: { kind: "record", object: "conversation", id: conversation.id },
          dedupeKey: `inbox.reply:${activityId}`,
          source: { actor: "system" },
        },
        now,
      );
      statements.push(...notice.statements);
    }
  } else {
    statements.push(
      db
        .updateTable("core_conversation")
        .set({
          last_reply_at: now,
          first_reply_at: sql<string>`coalesce(first_reply_at, ${now})`,
          updated_at: now,
          version,
        })
        .where("id", "=", conversation.id),
    );
  }
  return { activityId, statements, version };
}

// --- Erase ------------------------------------------------------------------------------------

/**
 * A Person's conversations and every activity in them (messages and notes, whatever else they
 * are linked to): what an erase or the Trash purge deletes with the Person. With `addresses`
 * (an erase), also the unknown-sender conversations from one of their addresses, which staff never
 * linked to them: those are theirs too.
 */
export async function conversationsOf(
  db: Kysely<CoreDatabase>,
  personIds: readonly string[],
  addresses: readonly string[] = [],
): Promise<{ conversationIds: string[]; activityIds: string[] }> {
  const hashes = await Promise.all([...new Set(addresses)].map(senderHash));
  if (!personIds.length && !hashes.length) return { conversationIds: [], activityIds: [] };
  const conversations = await db
    .selectFrom("core_conversation")
    .select("id")
    .where((eb) =>
      eb.or([
        eb("person_id", "in", jsonList(personIds)),
        eb("sender_hash", "in", jsonList(hashes)),
      ]),
    )
    .execute();
  const conversationIds = conversations.map((c) => c.id);
  if (!conversationIds.length) return { conversationIds, activityIds: [] };
  const activities = await db
    .selectFrom("core_activity")
    .select("id")
    .where("conversation_id", "in", jsonList(conversationIds))
    .execute();
  return { conversationIds, activityIds: activities.map((a) => a.id) };
}

/**
 * The deletes of those conversations and their activities. Each statement binds one JSON list,
 * so a Person with any number of conversations costs a few statements per chunk. A message's body
 * in R2 is queued for deletion by trigger (migration 0330); links and search rows go with it.
 */
export function eraseConversationStatements(
  db: Kysely<CoreDatabase>,
  found: { conversationIds: readonly string[]; activityIds: readonly string[] },
): Compilable[] {
  const statements: Compilable[] = [];
  for (const ids of chunk(found.activityIds, 500)) {
    statements.push(db.deleteFrom("core_activity").where("id", "in", jsonList(ids)));
  }
  for (const ids of chunk(found.conversationIds, 500)) {
    statements.push(db.deleteFrom("core_conversation").where("id", "in", jsonList(ids)));
  }
  return statements;
}

// --- Shapes -----------------------------------------------------------------------------------

const userRef = z.object({ id: z.string(), name: z.string().nullable() });

export const conversationSchema = z.object({
  id: z.string(),
  channel: z.enum(CONVERSATION_CHANNELS),
  subject: z.string().nullable(),
  status: z.enum(CONVERSATION_STATUSES),
  person: z
    .object({ id: z.string(), name: z.string().nullable() })
    .nullable()
    .describe("The Person it is with; null while the sender is unknown"),
  unknownSender: z
    .string()
    .nullable()
    .describe("An unknown sender's address (null once linked to a Person)"),
  senderUnverified: z.boolean().describe("The sender check failed on a message"),
  assignee: userRef.nullable().describe("Who has it; null: unassigned"),
  category: z.string().nullable(),
  about: z
    .object({ object: z.string(), id: z.string(), title: z.string().nullable().optional() })
    .nullable()
    .describe("The record it is about"),
  private: z.boolean().describe("Only admins and whoever has it see it"),
  privateAt: z.string().nullable(),
  privateBy: z.string().nullable(),
  openedAt: z.string(),
  lastInboundAt: z.string().nullable(),
  lastReplyAt: z.string().nullable(),
  firstReplyAt: z.string().nullable(),
  replyDueAt: z.string().nullable(),
  snoozedUntil: z.string().nullable(),
  closedAt: z.string().nullable(),
  closedBy: z.string().nullable(),
  updatedAt: z.string(),
  version: z.number().int().describe("Pass back to a write to refuse it if this changed since"),
});
export type Conversation = z.infer<typeof conversationSchema>;

/** A conversation row with the Person's and the assignee's names joined. */
export type ConversationListRow = ConversationRow & {
  person_name: string | null;
  assignee_name: string | null;
};

/** The conversation with the names a list shows: one statement, joined. */
export function conversationQuery(db: Kysely<CoreDatabase>) {
  return db
    .selectFrom("core_conversation as c")
    .leftJoin("core_person as p", "p.id", "c.person_id")
    .leftJoin("core_user as u", "u.id", "c.assignee_id")
    .selectAll("c")
    .select(["p.display_name as person_name", "u.name as assignee_name"]);
}

export function toConversation(row: ConversationListRow, aboutTitle?: string | null): Conversation {
  return {
    id: row.id,
    channel: row.channel,
    subject: row.subject,
    status: row.status,
    person: row.person_id ? { id: row.person_id, name: row.person_name } : null,
    unknownSender: row.person_id ? null : row.sender_address,
    senderUnverified: row.sender_unverified === 1,
    assignee: row.assignee_id ? { id: row.assignee_id, name: row.assignee_name } : null,
    category: row.category,
    about:
      row.about_object && row.about_id
        ? {
            object: row.about_object,
            id: row.about_id,
            ...(aboutTitle !== undefined ? { title: aboutTitle } : {}),
          }
        : null,
    private: row.private_at !== null,
    privateAt: row.private_at,
    privateBy: row.private_by,
    openedAt: row.opened_at,
    lastInboundAt: row.last_inbound_at,
    lastReplyAt: row.last_reply_at,
    firstReplyAt: row.first_reply_at,
    replyDueAt: row.reply_due_at,
    snoozedUntil: row.snoozed_until,
    closedAt: row.closed_at,
    closedBy: row.closed_by,
    updatedAt: row.updated_at,
    version: row.version,
  };
}

/** What the audit log records of a conversation: never a message's words or an address. */
export function conversationSnapshot(row: ConversationRow): Record<string, unknown> {
  return {
    status: row.status,
    assigneeId: row.assignee_id,
    category: row.category,
    about: row.about_object ? `${row.about_object}:${row.about_id}` : null,
    private: row.private_at !== null,
    personId: row.person_id,
  };
}
