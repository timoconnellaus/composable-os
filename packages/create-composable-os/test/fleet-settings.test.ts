// A running client's settings and its first admin (stage 66 step 9, ADR 0618 "The first client's
// day one"): `cos client setting list|set|unset`, `cos client first-admin` and `cos client add
// --admin --label`, against the registry's real migrations on Node's SQLite.
import { createHash } from "node:crypto";
import { applyMigrations, type MigrationLevel } from "@composable-os/db";
import {
  type ClientId,
  operatorSettingProblem,
  parseFirstAdmin,
  REGISTRY_MIGRATIONS_TABLE,
  readRegistry,
} from "@composable-os/db/registry";
import { readClientSettings } from "@composable-os/db/registry-writes";
import { beforeEach, describe, expect, it } from "vitest";
import { addClient, type FleetContext } from "../src/fleet/clients.ts";
import { nodeD1 } from "../src/fleet/node-d1.ts";
import type { Operator } from "../src/fleet/operator-client.ts";
import { registryMigrations } from "../src/fleet/run.ts";
import {
  addSettingsProblems,
  firstAdminCommand,
  labelSetting,
  type ReleasePacks,
  settingCommand,
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

beforeEach(async () => {
  registry = nodeD1();
  await applyMigrations(registry, registryMigrations(), { table: REGISTRY_MIGRATIONS_TABLE });
  lines = [];
  await addClient(ctx(), { id: "gym-a", settings: { COS_PACKS: "ticketing" } });
});

describe("cos client setting (G4)", () => {
  it("sets and unsets what may change on a running client, each value checked", async () => {
    expect(
      await settingCommand(
        ctx(),
        release,
        "set",
        "gym-a",
        "API_ALLOWED_ORIGINS",
        "https://www.gym-a.example",
      ),
    ).toBe(0);
    expect((await own("gym-a")).API_ALLOWED_ORIGINS).toBe("https://www.gym-a.example");
    expect(lines.join("\n")).toMatch(/within 10 seconds/);
    for (const [name, value] of [
      ["API_ALLOWED_ORIGINS", "http://www.gym-a.example"],
      ["API_ALLOWED_ORIGINS", "https://www.gym-a.example/path"],
      ["NATIVE_REDIRECT_URIS", "javascript:alert(1)"],
      ["NATIVE_REDIRECT_URIS", "http://evil.example/cb"],
      ["APPROVAL_EXPIRY_DAYS", "0"],
      ["COS_PRODUCT_LABEL", "Line\nbreak"],
      ["COS_PRODUCT_LABEL", "<b>Gym</b>"],
    ] as const) {
      await expect(
        settingCommand(ctx(), release, "set", "gym-a", name, value),
        `${name}=${value}`,
      ).rejects.toThrow(new RegExp(name));
    }
    await settingCommand(
      ctx(),
      release,
      "set",
      "gym-a",
      "NATIVE_REDIRECT_URIS",
      "gyma://staff-sign-in,http://127.0.0.1/cos-sign-in",
    );
    await settingCommand(ctx(), release, "set", "gym-a", "COS_PRODUCT_LABEL", "Gym A Studio");
    // Replacing or removing a value asks first; --yes answers.
    await expect(
      settingCommand(ctx(), release, "set", "gym-a", "COS_PRODUCT_LABEL", "Gym A"),
    ).rejects.toThrow(/pass --yes/);
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
      NATIVE_REDIRECT_URIS: "gyma://staff-sign-in,http://127.0.0.1/cos-sign-in",
    });
    // What the host reads is what was written.
    expect((await readRegistry(registry)).settings.get("gym-a" as ClientId)).toMatchObject({
      API_ALLOWED_ORIGINS: "https://www.gym-a.example",
    });
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
      await expect(settingCommand(ctx(), release, "set", "gym-a", name, "x"), name).rejects.toThrow(
        why,
      );
    }
    await settingCommand(ctx({ dryRun: true }), release, "set", "gym-a", "COS_PRODUCT_LABEL", "G");
    expect(await own("gym-a")).toEqual({ COS_PACKS: "ticketing" });
    expect(lines.join("\n")).toMatch(/Nothing was changed \(--dry-run\)/);
    await expect(
      settingCommand(ctx(), release, "set", "gym-b", "COS_PRODUCT_LABEL", "G"),
    ).rejects.toThrow(/No client gym-b/);
  });

  it("lists the client's own settings, never the first admin's hash", async () => {
    await firstAdminCommand(ctx(), "gym-a", "owner@gym-a.example", { token: "t".repeat(43) });
    lines = [];
    await settingCommand(ctx(), release, "list", "gym-a", undefined, undefined);
    const text = lines.join("\n");
    expect(text).toContain("COS_PACKS=ticketing");
    expect(text).toContain("COS_FIRST_ADMIN=owner@gym-a.example, its setup link until");
    expect(text).not.toContain(createHash("sha256").update("t".repeat(43)).digest("hex"));
  });
});

describe("COS_PACKS (G4)", () => {
  it("only widens, with packs the installed release carries and what they require", async () => {
    const set = (value: string, over: Partial<FleetContext> = {}) =>
      settingCommand(ctx(over), release, "set", "gym-a", "COS_PACKS", value);
    await expect(set("ticketing,bookings")).rejects.toThrow(/does not carry bookings/);
    await expect(set("ticketing,courses")).rejects.toThrow(/programs, content must be named too/);
    await expect(set("content")).rejects.toThrow(/only widen: ticketing would be taken out/);
    await expect(set("ticketing,Content")).rejects.toThrow(/pack ids/);
    await expect(
      settingCommand(ctx({ yes: true }), release, "unset", "gym-a", "COS_PACKS", undefined),
    ).rejects.toThrow(/never unset/);
    // Wider: replacing asks, then it is written; the host installs the new pack itself.
    expect(await set("ticketing,content,programs,courses", { yes: true })).toBe(0);
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

  it("are checked at add as the setting command checks them", () => {
    expect(addSettingsProblems({ COS_PACKS: "ticketing,courses" }, release)).toEqual([
      "COS_PACKS: programs, content must be named too: a pack listed requires them",
    ]);
    expect(addSettingsProblems({ COS_FIRST_ADMIN: "{}" }, release)[0]).toMatch(/--admin/);
    expect(addSettingsProblems({ COS_PRODUCT_LABEL: " Gym" }, release)[0]).toMatch(/space/);
    // A policy setting at add is the operator's, as before.
    expect(addSettingsProblems({ APPROVAL_FLOOR: '{"*":{}}' }, release)).toEqual([]);
    expect(() => labelSetting("")).toThrow(/--label/);
    expect(labelSetting("Gym A Studio")).toEqual({ COS_PRODUCT_LABEL: "Gym A Studio" });
  });
});

describe("the commands, through cos itself", () => {
  it("checks add's label, admin and settings before anything is written, and routes setting and first-admin", async () => {
    const { buildFixtureRelease } = await import("@composable-os/release/testing");
    const { runIn, startWorld } = await import("./world.ts");
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const world = await startWorld();
    try {
      await world.github.publish(
        await buildFixtureRelease({ version: "1.0.0", fleet: true, clientGatekeepers: true }),
      );
      const keysPath = join(mkdtempSync(join(tmpdir(), "s66s9-")), "staging.json");
      expect((await runIn(world, "fleet", "keys", "--env", "staging", "--out", keysPath)).code).toBe(
        0,
      );
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
      for (const [args, said] of [
        [["add", "gym-a", "--label", " Gym A"], /--label: no space/],
        [["add", "gym-a", "--admin", "not an address"], /--admin/],
        [["add", "gym-a", "--setting", "COS_PACKS=nope"], /does not carry nope/],
        [["add", "gym-a", "--setting", "COS_FIRST_ADMIN={}"], /--admin <email>/],
        [["setting", "set", "gym-a", "COS_PRODUCT_LABEL", "Gym A"], /No client gym-a/],
        [["setting", "set", "gym-a", "AUTH_ALLOW_SIGNUP", "true"], /never on a fleet/],
        [["first-admin", "gym-a", "owner@gym-a.example"], /No client gym-a/],
      ] as const) {
        const { code, output } = await client(...args);
        expect(code, args.join(" ")).toBe(1);
        expect(output, args.join(" ")).toMatch(said);
      }
      // Refused before anything: no client was written.
      expect((await client("list")).output).not.toContain("gym-a");
    } finally {
      world.server.close();
    }
  });
});

describe("cos client first-admin (G5)", () => {
  it("names the address, keeps only the token's hash, and prints the setup link once", async () => {
    const token = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG";
    const now = new Date("2026-11-27T00:00:00.000Z");
    expect(await firstAdminCommand(ctx(), "gym-a", " Owner@Gym-A.example ", { token, now })).toBe(
      0,
    );
    const stored = parseFirstAdmin((await own("gym-a")).COS_FIRST_ADMIN);
    expect(stored).toEqual({
      email: "owner@gym-a.example",
      sha256: createHash("sha256").update(token).digest("hex"),
      expires: "2026-11-30T00:00:00.000Z",
    });
    expect(JSON.stringify(await own("gym-a"))).not.toContain(token);
    expect(lines.join("\n")).toContain(
      `https://gym-a-admin.fleet.example/sign-in#first-admin=${token}`,
    );
    // A new link replaces the last.
    await firstAdminCommand(ctx(), "gym-a", "owner@gym-a.example", { token: "x".repeat(43), now });
    expect(parseFirstAdmin((await own("gym-a")).COS_FIRST_ADMIN)?.sha256).toBe(
      createHash("sha256").update("x".repeat(43)).digest("hex"),
    );
  });

  it("refuses an address that is not one, a client that does not exist, and writes nothing on a dry run", async () => {
    await expect(firstAdminCommand(ctx(), "gym-a", "not an address")).rejects.toThrow(/--admin/);
    await expect(firstAdminCommand(ctx(), "gym-z", "owner@gym-z.example")).rejects.toThrow(
      /No client gym-z/,
    );
    await firstAdminCommand(ctx({ dryRun: true }), "gym-a", "owner@gym-a.example");
    expect((await own("gym-a")).COS_FIRST_ADMIN).toBeUndefined();
  });

  it("never lets the setting command write it", () => {
    expect(operatorSettingProblem("COS_FIRST_ADMIN", "{}")).toMatch(/cos client first-admin/);
  });
});
