// Stage 64 step 1 (ADRs 0910 and 0916): locations, a base record. Every host has one open main
// location from migration 1390, which runs again without change; a person adds, changes, closes and
// reopens locations, an AI only asks; the last open location cannot be closed; the main location
// follows the organisation's zone; the public reads a public open location's name, short name,
// address and zone, and nothing of a hidden or closed one. Against real D1.
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  type ActingUser,
  coreRegistry,
  createInvoker,
  createRegistry,
  defineOperation,
  invoke,
  MAIN_LOCATION_FALLBACK,
  MAIN_LOCATION_ID,
  PendingApprovalError,
} from "../src/index.ts";
import { outside, PUBLIC } from "./customer-fixtures.ts";
import { auditChanges, context, createUser, unique } from "./helpers.ts";

let admin: ActingUser;
let member: ActingUser;

const MIGRATION = () => {
  const found = env.TEST_MIGRATIONS.find((m) => m.name.startsWith("1390_"));
  if (!found) throw new Error("migration 1390 is missing");
  return found;
};

async function rerunMigration() {
  await env.DB.batch(MIGRATION().queries.map((query) => env.DB.prepare(query)));
}

async function rows() {
  const { results } = await env.DB.prepare("SELECT * FROM core_location ORDER BY id").all();
  return results;
}

async function setSetting(key: string, value: unknown) {
  await env.DB.prepare(
    "INSERT INTO core_settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
  )
    .bind(key, JSON.stringify(value), new Date().toISOString())
    .run();
}

async function refusal(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return error as { code: string; details?: Record<string, unknown> };
  }
  throw new Error("expected a refusal");
}

type LocationOut = { id: string; name: string; state: string; timezone: string; main: boolean };
const list = async (as = admin) =>
  ((await invoke("location.list", {}, context(as))) as { items: LocationOut[] }).items;
const create = (input: { name: string } & Record<string, unknown>, as = admin) =>
  invoke("location.create", input, context(as)) as Promise<LocationOut>;

// A pack's tool the public calls, as Bookings' timetable will: it reads locations through the
// seam's public scope, which decides which records and which fields.
const peekList = defineOperation({
  name: "fixture.locations",
  description: "Fixture: the locations a public caller may read.",
  input: z.object({}),
  output: z.object({
    items: z.array(
      z.object({ object: z.string(), id: z.string(), values: z.record(z.string(), z.unknown()) }),
    ),
    nextCursor: z.string().nullable(),
  }),
  permission: "records:read",
  risk: "read",
  audiences: ["public", "customer"],
  handler: async (_input, ctx) => ctx.records.list("location", {}),
});
const peekGet = defineOperation({
  name: "fixture.location",
  description: "Fixture: one location a public caller may read.",
  input: z.object({ id: z.string() }),
  output: z.object({
    object: z.string(),
    id: z.string(),
    values: z.record(z.string(), z.unknown()),
  }),
  permission: "records:read",
  risk: "read",
  audiences: ["public", "customer"],
  handler: async (input, ctx) => ctx.records.get("location", input.id),
});
const outsiders = createInvoker(createRegistry([...coreRegistry.list(), peekList, peekGet]));

beforeAll(async () => {
  admin = await createUser("admin");
  member = await createUser("member");
});

describe("the main location (migration 1390)", () => {
  it("every host has exactly one open main location in the organisation's zone", async () => {
    const all = await list();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ id: MAIN_LOCATION_ID, main: true, state: "open" });
    const settings = (await invoke("settings.get", {}, context(admin))) as {
      orgName: string | null;
      timezone: string;
    };
    expect(all[0]?.timezone).toBe(settings.timezone);
    expect(all[0]?.name).toBe(settings.orgName ?? MAIN_LOCATION_FALLBACK);
  });

  it("runs again without change", async () => {
    const before = await rows();
    await rerunMigration();
    await rerunMigration();
    expect(await rows()).toEqual(before);
  });

  it("is named after the organisation, in its zone, when the host already has them", async () => {
    const before = await rows();
    await env.DB.prepare("DELETE FROM core_location").run();
    await setSetting("org_name", "Harbour Fitness");
    await setSetting("org_timezone", "Australia/Sydney");
    await rerunMigration();
    expect(await rows()).toMatchObject([
      { id: MAIN_LOCATION_ID, name: "Harbour Fitness", timezone: "Australia/Sydney", main: 1 },
    ]);
    // Put the host back as the migration first left it.
    await env.DB.prepare("DELETE FROM core_location").run();
    await env.DB.prepare(
      "DELETE FROM core_settings WHERE key IN ('org_name', 'org_timezone')",
    ).run();
    for (const row of before) {
      const keys = Object.keys(row);
      await env.DB.prepare(
        `INSERT INTO core_location (${keys.join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`,
      )
        .bind(...keys.map((k) => row[k]))
        .run();
    }
  });

  it("is named the fallback on a host with no name yet, or a blank one", async () => {
    const before = await rows();
    await env.DB.prepare("DELETE FROM core_location").run();
    await setSetting("org_name", "  ");
    await rerunMigration();
    expect(await rows()).toMatchObject([{ name: MAIN_LOCATION_FALLBACK, main: 1 }]);
    await env.DB.prepare("DELETE FROM core_location").run();
    await env.DB.prepare("DELETE FROM core_settings WHERE key = 'org_name'").run();
    for (const row of before) {
      const keys = Object.keys(row);
      await env.DB.prepare(
        `INSERT INTO core_location (${keys.join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`,
      )
        .bind(...keys.map((k) => row[k]))
        .run();
    }
  });

  it("follows the organisation's zone, and its name while it has the one it was given", async () => {
    await invoke("settings.update", { timezone: "Europe/London" }, context(admin));
    let main = (await list()).find((l) => l.main);
    expect(main?.timezone).toBe("Europe/London");
    await invoke("settings.update", { orgName: "Northside Gym" }, context(admin));
    main = (await list()).find((l) => l.main);
    expect(main?.name).toBe("Northside Gym");
    // Renamed apart, it keeps its own name.
    await invoke("location.update", { id: MAIN_LOCATION_ID, name: "Old Mill" }, context(admin));
    await invoke("settings.update", { orgName: "Northside Fitness" }, context(admin));
    main = (await list()).find((l) => l.main);
    expect(main?.name).toBe("Old Mill");
    // Its zone is the organisation's, changed only in Settings → General.
    const refused = await refusal(
      invoke("location.update", { id: MAIN_LOCATION_ID, timezone: "Asia/Tokyo" }, context(admin)),
    );
    expect(refused.details).toMatchObject({ rule: "main_location_zone" });
    expect((await auditChanges(MAIN_LOCATION_ID)).map((c) => c.object_type)).toContain("location");
  });

  it("is the main location for good", async () => {
    await expect(
      env.DB.prepare("UPDATE core_location SET main = 0 WHERE main = 1").run(),
    ).rejects.toThrow(/core_location_main_kept/);
  });
});

describe("location.create, location.update", () => {
  it("adds an open location in the organisation's zone by default, audited", async () => {
    const settings = (await invoke("settings.get", {}, context(admin))) as { timezone: string };
    const city = await create({ name: unique("City "), shortName: "City", address: "1 Quay St" });
    expect(city).toMatchObject({
      state: "open",
      main: false,
      public: true,
      timezone: settings.timezone,
      shortName: "City",
      dropInPrice: null,
    });
    const changes = await auditChanges(city.id);
    expect(changes).toMatchObject([{ action: "create", object_type: "location" }]);
    // The main location first.
    expect((await list())[0]?.main).toBe(true);
  });

  it("refuses a second location with one name, whatever the case", async () => {
    const name = unique("Dockside ");
    await create({ name, timezone: "Pacific/Auckland" });
    const refused = await refusal(create({ name: name.toUpperCase() }));
    expect(refused).toMatchObject({ code: "conflict", details: { rule: "location_name" } });
    // The index refuses it too, for a path that does not check first.
    await expect(
      env.DB.prepare(
        "INSERT INTO core_location (id, name, timezone, created_at, updated_at) VALUES ('loc_x', ?, 'UTC', 'now', 'now')",
      )
        .bind(name.toLowerCase())
        .run(),
    ).rejects.toThrow(/UNIQUE constraint failed: core_location.name/);
  });

  it("refuses an unknown zone and a staff member without settings:manage", async () => {
    expect((await refusal(create({ name: unique("Z "), timezone: "Mars/Olympus" }))).code).toBe(
      "invalid_input",
    );
    expect((await refusal(create({ name: unique("M ") }, member))).code).toBe("forbidden");
  });

  it("changes a location's fields, and clears an optional one with null", async () => {
    const loc = await create({ name: unique("East "), shortName: "East", dropInPrice: 2500 });
    const changed = (await invoke(
      "location.update",
      { id: loc.id, shortName: null, dropInPrice: 3000, public: false, timezone: "Asia/Tokyo" },
      context(admin),
    )) as Record<string, unknown>;
    expect(changed).toMatchObject({
      shortName: null,
      dropInPrice: 3000,
      public: false,
      timezone: "Asia/Tokyo",
    });
    expect(await invoke("location.get", { id: loc.id }, context(member))).toEqual(changed);
  });

  it("an AI's new location or change waits for a person", async () => {
    const asMcp = context(admin, {
      actor: "mcp",
      origin: { surface: "mcp", clientId: "client-1", clientName: "Test client" },
    });
    const name = unique("Asked ");
    const queued = await invoke("location.create", { name }, asMcp).catch((e: unknown) => e);
    expect(queued).toBeInstanceOf(PendingApprovalError);
    expect((await list()).some((l) => l.name === name)).toBe(false);
    await invoke(
      "approval.approve",
      { actionIds: [(queued as PendingApprovalError).pending.actionId] },
      context(admin),
    );
    expect((await list()).some((l) => l.name === name)).toBe(true);
  });
});

describe("location.close, location.reopen", () => {
  it("never closes the last open location, and closes and reopens another", async () => {
    // Close every location but the main one, then the main one is the last open.
    for (const l of await list()) {
      if (!l.main && l.state === "open") {
        await invoke("location.close", { id: l.id }, context(admin));
      }
    }
    const refused = await refusal(
      invoke("location.close", { id: MAIN_LOCATION_ID }, context(admin)),
    );
    expect(refused).toMatchObject({ code: "conflict", details: { rule: "last_open_location" } });
    // The database refuses it for a path that does not check first.
    await expect(
      env.DB.prepare("UPDATE core_location SET state = 'closed' WHERE main = 1").run(),
    ).rejects.toThrow(/core_location_last_open/);

    const other = await create({ name: unique("West ") });
    const closedMain = (await invoke(
      "location.close",
      { id: MAIN_LOCATION_ID },
      context(admin),
    )) as LocationOut;
    expect(closedMain.state).toBe("closed");
    expect((await refusal(invoke("location.close", { id: other.id }, context(admin)))).code).toBe(
      "conflict",
    );
    await invoke("location.reopen", { id: MAIN_LOCATION_ID }, context(admin));
    expect((await list()).find((l) => l.main)?.state).toBe("open");
  });

  it("is a person's only: refused for an AI, and for staff without settings:manage", async () => {
    const loc = await create({ name: unique("North ") });
    const asMcp = context(admin, {
      actor: "mcp",
      origin: { surface: "mcp", clientId: "client-1", clientName: "Test client" },
    });
    const asAssistant = context(admin, { actor: "assistant", origin: { surface: "assistant" } });
    for (const ctx of [asMcp, asAssistant]) {
      expect((await refusal(invoke("location.close", { id: loc.id }, ctx))).code).toBe("forbidden");
    }
    expect((await refusal(invoke("location.close", { id: loc.id }, context(member)))).code).toBe(
      "forbidden",
    );
    expect(
      (await invoke("location.get", { id: loc.id }, context(admin))) as LocationOut,
    ).toMatchObject({ state: "open" });
  });
});

describe("what the public reads of a location (ADR 0916)", () => {
  it("a public open location's name, short name, address and zone; nothing of the others", async () => {
    const shown = await create({
      name: unique("Shown "),
      shortName: "Shown",
      address: "2 Hill Rd",
      timezone: "Europe/Paris",
      dropInPrice: 1800,
      notes: "Alarm code is with the manager",
    });
    const hidden = await create({ name: unique("Hidden "), public: false });
    const closed = await create({ name: unique("Closed ") });
    await invoke("location.close", { id: closed.id }, context(admin));

    const page = (await outsiders.invokeByName("fixture.locations", {}, outside(PUBLIC))) as {
      items: { id: string; values: Record<string, unknown> }[];
    };
    const ids = page.items.map((item) => item.id);
    expect(ids).toContain(shown.id);
    expect(ids).not.toContain(hidden.id);
    expect(ids).not.toContain(closed.id);
    expect(page.items.find((item) => item.id === shown.id)?.values).toEqual({
      name: shown.name,
      shortName: "Shown",
      address: "2 Hill Rd",
      timezone: "Europe/Paris",
    });
    for (const id of [hidden.id, closed.id]) {
      const refused = await refusal(
        outsiders.invokeByName("fixture.location", { id }, outside(PUBLIC)),
      );
      expect(refused.code).toBe("not_found");
    }
    expect(
      (
        (await outsiders.invokeByName("fixture.location", { id: shown.id }, outside(PUBLIC))) as {
          values: Record<string, unknown>;
        }
      ).values,
    ).not.toHaveProperty("dropInPrice");
  });

  it("the location operations themselves are staff only", async () => {
    for (const name of ["location.list", "location.get", "location.create"]) {
      const op = coreRegistry.get(name);
      expect(op?.audiences ?? ["staff"]).toEqual(["staff"]);
    }
  });
});
