// `cos content import` (ADR 0470) against the real host: the CLI's own engine
// (packages/create-composable-os/src/content-import) over cos-app's real HTTP surface and media
// route, with a person's staff device session, as the command runs it. The Content pack's objects
// are reconciled into the host from the pack's own manifest.
//
// A folder of posts and pictures imports; a re-run changes nothing; a person's edit is reported,
// not overwritten; a bad file stops the run before any write; the upload route takes a staff
// device token only, and no MCP, assistant or automation caller can upload; --publish keeps the
// posts' dates, and the public list is in their order.
import { env } from "cloudflare:workers";
import { type Tokens, tokenSession } from "@composable-os/client";
import {
  type ActingUser,
  applyPlan,
  coreInvoker,
  handleMedia,
  type InvocationContext,
  invoke,
  isMediaPath,
  issueDeviceSession,
  planReconcile,
  refreshSchemaRegistry,
} from "@composable-os/core";
import { createCrmDb } from "@composable-os/db";
import { toManifest } from "@composable-os/sdk";
import { beforeAll, describe, expect, it } from "vitest";
import {
  type ImportHost,
  runImport,
} from "../../../packages/create-composable-os/src/content-import/engine.ts";
import { readFolder } from "../../../packages/create-composable-os/src/content-import/format.ts";
import { sessionHost } from "../../../packages/create-composable-os/src/content-import/host.ts";
import content from "../../../packs/content/index.ts";
import { apiContext, handleApi } from "../src/server/http/api.ts";
import { mediaStoreFor } from "../src/server/media.ts";
import { boundTestEnv } from "./bound-env.ts";
import { ORIGIN, signUp, unique } from "./mcp-helpers.ts";

const hostEnv = boundTestEnv(env);
const db = createCrmDb(env.DB);
const POST = "content.post";

/** cos-app's own dispatch for these paths (src/server.ts): the media route, then the surface. */
async function serve(request: Request): Promise<Response> {
  if (isMediaPath(new URL(request.url).pathname)) {
    return handleMedia(request, {
      invoker: coreInvoker,
      context: (req) => apiContext(req, hostEnv),
      media: mediaStoreFor(hostEnv as never),
      uploads: true,
      tokenUploads: true,
    });
  }
  return (await handleApi(request, hostEnv)) ?? new Response("Not found", { status: 404 });
}
const fetcher = ((input: string, init?: RequestInit) =>
  serve(new Request(input, init))) as unknown as typeof fetch;

let admin: ActingUser & { cookie: string };
let accessToken: string;

/** The engine over a staff device session's bearer token, as `cos content import` runs it. */
const asStaff = (): ImportHost =>
  sessionHost(ORIGIN, async () => ({ authorization: `Bearer ${accessToken}` }), fetcher);

/** A PNG header of the given size, with `seed` making each file's bytes its own. */
function png(width: number, height: number, seed = 0): Uint8Array {
  const bytes = new Uint8Array(40);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82]);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  view.setUint32(36, seed);
  return bytes;
}

const tag = unique("blog")
  .toLowerCase()
  .replace(/[^a-z0-9]/g, "");

/** An old blog's export: three posts, two pictures (one in a body, one a cover). */
function blog(change: (posts: Record<string, Record<string, unknown>>) => void = () => {}) {
  const posts: Record<string, Record<string, unknown>> = {
    [`opening-${tag}.json`]: {
      title: "Opening night",
      slug: `opening-${tag}`,
      excerpt: "Doors at seven.",
      body: {
        blocks: [
          { type: "paragraph", content: [{ type: "text", text: "The hall was full." }] },
          { type: "image", file: `hall-${tag}.png`, alt: "The hall" },
        ],
      },
      cover: { file: `cover-${tag}.png`, alt: "The stage" },
      date: "2021-03-01T09:00:00Z",
      status: "published",
      category: `News ${tag}`,
      byline: "Words by Sam Lee",
      seoTitle: "Opening night at the hall",
      seoDescription: "How the first night went.",
      noindex: false,
    },
    [`second-${tag}.json`]: {
      title: "Second week",
      slug: `second-${tag}`,
      date: "2022-06-15T09:00:00Z",
      status: "published",
      category: `News ${tag}`,
    },
    [`draft-${tag}.json`]: { title: "Still writing", slug: `draft-${tag}`, status: "draft" },
  };
  change(posts);
  return readFolder({
    posts: new Map(Object.entries(posts).map(([file, post]) => [file, JSON.stringify(post)])),
    pictures: new Map([
      [`hall-${tag}.png`, png(800, 600, 1)],
      [`cover-${tag}.png`, png(1200, 630, 2)],
    ]),
  });
}

const staff = (extra: Partial<InvocationContext> = {}): InvocationContext => ({
  actor: "human",
  user: admin,
  origin: { surface: "ui" },
  db,
  ...extra,
});

beforeAll(async () => {
  const user = await signUp(hostEnv as never, "admin");
  admin = { id: user.id, email: user.email, name: "Admin", role: "admin", cookie: user.cookie };
  const plan = await planReconcile(db.query, toManifest(content), {
    now: new Date().toISOString(),
  });
  await applyPlan((statements) => db.batch(statements), plan);
  await refreshSchemaRegistry(db.query);
  accessToken = (
    await issueDeviceSession(
      db,
      { audience: "staff", subjectId: admin.id },
      "Import test",
      new Date(),
    )
  ).accessToken;
}, 60_000);

const auditOf = async (operation: string) =>
  (await env.DB.prepare(
    "SELECT actor, user_id FROM core_audit WHERE operation = ? ORDER BY at DESC LIMIT 1",
  )
    .bind(operation)
    .first<{ actor: string; user_id: string }>()) ?? null;

describe("cos content import against the real host (ADR 0470)", () => {
  it("a bad file stops the run before any write, with every problem and its file", async () => {
    const before = await env.DB.prepare("SELECT count(*) AS n FROM core_import_key").first<{
      n: number;
    }>();
    const broken = readFolder({
      posts: new Map([
        [
          "a.json",
          JSON.stringify({ title: "A", body: { blocks: [{ type: "html", html: "<b>" }] } }),
        ],
        ["b.json", JSON.stringify({ title: "B", cover: { file: "missing.png", alt: "x" } })],
        ["c.json", "{ not json"],
        ["d.json", JSON.stringify({ title: "D", colour: "red" })],
      ]),
      pictures: new Map(),
    });
    const files = broken.problems.map((p) => p.file);
    expect(files).toEqual(expect.arrayContaining(["a.json", "b.json", "c.json", "d.json"]));
    const report = await runImport(broken, asStaff());
    expect(report.wroteNothing).toBe(true);
    expect(report.records).toEqual([]);
    // A problem only the host finds (a date the field refuses would be the folder's): a title
    // over the host's own limit is refused in the dry run, and nothing is written.
    const long = blog((posts) => {
      (posts[`draft-${tag}.json`] as Record<string, unknown>).excerpt = "x".repeat(1000);
      (posts[`second-${tag}.json`] as Record<string, unknown>).byline = "y".repeat(1001);
    });
    expect(long.problems.map((p) => p.file)).toContain(`second-${tag}.json`);
    const after = await env.DB.prepare("SELECT count(*) AS n FROM core_import_key").first<{
      n: number;
    }>();
    expect(after?.n).toBe(before?.n);
  });

  it("imports posts and pictures as the person, as drafts; a re-run changes nothing", async () => {
    const first = await runImport(blog(), asStaff());
    expect(first.problems).toEqual([]);
    expect(first.records.map((r) => r.outcome).sort()).toEqual(
      ["created", "created", "created", "created"].sort(),
    );
    expect(first.pictures).toEqual({ uploaded: 2, already: 0 });
    // Without --publish a published post in the source arrives a draft, said in the report.
    expect(first.notes.map((n) => n.file)).toEqual(
      expect.arrayContaining([`opening-${tag}.json`, `second-${tag}.json`]),
    );
    const opening = first.records.find((r) => r.key === `opening-${tag}`)?.id as string;
    const record = await invoke("record.get", { object: POST, id: opening }, staff());
    expect(record.values).toMatchObject({
      title: "Opening night",
      publishState: "draft",
      byline: "Words by Sam Lee",
      seoTitle: "Opening night at the hall",
      date: "2021-03-01T09:00:00.000Z",
    });
    const body = record.values.body as { blocks: { type: string; media?: string }[] };
    expect(body.blocks[1]?.media).toMatch(/^med_/);
    // Every write is the person's, through their device session: actor human.
    expect(await auditOf("record.import")).toEqual({ actor: "human", user_id: admin.id });
    expect(await auditOf("media.upload")).toEqual({ actor: "human", user_id: admin.id });

    const again = await runImport(blog(), asStaff());
    expect(again.records.every((r) => r.outcome === "unchanged")).toBe(true);
    expect(again.pictures).toEqual({ uploaded: 0, already: 2 });
    expect(again.wroteNothing).toBe(true);

    // A change in the source updates only what changed.
    const changed = await runImport(
      blog((posts) => {
        (posts[`draft-${tag}.json`] as Record<string, unknown>).excerpt = "Nearly done";
      }),
      asStaff(),
    );
    const draft = changed.records.find((r) => r.key === `draft-${tag}`);
    expect(draft).toMatchObject({ outcome: "updated", fields: ["excerpt"] });
  });

  it("a person's edit since the import is reported as a conflict, never overwritten", async () => {
    const report = await runImport(blog(), asStaff());
    const second = report.records.find((r) => r.key === `second-${tag}`)?.id as string;
    await invoke(
      "record.update",
      { object: POST, id: second, values: { title: "Week two" } },
      staff(),
    );
    const rerun = await runImport(
      blog((posts) => {
        (posts[`second-${tag}.json`] as Record<string, unknown>).title = "Second week, again";
      }),
      asStaff(),
    );
    expect(rerun.records.find((r) => r.key === `second-${tag}`)).toMatchObject({
      outcome: "conflict",
      fields: ["title"],
    });
    const kept = await invoke("record.get", { object: POST, id: second }, staff());
    expect(kept.values.title).toBe("Week two");
    // Put back as it was imported, it is the import's again.
    await invoke(
      "record.update",
      { object: POST, id: second, values: { title: "Second week" } },
      staff(),
    );
  });

  it("--publish keeps each post's date, and the public reads them newest first", async () => {
    const report = await runImport(blog(), asStaff(), { publish: true, confirm: async () => true });
    expect(report.published.map((p) => p.as).sort()).toEqual(["published", "published"]);
    const list = (await (
      await serve(
        new Request(`${ORIGIN}/api/v1/op/content.list`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            object: POST,
            filter: {
              field: "slug",
              op: "in",
              value: [`opening-${tag}`, `second-${tag}`, `draft-${tag}`],
            },
          }),
        }),
      )
    ).json()) as { data: { items: { values: { slug: string; date: string; byline?: string } }[] } };
    expect(list.data.items.map((i) => i.values.slug)).toEqual([`second-${tag}`, `opening-${tag}`]);
    expect(list.data.items.map((i) => i.values.date)).toEqual([
      "2022-06-15T09:00:00.000Z",
      "2021-03-01T09:00:00.000Z",
    ]);
    expect(list.data.items[1]?.values.byline).toBe("Words by Sam Lee");
    // A second --publish publishes nothing again.
    const again = await runImport(blog(), asStaff(), { publish: true, confirm: async () => true });
    expect(again.published.every((p) => p.as === "unchanged")).toBe(true);
    // Not confirmed: nothing at all.
    const stopped = await runImport(
      blog((posts) => {
        (posts[`draft-${tag}.json`] as Record<string, unknown>).excerpt = "Changed, then stopped";
      }),
      asStaff(),
      { publish: true, confirm: async () => false },
    );
    expect(stopped.wroteNothing).toBe(true);
  });

  it("a scheduled post is scheduled only with --publish", async () => {
    const future = new Date(Date.now() + 7 * 86_400_000).toISOString();
    const folder = () =>
      blog((posts) => {
        posts[`later-${tag}.json`] = {
          title: "Coming soon",
          slug: `later-${tag}`,
          status: "scheduled",
          date: future,
        };
      });
    const drafted = await runImport(folder(), asStaff());
    expect(drafted.notes.find((n) => n.file === `later-${tag}.json`)?.message).toContain(
      "Scheduled for",
    );
    const scheduled = await runImport(folder(), asStaff(), {
      publish: true,
      confirm: async () => true,
    });
    expect(scheduled.published.find((p) => p.file === `later-${tag}.json`)?.as).toBe("scheduled");
    const id = scheduled.records.find((r) => r.key === `later-${tag}`)?.id as string;
    const record = await invoke("record.get", { object: POST, id }, staff());
    expect(record.values).toMatchObject({ publishState: "scheduled", publishAt: future });
  });

  it("a dry run writes nothing and says what would happen", async () => {
    const before = await env.DB.prepare("SELECT count(*) AS n FROM core_import_key").first<{
      n: number;
    }>();
    const report = await runImport(
      blog((posts) => {
        posts[`new-${tag}.json`] = { title: "Brand new", slug: `new-${tag}` };
      }),
      asStaff(),
      { dryRun: true },
    );
    expect(report.records.find((r) => r.key === `new-${tag}`)?.outcome).toBe("created");
    expect(report.wroteNothing).toBe(true);
    const after = await env.DB.prepare("SELECT count(*) AS n FROM core_import_key").first<{
      n: number;
    }>();
    expect(after?.n).toBe(before?.n);
  });
});

describe("the upload route takes a person's staff device token only (ADR 0470)", () => {
  const upload = (headers: Record<string, string>, bytes = png(10, 10, Math.random() * 1e9)) =>
    serve(
      new Request(`${ORIGIN}/api/v1/media?name=x.png`, {
        method: "POST",
        headers: { "content-type": "application/octet-stream", ...headers },
        body: new Blob([new Uint8Array(bytes)]),
      }),
    );

  it("refuses a cookie, no credential and a token that is not a device session's", async () => {
    expect((await upload({})).status).toBe(401);
    expect((await upload({ cookie: admin.cookie })).status).toBe(401);
    expect((await upload({ authorization: "Bearer cos_at_madeupmadeupmadeup" })).status).toBe(401);
    // An MCP client's OAuth token is not a device session: refused the same way.
    expect((await upload({ authorization: "Bearer mcp_token_of_a_connected_app" })).status).toBe(
      401,
    );
    const ok = await upload({ authorization: `Bearer ${accessToken}` });
    expect(ok.status).toBe(200);
    expect(await auditOf("media.upload")).toEqual({ actor: "human", user_id: admin.id });
  });

  it("media.upload and record.import are a person's: no MCP, assistant or automation caller", async () => {
    for (const actor of ["mcp", "assistant", "automation"] as const) {
      const ctx = staff({
        actor,
        origin: { surface: actor === "automation" ? "automation" : actor, sessionId: unique("s") },
        media: mediaStoreFor(hostEnv as never),
        upload: { bytes: png(9, 9, 77) },
      } as never);
      await expect(invoke("media.upload", { name: "x.png" }, ctx), actor).rejects.toMatchObject({
        code: "forbidden",
      });
      await expect(
        invoke(
          "record.import",
          { object: POST, records: [{ key: "k", values: { title: "x" } }] },
          ctx,
        ),
        actor,
      ).rejects.toMatchObject({ code: "forbidden" });
    }
  });

  it("the run's session is signed out on the host when it ends", async () => {
    // The device session a staff sign-in answers with (staff-app.test.ts signs in by code and in
    // the browser on these same routes), held in memory as the command holds it.
    let tokens: Tokens | null = await issueDeviceSession(
      db,
      { audience: "staff", subjectId: admin.id },
      "cos content import",
      new Date(),
    );
    const store = {
      load: async () => tokens,
      save: async (t: Tokens | null) => {
        tokens = t;
      },
    };
    const session = tokenSession({ baseUrl: ORIGIN, store, fetch: fetcher as never });
    const held = (tokens as Tokens).accessToken;
    const host = sessionHost(ORIGIN, () => session.headers(), fetcher);
    await expect(host.call("media.findByHash", { sha256: ["0".repeat(64)] })).resolves.toEqual({
      items: [],
    });
    await session.signOut();
    expect(tokens).toBeNull();
    expect((await upload({ authorization: `Bearer ${held}` })).status).toBe(401);
  });
});
