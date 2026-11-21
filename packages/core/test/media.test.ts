// Stage 28, step 4 (ADR 0444), acceptance criterion 9: the media library. Type and size limits
// hold (the type read from the bytes); a picture no published content shows is not served to the
// public; the Trash purge deletes the R2 object. Against a real local R2 bucket.
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import {
  type ActingUser,
  coreInvoker,
  drainAllBlobDeletions,
  handleMedia,
  invoke,
  isMediaPath,
  MEDIA_MAX_BYTES,
  type MediaStore,
  mediaDimensions,
  sniffMediaType,
} from "../src/index.ts";
import { call, outside, PUBLIC } from "./customer-fixtures.ts";
import { extId, manifest, reconcile } from "./extension-helpers.ts";
import { context, createUser, db } from "./helpers.ts";

const bucket = (env as unknown as { MEDIA_TEST: R2Bucket }).MEDIA_TEST;
const store: MediaStore = {
  put: async (key, bytes, type) => {
    await bucket.put(key, bytes, { httpMetadata: { contentType: type } });
  },
  get: async (key) => {
    const object = await bucket.get(key);
    return object ? { body: object.body, size: object.size } : null;
  },
  delete: async (keys) => {
    await bucket.delete(keys);
  },
};
const blobs = {
  get: async () => null,
  put: async () => {},
  delete: (keys: string[]) => store.delete(keys),
};

/** A PNG header of the given size: signature, IHDR. Enough for the host to know it. */
function png(width: number, height: number, extra = 0): Uint8Array {
  const bytes = new Uint8Array(33 + extra);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82]);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}
const text = (s: string) => new TextEncoder().encode(s);

const EXT = extId("med");
const POST = `${EXT}.post`;
const STORY = `${EXT}.story`;
let admin: ActingUser;

const asStaff = (extra: Record<string, unknown> = {}) =>
  context(admin, { media: store, ...extra } as never);

async function upload(bytes: Uint8Array, name = "hall.png") {
  return invoke("media.upload", { name, alt: "The hall" }, asStaff({ upload: { bytes } }));
}

async function attempt(promise: Promise<unknown>) {
  try {
    return { ok: true as const, value: await promise };
  } catch (error) {
    return {
      ok: false as const,
      error: error as { code: string; details?: Record<string, unknown> },
    };
  }
}

const doc = (media: string) => ({
  blocks: [
    { type: "paragraph", content: [{ type: "text", text: "See the hall" }] },
    { type: "image", media, alt: "The hall, full" },
  ],
});

beforeAll(async () => {
  admin = await createUser("admin");
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
            body: { type: "richText", label: "Body" },
            cover: { type: "image", label: "Cover" },
          },
          publishable: { content: ["title", "body", "cover"], slug: "slug" },
          public: { read: ["title", "slug", "body", "cover"] },
        },
        // A picture among the content that the public does not read (issue #181).
        story: {
          label: "Story",
          plural: "Stories",
          titleField: "title",
          fields: {
            title: { type: "text", label: "Title", required: true },
            slug: { type: "slug", label: "Slug" },
            body: { type: "richText", label: "Body" },
            backstage: { type: "image", label: "Backstage picture" },
          },
          publishable: { content: ["title", "body", "backstage"], slug: "slug" },
          public: { read: ["title", "slug", "body"] },
        },
      },
    }),
  );
});

describe("what an upload may be (criterion 9)", () => {
  it("is a raster picture the host recognises from its bytes, at most 10 MB", async () => {
    expect(sniffMediaType(png(4, 3))).toBe("image/png");
    expect(mediaDimensions(png(640, 480), "image/png")).toEqual({ width: 640, height: 480 });
    const stored = await upload(png(640, 480));
    expect(stored).toMatchObject({ type: "image/png", width: 640, height: 480, alt: "The hall" });
    const object = await bucket.get(`media/${stored.id}`);
    expect(object?.size).toBe(33);
    expect(object?.httpMetadata?.contentType).toBe("image/png");

    // Named as a picture, or said to be one, it is still what its bytes are.
    for (const [what, bytes] of [
      ["an SVG", text('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')],
      ["HTML", text("<!doctype html><script>alert(1)</script>")],
      ["a script", text("#!/bin/sh\nrm -rf /")],
      ["a PDF", text("%PDF-1.7")],
      ["a few bytes", new Uint8Array([0x89, 0x50])],
    ] as const) {
      const refused = await attempt(upload(bytes, "photo.png"));
      expect(refused, what).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    }
    const tooBig = await attempt(upload(png(1, 1, MEDIA_MAX_BYTES)));
    expect(tooBig).toMatchObject({ ok: false, error: { details: { reason: "too_large" } } });
    const empty = await attempt(upload(new Uint8Array()));
    expect(empty).toMatchObject({ ok: false, error: { details: { reason: "empty" } } });
    // No file comes through an operation's input: over MCP, or without the route, there is none.
    const noFile = await attempt(invoke("media.upload", { name: "x.png" }, asStaff()));
    expect(noFile).toMatchObject({ ok: false, error: { details: { reason: "no_file" } } });
  });

  it("a picture in rich text or an image field names a live item", async () => {
    const item = await upload(png(10, 10));
    const ok = await invoke(
      "record.create",
      {
        object: POST,
        values: {
          title: "Pictured",
          body: doc(item.id),
          cover: { media: item.id, alt: "Cover", focal: { x: 0.5, y: 0.3 } },
        },
      },
      context(admin),
    );
    expect(ok.values.cover).toMatchObject({ media: item.id });
    const ghost = await attempt(
      invoke(
        "record.create",
        { object: POST, values: { title: "Ghost", body: doc("med_01NOSUCHPICTURE0000000000") } },
        context(admin),
      ),
    );
    expect(ghost).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    const badFocal = await attempt(
      invoke(
        "record.create",
        {
          object: POST,
          values: { title: "Off", cover: { media: item.id, alt: "x", focal: { x: 2, y: 0 } } },
        },
        context(admin),
      ),
    );
    expect(badFocal).toMatchObject({ ok: false });
  });
});

describe("serving (criterion 9)", () => {
  it("staff are served any live picture; the public only one a published record shows", async () => {
    const picture = await upload(png(800, 600));
    const loose = await upload(png(20, 20));
    const serve = (id: string, who: "staff" | "public") =>
      who === "staff"
        ? attempt(invoke("media.serve", { id }, context(admin)))
        : call("media.serve", { id }, outside(PUBLIC)).then((r) =>
            r.ok
              ? { ok: true as const, value: r.value }
              : { ok: false as const, error: r.error as never },
          );
    const NOT_FOUND = {
      ok: false,
      error: { code: "not_found", message: "Not found", details: { object: "media" } },
    };
    expect(await serve(loose.id, "staff")).toMatchObject({ ok: true });
    expect(await serve(loose.id, "public")).toEqual(NOT_FOUND);

    // In a draft only: not the public's.
    const post = await invoke(
      "record.create",
      { object: POST, values: { title: "Hall pictures", body: doc(picture.id) } },
      context(admin),
    );
    expect(await serve(picture.id, "public")).toEqual(NOT_FOUND);
    await invoke("record.publish", { object: POST, id: post.id }, context(admin));
    expect(await serve(picture.id, "public")).toMatchObject({ ok: true, value: { public: true } });
    // Taken out of the working copy, it is still in the live version until the next publish.
    await invoke(
      "record.update",
      { object: POST, id: post.id, values: { body: null } },
      context(admin),
    );
    expect(await serve(picture.id, "public")).toMatchObject({ ok: true });
    await invoke("record.publish", { object: POST, id: post.id }, context(admin));
    expect(await serve(picture.id, "public")).toEqual(NOT_FOUND);
    // Back in, then unpublished; then the record deleted; then the picture deleted.
    await invoke(
      "record.update",
      { object: POST, id: post.id, values: { cover: { media: picture.id, alt: "c" } } },
      context(admin),
    );
    await invoke("record.publish", { object: POST, id: post.id }, context(admin));
    expect(await serve(picture.id, "public")).toMatchObject({ ok: true });
    await invoke("record.unpublish", { object: POST, id: post.id }, context(admin));
    expect(await serve(picture.id, "public")).toEqual(NOT_FOUND);
    await invoke("record.publish", { object: POST, id: post.id }, context(admin));
    await invoke("record.delete", { object: POST, id: post.id }, context(admin));
    expect(await serve(picture.id, "public")).toEqual(NOT_FOUND);
    await invoke("record.restore", { object: POST, id: post.id }, context(admin));
    expect(await serve(picture.id, "public")).toMatchObject({ ok: true });
    await invoke("media.delete", { id: picture.id }, context(admin));
    expect(await serve(picture.id, "public")).toEqual(NOT_FOUND);
    expect(await serve(picture.id, "staff")).toMatchObject({
      ok: false,
      error: { code: "not_found" },
    });
    // An id that is not one answers the same.
    expect(await serve("med_01NOSUCHPICTURE0000000000", "public")).toEqual(NOT_FOUND);
  });

  it("the route uploads for staff, streams to whoever media.serve allows, and refuses the rest", async () => {
    const staffCtx = asStaff();
    const route = (who: "staff" | "public") => (request: Request) =>
      handleMedia(request, {
        invoker: coreInvoker,
        context: async () => (who === "staff" ? staffCtx : outside(PUBLIC)),
        media: store,
        uploads: true,
      });
    const posted = await route("staff")(
      new Request("https://host.test/api/media?name=stage.png&alt=Stage", {
        method: "POST",
        body: png(1280, 720),
      }),
    );
    expect(posted.status).toBe(200);
    const { data } = (await posted.json()) as { data: { id: string } };
    const asPublic = await route("public")(
      new Request(`https://host.test/api/media/${data.id}?w=640`),
    );
    expect(asPublic.status).toBe(404);
    const asStaffReply = await route("staff")(
      new Request(`https://host.test/api/media/${data.id}`),
    );
    expect(asStaffReply.status).toBe(200);
    expect(asStaffReply.headers.get("content-type")).toBe("image/png");
    expect(asStaffReply.headers.get("cache-control")).toBe("private, no-store");
    expect(asStaffReply.headers.get("x-content-type-options")).toBe("nosniff");
    expect((await asStaffReply.arrayBuffer()).byteLength).toBe(33);

    const post = await invoke(
      "record.create",
      { object: POST, values: { title: "On stage", body: doc(data.id) } },
      context(admin),
    );
    await invoke("record.publish", { object: POST, id: post.id }, context(admin));
    const published = await route("public")(
      new Request(`https://host.test/api/media/${data.id}?w=600`),
    );
    expect(published.status).toBe(200);
    expect(published.headers.get("cache-control")).toMatch(/^public, max-age=\d+$/);
    await published.arrayBuffer();
    // The same picture at the host's own address for a phone, beside the HTTP surface (#181).
    const forPhone = await route("public")(
      new Request(`https://host.test/api/v1/media/${data.id}?w=750`),
    );
    expect(forPhone.status).toBe(200);
    expect(forPhone.headers.get("content-type")).toBe("image/png");
    await forPhone.arrayBuffer();
    expect(isMediaPath("/api/v1/media/med_1")).toBe(true);
    expect(isMediaPath("/api/v1/op/me.get")).toBe(false);

    // A public caller cannot upload, and nobody uploads from another site or past the limit.
    const publicUpload = await route("public")(
      new Request("https://host.test/api/media?name=x.png", { method: "POST", body: png(1, 1) }),
    );
    expect(publicUpload.status).toBeGreaterThanOrEqual(400);
    const crossSite = await route("staff")(
      new Request("https://host.test/api/media?name=x.png", {
        method: "POST",
        body: png(1, 1),
        headers: { origin: "https://evil.test" },
      }),
    );
    expect(crossSite.status).toBe(403);
    const huge = await route("staff")(
      new Request("https://host.test/api/media?name=x.png", {
        method: "POST",
        body: png(1, 1, MEDIA_MAX_BYTES),
      }),
    );
    expect(huge.status).toBe(413);
    // The staff-token route (ADR 0470): a bearer token only, and only a person's staff session.
    const tokenRoute = (ctx: unknown, headers: Record<string, string>) =>
      handleMedia(
        new Request("https://host.test/api/v1/media?name=x.png", {
          method: "POST",
          body: png(3, 3),
          headers,
        }),
        {
          invoker: coreInvoker,
          context: async () => ctx as never,
          media: store,
          uploads: true,
          tokenUploads: true,
        },
      );
    expect((await tokenRoute(staffCtx, {})).status).toBe(401);
    expect((await tokenRoute(staffCtx, { cookie: "session=x" })).status).toBe(401);
    // A customer's device token, or the public, is not a person on the staff.
    expect(
      (await tokenRoute(outside(PUBLIC), { authorization: "Bearer cos_at_customer" })).status,
    ).toBe(403);
    for (const actor of ["mcp", "assistant", "automation"]) {
      const ai = { ...staffCtx, actor };
      expect((await tokenRoute(ai, { authorization: "Bearer cos_at_x" })).status, actor).toBe(403);
    }
    const byToken = await tokenRoute(staffCtx, { authorization: "Bearer cos_at_person" });
    expect(byToken.status).toBe(200);
    // Off unless the host turns it on: the binding never takes one.
    const off = await handleMedia(
      new Request("https://host.test/api/v1/media?name=x.png", {
        method: "POST",
        body: png(3, 3),
        headers: { authorization: "Bearer cos_at_person" },
      }),
      { invoker: coreInvoker, context: async () => staffCtx, media: store, uploads: false },
    );
    expect(off.status).toBe(404);

    // The binding's door takes no upload at all.
    const bound = await handleMedia(
      new Request("https://host.test/api/media?name=x.png", { method: "POST", body: png(1, 1) }),
      { invoker: coreInvoker, context: async () => staffCtx, media: store, uploads: false },
    );
    expect(bound.status).toBe(404);
  });
});

describe("the Trash and the purge (criterion 9)", () => {
  it("a deleted picture is in the Trash, comes back, and once purged its R2 object is gone", async () => {
    const item = await upload(png(30, 30));
    const key = `media/${item.id}`;
    await invoke("media.delete", { id: item.id }, context(admin));
    const trash = await invoke("trash.list", { object: "media" }, context(admin));
    expect(trash.items.map((i) => i.id)).toContain(item.id);
    await invoke("media.restore", { id: item.id }, context(admin));
    expect((await invoke("media.get", { id: item.id }, context(admin))).id).toBe(item.id);

    await invoke("media.delete", { id: item.id }, context(admin));
    const later = new Date(Date.now() + 31 * 86_400_000);
    const purged = await invoke(
      "trash.purge",
      { limit: 100 },
      context(admin, {
        actor: "automation",
        origin: { surface: "system", automationId: "trash.purge" },
        clock: () => later,
      } as never),
    );
    expect(purged.purged.map((p) => p.id)).toContain(item.id);
    const queued = await env.DB.prepare("SELECT key FROM core_blob_deletion WHERE key = ?")
      .bind(key)
      .first();
    expect(queued).not.toBeNull();
    expect(await bucket.head(key)).not.toBeNull();
    await drainAllBlobDeletions(db.query, blobs);
    expect(await bucket.head(key)).toBeNull();
    expect(
      await env.DB.prepare("SELECT key FROM core_blob_deletion WHERE key = ?").bind(key).first(),
    ).toBeNull();
  });
});

describe("serving follows the reader's fields, and every use (issue #181)", () => {
  const NOT_FOUND = {
    ok: false,
    error: { code: "not_found", message: "Not found", details: { object: "media" } },
  };
  const publicServe = (id: string) => call("media.serve", { id }, outside(PUBLIC));

  it("a picture only in a field the public does not read is not theirs, though it is published", async () => {
    const picture = await upload(png(40, 40));
    const story = await invoke(
      "record.create",
      {
        object: STORY,
        values: { title: "Behind the scenes", backstage: { media: picture.id, alt: "Crew" } },
      },
      context(admin),
    );
    await invoke("record.publish", { object: STORY, id: story.id }, context(admin));
    expect(await publicServe(picture.id)).toEqual(NOT_FOUND);
    expect(await attempt(invoke("media.serve", { id: picture.id }, context(admin)))).toMatchObject({
      ok: true,
    });
    // Shown in a field the public reads too, it is served.
    await invoke(
      "record.update",
      { object: STORY, id: story.id, values: { body: doc(picture.id) } },
      context(admin),
    );
    await invoke("record.publish", { object: STORY, id: story.id }, context(admin));
    expect(await publicServe(picture.id)).toMatchObject({ ok: true, value: { public: true } });
  });

  it("a picture whose first twenty uses are not public, and a later one is, is served", async () => {
    const picture = await upload(png(50, 50));
    for (let i = 0; i < 21; i += 1) {
      const post = await invoke(
        "record.create",
        { object: POST, values: { title: `Gone ${i}`, body: doc(picture.id) } },
        context(admin),
      );
      await invoke("record.publish", { object: POST, id: post.id }, context(admin));
      // Deleted: its version still names the picture, and the public reads none of it.
      await invoke("record.delete", { object: POST, id: post.id }, context(admin));
    }
    expect(await publicServe(picture.id)).toEqual(NOT_FOUND);
    const live = await invoke(
      "record.create",
      { object: POST, values: { title: "Still here", body: doc(picture.id) } },
      context(admin),
    );
    await invoke("record.publish", { object: POST, id: live.id }, context(admin));
    const uses = await env.DB.prepare(
      "SELECT count(*) AS n FROM core_published_media WHERE media_id = ?",
    )
      .bind(picture.id)
      .first<{ n: number }>();
    expect(uses?.n).toBe(22);
    expect(await publicServe(picture.id)).toMatchObject({ ok: true, value: { public: true } });
  });

  it("migration 0500's backfill finds what publishing writes", async () => {
    const one = await upload(png(10, 10));
    const two = await upload(png(10, 10));
    const post = await invoke(
      "record.create",
      {
        object: POST,
        values: { title: "Backfilled", body: doc(one.id), cover: { media: two.id, alt: "c" } },
      },
      context(admin),
    );
    await invoke("record.publish", { object: POST, id: post.id }, context(admin));
    const written = await env.DB.prepare(
      "SELECT media_id, field FROM core_published_media WHERE record_id = ? ORDER BY field",
    )
      .bind(post.id)
      .all<{ media_id: string; field: string }>();
    const backfill = await env.DB.prepare(
      `SELECT j.value AS media_id,
         substr(substr(j.fullkey, 3), 1, instr(substr(j.fullkey, 3) || '.', '.') - 1) AS field
       FROM core_publish_version v, json_tree(v.content) j
       WHERE v.current = 1 AND v.record_id = ? AND j.key = 'media' AND j.type = 'text'
         AND j.value LIKE 'med\\_%' ESCAPE '\\'
       ORDER BY field`,
    )
      .bind(post.id)
      .all<{ media_id: string; field: string }>();
    expect(written.results).toEqual([
      { media_id: one.id, field: "body" },
      { media_id: two.id, field: "cover" },
    ]);
    expect(backfill.results).toEqual(written.results);
  });
});
