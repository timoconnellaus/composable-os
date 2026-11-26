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
import { type ActingUser, invokeByName, newId } from "@composable-os/core";
import { createCrmDb } from "@composable-os/db";
import { RUNNER_METHODS } from "@composable-os/db/client-bindings";
import { propsClientEnvironment, stampOf, workflowRun } from "@composable-os/db/client-entries";
import { environmentFor } from "@composable-os/db/client-environment";
import { setUpTwoClients, TWO_CLIENTS } from "@composable-os/db/testing/two-clients";
import { beforeAll, describe, expect, it } from "vitest";
import Runner, { ClientRunner, extensionHost } from "../src/index.ts";

const { a, b, paused, behind } = TWO_CLIENTS;

interface CallAs {
  callAs(client: string, method: string, args: unknown[]): Promise<unknown>;
  ping(): Promise<unknown>;
}
// The runner's real entry class, as the host's Workers reach it (SELF's test proxy cannot carry
// this Worker's own loopback bindings across).
const entry = new Runner(createExecutionContext(), env as unknown as Env) as unknown as CallAs;
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

describe("Durable Objects, Workflows and minted entrypoints decide their client themselves", () => {
  it("an object refuses a name with no client, or a client the registry does not have", async () => {
    const gate = (name: string) =>
      (env as unknown as Env).CODE_MODE_GATE.getByName(name).acquire(1000);
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
