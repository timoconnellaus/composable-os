// Each client's work in the runner runs in that client's scope (stage 66 step 5, ADR 0617; review
// of #522, S1 and M5). This suite's Worker gives core a store that refuses code outside every
// scope, as a many-client host's entry gives it (src/client-scope.ts), so a path that loses its
// client's scope fails here with `NoClientScopeError`:
// - a record-triggered automation's Workflow runs to completion for each client: its steps run in
//   `step.do` callbacks, and its extension code calls back through Worker Loader, both of which
//   the runtime enters with no AsyncLocalStorage context;
// - `callAs` runs a method that reads the schema registry outside any operation (test mode);
// - a fan-out tick starts a client's due schedule automation.
import {
  createExecutionContext,
  createMessageBatch,
  getQueueResult,
  introspectWorkflow,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
  type ActingUser,
  type AutomationQueueMessage,
  currentClientId,
  type InvocationContext,
  invokeByName,
  memoryEventSink,
  newId,
  recordIntegrationEvents,
} from "@composable-os/core";
import { createCrmDb } from "@composable-os/db";
import { clientObjectName } from "@composable-os/db/client-bindings";
import { PARKING, PARKING_LEDGER_NAME, runnerCallerProps } from "@composable-os/db/client-entries";
import { environmentFor } from "@composable-os/db/client-environment";
import { CLIENT_OBJECT, refreshOnEachCall } from "@composable-os/db/client-objects";
import type { ParkingLedger } from "@composable-os/db/client-parking";
import type { ClientId } from "@composable-os/db/registry";
import { setUpTwoClients, TWO_CLIENTS } from "@composable-os/db/testing/two-clients";
import { beforeAll, describe, expect, it } from "vitest";
import { automationHost } from "../src/automations/host.ts";
import { clientKeyOf } from "../src/client-scope.ts";
import { RunHost, type RunState } from "../src/executor/host.ts";
import Runner, { extensionHost } from "../src/index.ts";
import { FIXTURE_FILES, FIXTURE_ID, ITEM } from "../test/automation-fixture.ts";

const { a, b } = TWO_CLIENTS;
const TEST_PROPS_KEY = (env as unknown as { COS_PROPS_KEY: string }).COS_PROPS_KEY;
/** The suite's object-naming key (vitest.two-client.config.ts). */
const OBJECT_KEY = "two-client-suite-binding-key-0123456789abcdef";

interface Client {
  id: string;
  env: Env;
  admin: ActingUser;
  context(overrides?: Partial<InvocationContext>): InvocationContext;
}

const clients: Client[] = [];

async function clientEnv(id: string): Promise<Env> {
  const found = await environmentFor(env as unknown as Env, id);
  if (!found.served) throw new Error(`no environment for ${id}`);
  return found.env;
}

/** The runner's real entry, called as cos-app's binding calls it. */
function entry(ctx: ExecutionContext = createExecutionContext()): Runner {
  Object.assign(ctx, { props: runnerCallerProps(TEST_PROPS_KEY, "live") });
  // The parking queue a many-client host binds beside its ledger (nothing is parked here).
  const host = {
    ...(env as unknown as Env),
    CLIENT_PARKING: { send: async () => {}, sendBatch: async () => {} },
  } as unknown as Env;
  return new Runner(ctx, host);
}

async function setUp(id: string): Promise<Client> {
  const cEnv = await clientEnv(id);
  const userId = newId("user");
  const now = new Date().toISOString();
  await cEnv.DB.prepare(
    "INSERT INTO core_user (id, name, email, email_verified, created_at, updated_at, role) VALUES (?, 'Admin', ?, 1, ?, ?, 'admin')",
  )
    .bind(userId, `admin-${userId}@example.com`, now, now)
    .run();
  await cEnv.DB.prepare("UPDATE core_settings SET value = ? WHERE key = 'approval_policy'")
    .bind(JSON.stringify({ preset: "balanced" }))
    .run();
  const admin: ActingUser = {
    id: userId,
    email: `admin-${userId}@example.com`,
    name: "Admin",
    role: "admin",
  };
  const client: Client = {
    id,
    env: cEnv,
    admin,
    context: (overrides = {}) => ({
      actor: "human",
      user: admin,
      origin: { surface: "ui" },
      db: createCrmDb(cEnv.DB),
      extensionHost: extensionHost(cEnv),
      automationHost: automationHost(cEnv),
      ...overrides,
    }),
  };
  await invokeByName(
    "extension.install",
    { id: FIXTURE_ID, files: FIXTURE_FILES },
    client.context(),
  );
  return client;
}

/** Runs every Workflow instance `fn` creates to completion (sleeps and retry delays off). */
async function toCompletion<T>(fn: () => Promise<T>): Promise<T> {
  await using introspector = await introspectWorkflow(env.AUTOMATION_WORKFLOW);
  await introspector.modifyAll(async (m) => {
    await m.disableSleeps();
    await m.disableRetryDelays();
  });
  const result = await fn();
  for (const instance of await introspector.get()) await instance.waitForStatus("complete");
  return result;
}

async function runsOf(client: Client, automation: string) {
  return createCrmDb(client.env.DB)
    .query.selectFrom("core_automation_runs")
    .select(["id", "status"])
    .where("automation_id", "=", `${FIXTURE_ID}.${automation}`)
    .execute();
}

beforeAll(async () => {
  await setUpTwoClients(env);
  for (const id of [a.id, b.id]) clients.push(await setUp(id));
});

describe("a record-triggered automation on a many-client host (review of #522, S1)", () => {
  it("runs to completion for each client, its steps and its extension's calls in that client's scope", async () => {
    for (const client of clients) {
      const sink = memoryEventSink();
      const item = (await invokeByName(
        "record.create",
        { object: ITEM, values: { name: `Item of ${client.id}`, level: 7 } },
        client.context({ events: sink }),
      )) as { id: string };
      const batch = createMessageBatch<unknown>(
        "cos-automation-events",
        sink.messages.map((body: AutomationQueueMessage, i) => ({
          id: `${client.id}-${i}`,
          timestamp: new Date(),
          attempts: 1,
          body: { cosClient: client.id, body },
        })),
      );
      await toCompletion(async () => {
        const ctx = createExecutionContext();
        await entry(ctx).queue(batch);
        const result = await getQueueResult(batch, ctx);
        expect(result.retryMessages).toEqual([]);
      });
      const runs = await runsOf(client, "onCreate");
      expect(runs.map((r) => r.status)).toEqual(["completed"]);
      // The step's task, in this client's database only.
      const tasks = await client.env.DB.prepare(
        "SELECT t.title AS title FROM core_task t JOIN core_task_links l ON l.task_id = t.id WHERE l.record_id = ?",
      )
        .bind(item.id)
        .all<{ title: string }>();
      expect(tasks.results.map((t) => t.title)).toEqual([`Follow up Item of ${client.id}`]);
    }
  });
});

describe("callAs on a many-client host (review of #522, M5)", () => {
  it("runs the method in the named client's scope: test mode reads that client's schema", async () => {
    for (const client of clients) {
      const item = (await invokeByName(
        "record.create",
        { object: ITEM, values: { name: "Probe", level: 1 } },
        client.context(),
      )) as { id: string };
      const report = (await entry().callAs(client.id, "testAutomation", [
        {
          automationId: `${FIXTURE_ID}.onCreate`,
          userId: client.admin.id,
          record: { object: ITEM, id: item.id },
        },
      ])) as { record: { id: string; title: string | null } | null };
      expect(report.record).toMatchObject({ id: item.id, title: "Probe" });
    }
  });
});

describe("a fan-out tick on a many-client host (review of #522, M5)", () => {
  it("runs the client's due work in that client's scope: its schedule and its integration events", async () => {
    const [client] = clients as [Client];
    const at = new Date();
    at.setUTCHours(9, 30, 0, 0);
    // An integration event waiting: the tick dispatches it as a trigger, which loads the client's
    // schema outside any operation.
    await recordIntegrationEvents(createCrmDb(client.env.DB), [
      {
        source: "webhook",
        connectionId: "conn-tick",
        type: "ping",
        externalId: `tick:${crypto.randomUUID()}`,
        payload: { payload: { hello: "world" } },
        occurredAt: at.toISOString(),
      },
    ]);
    const batch = createMessageBatch<unknown>("cos-runner-fanout", [
      {
        id: "tick-a",
        timestamp: new Date(),
        attempts: 1,
        body: { cosFanOut: 1, client: client.id, cron: "* * * * *", scheduledTime: at.getTime() },
      },
    ]);
    await toCompletion(async () => {
      const ctx = createExecutionContext();
      await entry(ctx).queue(batch);
      const result = await getQueueResult(batch, ctx);
      expect(result.explicitAcks).toEqual(["tick-a"]);
    });
    expect((await runsOf(client, "nightly")).map((r) => r.status)).toContain("completed");
    const waiting = await client.env.DB.prepare(
      "SELECT count(*) AS n FROM core_integration_event WHERE consumed_at IS NULL",
    ).first<{ n: number }>();
    expect(waiting?.n).toBe(0);
  });
});

describe("a parked automation event, handed back once its client is served (review of #522, M4)", () => {
  it("is consumed in its client's scope: its run starts and completes", async () => {
    const [client] = clients as [Client];
    const sink = memoryEventSink();
    const item = (await invokeByName(
      "record.create",
      { object: ITEM, values: { name: "Parked", level: 9 } },
      client.context({ events: sink }),
    )) as { id: string };
    const [message] = sink.messages;
    const id = crypto.randomUUID();
    const ledgers = (
      env as unknown as { CLIENT_PARKING_LEDGER: DurableObjectNamespace<ParkingLedger> }
    ).CLIENT_PARKING_LEDGER;
    const ledger = ledgers.get(
      ledgers.idFromName(
        clientObjectName(client.id as ClientId, a.generation, PARKING_LEDGER_NAME, OBJECT_KEY),
      ),
    );
    await ledger.admit(id, 1, PARKING.maxPerClient);
    const batch = createMessageBatch<unknown>("cos-runner-parking", [
      {
        id: `parked-${id}`,
        timestamp: new Date(),
        attempts: 1,
        body: {
          cosParked: 1,
          id,
          queue: "cos-automation-events",
          stamped: { cosClient: client.id, body: message },
          generation: a.generation,
          parkedAt: Date.now(),
          delaySeconds: 60,
          failures: 0,
        },
      },
    ]);
    await toCompletion(async () => {
      const ctx = createExecutionContext();
      await entry(ctx).queue(batch);
      const result = await getQueueResult(batch, ctx);
      expect(result.retryMessages).toEqual([]);
    });
    const tasks = await client.env.DB.prepare(
      "SELECT t.title AS title FROM core_task t JOIN core_task_links l ON l.task_id = t.id WHERE l.record_id = ?",
    )
      .bind(item.id)
      .all<{ title: string }>();
    expect(tasks.results.map((t) => t.title)).toEqual(["Follow up Parked"]);
  });
});

describe("a host module call from an extension's worker (review of #522, S1)", () => {
  it("runs in the run's client's scope, though Worker Loader calls back with none", async () => {
    const [client] = clients as [Client];
    // As Worker Loader calls it: from outside any scope. Routine mail loads the client's schema
    // itself, outside any operation; it then finds no mail connection, which is what it says.
    const host = new RunHost(client.env, {
      runId: "run-scope",
      extensionId: FIXTURE_ID,
      automation: {
        automationId: `${FIXTURE_ID}.onCreate`,
        runId: "run-scope",
        depth: 0,
        chain: [],
        rootEventId: "event-scope",
      },
      modules: new Set(["routine-mail"]),
      user: client.admin,
      permissions: {},
      deadline: Date.now() + 60_000,
      logs: [],
      operations: [],
    } as unknown as RunState);
    const answer = JSON.stringify(await host.call("routine-mail", "send", [{ to: "nobody" }]));
    expect(answer).not.toMatch(/No client for this code/);
    expect(answer).toMatch(/"ok":false/);
  });
});

describe("a value the runner keeps per client environment (review of #522, M1)", () => {
  it("is refused for an environment the directory did not make", () => {
    const [client] = clients as [Client];
    expect(clientKeyOf(client.env)).toBe(client.env);
    expect(() => clientKeyOf({ ...client.env })).toThrow(/Not a client's environment/);
  });
});

describe("a call that enters a client's Durable Object (review of #522, M4)", () => {
  it("runs in that client's scope, whatever the object's code reads", () => {
    const [client] = clients as [Client];
    // An object as refreshOnEachCall sees one: its client, admitted just now, with its environment.
    class Probe {
      readonly [CLIENT_OBJECT] = { client: client.id, fresh: true, env: client.env };
      whoAmI(): string | null {
        return currentClientId();
      }
    }
    refreshOnEachCall(Probe);
    expect(new Probe().whoAmI()).toBe(`live:${client.id}`);
  });
});
