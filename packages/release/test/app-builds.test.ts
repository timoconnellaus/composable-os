// The app's builds over the D1 API (stage 63, ADR 0901), against the fake Cloudflare API on Node's
// SQLite: `cos app record` writes core_app_build as the deploy path writes core_install, refuses a
// changed store id or a used build number, and a host without the table (a release from before
// stage 63 step 4) has nothing recorded and records nothing.
import { describe, expect, it } from "vitest";
import {
  type AppBuildRecord,
  AppBuildRefused,
  appBuildsViaApi,
  CloudflareClient,
  nextBuildNumber,
  recordAppBuildViaApi,
} from "../src/index.ts";
import { FakeCloudflare } from "../src/testing/index.ts";
import { nodeSqliteEngine } from "../src/testing/node-sqlite.ts";

const ACCOUNT = "acc0000000000000000000000000test";

// The table as stage 63's spec gives it (step 4 adds it to the core migrations).
const TABLE = `CREATE TABLE core_app_build (
  environment TEXT NOT NULL,
  platform TEXT NOT NULL CHECK (platform IN ('ios', 'android')),
  app_version TEXT NOT NULL,
  build_number INTEGER NOT NULL,
  api_version TEXT NOT NULL,
  app_id TEXT NOT NULL,
  commit_sha TEXT,
  uploaded_at TEXT NOT NULL,
  supported INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (environment, platform, build_number)
)`;

async function world(withTable = true) {
  const cf = new FakeCloudflare({ token: "t", accountId: ACCOUNT, sql: nodeSqliteEngine });
  const api = new CloudflareClient({
    token: "t",
    apiBase: "https://cf.test/client/v4",
    fetch: cf.fetch,
  });
  const db = await api.createD1(ACCOUNT, "gym-staging");
  if (withTable) await api.queryD1(ACCOUNT, db.uuid, TABLE);
  return { api, db: db.uuid };
}

const build = (over: Partial<AppBuildRecord> = {}): AppBuildRecord => ({
  environment: "staging",
  platform: "ios",
  app_version: "1.0.0",
  build_number: 1,
  api_version: "v1",
  app_id: "com.example.gym.staging",
  commit_sha: "a".repeat(40),
  uploaded_at: "2026-11-24T00:00:00.000Z",
  supported: 1,
  ...over,
});

describe("core_app_build over the D1 API", () => {
  it("records each platform's build, and the next number is the highest plus one", async () => {
    const { api, db } = await world();
    expect(nextBuildNumber((await appBuildsViaApi(api, ACCOUNT, db, "staging")) ?? [])).toBe(1);
    expect(await recordAppBuildViaApi(api, ACCOUNT, db, build())).toBe("recorded");
    expect(
      await recordAppBuildViaApi(api, ACCOUNT, db, build({ platform: "android", build_number: 1 })),
    ).toBe("recorded");
    expect(await recordAppBuildViaApi(api, ACCOUNT, db, build({ build_number: 4 }))).toBe(
      "recorded",
    );
    const builds = (await appBuildsViaApi(api, ACCOUNT, db, "staging")) ?? [];
    expect(builds.map((b) => `${b.platform}/${b.build_number}`)).toEqual([
      "ios/4",
      "android/1",
      "ios/1",
    ]);
    expect(nextBuildNumber(builds)).toBe(5);
    // Another environment's builds are its own.
    expect(await appBuildsViaApi(api, ACCOUNT, db, "live")).toEqual([]);
  });

  it("re-recording a build is a no-op; a used or lower number and a changed id are refused", async () => {
    const { api, db } = await world();
    await recordAppBuildViaApi(api, ACCOUNT, db, build({ build_number: 3 }));
    expect(await recordAppBuildViaApi(api, ACCOUNT, db, build({ build_number: 3 }))).toBe(
      "already",
    );
    await expect(
      recordAppBuildViaApi(
        api,
        ACCOUNT,
        db,
        build({ build_number: 3, commit_sha: "b".repeat(40) }),
      ),
    ).rejects.toThrow(/ios build 3 is already recorded/);
    await expect(
      recordAppBuildViaApi(api, ACCOUNT, db, build({ build_number: 2 })),
    ).rejects.toThrow(/lower than build 3/);
    await expect(
      recordAppBuildViaApi(
        api,
        ACCOUNT,
        db,
        build({ build_number: 4, app_id: "com.example.other" }),
      ),
    ).rejects.toBeInstanceOf(AppBuildRefused);
    expect((await appBuildsViaApi(api, ACCOUNT, db, "staging"))?.length).toBe(1);
  });

  it("a host without core_app_build has nothing recorded, and records nothing", async () => {
    const { api, db } = await world(false);
    expect(await appBuildsViaApi(api, ACCOUNT, db, "staging")).toBeNull();
    await expect(recordAppBuildViaApi(api, ACCOUNT, db, build())).rejects.toThrow(
      /has no core_app_build yet/,
    );
  });
});
