// Stage 66 step 5 (ADR 0617): on a host that serves many clients one Stream account holds every
// client's videos, so each client's video host stamps the client as the creator of what it
// uploads or copies, and refuses every call for a video another creator made: its details,
// securing it, its captions, deleting it, and a playback token. Against the fake Stream (one
// account, two clients' hosts over it), through the media operations with each client's own
// database, and the real provider's requests.

import { env } from "cloudflare:workers";
import { AsyncLocalStorage } from "node:async_hooks";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type ActingUser,
  type ClientScope,
  clientScopesHeld,
  createFakeStream,
  creatorCheckedVideoHost,
  currentClientId,
  invoke,
  OperationError,
  provideClientScope,
  runInClientScope,
  setVideoHostResolver,
  streamApiProvider,
  type VideoHost,
} from "../src/index.ts";
import { context, createUser } from "./helpers.ts";
import {
  asOtherClient,
  OTHER_CLIENT,
  otherClient,
  otherDatabase,
  otherDb,
} from "./other-client.ts";

const BASE = "https://host.test/api/v1/media/fake-stream";
const account = createFakeStream({ baseUrl: BASE, autoReady: false });
const OWN: ClientScope = { database: env.DB, client: "own-client" };
const asOwnClient = <T>(run: () => T) => runInClientScope(OWN, run);
const hosts: Record<string, VideoHost> = {
  "own-client": creatorCheckedVideoHost(account, "own-client"),
  "other-client": creatorCheckedVideoHost(account, "other-client"),
};

/** The refusal a call for another client's video gets: the one not-found. */
async function refusedAsAnothers(promise: Promise<unknown>): Promise<void> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(OperationError);
  expect((error as OperationError).code).toBe("not_found");
}

/** A video uploaded through `host` and finished by the fake: its id. */
async function uploaded(host: VideoHost): Promise<string> {
  const upload = await host.provider.createUpload({
    name: "class.mp4",
    bytes: 2048,
    maxDurationSeconds: 60,
    allowedOrigins: [],
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
  });
  account.fake.finish(upload.uid);
  return upload.uid;
}

describe("a client's video host on a shared account", () => {
  it("stamps every upload and copy with its client as the creator", async () => {
    const uid = await uploaded(hosts["own-client"] as VideoHost);
    expect(account.fake.video(uid)?.creator).toBe("own-client");
    const { uid: copied } = await (hosts["other-client"] as VideoHost).provider.copyFromUrl({
      url: "https://example.com/v.mp4",
      name: "copied.mp4",
      allowedOrigins: [],
    });
    expect(account.fake.video(copied)?.creator).toBe("other-client");
  });

  it("refuses every call for another client's video, and the video is untouched", async () => {
    const own = hosts["own-client"] as VideoHost;
    const other = hosts["other-client"] as VideoHost;
    const uid = await uploaded(own);
    await refusedAsAnothers(other.provider.details(uid));
    await refusedAsAnothers(other.provider.secure(uid, ["evil.test"]));
    await refusedAsAnothers(
      other.provider.uploadCaption(uid, "en", new TextEncoder().encode("WEBVTT\n")),
    );
    await refusedAsAnothers(other.provider.generateCaption(uid, "en"));
    await refusedAsAnothers(other.provider.deleteCaption(uid, "en"));
    await refusedAsAnothers(other.provider.listCaptions(uid));
    await refusedAsAnothers(other.provider.delete(uid));
    await refusedAsAnothers(other.signer.sign({ uid, expiresAt: new Date(Date.now() + 60_000) }));
    expect(account.fake.video(uid)).toBeTruthy();
    expect(account.fake.video(uid)?.allowedOrigins).toEqual([]);
    // Its own client's calls all go through.
    expect((await own.provider.details(uid))?.creator).toBe("own-client");
    await own.provider.uploadCaption(uid, "en", new TextEncoder().encode("WEBVTT\n"));
    expect(await own.provider.listCaptions(uid)).toHaveLength(1);
    expect(await own.signer.sign({ uid, expiresAt: new Date(Date.now() + 60_000) })).toBeTruthy();
    await own.provider.delete(uid);
    expect(account.fake.video(uid)).toBeUndefined();
  });

  it("checks a video before its first token, then signs with no call", async () => {
    const own = hosts["own-client"] as VideoHost;
    const uid = await uploaded(own);
    const before = account.fake.calls.length;
    await own.signer.sign({ uid, expiresAt: new Date(Date.now() + 60_000) });
    expect(account.fake.calls.slice(before).map((c) => c.method)).toEqual(["details"]);
    const again = account.fake.calls.length;
    await own.signer.sign({ uid, expiresAt: new Date(Date.now() + 60_000) });
    expect(account.fake.calls.length).toBe(again);
  });

  it("refuses a video no client created, for every client", async () => {
    const upload = await account.provider.createUpload({
      name: "nobody.mp4",
      bytes: 10,
      maxDurationSeconds: 60,
      allowedOrigins: [],
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    });
    for (const host of Object.values(hosts)) {
      await refusedAsAnothers(host.provider.details(upload.uid));
    }
  });
});

describe.skipIf(clientScopesHeld())(
  "through the media operations, each client on its own database",
  () => {
    let ownAdmin: ActingUser;
    let otherAdmin: ActingUser;
    beforeAll(async () => {
      otherAdmin = await otherClient();
      ownAdmin = await createUser("admin");
      provideClientScope(new AsyncLocalStorage<ClientScope>(), { unscoped: "refuse" });
      setVideoHostResolver(() => hosts[currentClientId() ?? ""]);
    });
    afterAll(() => {
      setVideoHostResolver(null);
      provideClientScope(null);
    });

    it("does not play, refresh or caption a video of one client's that reached another's database", async () => {
      const asked = await asOwnClient(() =>
        invoke("media.videoUpload", { name: "intro.mp4", bytes: 4096 }, context(ownAdmin)),
      );
      const id = asked.item.id;
      const row = await env.DB.prepare("SELECT * FROM core_media WHERE id = ?")
        .bind(id)
        .first<Record<string, unknown>>();
      const uid = String(row?.stream_uid);
      expect(account.fake.video(uid)?.creator).toBe("own-client");
      account.fake.finish(uid);
      const refreshed = await asOwnClient(() =>
        invoke("media.videoRefresh", { id }, context(ownAdmin)),
      );
      expect(refreshed.state).toBe("ready");
      const played = await asOwnClient(() => invoke("media.play", { id }, context(ownAdmin)));
      expect(played.token).toBeTruthy();

      // The same row in the other client's database: its video host refuses the video.
      const ready = await env.DB.prepare("SELECT * FROM core_media WHERE id = ?")
        .bind(id)
        .first<Record<string, unknown>>();
      const columns = Object.keys(ready ?? {});
      await otherDatabase
        .prepare(
          `INSERT INTO core_media (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
        )
        .bind(...columns.map((c) => (ready as Record<string, unknown>)[c] ?? null))
        .run();
      const as = {
        actor: "human" as const,
        user: otherAdmin,
        origin: { surface: "ui" as const },
        db: otherDb,
      };
      await refusedAsAnothers(asOtherClient(() => invoke("media.play", { id }, as)));
      await refusedAsAnothers(asOtherClient(() => invoke("media.videoRefresh", { id }, as)));
      expect(account.fake.video(uid)?.creator).toBe("own-client");
      expect(OTHER_CLIENT.client).toBe("other-client");
    });
  },
);

describe("the real provider names the creator", () => {
  it("in a basic upload, a resumable one and a copy, and reads it back", async () => {
    const sent: { url: string; headers: Headers; body: string }[] = [];
    const provider = streamApiProvider({
      accountId: "acct",
      apiToken: "token",
      apiBase: "https://api.test/client/v4",
      fetch: async (input, init) => {
        const url = String(input);
        sent.push({ url, headers: new Headers(init?.headers), body: String(init?.body ?? "") });
        if (url.endsWith("?direct_user=true")) {
          return new Response(null, {
            status: 201,
            headers: { location: "https://upload.test/x", "stream-media-id": "tus-uid" },
          });
        }
        if (url.endsWith("/direct_upload")) {
          return Response.json({
            success: true,
            result: { uid: "u1", uploadURL: "https://u.test" },
          });
        }
        if (url.endsWith("/copy")) return Response.json({ success: true, result: { uid: "c1" } });
        return Response.json({
          success: true,
          result: { uid: "u1", status: { state: "ready" }, creator: "own-client" },
        });
      },
    });
    const input = {
      name: "a.mp4",
      maxDurationSeconds: 60,
      allowedOrigins: [],
      expiresAt: new Date().toISOString(),
      creator: "own-client",
    };
    await provider.createUpload({ ...input, bytes: 10 });
    await provider.createUpload({ ...input, bytes: 300 * 1000 * 1000 });
    await provider.copyFromUrl({
      url: "https://e.test/v.mp4",
      name: "v",
      allowedOrigins: [],
      creator: "own-client",
    });
    expect(JSON.parse(sent[0]?.body ?? "{}").creator).toBe("own-client");
    expect(sent[1]?.headers.get("upload-creator")).toBe("own-client");
    expect(JSON.parse(sent[2]?.body ?? "{}").creator).toBe("own-client");
    expect((await provider.details("u1"))?.creator).toBe("own-client");
    // A single client names none: the requests are as they were.
    await provider.createUpload({ ...input, creator: undefined, bytes: 10 } as never);
    expect("creator" in JSON.parse(sent.at(-1)?.body ?? "{}")).toBe(false);
  });
});
