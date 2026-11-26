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
  runInDurableObject,
} from "cloudflare:test";
import { type ActingUser, invokeByName, newId, vendorBinding } from "@composable-os/core";
import { createCrmDb } from "@composable-os/db";
import {
  clientObjectName,
  keepLoaderApart,
  RUNNER_METHODS,
} from "@composable-os/db/client-bindings";
import {
  consumeByClient,
  consumeFanOut,
  consumeParked,
  FANOUT_CONSUMER,
  gatekeeperOffered,
  isRunnerCaller,
  PARKING,
  PARKING_LEDGER_NAME,
  type ParkedConsumer,
  perClientMissing,
  propsClientEnvironment,
  RUNNER_CALLER,
  runnerCallerProps,
  stampOf,
  workflowRun,
} from "@composable-os/db/client-entries";
import { clientOf, environmentFor } from "@composable-os/db/client-environment";
import {
  CLIENT_OBJECT,
  ClientDurableObject,
  type ClientObject,
  refreshOnEachCall,
} from "@composable-os/db/client-objects";
import { PARKING_HORIZON_MS, type ParkingLedger } from "@composable-os/db/client-parking";
import { bindingProof, PROOF } from "@composable-os/db/client-proofs";
import type { ClientId } from "@composable-os/db/registry";
import { setUpTwoClients, TWO_CLIENTS } from "@composable-os/db/testing/two-clients";
import { beforeAll, describe, expect, it, vi } from "vitest";
import Runner, { ClientRunner, extensionHost } from "../src/index.ts";
import { availableVendors, hostFor, integrationRuntime } from "../src/integrations/runtime.ts";

const { a, b, paused, moving, behind } = TWO_CLIENTS;
/** The suite's object-naming key (vitest.two-client.config.ts). */
const KEY = "two-client-suite-binding-key-0123456789abcdef";
/** The suite's props key (packages/db/testing/vitest.ts, `TEST_PROPS_KEY`). */
const TEST_PROPS_KEY = (env as unknown as { COS_PROPS_KEY: string }).COS_PROPS_KEY;

interface CallAs {
  callAs(client: string, method: string, args: unknown[]): Promise<unknown>;
  ping(): Promise<unknown>;
}
// The runner's real entry class, as the host's Workers reach it (SELF's test proxy cannot carry
// this Worker's own loopback bindings across).
/** An execution context with the props the deploy fixes on cos-app's binding (S4). */
const fromApp = () =>
  Object.assign(createExecutionContext(), {
    props: runnerCallerProps(TEST_PROPS_KEY, "live"),
  }) as ExecutionContext;
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

  it("refuses every entry while the fake gatekeeper is on or bound, as the directory does", () => {
    for (const flags of [{ INTEGRATIONS_FAKE_PROVIDER: "true" }, { GATEKEEPER_FAKE: {} }]) {
      const host = { ...(env as unknown as Env), ...flags } as unknown as Env;
      expect(() => new Runner(fromApp(), host)).toThrow(/fake gatekeeper/);
    }
  });

  it("refuses callAs from any binding but the app's, whatever client it names (S4)", async () => {
    const stranger = new Runner(
      createExecutionContext(),
      env as unknown as Env,
    ) as unknown as CallAs;
    await expect(stranger.callAs(a.id, "ping", [])).rejects.toThrow(/only to the host's own app/);
    // Another caller, and the app's caller name copied without the proof (what code minting
    // `exports.default` could do), or with another key's: all refused.
    for (const props of [
      { caller: "cos-front" },
      { ...RUNNER_CALLER },
      runnerCallerProps(`${TEST_PROPS_KEY}x`, "live"),
      // The object-naming key's proof is no props proof (#515, S4: two keys).
      runnerCallerProps(KEY, "live"),
    ]) {
      const forged = new Runner(
        Object.assign(createExecutionContext(), { props }) as ExecutionContext,
        env as unknown as Env,
      ) as unknown as CallAs;
      await expect(forged.callAs(b.id, "ping", [])).rejects.toThrow(/only to the host's own app/);
    }
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
      (name) =>
        !["constructor", "callAs", "gatekeeperCallback", "queue", "scheduled", "fetch"].includes(
          name,
        ),
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
    const parked: unknown[] = [];
    const host = {
      ...(env as unknown as Env),
      CLIENT_PARKING: { send: async (body: unknown) => void parked.push(body) },
    } as unknown as Env;
    const ctx = createExecutionContext();
    await new Runner(ctx, host).queue(batch);
    const result = await getQueueResult(batch, ctx);
    // The client behind the code's schema waits: parked, acked, never retried.
    expect(result.explicitAcks.sort()).toEqual(["e-a", "e-b", "e-behind"]);
    expect(result.retryMessages.map((m) => m.msgId).sort()).toEqual(["e-none"]);
    expect(parked).toMatchObject([{ cosParked: 1, stamped: { cosClient: behind.id } }]);
  });

  it("are refused whole, with what is missing said, on a host of many clients with no parking (review of #520, M5)", async () => {
    const batch = createMessageBatch<unknown>("cos-automation-events", [
      { id: "e-p", timestamp: new Date(), attempts: 1, body: { cosClient: paused.id, body: {} } },
    ]);
    const host = { ...(env as unknown as Env), CLIENT_PARKING_LEDGER: undefined } as unknown as Env;
    await expect(new Runner(createExecutionContext(), host).queue(batch)).rejects.toThrow(
      /binds CLIENT_PARKING and CLIENT_PARKING_LEDGER/,
    );
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

  it("a worker id named through one client's LOADER is never another client's warm worker (review of #520, M3)", async () => {
    const code = () => ({
      compatibilityDate: "2026-10-01",
      mainModule: "m.js",
      modules: {
        "m.js":
          "let n = 0; export default { fetch() { n += 1; return new Response(String(n)); } };",
      },
    });
    const count = async (loader: WorkerLoader, id: string) =>
      Number(await (await loader.get(id, code).getEntrypoint().fetch("https://w/")).text());
    const aLoader = (await clientEnv(a.id)).LOADER;
    const bLoader = (await clientEnv(b.id)).LOADER;
    expect(await count(bLoader, "probe-m3")).toBe(1);
    expect(await count(bLoader, "probe-m3")).toBe(2);
    // gym-b's worker as the real Worker Loader knows it, asked for through gym-a's: a new one.
    expect(await count(aLoader, "client:gym-b:probe-m3")).toBe(1);
    expect(await count(aLoader, "probe-m3")).toBe(1);
    expect(await count(bLoader, "probe-m3")).toBe(3);
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
      // The client's own LOADER (keepLoaderApart) over a recorder of what the real one is asked.
      const host = extensionHost(clientEnvironment, {
        loader: keepLoaderApart(counting(env.LOADER), client as ClientId),
      });
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

describe("the runner's bindings to the clients' databases (stage 66 step 2)", () => {
  it("are the query path only: no raw CLIENT_DB, and a client's DB goes through the service", async () => {
    const host = env as unknown as Record<string, unknown>;
    expect("CLIENT_DB" in host).toBe(false);
    expect(host.CLIENT_DB_QUERIES).toBeDefined();
    const aEnv = await clientEnv(a.id);
    expect(await aEnv.DB.prepare("SELECT 1 AS one").first("one")).toBe(1);
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

  it("the callback door reaches only a shared gatekeeper's own fetch, from the app's binding", async () => {
    const host = withGatekeepers();
    const door = new Runner(fromApp(), host) as unknown as {
      gatekeeperCallback(vendor: string, request: Request): Promise<Response>;
    };
    const at = (vendor: string) =>
      door.gatekeeperCallback(vendor, new Request(`https://callbacks.test/gatekeeper/${vendor}/x`));
    expect(await (await at("google")).text()).toBe("google");
    for (const vendor of ["payments", "text", "webhook", "email", "email-send", "nobody"]) {
      expect((await at(vendor)).status, vendor).toBe(404);
    }
    const stranger = new Runner(createExecutionContext(), host) as unknown as typeof door;
    await expect(
      stranger.gatekeeperCallback(
        "google",
        new Request("https://callbacks.test/gatekeeper/google/x"),
      ),
    ).rejects.toThrow(/only to the host's own app/);
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
    // With the raw namespace, code without the host's key cannot name a client's object: the
    // plain `<client>:<name>`, a made-up proof and another name's proof are refused (S1).
    await expect(gate(`${b.id}:user-1`)).rejects.toThrow(/named <client>:<name>/);
    await expect(gate(`${b.id}:${"0".repeat(32)}:user-1`)).rejects.toThrow();
    const otherProof = clientObjectName(b.id as ClientId, b.generation, "user-9", KEY).split(
      ":",
    )[1];
    await expect(gate(`${b.id}:${otherProof}:user-1`)).rejects.toThrow();
    expect(
      typeof (await gate(clientObjectName(a.id as ClientId, a.generation, "user-1", KEY))),
    ).toBe("string");
    // Through each client's environment the same caller's name is two objects.
    const aGate = (await clientEnv(a.id)).CODE_MODE_GATE.getByName("user-2");
    const bGate = (await clientEnv(b.id)).CODE_MODE_GATE.getByName("user-2");
    expect(typeof (await aGate.acquire(60_000))).toBe("string");
    expect(typeof (await bGate.acquire(60_000))).toBe("string");
    expect(await aGate.acquire(60_000)).toBeNull();
  });

  it("an object named for an earlier client of the same id is refused (#515, S3)", async () => {
    // What gym-a's objects were called before it was removed and added again: another generation.
    const earlier = clientObjectName(a.id as ClientId, "f6".repeat(16), "user-3", KEY);
    await expect(
      (async () => await (env as unknown as Env).CODE_MODE_GATE.getByName(earlier).acquire(1000))(),
    ).rejects.toThrow(/not the host's for its client/);
  });

  it("an object's code holds its client's environment only, and signs for its own client only (#515, S2)", async () => {
    const stub = (await clientEnv(a.id)).INTEGRATION_HOST.getByName("conn-s2");
    await runInDurableObject(stub as never, async (instance: object) => {
      const objectEnv = (instance as { env: Record<string, unknown> }).env;
      // The host's keys, the registry, every client's databases and the raw namespaces: absent.
      for (const name of [
        "COS_BINDING_KEY",
        "COS_PROPS_KEY",
        "COS_ROOT_KEY",
        "REGISTRY",
        "CLIENT_DB",
        "CLIENT_DB_QUERIES",
        "CLIENT_FANOUT",
        "CLIENT_PARKING",
        "CLIENT_PARKING_LEDGER",
      ]) {
        expect(objectEnv[name], name).toBeUndefined();
        expect(name in objectEnv, name).toBe(false);
      }
      expect(Object.keys(objectEnv)).toEqual(Object.keys(await clientEnv(a.id)));
      expect(objectEnv.COS_CLIENT_ID).toBe(a.id);
      // It answers as gym-a's environment to the checks that tell one (review of #520, M1).
      expect(clientOf(objectEnv)).toBe(a.id);
      expect(perClientMissing(objectEnv, "MCP_RESOURCE_NOT_A_NAME")).toMatch(/each client's own/);
      // Its namespaces are gym-a's wrappers: the same name through them is gym-a's object.
      const viaObject = (objectEnv.CODE_MODE_GATE as DurableObjectNamespace).idFromName("user-s2");
      const viaA = (await clientEnv(a.id)).CODE_MODE_GATE.idFromName("user-s2");
      expect(viaObject.equals(viaA)).toBe(true);
      // Nothing is written through it.
      expect(Reflect.set(objectEnv, "REGISTRY", {})).toBe(false);
      // Its proof is of gym-a, its generation and the parts: there is no client to pass.
      const owner = (instance as Record<symbol, ClientObject<Env>>)[CLIENT_OBJECT];
      expect(owner?.proof(PROOF.callback, "conn-s2")).toBe(
        bindingProof(TEST_PROPS_KEY, PROOF.callback, "live", a.id, a.generation, "conn-s2"),
      );
      expect(owner?.proof(PROOF.callback, b.id, "conn-s2")).not.toBe(
        bindingProof(TEST_PROPS_KEY, PROOF.callback, "live", b.id, b.generation, "conn-s2"),
      );
    });
  });

  it("an object reaches no other client's parking ledger, nor the fake gatekeeper, through ctx.exports (review of #520, S3)", async () => {
    const stub = (await clientEnv(a.id)).INTEGRATION_HOST.getByName("conn-s3");
    await runInDurableObject(stub as never, async (instance: object) => {
      const { exports } = (instance as { ctx: { exports: Record<string, DurableObjectNamespace> } })
        .ctx;
      const raw = exports.ParkingLedger as unknown as DurableObjectNamespace<ParkingLedger>;
      // gym-b's ledger by its id, by a made-up proof, by gym-a's proof: each refused.
      const aProof = clientObjectName(
        a.id as ClientId,
        a.generation,
        PARKING_LEDGER_NAME,
        KEY,
      ).split(":")[1];
      for (const name of [
        b.id,
        `${b.id}:${"0".repeat(32)}:${PARKING_LEDGER_NAME}`,
        `${b.id}:${aProof}:${PARKING_LEDGER_NAME}`,
        clientObjectName(b.id as ClientId, "f6".repeat(16), PARKING_LEDGER_NAME, KEY),
      ]) {
        const ledger = raw.get(raw.idFromName(name));
        await expect((async () => await ledger.admit("probe", 0, 0))(), name).rejects.toThrow();
        await expect((async () => await ledger.stats())(), name).rejects.toThrow();
        await expect((async () => await ledger.settle("probe", true))(), name).rejects.toThrow();
      }
      // The fake gatekeeper's classes refuse to be built on a host of many clients.
      // Each through a method it has, so only the refusal can fail the call.
      for (const [name, method] of [
        ["FakeAccount", "describe"],
        ["FakeProvider", "messages"],
      ] as const) {
        const namespace = exports[name] as unknown as DurableObjectNamespace;
        const fake = namespace.get(namespace.idFromName("x")) as unknown as Record<
          string,
          () => Promise<unknown>
        >;
        await expect((async () => await fake[method]?.())(), name).rejects.toThrow(
          /never on a host of many clients/,
        );
      }
    });
    // gym-b's real ledger, as the host's parking names it, saw none of it.
    const ledgers = (
      env as unknown as { CLIENT_PARKING_LEDGER: DurableObjectNamespace<ParkingLedger> }
    ).CLIENT_PARKING_LEDGER;
    const bLedger = ledgers.get(
      ledgers.idFromName(
        clientObjectName(b.id as ClientId, b.generation, PARKING_LEDGER_NAME, KEY),
      ),
    );
    expect(await bLedger.stats()).toEqual({ parked: 0, givenUpTotal: 0 });
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

  it("a gatekeeper's callback reaches only the client its props were minted with, with the host's proof", async () => {
    const host = env as unknown as Env;
    const generation = (client: string) =>
      client === a.id ? a.generation : client === b.id ? b.generation : "";
    const minted = (client: string, connection: string, key = TEST_PROPS_KEY) => ({
      client,
      proof: bindingProof(key, PROOF.callback, "live", client, generation(client), connection),
    });
    await expect(propsClientEnvironment(host, {}, PROOF.callback, "c")).rejects.toThrow(
      /No client/,
    );
    expect(await propsClientEnvironment(host, minted(a.id, "c"), PROOF.callback, "c")).toBe(
      await clientEnv(a.id),
    );
    // What code without the key mints through ctx.exports: no proof, another client's, another
    // connection's, another purpose's, or one for an earlier client of the id (S1; #515, S3).
    for (const props of [
      { client: b.id },
      { client: b.id, proof: minted(a.id, "c").proof },
      { client: b.id, proof: minted(b.id, "other").proof },
      {
        client: b.id,
        proof: bindingProof(TEST_PROPS_KEY, PROOF.clientApp, "live", b.id, b.generation),
      },
      {
        client: b.id,
        proof: bindingProof(TEST_PROPS_KEY, PROOF.callback, "live", b.id, "f6".repeat(16), "c"),
      },
      minted(b.id, "c", `${TEST_PROPS_KEY}-other`),
    ]) {
      await expect(propsClientEnvironment(host, props, PROOF.callback, "c")).rejects.toThrow(
        /not minted by the host/,
      );
    }
    await expect(
      propsClientEnvironment(host, minted("gym-nobody", "c"), PROOF.callback, "c"),
    ).rejects.toThrow();
  });

  it("props signed with the key before a rotation are still accepted, and never made (#515, S4)", async () => {
    const host = {
      ...(env as unknown as Env),
      COS_PROPS_KEY: `${TEST_PROPS_KEY}-new`,
      COS_PROPS_KEY_PREVIOUS: TEST_PROPS_KEY,
    } as unknown as Env;
    const old = {
      client: a.id,
      proof: bindingProof(TEST_PROPS_KEY, PROOF.callback, "live", a.id, a.generation, "c"),
    };
    await expect(propsClientEnvironment(host, old, PROOF.callback, "c")).resolves.toBeTruthy();
    // Once the previous key is dropped, the old props are no proof.
    const after = { ...host, COS_PROPS_KEY_PREVIOUS: undefined } as unknown as Env;
    await expect(propsClientEnvironment(after, old, PROOF.callback, "c")).rejects.toThrow(
      /not minted by the host/,
    );
    // The runner's caller props rotate the same way.
    expect(isRunnerCaller(runnerCallerProps(TEST_PROPS_KEY, "live"), host)).toBe(true);
    expect(isRunnerCaller(runnerCallerProps(TEST_PROPS_KEY, "live"), after)).toBe(false);
  });
});

describe("a client not served for a while (review of #512, S3 and S5; #515)", () => {
  const event = (id: string) => ({
    v: 1,
    kind: "record",
    id: `audit-${id}:0`,
    at: new Date().toISOString(),
    origin: { surface: "ui" },
    changes: [],
  });
  /** A queue the suite holds: what is sent to it, and with what delay. */
  const heldQueue = () => {
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
  const setStatus = (id: string, status: string) =>
    (env as unknown as { REGISTRY: D1Database }).REGISTRY.prepare(
      "UPDATE registry_clients SET status = ? WHERE id = ?",
    )
      .bind(status, id)
      .run();
  const ledgers = () =>
    (env as unknown as { CLIENT_PARKING_LEDGER: DurableObjectNamespace<ParkingLedger> })
      .CLIENT_PARKING_LEDGER;
  /** A client's ledger as the host's parking names it (review of #520, S3). */
  const generationOf = (client: string) =>
    Object.values(TWO_CLIENTS).find((c) => c.id === client)?.generation ?? "";
  const ledgerOf = (client: string) =>
    ledgers().get(
      ledgers().idFromName(
        clientObjectName(client as ClientId, generationOf(client), PARKING_LEDGER_NAME, KEY),
      ),
    );
  const automationConsumer = (
    consume: ParkedConsumer<Env>["consume"] = async () => {},
  ): Record<string, ParkedConsumer<Env>> => ({
    "cos-automation-events": { consume, maxRetries: 5, retryDelaySeconds: 10 },
  });
  /** One delivery of the parking queue's message `body`, consumed. */
  const deliver = async (
    host: Env,
    body: unknown,
    consumers: Record<string, ParkedConsumer<Env>>,
    at: number,
    id = `delivery-${crypto.randomUUID()}`,
  ) => {
    const batch = createMessageBatch<unknown>("cos-runner-parking", [
      { id, timestamp: new Date(at), attempts: 1, body },
    ]);
    const ctx = createExecutionContext();
    await consumeParked(host, batch, consumers, { now: () => at });
    return getQueueResult(batch, ctx);
  };

  it("parks a paused client's events on the parking queue for the whole pause, never retrying, then handles them", async () => {
    const parking = heldQueue();
    const fanOut = heldQueue();
    const host = () =>
      ({
        ...(env as unknown as Env),
        CLIENT_PARKING: parking,
        CLIENT_FANOUT: fanOut,
      }) as unknown as Env;
    const start = 1_000_000;
    // A message for the paused client: parked on the parking queue, the original acked.
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
    expect(parking.sent.at(-1)?.delaySeconds).toBe(PARKING.firstDelaySeconds);
    expect(parking.sent.at(-1)?.body).toMatchObject({
      cosParked: 1,
      queue: "cos-automation-events",
      generation: paused.generation,
      failures: 0,
    });
    // The crons' fan-out queue carries nothing of it: ticks never wait behind a backlog (S5).
    expect(fanOut.sent).toEqual([]);
    // Ten minutes of pause: each time it comes back it is parked again, waiting longer, never
    // retried (so `max_retries` is never reached).
    const delays: number[] = [];
    let at = start;
    while (at - start < 10 * 60 * 1000) {
      const parked = parking.sent.at(-1);
      at += (parked?.delaySeconds ?? 0) * 1000;
      const r = await deliver(host(), parked?.body, automationConsumer(), at);
      expect(r.retryMessages).toEqual([]);
      delays.push(parking.sent.at(-1)?.delaySeconds ?? 0);
    }
    expect(delays.slice(0, 4)).toEqual([120, 240, 480, 900]);
    expect(Math.max(...delays)).toBe(PARKING.maxDelaySeconds);
    // The client resumes: the parked event is handled by the events' consumer, in its environment.
    await setStatus(paused.id, "active");
    try {
      const handled: string[] = [];
      const parked = parking.sent.at(-1);
      const r = await deliver(
        host(),
        parked?.body,
        automationConsumer(async (clientEnv, share) => {
          handled.push(String(clientOf(clientEnv)));
          share.ackAll();
        }),
        at,
        "resumed",
      );
      expect(handled).toEqual([paused.id]);
      expect(r.explicitAcks).toEqual(["resumed"]);
      // Handled once: delivered again (queues deliver at least once), it is dropped.
      const again = await deliver(
        host(),
        parked?.body,
        automationConsumer(async () => {
          handled.push("twice");
        }),
        at,
      );
      expect(handled).toEqual([paused.id]);
      expect(again.explicitAcks.length).toBe(1);
    } finally {
      await setStatus(paused.id, "paused");
    }
  });

  it("leaves no ledger row for a message it could not send, handles one sent but not recorded, and forgets old rows (review of #520, M5)", async () => {
    const ledger = ledgerOf(moving.id);
    const before = (await ledger.stats()).parked;
    // The send fails: the message is retried on its own queue, and nothing counts towards the cap.
    const failing = {
      ...(env as unknown as Env),
      CLIENT_PARKING: {
        send: async () => {
          throw new Error("queue down");
        },
      },
    } as unknown as Env;
    const batch = createMessageBatch<unknown>("cos-automation-events", [
      {
        id: "m-x",
        timestamp: new Date(),
        attempts: 1,
        body: { cosClient: moving.id, body: event("x") },
      },
    ]);
    const ctx = createExecutionContext();
    await consumeByClient(failing, batch, async () => {});
    const result = await getQueueResult(batch, ctx);
    expect(result.retryMessages.map((m) => m.msgId)).toEqual(["m-x"]);
    expect((await ledger.stats()).parked).toBe(before);
    // Sent, but its row never written: its delivery handles it, and says so.
    await setStatus(moving.id, "active");
    const warned: string[] = [];
    const warn = vi.spyOn(console, "warn").mockImplementation((line: string) => {
      warned.push(String(line));
    });
    try {
      const handled: string[] = [];
      const r = await deliver(
        { ...(env as unknown as Env), CLIENT_PARKING: heldQueue() } as unknown as Env,
        {
          cosParked: 1,
          id: crypto.randomUUID(),
          queue: "cos-automation-events",
          stamped: { cosClient: moving.id, body: event("unrecorded") },
          generation: moving.generation,
          parkedAt: Date.now(),
          delaySeconds: 60,
          failures: 0,
        },
        automationConsumer(async (_clientEnv, share) => {
          handled.push("handled");
          share.ackAll();
        }),
        Date.now(),
      );
      expect(handled).toEqual(["handled"]);
      expect(r.explicitAcks.length).toBe(1);
      expect(warned.some((line) => line.includes("cos.queue.parked_unrecorded"))).toBe(true);
      expect(warned.join("\n")).not.toContain("audit-unrecorded");
    } finally {
      warn.mockRestore();
      await setStatus(moving.id, "moving");
    }
    // A row older than the horizon (its delivery never came) is forgotten on the next admit
    // (on a ledger no other test counts).
    const aside = ledgerOf(behind.id);
    const old = crypto.randomUUID();
    await aside.admit(old, 0, PARKING.maxPerClient, 0);
    const counted = (await aside.stats()).parked;
    await aside.admit(
      crypto.randomUUID(),
      PARKING_HORIZON_MS + 10,
      PARKING.maxPerClient,
      PARKING_HORIZON_MS + 10,
    );
    expect((await aside.stats()).parked).toBe(counted);
  });

  it("acks a message once its copy is parked even when the ledger fails, and parks a redelivery under the same id, handled once (issue #523, F2)", async () => {
    const parking = heldQueue();
    const real = ledgers();
    const brokenLedger = {
      idFromName: (name: string) => real.idFromName(name),
      get: () => ({
        admit: async () => {
          throw new Error("ledger down");
        },
      }),
    };
    const original = () =>
      createMessageBatch<unknown>("cos-automation-events", [
        {
          id: "f2-original",
          timestamp: new Date(),
          attempts: 1,
          body: { cosClient: paused.id, body: event("f2") },
        },
      ]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      // Sent, its row not written: acked, not retried (a retry would park a second copy).
      const first = original();
      const ctx = createExecutionContext();
      await consumeByClient(
        {
          ...(env as unknown as Env),
          CLIENT_PARKING: parking,
          CLIENT_PARKING_LEDGER: brokenLedger,
        } as unknown as Env,
        first,
        async () => {},
      );
      const r = await getQueueResult(first, ctx);
      expect(r.explicitAcks).toEqual(["f2-original"]);
      expect(r.retryMessages).toEqual([]);
      expect(parking.sent.length).toBe(1);
    } finally {
      warn.mockRestore();
    }
    // The queue delivers the original again anyway (at least once): parked under the same id.
    const again = original();
    const ctx2 = createExecutionContext();
    await consumeByClient(
      { ...(env as unknown as Env), CLIENT_PARKING: parking } as unknown as Env,
      again,
      async () => {},
    );
    await getQueueResult(again, ctx2);
    expect(parking.sent.length).toBe(2);
    const [one, two] = parking.sent.map((s) => s.body as { id: string });
    expect(one?.id).toBe(two?.id);
    // Each copy is delivered once the client is served: the event is handled once.
    await setStatus(paused.id, "active");
    try {
      const handled: string[] = [];
      const consumer = automationConsumer(async (_clientEnv, share) => {
        handled.push("handled");
        share.ackAll();
      });
      for (const copy of parking.sent) {
        await deliver(
          { ...(env as unknown as Env), CLIENT_PARKING: heldQueue() } as unknown as Env,
          copy.body,
          consumer,
          Date.now(),
        );
      }
      expect(handled).toEqual(["handled"]);
    } finally {
      await setStatus(paused.id, "paused");
    }
  });

  it("retries a parked message as its own queue would, then gives it up (#515)", async () => {
    const parking = heldQueue();
    const host = { ...(env as unknown as Env), CLIENT_PARKING: parking } as unknown as Env;
    const id = crypto.randomUUID();
    await ledgerOf(a.id).admit(id, 1, PARKING.maxPerClient);
    let body: unknown = {
      cosParked: 1,
      id,
      queue: "cos-automation-events",
      stamped: { cosClient: a.id, body: event("retry") },
      generation: a.generation,
      parkedAt: Date.now(),
      delaySeconds: 60,
      failures: 0,
    };
    let tries = 0;
    const failing = automationConsumer(async (_clientEnv, share) => {
      tries += 1;
      share.retryAll();
    });
    // cos-automation-events retries 5 times, 10 s apart: so does its parked message.
    for (let i = 1; i <= 5; i++) {
      await deliver(host, body, failing, Date.now());
      expect(parking.sent.at(-1)).toMatchObject({ delaySeconds: 10, body: { failures: i } });
      body = parking.sent.at(-1)?.body;
    }
    const sentBefore = parking.sent.length;
    const r = await deliver(host, body, failing, Date.now());
    expect(tries).toBe(6);
    expect(r.explicitAcks.length).toBe(1);
    expect(parking.sent.length).toBe(sentBefore);
    expect((await ledgerOf(a.id).stats()).givenUpTotal).toBeGreaterThanOrEqual(1);
  });

  it("gives up a client's oldest parked messages over its cap, counted, never acting on them (#515, S5)", async () => {
    const parking = heldQueue();
    const host = { ...(env as unknown as Env), CLIENT_PARKING: parking } as unknown as Env;
    const ledger = ledgerOf(moving.id);
    const before = (await ledger.stats()).givenUpTotal;
    const cap = 3;
    const ids = ["m-1", "m-2", "m-3", "m-4", "m-5"];
    const gaveUp: string[] = [];
    for (const [i, id] of ids.entries()) gaveUp.push(...(await ledger.admit(id, i, cap, i)));
    expect(gaveUp).toEqual(["m-1", "m-2"]);
    expect(await ledger.stats()).toEqual({ parked: 3, givenUpTotal: before + 2 });
    // When one given up comes back from the queue, it is not handled.
    await setStatus(moving.id, "active");
    try {
      const handled: string[] = [];
      const r = await deliver(
        host,
        {
          cosParked: 1,
          id: "m-1",
          queue: "cos-automation-events",
          stamped: { cosClient: moving.id, body: event("m-1") },
          generation: moving.generation,
          parkedAt: 0,
          delaySeconds: 60,
          failures: 0,
        },
        automationConsumer(async () => {
          handled.push("acted");
        }),
        1,
      );
      expect(handled).toEqual([]);
      expect(r.explicitAcks.length).toBe(1);
    } finally {
      await setStatus(moving.id, "moving");
    }
    // The cap the host uses.
    expect(PARKING.maxPerClient).toBe(1000);
  });

  it("gives a parked message up after 7 days, or when parked for an earlier client of its id", async () => {
    const parking = heldQueue();
    const host = { ...(env as unknown as Env), CLIENT_PARKING: parking } as unknown as Env;
    const parkedAt = 5_000;
    const handled: string[] = [];
    const acting = automationConsumer(async () => {
      handled.push("acted");
    });
    const parkedFor = async (client: string, generation: string) => {
      const id = crypto.randomUUID();
      await ledgerOf(client).admit(id, parkedAt, PARKING.maxPerClient);
      return {
        cosParked: 1,
        id,
        queue: "cos-automation-events",
        stamped: { cosClient: client, body: event(id) },
        generation,
        parkedAt,
        delaySeconds: 900,
        failures: 0,
      };
    };
    const old = await deliver(
      host,
      await parkedFor(paused.id, paused.generation),
      acting,
      parkedAt + PARKING.giveUpAfterMs + 1,
    );
    expect(old.explicitAcks.length).toBe(1);
    // gym-a now is not the gym-a it was parked for (S3).
    const earlier = await deliver(host, await parkedFor(a.id, "f6".repeat(16)), acting, parkedAt);
    expect(earlier.explicitAcks.length).toBe(1);
    expect(handled).toEqual([]);
    expect(parking.sent).toEqual([]);
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
    await consumeFanOut(env as unknown as Env, batch, async (clientEnv) => {
      running += 1;
      most = Math.max(most, running);
      order.push(String(clientOf(clientEnv)));
      await new Promise((resolve) => setTimeout(resolve, 5));
      running -= 1;
      if (order.length === 2) throw new Error("gym-b's tick fails");
    });
    const r = await getQueueResult(batch, ctx);
    expect(most).toBe(1);
    expect(order).toEqual([a.id, b.id, a.id]);
    expect(r.explicitAcks.sort()).toEqual(["1", "3"]);
    expect(r.retryMessages.map((m) => m.msgId)).toEqual(["2"]);
    expect(FANOUT_CONSUMER.max_batch_size).toBe(1);
  });
});

/** A base class shaped as a Durable Object's, with an inherited sync and async method. */
class ProbeBase {
  ctx: DurableObjectState;
  env: unknown;
  constructor(ctx: DurableObjectState, env: unknown) {
    this.ctx = ctx;
    this.env = env;
  }
  inheritedSync(): string {
    return "inherited";
  }
}

/** An object class with a sync method, an inherited one and a plain-promise one (#515). */
class Probe extends ClientDurableObject(ProbeBase) {
  sync(): number {
    return 1;
  }
  promised(): Promise<number> {
    return Promise.resolve(2);
  }
  callsItsOwn(): number {
    return this.sync() + 1;
  }
}
refreshOnEachCall(Probe);

describe("a warm object of a client that stops being served (review of #512, M2; #515)", () => {
  it("refuses its next call once the registry pauses the client, and serves again on resume", async () => {
    const registry = (env as unknown as { REGISTRY: D1Database }).REGISTRY;
    const gate = (await clientEnv(b.id)).CODE_MODE_GATE.getByName("warm-user");
    const acquire = async () => await gate.acquire(1_000);
    expect(typeof (await acquire())).toBe("string");
    // An object of each kind of method, warm: a sync one, an inherited one, one that answers a
    // promise without being an async function (#515: no method is skipped for how it is written).
    const ctx = {
      id: { name: clientObjectName(b.id as ClientId, b.generation, "probe", KEY) },
      blockConcurrencyWhile: (run: () => Promise<unknown>) => run(),
    } as unknown as DurableObjectState;
    const probe = new Probe(ctx, env);
    await (probe as unknown as Record<symbol, ClientObject<Env>>)[CLIENT_OBJECT]?.refresh();
    expect(probe.sync()).toBe(1);
    expect(probe.inheritedSync()).toBe("inherited");
    expect(await probe.promised()).toBe(2);
    expect(probe.callsItsOwn()).toBe(2);
    await registry
      .prepare("UPDATE registry_clients SET status = 'paused' WHERE id = ?")
      .bind(b.id)
      .run();
    try {
      // The object's isolate reads the registry's stamp at most every 10 seconds.
      await new Promise((resolve) => setTimeout(resolve, 10_500));
      await expect(acquire()).rejects.toThrow(/not served now|paused/);
      for (const call of [
        () => probe.sync(),
        () => probe.inheritedSync(),
        () => probe.promised(),
        () => probe.callsItsOwn(),
      ]) {
        await expect((async () => await call())()).rejects.toThrow(/not served now/);
      }
    } finally {
      await registry
        .prepare("UPDATE registry_clients SET status = 'active' WHERE id = ?")
        .bind(b.id)
        .run();
    }
    await new Promise((resolve) => setTimeout(resolve, 10_500));
    // A stub of a reset object stays broken: a new one reaches the object again.
    const fresh = (await clientEnv(b.id)).CODE_MODE_GATE.getByName("warm-user");
    await expect((async () => await fresh.acquire(1_000))()).resolves.toBeDefined();
    expect(await probe.sync()).toBe(1);
  }, 40_000);
});
