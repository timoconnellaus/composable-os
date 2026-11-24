// Stage 47 (ADR 0660): `screens.mine`, the screens of the installed shipped packs the caller may
// open in the admin, from the real packs' declarations. A screen is listed when its pack is
// installed, active and shipped and the caller passes the pipeline's own check for every tool it
// names (`staffAuthority`); for anyone but a person it is empty, and a customer is told no such
// operation exists. Pack roles reach this one core read and nothing more (a registry walk). It
// reads two statements whatever is installed.
import { env } from "cloudflare:workers";
import { createCrmDb } from "@composable-os/db";
import { screenGateFingerprint, toManifest } from "@composable-os/sdk";
import { beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  type ActingUser,
  type AnyOperation,
  checkManifest,
  coreRegistry,
  defineOperation,
  type HeldPackRole,
  invoke,
  invokeByName,
  loadPackRole,
  PACK_ROLE_READS,
  packRoleReaches,
  personMayCall,
  setBuiltScreens,
} from "../src/index.ts";
import { screensMine } from "../src/operations/screens.ts";
import { context, createUser, db } from "./helpers.ts";
import { releasePackExtensions, releasePackTools } from "./release-packs.ts";

const NOW = new Date().toISOString();
const manifests = releasePackExtensions.map((e) => toManifest(e));
const manifestOf = (id: string) => {
  const m = manifests.find((x) => x.id === id);
  if (!m) throw new Error(`no pack ${id}`);
  return m;
};

async function install(id: string, status = "active", source: "shipped" | "runtime" = "shipped") {
  await env.DB.prepare("DELETE FROM core_extensions WHERE id = ?").bind(id).run();
  await db.query
    .insertInto("core_extensions")
    .values({
      id,
      source,
      status,
      version: manifestOf(id).version,
      commit_oid: "test",
      manifest: JSON.stringify(manifestOf(id)),
      user_id: owner.id,
      installed_at: NOW,
      updated_at: NOW,
    } as never)
    .execute();
}

async function account(
  role: "admin" | "member" | "viewer",
  packRole?: string,
  grants: string[] = [],
): Promise<ActingUser> {
  const user = await createUser(role);
  await env.DB.prepare("UPDATE core_user SET pack_role = ?, granted_permissions = ? WHERE id = ?")
    .bind(packRole ?? null, grants.length ? JSON.stringify(grants) : null, user.id)
    .run();
  return user;
}

async function mine(
  user: ActingUser,
  actor: "human" | "assistant" | "mcp" | "automation" = "human",
) {
  const out = await invoke("screens.mine", {}, context(user, { actor }));
  return out.screens.map((s) => `${s.pack}/${s.key}`).sort();
}

const BOOKINGS = ["bookings/classList", "bookings/desk"];
const TEAM = [
  "rostering/myCalendar",
  "rostering/myShifts",
  "rostering/myTimeOff",
  "rostering/offers",
  "rostering/roster",
];
const ROSTERERS = [
  "rostering/checklists",
  "rostering/patterns",
  "rostering/qualifications",
  "rostering/timeOff",
];
const MEMBER_ELSE = [
  "courses/builder",
  "memberships/holdings",
  "programs/bank",
  "programs/builder",
  "programs/client",
];

let owner: ActingUser;
/** What the admin's build holds: each repository pack's gate fingerprint (screens-plugin.ts). */
const BUILT = Object.fromEntries(
  manifests.flatMap((m) => {
    const fingerprint = screenGateFingerprint(m);
    return fingerprint ? [[m.id, fingerprint]] : [];
  }),
);

beforeAll(async () => {
  setBuiltScreens(BUILT);
  owner = await createUser("admin");
  for (const id of ["programs", "bookings", "memberships", "courses", "rostering", "ticketing"]) {
    await install(id);
  }
});

describe("screens.mine (ADR 0660)", () => {
  it("an admin sees every screen of the installed packs, with its route, nav and record", async () => {
    const admin = await createUser("admin");
    // Core's own Sign at the desk too (stage 44 step 6, ADR 0649): an admin holds agreements:desk.
    expect(await mine(admin)).toEqual(
      [...BOOKINGS, ...MEMBER_ELSE, ...TEAM, ...ROSTERERS, "rostering/pay", "core/desk"].sort(),
    );
    const { screens } = await invoke("screens.mine", {}, context(admin));
    expect(screens.find((s) => s.pack === "core")).toEqual({
      pack: "core",
      key: "desk",
      label: "Sign at the desk",
      nav: { group: "Agreements", order: 10 },
      route: "/s/core/desk",
      record: null,
    });
    expect(screens.find((s) => s.pack === "bookings" && s.key === "desk")).toEqual({
      pack: "bookings",
      key: "desk",
      label: "Front desk",
      nav: { group: "Bookings", order: 10 },
      route: "/s/bookings/desk",
      record: null,
    });
    expect(screens.find((s) => s.pack === "memberships")).toMatchObject({
      nav: null,
      record: { object: "person", as: "personId" },
    });
  });

  it("a member holds the team's and the desk's tools, never the rosterers' or pay", async () => {
    const member = await createUser("member");
    expect(await mine(member)).toEqual([...BOOKINGS, ...MEMBER_ELSE, ...TEAM].sort());
  });

  it("a viewer sees only what reads: no desk, no ticking, no pass given", async () => {
    const viewer = await createUser("viewer");
    expect(await mine(viewer)).toEqual(["rostering/roster"]);
  });

  it("a granted rosterer sees the rosterers' screens; only a pay holder sees Pay", async () => {
    const rosterer = await account("member", undefined, ["rostering:manage"]);
    expect(await mine(rosterer)).toEqual(
      [...BOOKINGS, ...MEMBER_ELSE, ...TEAM, ...ROSTERERS].sort(),
    );
    const payer = await account("member", undefined, ["rostering:pay"]);
    expect(await mine(payer)).toEqual(
      [...BOOKINGS, ...MEMBER_ELSE, ...TEAM, "rostering/pay"].sort(),
    );
  });

  it("a coach sees today's class list only; with the desk granted, the desk too", async () => {
    const coach = await account("viewer", "bookings.coach");
    expect(await mine(coach)).toEqual(["bookings/classList"]);
    const desk = await account("viewer", "bookings.coach", ["bookings:desk"]);
    expect(await mine(desk)).toEqual(BOOKINGS);
    // The grant removed: gone on the next ask.
    await env.DB.prepare("UPDATE core_user SET granted_permissions = NULL WHERE id = ?")
      .bind(desk.id)
      .run();
    expect(await mine(desk)).toEqual(["bookings/classList"]);
    // A coach granted the team's tools is rostered too.
    const rostered = await account("viewer", "bookings.coach", ["rostering:roster"]);
    expect(await mine(rostered)).toEqual(["bookings/classList", ...TEAM].sort());
    // A coach granted agreements:desk (core's one permission for a fixed-role account, ADR 0600
    // amended) gets core's Sign at the desk (stage 44 step 6).
    const signing = await account("viewer", "bookings.coach", ["agreements:desk"]);
    expect(await mine(signing)).toEqual(["bookings/classList", "core/desk"]);
  });

  it("a team account sees the team's screens; granted, the rosterers'; never pay ungranted", async () => {
    const team = await account("viewer", "rostering.team");
    expect(await mine(team)).toEqual(TEAM);
    const rosterer = await account("viewer", "rostering.team", ["rostering:manage"]);
    expect(await mine(rosterer)).toEqual([...TEAM, ...ROSTERERS].sort());
    const payer = await account("viewer", "rostering.team", ["rostering:pay"]);
    expect(await mine(payer)).toEqual([...TEAM, "rostering/pay"].sort());
  });

  it("a door account has no screen (its work is in the app)", async () => {
    const door = await account("viewer", "ticketing.door");
    expect(await mine(door)).toEqual([]);
  });

  it("an assistant, an MCP client and an automation get nothing, even for an admin", async () => {
    const admin = await createUser("admin");
    for (const actor of ["assistant", "mcp", "automation"] as const) {
      expect(await mine(admin, actor)).toEqual([]);
    }
  });

  it("does not exist for a customer or the public", async () => {
    for (const principal of [
      { kind: "customer", customerId: "cus_screens", personId: "per_screens" },
      { kind: "public" },
    ]) {
      await expect(
        invokeByName("screens.mine", {}, { principal, db } as never),
      ).rejects.toMatchObject({ code: "unknown_operation" });
    }
  });

  it("a pack disabled, not installed or not shipped contributes nothing", async () => {
    const admin = await createUser("admin");
    await install("bookings", "disabled");
    expect((await mine(admin)).filter((s) => s.startsWith("bookings/"))).toEqual([]);
    await env.DB.prepare("DELETE FROM core_extensions WHERE id = 'bookings'").run();
    expect((await mine(admin)).filter((s) => s.startsWith("bookings/"))).toEqual([]);
    // A runtime extension's screens are ignored at run time (check and install refuse them).
    await install("bookings", "active", "runtime");
    expect((await mine(admin)).filter((s) => s.startsWith("bookings/"))).toEqual([]);
    await install("bookings");
    expect((await mine(admin)).filter((s) => s.startsWith("bookings/"))).toEqual(BOOKINGS);
  });

  it("reads two statements, whatever is installed (criterion 13)", async () => {
    let statements = 0;
    const metered = new Proxy(env.DB, {
      get(target, prop) {
        if (prop === "prepare") {
          return (query: string) => {
            statements += 1;
            return target.prepare(query);
          };
        }
        const value = Reflect.get(target, prop);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const counted = createCrmDb(metered);
    const coach = await account("viewer", "bookings.coach", ["bookings:desk"]);
    const ctx = {
      actor: "human",
      user: coach,
      principal: { kind: "staff", userId: coach.id, role: coach.role },
      db: counted.query,
    };
    const out = (await screensMine.handler({}, ctx as never)) as { screens: { key: string }[] };
    expect(out.screens.map((s) => s.key).sort()).toEqual(["classList", "desk"]);
    expect(statements).toBe(2);
  });
});

describe("what the admin's build holds (review of PR #303)", () => {
  it("lists nothing when the host has no admin build to show", async () => {
    const admin = await createUser("admin");
    setBuiltScreens(null);
    try {
      expect(await mine(admin)).toEqual([]);
    } finally {
      setBuiltScreens(BUILT);
    }
  });

  it("a row holding a pack's id with another manifest borrows none of its screens", async () => {
    // An org's own extension squatting Courses' id, declaring Courses' builder under Bookings'
    // tools (the review's probe): its gate fingerprint is not the build's, so nothing is listed.
    const base = JSON.parse(
      JSON.stringify(manifestOf("bookings")).replaceAll("bookings", "courses"),
    ) as ReturnType<typeof manifestOf>;
    const squat = {
      ...base,
      id: "courses",
      screens: {
        builder: {
          label: "Builder",
          block: "courses-builder",
          export: "CourseBuilder",
          opens: ["day"],
          record: { object: "courses.course", as: "courseId" },
        },
      },
    };
    await env.DB.prepare("DELETE FROM core_extensions WHERE id = 'courses'").run();
    await db.query
      .insertInto("core_extensions")
      .values({
        id: "courses",
        source: "shipped",
        status: "active",
        version: "9.9.9",
        commit_oid: "org",
        manifest: JSON.stringify(squat),
        user_id: owner.id,
        installed_at: NOW,
        updated_at: NOW,
      } as never)
      .execute();
    try {
      for (const role of ["viewer", "member", "admin"] as const) {
        const screens = await mine(await createUser(role));
        expect(
          screens.filter((s) => s.startsWith("courses/")),
          role,
        ).toEqual([]);
      }
    } finally {
      await install("courses");
    }
    expect(await mine(await createUser("admin"))).toContain("courses/builder");
  });

  it("one unreadable installed manifest never takes the others' screens away", async () => {
    const warn = console.warn;
    const said: string[] = [];
    console.warn = (...args: unknown[]) => {
      said.push(args.join(" "));
    };
    await env.DB.prepare(
      `UPDATE core_extensions SET manifest = '{"id":"memberships","screens":{"holdings":null}}' WHERE id = 'memberships'`,
    ).run();
    try {
      const admin = await createUser("admin");
      const screens = await mine(admin);
      expect(screens.filter((s) => s.startsWith("memberships/"))).toEqual([]);
      expect(screens).toEqual(expect.arrayContaining(BOOKINGS));
      await mine(admin);
      // Said once, not on every call.
      expect(said.filter((line) => line.includes("memberships"))).toHaveLength(1);
    } finally {
      console.warn = warn;
      await install("memberships");
    }
  });

  it("a record screen is listed with its object, for staff who may use it (criterion 5)", async () => {
    const member = await createUser("member");
    const viewer = await createUser("viewer");
    const tab = (out: Awaited<ReturnType<typeof invoke<"screens.mine">>>) =>
      out.screens.find((s) => s.pack === "memberships" && s.key === "holdings");
    expect(tab(await invoke("screens.mine", {}, context(member)))).toEqual({
      pack: "memberships",
      key: "holdings",
      label: "Memberships",
      nav: null,
      route: "/s/memberships/holdings",
      record: { object: "person", as: "personId" },
    });
    expect(tab(await invoke("screens.mine", {}, context(viewer)))).toBeUndefined();
    // A screen gated by a write of its object: any member, never a viewer or a pack role.
    expect(await mine(member)).toContain("courses/builder");
    expect(await mine(viewer)).not.toContain("courses/builder");
    expect(await mine(await account("viewer", "bookings.coach"))).not.toContain("courses/builder");
  });
});

describe("a gate tool's audience and actors (personMayCall)", () => {
  const staffRights = { packRole: null, grants: [] };
  const tool = (extra: Record<string, unknown>) =>
    defineOperation({
      name: "x.fixture.tool",
      description: "Fixture: a gate tool with a narrowed audience or actors.",
      input: z.object({}),
      output: z.object({}),
      permission: "records:read",
      risk: "read",
      handler: async () => ({}),
      ...extra,
    } as never) as unknown as AnyOperation;

  it("refuses a tool a person may not call, or one open only to customers", async () => {
    const admin = await createUser("admin");
    expect(personMayCall(tool({}), admin, staffRights)).toBe(true);
    expect(personMayCall(tool({ actors: ["assistant", "mcp"] }), admin, staffRights)).toBe(false);
    expect(personMayCall(tool({ audiences: ["customer"] }), admin, staffRights)).toBe(false);
    expect(personMayCall(tool({ audiences: ["staff", "customer"] }), admin, staffRights)).toBe(
      true,
    );
  });
});

describe("only a shipped pack declares screens (criterion 8)", () => {
  it("check and install refuse a runtime extension's screens; a shipped one passes", async () => {
    const shipped = { ...manifestOf("bookings"), id: "scrnrun" };
    // Its screens name bookings' blocks: renamed with the id, as a runtime copy would be.
    shipped.screens = {
      desk: { ...(manifestOf("bookings").screens?.desk as object), block: "scrnrun-desk" } as never,
    };
    const runtime = await checkManifest(db.query, "scrnrun", shipped, NOW, { source: "runtime" });
    expect(runtime.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "outside_audience", path: "screens" }),
      ]),
    );
    const asShipped = await checkManifest(db.query, "scrnrun", shipped, NOW, { source: "shipped" });
    expect(asShipped.issues.filter((i) => i.path.startsWith("screens"))).toEqual([]);
  });
});

describe("a pack role reaches screens.mine and nothing else new (registry walk)", () => {
  const everything: AnyOperation[] = [...coreRegistry.list(), ...releasePackTools];

  it.each([["bookings.coach"], ["rostering.team"], ["ticketing.door"]])(
    "%s reaches its tools, its reads and screens.mine",
    async (name) => {
      const user = await account("viewer", name);
      const role = (await loadPackRole(db.query, user.id)) as HeldPackRole;
      expect(role.name).toBe(name);
      const reached = everything.filter((op) => packRoleReaches(role, op)).map((op) => op.name);
      // What it reached before this stage: its pack's tools naming a permission it holds, and the
      // record reads when it reads objects.
      const before = everything
        .filter((op) =>
          op.packPermissions !== undefined
            ? op.packPermissions.some((p) => role.permissions.includes(p))
            : role.read.length > 0 && PACK_ROLE_READS.includes(op.name),
        )
        .map((op) => op.name);
      expect(reached.sort()).toEqual([...before, "screens.mine"].sort());
      // And no core operation but those.
      const core = reached.filter((n) => !n.startsWith("x."));
      expect(core.sort()).toEqual(
        [...(role.read.length ? PACK_ROLE_READS : []), "screens.mine"].sort(),
      );
      // Through the pipeline: the role's account calls it, and gets its own screens.
      await expect(invoke("screens.mine", {}, context(user))).resolves.toHaveProperty("screens");
    },
  );
});
