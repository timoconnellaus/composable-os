// A running client's settings and its first admin (stage 66 step 9, ADR 0618 "The first client's
// day one"): `cos client setting list|set|unset`, `cos client first-admin`, `cos client
// first-admin-token` and `cos client add --admin --label`, against the registry's real migrations
// on Node's SQLite.
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyMigrations, type MigrationLevel } from "@composable-os/db";
import {
  type ClientId,
  operatorSettingProblem,
  parseFirstAdmin,
  REGISTRY_MIGRATIONS_TABLE,
  readRegistry,
} from "@composable-os/db/registry";
import {
  addClientRows,
  readClientSettings,
  setClientSetting,
} from "@composable-os/db/registry-writes";
import { beforeEach, describe, expect, it } from "vitest";
import { addClient, type FleetContext } from "../src/fleet/clients.ts";
import { nodeD1 } from "../src/fleet/node-d1.ts";
import type { Operator } from "../src/fleet/operator-client.ts";
import { registryMigrations } from "../src/fleet/run.ts";
import {
  addSettingsProblems,
  firstAdminCommand,
  firstAdminTokenCommand,
  labelSetting,
  type ReleasePacks,
  settingCommand,
  setupTokenSource,
} from "../src/fleet/settings.ts";
import type { Io } from "../src/io.ts";

/** Just enough of the operator's Worker for `cos client add`. */
const operator = {
  async op<T>(action: string): Promise<T> {
    const level: MigrationLevel = {
      latest: "0001_m.sql",
      applied: 1,
      schemaVersion: 1,
      expectedSchemaVersion: 1,
      upToDate: true,
    };
    if (action === "place") return { first: true } as T;
    if (action === "migrate") return { applied: ["0001_m.sql"], failed: null, level } as T;
    if (action === "level") return level as T;
    throw new Error(`no such action ${action}`);
  },
} as unknown as Operator;

/** A release that carries four packs; Courses requires Programs and Content. */
const release: ReleasePacks = {
  carried: new Set(["ticketing", "content", "programs", "courses"]),
  requires: (packs) =>
    packs.includes("courses") ? ["programs", "content"].filter((p) => !packs.includes(p)) : [],
};

let registry: D1Database;
let lines: string[];
const io = (answers: string[] = [], interactive = false): Io => ({
  interactive,
  out: (l) => lines.push(l),
  err: (l) => lines.push(l),
  ask: async () => answers.shift() ?? "",
});
const ctx = (over: Partial<FleetContext> = {}): FleetContext => ({
  registry,
  operator,
  fleet: {
    environment: "live",
    callbackHostname: "callback.fleet.example",
    domain: "fleet.example",
    secretsPublicKey: "unused",
  },
  migrations: [{ name: "0001_m.sql", queries: ["CREATE TABLE t (v)"] }],
  io: io(),
  yes: false,
  dryRun: false,
  ...over,
});
const own = (id: string) => readClientSettings(registry, id as ClientId);
const set = (name: string, value: string, over: Partial<FleetContext> = {}) =>
  settingCommand(ctx(over), release, "set", "gym-a", name, value);

beforeEach(async () => {
  registry = nodeD1();
  await applyMigrations(registry, registryMigrations(), { table: REGISTRY_MIGRATIONS_TABLE });
  lines = [];
  await addClient(ctx(), {
    id: "gym-a",
    webHostname: "www.gym-a.example",
    settings: { COS_PACKS: "ticketing" },
  });
});

describe("cos client setting (G4)", () => {
  it("sets and unsets what may change on a running client, each value checked", async () => {
    expect(await set("API_ALLOWED_ORIGINS", "https://www.gym-a.example")).toBe(0);
    expect((await own("gym-a")).API_ALLOWED_ORIGINS).toBe("https://www.gym-a.example");
    expect(lines.join("\n")).toMatch(/within 10 seconds/);
    for (const [name, value] of [
      ["API_ALLOWED_ORIGINS", "http://www.gym-a.example"],
      ["API_ALLOWED_ORIGINS", "https://www.gym-a.example/path"],
      ["APPROVAL_EXPIRY_DAYS", "0"],
      ["COS_PRODUCT_LABEL", "Line\nbreak"],
      ["COS_PRODUCT_LABEL", "<b>Gym</b>"],
    ] as const) {
      await expect(set(name, value), `${name}=${value}`).rejects.toThrow(new RegExp(name));
    }
    await set("COS_PRODUCT_LABEL", "Gym A Studio");
    // Replacing or removing a value asks first; --yes answers.
    await expect(set("COS_PRODUCT_LABEL", "Gym A")).rejects.toThrow(/pass --yes/);
    await expect(
      settingCommand(ctx(), release, "unset", "gym-a", "COS_PRODUCT_LABEL", undefined),
    ).rejects.toThrow(/pass --yes/);
    await settingCommand(
      ctx({ yes: true }),
      release,
      "unset",
      "gym-a",
      "COS_PRODUCT_LABEL",
      undefined,
    );
    expect(await own("gym-a")).toEqual({
      API_ALLOWED_ORIGINS: "https://www.gym-a.example",
      COS_PACKS: "ticketing",
    });
    // What the host reads is what was written.
    expect((await readRegistry(registry)).settings.get("gym-a" as ClientId)).toMatchObject({
      API_ALLOWED_ORIGINS: "https://www.gym-a.example",
    });
  });

  it("refuses an allowed origin under the fleet's domain that is not the client's own hostname (S4)", async () => {
    await addClient(ctx(), { id: "gym-b" });
    for (const origin of [
      "https://gym-b-admin.fleet.example",
      "https://fleet.example",
      "https://evil.clients.fleet.example",
    ]) {
      await expect(set("API_ALLOWED_ORIGINS", origin), origin).rejects.toThrow(
        /under the fleet's domain and is not this client's hostname/,
      );
    }
    // The client's own staff hostname, and its own domain, are fine.
    expect(
      await set(
        "API_ALLOWED_ORIGINS",
        "https://gym-a-admin.fleet.example,https://www.gym-a.example",
      ),
    ).toBe(0);
  });

  it("takes a native redirect only as the client's app's, cos's loopback or https on its own hostname (S5)", async () => {
    for (const value of [
      "javascript:alert(1)",
      "http://evil.example/cb",
      "https://evil.example/cb",
      "https://gym-b-admin.fleet.example/cb",
      "gyma://elsewhere",
      "gyma://staff-sign-in/extra",
      "http://127.0.0.1/somewhere",
      "https://staff-sign-in",
    ]) {
      await expect(set("NATIVE_REDIRECT_URIS", value), value).rejects.toThrow(
        /NATIVE_REDIRECT_URIS/,
      );
    }
    const good =
      "gymapp://staff-sign-in,http://127.0.0.1/cos-sign-in,https://www.gym-a.example/app/sign-in";
    expect(await set("NATIVE_REDIRECT_URIS", good)).toBe(0);
    expect((await own("gym-a")).NATIVE_REDIRECT_URIS).toBe(good);
  });

  it("refuses every other setting, saying why, and changes nothing on a dry run", async () => {
    for (const [name, why] of [
      ["APPROVAL_FLOOR", /policy/],
      ["AUTH_ALLOW_SIGNUP", /never on a fleet/],
      ["IDENTITY_PROVIDER", /who every staff account is/],
      ["COS_FIRST_ADMIN", /first-admin/],
      ["COS_ORG_EXTENSIONS", /deploy/],
      ["AI_PROVIDERS", /first install/],
      ["NOT_A_SETTING", /not a client setting/],
    ] as const) {
      await expect(set(name, "x"), name).rejects.toThrow(why);
    }
    await set("COS_PRODUCT_LABEL", "G", { dryRun: true });
    expect(await own("gym-a")).toEqual({ COS_PACKS: "ticketing" });
    expect(lines.join("\n")).toMatch(/Nothing was changed \(--dry-run\)/);
    await expect(
      settingCommand(ctx(), release, "set", "gym-b", "COS_PRODUCT_LABEL", "G"),
    ).rejects.toThrow(/No client gym-b/);
  });

  it("checks an allowed origin at add's own write, failing closed without the fleet's domain (S-R1)", async () => {
    const client = (origin: string) => ({
      id: "gym-c",
      environment: "live" as const,
      tier: "standard" as const,
      hostnames: [{ hostname: "gym-c-admin.fleet.example", surface: "staff" as const }],
      settings: { API_ALLOWED_ORIGINS: origin },
    });
    await expect(addClientRows(registry, client("https://www.gym-c.example"))).rejects.toThrow(
      /the fleet's domain is needed/,
    );
    await expect(
      addClientRows(registry, client("https://gym-a-admin.fleet.example"), {
        fleetDomain: "fleet.example",
      }),
    ).rejects.toThrow(/under the fleet's domain/);
    await addClientRows(registry, client("https://gym-c-admin.fleet.example"), {
      fleetDomain: "fleet.example",
    });
    expect((await own("gym-c")).API_ALLOWED_ORIGINS).toBe("https://gym-c-admin.fleet.example");
  });

  it("holds the same list where the write is: the registry's own write refuses them too (S3)", async () => {
    for (const [name, value] of [
      ["AUTH_ALLOW_SIGNUP", "true"],
      ["COS_FIRST_ADMIN", "{}"],
      ["API_ALLOWED_ORIGINS", "https://gym-b-admin.fleet.example"],
    ] as const) {
      await expect(
        setClientSetting(registry, "gym-a" as ClientId, name, value, {
          fleetDomain: "fleet.example",
        }),
        name,
      ).rejects.toThrow(new RegExp(name));
    }
  });

  it("lists the client's own settings: the first admin as set, with its expiry, the address only when asked", async () => {
    await firstAdminCommand(ctx(), "gym-a", "owner@gym-a.example", {
      source: { sha256: "a".repeat(64) },
    });
    lines = [];
    await settingCommand(ctx(), release, "list", "gym-a", undefined, undefined);
    const text = lines.join("\n");
    expect(text).toContain("COS_PACKS=ticketing");
    expect(text).toMatch(/COS_FIRST_ADMIN=set, its setup link until \S+/);
    expect(text).not.toContain("owner@gym-a.example");
    expect(text).not.toContain("a".repeat(64));
    lines = [];
    await settingCommand(ctx(), release, "list", "gym-a", undefined, undefined, {
      showEmail: true,
    });
    expect(lines.join("\n")).toContain("COS_FIRST_ADMIN=set for owner@gym-a.example");
  });
});

describe("COS_PACKS (G4)", () => {
  it("only widens, with packs the installed release carries and what they require", async () => {
    await expect(set("COS_PACKS", "ticketing,bookings")).rejects.toThrow(/does not carry bookings/);
    await expect(set("COS_PACKS", "ticketing,courses")).rejects.toThrow(
      /programs, content must be named too/,
    );
    await expect(set("COS_PACKS", "content")).rejects.toThrow(
      /only widen: ticketing would be taken out/,
    );
    await expect(set("COS_PACKS", "ticketing,Content")).rejects.toThrow(/pack ids/);
    // Always an explicit list: never "*", the release product's packs.
    await expect(set("COS_PACKS", "*")).rejects.toThrow(/never \*/);
    expect(addSettingsProblems({ COS_PACKS: "*" }, release)[0]).toMatch(/never \*/);
    // Empty is none: narrower than ticketing, so refused here.
    await expect(set("COS_PACKS", "")).rejects.toThrow(/only widen/);
    await expect(
      settingCommand(ctx({ yes: true }), release, "unset", "gym-a", "COS_PACKS", undefined),
    ).rejects.toThrow(/never unset: a client's packs are always an explicit list/);
    // Wider: replacing asks, then it is written; the host installs the new pack itself.
    expect(await set("COS_PACKS", "ticketing,content,programs,courses", { yes: true })).toBe(0);
    expect((await own("gym-a")).COS_PACKS).toBe("ticketing,content,programs,courses");
    expect(lines.join("\n")).toMatch(/installs each newly listed pack/);
  });

  it("asks first for a client that had the deployment's packs", async () => {
    await addClient(ctx(), { id: "gym-b" });
    await expect(
      settingCommand(ctx(), release, "set", "gym-b", "COS_PACKS", "ticketing"),
    ).rejects.toThrow(/pass --yes/);
    expect(
      await settingCommand(ctx({ yes: true }), release, "set", "gym-b", "COS_PACKS", "ticketing"),
    ).toBe(0);
  });

  it("are checked at add as the setting command checks them, every other name refused (S2)", async () => {
    expect(addSettingsProblems({ COS_PACKS: "ticketing,courses" }, release)).toEqual([
      "COS_PACKS: programs, content must be named too: a pack listed requires them",
    ]);
    expect(addSettingsProblems({ COS_FIRST_ADMIN: "{}" }, release)[0]).toMatch(/--admin/);
    expect(addSettingsProblems({ COS_PRODUCT_LABEL: " Gym" }, release)[0]).toMatch(/space/);
    for (const [name, value, why] of [
      ["AUTH_ALLOW_SIGNUP", "true", /never on a fleet/],
      ["IDENTITY_PROVIDER", "cloudflare-access", /who every staff account is/],
      ["AI_MODEL_ROLES", "{}", /first install/],
      ["APPROVAL_FLOOR", '{"*":{}}', /policy/],
    ] as const) {
      expect(addSettingsProblems({ [name]: value }, release)[0], name).toMatch(why);
      // The registry's write refuses them as well, whatever calls it.
      await expect(
        addClient(ctx(), { id: "gym-c", settings: { [name]: value } }),
        name,
      ).rejects.toThrow(new RegExp(name));
    }
    expect(() => labelSetting("")).toThrow(/--label/);
    expect(labelSetting("Gym A Studio")).toEqual({ COS_PRODUCT_LABEL: "Gym A Studio" });
  });
});

describe("the commands, through cos itself", () => {
  it("checks add's label, admin and settings before anything is written, and routes setting and first-admin", async () => {
    const { buildFixtureRelease } = await import("@composable-os/release/testing");
    const { runIn, startWorld } = await import("./world.ts");
    const world = await startWorld();
    try {
      await world.github.publish(
        await buildFixtureRelease({ version: "1.0.0", fleet: true, clientGatekeepers: true }),
      );
      const keysPath = join(mkdtempSync(join(tmpdir(), "s66s9-")), "staging.json");
      expect(
        (await runIn(world, "fleet", "keys", "--env", "staging", "--out", keysPath)).code,
      ).toBe(0);
      const install = await runIn(
        world,
        "fleet",
        "install",
        "--env",
        "staging",
        "--keys-file",
        keysPath,
        "--callback-hostname",
        "callback.staging.example",
        "--domain",
        "staging.example",
        "--ai",
        "off",
      );
      expect(install.code, install.output).toBe(0);
      const client = (...args: string[]) => runIn(world, "client", ...args, "--env", "staging");
      const hash = "b".repeat(64);
      for (const [args, said] of [
        [["add", "gym-a", "--label", " Gym A"], /--label: no space/],
        [["add", "gym-a", "--admin", "not an address"], /--admin/],
        [["add", "gym-a", "--setting", "COS_PACKS=nope"], /does not carry nope/],
        [["add", "gym-a", "--setting", "COS_FIRST_ADMIN={}"], /--admin <email>/],
        [["add", "gym-a", "--setting", "AUTH_ALLOW_SIGNUP=true"], /never on a fleet/],
        [["add", "gym-a", "--admin", "owner@gym-a.example"], /--admin-token-sha256 <sha256>/],
        [
          ["add", "gym-a", "--admin", "owner@gym-a.example", "--admin-token-sha256", "abc"],
          /not a SHA-256/,
        ],
        [["setting", "set", "gym-a", "COS_PRODUCT_LABEL", "Gym A"], /No client gym-a/],
        [["setting", "set", "gym-a", "AUTH_ALLOW_SIGNUP", "true"], /never on a fleet/],
        [["first-admin", "gym-a", "--email", "owner@gym-a.example"], /--token-sha256 <sha256>/],
        [
          ["first-admin", "gym-a", "--email", "owner@gym-a.example", "--token-sha256", hash],
          /No client gym-a/,
        ],
      ] as const) {
        const { code, output } = await client(...args);
        expect(code, args.join(" ")).toBe(1);
        expect(output, args.join(" ")).toMatch(said);
      }
      // Refused before anything: no client was written.
      expect((await client("list")).output).not.toContain("gym-a");
      // The owner's helper: offline, refused in CI.
      const offline = await runIn(
        world,
        "client",
        "first-admin-token",
        "--staff-hostname",
        "gym-a-admin.staging.example",
      );
      expect(offline.code, offline.output).toBe(0);
      expect(offline.output).toMatch(
        /https:\/\/gym-a-admin\.staging\.example\/sign-in#first-admin=[A-Za-z0-9_-]{43}/,
      );
      expect(offline.output).toMatch(/\b[0-9a-f]{64}\b/);
    } finally {
      world.server.close();
    }
  });
});

describe("cos client first-admin (G5)", () => {
  /** A token and its hash, as the owner's `first-admin-token` makes them. */
  const TOKEN = randomBytes(32).toString("base64url");
  const HASH = createHash("sha256").update(TOKEN).digest("hex");

  it("with the token's hash: stores it, and prints neither a token, a link nor the address", async () => {
    const now = new Date("2026-11-27T00:00:00.000Z");
    // A dry run prints nothing of it.
    await firstAdminCommand(ctx({ dryRun: true }), "gym-a", "owner@gym-a.example", {
      source: { sha256: HASH },
    });
    expect((await own("gym-a")).COS_FIRST_ADMIN).toBeUndefined();
    expect(
      await firstAdminCommand(ctx(), "gym-a", " Owner@Gym-A.example ", {
        source: { sha256: HASH },
        now,
      }),
    ).toBe(0);
    expect(parseFirstAdmin((await own("gym-a")).COS_FIRST_ADMIN)).toEqual({
      email: "owner@gym-a.example",
      sha256: HASH,
      expires: "2026-11-30T00:00:00.000Z",
    });
    const text = lines.join("\n");
    expect(text).toContain("its setup link works until 2026-11-30T00:00:00.000Z");
    expect(text).not.toMatch(/owner@gym-a\.example|first-admin=|sign-in/i);
    expect(text).not.toContain(HASH);
  });

  it("the owner's helper makes a token whose link and hash the host accepts, and refuses CI", () => {
    const out: string[] = [];
    const helperIo = { ...io(), out: (l: string) => out.push(l) };
    expect(firstAdminTokenCommand(helperIo, {}, "gym-a-admin.fleet.example", TOKEN)).toBe(0);
    expect(out.join("\n")).toContain(
      `https://gym-a-admin.fleet.example/sign-in#first-admin=${TOKEN}`,
    );
    expect(out.join("\n")).toContain(HASH);
    for (const env of [{ CI: "true" }, { GITHUB_ACTIONS: "true" }]) {
      expect(() => firstAdminTokenCommand(helperIo, env, "gym-a-admin.fleet.example")).toThrow(
        /never in CI/,
      );
    }
    expect(() => firstAdminTokenCommand(helperIo, {}, "not a host")).toThrow(/--staff-hostname/);
  });

  it("makes and prints a link only with --print-link, and never in CI", async () => {
    const token = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG";
    await firstAdminCommand(ctx(), "gym-a", "owner@gym-a.example", {
      source: { print: true },
      token,
    });
    expect(lines.join("\n")).toContain(
      `https://gym-a-admin.fleet.example/sign-in#first-admin=${token}`,
    );
    expect(parseFirstAdmin((await own("gym-a")).COS_FIRST_ADMIN)?.sha256).toBe(
      createHash("sha256").update(token).digest("hex"),
    );
    for (const env of [{ CI: "true" }, { GITHUB_ACTIONS: "true" }]) {
      expect(() => setupTokenSource(undefined, true, env, "--token-sha256")).toThrow(
        /refused in CI/,
      );
    }
    expect(() => setupTokenSource(undefined, false, {}, "--token-sha256")).toThrow(
      /--token-sha256 <sha256>/,
    );
    expect(() => setupTokenSource(HASH, true, {}, "--token-sha256")).toThrow(/not both/);
    for (const bad of ["abc", HASH.toUpperCase(), `${HASH}0`, TOKEN]) {
      expect(() => setupTokenSource(bad, false, {}, "--token-sha256"), bad).toThrow(
        /not a SHA-256/,
      );
    }
    expect(setupTokenSource(HASH, false, { CI: "true" }, "--token-sha256")).toEqual({
      sha256: HASH,
    });
  });

  it("refuses an address that is not one and a client that does not exist", async () => {
    const source = { sha256: HASH };
    await expect(firstAdminCommand(ctx(), "gym-a", "not an address", { source })).rejects.toThrow(
      /--email/,
    );
    await expect(
      firstAdminCommand(ctx(), "gym-z", "owner@gym-z.example", { source }),
    ).rejects.toThrow(/No client gym-z/);
  });

  it("never lets the setting command write it", () => {
    expect(operatorSettingProblem("COS_FIRST_ADMIN", "{}")).toMatch(/cos client first-admin/);
  });
});
