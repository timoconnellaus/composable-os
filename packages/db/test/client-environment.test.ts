// The client's environment (stage 66 step 3, ADR 0613): with no registry it is the real `env`;
// on a many-client host it holds that client's database and settings and nothing that leads to
// the registry, to every client's databases or to another client.
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ClientDb } from "../src/client-db.ts";
import {
  buildClientEnvironment,
  ClientDirectory,
  clientForRequest,
  clientOf,
  environmentFor,
  envNameUse,
  type HostBindings,
  hostDirectory,
  hostMode,
  keepRateLimitApart,
} from "../src/client-environment.ts";
import { type ClientId, type ClientRecord, readRegistry } from "../src/registry.ts";
import {
  emptyRegistry,
  insertClient,
  insertHostname,
  insertSetting,
  metered,
  migrateRegistry,
} from "./registry-fixtures.ts";

const real = env as unknown as {
  DB: D1Database;
  REGISTRY: D1Database;
  CLIENT_DB: DurableObjectNamespace<ClientDb>;
};

/** A rate limiter that records the keys it is asked about. */
function recordingRateLimit(): RateLimit & { keys: string[] } {
  const keys: string[] = [];
  return {
    keys,
    limit: async ({ key }) => {
      keys.push(key);
      return { success: true };
    },
  };
}

/** A many-client host's `env`, as the app's would look with a registry bound. */
function manyClientEnv(registry: D1Database = real.REGISTRY) {
  return {
    DB: real.DB,
    REGISTRY: registry,
    CLIENT_DB: real.CLIENT_DB,
    // Settings: the deployment's own values.
    APPROVAL_FLOOR: "medium",
    COS_PACKS: "*",
    COS_ORG_EXTENSIONS: "the-deployments-own-hash",
    API_ALLOWED_ORIGINS: "https://host.example.com",
    // The host's own, and what step 6 fills in per client.
    CLOUDFLARE_API_TOKEN: "host-token",
    COS_UPDATE_TOKEN: "update-token",
    BETTER_AUTH_SECRET: "the-host-wide-secret",
    AI_KEY_OPENAI: "host-key",
    BETTER_AUTH_URL: "https://host.example.com",
    // Shared.
    STREAM_ACCOUNT_ID: "stream-account",
    LOADER: { name: "loader" },
    GATEKEEPER_PAYMENTS: { name: "payments" },
    // Kept apart: one with a wrapper (rate limits) and one without (files, step 4).
    MCP_RATE_LIMIT: recordingRateLimit(),
    BLOBS: { name: "bucket" },
    RUNNER: { name: "runner" },
    // Not listed anywhere.
    SOMETHING_NEW: "unlisted",
    SOME_NEW_BINDING: { name: "unlisted" },
  };
}

const gymA: ClientRecord = {
  id: "gym-a" as ClientId,
  environment: "live",
  status: "active",
  tier: "standard",
  repository: null,
  locationHint: "oc",
  schemaVersion: 1,
};

beforeAll(async () => {
  await migrateRegistry();
});

beforeEach(async () => {
  await emptyRegistry();
});

describe("a single-client deployment (no registry)", () => {
  it("is in single mode, and the client's environment is the real env, unchanged", async () => {
    const single = { DB: real.DB, APPROVAL_FLOOR: "medium" } as HostBindings;
    expect(hostMode(single)).toBe("single");
    expect(hostDirectory(single)).toBeNull();
    expect(await environmentFor(single, null)).toBe(single);
    const decided = await clientForRequest(single, "anything.example.com");
    expect(decided).toEqual({ mode: "single", env: single });
    expect(decided.mode === "single" && decided.env).toBe(single);
    expect((single as { DB: D1Database }).DB).toBe(real.DB);
    expect(clientOf(single)).toBeNull();
  });

  it("refuses a client named on a single-client deployment", async () => {
    await expect(environmentFor({ DB: real.DB }, "gym-a")).rejects.toThrow(/single-client/);
  });

  it("is the mode of the test Worker's own env, whose DB is the D1 binding", async () => {
    expect(hostMode({ DB: real.DB })).toBe("single");
  });
});

describe("hostMode", () => {
  it("refuses a registry with no CLIENT_DB, never falling back to the one D1 database", () => {
    expect(() => hostMode({ DB: real.DB, REGISTRY: real.REGISTRY })).toThrow(/CLIENT_DB/);
    expect(hostMode(manyClientEnv())).toBe("many");
  });
});

describe("buildClientEnvironment", () => {
  it("holds the client's database, settings and shared values, and leaves out the rest", () => {
    const host = manyClientEnv();
    const built = buildClientEnvironment(host, {
      client: gymA,
      settings: { APPROVAL_FLOOR: "high", COS_ORG_EXTENSIONS: "gym-a-hash" },
    }) as unknown as Record<string, unknown>;
    expect(Object.keys(built).sort()).toEqual(
      [
        "APPROVAL_FLOOR",
        "COS_ORG_EXTENSIONS",
        "COS_PACKS",
        "DB",
        "GATEKEEPER_PAYMENTS",
        "LOADER",
        "MCP_RATE_LIMIT",
        "STREAM_ACCOUNT_ID",
      ].sort(),
    );
    // The client's own settings, else the deployment's (`inherit`), else nothing (`empty`).
    expect(built.APPROVAL_FLOOR).toBe("high");
    expect(built.COS_ORG_EXTENSIONS).toBe("gym-a-hash");
    expect(built.COS_PACKS).toBe("*");
    expect("API_ALLOWED_ORIGINS" in built).toBe(false);
    // Shared values are the same objects.
    expect(built.LOADER).toBe(host.LOADER);
    expect(built.GATEKEEPER_PAYMENTS).toBe(host.GATEKEEPER_PAYMENTS);
    // DB is a client's database, not the D1 binding.
    expect(built.DB).not.toBe(real.DB);
    expect(clientOf(built)).toBe("gym-a");
  });

  it("never carries another client's own setting, even one the deployment has", () => {
    const built = buildClientEnvironment(manyClientEnv(), { client: gymA, settings: {} });
    const record = built as unknown as Record<string, unknown>;
    expect("COS_ORG_EXTENSIONS" in record).toBe(false);
    expect("API_ALLOWED_ORIGINS" in record).toBe(false);
  });

  it("opens the client's own database: what one client writes the other cannot read", async () => {
    const host = manyClientEnv();
    const a = buildClientEnvironment(host, { client: gymA, settings: {} });
    const b = buildClientEnvironment(host, {
      client: { ...gymA, id: "gym-b" as ClientId },
      settings: {},
    });
    await a.DB.prepare("CREATE TABLE only_gym_a (v TEXT)").run();
    await a.DB.prepare("INSERT INTO only_gym_a VALUES ('a')").run();
    expect(await a.DB.prepare("SELECT v FROM only_gym_a").first("v")).toBe("a");
    await expect(b.DB.prepare("SELECT v FROM only_gym_a").all()).rejects.toThrow(/no such table/);
    // Nor did it reach the D1 binding.
    await expect(real.DB.prepare("SELECT v FROM only_gym_a").all()).rejects.toThrow(
      /no such table/,
    );
  });

  it("keeps rate limits apart: the client in every key", async () => {
    const host = manyClientEnv();
    const a = buildClientEnvironment(host, { client: gymA, settings: {} }) as unknown as {
      MCP_RATE_LIMIT: RateLimit;
    };
    await a.MCP_RATE_LIMIT.limit({ key: "app-1" });
    expect(host.MCP_RATE_LIMIT.keys).toEqual(["gym-a:app-1"]);
    const limiter = recordingRateLimit();
    await keepRateLimitApart(limiter, "gym-b" as ClientId).limit({ key: "gym-a:app-1" });
    expect(limiter.keys).toEqual(["gym-b:gym-a:app-1"]);
  });

  it("has no property that leads to the registry, every client's databases, the real env or D1", () => {
    const host = manyClientEnv();
    const built = buildClientEnvironment(host, { client: gymA, settings: {} });
    const forbidden = new Set<unknown>([host, real.REGISTRY, real.CLIENT_DB, real.DB]);
    const seen = new Set<unknown>();
    const walk = (value: unknown, path: string, depth: number) => {
      if (value === null || (typeof value !== "object" && typeof value !== "function")) return;
      expect(forbidden.has(value), path).toBe(false);
      if (seen.has(value) || depth > 6) return;
      seen.add(value);
      for (const key of Reflect.ownKeys(value as object)) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (descriptor && "value" in descriptor) {
          walk(descriptor.value, `${path}.${String(key)}`, depth + 1);
        }
      }
      const proto = Object.getPrototypeOf(value);
      if (proto && proto !== Object.prototype && proto !== Function.prototype) {
        walk(proto, `${path}.__proto__`, depth + 1);
      }
    };
    walk(built, "env", 0);
    // The session D1's interface gives is the client's database too.
    walk((built.DB as D1Database).withSession(), "env.DB.withSession()", 1);
  });

  it("creates the client's database at its location hint, named by its id", async () => {
    const calls: { name: string; options: unknown }[] = [];
    const namespace = {
      idFromName: (name: string) => ({ name }),
      get: (id: { name: string }, options?: unknown) => {
        calls.push({ name: id.name, options });
        return { query: async () => ({ ok: true, results: [] }) };
      },
    } as unknown as DurableObjectNamespace<ClientDb>;
    const host = { ...manyClientEnv(), CLIENT_DB: namespace };
    const built = buildClientEnvironment(host, { client: gymA, settings: {} });
    await built.DB.prepare("SELECT 1").all().catch(() => undefined);
    expect(calls).toEqual([{ name: "gym-a", options: { locationHint: "oc" } }]);
    const nowhere = buildClientEnvironment(host, {
      client: { ...gymA, locationHint: null },
      settings: {},
    });
    await nowhere.DB.prepare("SELECT 1").all().catch(() => undefined);
    expect(calls[1]).toEqual({ name: "gym-a", options: undefined });
  });

  it("refuses a client id the registry would not hold", () => {
    expect(() =>
      buildClientEnvironment(manyClientEnv(), {
        client: { ...gymA, id: "Admin" as ClientId },
        settings: {},
      }),
    ).toThrow(RangeError);
  });
});

describe("envNameUse", () => {
  it("leaves out what it does not list", () => {
    expect(envNameUse("SOMETHING_NEW")).toBeNull();
    expect(envNameUse("REGISTRY")).toMatchObject({ use: "host" });
    expect(envNameUse("CLIENT_DB")).toMatchObject({ use: "host" });
    expect(envNameUse("APPROVAL_FLOOR")).toEqual({ use: "setting" });
    expect(envNameUse("AI_KEY_ANTHROPIC")).toMatchObject({ use: "per-client", what: "secret" });
    expect(envNameUse("GATEKEEPER_SLACK")).toEqual({ use: "shared" });
    expect(envNameUse("PUBLIC_RATE_LIMIT")).toMatchObject({ use: "kept-apart" });
  });
});

async function seedTwoClients() {
  await real.REGISTRY.batch([
    insertClient(real.REGISTRY, { id: "gym-a", locationHint: "oc" }),
    insertClient(real.REGISTRY, { id: "gym-b" }),
    insertClient(real.REGISTRY, { id: "gym-c", status: "paused" }),
    insertClient(real.REGISTRY, { id: "gym-s", environment: "staging" }),
    insertHostname(real.REGISTRY, "gym-a.example.com", "gym-a", "staff"),
    insertHostname(real.REGISTRY, "shop.gym-a.com", "gym-a", "web"),
    insertHostname(real.REGISTRY, "gym-b.example.com", "gym-b", "staff"),
    insertHostname(real.REGISTRY, "pending.gym-b.com", "gym-b", "web", false),
    insertHostname(real.REGISTRY, "gym-s.example.com", "gym-s", "staff"),
    insertSetting(real.REGISTRY, "gym-a", "APPROVAL_FLOOR", "high"),
  ]);
}

describe("ClientDirectory", () => {
  it("finds a client by its verified hostname, exactly, whatever the Host header's case or port", async () => {
    await seedTwoClients();
    const directory = new ClientDirectory(manyClientEnv());
    expect(await directory.clientForHostname("gym-a.example.com")).toMatchObject({
      client: { id: "gym-a" },
      surface: "staff",
    });
    expect(await directory.clientForHostname("GYM-A.example.com:443")).toMatchObject({
      client: { id: "gym-a" },
    });
    expect(await directory.clientForHostname("shop.gym-a.com")).toMatchObject({ surface: "web" });
  });

  it("never derives a client from a hostname: no suffix, prefix, label or unverified match", async () => {
    await seedTwoClients();
    const directory = new ClientDirectory(manyClientEnv());
    for (const host of [
      "gym-a", // the client's id alone
      "x.gym-a.example.com", // a name under a client's hostname
      "evil-gym-a.example.com",
      "gym-a.example.com.evil.com",
      "gym-a.example.co",
      "example.com",
      "gym-a.composableos.app", // where the fleet's name would be, not in the registry
      "pending.gym-b.com", // not verified
      "gym-a.example.com\u0000",
      "gym-a.example.com/x",
      "gym-a.example.com, gym-b.example.com",
      "",
      null,
      undefined,
    ]) {
      expect(await directory.clientForHostname(host), String(host)).toBeNull();
    }
  });

  it("finds only this deployment's environment when it is given one", async () => {
    await seedTwoClients();
    const live = new ClientDirectory(manyClientEnv(), { environment: "live" });
    expect(await live.clientForHostname("gym-s.example.com")).toBeNull();
    expect(await live.environmentFor("gym-s")).toBeNull();
    const staging = new ClientDirectory(manyClientEnv(), { environment: "staging" });
    expect(await staging.clientForHostname("gym-s.example.com")).toMatchObject({
      client: { id: "gym-s" },
    });
    expect(await staging.clientForHostname("gym-a.example.com")).toBeNull();
  });

  it("lists active clients for a cron's fan-out", async () => {
    await seedTwoClients();
    const directory = new ClientDirectory(manyClientEnv(), { environment: "live" });
    expect((await directory.activeClients()).sort()).toEqual(["gym-a", "gym-b"]);
  });

  it("gives each client one stable environment until the registry changes", async () => {
    await seedTwoClients();
    let now = 0;
    const meter = metered(real.REGISTRY);
    const directory = new ClientDirectory(manyClientEnv(meter.db), {
      refreshMs: 1_000,
      now: () => now,
    });
    const a1 = await directory.environmentFor("gym-a");
    const b1 = await directory.environmentFor("gym-b");
    expect(a1).not.toBeNull();
    expect(a1).not.toBe(b1);
    expect((a1 as unknown as { APPROVAL_FLOOR: string }).APPROVAL_FLOOR).toBe("high");
    expect((b1 as unknown as { APPROVAL_FLOOR: string }).APPROVAL_FLOOR).toBe("medium");
    const afterFirst = meter.statements();
    expect(afterFirst).toBe(4);
    // Within the refresh: no read at all, however many requests and hostnames.
    for (let i = 0; i < 50; i++) await directory.clientForHostname(`unknown-${i}.example.com`);
    expect(await directory.environmentFor("gym-a")).toBe(a1);
    expect(meter.statements()).toBe(afterFirst);
    // After it: one row read, and the same environment while the stamp is the same.
    now = 1_500;
    expect(await directory.environmentFor("gym-a")).toBe(a1);
    expect(meter.statements()).toBe(afterFirst + 1);
    // The operator changes a setting: the next check reads it, and the environment is rebuilt.
    await insertSetting(real.REGISTRY, "gym-b", "APPROVAL_FLOOR", "critical").run();
    now = 3_000;
    const a2 = await directory.environmentFor("gym-a");
    const b2 = await directory.environmentFor("gym-b");
    expect(a2).not.toBe(a1);
    expect((b2 as unknown as { APPROVAL_FLOOR: string }).APPROVAL_FLOOR).toBe("critical");
    expect(meter.statements()).toBe(afterFirst + 1 + 1 + 4);
  });

  it("stops finding a client the operator removed, at the next check", async () => {
    await seedTwoClients();
    let now = 0;
    const directory = new ClientDirectory(manyClientEnv(), { refreshMs: 1_000, now: () => now });
    expect(await directory.clientForHostname("gym-b.example.com")).not.toBeNull();
    await real.REGISTRY.prepare("DELETE FROM registry_clients WHERE id = 'gym-b'").run();
    now = 2_000;
    expect(await directory.clientForHostname("gym-b.example.com")).toBeNull();
    expect(await directory.environmentFor("gym-b")).toBeNull();
  });

  it("answers null for an id that is not a client's, without building anything", async () => {
    await seedTwoClients();
    const directory = new ClientDirectory(manyClientEnv());
    for (const id of ["gym-z", "GYM-A", "admin", "gym-a ", ""]) {
      expect(await directory.environmentFor(id), id).toBeNull();
      expect(await directory.client(id), id).toBeNull();
    }
  });

  it("is refused on a single-client deployment", () => {
    expect(() => new ClientDirectory({ DB: real.DB })).toThrow(/REGISTRY/);
  });
});

describe("clientForRequest and environmentFor on a many-client host", () => {
  it("decide the client from the hostname and give its environment", async () => {
    await seedTwoClients();
    const host = manyClientEnv();
    const decided = await clientForRequest(host, "gym-a.example.com");
    expect(decided).toMatchObject({ mode: "many", client: { id: "gym-a" }, surface: "staff" });
    if (decided.mode !== "many" || !decided.client) throw new Error("unreachable");
    expect(clientOf(decided.env as object)).toBe("gym-a");
    expect(await environmentFor(host, "gym-a")).toBe(decided.env);
    expect(await clientForRequest(host, "nobody.example.com")).toEqual({
      mode: "many",
      client: null,
    });
    await expect(environmentFor(host, null)).rejects.toThrow(/needs the client/);
    expect(await environmentFor(host, "gym-z")).toBeNull();
  });

  it("read the registry the directory read, which matches readRegistry", async () => {
    await seedTwoClients();
    const snapshot = await readRegistry(real.REGISTRY);
    const directory = new ClientDirectory(manyClientEnv());
    expect((await directory.snapshot()).version).toBe(snapshot.version);
  });
});
