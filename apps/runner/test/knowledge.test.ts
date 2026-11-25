// Stage 38 step 5 (ADR 0706): the Knowledge pack (packs/knowledge) in the real host, its tools run
// in the sandbox, installed the way a product that lists the pack installs it, with real D1.
// Content is installed beside it (posts are publishable too, and never a procedure's search), and
// Bookings (with Programs, which it requires) for a pack-role account: a coach.
//
// What it shows: a member drafts a procedure and cannot publish it; a person publishes it, and
// everyone who must read it is told; a coach (a pack role) reads the published wording and never
// the draft, has it to read, and confirms the current version once; a small fix keeps the
// confirmation and a read-again version asks again (and tells again); who must read and the
// review period are a person's, once published only a manager's; read status is for those who
// manage, never a member or the assistant; the assistant drafts, and its publish is a request; the
// public reads a help page as published and never a procedure; the review date follows the last
// publish; and the day's reminder is sent once.
import { env } from "cloudflare:workers";
import {
  type ActingUser,
  type ExtensionHost,
  getObject,
  type InvocationContext,
  invokeByName,
  type OutsideInvocationContext,
  refreshSchemaRegistry,
  runAckDue,
} from "@composable-os/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runDateRelative } from "../src/automations/schedule.ts";
import { runWorkflows, setPreset } from "./automation-fixture.ts";
import { createAdmin, createMember, db, host, unique } from "./helpers.ts";

const packFiles = (sources: Record<string, string>) =>
  Object.fromEntries(
    Object.entries(sources)
      .map(([path, text]) => [path.split("/").pop() as string, text] as const)
      .filter(([name]) => name !== "vitest.config.ts"),
  );
const files: Record<string, Record<string, string>> = {
  knowledge: packFiles(
    import.meta.glob<string>("../../../packs/knowledge/*.ts", {
      query: "?raw",
      import: "default",
      eager: true,
    }),
  ),
  content: packFiles(
    import.meta.glob<string>("../../../packs/content/*.ts", {
      query: "?raw",
      import: "default",
      eager: true,
    }),
  ),
  programs: packFiles(
    import.meta.glob<string>("../../../packs/programs/*.ts", {
      query: "?raw",
      import: "default",
      eager: true,
    }),
  ),
  bookings: packFiles(
    import.meta.glob<string>("../../../packs/bookings/*.ts", {
      query: "?raw",
      import: "default",
      eager: true,
    }),
  ),
};
const OURS = new Set(Object.keys(files));

/** The extension host of a deployment whose product lists Knowledge, Content and Bookings. */
const shippedHost: ExtensionHost = {
  ...host,
  shipped: async () => [
    ...(await host.shipped()).filter((s) => !OURS.has(s.id)),
    { id: "knowledge", version: "0.1.0" },
    { id: "content", version: "0.2.0" },
    { id: "programs", version: "0.1.0" },
    { id: "bookings", version: "0.1.0" },
  ],
  commitShipped: (id) =>
    files[id]
      ? host.commit({
          id,
          files: files[id] as Record<string, string>,
          message: `Shipped ${id}`,
          author: { name: "Composable OS", email: "release@composableos.dev" },
        })
      : host.commitShipped(id),
};

const PROCEDURE = "knowledge.procedure";
const HELP_PAGE = "knowledge.helppage";
const DAY = 86_400_000;

let admin: ActingUser;
let member: ActingUser;
let manager: ActingUser;
let coach: ActingUser;

const staff = (user: ActingUser, extra: Partial<InvocationContext> = {}): InvocationContext => ({
  actor: "human",
  user,
  origin: { surface: "ui" },
  db,
  extensionHost: shippedHost,
  ...extra,
});
const assistant = (user: ActingUser) =>
  staff(user, { actor: "assistant", origin: { surface: "assistant", sessionId: unique("s") } });
const outside = (principal: { kind: "public" }): OutsideInvocationContext => ({
  principal,
  db,
  extensionHost: shippedHost,
});

function run<T = Record<string, unknown>>(
  name: string,
  input: unknown,
  ctx: InvocationContext | OutsideInvocationContext,
): Promise<T> {
  return invokeByName(name, input, ctx) as Promise<T>;
}

/** What a call was refused with: its code and the host's details (unwrapped from a tool's). */
async function refusal(call: Promise<unknown>) {
  try {
    await call;
  } catch (error) {
    const e = error as { code?: string; details?: Record<string, unknown> };
    const inner = (e.details?.details ?? e.details) as Record<string, unknown> | undefined;
    return { code: e.code, inner: e.details?.code, details: inner };
  }
  throw new Error("expected a refusal");
}

/** The notices a person has with a key that starts so. */
async function noticesOf(user: ActingUser, key: string) {
  const rows = await env.DB.prepare(
    "SELECT title, dedupe_key FROM core_notifications WHERE user_id = ? AND substr(dedupe_key, 1, ?) = ? ORDER BY created_at",
  )
    .bind(user.id, key.length, key)
    .all<{ title: string; dedupe_key: string }>();
  return rows.results;
}

async function staffAccount(name: string, role: "member" | "viewer" = "member") {
  const id = `usr_${unique("k")}`;
  const now = new Date().toISOString();
  await env.DB.prepare(
    "INSERT INTO core_user (id, name, email, email_verified, created_at, updated_at, role) VALUES (?, ?, ?, 1, ?, ?, ?)",
  )
    .bind(id, name, `${unique("k")}@example.com`, now, now, role)
    .run();
  return { id, email: "", name, role } as ActingUser;
}

/** A member drafts a procedure; who must read it is set by a person (the admin). */
async function draftedProcedure(title: string, notes: string) {
  const made = await run<{ id: string }>(
    "x.knowledge.draftProcedure",
    { title, notes },
    staff(member),
  );
  await run(
    "record.update",
    {
      object: PROCEDURE,
      id: made.id,
      values: { mustRead: { everyone: false, roles: ["bookings.coach", "admin"] } },
    },
    staff(admin),
  );
  return made.id;
}

type ToRead = {
  toRead: { id: string; version: number }[];
  confirmed: { id: string; version: number }[];
};

beforeAll(async () => {
  admin = await createAdmin();
  for (const id of ["content", "programs", "bookings", "knowledge"]) {
    await run("extension.install", { id, shipped: true }, staff(admin));
  }
  await refreshSchemaRegistry(db.query);
  member = await createMember();
  manager = await staffAccount("Mo Manager");
  await run(
    "user.setPermissions",
    { id: manager.id, permissions: ["knowledge:manage"] },
    staff(admin),
  );
  coach = await staffAccount("Coach Kim");
  await run("user.setPackRole", { id: coach.id, role: "bookings.coach" }, staff(admin));
}, 180_000);

afterAll(() => setPreset("balanced"));

describe("the pack in a product", () => {
  it("is installed as shipped: a staff-read, acknowledged procedure and a public help page", async () => {
    const row = await env.DB.prepare("SELECT source, status FROM core_extensions WHERE id = ?")
      .bind("knowledge")
      .first();
    expect(row).toEqual({ source: "shipped", status: "active" });
    expect(getObject(PROCEDURE)?.publishable).toMatchObject({
      staffRead: true,
      acknowledge: {
        who: "mustRead",
        manage: "knowledge:manage",
        managed: ["reviewEvery", "owner"],
      },
    });
    expect(getObject(PROCEDURE)?.public).toBeUndefined();
    expect(getObject(HELP_PAGE)?.public?.read).toContain("body");
  });
});

describe("a procedure, drafted by staff and published by a person", () => {
  let id: string;

  beforeAll(async () => {
    id = await draftedProcedure(
      unique("Injuries"),
      "# When someone is hurt\nKeep calm and fetch the kit.\n\n## Afterwards\nWrite it up.",
    );
  });

  it("a member drafts it and cannot publish it; a person allowed to publish does", async () => {
    expect(
      (await refusal(run("record.publish", { object: PROCEDURE, id }, staff(member)))).code,
    ).toBe("forbidden");
    const published = await run<{ version: number; readAgain: boolean }>(
      "record.publish",
      { object: PROCEDURE, id },
      staff(admin),
    );
    expect(published).toMatchObject({ version: 1, readAgain: true });
  });

  it("everyone who must read it is told, and nobody else", async () => {
    expect(await noticesOf(coach, `ack.asked:${PROCEDURE}:${id}:1`)).toHaveLength(1);
    expect(await noticesOf(admin, `ack.asked:${PROCEDURE}:${id}:1`)).toHaveLength(1);
    // The member wrote it but is not in "must read": not told.
    expect(await noticesOf(member, `ack.asked:${PROCEDURE}:${id}`)).toEqual([]);
    const [notice] = await noticesOf(coach, `ack.asked:${PROCEDURE}:${id}:1`);
    expect(notice?.title).toMatch(/^Please read: Injuries/);
  });

  it("a coach reads the published wording, never the draft, and nothing else of the record", async () => {
    await run(
      "record.update",
      { object: PROCEDURE, id, values: { summary: "zebracrossing in the draft only" } },
      staff(admin),
    );
    const read = await run<{ version: number; values: Record<string, unknown> }>(
      "content.staffGet",
      { object: PROCEDURE, id },
      staff(coach),
    );
    expect(read.version).toBe(1);
    expect(read.values.summary ?? null).toBeNull();
    expect(read.values.mustRead).toBeUndefined();
    // Search finds the published words and not the draft's.
    const found = await run<{ items: { id: string; section: { anchor: string | null } }[] }>(
      "content.search",
      { object: PROCEDURE, q: "afterwa" },
      staff(coach),
    );
    expect(found.items.map((h) => h.id)).toContain(id);
    expect(found.items.find((h) => h.id === id)?.section.anchor).toBe("afterwards");
    const draftWord = await run<{ items: unknown[] }>(
      "content.search",
      { object: PROCEDURE, q: "zebracrossing" },
      staff(coach),
    );
    expect(draftWord.items).toEqual([]);
    // The working copy is not the coach's to read.
    expect((await refusal(run("record.get", { object: PROCEDURE, id }, staff(coach)))).code).toBe(
      "forbidden",
    );
  });

  it("the coach has it to read, confirms the current version once, and it is done", async () => {
    const before = await run<ToRead>("x.knowledge.toRead", {}, staff(coach));
    expect(before.toRead).toContainEqual(expect.objectContaining({ id, version: 1 }));
    expect(await run("x.knowledge.confirm", { id, version: 1 }, staff(coach))).toMatchObject({
      id,
      version: 1,
    });
    const twice = await refusal(run("x.knowledge.confirm", { id, version: 1 }, staff(coach)));
    expect(twice.inner ?? twice.code).toBe("conflict");
    const after = await run<ToRead>("x.knowledge.toRead", {}, staff(coach));
    expect(after.toRead.map((r) => r.id)).not.toContain(id);
    expect(after.confirmed).toContainEqual(expect.objectContaining({ id, version: 1 }));
  });

  it("a small fix keeps the confirmation; a read-again version asks again and tells again", async () => {
    await run(
      "record.update",
      { object: PROCEDURE, id, values: { summary: "What we do when someone is hurt." } },
      staff(admin),
    );
    const fix = await run<{ version: number }>(
      "record.publish",
      { object: PROCEDURE, id, readAgain: false },
      staff(admin),
    );
    expect(fix.version).toBe(2);
    expect(
      (await run<ToRead>("x.knowledge.toRead", {}, staff(coach))).toRead.map((r) => r.id),
    ).not.toContain(id);
    expect(await noticesOf(coach, `ack.asked:${PROCEDURE}:${id}:2`)).toEqual([]);
    // A superseded version is refused.
    const stale = await refusal(run("x.knowledge.confirm", { id, version: 1 }, staff(coach)));
    expect(stale.inner ?? stale.code).toBe("conflict");

    const again = await run<{ version: number }>(
      "record.publish",
      { object: PROCEDURE, id, readAgain: true },
      staff(admin),
    );
    expect(again.version).toBe(3);
    expect((await run<ToRead>("x.knowledge.toRead", {}, staff(coach))).toRead).toContainEqual(
      expect.objectContaining({ id, version: 3 }),
    );
    expect(await noticesOf(coach, `ack.asked:${PROCEDURE}:${id}:3`)).toHaveLength(1);
    // The confirmation of version 1 is kept, unchanged, and no longer counts.
    const rows = await env.DB.prepare(
      "SELECT version FROM core_publish_ack WHERE object_type = ? AND record_id = ? AND account_id = ?",
    )
      .bind(PROCEDURE, id, coach.id)
      .all<{ version: number }>();
    expect(rows.results.map((r) => r.version)).toEqual([1]);
  });

  it("read status is for those who manage: an admin and a grant, never a member or the assistant", async () => {
    const status = await run<{
      procedure: { people: { account: string; confirmed: unknown; since: string | null }[] };
    }>("x.knowledge.readStatus", { id }, staff(manager));
    const kim = status.procedure.people.find((p) => p.account === coach.id);
    expect(kim).toMatchObject({ confirmed: null });
    expect(kim?.since).not.toBeNull();
    const all = await run<{ procedures: { id: string; mustRead: number }[] }>(
      "x.knowledge.readStatus",
      {},
      staff(admin),
    );
    expect(all.procedures.find((p) => p.id === id)?.mustRead).toBeGreaterThanOrEqual(2);
    expect((await refusal(run("x.knowledge.readStatus", { id }, staff(member)))).code).toBe(
      "forbidden",
    );
    expect((await refusal(run("x.knowledge.readStatus", { id }, assistant(admin)))).code).toBe(
      "forbidden",
    );
    // A pack role manages nothing, whatever it is granted (ADR 0600).
    expect((await refusal(run("x.knowledge.readStatus", { id }, staff(coach)))).code).toBe(
      "forbidden",
    );
  });

  it("who must read and the review period are a manager's once published, never an AI's", async () => {
    // Host rule (ADR 0706, `acknowledge.managed`): a member may not change the review period of
    // a published procedure; a person who manages may.
    expect(
      (
        await refusal(
          run(
            "record.update",
            { object: PROCEDURE, id, values: { reviewEvery: 6 } },
            staff(member),
          ),
        )
      ).code,
    ).toBe("forbidden");
    await setPreset("autonomous");
    try {
      expect(
        (
          await refusal(
            run(
              "record.update",
              { object: PROCEDURE, id, values: { reviewEvery: 6 } },
              assistant(admin),
            ),
          )
        ).code,
      ).toBe("forbidden");
    } finally {
      await setPreset("balanced");
    }
    await run(
      "record.update",
      { object: PROCEDURE, id, values: { reviewEvery: 6 } },
      staff(manager),
    );
    const read = await run<{ values: Record<string, unknown> }>(
      "record.get",
      { object: PROCEDURE, id },
      staff(admin),
    );
    // The next review is six months after the last publish.
    const published = Date.parse(String(read.values.publishedAt));
    const next = Date.parse(String(read.values.nextReview).replace(" ", "T"));
    const months = (next - published) / DAY / 30.4;
    expect(Math.round(months)).toBe(6);
    // 0 is never: no next review, so no reminder.
    await run("record.update", { object: PROCEDURE, id, values: { reviewEvery: 0 } }, staff(admin));
    const never = await run<{ values: Record<string, unknown> }>(
      "record.get",
      { object: PROCEDURE, id },
      staff(admin),
    );
    expect(never.values.nextReview ?? null).toBeNull();
  });

  it("the day's reminder reaches who still has it to read, once", async () => {
    // Eight days on, at noon UTC: the coach has had version 3 to read for more than seven days.
    const later = new Date(Date.now() + 8 * DAY);
    later.setUTCHours(12, 0, 0, 0);
    // A retitle in the draft only (M3): the coach's list and the reminder keep the published title.
    const published = await run<{ values: Record<string, unknown> }>(
      "content.staffGet",
      { object: PROCEDURE, id },
      staff(coach),
    );
    const title = String(published.values.title);
    await run(
      "record.update",
      { object: PROCEDURE, id, values: { title: "SECRET draft title" } },
      staff(admin),
    );
    const listed = await run<{ toRead: { id: string; title: string | null }[] }>(
      "x.knowledge.toRead",
      {},
      staff(coach),
    );
    expect(listed.toRead.find((r) => r.id === id)?.title).toBe(title);
    const first = await runAckDue(db, { clock: () => later });
    expect(first.reminders).toBeGreaterThanOrEqual(1);
    const reminders = await noticesOf(coach, `ack.reminder:${PROCEDURE}:${id}:3`);
    expect(reminders).toHaveLength(1);
    expect(reminders[0]?.title).toBe(`Still to read: ${title}`);
    // The admin confirmed nothing either; the manager is not in "must read" and is not reminded.
    expect(await noticesOf(manager, `ack.reminder:${PROCEDURE}:${id}`)).toEqual([]);
    // The same day again, and the next day: no second reminder of this version.
    expect(await runAckDue(db, { clock: () => later })).toEqual({
      asked: 0,
      reminders: 0,
      outstanding: 0,
      welcomes: 0,
      more: false,
    });
    await runAckDue(db, { clock: () => new Date(later.getTime() + DAY) });
    expect(await noticesOf(coach, `ack.reminder:${PROCEDURE}:${id}:3`)).toHaveLength(1);
  });
});

describe("the review reminder", () => {
  it("reaches the procedure's owner on its next review date, 12 months from the last publish", async () => {
    const id = await draftedProcedure(unique("Cleaning standards"), "Wipe every bench.");
    await run(
      "record.update",
      { object: PROCEDURE, id, values: { owner: manager.id } },
      staff(admin),
    );
    await run("record.publish", { object: PROCEDURE, id }, staff(admin));
    const read = await run<{ values: Record<string, unknown> }>(
      "record.get",
      { object: PROCEDURE, id },
      staff(admin),
    );
    expect(read.values.reviewEvery).toBe(12);
    const next = String(read.values.nextReview);
    const published = String(read.values.publishedAt);
    // A year on, the same day.
    expect(next.slice(0, 10)).toBe(`${Number(published.slice(0, 4)) + 1}${published.slice(4, 10)}`);
    const title = String(read.values.title);
    await runWorkflows(() => runDateRelative(env, next.slice(0, 10), new Date().toISOString()));
    const told = await env.DB.prepare(
      "SELECT title FROM core_notifications WHERE user_id = ? AND title = ?",
    )
      .bind(manager.id, `Time to check this is still right: ${title}`)
      .all();
    expect(told.results).toHaveLength(1);
    // The day before, nothing.
    const before = await runDateRelative(env, published.slice(0, 10), new Date().toISOString());
    expect(before.runIds ?? []).toEqual([]);
  });
});

describe("pack roles and the assistant", () => {
  it("a coach writes procedures only when granted knowledge:write", async () => {
    const refused = await refusal(
      run("x.knowledge.draftProcedure", { title: unique("Locking up") }, staff(coach)),
    );
    expect(refused.code).toBe("forbidden");
    await run(
      "user.setPermissions",
      { id: coach.id, permissions: ["knowledge:write"] },
      staff(admin),
    );
    try {
      const made = await run<{ id: string }>(
        "x.knowledge.draftProcedure",
        { title: unique("Locking up") },
        staff(coach),
      );
      expect(made.id).toBeTruthy();
      // Writing is not publishing, and not reading the working copy elsewhere.
      expect(
        (await refusal(run("record.publish", { object: PROCEDURE, id: made.id }, staff(coach))))
          .code,
      ).toBe("forbidden");
    } finally {
      await run("user.setPermissions", { id: coach.id, permissions: [] }, staff(admin));
    }
  });

  it("the assistant drafts; its publish is a request a person approves, and it never confirms", async () => {
    await setPreset("autonomous");
    let id = "";
    try {
      const made = await run<{ id: string }>(
        "x.knowledge.draftProcedure",
        { title: unique("Fire alarm"), notes: "Leave by the nearest exit." },
        assistant(admin),
      );
      id = made.id;
      // Who must read is a person's: the assistant cannot set it.
      expect(
        (
          await refusal(
            run(
              "record.update",
              { object: PROCEDURE, id, values: { mustRead: { everyone: true } } },
              assistant(admin),
            ),
          )
        ).code,
      ).toBe("forbidden");
      const asked = await refusal(
        run("record.publish", { object: PROCEDURE, id }, assistant(admin)),
      );
      expect(asked.code).toBe("pending_approval");
    } finally {
      await setPreset("balanced");
    }
    // Nothing went live: staff read no version of it.
    expect(
      (await refusal(run("content.staffGet", { object: PROCEDURE, id }, staff(admin)))).code,
    ).toBe("not_found");
    expect(
      (await refusal(run("x.knowledge.confirm", { id, version: 1 }, assistant(admin)))).code,
    ).toBe("forbidden");
  });
});

describe("help pages and the public", () => {
  it("the public reads a help page as published and finds it by a word in its body", async () => {
    const made = await run<{ id: string }>(
      "x.knowledge.draftHelpPage",
      { title: unique("Where do I park"), notes: "Use the quokkacarpark behind the hall." },
      staff(member),
    );
    const slugOf = async () =>
      String(
        (
          await run<{ values: Record<string, unknown> }>(
            "record.get",
            { object: HELP_PAGE, id: made.id },
            staff(admin),
          )
        ).values.slug,
      );
    // A draft is not found, by address or by search.
    expect(
      (
        await refusal(
          run(
            "content.get",
            { object: HELP_PAGE, slug: await slugOf() },
            outside({ kind: "public" }),
          ),
        )
      ).code,
    ).toBe("not_found");
    expect(
      (
        await run<{ items: unknown[] }>(
          "content.search",
          { object: HELP_PAGE, q: "quokkacar" },
          outside({ kind: "public" }),
        )
      ).items,
    ).toEqual([]);
    await run("record.publish", { object: HELP_PAGE, id: made.id }, staff(admin));
    const page = await run<{ id: string; values: Record<string, unknown> }>(
      "content.get",
      { object: HELP_PAGE, slug: await slugOf() },
      outside({ kind: "public" }),
    );
    expect(page.id).toBe(made.id);
    const hits = await run<{ items: { id: string }[] }>(
      "content.search",
      { object: HELP_PAGE, q: "quokkacar" },
      outside({ kind: "public" }),
    );
    expect(hits.items.map((h) => h.id)).toEqual([made.id]);
  });

  it("the public never reads a procedure, published or not", async () => {
    const id = await draftedProcedure(
      unique("Closing up"),
      "Lock the back door with the wombatkey.",
    );
    await run("record.publish", { object: PROCEDURE, id }, staff(admin));
    const slug = String(
      (
        await run<{ values: Record<string, unknown> }>(
          "record.get",
          { object: PROCEDURE, id },
          staff(admin),
        )
      ).values.slug,
    );
    for (const [name, input] of [
      ["content.get", { object: PROCEDURE, slug }],
      ["content.list", { object: PROCEDURE }],
      ["content.search", { object: PROCEDURE, q: "wombatkey" }],
      ["content.staffGet", { object: PROCEDURE, id }],
    ] as const) {
      // Not found, and the staff read is no operation of the public's at all.
      expect((await refusal(run(name, input, outside({ kind: "public" })))).code, name).toMatch(
        /^(not_found|unknown_operation)$/,
      );
    }
    // Staff find it by the same word.
    expect(
      (
        await run<{ items: { id: string }[] }>(
          "content.search",
          { object: PROCEDURE, q: "wombatkey" },
          staff(coach),
        )
      ).items.map((h) => h.id),
    ).toEqual([id]);
  });

  it("the help topics are open to anyone, in their order", async () => {
    for (const [name, order] of [
      ["Payments", 2],
      ["Booking", 1],
    ] as const) {
      await run(
        "record.create",
        { object: "knowledge.helptopic", values: { name: unique(name), order } },
        staff(admin),
      );
    }
    const out = await run<{ topics: { name: string; order: number }[] }>(
      "x.knowledge.helpTopics",
      {},
      outside({ kind: "public" }),
    );
    const orders = out.topics.map((t) => t.order);
    expect(orders).toEqual([...orders].sort((a, b) => a - b));
    expect(out.topics.length).toBeGreaterThanOrEqual(2);
  });
});
