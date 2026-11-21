// Stage 42, steps 1 and 2 (ADRs 0475 and 0476): videos in Cloudflare Stream and signed playback,
// against the fake Stream (records/stream-fake.ts), which verifies tokens as Stream does.
//
// Criterion 2: a staff person uploads through a direct upload address; the item is ready only
// once Stream says so; a record naming a video that is not ready is refused; an MCP client, the
// assistant and an automation cannot ask for an upload. Criterion 3 (the part the host holds): a
// token plays and stops at its expiry; the public and a made-up id get the one not-found; the id
// with no token does not play; a public trailer plays for anyone; no token allows a download.
// Who holds access to a course's lessons is visibility/access.ts's (access.test.ts).
import { env } from "cloudflare:workers";
import { MEDIA_FILE_MAX_BYTES } from "@composable-os/sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type ActingUser,
  coreInvoker,
  createFakeStream,
  drainAllBlobDeletions,
  handleMedia,
  invoke,
  type MediaStore,
  setVideoHost,
  streamApiProvider,
  streamHostnames,
  streamPlayback,
  streamSigner,
  tokenClaims,
} from "../src/index.ts";
import { call, outside, PUBLIC } from "./customer-fixtures.ts";
import { extId, manifest, reconcile } from "./extension-helpers.ts";
import { context, createUser, db } from "./helpers.ts";

const BASE = "https://host.test/api/v1/media/fake-stream";
let clock = Date.now();
const stream = createFakeStream({ baseUrl: BASE, autoReady: false, now: () => clock });

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

const EXT = extId("vid");
const TALK = `${EXT}.talk`;
let admin: ActingUser;

const NOT_FOUND = {
  ok: false,
  error: { code: "not_found", message: "Not found", details: { object: "media" } },
};

async function attempt<T>(promise: Promise<T>) {
  try {
    return { ok: true as const, value: await promise };
  } catch (error) {
    const e = error as { toJSON?: () => Record<string, unknown> };
    return { ok: false as const, error: (e.toJSON ? e.toJSON() : e) as Record<string, unknown> };
  }
}

/** A staff person asks for an address and the browser sends the file there. */
async function uploadVideo(name = "lesson.mp4", bytes = 2048) {
  const asked = await invoke("media.videoUpload", { name, bytes }, context(admin));
  const upload = asked.upload;
  if (!upload) throw new Error("no address");
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(bytes)], { type: "video/mp4" }), name);
  const sent = await stream.fake.handle(new Request(upload.url, { method: "POST", body: form }));
  expect(sent.status).toBe(200);
  return asked;
}

async function readyVideo(name = "lesson.mp4") {
  const asked = await uploadVideo(name);
  const uid = String(stream.fake.calls.find((c) => c.method === "createUpload" && c.uid)?.uid);
  const row = await env.DB.prepare("SELECT stream_uid FROM core_media WHERE id = ?")
    .bind(asked.item.id)
    .first<{ stream_uid: string }>();
  expect(row?.stream_uid).toBeTruthy();
  stream.fake.finish(String(row?.stream_uid));
  void uid;
  const refreshed = await invoke("media.videoRefresh", { id: asked.item.id }, context(admin));
  expect(refreshed.state).toBe("ready");
  return { id: asked.item.id, uid: String(row?.stream_uid) };
}

const play = (id: string, who: "staff" | "public", extra: Record<string, unknown> = {}) =>
  who === "staff"
    ? attempt(invoke("media.play", { id, ...extra }, context(admin)))
    : call("media.play", { id, ...extra }, outside(PUBLIC));

const fetchFake = (url: string) => stream.fake.handle(new Request(url));

beforeAll(async () => {
  setVideoHost(stream);
  admin = await createUser("admin");
  await reconcile(
    manifest(EXT, {
      objects: {
        talk: {
          label: "Talk",
          plural: "Talks",
          titleField: "title",
          fields: {
            title: { type: "text", label: "Title", required: true },
            slug: { type: "slug", label: "Slug" },
            trailer: { type: "video", label: "Trailer" },
            recording: { type: "video", label: "Recording" },
          },
          publishable: { content: ["title", "trailer", "recording"], slug: "slug" },
          // The trailer is the public's; the full recording is staff's only.
          public: { read: ["title", "slug", "trailer"] },
        },
      },
    }),
  );
});

afterAll(() => setVideoHost(undefined));

describe("uploading a video (criterion 2)", () => {
  it("goes to a one-time direct upload address, never through the operation", async () => {
    const asked = await invoke(
      "media.videoUpload",
      { name: "intro.mp4", bytes: 4096 },
      context(admin),
    );
    expect(asked.item).toMatchObject({ kind: "video", state: "uploading", name: "intro.mp4" });
    expect(asked.upload).toMatchObject({ protocol: "post" });
    expect(asked.upload?.url.startsWith(`${BASE}/upload/`)).toBe(true);
    // Stream was asked for a video that requires a signed token, from the deployment's origins.
    const made = stream.fake.calls.filter((c) => c.method === "createUpload").at(-1);
    expect(made?.detail).toMatchObject({ bytes: 4096, allowedOrigins: ["host.test"] });
    const uid = String(made?.uid);
    expect(stream.fake.video(uid)?.requireSignedURLs).toBe(true);
    // The audit log holds the item, never the one-time address.
    const audit = await env.DB.prepare(
      "SELECT result FROM core_audit WHERE operation = 'media.videoUpload' ORDER BY at DESC LIMIT 1",
    ).first<{ result: string }>();
    expect(audit?.result).toContain(asked.item.id);
    expect(audit?.result ?? "").not.toContain("/upload/");

    // The browser sends it; the address is one-time.
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(4096)]), "intro.mp4");
    const url = String(asked.upload?.url);
    expect(
      (await stream.fake.handle(new Request(url, { method: "POST", body: form }))).status,
    ).toBe(200);
    const again = new FormData();
    again.append("file", new Blob([new Uint8Array(10)]), "other.mp4");
    expect(
      (await stream.fake.handle(new Request(url, { method: "POST", body: again }))).status,
    ).toBe(404);

    // Processing until Stream says ready.
    const processing = await invoke("media.videoRefresh", { id: asked.item.id }, context(admin));
    expect(processing.state).toBe("processing");
    stream.fake.finish(uid);
    const ready = await invoke("media.videoRefresh", { id: asked.item.id }, context(admin));
    expect(ready).toMatchObject({ state: "ready", duration: 61.5, width: 1920, height: 1080 });
  });

  it("a large file is a resumable (tus) upload, taken chunk by chunk at the right offsets", async () => {
    const bytes = 210_000_000;
    const asked = await invoke("media.videoUpload", { name: "long.mp4", bytes }, context(admin));
    expect(asked.upload?.protocol).toBe("tus");
    const url = String(asked.upload?.url);
    const head = await stream.fake.handle(new Request(url, { method: "HEAD" }));
    expect(head.headers.get("upload-offset")).toBe("0");
    const patch = (offset: number, size: number) =>
      stream.fake.handle(
        new Request(url, {
          method: "PATCH",
          headers: { "Tus-Resumable": "1.0.0", "Upload-Offset": String(offset) },
          body: new Uint8Array(size),
        }),
      );
    // A chunk at the wrong offset is refused; the right one is taken and the offset moves on.
    expect((await patch(5, 10)).status).toBe(409);
    const taken = await patch(0, 1000);
    expect(taken.status).toBe(204);
    expect(taken.headers.get("upload-offset")).toBe("1000");
    expect((await patch(0, 10)).status).toBe(409);
  });

  it("a record cannot name a video that is not ready, a picture where a video goes, or a made-up one", async () => {
    const pending = await uploadVideo("pending.mp4");
    const refused = await attempt(
      invoke(
        "record.create",
        { object: TALK, values: { title: "Too soon", trailer: { media: pending.item.id } } },
        context(admin),
      ),
    );
    expect(refused).toMatchObject({
      ok: false,
      error: { code: "invalid_input", details: { reason: "video_not_ready" } },
    });
    const picture = await invoke(
      "media.upload",
      { name: "p.png" },
      context(admin, {
        media: store,
        upload: {
          bytes: new Uint8Array([
            0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1,
            0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0,
          ]),
        },
      } as never),
    );
    const wrongKind = await attempt(
      invoke(
        "record.create",
        { object: TALK, values: { title: "Wrong", trailer: { media: picture.id } } },
        context(admin),
      ),
    );
    expect(wrongKind).toMatchObject({ ok: false, error: { details: { reason: "media_kind" } } });
    const ghost = await attempt(
      invoke(
        "record.create",
        {
          object: TALK,
          values: { title: "Ghost", trailer: { media: "med_01NOSUCHVIDEO00000000000" } },
        },
        context(admin),
      ),
    );
    expect(ghost).toMatchObject({ ok: false, error: { code: "invalid_input" } });
  });

  it("an MCP client, the assistant and an automation cannot ask for an upload", async () => {
    for (const actor of ["mcp", "assistant", "automation"] as const) {
      const refused = await attempt(
        invoke(
          "media.videoUpload",
          { name: "x.mp4", bytes: 10 },
          context(admin, { actor } as never),
        ),
      );
      expect(refused, actor).toMatchObject({ ok: false });
    }
    // And no outsider: it is not open to them at all.
    const outsider = await call("media.videoUpload", { name: "x.mp4", bytes: 10 }, outside(PUBLIC));
    expect(outsider).toMatchObject({ ok: false, error: { code: "unknown_operation" } });
  });

  it("captions are WebVTT, at most 10 MB; generated ones are off until an admin turns them on", async () => {
    const { id, uid } = await readyVideo("captioned.mp4");
    const vtt = new TextEncoder().encode("WEBVTT\n\n00:00.000 --> 00:01.000\nHello\n");
    const route = (body: Uint8Array, query: string) =>
      handleMedia(
        new Request(`https://host.test/api/media/${id}/captions?${query}`, {
          method: "POST",
          body,
        }),
        { invoker: coreInvoker, context: async () => context(admin), media: store, uploads: true },
      );
    const added = await route(vtt, "language=en&label=English");
    expect(added.status).toBe(200);
    expect(stream.fake.video(uid)?.captions.get("en")).toBeTruthy();
    const srt = await route(
      new TextEncoder().encode("1\n00:00:00,000 --> 00:00:01,000\nHi\n"),
      "language=fr",
    );
    expect(srt.status).toBe(400);
    // Over the client-app binding (no uploads) there is no caption route.
    const bound = await handleMedia(
      new Request(`https://host.test/api/media/${id}/captions?language=de`, {
        method: "POST",
        body: vtt,
      }),
      { invoker: coreInvoker, context: async () => context(admin), media: store, uploads: false },
    );
    expect(bound.status).toBe(404);

    const off = await attempt(
      invoke("media.captionGenerate", { id, language: "es" }, context(admin)),
    );
    expect(off).toMatchObject({
      ok: false,
      error: { details: { reason: "generated_captions_off" } },
    });
    // Only a person turns it on.
    const byAi = await attempt(
      invoke(
        "media.settings.update",
        { generatedCaptions: true },
        context(admin, { actor: "assistant" } as never),
      ),
    );
    expect(byAi).toMatchObject({ ok: false });
    await invoke("media.settings.update", { generatedCaptions: true }, context(admin));
    const generated = await invoke("media.captionGenerate", { id, language: "es" }, context(admin));
    expect(generated).toMatchObject({ language: "es", generated: true, state: "processing" });
    await invoke("media.settings.update", { generatedCaptions: false }, context(admin));
    const played = await invoke("media.play", { id }, context(admin));
    // Only ready tracks go to the player.
    expect(played.captions).toEqual([{ language: "en", label: "English" }]);
  });
});

describe("downloadable files (step 1)", () => {
  it("a PDF is a file, kept in R2 and served as a download by the picture's rule", async () => {
    const pdf = new TextEncoder().encode("%PDF-1.7\n% a worksheet\n");
    const file = await invoke(
      "media.upload",
      { name: "worksheet.pdf" },
      context(admin, { media: store, upload: { bytes: pdf } } as never),
    );
    expect(file).toMatchObject({ kind: "file", type: "application/pdf", width: null });
    const served = await handleMedia(new Request(`https://host.test/api/media/${file.id}`), {
      invoker: coreInvoker,
      context: async () => context(admin),
      media: store,
      uploads: true,
    });
    expect(served.status).toBe(200);
    expect(served.headers.get("content-disposition")).toBe("attachment");
    await served.arrayBuffer();
    // The public is served it only as a picture would be: here no published record shows it.
    expect(await call("media.serve", { id: file.id }, outside(PUBLIC))).toEqual(NOT_FOUND);
    // Past a file's limit, refused from the header before the body is read.
    const tooBig = await handleMedia(
      new Request("https://host.test/api/media?name=big.pdf", {
        method: "POST",
        body: pdf,
        headers: { "content-length": String(MEDIA_FILE_MAX_BYTES + 1) },
      }),
      { invoker: coreInvoker, context: async () => context(admin), media: store, uploads: true },
    );
    expect(tooBig.status).toBe(413);
  });
});

describe("signed playback (criterion 3)", () => {
  it("staff get a token for any ready video; it plays, for that video only, and stops at its expiry", async () => {
    const { id, uid } = await readyVideo("staff.mp4");
    const played = await invoke("media.play", { id }, context(admin));
    const claims = tokenClaims(played.token);
    expect(claims).toMatchObject({ sub: uid });
    expect(Number(claims?.exp) - Math.floor(Date.now() / 1000)).toBeLessThanOrEqual(3600);
    expect(claims).not.toHaveProperty("downloadable");
    expect(played.hls).toBe(`${BASE}/${played.token}/manifest/video.m3u8`);
    expect((await fetchFake(played.hls)).status).toBe(200);
    // The id with no token does not play; nor does a download, with or without a token.
    expect((await fetchFake(`${BASE}/${uid}/manifest/video.m3u8`)).status).toBe(401);
    expect((await fetchFake(`${BASE}/${played.token}/downloads/default.mp4`)).status).toBe(401);
    // A token changed to name another video no longer verifies.
    const other = await readyVideo("other.mp4");
    const [h, , s] = played.token.split(".");
    const forged = `${h}.${btoa(JSON.stringify({ ...claims, sub: other.uid })).replace(/=+$/, "")}.${s}`;
    expect((await fetchFake(`${BASE}/${forged}/manifest/video.m3u8`)).status).toBe(401);
    // A short token, then past its expiry.
    const short = await invoke("media.play", { id, seconds: 60 }, context(admin));
    expect((await fetchFake(short.hls)).status).toBe(200);
    clock += 61_000;
    expect((await fetchFake(short.hls)).status).toBe(401);
    clock = Date.now();
    // No token lives past an hour, whatever is asked.
    const long = await attempt(invoke("media.play", { id, seconds: 7200 }, context(admin)));
    expect(long.ok).toBe(false);
  });

  it("the public: a published trailer plays for anyone; a staff-only field's video, a draft's and a made-up id are the one not-found", async () => {
    const trailer = await readyVideo("trailer.mp4");
    const recording = await readyVideo("recording.mp4");
    const talk = await invoke(
      "record.create",
      {
        object: TALK,
        values: {
          title: "A talk",
          trailer: { media: trailer.id },
          recording: { media: recording.id },
        },
      },
      context(admin),
    );
    expect(await play(trailer.id, "public")).toEqual(NOT_FOUND); // a draft's
    await invoke("record.publish", { object: TALK, id: talk.id }, context(admin));
    const open = await play(trailer.id, "public");
    expect(open).toMatchObject({ ok: true });
    const token = (open as { value: { hls: string } }).value.hls;
    expect((await fetchFake(token)).status).toBe(200);
    // In a field the public does not read: not theirs.
    expect(await play(recording.id, "public")).toEqual(NOT_FOUND);
    expect(await play("med_01NOSUCHVIDEO00000000000", "public")).toEqual(NOT_FOUND);
    // A picture is not played; a video is not served as a picture.
    expect(await call("media.serve", { id: trailer.id }, outside(PUBLIC))).toEqual(NOT_FOUND);
    // Unpublished, it stops.
    await invoke("record.unpublish", { object: TALK, id: talk.id }, context(admin));
    expect(await play(trailer.id, "public")).toEqual(NOT_FOUND);
  });

  it("a video still processing, or one that failed, is not played even by staff", async () => {
    const pending = await uploadVideo("pending-play.mp4");
    expect((await play(pending.item.id, "staff")).ok).toBe(false);
    const failed = await uploadVideo("broken.mp4");
    const row = await env.DB.prepare("SELECT stream_uid FROM core_media WHERE id = ?")
      .bind(failed.item.id)
      .first<{ stream_uid: string }>();
    stream.fake.finish(String(row?.stream_uid), { failed: "ERR_MALFORMED_VIDEO" });
    const refreshed = await invoke("media.videoRefresh", { id: failed.item.id }, context(admin));
    expect(refreshed).toMatchObject({ state: "failed", stateReason: "ERR_MALFORMED_VIDEO" });
    expect((await play(failed.item.id, "staff")).ok).toBe(false);
  });

  it("a video made playable without a token in Stream is made to need one again", async () => {
    const { id, uid } = await readyVideo("loosened.mp4");
    const video = stream.fake.video(uid) as { requireSignedURLs: boolean };
    video.requireSignedURLs = false;
    await invoke("media.videoRefresh", { id }, context(admin));
    expect(stream.fake.video(uid)?.requireSignedURLs).toBe(true);
  });

  it("purging a video deletes it from Stream", async () => {
    const { id, uid } = await readyVideo("purged.mp4");
    await invoke("media.delete", { id }, context(admin));
    const later = new Date(Date.now() + 31 * 86_400_000);
    await invoke(
      "trash.purge",
      { limit: 100 },
      context(admin, {
        actor: "automation",
        origin: { surface: "system", automationId: "trash.purge" },
        clock: () => later,
      } as never),
    );
    const queued = await env.DB.prepare("SELECT key FROM core_blob_deletion WHERE key = ?")
      .bind(`stream/${uid}`)
      .first();
    expect(queued).not.toBeNull();
    expect(stream.fake.video(uid)).toBeTruthy();
    await drainAllBlobDeletions(db.query, {
      get: async () => null,
      put: async () => {},
      delete: store.delete,
    });
    expect(stream.fake.video(uid)).toBeUndefined();
    const left = await env.DB.prepare("SELECT key FROM core_blob_deletion WHERE key = ?")
      .bind(`stream/${uid}`)
      .first();
    expect(left).toBeNull();
  });
});

describe("the real provider's requests and tokens", () => {
  it("asks Stream's REST API for a signed-only video and signs RS256 tokens Stream can verify", async () => {
    const sent: { url: string; init: RequestInit }[] = [];
    const provider = streamApiProvider({
      accountId: "acct",
      apiToken: "token",
      apiBase: "https://api.test/client/v4",
      fetch: (async (url: string, init: RequestInit) => {
        sent.push({ url, init });
        if (String(url).includes("direct_user=true")) {
          return new Response(null, {
            status: 201,
            headers: { location: "https://upload.test/tus/abc", "stream-media-id": "abc" },
          });
        }
        return Response.json({
          success: true,
          result: { uid: "abc", uploadURL: "https://upload.test/abc" },
        });
      }) as unknown as typeof fetch,
    });
    const small = await provider.createUpload({
      name: "a.mp4",
      bytes: 100,
      maxDurationSeconds: 60,
      allowedOrigins: ["shop.example"],
      expiresAt: "2026-11-22T10:00:00.000Z",
    });
    expect(small).toMatchObject({ uid: "abc", protocol: "post" });
    expect(sent[0]?.url).toBe("https://api.test/client/v4/accounts/acct/stream/direct_upload");
    expect(JSON.parse(String(sent[0]?.init.body))).toMatchObject({
      requireSignedURLs: true,
      allowedOrigins: ["shop.example"],
    });
    const large = await provider.createUpload({
      name: "b.mp4",
      bytes: 300_000_000,
      maxDurationSeconds: 60,
      allowedOrigins: [],
      expiresAt: "2026-11-22T10:00:00.000Z",
    });
    expect(large).toMatchObject({
      uid: "abc",
      protocol: "tus",
      url: "https://upload.test/tus/abc",
    });
    const headers = sent[1]?.init.headers as Record<string, string>;
    expect(headers["Upload-Metadata"]).toContain("requiresignedurls");
    expect(headers["Upload-Length"]).toBe("300000000");

    // A key pair as Stream would give one: the signed token verifies with its public half.
    const pair = (await crypto.subtle.generateKey(
      {
        name: "RSASSA-PKCS1-v1_5",
        hash: "SHA-256",
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
      },
      true,
      ["sign", "verify"],
    )) as CryptoKeyPair;
    const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
    const signer = streamSigner("kid1", btoa(JSON.stringify(jwk)));
    const token = await signer.sign({ uid: "abc", expiresAt: new Date(Date.now() + 1000_000) });
    const [h, p, s] = token.split(".");
    expect(JSON.parse(atob(String(h).replace(/-/g, "+").replace(/_/g, "/")))).toEqual({
      alg: "RS256",
      kid: "kid1",
    });
    expect(tokenClaims(token)).toMatchObject({ sub: "abc", kid: "kid1" });
    const raw = (t: string) =>
      Uint8Array.from(
        atob(t.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (t.length % 4)) % 4)),
        (c) => c.charCodeAt(0),
      );
    const verified = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      pair.publicKey,
      raw(String(s)),
      new TextEncoder().encode(`${h}.${p}`),
    );
    expect(verified).toBe(true);
    expect(streamPlayback("xyz", token).hls).toBe(
      `https://customer-xyz.cloudflarestream.com/${token}/manifest/video.m3u8`,
    );
    expect(
      streamHostnames(["https://a.example:8443", "b.example,https://c.example/path", undefined]),
    ).toEqual(["a.example", "b.example", "c.example"]);
  });
});
