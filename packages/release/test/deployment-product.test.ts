// A deployment records the product whose release it runs, and the engine refuses another
// product's release for it before anything is made (review of #553).
import { describe, expect, it } from "vitest";
import {
  CloudflareClient,
  type DeploymentState,
  d1ApiMigrations,
  fetchReleaseManifest,
  getRelease,
  installRelease,
  openBundle,
  readDeploymentState,
  releaseAssetNames,
  runRollback,
  runUpdate,
} from "../src/index.ts";
import {
  buildFixtureRelease,
  FakeCloudflare,
  FakeGitHub,
  FIXTURE_PRODUCT_DEFINITION,
} from "../src/testing/index.ts";
import { nodeSqliteEngine } from "../src/testing/node-sqlite.ts";

const ACCOUNT = "acc0000000000000000000000000test";

const OTHER = {
  ...FIXTURE_PRODUCT_DEFINITION,
  id: "other",
  label: "Other",
  names: {
    app: "other-app",
    runner: "other-runner",
    gatekeeperPrefix: "other-gatekeeper-",
    database: "other",
    resourcePrefix: "other-",
  },
};

async function installed() {
  const cf = new FakeCloudflare({ token: "t", accountId: ACCOUNT, sql: nodeSqliteEngine });
  const api = new CloudflareClient({
    token: "t",
    apiBase: "https://cf.test/client/v4",
    fetch: cf.fetch,
  });
  const bundle = await openBundle((await buildFixtureRelease({ version: "1.0.0" })).bundle);
  const state: DeploymentState = {
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
  };
  const result = await installRelease({
    api,
    bundle,
    state,
    secrets: { "demo-app": { BETTER_AUTH_SECRET: "x".repeat(64) } },
  });
  const databaseId = result.state.resources["D1_ID(demo)"] as string;
  return { cf, api, bundle, databaseId };
}

describe("a deployment's product", () => {
  it("is recorded by an install and kept by an update", async () => {
    const { api, bundle, databaseId } = await installed();
    const state = (await readDeploymentState(api, ACCOUNT, databaseId)) as DeploymentState;
    expect(state.product).toBe("demo");
    const target = await openBundle((await buildFixtureRelease({ version: "1.1.0" })).bundle);
    const outcome = await runUpdate({
      api,
      state,
      databaseId,
      target,
      previous: async () => bundle,
      migrations: d1ApiMigrations(api, ACCOUNT, databaseId),
      smoke: async () => {},
    });
    expect(outcome.status, outcome.error).toBe("succeeded");
    expect((await readDeploymentState(api, ACCOUNT, databaseId))?.product).toBe("demo");
  });

  it("refuses an update, a rollback and an install from another product's release, changing nothing", async () => {
    const { cf, api, bundle, databaseId } = await installed();
    const state = (await readDeploymentState(api, ACCOUNT, databaseId)) as DeploymentState;
    const other = await openBundle(
      (await buildFixtureRelease({ version: "1.1.0", product: OTHER })).bundle,
    );
    const writes = () => cf.calls.filter((c) => c.method !== "GET").length;
    const before = writes();
    await expect(
      runUpdate({
        api,
        state,
        databaseId,
        target: other,
        previous: async () => bundle,
        migrations: d1ApiMigrations(api, ACCOUNT, databaseId),
        smoke: async () => {},
      }),
    ).rejects.toThrow(/runs demo's release, not other's/);
    await expect(
      runRollback({ api, state, databaseId, previous: other, bookmark: null }),
    ).rejects.toThrow(/not other's/);
    await expect(installRelease({ api, bundle: other, state, secrets: {} })).rejects.toThrow(
      /not other's/,
    );
    expect(writes()).toBe(before);
    expect([...cf.scripts.keys()].filter((n) => n.startsWith("other"))).toEqual([]);
    expect([...cf.d1.values()].map((d) => d.name)).toEqual(["demo"]);
  });
});

describe("a release's manifest asset", () => {
  it("is refused for preflight when it is another product's", async () => {
    const github = new FakeGitHub();
    const demo = await buildFixtureRelease({ version: "1.0.0" });
    const other = await buildFixtureRelease({ version: "1.0.0", product: OTHER });
    await github.publishProducts([demo, other]);
    const options = {
      apiBase: github.api,
      fetch: github.fetch,
      repository: github.repository,
      product: "demo",
    };
    const info = await getRelease("1.0.0", options);
    expect((await fetchReleaseManifest(info, options)).product).toBe("demo");
    // The demo manifest asset replaced by the other product's.
    const assets = github.releases.at(-1)?.assets as Map<string, Uint8Array>;
    assets.set(
      releaseAssetNames("demo", "1.0.0").manifest,
      new TextEncoder().encode(other.manifestText),
    );
    await expect(fetchReleaseManifest(info, options)).rejects.toThrow(/other's, not demo's/);
  });
});
