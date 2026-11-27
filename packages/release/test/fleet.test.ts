// A fleet deployment, a host of many clients (stage 66 step 7, ADR 0618): what the deploy engine
// adds, checked against ADR 0615's list ("What a many-client deployment binds"), and that a
// single-client deployment's uploads have none of it.
import { describe, expect, it } from "vitest";
import {
  CloudflareClient,
  type DeploymentState,
  type FleetDeployInput,
  fleetDeploymentNames,
  fleetDurableObjectMigration,
  installRelease,
  openBundle,
} from "../src/index.ts";
import { buildFixtureRelease, FakeCloudflare } from "../src/testing/index.ts";
import { nodeSqliteEngine } from "../src/testing/node-sqlite.ts";

const ACCOUNT = "acc0000000000000000000000000test";
const KEYS: FleetDeployInput = {
  keys: {
    rootKey: "root-key-root-key-root-key-root-key-root-ke",
    secretsPrivateKey: "secrets-key-secrets-key-secrets-key-secret",
    bindingKey: "binding-key-binding-key-binding-key-bindin",
    propsKey: "props-key-props-key-props-key-props-key-pro",
  },
  props: {
    clientDbApp: { caller: "cos-app", proof: "p-app" },
    clientDbRunner: { caller: "cos-runner", proof: "p-runner" },
    runnerCaller: { caller: "cos-app", proof: "p-caller" },
  },
};

function state(over: Partial<DeploymentState> = {}): DeploymentState {
  return {
    version: "1.0.0",
    accountId: ACCOUNT,
    hostname: "demo-app.example.workers.dev",
    hostnameMode: "workers.dev",
    identityProvider: "better-auth",
    channel: "stable",
    gatekeepers: ["demo-gatekeeper-test"],
    workerNames: {},
    vars: {},
    resources: {},
    ...over,
  };
}
const fleet = (environment: "live" | "staging") => ({
  environment,
  callbackHostname:
    environment === "live" ? "callback.fleet.example" : "callback-staging.fleet.example",
  domain: "fleet.example",
  secretsPublicKey: "public-key",
});

async function setup() {
  const cf = new FakeCloudflare({ token: "t", accountId: ACCOUNT, sql: nodeSqliteEngine });
  const api = new CloudflareClient({
    token: "t",
    apiBase: "https://cf.test/client/v4",
    fetch: cf.fetch,
  });
  return { cf, api };
}
type Binding = { type: string; name: string } & Record<string, unknown>;
const bindingsOf = (cf: FakeCloudflare, script: string) => {
  const s = cf.scripts.get(script);
  const live = s?.versions.find((v) => v.id === s.current) ?? s?.versions.at(-1);
  return (live?.metadata.bindings ?? []) as Binding[];
};
const named = (list: Binding[], name: string) => list.find((b) => b.name === name);
const secrets = {
  "demo-app": { BETTER_AUTH_SECRET: "s".repeat(64) },
  "demo-gatekeeper-test": { CLIENT_SECRET: "c" },
};

describe("a fleet deployment", () => {
  it("binds every item of ADR 0615's list, from the engine, on the app and the runner", async () => {
    const { cf, api } = await setup();
    const bundle = await openBundle(
      (await buildFixtureRelease({ version: "1.0.0", fleet: true })).bundle,
    );
    await installRelease({
      api,
      bundle,
      state: state({ fleet: fleet("live") }),
      secrets,
      fleet: KEYS,
    });
    for (const [worker, caller, q] of [
      ["demo-app", "clientDbApp", "demo-app"],
      ["demo-runner", "clientDbRunner", "demo-runner"],
    ] as const) {
      const b = bindingsOf(cf, worker);
      expect(named(b, "REGISTRY")).toMatchObject({ type: "d1" });
      expect(named(b, "COS_HOST_ENVIRONMENT")).toMatchObject({ text: "live" });
      expect(named(b, "COS_CALLBACK_HOSTNAME")).toMatchObject({ text: "callback.fleet.example" });
      expect(named(b, "CLIENT_DB_QUERIES")).toEqual({
        type: "service",
        name: "CLIENT_DB_QUERIES",
        service: "demo-client-db",
        entrypoint: "ClientDbQueries",
        props: KEYS.props[caller],
      });
      expect(named(b, "CLIENT_FANOUT")).toMatchObject({ type: "queue", queue_name: `${q}-fanout` });
      expect(named(b, "CLIENT_PARKING")).toMatchObject({
        type: "queue",
        queue_name: `${q}-parking`,
      });
      expect(named(b, "CLIENT_PARKING_LEDGER")).toMatchObject({
        type: "durable_object_namespace",
        class_name: "ParkingLedger",
      });
      const set = cf.scripts.get(worker)?.secrets;
      for (const key of [
        "COS_ROOT_KEY",
        "COS_SECRETS_PRIVATE_KEY",
        "COS_BINDING_KEY",
        "COS_PROPS_KEY",
      ]) {
        expect(set?.has(key), `${worker} ${key}`).toBe(true);
      }
      expect(cf.scripts.get(worker)?.secrets.get("COS_BINDING_KEY")).not.toBe(
        cf.scripts.get(worker)?.secrets.get("COS_PROPS_KEY"),
      );
      // The ledger's class, added by a migration of the fleet's own after the release's.
      expect(cf.scripts.get(worker)?.migrationTag).toMatch(/(^|\+)fleet$/);
    }
    // The app's binding to the runner carries the props without which callAs refuses.
    expect(named(bindingsOf(cf, "demo-app"), "RUNNER")).toMatchObject({
      service: "demo-runner",
      props: KEYS.props.runnerCaller,
    });
    // cos-client-db holds the props key and its environment, nothing else of the host's.
    const db = cf.scripts.get("demo-client-db");
    expect([...(db?.secrets.keys() ?? [])].sort()).toEqual(["COS_PROPS_KEY"]);
    expect(named(bindingsOf(cf, "demo-client-db"), "COS_HOST_ENVIRONMENT")).toMatchObject({
      text: "live",
    });
    // The operator's Worker: the registry, files, exports, key-value, and the keys to open secrets.
    const op = bindingsOf(cf, "demo-operator");
    for (const name of [
      "REGISTRY",
      "BLOBS",
      "EXPORTS",
      "OAUTH_KV",
      "CLIENT_DB",
      "COS_HOST_ENVIRONMENT",
    ]) {
      expect(named(op, name), name).toBeTruthy();
    }
    expect([...(cf.scripts.get("demo-operator")?.secrets.keys() ?? [])].sort()).toEqual([
      "COS_ROOT_KEY",
      "COS_SECRETS_PRIVATE_KEY",
    ]);
    // Every gatekeeper's BASE_URL is under the one callback address.
    expect(named(bindingsOf(cf, "demo-gatekeeper-test"), "BASE_URL")).toMatchObject({
      text: "https://callback.fleet.example/gatekeeper/test",
    });
    // Queues: the fan-out and parking queues with a batch of one, each with a DLQ, and every DLQ
    // consumed by the Worker of its queue.
    const consumers = new Map(
      [...cf.queues.values()].map((q) => [
        q.name,
        q.consumers.map((c) => ({
          script: c.script_name,
          settings: c.settings,
          dlq: c.dead_letter_queue,
        })),
      ]),
    );
    for (const [queue, script] of [
      ["demo-app-fanout", "demo-app"],
      ["demo-app-parking", "demo-app"],
      ["demo-runner-fanout", "demo-runner"],
      ["demo-runner-parking", "demo-runner"],
    ]) {
      expect(consumers.get(queue as string)).toEqual([
        {
          script,
          settings: { batch_size: 1, max_wait_time_ms: 1000, max_retries: 3 },
          dlq: `${queue}-dlq`,
        },
      ]);
      expect(consumers.get(`${queue}-dlq`)?.[0]?.script).toBe(script);
    }
    expect(consumers.get("demo-automation-events-dlq")?.[0]?.script).toBe("demo-runner");
    // The registry, and the exports bucket that keeps a removed client's export 90 days.
    expect([...cf.d1.values()].map((d) => d.name).sort()).toEqual(["demo", "demo-registry"]);
    expect(cf.r2Lifecycle.get("demo-exports")).toMatchObject({
      rules: [{ deleteObjectsTransition: { condition: { maxAge: 90 * 24 * 60 * 60 } } }],
    });
  });

  it("refuses one value for both keys, and a fleet deploy without its keys", async () => {
    const { api } = await setup();
    const bundle = await openBundle(
      (await buildFixtureRelease({ version: "1.0.0", fleet: true })).bundle,
    );
    const same = { ...KEYS, keys: { ...KEYS.keys, propsKey: KEYS.keys.bindingKey } };
    await expect(
      installRelease({ api, bundle, state: state({ fleet: fleet("live") }), secrets, fleet: same }),
    ).rejects.toThrow(/must differ/);
    await expect(
      installRelease({ api, bundle, state: state({ fleet: fleet("live") }), secrets }),
    ).rejects.toThrow(/needs its keys/);
  });

  it("gives staging its own Workers, registry and queues: nothing shared with live", async () => {
    const { cf, api } = await setup();
    const bundle = await openBundle(
      (await buildFixtureRelease({ version: "1.0.0", fleet: true })).bundle,
    );
    await installRelease({
      api,
      bundle,
      state: state({ fleet: fleet("live") }),
      secrets,
      fleet: KEYS,
    });
    const names = fleetDeploymentNames(bundle.manifest, "staging");
    await installRelease({
      api,
      bundle,
      state: state({
        fleet: fleet("staging"),
        workerNames: names.workers,
        resourceNames: names.resources,
      }),
      secrets,
      fleet: KEYS,
    });
    expect([...cf.d1.values()].map((d) => d.name).sort()).toEqual([
      "demo",
      "demo-registry",
      "demo-registry-staging",
      "demo-staging",
    ]);
    const app = bindingsOf(cf, "demo-app-staging");
    expect(named(app, "COS_HOST_ENVIRONMENT")).toMatchObject({ text: "staging" });
    expect(named(app, "CLIENT_DB_QUERIES")).toMatchObject({ service: "demo-client-db-staging" });
    expect(named(app, "CLIENT_FANOUT")).toMatchObject({ queue_name: "demo-app-fanout-staging" });
    expect(named(app, "RUNNER")).toMatchObject({ service: "demo-runner-staging" });
    // The runner's Workflows exist, by their staging names: uploading the runner makes none.
    expect(cf.workflows.get("demo-automation-staging")).toMatchObject({
      script: "demo-runner-staging",
    });
  });
});

describe("email sending on a fleet (issue #529)", () => {
  it("takes each client's own sender domains: SENDER_DOMAINS_PER_CLIENT on a fleet's, not on a single client's", async () => {
    const bundle = await openBundle(
      (await buildFixtureRelease({ version: "1.0.0", fleet: true, clientGatekeepers: true }))
        .bundle,
    );
    const withEmail = { gatekeepers: ["demo-gatekeeper-email-send", "demo-gatekeeper-test"] };
    const fleetSide = await setup();
    await installRelease({
      api: fleetSide.api,
      bundle,
      state: state({ ...withEmail, fleet: fleet("live") }),
      secrets,
      fleet: KEYS,
    });
    expect(
      named(bindingsOf(fleetSide.cf, "demo-gatekeeper-email-send"), "SENDER_DOMAINS_PER_CLIENT"),
    ).toMatchObject({
      type: "plain_text",
      text: "true",
    });
    const single = await setup();
    await installRelease({ api: single.api, bundle, state: state(withEmail), secrets });
    expect(
      named(bindingsOf(single.cf, "demo-gatekeeper-email-send"), "SENDER_DOMAINS_PER_CLIENT")?.text,
    ).not.toBe("true");
  });
});

describe('INTERNAL_DOMAINS on a fleet (ADR 0618, "A fleet\'s gatekeepers")', () => {
  it("is always empty on a fleet's email-send gatekeeper, whatever a state var says; a single client keeps its own", async () => {
    const bundle = await openBundle(
      (await buildFixtureRelease({ version: "1.0.0", fleet: true, clientGatekeepers: true }))
        .bundle,
    );
    const over = {
      gatekeepers: ["demo-gatekeeper-email-send", "demo-gatekeeper-test"],
      vars: { "demo-gatekeeper-email-send": { INTERNAL_DOMAINS: "gym-a.example" } },
    };
    const fleetSide = await setup();
    await installRelease({
      api: fleetSide.api,
      bundle,
      state: state({ ...over, fleet: fleet("live") }),
      secrets,
      fleet: KEYS,
    });
    const onFleet = bindingsOf(fleetSide.cf, "demo-gatekeeper-email-send").filter(
      (b) => b.name === "INTERNAL_DOMAINS",
    );
    expect(onFleet).toEqual([{ type: "plain_text", name: "INTERNAL_DOMAINS", text: "" }]);
    const single = await setup();
    await installRelease({ api: single.api, bundle, state: state(over), secrets });
    expect(
      named(bindingsOf(single.cf, "demo-gatekeeper-email-send"), "INTERNAL_DOMAINS")?.text,
    ).toBe("gym-a.example");
  });
});

describe("an imported client's videos", () => {
  it("have their creator read: its stamp, null for none, undefined when the account has no such video", async () => {
    const { cf, api } = await setup();
    const held = "c".repeat(32);
    const stamped = "e".repeat(32);
    cf.streamCreators.set(held, null);
    cf.streamCreators.set(stamped, "live:gym-a");
    expect(await api.streamVideoCreator(ACCOUNT, held)).toBeNull();
    expect(await api.streamVideoCreator(ACCOUNT, stamped)).toBe("live:gym-a");
    expect(await api.streamVideoCreator(ACCOUNT, "d".repeat(32))).toBeUndefined();
    await expect(api.streamVideoCreator(ACCOUNT, "../x")).rejects.toThrow(/Stream/);
  });
});

describe("a single-client deployment", () => {
  it("deploys no fleet Worker and binds nothing of a fleet's, from a release that carries them", async () => {
    const { cf, api } = await setup();
    const bundle = await openBundle(
      (await buildFixtureRelease({ version: "1.0.0", fleet: true })).bundle,
    );
    await installRelease({ api, bundle, state: state(), secrets });
    expect([...cf.scripts.keys()].sort()).toEqual([
      "demo-app",
      "demo-gatekeeper-test",
      "demo-runner",
    ]);
    const names = [...bindingsOf(cf, "demo-app"), ...bindingsOf(cf, "demo-runner")].map(
      (b) => b.name,
    );
    for (const fleetName of [
      "REGISTRY",
      "CLIENT_DB_QUERIES",
      "CLIENT_FANOUT",
      "CLIENT_PARKING",
      "CLIENT_PARKING_LEDGER",
      "COS_HOST_ENVIRONMENT",
      "COS_ROOT_KEY",
      "COS_BINDING_KEY",
    ]) {
      expect(names).not.toContain(fleetName);
    }
    expect(named(bindingsOf(cf, "demo-app"), "RUNNER")?.props).toBeUndefined();
    expect([...cf.d1.values()].map((d) => d.name)).toEqual(["demo"]);
  });
});

describe("a fleet's Durable Object migrations", () => {
  const history = [
    { tag: "v1", new_sqlite_classes: ["A"] },
    { tag: "v2", new_sqlite_classes: ["B"] },
  ];
  it("adds the ledger's class once, after the release's steps, and follows the release after", () => {
    expect(fleetDurableObjectMigration(history, undefined)).toEqual({
      new_tag: "v2+fleet",
      steps: [
        { new_sqlite_classes: ["A"] },
        { new_sqlite_classes: ["B"] },
        { new_sqlite_classes: ["ParkingLedger"] },
      ],
    });
    // A single-client Worker becoming a fleet's: the ledger only.
    expect(fleetDurableObjectMigration(history, "v2")).toEqual({
      old_tag: "v2",
      new_tag: "v2+fleet",
      steps: [{ new_sqlite_classes: ["ParkingLedger"] }],
    });
    expect(fleetDurableObjectMigration(history, "v2+fleet")).toBeUndefined();
    // A later release's step, after the fleet's.
    expect(
      fleetDurableObjectMigration(
        [...history, { tag: "v3", new_sqlite_classes: ["C"] }],
        "v2+fleet",
      ),
    ).toEqual({ old_tag: "v2+fleet", new_tag: "v3+fleet", steps: [{ new_sqlite_classes: ["C"] }] });
    expect(() => fleetDurableObjectMigration(history, "v9+fleet")).toThrow(/not in this release/);
    // A Worker whose release has no Durable Object steps: the fleet's alone, tagged `fleet`.
    expect(fleetDurableObjectMigration([], undefined)).toEqual({
      new_tag: "fleet",
      steps: [{ new_sqlite_classes: ["ParkingLedger"] }],
    });
    expect(fleetDurableObjectMigration([], "fleet")).toBeUndefined();
    expect(fleetDurableObjectMigration(history, "fleet")?.new_tag).toBe("v2+fleet");
  });
});
