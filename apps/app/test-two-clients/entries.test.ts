// Two clients on one deployment of cos-app (stage 66 step 4, criteria 3, 4, 7, 8 and 9): every
// request is decided by its hostname before any other code; each client's staff see only their
// own records, files and assistant threads; every credential issued for one client is refused at
// the other's address; the client's web app reaches only the client fixed on its binding; the
// crons fan out per client and the queue acts as the client stamped on each message.
//
// What needs step 6 (each client's own auth secrets and addresses) is shown refused clearly, not
// driven end to end: a staff browser session (Better Auth), a customer browser session, and an
// MCP connection's consent (which needs a staff session). See ADR 0615, "Not covered yet".
import {
  createExecutionContext,
  createMessageBatch,
  createScheduledController,
  env,
  getQueueResult,
  waitOnExecutionContext,
} from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { issueDeviceSession, newId } from "@composable-os/core";
import { createCrmDb } from "@composable-os/db";
import { unknownHostResponse } from "@composable-os/db/client-entries";
import { clientOf, environmentFor } from "@composable-os/db/client-environment";
import {
  NOT_STAFF_HOSTNAMES,
  setUpTwoClients,
  TWO_CLIENTS,
} from "@composable-os/db/testing/two-clients";
import { beforeAll, describe, expect, it } from "vitest";
import { threadStub } from "../src/server/assistant/http.ts";
import { type AppParts, hostFetch, hostQueue, hostScheduled } from "../src/server/entry.ts";
import { createAppHandler } from "../src/server/mcp/handler.ts";
import { requestEnv } from "../src/server/request-env.ts";

const { a, b, paused, moving, behind } = TWO_CLIENTS;
const host = env as unknown as Env;

/** What TanStack Start would have been handed: the request, and the env its code reads. */
const reachedStart: { url: string; client: string | null }[] = [];
const start = async (request: Request) => {
  // Below the entry, code that reads no env of its own reads the request's: the client's.
  reachedStart.push({ url: request.url, client: clientOf(requestEnv()) });
  await new Promise((resolve) => setTimeout(resolve, 5));
  reachedStart.push({ url: `${request.url}#after-await`, client: clientOf(requestEnv()) });
  return new Response(`start for ${clientOf(requestEnv())}`);
};
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

function op(hostname: string, name: string, input: unknown, token?: string) {
  return fetchAt(hostname, `/api/v1/op/${name}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": crypto.randomUUID(),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(input),
  });
}

async function clientEnv(id: string): Promise<Env> {
  const found = await environmentFor(host, id);
  if (!found.served) throw new Error(`no environment for ${id}`);
  return found.env;
}

interface Client {
  id: string;
  hostname: string;
  userId: string;
  staffToken: string;
  customerToken: string;
}

async function seedClient(c: { id: string; hostname: string }, label: string): Promise<Client> {
  const db = createCrmDb((await clientEnv(c.id)).DB);
  const userId = newId("user");
  const now = new Date();
  const at = now.toISOString();
  await db.query
    .insertInto("core_user")
    .values({
      id: userId,
      name: `${label} admin`,
      email: `admin@${c.hostname}`,
      email_verified: 1,
      created_at: at,
      updated_at: at,
      role: "admin",
    } as never)
    .execute();
  const staff = await issueDeviceSession(
    db,
    { audience: "staff", subjectId: userId },
    "phone",
    now,
  );
  // The member's Person, made by the admin through the host's surface, at their own address.
  const made = await op(
    c.hostname,
    "person.create",
    { givenName: `${label} member` },
    staff.accessToken,
  );
  if (made.status !== 200) throw new Error(`person.create: ${made.status} ${await made.text()}`);
  const personId = ((await made.json()) as { data?: { id: string }; id?: string }).data?.id;
  if (!personId) throw new Error("person.create returned no id");
  const customerId = `cus_${label.toLowerCase()}`;
  await db.query
    .insertInto("core_customer")
    .values({
      id: customerId,
      person_id: personId,
      email: `member@${c.hostname}`,
      email_verified: 1,
      created_at: at,
      updated_at: at,
    } as never)
    .execute();
  const customer = await issueDeviceSession(
    db,
    { audience: "customer", subjectId: customerId },
    "phone",
    now,
  );
  return {
    ...c,
    userId,
    staffToken: staff.accessToken,
    customerToken: customer.accessToken,
  };
}

let A: Client;
let B: Client;

beforeAll(async () => {
  await setUpTwoClients(env);
  A = await seedClient(a, "Ada");
  B = await seedClient(b, "Bea");
});

describe("a hostname the host does not serve (criterion 8)", () => {
  it("gets one plain 404, the same for every such hostname, before any other code", async () => {
    const expected = unknownHostResponse();
    const expectedBody = await expected.text();
    const before = reachedStart.length;
    for (const hostname of [
      "nobody.test",
      NOT_STAFF_HOSTNAMES.unverified,
      NOT_STAFF_HOSTNAMES.web,
      NOT_STAFF_HOSTNAMES.desk,
      "127.0.0.1",
      "gym-a",
      `x.${a.hostname}`,
    ]) {
      for (const path of [
        "/",
        "/api/v1/op/person.list",
        "/mcp",
        "/oauth/register",
        "/api/auth/x",
      ]) {
        const response = await fetchAt(hostname, path, { headers: { accept: "text/html" } });
        expect(response.status, `${hostname}${path}`).toBe(404);
        expect(await response.text()).toBe(expectedBody);
        expect([...response.headers]).toEqual([...expected.headers]);
      }
    }
    expect(reachedStart.length).toBe(before);
  });

  it("is refused with a credential of a client too: the token is never read", async () => {
    const response = await op("nobody.test", "person.list", {}, A.staffToken);
    expect(response.status).toBe(404);
  });
});

describe("a client the host does not serve right now", () => {
  it("gets the same 'being updated' answer, paused, moving or behind the code's schema", async () => {
    const bodies = new Set<string>();
    for (const c of [paused, moving, behind]) {
      const response = await fetchAt(c.hostname, "/api/v1/op/person.list");
      expect(response.status, c.id).toBe(503);
      expect(response.headers.get("retry-after")).toBe("120");
      bodies.add(await response.text());
    }
    expect(bodies.size).toBe(1);
    expect([...bodies][0]).not.toMatch(/gym-|paused|moving|schema/);
  });
});

describe("each client's staff, at their own address (criterion 3)", () => {
  it("run on their own client's environment, also in code that reads no env of its own", async () => {
    reachedStart.length = 0;
    const [ra, rb] = await Promise.all([fetchAt(a.hostname, "/"), fetchAt(b.hostname, "/")]);
    expect(await ra.text()).toBe("start for gym-a");
    expect(await rb.text()).toBe("start for gym-b");
    // Two requests at once, each through an await: each keeps its own client.
    for (const entry of reachedStart) {
      expect(entry.client, entry.url).toBe(entry.url.includes("gym-a") ? "gym-a" : "gym-b");
    }
  });

  it("see only their own records", async () => {
    for (const [c, name] of [
      [A, "Adele from A"],
      [B, "Bruno from B"],
    ] as const) {
      const made = await op(c.hostname, "person.create", { givenName: name }, c.staffToken);
      expect(made.status, await made.clone().text()).toBe(200);
    }
    const listA = await (await op(a.hostname, "person.list", {}, A.staffToken)).text();
    const listB = await (await op(b.hostname, "person.list", {}, B.staffToken)).text();
    expect(listA).toContain("Adele from A");
    expect(listA).not.toContain("Bruno from B");
    expect(listB).toContain("Bruno from B");
    expect(listB).not.toContain("Adele from A");
  });

  it("call the runner as their own client", async () => {
    const aEnv = await clientEnv(a.id);
    expect(await (aEnv.RUNNER as unknown as { ping(): Promise<unknown> }).ping()).toEqual({
      client: "gym-a",
      method: "ping",
      args: [],
    });
    const bEnv = await clientEnv(b.id);
    expect(await (bEnv.RUNNER as unknown as { ping(): Promise<unknown> }).ping()).toEqual({
      client: "gym-b",
      method: "ping",
      args: [],
    });
  });

  it("have their own files", async () => {
    const aEnv = await clientEnv(a.id);
    const bEnv = await clientEnv(b.id);
    await aEnv.BLOBS.put("media/logo", "A's logo");
    expect(await bEnv.BLOBS.get("media/logo")).toBeNull();
    expect(await (await aEnv.BLOBS.get("media/logo"))?.text()).toBe("A's logo");
  });

  it("have their own assistant threads: the same user id is two threads", async () => {
    const aEnv = await clientEnv(a.id);
    const bEnv = await clientEnv(b.id);
    const aThread = await threadStub(aEnv.ASSISTANT as never, "user-1");
    await aThread.threadState("user-1", {});
    // B's object of the same name is another object: it has no owner yet, so user-2 takes it.
    const bThread = await threadStub(bEnv.ASSISTANT as never, "user-1");
    await expect((async () => await bThread.threadState("user-2", {}))()).resolves.toBeTruthy();
    // A's is user-1's: user-2 is refused there.
    await expect((async () => await aThread.threadState("user-2", {}))()).rejects.toThrow(
      /No such thread/,
    );
    // The raw namespace with a name that carries no client refuses.
    const raw = host.ASSISTANT.get(host.ASSISTANT.idFromName("user:1"));
    await expect((async () => await raw.threadState("user-1", {}))()).rejects.toThrow();
  });
});

describe("a credential issued for one client, at the other's address (criterion 4)", () => {
  it("a staff device token (the native app's, and an API token) is unknown there", async () => {
    expect((await op(a.hostname, "person.list", {}, A.staffToken)).status).toBe(200);
    const crossed = await op(b.hostname, "person.list", {}, A.staffToken);
    expect(crossed.status).toBe(401);
    expect(await crossed.text()).not.toContain("Adele");
  });

  it("a customer device token is unknown there", async () => {
    expect((await op(a.hostname, "me.get", {}, A.customerToken)).status).toBe(200);
    expect((await op(b.hostname, "me.get", {}, A.customerToken)).status).toBe(401);
  });

  it("MCP and OAuth: refused at every client's address until step 6 gives it its own address", async () => {
    // The issuer and resource are the client's MCP_RESOURCE (step 6), never the request's: until
    // then registration, tokens and /mcp all answer 503 naming step 6, at A and at B. That the
    // library's clients, grants and tokens are each client's own (its KV prefix) is shown in
    // packages/db/test/client-bindings.test.ts; the cross-client exchange waits for step 6.
    for (const hostname of [a.hostname, b.hostname]) {
      for (const [path, init] of [
        [
          "/oauth/register",
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ client_name: "Claude", redirect_uris: ["http://localhost/cb"] }),
          },
        ],
        ["/oauth/token", { method: "POST", body: "grant_type=authorization_code" }],
        ["/.well-known/oauth-authorization-server", {}],
        [
          "/mcp",
          { method: "POST", headers: { authorization: `Bearer ${A.userId}:g:s` }, body: "{}" },
        ],
      ] as const) {
        const response = await fetchAt(hostname, path, init as RequestInit);
        expect(response.status, `${hostname}${path}`).toBe(503);
        expect(await response.text()).toMatch(/MCP_RESOURCE.*step 6/);
      }
    }
    // Nothing was stored for any client.
    expect((await host.OAUTH_KV.list()).keys).toEqual([]);
  });

  it("the deployment's callback address decides no client and reaches only the gatekeepers' door", async () => {
    const callback = await fetchAt("callbacks.test", "/gatekeeper/google/oauth?state=x");
    expect(await callback.text()).toBe("callback for google");
    for (const path of ["/", "/api/v1/op/person.list", "/mcp", "/gatekeeper/"]) {
      const response = await fetchAt("callbacks.test", path);
      expect(response.status, path).toBe(404);
    }
  });

  it("a staff or customer browser session: refused, since a client's auth secret is step 6's", async () => {
    const staff = await fetchAt(a.hostname, "/api/v1/op/person.list", {
      method: "POST",
      headers: {
        cookie: "better-auth.session_token=forged.signature",
        "content-type": "application/json",
      },
      body: "{}",
    });
    expect(staff.status).not.toBe(200);
    const signIn = await fetchAt(a.hostname, "/api/customer-auth/get-session");
    expect(signIn.status).toBe(503);
    expect(await signIn.text()).toMatch(/step 6/);
  });
});

describe("a client's web app, through its HOST binding (criterion 9)", () => {
  const bound = (binding: Fetcher, hostname: string) =>
    binding.fetch(`https://${hostname}/api/v1/manifest`, { headers: { host: hostname } });

  it("reaches the client fixed on its binding, whatever hostname it sends", async () => {
    const web = (env as unknown as { WEB_GYM_A: Fetcher }).WEB_GYM_A;
    for (const hostname of [a.hostname, b.hostname, "nobody.test"]) {
      expect((await bound(web, hostname)).status, hostname).toBe(200);
    }
  });

  it("is refused with no client on its binding, an unknown one, or one not served now", async () => {
    const e = env as unknown as Record<string, Fetcher>;
    expect((await bound(e.WEB_NO_CLIENT as Fetcher, a.hostname)).status).toBe(404);
    expect((await bound(e.WEB_NOBODY as Fetcher, a.hostname)).status).toBe(404);
    expect((await bound(e.WEB_PAUSED as Fetcher, paused.hostname)).status).toBe(503);
  });

  it("is refused with props minted without the host's key: gym-b by gym-a's proof, or none (S1)", async () => {
    const e = env as unknown as Record<string, Fetcher>;
    expect((await bound(e.WEB_FORGED as Fetcher, b.hostname)).status).toBe(404);
    expect((await bound(e.WEB_UNPROVEN as Fetcher, b.hostname)).status).toBe(404);
  });
});

describe("what code below an entry could reach through exports (review of #512, S1)", () => {
  it("cannot mint ClientApp for another client: its props need the host's proof", async () => {
    const minted = (props: { client: string; proof?: string }) =>
      (exports as unknown as { ClientApp: (o: { props: unknown }) => Fetcher }).ClientApp({
        props,
      });
    for (const props of [{ client: b.id }, { client: b.id, proof: "0".repeat(32) }]) {
      const response = await minted(props).fetch(`https://${b.hostname}/api/v1/manifest`);
      expect(response.status).toBe(404);
    }
  });

  it("cannot open another client's object with the raw namespace: its name needs the proof", async () => {
    const raw = (exports as unknown as { AssistantAgent: DurableObjectNamespace }).AssistantAgent;
    for (const name of [`${b.id}:user:x`, `${b.id}:${"0".repeat(32)}:user:x`]) {
      const stub = raw.get(raw.idFromName(name)) as unknown as {
        threadState(u: string, o: object): Promise<unknown>;
      };
      await expect((async () => await stub.threadState("x", {}))()).rejects.toThrow();
    }
  });
});

describe("the crons and the queue (criterion 7)", () => {
  it("a cron tick fans out one message per client served, and runs no client's work", async () => {
    const sent: unknown[] = [];
    const fanOut = {
      sendBatch: async (messages: Iterable<{ body: unknown }>) => {
        for (const m of messages) sent.push(m.body);
      },
    };
    const ctx = createExecutionContext();
    hostScheduled(
      createScheduledController({ cron: "17 3 * * *", scheduledTime: 1_000 }),
      { ...host, CLIENT_FANOUT: fanOut } as unknown as Env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect((sent as { client: string }[]).map((m) => m.client).sort()).toEqual(["gym-a", "gym-b"]);
  });

  it("each client's tick and each routine delivery runs as its client, acked or retried alone", async () => {
    const tick = (client: string) => ({
      cosFanOut: 1,
      client,
      cron: "17 3 * * *",
      scheduledTime: 1,
    });
    // The fan-out queue's batch: each tick in its client's environment, one at a time.
    const ticks = createMessageBatch<unknown>("cos-app-fanout", [
      { id: "t-a", timestamp: new Date(), attempts: 1, body: tick(a.id) },
      { id: "t-b", timestamp: new Date(), attempts: 1, body: tick(b.id) },
      { id: "t-p", timestamp: new Date(), attempts: 1, body: tick(paused.id) },
    ]);
    const tickCtx = createExecutionContext();
    await hostQueue(ticks, host);
    const ticked = await getQueueResult(ticks, tickCtx);
    expect(ticked.explicitAcks.sort()).toEqual(["t-a", "t-b", "t-p"]);
    // The delivery queue's batch: a tick-shaped body here is only a message with no stamp.
    const batch = createMessageBatch<unknown>("cos-routine-delivery", [
      // A routine's message for a user A does not have: A's delivery fails and is retried alone.
      {
        id: "r-a",
        timestamp: new Date(),
        attempts: 1,
        body: { cosClient: a.id, body: { userId: "user-nobody", routineId: "r", runId: null } },
      },
      // No stamp: never acted on.
      {
        id: "r-none",
        timestamp: new Date(),
        attempts: 1,
        body: { userId: A.userId, routineId: "r", runId: null },
      },
      { id: "r-tick", timestamp: new Date(), attempts: 1, body: tick(a.id) },
    ]);
    const ctx = createExecutionContext();
    await hostQueue(batch, host);
    const result = await getQueueResult(batch, ctx);
    expect(result.explicitAcks).toEqual([]);
    expect(result.retryMessages.map((m) => m.msgId).sort()).toEqual(["r-a", "r-none", "r-tick"]);
  });
});
