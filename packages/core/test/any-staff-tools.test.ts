// ADR 0652: two ways a shipped pack's tool says who may call it beyond its roles and grants.
// `anyStaff`: every staff account, pack roles included (a cleaner, a coach, the door), the host
// operation it calls deciding by its own rule (Daily checklists: the checklist's "who may do it").
// `corePermission`: a grantable core permission instead of records:read or records:write (Daily
// checklists' history: checklists:write), so no pack role and no member without the grant. The
// contract's refusals, the operation each becomes (and what a runtime extension's becomes), and the
// one authority decision the pipeline makes.
import { defineExtension, defineTool, toManifest, validateManifest, z } from "@composable-os/sdk";
import { describe, expect, it } from "vitest";
import { toolOperation } from "../src/extensions/tools.ts";
import {
  checkManifest,
  type HeldPackRole,
  packRoleReaches,
  type Role,
  type StaffRights,
  staffAuthority,
  staffRightsReach,
} from "../src/index.ts";
import { db } from "./helpers.ts";

const pack = defineExtension({
  id: "anypack",
  version: "1.0.0",
  contractVersion: 1,
  permissions: { modules: ["ops"] },
  objects: {},
  tools: {
    mine: defineTool({
      description: "Fixture: today's list, every staff account's; the host decides what is in it.",
      input: z.object({}),
      output: z.object({}),
      risk: "read",
      anyStaff: true,
      humanOnly: true,
      handler: () => ({}),
    }),
    tick: defineTool({
      description: "Fixture: a tick, every staff account's; the host decides who may.",
      input: z.object({}),
      output: z.object({}),
      anyStaff: true,
      humanOnly: true,
      handler: () => ({}),
    }),
    history: defineTool({
      description: "Fixture: how it went, for those granted checklists:write (and admins).",
      input: z.object({}),
      output: z.object({}),
      risk: "read",
      corePermission: "checklists:write",
      humanOnly: true,
      handler: () => ({}),
    }),
  },
});
const m = toManifest(pack);
const op = (name: string, source: "shipped" | "runtime" = "shipped") =>
  toolOperation(m, name, m.tools[name] as (typeof m.tools)[string], source);
const issues = (change: (c: typeof m) => void) => {
  const copy = structuredClone(m);
  change(copy);
  return validateManifest(copy).issues.map((i) => i.path);
};
const none: StaffRights = { packRole: null, grants: [] };
const cleaner: HeldPackRole = {
  name: "rostering.team",
  extension: "rostering",
  label: "Team",
  permissions: ["rostering:team"],
  read: [],
};
const as = (role: Role) => ({ role });

describe("anyStaff and corePermission (ADR 0652)", () => {
  it("the contract takes them on a person's own, staff-only tool naming no pack permission", () => {
    expect(validateManifest(m).issues).toEqual([]);
    expect(issues((c) => delete (c.tools.tick as { humanOnly?: true }).humanOnly)).toContain(
      "tools.tick.anyStaff",
    );
    expect(
      issues((c) => Object.assign(c.tools.tick as object, { permission: "anypack:x" })),
    ).toContain("tools.tick.anyStaff");
    expect(
      issues((c) => Object.assign(c.tools.tick as object, { audiences: ["customer"] })),
    ).toContain("tools.tick.anyStaff");
    expect(
      issues((c) => Object.assign(c.tools.history as object, { permission: "anypack:x" })),
    ).toContain("tools.history.corePermission");
    expect(
      issues((c) => Object.assign(c.tools.history as object, { corePermission: "anypack:x" })),
    ).toContain("tools.history.corePermission");
  });

  it("a runtime extension may declare neither", async () => {
    const out = await checkManifest(db.query, "anypack", m, new Date().toISOString(), {
      source: "runtime",
    });
    const paths = out.issues.filter((i) => i.code === "outside_audience").map((i) => i.path);
    expect(paths).toEqual(
      expect.arrayContaining([
        "tools.mine.anyStaff",
        "tools.tick.anyStaff",
        "tools.history.corePermission",
      ]),
    );
  });

  it("every staff account may call an anyStaff tool, a pack role too; a viewer reads but does not write", () => {
    const read = op("mine");
    const write = op("tick");
    expect(read.packAnyStaff).toBe(true);
    expect(read.actors).toEqual(["human"]);
    const role: StaffRights = { packRole: cleaner, grants: [] };
    expect(packRoleReaches(cleaner, write)).toBe(true);
    expect(staffRightsReach(role, write)).toBe(true);
    expect(staffAuthority(as("viewer"), role, write, {})).toBe("packRole");
    expect(staffAuthority(as("member"), none, write, {})).toBe("role");
    expect(staffAuthority(as("viewer"), none, read, {})).toBe("role");
    expect(staffAuthority(as("viewer"), none, write, {})).toBeNull();
    // From a runtime extension it is an ordinary tool: no pack role reaches it.
    expect(op("tick", "runtime").packAnyStaff).toBeUndefined();
    expect(packRoleReaches(cleaner, op("tick", "runtime"))).toBe(false);
  });

  it("a corePermission tool is its holders' only: admins and those granted it, never a pack role", () => {
    const history = op("history");
    expect(history.permission).toBe("checklists:write");
    expect(staffAuthority(as("admin"), none, history, {})).toBe("role");
    expect(staffAuthority(as("member"), none, history, {})).toBeNull();
    expect(
      staffAuthority(as("member"), { packRole: null, grants: ["checklists:write"] }, history, {}),
    ).toBe("role");
    expect(
      staffAuthority(
        as("viewer"),
        { packRole: cleaner, grants: ["checklists:write"] },
        history,
        {},
      ),
    ).toBeNull();
    // A permission that is not a grantable core one, or a runtime extension's: admins only.
    const odd = toolOperation(
      m,
      "history",
      { ...(m.tools.history as (typeof m.tools)[string]), corePermission: "records:read" },
      "shipped",
    );
    expect(odd.permission).toBe("users:manage");
    expect(op("history", "runtime").permission).toBe("users:manage");
  });
});
