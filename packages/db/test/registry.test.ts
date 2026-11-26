// The registry of a many-client host (stage 66 step 3, ADR 0613): its migrations, its version
// stamp, the shapes it refuses, client ids, hostnames, the one read of it and D1's limits.
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as db from "../src/index.ts";
import { CORE_SCHEMA_VERSION } from "../src/migrate.ts";
import {
  canonicalHostname,
  clientIdProblem,
  isClientId,
  isSchemaBehind,
  readRegistry,
  readRegistryStamp,
  readRegistryVersion,
  validateClientId,
} from "../src/registry.ts";
import {
  emptyRegistry,
  insertClient,
  insertHostname,
  insertSetting,
  metered,
  migrateRegistry,
} from "./registry-fixtures.ts";

const registry = env.REGISTRY;

beforeAll(async () => {
  await migrateRegistry();
});

beforeEach(async () => {
  await emptyRegistry();
});

describe("the registry's migrations", () => {
  it("are its own: recorded in registry_migrations, with no core table and no core_meta", async () => {
    expect(await migrateRegistry()).toEqual([]);
    const { results } = await registry
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all<{ name: string }>();
    const tables = results.map((r) => r.name).filter((n) => !n.startsWith("_cf_"));
    expect(tables).toEqual([
      "registry_clients",
      "registry_hostnames",
      "registry_meta",
      "registry_migrations",
      // The operator's commands' progress (migration 0795, stage 66 step 7).
      "registry_operations",
      "registry_operator_session",
      "registry_removed_clients",
      "registry_secrets",
      "registry_settings",
      "sqlite_sequence",
    ]);
    // The host's D1 database never gains a registry table.
    const host = await env.DB.prepare(
      "SELECT count(*) AS n FROM sqlite_master WHERE name LIKE 'registry\\_%' ESCAPE '\\'",
    ).first<{ n: number }>();
    expect(host?.n).toBe(0);
  });

  it("are not the host's: no registry migration is among the host's", () => {
    const host = new Set(env.TEST_MIGRATIONS.map((m) => m.name));
    for (const migration of env.REGISTRY_MIGRATIONS) expect(host.has(migration.name)).toBe(false);
  });
});

describe("the version stamp", () => {
  it("moves on every write to every table", async () => {
    const stamps = [await readRegistryVersion(registry)];
    const step = async (statement: D1PreparedStatement) => {
      await statement.run();
      stamps.push(await readRegistryVersion(registry));
    };
    await step(insertClient(registry, { id: "gym-a" }));
    await step(
      registry.prepare("UPDATE registry_clients SET status = 'paused' WHERE id = 'gym-a'"),
    );
    await step(insertHostname(registry, "gym-a.example.com", "gym-a"));
    await step(registry.prepare("UPDATE registry_hostnames SET verified = 0"));
    await step(insertSetting(registry, "gym-a", "APPROVAL_FLOOR", "high"));
    await step(registry.prepare("UPDATE registry_settings SET value = 'medium'"));
    await step(
      registry.prepare(
        "INSERT INTO registry_secrets (client, name, kind, enc, ciphertext, key_id) VALUES ('gym-a', 'AI_KEY_OPENAI', 'given', zeroblob(32), zeroblob(32), 'k2-0000000000000000')",
      ),
    );
    await step(registry.prepare("UPDATE registry_secrets SET key_id = 'k2-1111111111111111'"));
    await step(registry.prepare("DELETE FROM registry_secrets"));
    await step(registry.prepare("DELETE FROM registry_settings"));
    await step(registry.prepare("DELETE FROM registry_hostnames"));
    await step(registry.prepare("DELETE FROM registry_clients"));
    for (let i = 1; i < stamps.length; i++) {
      expect(stamps[i], `write ${i}`).toBeGreaterThan(stamps[i - 1] as number);
    }
  });
});

describe("what the registry refuses", () => {
  const refused = async (statement: D1PreparedStatement) =>
    expect(statement.run()).rejects.toThrow(/CHECK constraint failed|FOREIGN KEY/);

  it("a client id of the wrong shape", async () => {
    for (const id of ["ab", "Gym", "1gym", "gym-", "gy--m", "gym_a", "gym.a", "a".repeat(31), ""]) {
      await refused(insertClient(registry, { id }));
    }
    await insertClient(registry, { id: "gym-a1" }).run();
  });

  it("an unknown status, tier, environment or location hint", async () => {
    await refused(insertClient(registry, { id: "gym-a", status: "deleted" as never }));
    await refused(insertClient(registry, { id: "gym-a", tier: "own-account" as never }));
    await refused(insertClient(registry, { id: "gym-a", environment: "dev" as never }));
    await refused(insertClient(registry, { id: "gym-a", locationHint: "mars" }));
    await refused(insertClient(registry, { id: "gym-a", repository: "no-slash" }));
  });

  it("a hostname that is not canonical, and one of no client", async () => {
    await insertClient(registry, { id: "gym-a" }).run();
    for (const hostname of [
      "Gym-A.example.com",
      "gym-a.example.com.",
      ".example.com",
      "a..b",
      "gym-a.example.com:443",
      "gym a.example.com",
      "",
      "-gym.example.com",
      "gym.example.com-",
      "gym.-example.com",
      "gym-.example.com",
      "127.0.0.1",
      "10.0.0.12",
    ]) {
      await refused(insertHostname(registry, hostname, "gym-a"));
    }
    await refused(insertHostname(registry, "gym-b.example.com", "gym-b"));
    await refused(insertHostname(registry, "gym-a.example.com", "gym-a", "api" as never));
  });

  it("a setting or secret name that is not an env name", async () => {
    await insertClient(registry, { id: "gym-a" }).run();
    await refused(insertSetting(registry, "gym-a", "approval_floor", "high"));
    await refused(insertSetting(registry, "gym-a", "APPROVAL-FLOOR", "high"));
  });

  it("two clients on one hostname", async () => {
    await registry.batch([
      insertClient(registry, { id: "gym-a" }),
      insertClient(registry, { id: "gym-b" }),
      insertHostname(registry, "gym.example.com", "gym-a"),
    ]);
    await expect(insertHostname(registry, "gym.example.com", "gym-b").run()).rejects.toThrow(
      /UNIQUE/,
    );
  });

  it("removes a client's hostnames, settings and secrets with it", async () => {
    await registry.batch([
      insertClient(registry, { id: "gym-a" }),
      insertHostname(registry, "gym-a.example.com", "gym-a"),
      insertSetting(registry, "gym-a", "APPROVAL_FLOOR", "high"),
    ]);
    await registry.prepare("DELETE FROM registry_clients WHERE id = 'gym-a'").run();
    const snapshot = await readRegistry(registry);
    expect(snapshot.hostnames.size).toBe(0);
    const left = await registry
      .prepare(
        "SELECT (SELECT count(*) FROM registry_hostnames) + (SELECT count(*) FROM registry_settings) AS n",
      )
      .first<{ n: number }>();
    expect(left?.n).toBe(0);
  });

  it("never takes a removed client's id again, and never changes a client's id (#515, S3)", async () => {
    await registry.batch([
      insertClient(registry, { id: "gym-a" }),
      insertClient(registry, { id: "gym-b" }),
    ]);
    const before = await registry
      .prepare("SELECT secret_generation FROM registry_clients WHERE id = 'gym-a'")
      .first<{ secret_generation: string }>();
    await registry.prepare("DELETE FROM registry_clients WHERE id = 'gym-a'").run();
    // Kept, with the generation it had, so what was made for it is told apart from anything later.
    expect(
      await registry
        .prepare("SELECT id, environment, secret_generation FROM registry_removed_clients")
        .all(),
    ).toMatchObject({
      results: [{ id: "gym-a", environment: "live", secret_generation: before?.secret_generation }],
    });
    // Its objects, database and parked messages would be the new client's: refused.
    await expect(insertClient(registry, { id: "gym-a" }).run()).rejects.toThrow(/never used again/);
    await expect(
      insertClient(registry, { id: "gym-a", environment: "staging" }).run(),
    ).rejects.toThrow(/never used again/);
    await expect(
      registry.prepare("UPDATE registry_clients SET id = 'gym-c' WHERE id = 'gym-b'").run(),
    ).rejects.toThrow(/id never changes/);
  });

  it("refuses INSERT OR REPLACE of a client it has: no new generation, no other environment (review of #520, S1)", async () => {
    await registry.batch([insertClient(registry, { id: "gym-a" })]);
    const read = () =>
      registry
        .prepare("SELECT environment, secret_generation FROM registry_clients WHERE id = 'gym-a'")
        .first<{ environment: string; secret_generation: string }>();
    const before = await read();
    for (const environment of ["live", "staging"]) {
      await expect(
        registry
          .prepare(
            "INSERT OR REPLACE INTO registry_clients (id, environment, tier) VALUES ('gym-a', ?, 'standard')",
          )
          .bind(environment)
          .run(),
        environment,
      ).rejects.toThrow(/never used again, nor added twice/);
    }
    expect(await read()).toEqual(before);
    expect(
      (await registry.prepare("SELECT count(*) AS n FROM registry_removed_clients").first("n")) ??
        0,
    ).toBe(0);
  });
});

describe("client ids", () => {
  it("are lowercase letters, digits and single hyphens, 3 to 30 long, starting with a letter", () => {
    for (const id of ["gym", "gym-a", "ghetto", "gym-a2", "a1b", "a".repeat(30)]) {
      expect(clientIdProblem(id), id).toBeNull();
    }
    for (const id of ["ab", "a".repeat(31), "Gym", "1gym", "-gym", "gym-", "gy--m", "gym_a"]) {
      expect(isClientId(id), id).toBe(false);
    }
    for (const id of ["gym.a", "gym/a", "gym:a", "gym a", "gým", "gym\n", "", 7, null, undefined]) {
      expect(isClientId(id), String(id)).toBe(false);
    }
  });

  it("are never a reserved word, a platform prefix or a surface's ending", () => {
    for (const id of [
      "admin",
      "www",
      "registry",
      "staging",
      "api",
      "mcp",
      "cos",
      "undefined",
      "callback",
      "webhook",
      "mail",
      "status",
      "docs",
      "app",
      "fleet",
      "login",
      "billing",
      "media",
      "files",
    ]) {
      expect(clientIdProblem(id), id).toMatch(/reserved/);
    }
    for (const id of ["cos-app", "xn-gym"]) expect(clientIdProblem(id), id).toMatch(/start/);
    for (const id of ["gym-a-admin", "gym-staging", "gym-desk", "gym-web", "gym-staff"]) {
      expect(clientIdProblem(id), id).toMatch(/end/);
    }
  });

  it("are refused by validateClientId with the reason", () => {
    expect(validateClientId("gym-a")).toBe("gym-a");
    expect(() => validateClientId("Admin")).toThrow(RangeError);
    expect(() => validateClientId("admin")).toThrow(/reserved/);
  });
});

describe("canonicalHostname", () => {
  it("is the hostname lowercased, without one trailing dot", () => {
    expect(canonicalHostname("Gym-A.ComposableOS.app")).toBe("gym-a.composableos.app");
    expect(canonicalHostname("gym-a.composableos.app.")).toBe("gym-a.composableos.app");
    expect(canonicalHostname("localhost")).toBe("localhost");
    expect(canonicalHostname("0x7f.com")).toBe("0x7f.com");
    expect(canonicalHostname("gym1.app2")).toBe("gym1.app2");
  });

  it("refuses any port and anything numeric-looking", () => {
    for (const host of [
      "gym-a.composableos.app:8443",
      "gym-a.composableos.app:0",
      "gym-a.composableos.app:",
      "localhost:5173",
      "127.1",
      "0x7f.1",
      "127.0.0.1",
      "2130706433",
      "0x7f000001",
      "gym.123",
    ]) {
      expect(canonicalHostname(host), host).toBeNull();
    }
  });

  it("is null for anything that is not a plain DNS name", () => {
    for (const host of [
      null,
      undefined,
      "",
      ".",
      "gym..app",
      "gym.app..",
      "-gym.app",
      "gym-.app",
      "gym_a.app",
      "gym a.app",
      "gým.app",
      "gym.app/evil",
      "gym.app@evil.com",
      "gym.app\r\nx",
      "[::1]",
      "[::1]:443",
      "::1",
      "127.0.0.1",
      "10.0.0.1:80",
      "gym.app:99999x",
      `${"a".repeat(64)}.app`,
      `${"a.".repeat(127)}app`,
    ]) {
      expect(canonicalHostname(host as string), String(host)).toBeNull();
    }
  });
});

describe("readRegistry", () => {
  it("reads every client, its settings and its verified hostnames, leaving out what the code refuses", async () => {
    await registry.batch([
      insertClient(registry, { id: "gym-a", locationHint: "oc", schemaVersion: 7 }),
      insertClient(registry, { id: "gym-b", tier: "bespoke", repository: "us/gym-b" }),
      // A reserved word the shape check lets through: the code never accepts it.
      insertClient(registry, { id: "admin" }),
      insertHostname(registry, "gym-a.example.com", "gym-a", "staff"),
      insertHostname(registry, "gym-a-shop.example.com", "gym-a", "web", false),
      insertHostname(registry, "admin.example.com", "admin"),
      insertSetting(registry, "gym-a", "APPROVAL_FLOOR", "high"),
      insertSetting(registry, "gym-a", "BETTER_AUTH_SECRET", "never-a-setting"),
    ]);
    const snapshot = await readRegistry(registry);
    expect(snapshot.version).toBe(await readRegistryVersion(registry));
    expect([...snapshot.clients.keys()].sort()).toEqual(["gym-a", "gym-b"]);
    expect(snapshot.clients.get("gym-a" as never)).toEqual({
      id: "gym-a",
      environment: "live",
      status: "active",
      tier: "standard",
      repository: null,
      locationHint: "oc",
      schemaVersion: 7,
      // Written by the registry when the client was added (migration 0792).
      secretGeneration: expect.stringMatching(/^[0-9a-f]{32}$/),
      imported: false,
    });
    expect(snapshot.settings.get("gym-a" as never)).toEqual({ APPROVAL_FLOOR: "high" });
    expect([...snapshot.hostnames.keys()]).toEqual(["gym-a.example.com"]);
    expect([...snapshot.unverified]).toEqual(["gym-a-shop.example.com"]);
  });

  it("names every row it leaves out, for the operator", async () => {
    await registry.batch([
      insertClient(registry, { id: "gym-a" }),
      insertClient(registry, { id: "admin" }),
      insertSetting(registry, "gym-a", "BETTER_AUTH_SECRET", "never-a-setting"),
      // A label over 63 characters: the table's check cannot say so, the code can.
      insertHostname(registry, `${"a".repeat(64)}.example.com`, "gym-a"),
    ]);
    const { problems, hostnames } = await readRegistry(registry);
    expect(hostnames.size).toBe(0);
    expect(problems).toHaveLength(3);
    expect(problems.join("\n")).toMatch(/client "admin" left out: "admin" is reserved/);
    expect(problems.join("\n")).toMatch(/setting BETTER_AUTH_SECRET of gym-a left out/);
    expect(problems.join("\n")).toMatch(/hostname "a{64}\.example\.com" of gym-a left out/);
  });

  it("has a stamp that never recurs, even when a restore brings its counter back", async () => {
    await insertClient(registry, { id: "gym-a" }).run();
    const before = await readRegistry(registry);
    // As a restore would: the counter back to what it was, with other rows.
    await insertClient(registry, { id: "gym-b" }).run();
    await registry
      .prepare("UPDATE registry_meta SET value = ? WHERE key = 'version'")
      .bind(before.version)
      .run();
    const after = await readRegistry(registry);
    expect(after.version).toBe(before.version);
    expect(after.stamp).not.toBe(before.stamp);
    expect(await readRegistryStamp(registry)).toBe(after.stamp);
  });

  it("stays within D1's limits with hundreds of clients: four statements, no bound parameter", async () => {
    const clients = 400;
    const statements: D1PreparedStatement[] = [];
    for (let i = 0; i < clients; i++) {
      const id = `gym-${i}`;
      statements.push(
        insertClient(registry, { id }),
        insertHostname(registry, `${id}.example.com`, id, "staff"),
        insertHostname(registry, `${id}-shop.example.com`, id, "web"),
        insertSetting(registry, id, "APPROVAL_FLOOR", "high"),
        insertSetting(registry, id, "COS_PACKS", "*"),
      );
    }
    // The operator's writes in batches below D1's 1,000 statements an invocation.
    for (let i = 0; i < statements.length; i += 500) {
      await registry.batch(statements.slice(i, i + 500));
    }
    const meter = metered(registry);
    const snapshot = await readRegistry(meter.db);
    expect(snapshot.clients.size).toBe(clients);
    expect(snapshot.hostnames.size).toBe(clients * 2);
    expect(meter.statements()).toBe(4);
    expect(meter.mostBound()).toBe(0);
    expect(await readRegistryVersion(meter.db)).toBe(snapshot.version);
    expect(meter.statements()).toBe(5);
  });

  it("refuses a registry whose migrations have not run", async () => {
    await registry.prepare("DELETE FROM registry_meta").run();
    try {
      await expect(readRegistry(registry)).rejects.toThrow(/version stamp/);
      await expect(readRegistryVersion(registry)).rejects.toThrow(/version stamp/);
    } finally {
      await registry
        .prepare("INSERT INTO registry_meta (key, value, nonce) VALUES ('version', 1, 'restored')")
        .run();
    }
  });
});

describe("isSchemaBehind", () => {
  it("is true when the recorded version is lower than the code's, or was never recorded", () => {
    expect(isSchemaBehind({ schemaVersion: null })).toBe(true);
    expect(isSchemaBehind({ schemaVersion: CORE_SCHEMA_VERSION - 1 })).toBe(true);
    expect(isSchemaBehind({ schemaVersion: CORE_SCHEMA_VERSION })).toBe(false);
    // Migrated ahead of the Workers during an update: still served by the old code.
    expect(isSchemaBehind({ schemaVersion: CORE_SCHEMA_VERSION + 1 })).toBe(false);
    expect(isSchemaBehind({ schemaVersion: 10 }, 11)).toBe(true);
  });
});

describe("@composable-os/db", () => {
  it("exports nothing of the registry or the client's environment: they are subpaths of their own", () => {
    const names = Object.keys(db);
    for (const name of names) expect(name).not.toMatch(/registry|client|environment|directory/i);
  });
});
