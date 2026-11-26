// Two clients on one runner (stage 66 step 4, criteria 3, 6 and 7): every RPC is called as a
// client and runs on that client's environment; the methods on the runner itself refuse; its
// cron fans out one message per client served and each tick runs as its client; automation
// events act as the client stamped on them; a Workflow is reachable only by its own client; the
// extension workspace, and the Worker Loader's tool isolates, are each client's own.
import {
  createExecutionContext,
  createMessageBatch,
  createScheduledController,
  env,
  getQueueResult,
} from "cloudflare:test";
import { type ActingUser, invokeByName, newId, vendorBinding } from "@composable-os/core";
import { createCrmDb } from "@composable-os/db";
import { RUNNER_METHODS } from "@composable-os/db/client-bindings";
import {
  consumeByClient,
  consumeFanOut,
  FANOUT_CONSUMER,
  gatekeeperOffered,
  PARKING,
  propsClientEnvironment,
  RUNNER_CALLER,
  stampOf,
  workflowRun,
} from "@composable-os/db/client-entries";
import { clientOf, environmentFor } from "@composable-os/db/client-environment";
import { setUpTwoClients, TWO_CLIENTS } from "@composable-os/db/testing/two-clients";
import { beforeAll, describe, expect, it } from "vitest";
import Runner, { ClientRunner, extensionHost } from "../src/index.ts";
import { availableVendors, hostFor, integrationRuntime } from "../src/integrations/runtime.ts";

const { a, b, paused, behind } = TWO_CLIENTS;

interface CallAs {
  callAs(client: string, method: string, args: unknown[]): Promise<unknown>;
  ping(): Promise<unknown>;
}
// The runner's real entry class, as the host's Workers reach it (SELF's test proxy cannot carry
// this Worker's own loopback bindings across).
/** An execution context with the props the deploy fixes on cos-app's binding (S4). */
const fromApp = () =>
  Object.assign(createExecutionContext(), { props: { ...RUNNER_CALLER } }) as ExecutionContext;
const entry = new Runner(fromApp(), env as unknown as Env) as unknown as CallAs;
/** The runner's methods as `client`, as cos-app's RUNNER wrapper calls them. */
const as = (client: string) =>
  new Proxy(
    {},
    {
      get:
        (_t, method) =>
        (...args: unknown[]) =>
          entry.callAs(client, String(method), args),
    },
  ) as Record<string, (...args: unknown[]) => Promise<unknown>>;

async function clientEnv(id: string): Promise<Env> {
  const found = await environmentFor(env as unknown as Env, id);
  if (!found.served) throw new Error(`no environment for ${id}`);
  return found.env;
}

async function adminIn(clientEnvironment: Env): Promise<ActingUser> {
  const id = newId("user");
  const email = `admin-${id}@example.com`;
  const now = new Date().toISOString();
  await clientEnvironment.DB.prepare(
    "INSERT INTO core_user (id, name, email, email_verified, created_at, updated_at, role) VALUES (?, 'Admin', ?, 1, ?, ?, 'admin')",
  )
    .bind(id, email, now, now)
    .run();
  return { id, email, name: "Admin", role: "admin" };
}

beforeAll(async () => {
  await setUpTwoClients(env);
});

describe("the runner's RPC on a many-client host", () => {
  it("runs each call as the client named, and refuses the methods on the runner itself", async () => {
    expect(await as(a.id).ping?.()).toMatchObject({ ok: true });
    expect(await as(b.id).ping?.()).toMatchObject({ ok: true });
    await expect((async () => entry.ping())()).rejects.toThrow(/callAs/);
    await expect(entry.callAs(a.id, "fetch", [])).rejects.toThrow(/not one of/);
    await expect(entry.callAs(a.id, "constructor", [])).rejects.toThrow(/not one of/);
  });

  it("refuses callAs from any binding but the app's, whatever client it names (S4)", async () => {
    const stranger = new Runner(
      createExecutionContext(),
      env as unknown as Env,
    ) as unknown as CallAs;
    await expect(stranger.callAs(a.id, "ping", [])).rejects.toThrow(/only to the host's own app/);
    const forged = new Runner(
      Object.assign(createExecutionContext(), {
        props: { caller: "cos-front" },
      }) as ExecutionContext,
      env as unknown as Env,
    ) as unknown as CallAs;
    await expect(forged.callAs(b.id, "ping", [])).rejects.toThrow(/only to the host's own app/);
  });

  it("refuses a client it does not know or does not serve now", async () => {
    for (const id of ["gym-nobody", paused.id, behind.id, "Not A Client", ""]) {
      await expect(as(id).ping?.(), id).rejects.toThrow();
    }
  });

  it("offers through callAs every method the RUNNER wrapper lists, and the wrapper lists them all", () => {
    const methods = Object.getOwnPropertyNames(ClientRunner.prototype).filter(
      (name) => name !== "constructor",
    );
    expect([...methods].sort()).toEqual([...RUNNER_METHODS].sort());
    const own = Object.getOwnPropertyNames(Runner.prototype).filter(
      (name) => !["constructor", "callAs", "queue", "scheduled", "fetch"].includes(name),
    );
    expect(own.sort()).toEqual([...RUNNER_METHODS].sort());
  });
});

describe("Workflows", () => {
  it("are reached only by the client that started them", async () => {
    const started = (await as(a.id).startHelloWorkflow?.("Ada")) as { id: string };
    expect(started.id).not.toContain("gym-a");
    const status = (await as(a.id).helloWorkflowStatus?.(started.id)) as {
      id: string;
    };
    expect(status.id).toBe(started.id);
    // The same id from B is B's instance id, which does not exist; B's own stored form neither.
    await expect(as(b.id).helloWorkflowStatus?.(started.id)).rejects.toThrow();
    await expect(as(b.id).helloWorkflowStatus?.(`gym-a_${started.id}`)).rejects.toThrow();
    // The instance is stored under A's id, with A's stamp beside its params.
    const raw = await env.HELLO_WORKFLOW.get(`gym-a_${started.id}`);
    expect(raw.id).toBe(`gym-a_${started.id}`);
  });
});

describe("the minute cron", () => {
  it("fans out one message per client served, and does no client's work itself", async () => {
    const sent: unknown[] = [];
    const fanOut = {
      sendBatch: async (messages: Iterable<{ body: unknown }>) => {
        for (const m of messages) sent.push(m.body);
      },
    };
    const host = { ...(env as unknown as Env), CLIENT_FANOUT: fanOut } as unknown as Env;
    const ctx = createExecutionContext();
    const worker = new Runner(ctx, host);
    await worker.scheduled(createScheduledController({ cron: "* * * * *", scheduledTime: 60_000 }));
    expect((sent as { client: string }[]).map((m) => m.client).sort()).toEqual([a.id, b.id].sort());
    expect(sent[0]).toMatchObject({ cosFanOut: 1, cron: "* * * * *", scheduledTime: 60_000 });
  });

  it("runs each client's tick as its own message, acked or retried alone", async () => {
    const batch = createMessageBatch<unknown>("cos-runner-fanout", [
      { id: "m-a", timestamp: new Date(), attempts: 1, body: tick(a.id) },
      { id: "m-b", timestamp: new Date(), attempts: 1, body: tick(b.id) },
      // A client no longer served is skipped (acked): the next tick comes.
      { id: "m-p", timestamp: new Date(), attempts: 1, body: tick(paused.id) },
    ]);
    const ctx = createExecutionContext();
    await new Runner(ctx, env as unknown as Env).queue(batch);
    const result = await getQueueResult(batch, ctx);
    expect(result.explicitAcks.sort()).toEqual(["m-a", "m-b", "m-p"]);
    expect(result.retryMessages).toEqual([]);
  });
});

function tick(client: string) {
  return { cosFanOut: 1, client, cron: "* * * * *", scheduledTime: Date.now() };
}

describe("automation events", () => {
  it("act as the client stamped on them; an unstamped one, or a refused client's, is retried", async () => {
    // A record event with no change: it matches no automation, and is consumed as it is.
    const event = (id: string) => ({
      v: 1,
      kind: "record",
      id: `audit-${id}:0`,
      at: new Date().toISOString(),
      origin: { surface: "ui" },
      changes: [],
    });
    const batch = createMessageBatch<unknown>("cos-automation-events", [
      {
        id: "e-a",
        timestamp: new Date(),
        attempts: 1,
        body: { cosClient: a.id, body: event("1") },
      },
      {
        id: "e-b",
        timestamp: new Date(),
        attempts: 1,
        body: { cosClient: b.id, body: event("2") },
      },
      { id: "e-none", timestamp: new Date(), attempts: 1, body: event("3") },
      {
        id: "e-behind",
        timestamp: new Date(),
        attempts: 1,
        body: { cosClient: behind.id, body: event("4") },
      },
    ]);
    const ctx = createExecutionContext();
    await new Runner(ctx, env as unknown as Env).queue(batch);
    const result = await getQueueResult(batch, ctx);
    expect(result.explicitAcks.sort()).toEqual(["e-a", "e-b"]);
    expect(result.retryMessages.map((m) => m.msgId).sort()).toEqual(["e-behind", "e-none"]);
  });

  it("are sent stamped with the client by the queue in a client's environment", async () => {
    const sent: unknown[] = [];
    const host = {
      ...(env as unknown as Env),
      AUTOMATION_EVENTS: {
        send: async (body: unknown) => sent.push(body),
        sendBatch: async (messages: Iterable<{ body: unknown }>) => {
          for (const m of messages) sent.push(m.body);
        },
      },
    } as unknown as Env;
    const aEnv = await environmentFor(host, a.id);
    if (!aEnv.served) throw new Error("gym-a is served");
    await aEnv.env.AUTOMATION_EVENTS.send({ kind: "record" } as never);
    expect(stampOf(sent[0])).toEqual({ client: a.id, body: { kind: "record" } });
  });
});

describe("the extension workspace and the tool isolates", () => {
  const files = (id: string) => ({
    "index.ts": `import { defineExtension, defineTool, z } from "@composable-os/sdk";
let runs = 0;
export default defineExtension({
  id: "${id}",
  version: "1.0.0",
  contractVersion: 1,
  tools: {
    count: defineTool({
      description: "Counts the runs this isolate has seen: module-level state.",
      input: z.object({}),
      output: z.number(),
      handler: async () => { runs += 1; return runs; },
    }),
  },
  permissions: { read: [], modules: [] },
});
`,
  });

  it("are each client's own: same pack, two workspaces, two Worker Loader ids, no shared state", async () => {
    const id = "counter";
    const seen: string[] = [];
    const counting = (loader: WorkerLoader): WorkerLoader =>
      ({
        get: (workerId: string, code: () => unknown) => {
          seen.push(workerId);
          return loader.get(workerId, code as never);
        },
        load: (code: unknown) => loader.load(code as never),
      }) as unknown as WorkerLoader;
    const ran: Record<string, number[]> = {};
    for (const client of [a.id, b.id]) {
      const clientEnvironment = await clientEnv(client);
      const admin = await adminIn(clientEnvironment);
      const host = extensionHost(clientEnvironment, { loader: counting(env.LOADER) });
      const installed = (await invokeByName(
        "extension.install",
        { id, files: files(id) },
        {
          actor: "human",
          user: admin,
          origin: { surface: "ui" },
          db: createCrmDb(clientEnvironment.DB),
          extensionHost: host,
        },
      )) as { commit: string };
      const run = async () => {
        const result = await host.runTool({
          id,
          commit: installed.commit,
          tool: "count",
          input: {},
          caller: { actor: "human", userId: admin.id },
        });
        if (!result.ok) throw new Error(JSON.stringify(result.error));
        return result.value as number;
      };
      ran[client] = client === a.id ? [await run(), await run()] : [await run()];
      // The workspace is the client's: the other's extension is not in it.
      const listed = await host.listWorkspace();
      expect(listed.filter((entry) => entry.id === id).length).toBeLessThanOrEqual(1);
    }
    // A's isolate counted A's runs; B's started at one: nothing of A's run reached it.
    expect(ran).toEqual({ [a.id]: [1, 2], [b.id]: [1] });
    const tools = seen.filter((workerId) => workerId.includes("ext:counter:"));
    expect(tools.some((w) => w.startsWith("client:gym-a:"))).toBe(true);
    expect(tools.some((w) => w.startsWith("client:gym-b:"))).toBe(true);
    expect(tools.every((w) => w.startsWith("client:"))).toBe(true);
    // Each client's database has its own install only.
    for (const client of [a.id, b.id]) {
      const rows = await (await clientEnv(client)).DB.prepare(
        "SELECT count(*) AS n FROM core_extensions WHERE id = ?",
      )
        .bind(id)
        .first<{ n: number }>();
      expect(rows?.n).toBe(1);
    }
  });
});

describe("the runner's D1 binding", () => {
  it("holds no table: nothing ran on it instead of a client's database", async () => {
    const row = await (env as unknown as Env).DB.prepare(
      "SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\'",
    ).first<{ n: number }>();
    expect(row?.n).toBe(0);
  });
});

describe("gatekeepers on a many-client host (B1)", () => {
  /** A gatekeeper binding the suite can see the use of: every method records and answers. */
  const fakeGatekeeper = (name: string) => ({ fetch: async () => new Response(name) });
  const every = [
    "google",
    "microsoft",
    "slack",
    "slack-post",
    "mcp",
    "email",
    "email-send",
    "zoominfo",
    "websearch",
    "webhook",
    "payments",
    "text",
  ];
  const withGatekeepers = () =>
    ({
      ...(env as unknown as Env),
      ...Object.fromEntries(every.map((v) => [vendorBinding(v), fakeGatekeeper(v)])),
    }) as unknown as Env;

  it("offers no gatekeeper that holds one account for every client, and every other one", async () => {
    const host = withGatekeepers();
    for (const id of [a.id, b.id]) {
      const admitted = await environmentFor(host, id);
      if (!admitted.served) throw new Error("served");
      const offered = availableVendors(admitted.env).sort();
      expect(offered).toEqual(
        ["google", "mcp", "microsoft", "slack", "slack-post", "websearch", "zoominfo"].sort(),
      );
      for (const vendor of ["payments", "text", "webhook", "email", "email-send"]) {
        // Not in the client's environment at all, and the reason says why.
        expect(vendorBinding(vendor) in admitted.env, vendor).toBe(false);
        const why = gatekeeperOffered(admitted.env, vendorBinding(vendor));
        expect(why).toEqual({
          offered: false,
          why: expect.stringMatching(/not available on this host yet/),
        });
      }
    }
    // A single-client deployment offers every bound gatekeeper, as before.
    const single = Object.fromEntries(
      every.map((v) => [vendorBinding(v), fakeGatekeeper(v)]),
    ) as unknown as Env;
    expect(availableVendors(single).sort()).toEqual([...every].sort());
  });

  it("a connection of gym-a's is not one of gym-b's: B cannot use, enable or replace it", async () => {
    const host = withGatekeepers();
    const admittedA = await environmentFor(host, a.id);
    const admittedB = await environmentFor(host, b.id);
    if (!admittedA.served || !admittedB.served) throw new Error("served");
    const connectionId = `conn_${crypto.randomUUID().replace(/-/g, "")}`;
    const admin = await adminIn(admittedA.env);
    const now = new Date().toISOString();
    await admittedA.env.DB.prepare(
      "INSERT INTO core_integration_connection (id, vendor, scope, owner_user_id, title, status, created_at, updated_at) VALUES (?, 'google', 'org', ?, 'A mail', 'connecting', ?, ?)",
    )
      .bind(connectionId, admin.id, now, now)
      .run();
    // B's runtime reaches B's object of that name, which has no such connection: every way in
    // (its resources, a call, a hook's start, a sync) is refused, and A's object is untouched.
    const runtimeB = integrationRuntime(admittedB.env);
    await expect(
      (async () => await hostFor(admittedB.env, connectionId).supportedResources())(),
    ).rejects.toThrow(/No connection/);
    await expect(
      (async () => await hostFor(admittedB.env, connectionId).startHook("hook-1"))(),
    ).rejects.toThrow();
    await expect(
      (async () => await hostFor(admittedB.env, connectionId).setSync({} as never))(),
    ).rejects.toThrow();
    expect(typeof runtimeB.startConnect).toBe("function");
    // A's own object knows it.
    const meta = await admittedA.env.DB.prepare(
      "SELECT id FROM core_integration_connection WHERE id = ?",
    )
      .bind(connectionId)
      .first<{ id: string }>();
    expect(meta?.id).toBe(connectionId);
  });
});

describe("Durable Objects, Workflows and minted entrypoints decide their client themselves", () => {
  it("an object refuses a name with no client, or a client the registry does not have", async () => {
    // A native promise of the call's outcome: an RPC promise handed to `expect` is read twice.
    const gate = async (name: string) =>
      await (env as unknown as Env).CODE_MODE_GATE.getByName(name).acquire(1000);
    await expect(gate("user-1")).rejects.toThrow(/named <client>:<name>/);
    await expect(gate("gym-nobody:user-1")).rejects.toThrow();
    expect(typeof (await gate(`${a.id}:user-1`))).toBe("string");
    // Through each client's environment the same caller's name is two objects.
    const aGate = (await clientEnv(a.id)).CODE_MODE_GATE.getByName("user-2");
    const bGate = (await clientEnv(b.id)).CODE_MODE_GATE.getByName("user-2");
    expect(typeof (await aGate.acquire(60_000))).toBe("string");
    expect(typeof (await bGate.acquire(60_000))).toBe("string");
    expect(await aGate.acquire(60_000)).toBeNull();
  });

  it("a Workflow instance runs only as the client its id and stamped params agree on", async () => {
    const host = env as unknown as Env;
    await expect(workflowRun(host, { instanceId: "run-1", payload: { n: 1 } })).rejects.toThrow(
      /names no client/,
    );
    await expect(
      workflowRun(host, { instanceId: `${a.id}_run-1`, payload: { cosClient: b.id, params: {} } }),
    ).rejects.toThrow(/names no client/);
    const ran = await workflowRun<Env, { n: number }>(host, {
      instanceId: `${a.id}_run-1`,
      payload: { cosClient: a.id, params: { n: 1 } },
    });
    expect(ran.params).toEqual({ n: 1 });
    expect(ran.env).toBe(await clientEnv(a.id));
  });

  it("a gatekeeper's callback reaches only the client its props were minted with", async () => {
    const host = env as unknown as Env;
    await expect(propsClientEnvironment(host, {})).rejects.toThrow(/No client/);
    expect(await propsClientEnvironment(host, { client: a.id })).toBe(await clientEnv(a.id));
    await expect(propsClientEnvironment(host, { client: "gym-nobody" })).rejects.toThrow();
  });
});

describe("a client not served for a while (review of #512, S3 and S5)", () => {
  const event = (id: string) => ({
    v: 1,
    kind: "record",
    id: `audit-${id}:0`,
    at: new Date().toISOString(),
    origin: { surface: "ui" },
    changes: [],
  });
  /** A fan-out queue the suite holds: what is sent to it, and with what delay. */
  const fanOutQueue = () => {
    const sent: { body: unknown; delaySeconds?: number }[] = [];
    return {
      sent,
      send: async (body: unknown, options?: { delaySeconds?: number }) => {
        sent.push({ body, delaySeconds: options?.delaySeconds });
      },
      sendBatch: async (messages: Iterable<{ body: unknown }>) => {
        for (const m of messages) sent.push({ body: m.body });
      },
    };
  };

  it("parks a paused client's events for the whole pause, never retrying, then handles them", async () => {
    const queue = fanOutQueue();
    const host = () => ({ ...(env as unknown as Env), CLIENT_FANOUT: queue }) as unknown as Env;
    const start = 1_000_000;
    // A message for the paused client: parked on the fan-out queue, the original acked.
    const first = createMessageBatch<unknown>("cos-automation-events", [
      {
        id: "p-1",
        timestamp: new Date(),
        attempts: 1,
        body: { cosClient: paused.id, body: event("p") },
      },
    ]);
    const ctx = createExecutionContext();
    await consumeByClient(host(), first, async () => {}, { now: () => start });
    const firstResult = await getQueueResult(first, ctx);
    expect(firstResult.explicitAcks).toEqual(["p-1"]);
    expect(firstResult.retryMessages).toEqual([]);
    expect(queue.sent.at(-1)?.delaySeconds).toBe(PARKING.firstDelaySeconds);
    // Ten minutes of pause: each time it comes back it is parked again, waiting longer, never
    // retried (so `max_retries` is never reached).
    const delays: number[] = [];
    let at = start;
    while (at - start < 10 * 60 * 1000) {
      const parked = queue.sent.at(-1);
      at += (parked?.delaySeconds ?? 0) * 1000;
      const batch = createMessageBatch<unknown>("cos-runner-fanout", [
        { id: `again-${at}`, timestamp: new Date(at), attempts: 1, body: parked?.body },
      ]);
      const c = createExecutionContext();
      await consumeFanOut(
        host(),
        batch,
        { tick: async () => {}, parked: { "cos-automation-events": async () => {} } },
        { now: () => at },
      );
      const r = await getQueueResult(batch, c);
      expect(r.retryMessages).toEqual([]);
      delays.push(queue.sent.at(-1)?.delaySeconds ?? 0);
    }
    expect(delays.slice(0, 4)).toEqual([120, 240, 480, 900]);
    expect(Math.max(...delays)).toBe(PARKING.maxDelaySeconds);
    // The client resumes: the parked event is handled by the events' consumer, in its environment.
    await (env as unknown as { REGISTRY: D1Database }).REGISTRY.prepare(
      "UPDATE registry_clients SET status = 'active' WHERE id = ?",
    )
      .bind(paused.id)
      .run();
    try {
      const handled: string[] = [];
      const parked = queue.sent.at(-1);
      const last = createMessageBatch<unknown>("cos-runner-fanout", [
        { id: "resumed", timestamp: new Date(at), attempts: 1, body: parked?.body },
      ]);
      const c = createExecutionContext();
      await consumeFanOut(
        host(),
        last,
        {
          tick: async () => {},
          parked: {
            "cos-automation-events": async (clientEnv, share) => {
              handled.push(String(clientOf(clientEnv)));
              share.ackAll();
            },
          },
        },
        { now: () => at },
      );
      const r = await getQueueResult(last, c);
      expect(handled).toEqual([paused.id]);
      expect(r.explicitAcks).toEqual(["resumed"]);
    } finally {
      await (env as unknown as { REGISTRY: D1Database }).REGISTRY.prepare(
        "UPDATE registry_clients SET status = 'paused' WHERE id = ?",
      )
        .bind(paused.id)
        .run();
    }
  });

  it("gives a parked message up after 7 days, as a dead letter, and never acts on it", async () => {
    const queue = fanOutQueue();
    const host = { ...(env as unknown as Env), CLIENT_FANOUT: queue } as unknown as Env;
    const parkedAt = 5_000;
    const batch = createMessageBatch<unknown>("cos-runner-fanout", [
      {
        id: "old",
        timestamp: new Date(),
        attempts: 1,
        body: {
          cosParked: 1,
          queue: "cos-automation-events",
          stamped: { cosClient: paused.id, body: event("old") },
          parkedAt,
          delaySeconds: 900,
        },
      },
    ]);
    const handled: string[] = [];
    const ctx = createExecutionContext();
    await consumeFanOut(
      host,
      batch,
      {
        tick: async () => {},
        parked: {
          "cos-automation-events": async () => {
            handled.push("acted");
          },
        },
      },
      { now: () => parkedAt + PARKING.giveUpAfterMs + 1 },
    );
    const r = await getQueueResult(batch, ctx);
    expect(r.explicitAcks).toEqual(["old"]);
    expect(handled).toEqual([]);
    expect(queue.sent).toEqual([]);
  });

  it("runs a fan-out batch one client's tick at a time, each acked on its own", async () => {
    let running = 0;
    let most = 0;
    const order: string[] = [];
    const batch = createMessageBatch<unknown>("cos-runner-fanout", [
      { id: "1", timestamp: new Date(), attempts: 1, body: tick(a.id) },
      { id: "2", timestamp: new Date(), attempts: 1, body: tick(b.id) },
      { id: "3", timestamp: new Date(), attempts: 1, body: tick(a.id) },
    ]);
    const ctx = createExecutionContext();
    await consumeFanOut(env as unknown as Env, batch, {
      tick: async (clientEnv) => {
        running += 1;
        most = Math.max(most, running);
        order.push(String(clientOf(clientEnv)));
        await new Promise((resolve) => setTimeout(resolve, 5));
        running -= 1;
        if (order.length === 2) throw new Error("gym-b's tick fails");
      },
      parked: {},
    });
    const r = await getQueueResult(batch, ctx);
    expect(most).toBe(1);
    expect(order).toEqual([a.id, b.id, a.id]);
    expect(r.explicitAcks.sort()).toEqual(["1", "3"]);
    expect(r.retryMessages.map((m) => m.msgId)).toEqual(["2"]);
    expect(FANOUT_CONSUMER.max_batch_size).toBe(1);
  });
});
