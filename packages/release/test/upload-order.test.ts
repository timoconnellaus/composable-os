// The order Workers are uploaded in (the first real staging run, 2026-11-27): Cloudflare refuses a
// Worker, or a version of one, whose service binding names a Worker that does not exist yet
// (10143). The engine adds bindings the release's `dependsOn` does not know (a gatekeeper on the
// runner), so the order comes from the bindings as uploaded. The fake refuses as the real API does.
import { describe, expect, it } from "vitest";
import {
  bindingOrder,
  boundWorkers,
  CloudflareClient,
  type DeploymentState,
  installRelease,
  openBundle,
} from "../src/index.ts";
import { buildFixtureRelease, FakeCloudflare } from "../src/testing/index.ts";
import { nodeSqliteEngine } from "../src/testing/node-sqlite.ts";

const ACCOUNT = "acc0000000000000000000000000ordr";

function state(over: Partial<DeploymentState> = {}): DeploymentState {
  return {
    version: "1.0.0",
    accountId: ACCOUNT,
    hostname: "demo-app.example.workers.dev",
    hostnameMode: "workers.dev",
    identityProvider: "better-auth",
    channel: "stable",
    gatekeepers: [],
    workerNames: {},
    vars: {},
    resources: {},
    ...over,
  };
}

async function setup() {
  const cf = new FakeCloudflare({ token: "t", accountId: ACCOUNT, sql: nodeSqliteEngine });
  const api = new CloudflareClient({
    token: "t",
    apiBase: "https://cf.test/client/v4",
    fetch: cf.fetch,
  });
  return { cf, api };
}
const secrets = {
  "demo-app": { BETTER_AUTH_SECRET: "s".repeat(64) },
  "demo-gatekeeper-test": { CLIENT_SECRET: "c" },
};

describe("the fake Cloudflare API", () => {
  it("refuses a script, or a version, whose service binding names a Worker that does not exist (10143)", async () => {
    const { api } = await setup();
    const bindings = [{ type: "service", name: "OTHER", service: "missing-worker" }];
    const modules = [{ name: "index.js", type: "esm" as const, bytes: new Uint8Array([1]) }];
    const meta = { main_module: "index.js", compatibility_date: "2026-09-04", bindings };
    await expect(api.putScript(ACCOUNT, "binder", meta, modules)).rejects.toThrow(
      /10143: Service binding 'OTHER' references Worker 'missing-worker' which was not found/,
    );
    await api.putScript(ACCOUNT, "binder", { ...meta, bindings: [] }, modules);
    await expect(api.uploadVersion(ACCOUNT, "binder", meta, modules)).rejects.toThrow(/10143/);
    await api.putScript(ACCOUNT, "missing-worker", { ...meta, bindings: [] }, modules);
    await api.putScript(ACCOUNT, "binder", meta, modules);
    // A D1 binding to a database the account does not have (10181).
    const d1 = [{ type: "d1", name: "DB", database_id: "no-such-database" }];
    await expect(
      api.putScript(ACCOUNT, "binder", { ...meta, bindings: d1 }, modules),
    ).rejects.toThrow(/10181: D1 binding "DB" references a database that was not found/);
  });

  it("creates a Workflow only by its own call, never by uploading the Worker, and pages the list by total_count", async () => {
    const { cf, api } = await setup();
    const modules = [{ name: "index.js", type: "esm" as const, bytes: new Uint8Array([1]) }];
    const flow = { type: "workflow", name: "FLOW", workflow_name: "demo-flow", class_name: "Flow" };
    await api.putScript(
      ACCOUNT,
      "runner",
      { main_module: "index.js", compatibility_date: "2026-09-04", bindings: [flow] },
      modules,
    );
    expect(cf.workflows.has("demo-flow")).toBe(false);
    await api.putWorkflow(ACCOUNT, "demo-flow", { class_name: "Flow", script_name: "runner" });
    expect(cf.workflows.get("demo-flow")).toEqual({ className: "Flow", script: "runner" });
    for (let i = 0; i < 70; i++) cf.workflows.set(`other-${i}`, { className: "X", script: "x" });
    expect((await api.listWorkflows(ACCOUNT)).length).toBe(71);
  });
});

describe("the upload order", () => {
  it("installs a gatekeeper before the runner that binds it, on a fresh single-client install", async () => {
    const bundle = await openBundle((await buildFixtureRelease({ version: "1.0.0" })).bundle);
    const { cf, api } = await setup();
    await installRelease({
      api,
      bundle,
      state: state({ gatekeepers: ["demo-gatekeeper-test"] }),
      secrets,
    });
    expect(cf.liveBinding("demo-runner", "GATEKEEPER_TEST")).toMatchObject({
      service: "demo-gatekeeper-test",
    });
  });

  it("uploads a gatekeeper added to an existing host before the runner's new version binds it", async () => {
    const bundle = await openBundle((await buildFixtureRelease({ version: "1.0.0" })).bundle);
    const { cf, api } = await setup();
    await installRelease({ api, bundle, state: state(), secrets });
    expect(cf.scripts.has("demo-gatekeeper-test")).toBe(false);
    const logs: string[] = [];
    await installRelease({
      api,
      bundle,
      state: state({ gatekeepers: ["demo-gatekeeper-test"] }),
      secrets,
      log: (l) => logs.push(l),
    });
    expect(cf.liveBinding("demo-runner", "GATEKEEPER_TEST")).toMatchObject({
      service: "demo-gatekeeper-test",
    });
    expect(logs.join("\n")).toContain("demo-gatekeeper-test (new Worker, uploaded now");
  });

  it("orders by the bindings as uploaded, and refuses a cycle", () => {
    const item = (deployedName: string, deps: string[]) => ({ deployedName, deps });
    const ordered = bindingOrder([
      item("app", ["runner", "client-db"]),
      item("runner", ["gatekeeper", "client-db"]),
      item("client-db", []),
      item("gatekeeper", []),
    ]);
    expect(ordered.map((i) => i.deployedName)).toEqual([
      "gatekeeper",
      "client-db",
      "runner",
      "app",
    ]);
    expect(() => bindingOrder([item("a", ["b"]), item("b", ["a"])])).toThrow(/cycle \(a → b → a\)/);
    expect(
      boundWorkers(
        [
          { type: "service", name: "RUNNER", service: "runner" },
          { type: "durable_object_namespace", name: "X", class_name: "X", script_name: "db" },
          { type: "durable_object_namespace", name: "OWN", class_name: "Own" },
          { type: "service", name: "SELF", service: "app" },
        ] as never,
        "app",
      ),
    ).toEqual(["runner", "db"]);
  });
});
