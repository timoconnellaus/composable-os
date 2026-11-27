// Two clients on one deployment of cos-app (stage 66 step 4, criteria 3, 4, 7, 8 and 9): every
// request is decided by its hostname before any other code; each client's staff see only their
// own records, files and assistant threads; every credential issued for one client is refused at
// the other's address; the client's web app reaches only the client fixed on its binding; the
// crons fan out per client and the queue acts as the client stamped on each message.
//
// With step 6's secrets and addresses, every sign-in is driven end to end at one client and
// refused at the other: device tokens, staff and customer browser sessions, MCP consent and
// exchange, the native handoff, calendar feed addresses and support tokens.
import {
  createExecutionContext,
  createMessageBatch,
  createScheduledController,
  env,
  getQueueResult,
  waitOnExecutionContext,
} from "cloudflare:test";
import { exports } from "cloudflare:workers";
import {
  createIdentityProvider,
  getCustomerIdentity,
  getPractitionerIdentity,
} from "@composable-os/auth";
import {
  inviteCustomer,
  invoke,
  issueDeviceSession,
  issueNativeHandoff,
  newId,
  pkceChallenge,
} from "@composable-os/core";
import { createCrmDb } from "@composable-os/db";
import { unknownHostResponse } from "@composable-os/db/client-entries";
import { clientOf, environmentFor } from "@composable-os/db/client-environment";
import {
  NOT_STAFF_HOSTNAMES,
  setUpTwoClients,
  TWO_CLIENTS,
} from "@composable-os/db/testing/two-clients";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { threadStub } from "../src/server/assistant/http.ts";
import { type AppParts, hostFetch, hostQueue, hostScheduled } from "../src/server/entry.ts";
import { createAppHandler } from "../src/server/mcp/handler.ts";
import { requestEnv } from "../src/server/request-env.ts";
import { SUPPORT_TOKEN_ISSUER } from "../src/server/support.ts";

const { a, b, paused, moving, behind } = TWO_CLIENTS;
const host = env as unknown as Env;

/** What TanStack Start would have been handed: the request, and the env its code reads. */
const reachedStart: { url: string; client: string | null }[] = [];
const start = async (request: Request) => {
  // Better Auth's routes, as src/routes/api/auth/$.ts serves them: on the request's env.
  if (new URL(request.url).pathname.startsWith("/api/auth/")) {
    const provider = createIdentityProvider(requestEnv() as never);
    return (await provider.handle?.(request)) ?? new Response("Not found", { status: 404 });
  }
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

  it("an MCP connection made at one client (consent and exchange) is unknown at the other", async () => {
    const staff = await signUpStaff(a.hostname);
    const tokens = await connectMcp(a.hostname, staff.cookie);
    const list = (hostname: string) =>
      fetchAt(hostname, "/mcp", {
        method: "POST",
        headers: {
          authorization: `Bearer ${tokens.access_token}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "t", version: "1" },
          },
        }),
      });
    const atA = await list(a.hostname);
    expect(atA.status, await atA.clone().text()).toBe(200);
    expect((await list(b.hostname)).status).toBe(401);
    // Its refresh token and the client it registered are unknown at B too.
    const refreshed = await fetchAt(b.hostname, "/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: tokens.refresh_token,
        client_id: tokens.clientId,
        resource: `https://${b.hostname}/mcp`,
      }),
    });
    expect(refreshed.status).toBeGreaterThanOrEqual(400);
    // Everything the library stored is under A's prefix.
    const keys = (await host.OAUTH_KV.list()).keys.map((k) => k.name);
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) expect(key.startsWith(`clients/${a.id}/`), key).toBe(true);
  });

  it("the deployment's callback address decides no client and reaches only the gatekeepers' door", async () => {
    const callback = await fetchAt("callbacks.test", "/gatekeeper/google/oauth?state=x");
    expect(await callback.text()).toBe("callback for google");
    for (const path of ["/", "/api/v1/op/person.list", "/mcp", "/gatekeeper/"]) {
      const response = await fetchAt("callbacks.test", path);
      expect(response.status, path).toBe(404);
    }
  });

  it("a staff browser session is unknown there, and a planted unprefixed cookie is not a second hat", async () => {
    const staff = await signUpStaff(a.hostname);
    expect(staff.cookie).toMatch(/^__Host-/);
    const atA = await cookieOp(a.hostname, staff.cookie, "person.list");
    expect(atA.status, await atA.clone().text()).toBe(200);
    // At B it is no session at all: the same answer as a request with no cookie.
    await expectSameAs(
      cookieOp(b.hostname, staff.cookie, "person.list"),
      cookieOp(b.hostname, "", "person.list"),
    );
    // A sibling hostname can plant `cos-customer.*` with Domain= on the parent: on a many-client
    // host only `__Host-` names are sessions, so this staff request is still one hat.
    const planted = await cookieOp(
      a.hostname,
      `${staff.cookie}; cos-customer.session_token=planted.value`,
      "person.list",
    );
    expect(planted.status, await planted.clone().text()).toBe(200);
  });

  it("a customer browser session is unknown there", async () => {
    const aEnv = await clientEnv(a.id);
    const email = `ada-${crypto.randomUUID()}@member.test`;
    const codes = new Map<string, string>();
    // Built first, this is the identity the host's routes use for A's (frozen) environment, and it
    // hands the code to the test instead of mailing it.
    getCustomerIdentity(aEnv as never, async ({ to, code }) => {
      codes.set(to.toLowerCase(), code);
    });
    await inviteCustomer(createCrmDb(aEnv.DB), email, A.userId);
    const web = `https://${NOT_STAFF_HOSTNAMES.web}`;
    const step = (route: string, body: unknown) =>
      fetchAt(a.hostname, `/api/customer-auth${route}`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: web },
        body: JSON.stringify(body),
      });
    const asked = await step("/email-otp/send-verification-otp", { email, type: "sign-in" });
    expect(asked.status, await asked.clone().text()).toBe(200);
    const otp = codes.get(email);
    expect(otp).toBeTruthy();
    const signedIn = await step("/sign-in/email-otp", { email, otp });
    expect(signedIn.status, await signedIn.clone().text()).toBe(200);
    const cookie = cookiesOf(signedIn);
    expect(cookie).toMatch(/^__Host-cos-customer\./);
    const atA = await cookieOp(a.hostname, cookie, "me.get");
    expect(atA.status, await atA.clone().text()).toBe(200);
    // At B it is no session at all: the same answer as a request with no cookie.
    await expectSameAs(cookieOp(b.hostname, cookie, "me.get"), cookieOp(b.hostname, "", "me.get"));
  });

  it("a practitioner browser session is unknown there", async () => {
    const aEnv = await clientEnv(a.id);
    const email = `pat-${crypto.randomUUID()}@practice.test`;
    const codes = new Map<string, string>();
    // As for customers: built first, this identity is the one A's routes use, and it hands the
    // code to the test.
    getPractitionerIdentity(aEnv as never, async ({ to, code }) => {
      codes.set(to.toLowerCase(), code);
    });
    // Invited by A's admin in the web admin (the operation refuses a device's token).
    await invoke(
      "practitioner.invite",
      { email, name: "Pat Physio", discipline: "Physiotherapist" },
      {
        actor: "human",
        user: { id: A.userId, email: `admin@${a.hostname}`, name: "Ada admin", role: "admin" },
        origin: { surface: "ui" },
        db: createCrmDb(aEnv.DB),
      },
    );
    const web = `https://${NOT_STAFF_HOSTNAMES.web}`;
    const step = (route: string, body: unknown) =>
      fetchAt(a.hostname, `/api/practitioner-auth${route}`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: web },
        body: JSON.stringify(body),
      });
    const asked = await step("/email-otp/send-verification-otp", { email, type: "sign-in" });
    expect(asked.status, await asked.clone().text()).toBe(200);
    const otp = codes.get(email);
    expect(otp).toBeTruthy();
    const signedIn = await step("/sign-in/email-otp", { email, otp });
    expect(signedIn.status, await signedIn.clone().text()).toBe(200);
    const cookie = cookiesOf(signedIn);
    expect(cookie).toMatch(/^__Host-/);
    const atA = await cookieOp(a.hostname, cookie, "practitioner.me");
    expect(atA.status, await atA.clone().text()).toBe(200);
    expect(await atA.text()).toContain(email);
    // At B it is no session at all: the same answer as a request with no cookie.
    await expectSameAs(
      cookieOp(b.hostname, cookie, "practitioner.me"),
      cookieOp(b.hostname, "", "practitioner.me"),
    );
  });

  it("a native sign-in's handoff code made at one client is unknown at the other", async () => {
    const codeVerifier = "v".repeat(43);
    const challenge = await pkceChallenge(codeVerifier);
    const redirectUri = "gym://staff-sign-in";
    const issue = async () =>
      issueNativeHandoff(
        createCrmDb((await clientEnv(a.id)).DB),
        { userId: A.userId, challenge, redirectUri },
        new Date(),
      );
    const exchange = (hostname: string, code: string) =>
      fetchAt(hostname, "/api/v1/auth/staff/exchange", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code, codeVerifier, redirectUri, deviceName: "phone" }),
      });
    expect((await exchange(b.hostname, await issue())).status).toBe(401);
    const atA = await exchange(a.hostname, await issue());
    expect(atA.status, await atA.clone().text()).toBe(200);
  });

  it("a customer's calendar feed address made at one client opens nothing at the other", async () => {
    const rotated = await op(a.hostname, "me.calendarFeed.rotate", {}, A.customerToken);
    expect(rotated.status, await rotated.clone().text()).toBe(200);
    const data = ((await rotated.json()) as { data: { url?: string; path?: string } }).data;
    const path = data.path ?? new URL(data.url ?? "").pathname;
    const atA = await fetchAt(a.hostname, path);
    expect(atA.status, await atA.clone().text()).toBe(200);
    expect((await fetchAt(b.hostname, path)).status).toBe(404);
  });

  it("a support token for one client's address is refused at the other's", async () => {
    const token = await supportToken(a.hostname);
    const enter = (hostname: string) =>
      fetchAt(hostname, `/support/enter?token=${encodeURIComponent(token)}`);
    const reasons: string[] = [];
    const warn = vi.spyOn(console, "warn").mockImplementation((line: string) => {
      reasons.push(line);
    });
    try {
      expect((await enter(b.hostname)).status).toBe(403);
      // At A the audience holds, and the grant is looked up in A's database: there is none.
      expect((await enter(a.hostname)).status).toBe(403);
    } finally {
      warn.mockRestore();
    }
    expect(reasons).toEqual([
      "support access refused: wrong audience",
      "support access refused: unknown grant",
    ]);
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

  it("is refused with props made for an earlier client of the same id (#515, S3)", async () => {
    const e = env as unknown as Record<string, Fetcher>;
    // gym-a's props as the deploy wrote them before gym-a was removed and added again.
    expect((await bound(e.WEB_EARLIER as Fetcher, a.hostname)).status).toBe(404);
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
    // A fleet binds the parking queue (step 7): the suite holds it.
    const withParking = {
      ...host,
      CLIENT_PARKING: { send: async () => undefined },
    } as unknown as Env;
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
    await hostQueue(ticks, withParking);
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
    await hostQueue(batch, withParking);
    const result = await getQueueResult(batch, ctx);
    expect(result.explicitAcks).toEqual([]);
    expect(result.retryMessages.map((m) => m.msgId).sort()).toEqual(["r-a", "r-none", "r-tick"]);
  });
});

function cookiesOf(response: Response): string {
  return response.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
}

/** Two answers alike in status and body, and neither a success. */
async function expectSameAs(got: Promise<Response>, without: Promise<Response>): Promise<void> {
  const [g, w] = await Promise.all([got, without]);
  expect(g.status).toBeGreaterThanOrEqual(400);
  expect({ status: g.status, body: await g.text() }).toEqual({
    status: w.status,
    body: await w.text(),
  });
}

/** A staff account signed up by password at `hostname` (the host's own sign-in), and its cookie. */
async function signUpStaff(hostname: string): Promise<{ cookie: string }> {
  const origin = `https://${hostname}`;
  const response = await fetchAt(hostname, "/api/auth/sign-up/email", {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify({
      email: `staff-${crypto.randomUUID()}@staff.test`,
      password: "correct-horse-battery",
      name: "Staff",
    }),
  });
  if (response.status !== 200) {
    throw new Error(`sign-up failed: ${response.status} ${await response.text()}`);
  }
  return { cookie: cookiesOf(response) };
}

/** An operation called from a page, by cookie. */
function cookieOp(hostname: string, cookie: string, name: string, origin = `https://${hostname}`) {
  return fetchAt(hostname, `/api/v1/op/${name}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": crypto.randomUUID(),
      origin,
      cookie,
    },
    body: "{}",
  });
}

function b64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** The OAuth 2.1 flow at `hostname`: register, consent as the staff cookie, exchange the code. */
async function connectMcp(hostname: string, cookie: string) {
  const origin = `https://${hostname}`;
  const redirect = "http://localhost:3333/callback";
  const registered = await fetchAt(hostname, "/oauth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "Claude",
      redirect_uris: [redirect],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  });
  if (registered.status >= 300) throw new Error(`register: ${await registered.text()}`);
  const { client_id: clientId } = (await registered.json()) as { client_id: string };
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))),
  );
  const query = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirect,
    scope: "read",
    state: "st4te",
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: `${origin}/mcp`,
  });
  const page = await fetchAt(hostname, `/oauth/consent?${query}`, { headers: { cookie } });
  const html = await page.text();
  const handle = /name="handle" value="([^"]+)"/.exec(html)?.[1]?.replace(/&amp;/g, "&");
  if (!handle) throw new Error(`no consent form: ${page.status} ${html.slice(0, 300)}`);
  const form = new URLSearchParams({ handle, decision: "allow" });
  form.append("scope", "read");
  const decided = await fetchAt(hostname, "/oauth/consent", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      cookie: [cookie, cookiesOf(page)].filter(Boolean).join("; "),
      origin,
    },
    body: form,
    redirect: "manual",
  });
  const location = decided.headers.get("location");
  if (decided.status !== 302 || !location) {
    throw new Error(`consent: ${decided.status} ${await decided.text()}`);
  }
  const token = await fetchAt(hostname, "/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: new URL(location).searchParams.get("code") ?? "",
      redirect_uri: redirect,
      client_id: clientId,
      code_verifier: verifier,
      resource: `${origin}/mcp`,
    }),
  });
  if (token.status !== 200) throw new Error(`token: ${token.status} ${await token.text()}`);
  return {
    ...((await token.json()) as { access_token: string; refresh_token: string }),
    clientId,
  };
}

describe("the host's own health, what an update smoke-checks (review of #526, M1)", () => {
  it("answers on the callback hostname while a client is paused, through the real entry and the real smoke check", async () => {
    // A paused client's own address answers "being updated", which is no health answer at all.
    const atPaused = await fetchAt(paused.hostname, "/api/health");
    expect(atPaused.status).toBe(503);
    expect(atPaused.headers.get("content-type") ?? "").not.toContain("json");
    // The host's own: decided before any client, reading the registry's stamp only.
    const own = await fetchAt("callbacks.test", "/api/health");
    expect(own.status).toBe(200);
    const body = (await own.json()) as { status: string; version: string; host: boolean };
    expect(body).toMatchObject({ status: "ok", host: true });
    // `cos fleet upgrade`'s smoke check itself (packages/release `healthSmoke`), unstubbed.
    const { healthSmoke } = await import("@composable-os/release");
    await healthSmoke("callbacks.test", body.version, {
      attempts: 1,
      delayMs: 0,
      fetch: (async (input: RequestInfo | URL) =>
        fetchAt("callbacks.test", new URL(String(input)).pathname)) as typeof fetch,
    });
    await expect(
      healthSmoke(paused.hostname, body.version, {
        attempts: 1,
        delayMs: 0,
        fetch: (async (input: RequestInfo | URL) =>
          fetchAt(paused.hostname, new URL(String(input)).pathname)) as typeof fetch,
      }),
    ).rejects.toThrow(/smoke check failed/);
    // Only GET of that one path: anything else there is still the gatekeepers' door or a 404.
    expect((await fetchAt("callbacks.test", "/api/health/x")).status).toBe(404);
    // A registry that does not answer: a fixed message, never the database's own text.
    const { hostHealthResponse } = await import("../src/server/health.ts");
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const broken = await hostHealthResponse({
        REGISTRY: {
          prepare() {
            throw new Error("D1_ERROR: near row text of a client");
          },
        } as unknown as D1Database,
      });
      expect(broken.status).toBe(503);
      const text = await broken.text();
      expect(text).toContain("the registry did not answer");
      expect(text).not.toContain("row text");
    } finally {
      errors.mockRestore();
    }
  });
});

describe("erase on a host of many clients (criterion 14, ADR 0320)", () => {
  it("reaches every store of the erasing client and touches nothing of the other's", async () => {
    // The same person, the same email with its body under the same key, in each client.
    const seed = async (c: Client) => {
      const cEnv = await clientEnv(c.id);
      const made = await op(
        c.hostname,
        "person.create",
        { givenName: "Erin", familyName: "Same", emails: [{ email: "erin@same.example" }] },
        c.staffToken,
      );
      expect(made.status).toBe(200);
      const personId = ((await made.json()) as { data: { id: string } }).data.id;
      const activityId = newId("activity");
      const at = new Date().toISOString();
      await cEnv.DB.batch([
        cEnv.DB.prepare(
          "INSERT INTO core_activity (id, type, subject, body, payload, occurred_at, created_at, updated_at, body_ref) VALUES (?, 'email', 'Hello Erin', 'Dear Erin', '{}', ?, ?, ?, 'email-bodies/shared-key')",
        ).bind(activityId, at, at, at),
        cEnv.DB.prepare(
          "INSERT INTO core_activity_links (activity_id, object_type, record_id) VALUES (?, 'person', ?)",
        ).bind(activityId, personId),
      ]);
      await cEnv.BLOBS.put("email-bodies/shared-key", `Dear Erin, from ${c.id}`);
      return { personId, activityId, cEnv };
    };
    const atA = await seed(A);
    const atB = await seed(B);
    const erased = await op(A.hostname, "person.erase", { id: atA.personId }, A.staffToken);
    expect(erased.status, await erased.clone().text()).toBe(200);
    const count = async (cEnv: Env, sql: string, ...params: string[]) =>
      (
        await cEnv.DB.prepare(sql)
          .bind(...params)
          .first<{ n: number }>()
      )?.n;
    // At A: the person, their email address, the email and its body in the files are gone.
    expect(
      await count(atA.cEnv, "SELECT count(*) AS n FROM core_person WHERE id = ?", atA.personId),
    ).toBe(0);
    expect(
      await count(atA.cEnv, "SELECT count(*) AS n FROM core_activity WHERE id = ?", atA.activityId),
    ).toBe(0);
    expect(
      await count(
        atA.cEnv,
        "SELECT count(*) AS n FROM core_person_emails WHERE email = ?",
        "erin@same.example",
      ),
    ).toBe(0);
    expect(await atA.cEnv.BLOBS.get("email-bodies/shared-key")).toBeNull();
    // At B, the same rows, the same address and the same key: all as they were.
    expect(
      await count(atB.cEnv, "SELECT count(*) AS n FROM core_person WHERE id = ?", atB.personId),
    ).toBe(1);
    expect(
      await count(atB.cEnv, "SELECT count(*) AS n FROM core_activity WHERE id = ?", atB.activityId),
    ).toBe(1);
    expect(
      await count(
        atB.cEnv,
        "SELECT count(*) AS n FROM core_person_emails WHERE email = ?",
        "erin@same.example",
      ),
    ).toBe(1);
    expect(await (await atB.cEnv.BLOBS.get("email-bodies/shared-key"))?.text()).toBe(
      `Dear Erin, from ${b.id}`,
    );
    expect(
      await count(
        atB.cEnv,
        "SELECT count(*) AS n FROM core_blob_deletion WHERE key = ?",
        "email-bodies/shared-key",
      ),
    ).toBe(0);
  });
});

/** A support token as the control plane signs one, for `audience` (ADR 0212). */
async function supportToken(audience: string): Promise<string> {
  const jwk = JSON.parse(
    (env as unknown as { SUPPORT_TEST_PRIVATE_JWK: string }).SUPPORT_TEST_PRIVATE_JWK,
  );
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "Ed25519" }, false, ["sign"]);
  const now = Math.floor(Date.now() / 1000);
  const part = (value: unknown) => b64url(new TextEncoder().encode(JSON.stringify(value)));
  const head = part({ alg: "EdDSA", typ: "JWT" });
  const body = part({
    iss: SUPPORT_TOKEN_ISSUER,
    aud: audience,
    sub: "grant-1",
    email: "support@example.com",
    iat: now,
    exp: now + 300,
    jti: crypto.randomUUID(),
  });
  const signature = await crypto.subtle.sign(
    { name: "Ed25519" },
    key,
    new TextEncoder().encode(`${head}.${body}`),
  );
  return `${head}.${body}.${b64url(new Uint8Array(signature))}`;
}
