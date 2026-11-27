// Stage 75 step 3 (criterion 7, as far as versions go; ADR 0961): two clients on one deployment of
// cos-app, each storing screen versions through the app's real entry (the upload route and the
// HTTP surface, with a staff device token). Client B cannot list, read or reference A's versions
// or files, including by naming a hash A stored; the same file stored by both is two objects, each
// in its own client's part of the files binding.
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { issueDeviceSession, newId, screenVersionFile } from "@composable-os/core";
import { createCrmDb } from "@composable-os/db";
import { environmentFor } from "@composable-os/db/client-environment";
import { setUpTwoClients, TWO_CLIENTS } from "@composable-os/db/testing/two-clients";
import { screenVersionManifestOf, sha256OfBytes } from "@composable-os/sdk";
import { beforeAll, describe, expect, it } from "vitest";
import { type AppParts, hostFetch } from "../src/server/entry.ts";
import { createAppHandler } from "../src/server/mcp/handler.ts";

const { a, b } = TWO_CLIENTS;
const host = env as unknown as Env;
const start = async () => new Response("start");
const parts: AppParts = { app: createAppHandler({ fetch: start }), start };

async function fetchAt(hostname: string, path: string, init: RequestInit = {}): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await hostFetch(
    new Request(`https://${hostname}${path}`, init),
    host,
    ctx,
    parts,
  );
  await waitOnExecutionContext(ctx);
  return response;
}

async function clientEnv(id: string): Promise<Env> {
  const found = await environmentFor(host, id);
  if (!found.served) throw new Error(`no environment for ${id}`);
  return found.env;
}

/** A staff admin of the client, signed in as `cos` signs in: a device token. */
async function staffToken(c: { id: string; hostname: string }): Promise<string> {
  const db = createCrmDb((await clientEnv(c.id)).DB);
  const userId = newId("user");
  const at = new Date().toISOString();
  await db.query
    .insertInto("core_user")
    .values({
      id: userId,
      name: `${c.id} admin`,
      email: `screens@${c.hostname}`,
      email_verified: 1,
      created_at: at,
      updated_at: at,
      role: "admin",
    } as never)
    .execute();
  const session = await issueDeviceSession(
    db,
    { audience: "staff", subjectId: userId },
    "cli",
    new Date(),
  );
  return session.accessToken;
}

async function op(hostname: string, token: string, name: string, input: unknown) {
  const response = await fetchAt(hostname, `/api/v1/op/${name}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": crypto.randomUUID(),
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(input),
  });
  return {
    status: response.status,
    body: (await response.json()) as {
      data?: Record<string, unknown>;
      error?: { code: string; details?: Record<string, unknown> };
    },
  };
}

function putFile(hostname: string, token: string, version: string, sha: string, bytes: Uint8Array) {
  return fetchAt(hostname, `/api/v1/screens/versions/${version}/files/${sha}`, {
    method: "PUT",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/octet-stream" },
    body: bytes as Uint8Array<ArrayBuffer>,
  });
}

const text = (s: string) => new TextEncoder().encode(s);
const files = [
  { path: "index.html", bytes: text("<!doctype html><p>A's screens</p>") },
  { path: "assets/app.js", bytes: text("console.log('A')") },
];
const manifest = () =>
  screenVersionManifestOf(files, { entry: "index.html", contract: "v1", build: { tool: "test" } });

let tokenA: string;
let tokenB: string;
let versionA: string;
let hashes: string[];

beforeAll(async () => {
  await setUpTwoClients(env);
  tokenA = await staffToken(a);
  tokenB = await staffToken(b);
  hashes = await Promise.all(files.map((f) => sha256OfBytes(f.bytes)));
  const begun = await op(a.hostname, tokenA, "screens.versionBegin", {});
  expect(begun.status, JSON.stringify(begun.body)).toBe(200);
  versionA = String(begun.body.data?.id);
  for (const [i, f] of files.entries()) {
    const put = await putFile(a.hostname, tokenA, versionA, hashes[i] as string, f.bytes);
    expect(put.status, await put.clone().text()).toBe(200);
  }
  const sealed = await op(a.hostname, tokenA, "screens.versionSeal", {
    version: versionA,
    manifest: await manifest(),
  });
  expect(sealed.status, JSON.stringify(sealed.body)).toBe(200);
});

describe("one client's screen versions, out of another's reach (criterion 7)", () => {
  it("are stored in A's database and A's part of the files binding", async () => {
    const aEnv = await clientEnv(a.id);
    const file = await screenVersionFile(createCrmDb(aEnv.DB).query, versionA, "index.html");
    expect(file).not.toBeNull();
    expect(await (await aEnv.BLOBS.get(file?.objectKey ?? ""))?.text()).toContain("A's screens");
    // The same key in B's part holds nothing.
    const bEnv = await clientEnv(b.id);
    expect(await bEnv.BLOBS.get(file?.objectKey ?? "")).toBeNull();
    // And on the bucket itself, it is under A's prefix.
    const raw = (host as unknown as { BLOBS: R2Bucket }).BLOBS;
    const listed = await raw.list({ prefix: `clients/${a.id}/screens/` });
    expect(listed.objects.length).toBeGreaterThanOrEqual(2);
    expect((await raw.list({ prefix: `clients/${b.id}/screens/` })).objects).toHaveLength(0);
  });

  it("are not listed or read at B's address", async () => {
    const listed = await op(b.hostname, tokenB, "screens.versionList", {});
    expect(listed.status).toBe(200);
    expect(JSON.stringify(listed.body)).not.toContain(versionA);
    const got = await op(b.hostname, tokenB, "screens.versionGet", { version: versionA });
    expect(got.body.error?.code).toBe("not_found");
    const bEnv = await clientEnv(b.id);
    expect(await screenVersionFile(createCrmDb(bEnv.DB).query, versionA, "index.html")).toBeNull();
  });

  it("cannot be referenced by B, even by naming the hashes A stored", async () => {
    const begun = await op(b.hostname, tokenB, "screens.versionBegin", { sha256: hashes });
    expect(begun.status).toBe(200);
    expect(begun.body.data?.held).toEqual([]);
    const versionB = String(begun.body.data?.id);
    const sealed = await op(b.hostname, tokenB, "screens.versionSeal", {
      version: versionB,
      manifest: await manifest(),
    });
    expect(sealed.body.error?.details?.reason).toBe("missing_files");
    // B sends the same bytes: stored again, in B's own part.
    for (const [i, f] of files.entries()) {
      const put = await putFile(b.hostname, tokenB, versionB, hashes[i] as string, f.bytes);
      expect(put.status).toBe(200);
      expect(((await put.json()) as { data: { stored: boolean } }).data.stored).toBe(true);
    }
    const raw = (host as unknown as { BLOBS: R2Bucket }).BLOBS;
    expect((await raw.list({ prefix: `clients/${b.id}/screens/` })).objects).toHaveLength(2);
  });

  it("cannot be written to by B, by its id or with A's token at B's address", async () => {
    const put = await putFile(
      b.hostname,
      tokenB,
      versionA,
      hashes[0] as string,
      files[0]?.bytes as Uint8Array,
    );
    expect(put.status).toBe(404);
    // A's token at B's address is no one's there.
    const crossed = await op(b.hostname, tokenA, "screens.versionList", {});
    expect(crossed.status).toBe(401);
    const crossedPut = await putFile(
      b.hostname,
      tokenA,
      versionA,
      hashes[0] as string,
      files[0]?.bytes as Uint8Array,
    );
    expect(crossedPut.status).toBe(401);
  });

  it("refuses a file sent without a staff device token", async () => {
    const response = await fetchAt(
      a.hostname,
      `/api/v1/screens/versions/${versionA}/files/${hashes[0]}`,
      {
        method: "PUT",
        body: files[0]?.bytes as Uint8Array<ArrayBuffer>,
      },
    );
    expect(response.status).toBe(401);
  });
});
