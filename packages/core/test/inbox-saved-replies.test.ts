// Stage 36 step 3 (ADR 0749): saved replies, Settings → Inbox and a conversation's category,
// against real D1.
import { env } from "cloudflare:workers";
import { createCrmDb } from "@composable-os/db";
import { beforeAll, describe, expect, it } from "vitest";
import { PendingApprovalError, toOperationError } from "../src/errors.ts";
import { checkManifest } from "../src/extensions/install.ts";
import { messageStatements, newConversationStatement } from "../src/inbox/index.ts";
import { type ActingUser, invoke } from "../src/index.ts";
import { extId, manifest } from "./extension-helpers.ts";
import { createPerson } from "./fixtures.ts";
import { context, createUser, db, refusal, setPreset, unique } from "./helpers.ts";

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

/** A conversation with one inbound message, as the host writes one. */
async function conversation(personId: string | null, channel: "email" | "chat" = "email") {
  const now = new Date().toISOString();
  const created = await newConversationStatement(db.query, {
    channel,
    personId,
    senderAddress: personId ? null : `${unique("who")}@example.com`,
    subject: "About my class",
    now,
  });
  await db.batch([created.statement]);
  const row = await db.query
    .selectFrom("core_conversation")
    .select(["id", "version", "person_id", "assignee_id", "status"])
    .where("id", "=", created.id)
    .executeTakeFirstOrThrow();
  const written = await messageStatements(db.query, {
    conversation: row,
    type: channel,
    direction: "inbound",
    body: "Can I move my class?",
    externalKey: `${channel}:${unique("m")}`,
    now,
  });
  await db.batch(written.statements);
  return created.id;
}

const create = (user: ActingUser, input: Record<string, unknown>, actor?: "assistant" | "mcp") =>
  invoke(
    "savedReply.create",
    { title: unique("Reply"), body: "Thanks for writing.", ...input } as never,
    context(user, actor ? { actor } : {}),
  );

const listIds = async (user: ActingUser, input: Record<string, unknown> = {}) => {
  const ids: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await invoke(
      "savedReply.list",
      { limit: 100, ...input, ...(cursor ? { cursor } : {}) },
      context(user),
    );
    ids.push(...page.items.map((r) => r.id));
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return ids;
};

describe("saved replies: whose they are", () => {
  it("one's own is listed, read and changed by its owner alone, an admin included", async () => {
    const mine = await create(member, {});
    expect(mine.shared).toBe(false);
    expect(mine.owner?.id).toBe(member.id);
    expect(mine.canEdit).toBe(true);
    expect(await listIds(member)).toContain(mine.id);
    for (const user of [other, admin]) {
      expect(await listIds(user)).not.toContain(mine.id);
      expect(
        (
          await refusal(
            invoke("savedReply.update", { id: mine.id, title: "Mine now" }, context(user)),
          )
        ).code,
      ).toBe("not_found");
      expect(
        (await refusal(invoke("savedReply.archive", { id: mine.id }, context(user)))).code,
      ).toBe("not_found");
    }
    const person = await createPerson(member);
    const c = await conversation(person.id);
    expect(
      (await refusal(invoke("savedReply.fill", { id: mine.id, conversationId: c }, context(other))))
        .code,
    ).toBe("not_found");
    const changed = await invoke(
      "savedReply.update",
      { id: mine.id, title: "Moving a class", version: mine.version },
      context(member),
    );
    expect(changed.title).toBe("Moving a class");
    expect(changed.version).toBe(mine.version + 1);
  });

  it("shared ones are written by admins and used by everyone who works the inbox", async () => {
    expect((await refusal(create(member, { shared: true }))).code).toBe("forbidden");
    const shared = await create(admin, { shared: true });
    expect(shared.shared).toBe(true);
    expect(shared.owner).toBeNull();
    expect(await listIds(member)).toContain(shared.id);
    expect(await listIds(member, { scope: "shared" })).toContain(shared.id);
    expect(await listIds(member, { scope: "mine" })).not.toContain(shared.id);
    const asMember = (await invoke("savedReply.list", { limit: 100 }, context(member))).items.find(
      (r) => r.id === shared.id,
    );
    expect(asMember?.canEdit).toBe(false);
    expect(
      (await refusal(invoke("savedReply.update", { id: shared.id, title: "x" }, context(member))))
        .code,
    ).toBe("forbidden");
    expect(
      (await refusal(invoke("savedReply.archive", { id: shared.id }, context(member)))).code,
    ).toBe("forbidden");
    // A viewer reads the inbox and does not work it: no saved replies.
    expect((await refusal(invoke("savedReply.list", {}, context(viewer)))).code).toBe("forbidden");
  });

  it("archived ones leave the list and come back", async () => {
    const reply = await create(member, {});
    const archived = await invoke("savedReply.archive", { id: reply.id }, context(member));
    expect(archived.archived).toBe(true);
    expect(await listIds(member)).not.toContain(reply.id);
    expect(await listIds(member, { archived: true })).toContain(reply.id);
    const person = await createPerson(member);
    const c = await conversation(person.id);
    expect(
      (
        await refusal(
          invoke("savedReply.fill", { id: reply.id, conversationId: c }, context(member)),
        )
      ).code,
    ).toBe("invalid_input");
    await invoke("savedReply.archive", { id: reply.id, archived: false }, context(member));
    expect(await listIds(member)).toContain(reply.id);
  });

  it("a write from an older read is refused", async () => {
    const reply = await create(member, {});
    await invoke("savedReply.update", { id: reply.id, title: "First" }, context(member));
    expect(
      (
        await refusal(
          invoke(
            "savedReply.update",
            { id: reply.id, title: "Second", version: reply.version },
            context(member),
          ),
        )
      ).code,
    ).toBe("conflict");
    // At commit, the stale guards (migrations 1050 and 1051) are conflicts, not internal errors.
    expect(toOperationError(new Error("D1_ERROR: core_saved_reply_stale")).code).toBe("conflict");
    expect(toOperationError(new Error("D1_ERROR: core_conversation_stale")).code).toBe("conflict");
  });

  it("filters by channel", async () => {
    const chatOnly = await create(member, { channels: ["chat"] });
    expect(await listIds(member, { channel: "chat" })).toContain(chatOnly.id);
    expect(await listIds(member, { channel: "email" })).not.toContain(chatOnly.id);
    const person = await createPerson(member);
    const email = await conversation(person.id, "email");
    expect(
      (
        await refusal(
          invoke("savedReply.fill", { id: chatOnly.id, conversationId: email }, context(member)),
        )
      ).code,
    ).toBe("invalid_input");
  });
});

describe("saved replies: fixed slots only", () => {
  it("refuses a slot that is not one of the fixed ones, and a half-written one", async () => {
    for (const body of [
      "Hi {{person.email}}",
      "Your balance is {{order.balance}}",
      "Hi {{person.firstName}",
      "Hi person.firstName}}",
    ]) {
      expect((await refusal(create(member, { body }))).code).toBe("invalid_input");
    }
    const reply = await create(member, { body: "Hi" });
    expect(
      (
        await refusal(
          invoke("savedReply.update", { id: reply.id, body: "Hi {{x}}" }, context(member)),
        )
      ).code,
    ).toBe("invalid_input");
  });

  it("the host fills the slots from the conversation, the caller and the business", async () => {
    await invoke("settings.update", { orgName: "Northside Gym" }, context(admin));
    const person = await invoke(
      "person.create",
      {
        givenName: "Ada",
        familyName: "Byron",
        emails: [{ email: `${unique("ada")}@example.com` }],
      },
      context(member),
    );
    const c = await conversation(person.id);
    const reply = await create(member, {
      body: "Hi {{person.firstName}},\n\n{{ staff.firstName }} here at {{business.name}}.",
    });
    expect(reply.slots).toEqual(["person.firstName", "staff.firstName", "business.name"]);
    const filled = await invoke(
      "savedReply.fill",
      { id: reply.id, conversationId: c },
      context(member),
    );
    expect(filled.body).toBe("Hi Ada,\n\nmember here at Northside Gym.");
    expect(filled.missing).toEqual([]);
    // An unknown sender has no first name: the slot is left empty, and said so.
    const unknown = await conversation(null);
    const blank = await invoke(
      "savedReply.fill",
      { id: reply.id, conversationId: unknown },
      context(member),
    );
    expect(blank.body.startsWith("Hi ,")).toBe(true);
    expect(blank.missing).toEqual(["person.firstName"]);
  });

  it("filling one for a private conversation the caller may not read is not found", async () => {
    const person = await createPerson(member);
    const c = await conversation(person.id);
    await invoke("conversation.assign", { id: c, assigneeId: other.id }, context(admin));
    await invoke("conversation.setPrivate", { id: c, private: true }, context(admin));
    const reply = await create(member, {});
    expect(
      (
        await refusal(
          invoke("savedReply.fill", { id: reply.id, conversationId: c }, context(member)),
        )
      ).code,
    ).toBe("not_found");
    const own = await create(other, {});
    const filled = await invoke(
      "savedReply.fill",
      { id: own.id, conversationId: c },
      context(other),
    );
    expect(filled.body).toBe("Thanks for writing.");
  });
});

describe("saved replies: people only", () => {
  it("an AI caller may list and fill them, and may not write one", async () => {
    for (const actor of ["assistant", "mcp"] as const) {
      expect((await refusal(create(member, {}, actor))).code).toBe("forbidden");
    }
    const reply = await create(member, {});
    for (const actor of ["assistant", "automation"] as const) {
      expect(
        (
          await refusal(
            invoke("savedReply.update", { id: reply.id, title: "x" }, context(member, { actor })),
          )
        ).code,
      ).toBe("forbidden");
      expect(
        (await refusal(invoke("savedReply.archive", { id: reply.id }, context(member, { actor }))))
          .code,
      ).toBe("forbidden");
    }
    const listed = await invoke(
      "savedReply.list",
      { limit: 100 },
      context(member, { actor: "assistant" }),
    );
    expect(listed.items.map((r) => r.id)).toContain(reply.id);
  });

  it("a runtime extension may not declare the saved replies' operations", async () => {
    for (const operation of ["savedReply.list", "savedReply.fill", "inbox.categories"]) {
      const id = extId("rt");
      const checked = await checkManifest(
        db.query,
        id,
        manifest(id, {
          permissions: { read: [], write: [], operations: [operation], modules: [] },
        }),
        new Date().toISOString(),
        { source: "runtime" },
      );
      expect(JSON.stringify(checked.issues)).toContain("cannot read or work the shared inbox");
    }
  });

  it("audits a saved reply's title and channels, never its words", async () => {
    const reply = await create(member, { body: "The secret password is swordfish" });
    const { results } = await env.DB.prepare(
      `SELECT a.input, c.diff FROM core_audit a JOIN core_audit_changes c ON c.audit_id = a.id
       WHERE c.record_id = ?`,
    )
      .bind(reply.id)
      .all<{ input: string; diff: string }>();
    expect(results.length).toBeGreaterThan(0);
    expect(JSON.stringify(results)).not.toContain("swordfish");
  });
});

describe("Settings → Inbox and categories", () => {
  it("an admin sets the categories; staff read them; a conversation is filed under one", async () => {
    const name = unique("Bookings");
    const settings = await invoke(
      "inbox.settings.update",
      { categories: [name, "Payments", name.toUpperCase(), " Injuries "] },
      context(admin),
    );
    expect(settings.categories).toEqual([name, "Payments", "Injuries"]);
    expect((await invoke("inbox.settings.get", {}, context(admin))).categories).toEqual([
      name,
      "Payments",
      "Injuries",
    ]);
    expect((await invoke("inbox.categories", {}, context(viewer))).categories).toContain(name);
    const person = await createPerson(member);
    const c = await conversation(person.id);
    const filed = await invoke(
      "conversation.setCategory",
      { id: c, category: "payments" },
      context(member),
    );
    expect(filed.category).toBe("Payments");
    const listed = await invoke(
      "inbox.list",
      { view: "all", category: "Payments", limit: 100 },
      context(member),
    );
    expect(listed.items.map((i) => i.id)).toContain(c);
    expect(
      (
        await refusal(
          invoke("conversation.setCategory", { id: c, category: "Nope" }, context(member)),
        )
      ).code,
    ).toBe("invalid_input");
    expect(
      (
        await refusal(
          invoke("conversation.setCategory", { id: c, category: null }, context(viewer)),
        )
      ).code,
    ).toBe("forbidden");
    const cleared = await invoke(
      "conversation.setCategory",
      { id: c, category: null, version: filed.version },
      context(member),
    );
    expect(cleared.category).toBeNull();
    // Taking a category off the list leaves a conversation filed under it as it was.
    await invoke("conversation.setCategory", { id: c, category: "Injuries" }, context(member));
    await invoke("inbox.settings.update", { categories: [name, "Payments"] }, context(admin));
    expect(
      (await invoke("conversation.get", { id: c }, context(member))).conversation.category,
    ).toBe("Injuries");
  });

  it("the settings are a human admin's", async () => {
    for (const user of [member, viewer]) {
      expect(
        (await refusal(invoke("inbox.settings.update", { categories: ["A"] }, context(user)))).code,
      ).toBe("forbidden");
      expect((await refusal(invoke("inbox.settings.get", {}, context(user)))).code).toBe(
        "forbidden",
      );
    }
    for (const actor of ["assistant", "mcp", "automation"] as const) {
      expect(
        (
          await refusal(
            invoke("inbox.settings.update", { categories: ["A"] }, context(admin, { actor })),
          )
        ).code,
      ).toBe("forbidden");
    }
  });

  it("a private conversation is not found to file for a member who does not have it", async () => {
    await invoke("inbox.settings.update", { categories: ["Payments"] }, context(admin));
    const person = await createPerson(member);
    const c = await conversation(person.id);
    await invoke("conversation.setPrivate", { id: c, private: true }, context(admin));
    expect(
      (
        await refusal(
          invoke("conversation.setCategory", { id: c, category: "Payments" }, context(member)),
        )
      ).code,
    ).toBe("not_found");
    const filed = await invoke(
      "conversation.setCategory",
      { id: c, category: "Payments" },
      context(admin),
    );
    expect(filed.category).toBe("Payments");
  });
});

describe("the saved replies' cost", () => {
  let statements = 0;
  const metered = new Proxy(env.DB, {
    get(target, prop) {
      if (prop === "prepare") {
        return (query: string) => {
          statements += 1;
          return target.prepare(query);
        };
      }
      const value = Reflect.get(target, prop);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const meteredDb = createCrmDb(metered);

  it("lists a page in the same statements for 3 saved replies as for 150", async () => {
    const few = await createUser("member");
    const many = await createUser("member");
    const seed = async (owner: string, count: number) => {
      const now = new Date().toISOString();
      await env.DB.prepare(
        `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
         INSERT INTO core_saved_reply (id, title, body, channels, owner_id, created_at, updated_at)
         SELECT 'svr_' || ? || '_' || i, 'Reply ' || printf('%04d', i), 'Hello', '["email","chat"]',
           ?, ?, ? FROM n`,
      )
        .bind(count, owner, owner, now, now)
        .run();
    };
    await seed(few.id, 3);
    await seed(many.id, 150);
    const page = async (user: ActingUser) => {
      statements = 0;
      const out = await invoke(
        "savedReply.list",
        { scope: "mine", limit: 100 },
        { ...context(user), db: meteredDb },
      );
      return { statements, items: out.items.length, next: out.nextCursor };
    };
    const small = await page(few);
    const large = await page(many);
    expect(small.items).toBe(3);
    expect(large.items).toBe(100);
    expect(large.next).not.toBeNull();
    expect(large.statements).toBe(small.statements);
    expect(small.statements).toBeGreaterThan(0);
    expect(small.statements).toBeLessThanOrEqual(4);
    // The next page carries on where the first stopped.
    const rest = await invoke(
      "savedReply.list",
      { scope: "mine", limit: 100, cursor: large.next as string },
      context(many),
    );
    expect(rest.items).toHaveLength(50);
    expect(rest.nextCursor).toBeNull();
  });
});

describe("an AI files a conversation only through a person (review of PR #494, M7)", () => {
  it("an assistant's or MCP's category waits for review, under balanced and autonomous", async () => {
    await invoke("inbox.settings.update", { categories: ["Payments"] }, context(admin));
    const person = await createPerson(member);
    const c = await conversation(person.id);
    try {
      for (const preset of ["balanced", "autonomous"] as const) {
        await setPreset(preset);
        for (const [actor, origin] of [
          ["assistant", { surface: "assistant", sessionId: "ath_x" }],
          ["mcp", { surface: "mcp", clientId: "cap_x" }],
        ] as const) {
          await expect(
            invoke(
              "conversation.setCategory",
              { id: c, category: "Payments" },
              context(member, { actor, origin } as never),
            ),
          ).rejects.toBeInstanceOf(PendingApprovalError);
        }
        const now = await invoke("conversation.get", { id: c }, context(member));
        expect(now.conversation.category).toBeNull();
      }
    } finally {
      await setPreset("balanced");
    }
    // A person files it at once.
    const filed = await invoke(
      "conversation.setCategory",
      { id: c, category: "Payments" },
      context(member),
    );
    expect(filed.category).toBe("Payments");
  });
});

describe("making a Person from an unknown sender is one write (review of PR #494, M1)", () => {
  it("makes the Person with the sender's address and links them, in one batch", async () => {
    const c = await conversation(null);
    const before = await invoke("conversation.get", { id: c }, context(member));
    const sender = before.conversation.unknownSender as string;
    const linked = await invoke(
      "conversation.linkPerson",
      { id: c, newPerson: { givenName: "Grace", familyName: "Hopper" } },
      context(member),
    );
    expect(linked.person?.name).toBe("Grace Hopper");
    expect(linked.unknownSender).toBeNull();
    const person = await invoke("person.get", { id: linked.person?.id as string }, context(member));
    expect(person.emails.map((e) => e.email)).toEqual([sender.toLowerCase()]);
    // Pressed again: refused, and no second Person.
    const again = await refusal(
      invoke(
        "conversation.linkPerson",
        { id: c, newPerson: { givenName: "Grace", familyName: "Hopper" } },
        context(member),
      ),
    );
    expect(again.code).toBe("conflict");
    const named = await env.DB.prepare(
      "SELECT count(*) AS n FROM core_person_emails WHERE email = ?",
    )
      .bind(sender.toLowerCase())
      .first<{ n: number }>();
    expect(named?.n).toBe(1);
  });

  it("a refused link leaves no Person behind", async () => {
    const c = await conversation(null);
    const read = await invoke("conversation.get", { id: c }, context(member));
    const sender = read.conversation.unknownSender as string;
    // Someone else changed the conversation since this read: the write is refused whole.
    await invoke("conversation.take", { id: c }, context(other));
    expect(
      (
        await refusal(
          invoke(
            "conversation.linkPerson",
            { id: c, newPerson: { givenName: "Ada" }, version: read.conversation.version },
            context(member),
          ),
        )
      ).code,
    ).toBe("conflict");
    const left = await env.DB.prepare(
      "SELECT count(*) AS n FROM core_person_emails WHERE email = ?",
    )
      .bind(sender.toLowerCase())
      .first<{ n: number }>();
    expect(left?.n).toBe(0);
  });

  it("takes personId or newPerson, not both and not neither", async () => {
    const c = await conversation(null);
    const person = await createPerson(member);
    for (const input of [
      { id: c },
      { id: c, personId: person.id, newPerson: { givenName: "Ada" } },
    ]) {
      expect((await refusal(invoke("conversation.linkPerson", input, context(member)))).code).toBe(
        "invalid_input",
      );
    }
  });
});
