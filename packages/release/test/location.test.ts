// The location hint (ADR 0580) against the fake Cloudflare API: sent only when a D1 database or an
// R2 bucket is created, under the field each create API takes; never by default; never to a store
// that exists, by a repair or by an upgrade; and never for KV, queues or Vectorize.
import { describe, expect, it } from "vitest";
import {
  CloudflareClient,
  type DeploymentState,
  d1ApiMigrations,
  installRelease,
  type LocationHint,
  neededResources,
  openBundle,
  provisionResources,
  runUpdate,
} from "../src/index.ts";
import { buildFixtureRelease, FakeCloudflare } from "../src/testing/index.ts";
import { nodeSqliteEngine } from "../src/testing/node-sqlite.ts";

const ACCOUNT = "acc0000000000000000000000000test";

function world() {
  const cf = new FakeCloudflare({ token: "t", accountId: ACCOUNT, sql: nodeSqliteEngine });
  const api = new CloudflareClient({
    token: "t",
    apiBase: "https://cf.test/client/v4",
    fetch: cf.fetch,
  });
  return { cf, api };
}

function stateFor(version: string, locationHint?: LocationHint): DeploymentState {
  return {
    version,
    accountId: ACCOUNT,
    hostname: "demo-app.example.workers.dev",
    hostnameMode: "workers.dev",
    identityProvider: "better-auth",
    channel: "stable",
    gatekeepers: [],
    workerNames: {},
    vars: {},
    resources: {},
    ...(locationHint ? { locationHint } : {}),
  };
}

const secrets = { "demo-app": { BETTER_AUTH_SECRET: "x".repeat(64) } };

describe("location hint", () => {
  it("is not sent by default: D1 and R2 are created with a name only", async () => {
    const { cf, api } = world();
    const bundle = await openBundle((await buildFixtureRelease({ version: "1.0.0" })).bundle);
    await provisionResources(api, ACCOUNT, neededResources(bundle.manifest, []));
    expect(cf.creates).toEqual([
      { type: "d1", name: "demo", locationHint: undefined },
      { type: "r2", name: "demo-blobs", locationHint: undefined },
    ]);
  });

  it("an install asked for Oceania creates its D1 and R2 with oc, under each API's field", async () => {
    const { cf, api } = world();
    const bodies: { path: string; body: unknown }[] = [];
    cf.failOn = (method, path, body) => {
      if (method === "POST") bodies.push({ path, body });
      return undefined;
    };
    const bundle = await openBundle((await buildFixtureRelease({ version: "1.0.0" })).bundle);
    const result = await installRelease({
      api,
      bundle,
      state: stateFor("1.0.0", "oc"),
      secrets,
    });
    expect(cf.creates).toEqual([
      { type: "d1", name: "demo", locationHint: "oc" },
      { type: "r2", name: "demo-blobs", locationHint: "oc" },
    ]);
    expect(result.state.locationHint).toBe("oc");
    const body = (suffix: string) => bodies.find((b) => b.path.endsWith(suffix))?.body;
    expect(body("/d1/database")).toEqual({ name: "demo", primary_location_hint: "oc" });
    expect(body("/r2/buckets")).toEqual({ name: "demo-blobs", locationHint: "oc" });
    // KV, queues and Vectorize take no location hint in Cloudflare's API: none is sent.
    expect(body("/storage/kv/namespaces")).toEqual({ title: "demo-app-oauth-kv" });
    for (const b of bodies.filter((b) => /\/(queues|vectorize\/v2\/indexes)$/.test(b.path))) {
      expect(JSON.stringify(b.body)).not.toMatch(/location|jurisdiction/i);
    }
  });

  it("a store that exists is never sent a hint: a repair with one creates nothing", async () => {
    const { cf, api } = world();
    const bundle = await openBundle((await buildFixtureRelease({ version: "1.0.0" })).bundle);
    await provisionResources(api, ACCOUNT, neededResources(bundle.manifest, []));
    const before = cf.creates.length;
    const logs: string[] = [];
    await provisionResources(
      api,
      ACCOUNT,
      neededResources(bundle.manifest, []),
      (l) => logs.push(l),
      {},
      { locationHint: "oc" },
    );
    expect(cf.creates).toHaveLength(before);
    expect(logs).toContain("  D1 demo: exists");
    expect(logs).toContain("  R2 demo-blobs: exists");
  });

  it("an upgrade sends no hint for what exists, and the install's hint only to a store it adds", async () => {
    const { cf, api } = world();
    const bundle = await openBundle((await buildFixtureRelease({ version: "1.0.0" })).bundle);
    const installed = await installRelease({
      api,
      bundle,
      state: stateFor("1.0.0", "oc"),
      secrets,
    });
    // An existing install with every store in place: the upgrade creates none.
    const target = await openBundle((await buildFixtureRelease({ version: "1.1.0" })).bundle);
    const before = cf.creates.length;
    const first = await runUpdate({
      api,
      state: installed.state,
      databaseId: installed.databaseId,
      target,
      previous: async () => bundle,
      migrations: d1ApiMigrations(api, ACCOUNT, installed.databaseId),
      smoke: async () => {},
    });
    expect(first.status).toBe("succeeded");
    expect(cf.creates).toHaveLength(before);

    // A store the next release adds (here: a bucket the state does not hold yet) is created with
    // the hint the install was made with; the database is not touched.
    const { "R2_NAME(demo-blobs)": _gone, ...withoutBucket } = installed.state.resources;
    cf.r2.delete("demo-blobs");
    const next = await openBundle((await buildFixtureRelease({ version: "1.2.0" })).bundle);
    const second = await runUpdate({
      api,
      state: { ...installed.state, version: "1.1.0", resources: withoutBucket },
      databaseId: installed.databaseId,
      target: next,
      previous: async () => target,
      migrations: d1ApiMigrations(api, ACCOUNT, installed.databaseId),
      smoke: async () => {},
    });
    expect(second.status).toBe("succeeded");
    expect(cf.creates.slice(before)).toEqual([
      { type: "r2", name: "demo-blobs", locationHint: "oc" },
    ]);
  });

  it("an upgrade of an install made without a hint sends none", async () => {
    const { cf, api } = world();
    const bundle = await openBundle((await buildFixtureRelease({ version: "1.0.0" })).bundle);
    const installed = await installRelease({ api, bundle, state: stateFor("1.0.0"), secrets });
    const { "R2_NAME(demo-blobs)": _gone, ...withoutBucket } = installed.state.resources;
    cf.r2.delete("demo-blobs");
    const target = await openBundle((await buildFixtureRelease({ version: "1.1.0" })).bundle);
    await runUpdate({
      api,
      state: { ...installed.state, resources: withoutBucket },
      databaseId: installed.databaseId,
      target,
      previous: async () => bundle,
      migrations: d1ApiMigrations(api, ACCOUNT, installed.databaseId),
      smoke: async () => {},
    });
    expect(cf.creates.every((c) => c.locationHint === undefined)).toBe(true);
    expect(cf.creates.at(-1)).toEqual({ type: "r2", name: "demo-blobs", locationHint: undefined });
  });

  it("the fake refuses a hint the real API would refuse", async () => {
    const { api } = world();
    await expect(
      // @ts-expect-error: not a location hint, to prove the fake is as strict as the API
      api.createD1(ACCOUNT, "x", { locationHint: "au" }),
    ).rejects.toThrow(/primary_location_hint/);
    await expect(
      // @ts-expect-error: as above, for R2
      api.createR2(ACCOUNT, "x", { locationHint: "syd" }),
    ).rejects.toThrow(/locationHint/);
  });
});
