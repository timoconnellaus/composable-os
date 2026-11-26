// Two clients on one deployment of cos-app (stage 66 step 5, criterion 5, ADR 0617): what the
// host keeps at module level is kept per client, through the app's real entries. One client has
// an extension the other has not, and their requests interleave in the same isolate: each sees
// only its own schema. And each client's video host is its own, stamping that client as the
// creator of every upload.
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import {
  applyPlan,
  getObject,
  issueDeviceSession,
  newId,
  planReconcile,
} from "@composable-os/core";
import { createCrmDb } from "@composable-os/db";
import { clientStampOf, environmentFor } from "@composable-os/db/client-environment";
import { setUpTwoClients, TWO_CLIENTS } from "@composable-os/db/testing/two-clients";
import { manifestSchema } from "@composable-os/sdk";
import { beforeAll, describe, expect, it } from "vitest";
import { clientKeyOf } from "../src/server/client-key.ts";
import { type AppParts, hostFetch } from "../src/server/entry.ts";
import { createAppHandler } from "../src/server/mcp/handler.ts";
import { clientVideoHosts } from "../src/server/media.ts";
import { runInClientEnv } from "../src/server/request-env.ts";

const { a, b } = TWO_CLIENTS;
const host = env as unknown as Env;
const start = async () => new Response("start");
const parts: AppParts = { app: createAppHandler({ fetch: start }), start };

const EXTENSION = "onlygyma";
const OBJECT = `${EXTENSION}.gadget`;

async function clientEnv(id: string): Promise<Env> {
  const found = await environmentFor(host, id);
  if (!found.served) throw new Error(`no environment for ${id}`);
  return found.env;
}

async function op(hostname: string, name: string, input: unknown, token: string) {
  const ctx = createExecutionContext();
  const response = await hostFetch(
    new Request(`https://${hostname}/api/v1/op/${name}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": crypto.randomUUID(),
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(input),
    }),
    host,
    ctx,
    parts,
  );
  await waitOnExecutionContext(ctx);
  return response;
}

/** An admin of client `id` and a staff device token for them. */
async function adminToken(id: string, hostname: string): Promise<string> {
  const db = createCrmDb((await clientEnv(id)).DB);
  const userId = newId("user");
  const now = new Date();
  await db.query
    .insertInto("core_user")
    .values({
      id: userId,
      name: `${id} admin`,
      email: `admin@${hostname}`,
      email_verified: 1,
      created_at: now.toISOString(),
      updated_at: now.toISOString(),
      role: "admin",
    } as never)
    .execute();
  const session = await issueDeviceSession(
    db,
    { audience: "staff", subjectId: userId },
    "phone",
    now,
  );
  return session.accessToken;
}

let tokenA: string;
let tokenB: string;

beforeAll(async () => {
  await setUpTwoClients(env);
  tokenA = await adminToken(a.id, a.hostname);
  tokenB = await adminToken(b.id, b.hostname);
  // Client A installs an extension of its own; B never does.
  const aEnv = await clientEnv(a.id);
  const db = createCrmDb(aEnv.DB);
  await runInClientEnv(aEnv, async () => {
    const plan = await planReconcile(
      db.query,
      manifestSchema.parse({
        id: EXTENSION,
        version: "1.0.0",
        contractVersion: 1,
        objects: {
          gadget: {
            label: "Gadget",
            plural: "Gadgets",
            titleField: "name",
            fields: { name: { type: "text", label: "Name", required: true } },
          },
        },
      }),
      { now: new Date().toISOString() },
    );
    await applyPlan((statements) => db.batch(statements), plan);
  });
});

describe("the extension schema each client's requests read (criterion 5)", () => {
  it("is the client's own, also with the two clients' requests side by side in one isolate", async () => {
    for (let round = 0; round < 3; round++) {
      const [listA, listB, objectsA, objectsB] = await Promise.all([
        op(a.hostname, "record.list", { object: OBJECT }, tokenA),
        op(b.hostname, "record.list", { object: OBJECT }, tokenB),
        op(a.hostname, "schema.objects", {}, tokenA),
        op(b.hostname, "schema.objects", {}, tokenB),
      ]);
      expect(listA.status).toBe(200);
      expect(listB.status).not.toBe(200);
      expect(await objectsA.text()).toContain(OBJECT);
      expect(await objectsB.text()).not.toContain(OBJECT);
    }
    // What A's requests loaded stays A's: B's scope reads none of it, A's reads it.
    const aEnv = await clientEnv(a.id);
    const bEnv = await clientEnv(b.id);
    await op(a.hostname, "schema.objects", {}, tokenA);
    expect(runInClientEnv(bEnv, () => Boolean(getObject(OBJECT)))).toBe(false);
    expect(runInClientEnv(aEnv, () => Boolean(getObject(OBJECT)))).toBe(true);
  });
});

describe("each client's video host", () => {
  it("is its own, stamping its client as the creator of every upload", async () => {
    const resolve = clientVideoHosts({ ...(host as object), STREAM_FAKE: "true" } as never);
    for (const client of [a.id, b.id]) {
      const clientsEnv = await clientEnv(client);
      const made = await runInClientEnv(clientsEnv, async () => {
        const video = resolve();
        if (!video) throw new Error("no video host");
        const upload = await video.provider.createUpload({
          name: "class.mp4",
          bytes: 100,
          maxDurationSeconds: 60,
          allowedOrigins: [],
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        });
        return { same: resolve() === video, details: await video.provider.details(upload.uid) };
      });
      expect(made.same).toBe(true);
      // `<environment>:<client>`: a client's staging and live never share a creator (#522, M2).
      expect(made.details?.creator).toBe(`live:${client}`);
      expect(made.details?.creator).toBe(clientStampOf(clientsEnv));
    }
  });
});

describe("a value kept per client environment (review of #522, M1)", () => {
  it("is refused for an environment the directory did not make, never kept in one shared slot", async () => {
    const aEnv = await clientEnv(a.id);
    expect(clientKeyOf(aEnv)).toBe(aEnv);
    // A copy of a client's environment is no client's: refused, not the single client's slot.
    expect(() => clientKeyOf({ ...aEnv })).toThrow(/Not a client's environment/);
    expect(() => clientKeyOf({})).toThrow(/Not a client's environment/);
  });
});
