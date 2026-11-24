// Stage 36 step 1 (ADR 0740): conversations and their messages, notes, private conversations,
// the inbox's notices and erase, against real D1.
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import {
  type MessageType,
  messageStatements,
  newConversationStatement,
  senderHash,
} from "../src/inbox/index.ts";
import {
  type ActingUser,
  ConflictError,
  ForbiddenError,
  invoke,
  NotFoundError,
  ValidationError,
} from "../src/index.ts";
import { createPerson } from "./fixtures.ts";
import { context, createUser, db, unique } from "./helpers.ts";

let admin: ActingUser;
let member: ActingUser;
let other: ActingUser;
let viewer: ActingUser;

beforeAll(async () => {
  admin = await createUser("admin");
  member = await createUser("member");
  other = await createUser("member");
  viewer = await createUser("viewer");
});

/** A conversation as the host writes one (the inbound hook, chat), with one inbound message. */
async function conversation(
  options: {
    personId?: string | null;
    sender?: string;
    channel?: MessageType;
    subject?: string;
    body?: string;
    bodyRef?: string;
  } = {},
) {
  const now = new Date().toISOString();
  const channel = options.channel ?? "email";
  const personId = options.personId === undefined ? null : options.personId;
  const created = await newConversationStatement(db.query, {
    channel,
    personId,
    senderAddress: personId ? null : (options.sender ?? `${unique("who")}@example.com`),
    subject: options.subject ?? "About my booking",
    now,
  });
  await db.batch([created.statement]);
  const message = await inbound(created.id, options.body ?? "Hello, can I move my class?", {
    bodyRef: options.bodyRef,
    type: channel,
  });
  return { id: created.id, messageId: message };
}

/** One more inbound message on a conversation, as the host writes it. */
async function inbound(
  id: string,
  body: string,
  { bodyRef, type = "email" }: { bodyRef?: string | undefined; type?: MessageType } = {},
) {
  const row = await db.query
    .selectFrom("core_conversation")
    .select(["id", "version", "person_id", "assignee_id", "status"])
    .where("id", "=", id)
    .executeTakeFirstOrThrow();
  const written = await messageStatements(db.query, {
    conversation: row,
    type,
    direction: "inbound",
    subject: "About my booking",
    body,
    bodyRef: bodyRef ?? null,
    externalKey: `${type}:${unique("m")}`,
    senderName: "A member",
    now: new Date().toISOString(),
  });
  await db.batch(written.statements);
  return written.activityId;
}

async function notices(userId: string, type: string) {
  const { results } = await env.DB.prepare(
    "SELECT title, body, link FROM core_notifications WHERE user_id = ? AND type = ? ORDER BY created_at, id",
  )
    .bind(userId, type)
    .all<{ title: string; body: string | null; link: string }>();
  return results;
}

const listIds = async (user: ActingUser, input: Record<string, unknown> = {}) =>
  (await invoke("inbox.list", { view: "all", limit: 100, ...input }, context(user))).items.map(
    (c) => c.id,
  );

describe("conversations and messages", () => {
  it("lists a person's conversation, reads it, and puts its messages on their timeline", async () => {
    const person = await createPerson(member);
    const c = await conversation({ personId: person.id });

    expect(await listIds(viewer)).toContain(c.id);
    const read = await invoke("conversation.get", { id: c.id }, context(viewer));
    expect(read.conversation).toMatchObject({
      channel: "email",
      status: "open",
      person: { id: person.id, name: person.displayName },
      unknownSender: null,
      assignee: null,
      private: false,
    });
    expect(read.messages).toEqual([
      expect.objectContaining({
        id: c.messageId,
        kind: "message",
        type: "email",
        direction: "inbound",
        body: "Hello, can I move my class?",
      }),
    ]);

    const timeline = await invoke(
      "activity.listForRecord",
      { object: "person", recordId: person.id },
      context(viewer),
    );
    expect(timeline.items.map((a) => [a.id, a.type, a.conversationId])).toContainEqual([
      c.messageId,
      "email",
      c.id,
    ]);
  });

  it("takes a chat message as an activity of type chat", async () => {
    const person = await createPerson(member);
    const c = await conversation({ personId: person.id, channel: "chat", body: "Hi from the app" });
    const activity = await invoke("activity.get", { id: c.messageId }, context(member));
    expect(activity).toMatchObject({ type: "chat", conversationId: c.id, body: "Hi from the app" });
    await expect(
      invoke("activity.update", { id: c.messageId, body: "changed" }, context(member)),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("filters the inbox by view, status and channel", async () => {
    const person = await createPerson(member);
    const mine = await conversation({ personId: person.id });
    const nobodys = await conversation({ personId: person.id, channel: "chat" });
    await invoke("conversation.take", { id: mine.id }, context(member));

    const ofPerson = { personId: person.id };
    expect(await listIds(member, { ...ofPerson, view: "mine" })).toEqual([mine.id]);
    expect(await listIds(member, { ...ofPerson, view: "unassigned" })).toEqual([nobodys.id]);
    expect(await listIds(member, { ...ofPerson, channel: "chat" })).toEqual([nobodys.id]);
    await invoke("conversation.setStatus", { id: nobodys.id, status: "closed" }, context(member));
    expect(await listIds(member, ofPerson)).toEqual([mine.id]);
    expect(await listIds(member, { ...ofPerson, status: ["closed"] })).toEqual([nobodys.id]);
  });

  it("pages the inbox newest first", async () => {
    const person = await createPerson(member);
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) ids.push((await conversation({ personId: person.id })).id);
    const first = await invoke("inbox.list", { personId: person.id, limit: 2 }, context(member));
    expect(first.items.map((c) => c.id)).toEqual([ids[2], ids[1]]);
    const second = await invoke(
      "inbox.list",
      { personId: person.id, limit: 2, cursor: first.nextCursor ?? undefined },
      context(member),
    );
    expect(second.items.map((c) => c.id)).toEqual([ids[0]]);
    expect(second.nextCursor).toBeNull();
  });

  it("reopens a closed conversation on a new inbound message and tells whoever has it", async () => {
    const person = await createPerson(member);
    const c = await conversation({ personId: person.id });
    await invoke("conversation.assign", { id: c.id, assigneeId: other.id }, context(member));
    await invoke("conversation.setStatus", { id: c.id, status: "closed" }, context(other));
    const closed = await invoke("conversation.get", { id: c.id }, context(other));
    expect(closed.conversation).toMatchObject({ status: "closed", closedBy: other.id });

    await inbound(c.id, "One more thing");
    const after = await invoke("conversation.get", { id: c.id }, context(other));
    expect(after.conversation).toMatchObject({ status: "open", closedAt: null });
    expect(after.messages.map((m) => m.body)).toEqual([
      "Hello, can I move my class?",
      "One more thing",
    ]);
    const replies = (await notices(other.id, "inbox.reply")).filter((n) => n.link.includes(c.id));
    expect(replies).toEqual([
      { title: "A member replied", body: null, link: expect.stringContaining('"conversation"') },
    ]);
  });
});

describe("taking and assigning", () => {
  it("one takes it, the other sees who has it and cannot take it; an assignment notifies", async () => {
    const person = await createPerson(member);
    const c = await conversation({ personId: person.id, subject: "Freeze my membership" });

    // Both open it.
    const seenByMember = await invoke("conversation.get", { id: c.id }, context(member));
    const seenByOther = await invoke("conversation.get", { id: c.id }, context(other));
    expect(seenByOther.conversation.version).toBe(seenByMember.conversation.version);

    const taken = await invoke(
      "conversation.take",
      { id: c.id, version: seenByMember.conversation.version },
      context(member),
    );
    expect(taken.assignee).toEqual({ id: member.id, name: member.name });

    // The other's take, from the read before, is refused and names who has it.
    const refused = invoke(
      "conversation.take",
      { id: c.id, version: seenByOther.conversation.version },
      context(other),
    );
    await expect(refused).rejects.toBeInstanceOf(ConflictError);
    await expect(invoke("conversation.take", { id: c.id }, context(other))).rejects.toThrow(
      `${member.name} has this conversation`,
    );
    expect(
      (await invoke("conversation.get", { id: c.id }, context(other))).conversation,
    ).toMatchObject({ assignee: { id: member.id } });

    // Handing it over tells the new assignee in the app, never with a message's words.
    await invoke("conversation.assign", { id: c.id, assigneeId: other.id }, context(member));
    const given = (await notices(other.id, "inbox.assigned")).filter((n) => n.link.includes(c.id));
    expect(given).toHaveLength(1);
    expect(given[0]?.title).toBe(`${member.name} gave you a conversation`);
    expect(given[0]?.body).not.toContain("Hello");
  });

  it("a write from an older read fails at commit: the stale guard", async () => {
    const person = await createPerson(member);
    const c = await conversation({ personId: person.id });
    const row = await db.query
      .selectFrom("core_conversation")
      .select("version")
      .where("id", "=", c.id)
      .executeTakeFirstOrThrow();
    await invoke("conversation.take", { id: c.id }, context(member));
    await expect(
      db.batch([
        db.query
          .updateTable("core_conversation")
          .set({ assignee_id: other.id, version: row.version + 1 })
          .where("id", "=", c.id),
      ]),
    ).rejects.toThrow(/core_conversation_stale/);
  });

  it("gives conversations only to staff who work the inbox", async () => {
    const person = await createPerson(member);
    const c = await conversation({ personId: person.id });
    await expect(
      invoke("conversation.assign", { id: c.id, assigneeId: viewer.id }, context(member)),
    ).rejects.toBeInstanceOf(ValidationError);
    const coach = await createUser("member");
    await env.DB.prepare("UPDATE core_user SET pack_role = 'bookings.coach' WHERE id = ?")
      .bind(coach.id)
      .run();
    await expect(
      invoke("conversation.assign", { id: c.id, assigneeId: coach.id }, context(member)),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(invoke("conversation.take", { id: c.id }, context(viewer))).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });

  it("only a person closes a conversation", async () => {
    const person = await createPerson(member);
    const c = await conversation({ personId: person.id });
    for (const actor of ["assistant", "mcp", "automation"] as const) {
      await expect(
        invoke(
          "conversation.setStatus",
          { id: c.id, status: "closed" },
          context(member, { actor }),
        ),
      ).rejects.toBeInstanceOf(ForbiddenError);
    }
  });

  it("says what a conversation is about", async () => {
    const person = await createPerson(member);
    const c = await conversation({ personId: person.id });
    const about = await createPerson(member);
    await invoke(
      "conversation.setAbout",
      { id: c.id, about: { object: "person", id: about.id } },
      context(member),
    );
    const read = await invoke("conversation.get", { id: c.id }, context(viewer));
    expect(read.conversation.about).toEqual({
      object: "person",
      id: about.id,
      title: about.displayName,
    });
    await expect(
      invoke(
        "conversation.setAbout",
        { id: c.id, about: { object: "person", id: "per_missing" } },
        context(member),
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});

describe("notes", () => {
  it("a note stays on the conversation, mentions tell staff, and it is never a message", async () => {
    const person = await createPerson(member);
    const c = await conversation({ personId: person.id });
    const note = await invoke(
      "message.note",
      { id: c.id, body: "Their knee is hurt, see last week", mentions: [other.id] },
      context(member),
    );
    const read = await invoke("conversation.get", { id: c.id }, context(viewer));
    expect(read.messages.at(-1)).toMatchObject({
      id: note.id,
      kind: "note",
      type: "note",
      direction: null,
      mentions: [other.id],
      author: { userId: member.id },
    });
    // Not on the Person's timeline (what the person's own reads are built from), not a message.
    const timeline = await invoke(
      "activity.listForRecord",
      { object: "person", recordId: person.id },
      context(member),
    );
    expect(timeline.items.map((a) => a.id)).not.toContain(note.id);
    const row = await env.DB.prepare(
      "SELECT type, external_key, payload FROM core_activity WHERE id = ?",
    )
      .bind(note.id)
      .first<{ type: string; external_key: string | null; payload: string }>();
    expect(row).toMatchObject({ type: "note", external_key: null });
    expect(JSON.parse(row?.payload ?? "{}").direction).toBeUndefined();

    const mention = (await notices(other.id, "inbox.mention")).filter((n) => n.link.includes(c.id));
    expect(mention).toHaveLength(1);
    expect(JSON.stringify(mention)).not.toContain("knee");
    // The audit log records the note, not its words.
    const audit = await env.DB.prepare(
      "SELECT input FROM core_audit WHERE operation = 'message.note' AND user_id = ? ORDER BY at DESC LIMIT 1",
    )
      .bind(member.id)
      .first<{ input: string }>();
    expect(audit?.input).toBeDefined();
    expect(audit?.input).not.toContain("knee");
    const changes = await env.DB.prepare("SELECT diff FROM core_audit_changes WHERE record_id = ?")
      .bind(note.id)
      .all<{ diff: string }>();
    expect(JSON.stringify(changes.results)).not.toContain("knee");
  });

  it("refuses a mention of someone who cannot read the conversation", async () => {
    const person = await createPerson(member);
    const c = await conversation({ personId: person.id });
    await invoke("conversation.take", { id: c.id }, context(member));
    await invoke("conversation.setPrivate", { id: c.id, private: true }, context(member));
    await expect(
      invoke("message.note", { id: c.id, body: "x", mentions: [other.id] }, context(member)),
    ).rejects.toBeInstanceOf(ValidationError);
    await invoke("message.note", { id: c.id, body: "x", mentions: [admin.id] }, context(member));
  });
});

describe("private conversations", () => {
  async function privateOne() {
    const person = await createPerson(member);
    const word = unique("injury");
    const c = await conversation({ personId: person.id, body: `My ${word} is worse` });
    await invoke("conversation.take", { id: c.id }, context(member));
    await invoke("conversation.setPrivate", { id: c.id, private: true }, context(member));
    return { person, word, ...c };
  }

  it("is absent for a member who does not have it in every read path", async () => {
    const { person, word, id, messageId } = await privateOne();
    const reads = async (user: ActingUser, actor: "human" | "assistant" | "mcp" = "human") => {
      const ctx = context(user, { actor });
      const listed = (
        await invoke("inbox.list", { view: "all", personId: person.id }, ctx)
      ).items.map((c) => c.id);
      const got = await invoke("conversation.get", { id }, ctx).then(
        () => true,
        (e) => (e instanceof NotFoundError ? false : Promise.reject(e)),
      );
      const timeline = (
        await invoke("activity.listForRecord", { object: "person", recordId: person.id }, ctx)
      ).items.map((a) => a.id);
      const activity = await invoke("activity.get", { id: messageId }, ctx).then(
        () => true,
        (e) => (e instanceof NotFoundError ? false : Promise.reject(e)),
      );
      const body = await invoke("activity.getBody", { id: messageId }, ctx).then(
        () => true,
        (e) => (e instanceof NotFoundError ? false : Promise.reject(e)),
      );
      return {
        listed: listed.includes(id),
        got,
        timeline: timeline.includes(messageId),
        activity,
        body,
      };
    };
    const none = { listed: false, got: false, timeline: false, activity: false, body: false };
    const all = { listed: true, got: true, timeline: true, activity: true, body: true };
    // A member who does not have it, a viewer, and the same member through MCP or the assistant.
    expect(await reads(other)).toEqual(none);
    expect(await reads(viewer)).toEqual(none);
    expect(await reads(other, "mcp")).toEqual(none);
    expect(await reads(other, "assistant")).toEqual(none);
    // An admin and the assignee.
    expect(await reads(admin)).toEqual(all);
    expect(await reads(member)).toEqual(all);
    expect(await reads(member, "mcp")).toEqual(all);

    // Search and the rec_* views leave it out for everyone, as a private activity.
    for (const user of [other, admin]) {
      const found = await invoke("search.global", { query: word }, context(user));
      expect(JSON.stringify(found)).not.toContain(messageId);
      const sql = await invoke(
        "query.sql",
        {
          sql: `SELECT id FROM rec_activity WHERE id = '${messageId}' UNION ALL SELECT activity_id FROM rec_activity_link WHERE activity_id = '${messageId}'`,
        },
        context(user),
      );
      expect(sql.rows).toEqual([]);
    }
  });

  it("reassigning moves who sees it; unmarking puts it back in search", async () => {
    const { word, id, messageId } = await privateOne();
    await invoke("conversation.assign", { id, assigneeId: other.id }, context(member));
    expect(await listIds(other)).toContain(id);
    expect(await listIds(member)).not.toContain(id);
    await expect(invoke("conversation.get", { id }, context(member))).rejects.toBeInstanceOf(
      NotFoundError,
    );

    await invoke("conversation.setPrivate", { id, private: false }, context(other));
    expect(await listIds(member)).toContain(id);
    const found = await invoke("search.global", { query: word }, context(member));
    expect(JSON.stringify(found)).toContain(messageId);
  });

  it("only a person marks or unmarks it, and every mark is audited", async () => {
    const person = await createPerson(member);
    const c = await conversation({ personId: person.id });
    for (const actor of ["assistant", "mcp", "automation"] as const) {
      await expect(
        invoke("conversation.setPrivate", { id: c.id, private: true }, context(member, { actor })),
      ).rejects.toBeInstanceOf(ForbiddenError);
    }
    await invoke("conversation.setPrivate", { id: c.id, private: true }, context(member));
    await invoke("conversation.setPrivate", { id: c.id, private: false }, context(admin));
    const changes = await env.DB.prepare(
      "SELECT c.diff, a.user_id FROM core_audit_changes c JOIN core_audit a ON a.id = c.audit_id WHERE c.record_id = ? AND a.operation = 'conversation.setPrivate' ORDER BY c.id",
    )
      .bind(c.id)
      .all<{ diff: string; user_id: string }>();
    expect(changes.results.map((r) => [r.user_id, JSON.parse(r.diff).private])).toEqual([
      [member.id, { before: false, after: true }],
      [admin.id, { before: true, after: false }],
    ]);
  });

  it("a pack-role account reads nothing of the inbox", async () => {
    const { id, person, messageId } = await privateOne();
    const open = await conversation({ personId: person.id });
    const coach = await createUser("member");
    await env.DB.prepare("UPDATE core_user SET pack_role = 'bookings.coach' WHERE id = ?")
      .bind(coach.id)
      .run();
    const calls: [string, Record<string, unknown>][] = [
      ["inbox.list", {}],
      ["conversation.get", { id: open.id }],
      ["conversation.get", { id }],
      ["activity.listForRecord", { object: "person", recordId: person.id }],
      ["activity.get", { id: messageId }],
      ["search.global", { query: "booking" }],
      ["conversation.take", { id: open.id }],
      ["message.note", { id: open.id, body: "x" }],
    ];
    for (const [name, input] of calls) {
      await expect(
        invoke(name as "inbox.list", input as never, context(coach)),
      ).rejects.toBeInstanceOf(ForbiddenError);
    }
  });
});

describe("unknown senders", () => {
  it("makes no Person; linking it to one moves its messages onto their timeline", async () => {
    const address = `${unique("stranger")}@example.com`;
    const c = await conversation({ sender: address });
    const note = await invoke("message.note", { id: c.id, body: "Who is this?" }, context(member));
    const read = await invoke("conversation.get", { id: c.id }, context(member));
    expect(read.conversation).toMatchObject({ person: null, unknownSender: address });
    const stored = await db.query
      .selectFrom("core_conversation")
      .select(["sender_hash"])
      .where("id", "=", c.id)
      .executeTakeFirstOrThrow();
    expect(stored.sender_hash).toBe(await senderHash(address.toUpperCase()));

    const person = await createPerson(member);
    for (const actor of ["assistant", "mcp", "automation"] as const) {
      await expect(
        invoke(
          "conversation.linkPerson",
          { id: c.id, personId: person.id },
          context(member, { actor }),
        ),
      ).rejects.toBeInstanceOf(ForbiddenError);
    }
    const linked = await invoke(
      "conversation.linkPerson",
      { id: c.id, personId: person.id },
      context(member),
    );
    expect(linked).toMatchObject({ person: { id: person.id }, unknownSender: null });
    const after = await db.query
      .selectFrom("core_conversation")
      .select(["sender_address", "sender_hash"])
      .where("id", "=", c.id)
      .executeTakeFirstOrThrow();
    expect(after).toEqual({ sender_address: null, sender_hash: null });
    const timeline = (
      await invoke(
        "activity.listForRecord",
        { object: "person", recordId: person.id },
        context(member),
      )
    ).items.map((a) => a.id);
    expect(timeline).toContain(c.messageId);
    expect(timeline).not.toContain(note.id);
    await expect(
      invoke("conversation.linkPerson", { id: c.id, personId: person.id }, context(member)),
    ).rejects.toBeInstanceOf(ConflictError);
  });
});

describe("erase", () => {
  it("removes a Person's conversations, their messages and notes, and the bodies in R2", async () => {
    const person = await createPerson(member);
    const c = await conversation({ personId: person.id, bodyRef: `email-bodies/${unique("b")}` });
    const second = await conversation({ personId: person.id, channel: "chat" });
    const note = await invoke("message.note", { id: c.id, body: "noted" }, context(member));
    // A message also linked to another record goes all the same: it is the Person's.
    const elsewhere = await createPerson(member);
    await env.DB.prepare(
      "INSERT INTO core_activity_links (activity_id, object_type, record_id) VALUES (?, 'person', ?)",
    )
      .bind(second.messageId, elsewhere.id)
      .run();
    const { body_ref } = (await env.DB.prepare("SELECT body_ref FROM core_activity WHERE id = ?")
      .bind(c.messageId)
      .first<{ body_ref: string }>()) ?? { body_ref: "" };

    await invoke("person.erase", { id: person.id }, context(admin));

    for (const id of [c.id, second.id]) {
      expect(
        await env.DB.prepare("SELECT id FROM core_conversation WHERE id = ?").bind(id).first(),
      ).toBeNull();
    }
    for (const id of [c.messageId, second.messageId, note.id]) {
      expect(
        await env.DB.prepare("SELECT id FROM core_activity WHERE id = ?").bind(id).first(),
      ).toBeNull();
    }
    expect(
      await env.DB.prepare("SELECT key FROM core_blob_deletion WHERE key = ?")
        .bind(body_ref)
        .first(),
    ).not.toBeNull();
  });

  it("the Trash purge deletes a purged Person's conversations", async () => {
    const person = await createPerson(member);
    const c = await conversation({ personId: person.id });
    await env.DB.prepare(
      "UPDATE core_person SET deleted_at = '2000-01-01T00:00:00.000Z' WHERE id = ?",
    )
      .bind(person.id)
      .run();
    await invoke("trash.purge", { limit: 100 }, context(admin, { actor: "automation" }));
    expect(
      await env.DB.prepare("SELECT id FROM core_conversation WHERE id = ?").bind(c.id).first(),
    ).toBeNull();
    expect(
      await env.DB.prepare("SELECT id FROM core_activity WHERE id = ?").bind(c.messageId).first(),
    ).toBeNull();
  });

  it("a merge moves the merged Person's conversations to the survivor", async () => {
    const survivor = await createPerson(member);
    const merged = await createPerson(member);
    const c = await conversation({ personId: merged.id });
    await invoke("person.merge", { survivorId: survivor.id, mergedId: merged.id }, context(admin));
    const read = await invoke("conversation.get", { id: c.id }, context(member));
    expect(read.conversation.person?.id).toBe(survivor.id);
  });
});
