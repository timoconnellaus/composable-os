// Issue #181: a company's own site shows a post's pictures. `company-web` is the client template's
// host module in a Worker of its own, bound to cos-app's real ClientApp entrypoint
// (test/fixtures/company-web); the test is the browser, talking only to https://shop.test. A
// published post's picture comes back through the template's media route; a draft's is not found;
// nothing but the id, the width and the customer's cookie crosses to the host.
import { env } from "cloudflare:workers";
import {
  type ActingUser,
  applyPlan,
  type InvocationContext,
  invoke,
  planReconcile,
  refreshSchemaRegistry,
} from "@composable-os/core";
import { createCrmDb } from "@composable-os/db";
import { manifestSchema } from "@composable-os/sdk";
import { beforeAll, describe, expect, it } from "vitest";
import { mediaStoreFor } from "../src/server/media.ts";
import { boundTestEnv, WEB_ORIGIN } from "./bound-env.ts";
import { signUp, unique } from "./mcp-helpers.ts";

const hostEnv = boundTestEnv(env);
const db = createCrmDb(env.DB);
const EXT = `web${Date.now().toString(36)}`;
const POST = `${EXT}.post`;
let admin: ActingUser;

/**
 * A PNG header of the given size. Each call's bytes are its own: the library keeps one item per
 * file (ADR 0470), and the two pictures here must be two items.
 */
let made = 0;
function png(width: number, height: number): Uint8Array {
  made += 1;
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82]);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  view.setUint32(29, made);
  return bytes;
}

const staff = (extra: Partial<InvocationContext> = {}): InvocationContext => ({
  actor: "human",
  user: admin,
  origin: { surface: "ui" },
  db,
  ...extra,
});

const picture = async () =>
  invoke(
    "media.upload",
    { name: "hall.png", alt: "The hall" },
    staff({ media: mediaStoreFor(hostEnv as never), upload: { bytes: png(64, 48) } }),
  );

const doc = (media: string) => ({
  blocks: [
    { type: "paragraph", content: [{ type: "text", text: "The hall" }] },
    { type: "image", media, alt: "The hall, full" },
  ],
});

const browse = (path: string, init: RequestInit = {}) =>
  env.COMPANY_WEB.fetch(`${WEB_ORIGIN}${path}`, init);

beforeAll(async () => {
  const user = await signUp(hostEnv as never, "admin");
  admin = { id: user.id, email: user.email, name: "Admin", role: "admin" };
  const plan = await planReconcile(
    db.query,
    manifestSchema.parse({
      id: EXT,
      version: "1.0.0",
      contractVersion: 1,
      objects: {
        post: {
          label: "Post",
          plural: "Posts",
          titleField: "title",
          fields: {
            title: { type: "text", label: "Title", required: true },
            slug: { type: "slug", label: "Slug" },
            body: { type: "richText", label: "Body" },
          },
          publishable: { content: ["title", "body"], slug: "slug" },
          public: { read: ["title", "slug", "body"] },
        },
      },
    }),
    { now: new Date().toISOString() },
  );
  await applyPlan((statements) => db.batch(statements), plan);
  await refreshSchemaRegistry(db.query);
}, 60_000);

describe("a company's site shows a post's pictures through the template's media route", () => {
  it("a published post's picture is served; a draft's is not found", async () => {
    const shown = await picture();
    const hidden = await picture();
    const published = await invoke(
      "record.create",
      { object: POST, values: { title: unique("Open"), body: doc(shown.id) } },
      staff(),
    );
    await invoke("record.publish", { object: POST, id: published.id }, staff());
    await invoke(
      "record.create",
      { object: POST, values: { title: unique("Draft"), body: doc(hidden.id) } },
      staff(),
    );

    const ok = await browse(`/api/media/${shown.id}?w=640`);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toBe("image/png");
    expect(ok.headers.get("cache-control")).toMatch(/^public, max-age=\d+$/);
    expect(ok.headers.get("x-content-type-options")).toBe("nosniff");
    expect(ok.headers.getSetCookie()).toEqual([]);
    expect((await ok.arrayBuffer()).byteLength).toBe(33);

    const draft = await browse(`/api/media/${hidden.id}`);
    expect(draft.status).toBe(404);
    expect(await draft.json()).toMatchObject({
      error: { code: "not_found", message: "Not found" },
    });
    // A made-up id answers the same.
    expect((await browse("/api/media/med_01NOSUCHPICTURE0000000000")).status).toBe(404);
  });

  it("forwards GET only, the id and the width only, and never a token", async () => {
    const shown = await picture();
    const post = await invoke(
      "record.create",
      { object: POST, values: { title: unique("Gig"), body: doc(shown.id) } },
      staff(),
    );
    await invoke("record.publish", { object: POST, id: post.id }, staff());
    expect((await browse(`/api/media/${shown.id}`, { method: "POST", body: "x" })).status).toBe(
      405,
    );
    expect((await browse("/api/media/../op/me.get")).status).toBe(404);
    expect((await browse("/api/media/not-an-id")).status).toBe(404);
    // A bearer token the page sends is not passed on: the host would refuse it over the binding.
    const withToken = await browse(`/api/media/${shown.id}?w=320&evil=1`, {
      headers: { authorization: "Bearer cos_at_not-for-the-host", "x-forwarded-host": "evil" },
    });
    expect(withToken.status).toBe(200);
    await withToken.arrayBuffer();
    const head = await browse(`/api/media/${shown.id}`, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-type")).toBe("image/png");
  });
});

// Stage 44 step 5: the template's route for a signed agreement's PDF forwards GET only, an
// acceptance's id only, with the customer's cookie; whose it may be is the host's answer.
describe("a company's site forwards a signed agreement's PDF to the host", () => {
  it("passes GET for an acceptance's id, and refuses anything else before the host", async () => {
    const pdf = "/api/v1/agreements/acceptances";
    // The public, or an acceptance that is not theirs: the host's not found.
    const unknown = await browse(`${pdf}/aga_01NOSUCHACCEPTANCE000000.pdf`);
    expect(unknown.status).toBe(404);
    expect(unknown.headers.get("cache-control")).toBe("no-store");
    await unknown.arrayBuffer();
    expect((await browse(`${pdf}/aga_01X.pdf`, { method: "POST", body: "x" })).status).toBe(405);
    expect((await browse(`${pdf}/not-an-id.pdf`)).status).toBe(404);
    expect((await browse(`${pdf}/aga_01X`)).status).toBe(404);
    expect((await browse(`${pdf}/..%2F..%2Fop%2Fme.get.pdf`)).status).toBe(404);
  });
});
