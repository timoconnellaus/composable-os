// Stage 28, steps 2 and 3 (ADRs 0441, 0442, 0443): `publishable` completed for content, and what
// the public reads of it. A post has a working copy staff edit and at most one published version
// the public reads by its slug; it is a draft, scheduled, published or unpublished; old versions
// are kept and restored into the working copy; a changed slug redirects; a preview link shows a
// working copy until it expires; a public read is cached until the next change.
import { env } from "cloudflare:workers";
import { validateManifest } from "@composable-os/sdk";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  type ActingUser,
  getObject,
  invoke,
  publicProblems,
  runPublishDue,
  setContentCacheStore,
} from "../src/index.ts";
import { call, outside, PUBLIC } from "./customer-fixtures.ts";
import { extId, manifest, reconcile } from "./extension-helpers.ts";
import { context, createUser, db, refusal } from "./helpers.ts";

const EXT = extId("cms");
const POST = `${EXT}.post`;
/** A publishable object the public does not read (a program's shape). */
const NOTE = `${EXT}.note`;
/** A public object that is not publishable (an event on sale's shape). */
const SIGN = `${EXT}.sign`;
let admin: ActingUser;
let member: ActingUser;

const doc = (text: string) => ({
  blocks: [{ type: "paragraph", content: [{ type: "text", text }] }],
});

async function createPost(values: Record<string, unknown>) {
  return invoke("record.create", { object: POST, values }, context(admin));
}
const update = (id: string, values: Record<string, unknown>) =>
  invoke("record.update", { object: POST, id, values }, context(admin));
const publish = (id: string, at?: Date) =>
  invoke("record.publish", { object: POST, id }, context(admin, at ? { clock: () => at } : {}));
/** What the public is told: `content.get` called with no account. */
const read = (slug: string, object = POST) =>
  call("content.get", { object, slug }, outside(PUBLIC));
const list = () => call("content.list", { object: POST }, outside(PUBLIC));

const NOT_FOUND = (object = POST) => ({
  ok: false,
  error: { code: "not_found", message: "Not found", details: { object } },
});

beforeAll(async () => {
  admin = await createUser("admin");
  member = await createUser("member");
  await reconcile(
    manifest(EXT, {
      objects: {
        post: {
          label: "Post",
          plural: "Posts",
          titleField: "title",
          fields: {
            title: { type: "text", label: "Title", required: true },
            slug: { type: "slug", label: "Slug" },
            excerpt: { type: "text", label: "Excerpt" },
            body: { type: "richText", label: "Body" },
            date: { type: "datetime", label: "Date" },
            staffNote: { type: "text", label: "Staff note" },
          },
          publishable: {
            content: ["title", "excerpt", "body", "date"],
            slug: "slug",
            date: "date",
          },
          public: { read: ["title", "slug", "excerpt", "body", "date", "publishedAt"] },
        },
        note: {
          label: "Note",
          plural: "Notes",
          titleField: "title",
          fields: {
            title: { type: "text", label: "Title" },
            slug: { type: "slug", label: "Slug" },
          },
          publishable: { content: ["title"], slug: "slug" },
        },
        sign: {
          label: "Sign",
          plural: "Signs",
          titleField: "title",
          fields: {
            title: { type: "text", label: "Title" },
            slug: { type: "slug", label: "Slug" },
          },
          public: { read: ["title", "slug"] },
        },
      },
    }),
  );
});

beforeEach(() => {
  // The Worker's cache is shared by the tests in this file; most of them read the database.
  setContentCacheStore(null);
});

describe("the declaration", () => {
  it("names a slug field outside the content and a date field inside it", () => {
    expect(getObject(POST)?.publishable).toEqual({
      content: ["title", "excerpt", "body", "date"],
      slug: "slug",
      date: "date",
    });
    const fields = getObject(POST)?.fields.filter((f) => f.name.startsWith("publish"));
    expect(fields?.map((f) => f.name)).toEqual([
      "publishedVersion",
      "publishedAt",
      "publishState",
      "publishAt",
    ]);
    const { issues } = validateManifest(
      manifest(extId("bad"), {
        objects: {
          post: {
            label: "Post",
            plural: "Posts",
            titleField: "title",
            fields: {
              title: { type: "text", label: "Title" },
              slug: { type: "slug", label: "Slug" },
              when: { type: "text", label: "When" },
              total: { type: "formula", label: "Total", expression: "1" },
            },
            publishable: { content: ["title", "slug"], slug: "slug", date: "when" },
            public: { read: ["title", "total"] },
          },
        },
      }),
    );
    expect(issues.map((i) => i.message)).toEqual(
      expect.arrayContaining([
        "The slug is the record's address, not content: leave it out of content",
        "publishable.date must name a date or datetime field of post",
        'public.read lists "total", a formula: on a publishable object a formula reads the working copy',
      ]),
    );
    // The host holds the same line when it reads a declaration.
    const post = getObject(POST);
    if (!post?.public) throw new Error("no post");
    expect(publicProblems({ ...post, public: { read: ["title"] } })).toEqual([
      'public.read lists the slug "slug": it is how the public reads',
    ]);
  });
});

describe("live is a snapshot (criterion 1)", () => {
  it("editing a published post's working copy changes nothing the public reads until it is published again", async () => {
    const post = await createPost({ title: "Summer launch", excerpt: "Soon", body: doc("v1") });
    expect(post.values.slug).toBe("summer-launch");
    expect(post.values.publishState).toBe("draft");
    expect(await read("summer-launch")).toEqual(NOT_FOUND());

    await publish(post.id);
    const first = await read("summer-launch");
    expect(first).toMatchObject({
      ok: true,
      value: {
        kind: "record",
        id: post.id,
        values: { title: "Summer launch", excerpt: "Soon", body: doc("v1") },
      },
    });
    // Only the declared fields: never the staff note, the state or the working copy's time.
    const values = (first as { value: { values: Record<string, unknown> } }).value.values;
    expect(Object.keys(values).sort()).toEqual(
      ["body", "date", "excerpt", "publishedAt", "slug", "title"].sort(),
    );
    // The date was empty: publishing filled it, in the version and the working copy.
    expect(values.date).toBe(values.publishedAt);

    await update(post.id, { title: "Summer launch (draft)", body: doc("v2"), staffNote: "s" });
    expect(await read("summer-launch")).toEqual(first);
    expect(await list()).toMatchObject({
      ok: true,
      value: { items: expect.arrayContaining([expect.objectContaining({ values })]) },
    });

    await publish(post.id);
    expect(await read("summer-launch")).toMatchObject({
      ok: true,
      value: { values: { title: "Summer launch (draft)", body: doc("v2") } },
    });
  });
});

describe("states (criterion 2)", () => {
  it("draft, scheduled, published at the set time by the cron, unpublished: each public read matches", async () => {
    const start = new Date("2031-03-01T09:00:00.000Z");
    const post = await createPost({ title: "Opening night", body: doc("Doors at 7") });
    const state = async () =>
      (await invoke("record.get", { object: POST, id: post.id }, context(admin))).values;

    expect((await state()).publishState).toBe("draft");
    expect(await read("opening-night")).toEqual(NOT_FOUND());

    const at = new Date(start.getTime() + 3_600_000).toISOString();
    const scheduled = await invoke(
      "record.schedulePublish",
      { object: POST, id: post.id, at },
      context(admin, { clock: () => start }),
    );
    expect(scheduled).toMatchObject({ publishAt: at, scheduledBy: admin.id });
    expect(await state()).toMatchObject({ publishState: "scheduled", publishAt: at, date: at });
    expect(await read("opening-night")).toEqual(NOT_FOUND());
    // A later edit waits for the next publish: what goes live is what the person scheduled.
    await update(post.id, { body: doc("Doors at 8, written after the schedule") });

    // Not due yet: the cron publishes nothing.
    const early = await runPublishDue(db, { clock: () => new Date(start.getTime() + 60_000) });
    expect(early.published).toBe(0);
    expect(await read("opening-night")).toEqual(NOT_FOUND());

    const due = await runPublishDue(db, { clock: () => new Date(start.getTime() + 3_660_000) });
    expect(due.published).toBeGreaterThanOrEqual(1);
    expect(await state()).toMatchObject({
      publishState: "published",
      publishedVersion: 1,
      publishAt: null,
    });
    expect(await read("opening-night")).toMatchObject({
      ok: true,
      value: { values: { body: doc("Doors at 7"), date: at } },
    });
    const version = await invoke("record.versions", { object: POST, id: post.id }, context(admin));
    expect(version.items[0]).toMatchObject({ version: 1, publishedBy: admin.id });

    await invoke("record.unpublish", { object: POST, id: post.id }, context(admin));
    expect((await state()).publishState).toBe("unpublished");
    expect(await read("opening-night")).toEqual(NOT_FOUND());
    expect(await list()).toMatchObject({ ok: true });
    expect(JSON.stringify(await list())).not.toContain(post.id);
    // The versions are kept, and it can go live again.
    expect(
      (await invoke("record.versions", { object: POST, id: post.id }, context(admin))).items,
    ).toHaveLength(1);
    await publish(post.id);
    expect((await state()).publishState).toBe("published");
    expect(await read("opening-night")).toMatchObject({ ok: true });
  });

  it("scheduling and unpublishing are a person's with the publish permission; a schedule is in the future", async () => {
    const post = await createPost({ title: "Gated schedule" });
    const at = new Date(Date.now() + 3_600_000).toISOString();
    // An AI actor only asks: its request waits for a person (ADR 0480).
    for (const actor of ["assistant", "mcp", "automation"] as const) {
      const error = await refusal(
        invoke(
          "record.schedulePublish",
          { object: POST, id: post.id, at },
          context(admin, {
            actor,
            origin: {
              surface: actor === "automation" ? "automation" : actor,
              sessionId: `s_${actor}_${Date.now()}`,
            },
          } as never),
        ),
      );
      expect(error.code, actor).toBe("pending_approval");
    }
    expect(
      await refusal(
        invoke("record.schedulePublish", { object: POST, id: post.id, at }, context(member)),
      ),
    ).toMatchObject({ code: "forbidden", details: { permission: "records:publish" } });
    expect(
      await refusal(
        invoke(
          "record.schedulePublish",
          { object: POST, id: post.id, at: new Date(Date.now() - 60_000).toISOString() },
          context(admin),
        ),
      ),
    ).toMatchObject({ code: "invalid_input", details: { field: "at" } });
    // Cancelling drops it; publishing now drops it too.
    await invoke("record.schedulePublish", { object: POST, id: post.id, at }, context(admin));
    await invoke("record.cancelSchedule", { object: POST, id: post.id }, context(admin));
    const cancelled = await invoke("record.get", { object: POST, id: post.id }, context(admin));
    expect(cancelled.values).toMatchObject({ publishState: "draft", publishAt: null });
    await invoke("record.schedulePublish", { object: POST, id: post.id, at }, context(admin));
    await publish(post.id);
    const rows = await env.DB.prepare(
      "SELECT count(*) AS n FROM core_publish_schedule WHERE record_id = ?",
    )
      .bind(post.id)
      .first<{ n: number }>();
    expect(rows?.n).toBe(0);
  });
});

describe("versions (criterion 3)", () => {
  it("every publish keeps its version; comparing and restoring change the working copy only", async () => {
    const post = await createPost({ title: "Versions", excerpt: "one", body: doc("one") });
    await publish(post.id);
    await update(post.id, { excerpt: "two", body: doc("two") });
    await publish(post.id);
    await update(post.id, { excerpt: "three" });
    const versions = await invoke("record.versions", { object: POST, id: post.id }, context(admin));
    expect(versions.items.map((v) => v.version)).toEqual([2, 1]);

    const compared = await invoke(
      "record.compareVersions",
      { object: POST, id: post.id, from: 1, to: 2 },
      context(admin),
    );
    expect(compared.changes.map((c) => c.field).sort()).toEqual(["body", "excerpt"]);
    const toWorking = await invoke(
      "record.compareVersions",
      { object: POST, id: post.id, from: 2 },
      context(admin),
    );
    expect(toWorking).toMatchObject({
      to: null,
      changes: [{ field: "excerpt", before: "two", after: "three" }],
    });

    await invoke(
      "record.restoreVersion",
      { object: POST, id: post.id, version: 1 },
      context(admin),
    );
    const record = await invoke("record.get", { object: POST, id: post.id }, context(admin));
    expect(record.values).toMatchObject({ excerpt: "one", body: doc("one"), publishedVersion: 2 });
    // The public still reads version 2.
    expect(await read("versions")).toMatchObject({
      ok: true,
      value: { values: { excerpt: "two", body: doc("two") } },
    });
  });
});

describe("not found is one answer (criterion 4)", () => {
  it("a draft, an unpublished record, an unknown slug and a non-publishable object answer alike", async () => {
    await createPost({ title: "Still a draft" });
    const gone = await createPost({ title: "Taken down" });
    await publish(gone.id);
    await invoke("record.unpublish", { object: POST, id: gone.id }, context(admin));
    const deleted = await createPost({ title: "Deleted one" });
    await publish(deleted.id);
    await invoke("record.delete", { object: POST, id: deleted.id }, context(admin));
    await invoke("record.create", { object: SIGN, values: { title: "Open" } }, context(admin));
    const note = await invoke(
      "record.create",
      { object: NOTE, values: { title: "Coach note" } },
      context(admin),
    );
    await invoke("record.publish", { object: NOTE, id: note.id }, context(admin));

    const answers = [
      await read("still-a-draft"),
      await read("taken-down"),
      await read("deleted-one"),
      await read("never-was"),
      await read("Not A Slug!"),
    ];
    for (const answer of answers) expect(answer).toEqual(NOT_FOUND());
    for (const object of [SIGN, NOTE, "nope.nope", "person"]) {
      expect(await read("open", object)).toEqual(NOT_FOUND(object));
      expect(await read("coach-note", object)).toEqual(NOT_FOUND(object));
    }
    // Staff calling it are told what the public is told: never the working copy.
    const asStaff = await refusal(
      invoke("content.get", { object: POST, slug: "still-a-draft" }, context(admin)),
    );
    expect(asStaff).toMatchObject({ code: "not_found", message: "Not found" });
    // And the generic public reads hold the same line.
    const direct = await call("public.get", { object: POST, id: gone.id }, outside(PUBLIC));
    expect(direct).toMatchObject({ ok: false, error: { code: "unknown_operation" } });
  });
});

describe("slugs (criterion 8)", () => {
  it("are unique among live records, redirect when changed, and are free again after a delete", async () => {
    const a = await createPost({ title: "Hello world" });
    const b = await createPost({ title: "Hello world" });
    expect([a.values.slug, b.values.slug]).toEqual(["hello-world", "hello-world-2"]);
    expect(
      await refusal(
        invoke(
          "record.create",
          { object: POST, values: { title: "x", slug: "hello-world" } },
          context(admin),
        ),
      ),
    ).toMatchObject({ code: "invalid_input", details: { reason: "slug_taken", field: "slug" } });
    expect(await refusal(update(b.id, { slug: "hello-world" }))).toMatchObject({
      details: { reason: "slug_taken" },
    });
    expect(await refusal(update(b.id, { slug: "Hello World" }))).toMatchObject({
      code: "invalid_input",
    });
    // The database refuses a second one whatever wrote it.
    const table = (await env.DB.prepare(
      "SELECT table_name FROM core_extension_objects WHERE name = ?",
    )
      .bind(POST)
      .first<{ table_name: string }>()) as { table_name: string };
    await expect(
      env.DB.prepare(`UPDATE ${table.table_name} SET slug = 'hello-world' WHERE id = ?`)
        .bind(b.id)
        .run(),
    ).rejects.toThrow(/UNIQUE/);

    // A published record's changed slug redirects; a draft's does not.
    await publish(a.id);
    await update(a.id, { slug: "hello-again" });
    expect(await read("hello-world")).toEqual({
      ok: true,
      value: { kind: "redirect", object: POST, slug: "hello-again" },
    });
    expect(await read("hello-again")).toMatchObject({
      ok: true,
      value: { kind: "record", id: a.id },
    });
    await update(b.id, { slug: "hello-draft" });
    expect(await read("hello-world-2")).toEqual(NOT_FOUND());
    // Unpublished, the redirect leads nowhere: one answer.
    await invoke("record.unpublish", { object: POST, id: a.id }, context(admin));
    expect(await read("hello-world")).toEqual(NOT_FOUND());
    await publish(a.id);

    // A record that takes the old slug wins it.
    const c = await createPost({ title: "Hello world" });
    expect(c.values.slug).toBe("hello-world");
    expect(await read("hello-world")).toEqual(NOT_FOUND());
    await publish(c.id);
    expect(await read("hello-world")).toMatchObject({ ok: true, value: { id: c.id } });

    // Deleted, its slug can be used again.
    await invoke("record.delete", { object: POST, id: c.id }, context(admin));
    const d = await invoke(
      "record.create",
      { object: POST, values: { title: "Another", slug: "hello-world" } },
      context(admin),
    );
    expect(d.values.slug).toBe("hello-world");
    // A record without an address is not published.
    const e = await createPost({ title: "No address" });
    await update(e.id, { slug: null });
    expect(await refusal(publish(e.id))).toMatchObject({
      code: "invalid_input",
      details: { reason: "slug_required" },
    });
  });
});

describe("preview links (criterion 10)", () => {
  it("show the working copy, and stop working after expiry and for any other record", async () => {
    const post = await createPost({ title: "Preview me", body: doc("draft"), staffNote: "secret" });
    const other = await createPost({ title: "Someone else", body: doc("other draft") });
    const start = new Date();
    const link = await invoke(
      "content.previewLink",
      { object: POST, id: post.id, hours: 1 },
      context(member, { clock: () => start }),
    );
    expect(link.token).toMatch(/^pv_/);
    const preview = (slug: string, token = link.token, at = start) =>
      call(
        "content.preview",
        { object: POST, slug, token },
        outside(PUBLIC, { clock: () => new Date(at.getTime() + 60_000) }),
      );
    const shown = await preview("preview-me");
    expect(shown).toMatchObject({
      ok: true,
      value: { kind: "preview", id: post.id, values: { title: "Preview me", body: doc("draft") } },
    });
    expect(JSON.stringify(shown)).not.toContain("secret");
    // Any other record, a made-up token, and after it expires: not found, as a draft is.
    expect(await preview("someone-else")).toEqual(NOT_FOUND());
    expect(await preview("preview-me", `pv_${"A".repeat(43)}`)).toEqual(NOT_FOUND());
    expect(await preview("preview-me", link.token, new Date(start.getTime() + 3_600_000))).toEqual(
      NOT_FOUND(),
    );
    const otherLink = await invoke(
      "content.previewLink",
      { object: POST, id: other.id },
      context(admin, { clock: () => start }),
    );
    expect(await preview("preview-me", otherLink.token)).toEqual(NOT_FOUND());
    // The token is a credential: only its hash is kept, and the audit log never holds it.
    const stored = await env.DB.prepare("SELECT token_hash FROM core_preview_link").all();
    expect(JSON.stringify(stored.results)).not.toContain(link.token);
    const audit = await env.DB.prepare(
      "SELECT * FROM core_audit WHERE operation = 'content.previewLink'",
    ).all();
    expect(JSON.stringify(audit.results)).not.toContain(link.token);
  });
});

describe("the cache (criterion 11)", () => {
  it("serves a public read from the cache, and after a publish the next read is the new version", async () => {
    const entries = new Map<string, string>();
    setContentCacheStore({
      async match(request) {
        const hit = entries.get(request.url);
        return hit === undefined ? undefined : new Response(hit);
      },
      async put(request, response) {
        entries.set(request.url, await response.text());
      },
    });
    const post = await createPost({ title: "Cached", body: doc("first") });
    await publish(post.id);
    expect(await read("cached")).toMatchObject({
      ok: true,
      value: { values: { body: doc("first") } },
    });
    const kept = entries.size;
    expect(kept).toBeGreaterThan(0);
    // Behind the pipeline's back the version changes: the cache still answers, so it was used.
    await env.DB.prepare(
      "UPDATE core_publish_version SET content = json_set(content, '$.title', 'Changed behind') WHERE record_id = ? AND current = 1",
    )
      .bind(post.id)
      .run();
    expect(await read("cached")).toMatchObject({
      ok: true,
      value: { values: { title: "Cached" } },
    });

    await update(post.id, { body: doc("second") });
    await publish(post.id);
    expect(await read("cached")).toMatchObject({
      ok: true,
      value: { values: { title: "Cached", body: doc("second") } },
    });
    // Unpublishing moves the key as well.
    await invoke("record.unpublish", { object: POST, id: post.id }, context(admin));
    expect(await read("cached")).toEqual(NOT_FOUND());
  });
});

describe("a slug taken while its record was in the Trash (ADR 0444)", () => {
  it("restoring it answers a conflict naming the slug, never an internal error", async () => {
    const first = await createPost({ title: "Coming back" });
    await invoke("record.delete", { object: POST, id: first.id }, context(admin));
    const second = await createPost({ title: "Coming back" });
    expect(second.values.slug).toBe("coming-back");
    const refused = await refusal(
      invoke("record.restore", { object: POST, id: first.id }, context(admin)),
    );
    expect(refused).toMatchObject({
      code: "conflict",
      details: { field: "slug", slug: "coming-back", reason: "slug_taken", heldBy: second.id },
    });
    expect(refused.message).toContain('"coming-back"');
    // Once the other one's address changes, it comes back.
    await update(second.id, { slug: "coming-back-again" });
    const restored = await invoke("record.restore", { object: POST, id: first.id }, context(admin));
    expect(restored.values.slug).toBe("coming-back");
  });
});

describe("preview links are listed and revoked (ADR 0444)", () => {
  it("staff see a record's working links without their tokens, and a revoked link stops at once", async () => {
    const post = await createPost({ title: "Revocable", body: doc("draft") });
    const one = await invoke("content.previewLink", { object: POST, id: post.id }, context(admin));
    const two = await invoke("content.previewLink", { object: POST, id: post.id }, context(member));
    const links = await invoke(
      "content.previewLinks",
      { object: POST, id: post.id },
      context(admin),
    );
    expect(links.items).toHaveLength(2);
    expect(JSON.stringify(links)).not.toContain(one.token);
    expect(JSON.stringify(links)).not.toContain(two.token);
    const preview = (token: string) =>
      call("content.preview", { object: POST, slug: "revocable", token }, outside(PUBLIC));
    expect(await preview(one.token)).toMatchObject({ ok: true });
    // Revoke the member's: it stops; the admin's still works.
    const memberLink = links.items.find((l) => l.createdBy === member.id);
    await invoke(
      "content.revokePreview",
      { object: POST, id: post.id, link: memberLink?.id },
      context(admin),
    );
    expect(await preview(two.token)).toEqual(NOT_FOUND());
    expect(await preview(one.token)).toMatchObject({ ok: true });
    const all = await invoke(
      "content.revokePreview",
      { object: POST, id: post.id, all: true },
      context(admin),
    );
    expect(all.revoked).toBe(1);
    expect(await preview(one.token)).toEqual(NOT_FOUND());
    expect(
      (await invoke("content.previewLinks", { object: POST, id: post.id }, context(admin))).items,
    ).toEqual([]);
  });
});
