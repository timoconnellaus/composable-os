// The client's environment (stage 66 step 3, ADR 0613): with no registry it is the real `env`;
// on a many-client host it is handed out only for a client that is served, holds that client's
// database and settings, is frozen, and has no data property or getter that leads to the
// registry, to every client's databases or to the real `env`.
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ClientDb } from "../src/client-db.ts";
import type { ClientDbQueryService } from "../src/client-db-service.ts";
import * as published from "../src/client-environment.ts";
import {
  ClientDirectory,
  clientForRequest,
  clientOf,
  environmentFor,
  envNameUse,
  type HostBindings,
  hostDirectory,
  hostEnvironment,
  hostMode,
  keepRateLimitApart,
} from "../src/client-environment.ts";
import { buildClientEnvironment } from "../src/client-environment-build.ts";
import { CORE_SCHEMA_VERSION } from "../src/migrate.ts";
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
  CLIENT_DB_QUERIES: ClientDbQueryService;
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
function manyClientEnv(registry: D1Database = real.REGISTRY, environment = "live") {
  return {
    DB: real.DB,
    REGISTRY: registry,
    // The operator's raw namespace (left out of every client's environment) and the query path
    // the host's Workers bind (stage 66 step 2), which a client's DB goes through.
    CLIENT_DB: real.CLIENT_DB,
    CLIENT_DB_QUERIES: real.CLIENT_DB_QUERIES,
    COS_HOST_ENVIRONMENT: environment,
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
    STREAM_API_TOKEN: "the-accounts-stream-token",
    STREAM_SIGNING_JWK: "the-accounts-signing-key",
    // Shared.
    STREAM_ACCOUNT_ID: "stream-account",
    LOADER: { name: "loader" },
    GATEKEEPER_GOOGLE: { name: "google" },
    // Holds one deployment's Stripe key and events: left out until it is per client (ADR 0616).
    GATEKEEPER_PAYMENTS: { name: "payments" },
    // Kept apart: each by its wrapper (rate limits, files and the runner here).
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
  schemaVersion: CORE_SCHEMA_VERSION,
  secretGeneration: "0123456789abcdef0123456789abcdef",
  imported: false,
};

/** The environment of a served admission, or a failure naming why it was refused. */
function served<E>(admission: { served: true; env: E } | { served: false; refused: string }): E {
  if (!admission.served) throw new Error(`refused: ${admission.refused}`);
  return admission.env;
}

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
    const own = await environmentFor(single, null);
    expect(own).toEqual({ mode: "single", served: true, env: single });
    expect(own.served && own.env).toBe(single);
    const decided = await clientForRequest(single, "anything.example.com");
    expect(decided).toEqual({ mode: "single", served: true, env: single });
    expect(decided.served && decided.env).toBe(single);
    expect((single as { DB: D1Database }).DB).toBe(real.DB);
    expect(clientOf(single)).toBeNull();
    // Nothing is frozen or changed on the real env.
    expect(Object.isFrozen(single)).toBe(false);
  });

  it("refuses a client named on a single-client deployment", async () => {
    await expect(environmentFor({ DB: real.DB }, "gym-a")).rejects.toThrow(/single-client/);
  });

  it("is the mode of the test Worker's own env, whose DB is the D1 binding", async () => {
    expect(hostMode({ DB: real.DB })).toBe("single");
  });
});

describe("hostMode and hostEnvironment", () => {
  it("refuse a registry with no CLIENT_DB, never falling back to the one D1 database", () => {
    expect(() => hostMode({ DB: real.DB, REGISTRY: real.REGISTRY })).toThrow(/CLIENT_DB/);
    expect(hostMode(manyClientEnv())).toBe("many");
  });

  it("read the deployment's environment from env, and refuse a host without one", () => {
    expect(hostEnvironment(manyClientEnv())).toBe("live");
    expect(hostEnvironment(manyClientEnv(real.REGISTRY, "staging"))).toBe("staging");
    for (const value of [undefined, "", "production", "LIVE"]) {
      const host = { ...manyClientEnv(), COS_HOST_ENVIRONMENT: value };
      expect(() => hostEnvironment(host), String(value)).toThrow(/COS_HOST_ENVIRONMENT/);
      expect(() => new ClientDirectory(host), String(value)).toThrow(/COS_HOST_ENVIRONMENT/);
    }
  });
});

describe("the package's exports", () => {
  it("do not include building an environment: only the directory builds one", () => {
    expect(Object.keys(published)).not.toContain("buildClientEnvironment");
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
        // Kept apart by step 4's wrappers (client-bindings.ts), never the real bindings.
        "BLOBS",
        "COS_CLIENT_ID",
        "COS_ORG_EXTENSIONS",
        "COS_PACKS",
        "DB",
        "GATEKEEPER_GOOGLE",
        "LOADER",
        "MCP_RATE_LIMIT",
        "RUNNER",
        "STREAM_ACCOUNT_ID",
      ].sort(),
    );
    expect(built.BLOBS).not.toBe(host.BLOBS);
    expect(built.RUNNER).not.toBe(host.RUNNER);
    // The client's own settings, else the deployment's (`inherit`), else nothing (`empty`).
    expect(built.APPROVAL_FLOOR).toBe("high");
    expect(built.COS_ORG_EXTENSIONS).toBe("gym-a-hash");
    expect(built.COS_PACKS).toBe("*");
    expect("API_ALLOWED_ORIGINS" in built).toBe(false);
    // The account's Stream token and signing key are kept apart, so left out with no wrapper.
    expect("STREAM_API_TOKEN" in built).toBe(false);
    expect("STREAM_SIGNING_JWK" in built).toBe(false);
    // Shared values are the same objects.
    expect(built.LOADER).toBe(host.LOADER);
    expect(built.GATEKEEPER_GOOGLE).toBe(host.GATEKEEPER_GOOGLE);
    expect("GATEKEEPER_PAYMENTS" in built).toBe(false);
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

  it("is frozen, with what it made for the client: a write below the entry throws and does not persist", () => {
    const host = manyClientEnv();
    const built = buildClientEnvironment(host, { client: gymA, settings: {} }) as unknown as Record<
      string,
      unknown
    >;
    expect(Object.isFrozen(built)).toBe(true);
    expect(Object.isFrozen(built.DB)).toBe(true);
    expect(Object.isFrozen(built.MCP_RATE_LIMIT)).toBe(true);
    expect(() => {
      built.APPROVAL_FLOOR = "none";
    }).toThrow(TypeError);
    expect(() => {
      built.REGISTRY = real.REGISTRY;
    }).toThrow(TypeError);
    expect(() => {
      delete built.DB;
    }).toThrow(TypeError);
    expect(() => {
      (built.DB as { prepare: unknown }).prepare = () => null;
    }).toThrow(TypeError);
    expect(built.APPROVAL_FLOOR).toBe("medium");
    expect("REGISTRY" in built).toBe(false);
    // The host's own shared objects are not frozen by it.
    expect(Object.isFrozen(host.LOADER)).toBe(false);
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
    await keepRateLimitApart(limiter, "gym-b" as ClientId, {}).limit({ key: "gym-a:app-1" });
    expect(limiter.keys).toEqual(["gym-b:gym-a:app-1"]);
  });

  it("has no data property or getter that leads to the registry, every client's databases, the real env or D1", () => {
    const host = manyClientEnv();
    const built = buildClientEnvironment(host, { client: gymA, settings: {} });
    walkForEscapes(built, host);
    walkForEscapes((built.DB as D1Database).withSession(), host);
  });

  it("the walk itself finds an escape through a getter or an escape-hatch method", () => {
    const host = manyClientEnv();
    const withGetter = {
      DB: {
        get raw() {
          return real.REGISTRY;
        },
      },
    };
    expect(() => walkForEscapes(withGetter, host)).toThrow();
    // A getter of any name is called, so what it returns is walked.
    const plainGetter = {
      VECTORIZE: {
        get stats() {
          return { index: real.CLIENT_DB };
        },
      },
    };
    expect(() => walkForEscapes(plainGetter, host)).toThrow(/forbidden/);
    const withHatch = { BLOBS: { get: () => null, unwrap: () => host.BLOBS } };
    expect(() => walkForEscapes(withHatch, host)).toThrow(/escape hatch/);
    class Wrapped {
      #binding = real.CLIENT_DB;
      get binding() {
        return this.#binding;
      }
    }
    expect(() => walkForEscapes({ X: new Wrapped() }, host)).toThrow();
  });

  it("creates the client's database at its location hint, named by its id", async () => {
    // The query service as the host's Workers bind it: each call names its target.
    const calls: unknown[] = [];
    const service = new Proxy(
      {},
      {
        get: (_target, method) =>
          method === "then"
            ? undefined
            : async (target: unknown) => {
                calls.push(target);
                throw new Error("not a database");
              },
      },
    ) as unknown as ClientDbQueryService;
    const host = { ...manyClientEnv(), CLIENT_DB_QUERIES: service };
    const built = buildClientEnvironment(host, { client: gymA, settings: {} });
    await built.DB.prepare("SELECT 1")
      .all()
      .catch(() => undefined);
    expect(calls[0]).toEqual({ client: "gym-a", locationHint: "oc" });
    const nowhere = buildClientEnvironment(host, {
      client: { ...gymA, locationHint: null },
      settings: {},
    });
    await nowhere.DB.prepare("SELECT 1")
      .all()
      .catch(() => undefined);
    expect(calls.at(-1)).toEqual({ client: "gym-a" });
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

/** Names a wrapper must never have: a way back to the real binding. */
const ESCAPE_HATCH =
  /^(?:raw|unwrap|unwrapped|inner|binding|target|real|underlying|original|unsafe|escape|source|delegate)$/i;

/**
 * Walks every own property of `value` and its prototypes, data and accessor alike (a getter is
 * called), and fails on any value that is the registry, `CLIENT_DB`, the real `env` or the D1
 * binding, and on any function named like an escape hatch. It cannot see into closures: what a
 * method does with its arguments is for behavioural tests (each wrapper's, step 4).
 */
function walkForEscapes(root: unknown, host: object): void {
  const forbidden = new Set<unknown>([
    host,
    real.REGISTRY,
    real.CLIENT_DB,
    real.CLIENT_DB_QUERIES,
    real.DB,
  ]);
  const seen = new Set<unknown>();
  const walk = (value: unknown, path: string, depth: number) => {
    if (value === null || (typeof value !== "object" && typeof value !== "function")) return;
    if (forbidden.has(value)) throw new Error(`${path} leads to a forbidden binding`);
    if (seen.has(value) || depth > 8) return;
    seen.add(value);
    for (const key of Reflect.ownKeys(value as object)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor) continue;
      const at = `${path}.${String(key)}`;
      if (typeof key === "string" && ESCAPE_HATCH.test(key)) {
        const held = "value" in descriptor ? descriptor.value : undefined;
        if (typeof held === "function" || descriptor.get) {
          throw new Error(`${at} is named like an escape hatch`);
        }
      }
      if ("value" in descriptor) {
        walk(descriptor.value, at, depth + 1);
      } else if (descriptor.get) {
        walk(Reflect.apply(descriptor.get, value, []), at, depth + 1);
      }
    }
    const proto = Object.getPrototypeOf(value);
    if (proto && proto !== Object.prototype && proto !== Function.prototype) {
      for (const key of Reflect.ownKeys(proto)) {
        const descriptor = Object.getOwnPropertyDescriptor(proto, key);
        if (descriptor?.get) {
          walk(Reflect.apply(descriptor.get, value, []), `${path}.${String(key)}`, depth + 1);
        }
        if (typeof key === "string" && ESCAPE_HATCH.test(key)) {
          throw new Error(`${path}.${key} is named like an escape hatch`);
        }
      }
    }
  };
  walk(root, "env", 0);
}

describe("envNameUse", () => {
  it("leaves out what it does not list", () => {
    expect(envNameUse("SOMETHING_NEW")).toBeNull();
    expect(envNameUse("REGISTRY")).toMatchObject({ use: "host" });
    expect(envNameUse("CLIENT_DB")).toMatchObject({ use: "host" });
    expect(envNameUse("APPROVAL_FLOOR")).toEqual({ use: "setting" });
    expect(envNameUse("AI_KEY_ANTHROPIC")).toMatchObject({ use: "per-client", what: "secret" });
    expect(envNameUse("GATEKEEPER_SLACK")).toMatchObject({ use: "shared" });
    expect(envNameUse("PUBLIC_RATE_LIMIT")).toMatchObject({ use: "kept-apart" });
    expect(envNameUse("STREAM_API_TOKEN")).toMatchObject({ use: "kept-apart" });
  });
});

async function seedClients() {
  await real.REGISTRY.batch([
    insertClient(real.REGISTRY, { id: "gym-a", locationHint: "oc" }),
    insertClient(real.REGISTRY, { id: "gym-b" }),
    insertClient(real.REGISTRY, { id: "gym-p", status: "paused" }),
    insertClient(real.REGISTRY, { id: "gym-m", status: "moving" }),
    insertClient(real.REGISTRY, { id: "gym-n", schemaVersion: null }),
    insertClient(real.REGISTRY, { id: "gym-o", schemaVersion: CORE_SCHEMA_VERSION - 1 }),
    insertClient(real.REGISTRY, { id: "gym-s", environment: "staging" }),
    insertHostname(real.REGISTRY, "gym-a.example.com", "gym-a", "staff"),
    insertHostname(real.REGISTRY, "shop.gym-a.com", "gym-a", "web"),
    insertHostname(real.REGISTRY, "gym-b.example.com", "gym-b", "staff"),
    insertHostname(real.REGISTRY, "pending.gym-b.com", "gym-b", "web", false),
    insertHostname(real.REGISTRY, "gym-p.example.com", "gym-p", "staff"),
    insertHostname(real.REGISTRY, "gym-m.example.com", "gym-m", "staff"),
    insertHostname(real.REGISTRY, "gym-n.example.com", "gym-n", "staff"),
    insertHostname(real.REGISTRY, "gym-s.example.com", "gym-s", "staff"),
    insertSetting(real.REGISTRY, "gym-a", "APPROVAL_FLOOR", "high"),
  ]);
}

describe("ClientDirectory", () => {
  it("serves a client by its verified hostname, exactly, whatever the hostname's case", async () => {
    await seedClients();
    const directory = new ClientDirectory(manyClientEnv());
    const a = await directory.clientForHostname("gym-a.example.com");
    expect(a).toMatchObject({ served: true, client: { id: "gym-a" }, surface: "staff" });
    expect(clientOf(served(a) as object)).toBe("gym-a");
    expect(await directory.clientForHostname("GYM-A.example.com")).toMatchObject({
      served: true,
      client: { id: "gym-a" },
    });
    expect(await directory.clientForHostname("shop.gym-a.com")).toMatchObject({
      served: true,
      surface: "web",
    });
  });

  it("refuses by default: paused, moving and behind are never served, and carry no env", async () => {
    await seedClients();
    const directory = new ClientDirectory(manyClientEnv());
    const cases: [string, string][] = [
      ["gym-p", "paused"],
      ["gym-m", "moving"],
      ["gym-n", "schema-behind"],
      ["gym-o", "schema-behind"],
    ];
    for (const [id, refused] of cases) {
      const byId = await directory.environmentFor(id);
      expect(byId, id).toEqual({ served: false, refused, client: expect.objectContaining({ id }) });
      expect("env" in byId, id).toBe(false);
      const decided = await environmentFor(manyClientEnv(), id);
      expect(decided, id).toMatchObject({ mode: "many", served: false, refused });
      expect("env" in decided, id).toBe(false);
    }
    for (const [host, refused] of [
      ["gym-p.example.com", "paused"],
      ["gym-m.example.com", "moving"],
      ["gym-n.example.com", "schema-behind"],
    ] as const) {
      const byHost = await directory.clientForHostname(host);
      expect(byHost, host).toMatchObject({ served: false, refused });
      expect("env" in byHost, host).toBe(false);
    }
  });

  it("never derives a client from a hostname: no suffix, prefix, label, port or unverified match", async () => {
    await seedClients();
    const directory = new ClientDirectory(manyClientEnv());
    for (const host of [
      "gym-a", // the client's id alone
      "x.gym-a.example.com", // a name under a client's hostname
      "evil-gym-a.example.com",
      "gym-a.example.com.evil.com",
      "gym-a.example.co",
      "example.com",
      "gym-a.composableos.app", // where the fleet's name would be, not in the registry
      "gym-a.example.com:443",
      "gym-a.example.com\u0000",
      "gym-a.example.com/x",
      "gym-a.example.com, gym-b.example.com",
      "",
      null,
      undefined,
    ]) {
      expect(await directory.clientForHostname(host), String(host)).toEqual({
        served: false,
        refused: "unknown",
        client: null,
      });
    }
    expect(await directory.clientForHostname("pending.gym-b.com")).toEqual({
      served: false,
      refused: "unverified",
      client: null,
    });
  });

  it("finds only the deployment's environment, read from env", async () => {
    await seedClients();
    const live = new ClientDirectory(manyClientEnv());
    expect(live.environment).toBe("live");
    expect(await live.clientForHostname("gym-s.example.com")).toMatchObject({
      served: false,
      refused: "unknown",
    });
    expect(await live.environmentFor("gym-s")).toMatchObject({ served: false, refused: "unknown" });
    expect(await live.client("gym-s")).toBeNull();
    const staging = new ClientDirectory(manyClientEnv(real.REGISTRY, "staging"));
    expect(await staging.clientForHostname("gym-s.example.com")).toMatchObject({
      served: true,
      client: { id: "gym-s" },
    });
    expect(await staging.clientForHostname("gym-a.example.com")).toMatchObject({ served: false });
  });

  it("keeps the deployment's environment whoever asks first (hostDirectory takes no options)", async () => {
    await seedClients();
    const host = manyClientEnv();
    await clientForRequest(host, "gym-a.example.com");
    const directory = hostDirectory(host);
    expect(directory?.environment).toBe("live");
    expect(await directory?.client("gym-s")).toBeNull();
    expect(await environmentFor(host, "gym-s")).toMatchObject({
      served: false,
      refused: "unknown",
    });
  });

  it("lists active clients for a cron's fan-out", async () => {
    await seedClients();
    const directory = new ClientDirectory(manyClientEnv());
    expect((await directory.activeClients()).sort()).toEqual(["gym-a", "gym-b", "gym-n", "gym-o"]);
  });

  it("gives each client one stable environment until the registry changes", async () => {
    await seedClients();
    let now = 0;
    const meter = metered(real.REGISTRY);
    const directory = new ClientDirectory(manyClientEnv(meter.db), {
      refreshMs: 1_000,
      now: () => now,
    });
    const a1 = served(await directory.environmentFor("gym-a"));
    const b1 = served(await directory.environmentFor("gym-b"));
    expect(a1).not.toBe(b1);
    expect((a1 as unknown as { APPROVAL_FLOOR: string }).APPROVAL_FLOOR).toBe("high");
    expect((b1 as unknown as { APPROVAL_FLOOR: string }).APPROVAL_FLOOR).toBe("medium");
    const afterFirst = meter.statements();
    // The registry in one batch of four, and each built client's sealed secrets, one read each
    // (stage 66 step 6: never in the snapshot).
    expect(afterFirst).toBe(4 + 2);
    // Within the refresh: no read at all, however many requests and hostnames.
    for (let i = 0; i < 50; i++) await directory.clientForHostname(`unknown-${i}.example.com`);
    expect(served(await directory.environmentFor("gym-a"))).toBe(a1);
    expect(meter.statements()).toBe(afterFirst);
    // After it: one row read, and the same environment while the stamp is the same.
    now = 1_500;
    expect(served(await directory.environmentFor("gym-a"))).toBe(a1);
    expect(meter.statements()).toBe(afterFirst + 1);
    // The operator changes a setting: the next check reads it, and the environment is rebuilt.
    await insertSetting(real.REGISTRY, "gym-b", "APPROVAL_FLOOR", "critical").run();
    now = 3_000;
    const a2 = served(await directory.environmentFor("gym-a"));
    const b2 = served(await directory.environmentFor("gym-b"));
    expect(a2).not.toBe(a1);
    expect((b2 as unknown as { APPROVAL_FLOOR: string }).APPROVAL_FLOOR).toBe("critical");
    expect(meter.statements()).toBe(afterFirst + 1 + 1 + 4 + 2);
  });

  it("stops serving a client the operator removed or paused, at the next check", async () => {
    await seedClients();
    let now = 0;
    const directory = new ClientDirectory(manyClientEnv(), { refreshMs: 1_000, now: () => now });
    expect(await directory.clientForHostname("gym-b.example.com")).toMatchObject({ served: true });
    expect(await directory.clientForHostname("gym-a.example.com")).toMatchObject({ served: true });
    await real.REGISTRY.prepare("DELETE FROM registry_clients WHERE id = 'gym-b'").run();
    await real.REGISTRY.prepare(
      "UPDATE registry_clients SET status = 'moving' WHERE id = 'gym-a'",
    ).run();
    now = 2_000;
    expect(await directory.clientForHostname("gym-b.example.com")).toMatchObject({
      served: false,
      refused: "unknown",
    });
    expect(await directory.environmentFor("gym-b")).toMatchObject({ served: false });
    expect(await directory.environmentFor("gym-a")).toMatchObject({
      served: false,
      refused: "moving",
    });
  });

  it("never lets an older read of the registry replace a newer one", async () => {
    await seedClients();
    let now = 0;
    // A registry whose reads can be held back: the first full read waits until released.
    let release: () => void = () => undefined;
    let holdNext = false;
    const slow = new Proxy(real.REGISTRY, {
      get(target, key) {
        if (key === "batch") {
          return async (list: D1PreparedStatement[]) => {
            const answer = await target.batch(list);
            if (holdNext) {
              holdNext = false;
              await new Promise<void>((resolve) => {
                release = resolve;
              });
            }
            return answer;
          };
        }
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const directory = new ClientDirectory(manyClientEnv(slow), {
      refreshMs: 1_000,
      now: () => now,
    });
    // The older read (with gym-b) is held while the operator removes gym-b and a newer read lands.
    holdNext = true;
    const older = directory.snapshot();
    await new Promise((resolve) => setTimeout(resolve, 10));
    await real.REGISTRY.prepare("DELETE FROM registry_clients WHERE id = 'gym-b'").run();
    now = 5;
    const newer = await directory.snapshot();
    expect(newer.clients.has("gym-b" as ClientId)).toBe(false);
    release();
    await older;
    expect(await directory.environmentFor("gym-b")).toMatchObject({
      served: false,
      refused: "unknown",
    });
  });

  it("fails the call, never serving a stale copy, when the registry cannot be read", async () => {
    await seedClients();
    let now = 0;
    let broken = false;
    const flaky = new Proxy(real.REGISTRY, {
      get(target, key) {
        if (key === "prepare" && broken) {
          return () => {
            throw new Error("D1_ERROR: the registry is unavailable");
          };
        }
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const directory = new ClientDirectory(manyClientEnv(flaky), {
      refreshMs: 1_000,
      now: () => now,
    });
    expect(await directory.environmentFor("gym-a")).toMatchObject({ served: true });
    broken = true;
    now = 2_000;
    await expect(directory.environmentFor("gym-a")).rejects.toThrow(/unavailable/);
  });

  it("answers unknown for an id that is not a client's, without building anything", async () => {
    await seedClients();
    const directory = new ClientDirectory(manyClientEnv());
    for (const id of ["gym-z", "GYM-A", "admin", "gym-a ", ""]) {
      expect(await directory.environmentFor(id), id).toEqual({
        served: false,
        refused: "unknown",
        client: null,
      });
      expect(await directory.client(id), id).toBeNull();
    }
  });

  it("is refused on a single-client deployment", () => {
    expect(() => new ClientDirectory({ DB: real.DB })).toThrow(/REGISTRY/);
  });
});

describe("clientForRequest and environmentFor on a many-client host", () => {
  it("decide the client from the hostname and give its environment only when served", async () => {
    await seedClients();
    const host = manyClientEnv();
    const decided = await clientForRequest(host, "gym-a.example.com");
    expect(decided).toMatchObject({
      mode: "many",
      served: true,
      client: { id: "gym-a" },
      surface: "staff",
    });
    const env = served(decided);
    expect(clientOf(env as object)).toBe("gym-a");
    expect(served(await environmentFor(host, "gym-a"))).toBe(env);
    expect(await clientForRequest(host, "nobody.example.com")).toEqual({
      mode: "many",
      served: false,
      refused: "unknown",
      client: null,
    });
    await expect(environmentFor(host, null)).rejects.toThrow(/needs the client/);
    expect(await environmentFor(host, "gym-z")).toMatchObject({
      served: false,
      refused: "unknown",
    });
  });

  it("read the registry the directory read, which matches readRegistry", async () => {
    await seedClients();
    const snapshot = await readRegistry(real.REGISTRY);
    const directory = new ClientDirectory(manyClientEnv());
    expect((await directory.snapshot()).stamp).toBe(snapshot.stamp);
  });
});
