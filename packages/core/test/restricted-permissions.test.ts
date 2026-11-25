// Stage 45 step 4 (ADR 0625): restricted pack permissions. A pack declares a tool permission
// `restricted`: the tool is held by admins and by a grant of it, never through a member's or a
// viewer's own role, never through a pack role, never from another extension's code or an
// automation. And the roster's rules (ADR 0626): who rosters is the admins and those granted the
// pack's declared `staffing.rosters` permission; the roster's numbers are the pack's settings.
// Registry-wide for the authority; the contract's refusals; the rosterers read from the database.
import { env } from "cloudflare:workers";
import { defineExtension, defineTool, toManifest, validateManifest, z } from "@composable-os/sdk";
import { beforeAll, describe, expect, it } from "vitest";
import { toolOperation } from "../src/extensions/tools.ts";
import {
  type ActingUser,
  type AnyOperation,
  coreRegistry,
  type HeldPackRole,
  type Role,
  type StaffRights,
  staffAuthority,
  staffRightsReach,
} from "../src/index.ts";
import { isRosterer, rosterers, rosterNumbers } from "../src/staffing/rosterers.ts";
import { createUser, db } from "./helpers.ts";

const pack = defineExtension({
  id: "rpack",
  version: "1.0.0",
  contractVersion: 1,
  permissions: { modules: ["ops"] },
  grantable: ["rpack:roster", "rpack:manage"],
  restricted: ["rpack:manage"],
  staffing: { rosters: "rpack:manage", settings: { offerCutoffMinutes: "cutoff" } },
  settings: {
    cutoff: {
      type: "number",
      label: "Cut-off",
      default: 45,
      min: 0,
      max: 600,
      personApproves: true,
    },
    days: { type: "number", label: "Days", default: 10 },
  },
  objects: {},
  roles: {
    team: {
      label: "Team",
      description: "Fixture: the team's tools only.",
      permissions: ["rpack:team"],
      read: [],
    },
  },
  tools: {
    week: defineTool({
      description: "Fixture: the team's read, also granted to another role's account.",
      input: z.object({}),
      output: z.object({}),
      risk: "read",
      permission: ["rpack:team", "rpack:roster"],
      grantLiftsRoleLimits: true,
      handler: () => ({}),
    }),
    assign: defineTool({
      description: "Fixture: the rosterers' write, restricted.",
      input: z.object({ note: z.string().optional() }),
      output: z.object({}),
      permission: "rpack:manage",
      personApproves: true,
      redact: ["note"],
      handler: () => ({}),
    }),
    peek: defineTool({
      description: "Fixture: the rosterers' read, restricted.",
      input: z.object({}),
      output: z.object({}),
      risk: "read",
      permission: "rpack:manage",
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
  return validateManifest(copy).issues.map((i) => `${i.path}: ${i.message}`);
};

const none: StaffRights = { packRole: null, grants: [] };
const granted: StaffRights = { packRole: null, grants: ["rpack:manage"] };
const team: HeldPackRole = {
  name: "rpack.team",
  extension: "rpack",
  label: "Team",
  permissions: ["rpack:team"],
  read: [],
};
const as = (role: Role) => ({ role });

describe("restricted pack permissions (ADR 0625)", () => {
  it("the manifest passes the contract", () => {
    expect(validateManifest(m).issues).toEqual([]);
  });

  it("an admin holds a restricted tool; a member or viewer only by a grant; a role never", () => {
    for (const name of ["assign", "peek"]) {
      const tool = op(name);
      expect(tool.packRestricted).toBe(true);
      expect(staffAuthority(as("admin"), none, tool, {})).toBe("role");
      expect(staffAuthority(as("member"), none, tool, {})).toBeNull();
      expect(staffAuthority(as("viewer"), none, tool, {})).toBeNull();
      expect(staffAuthority(as("member"), granted, tool, {})).toBe("grant");
      expect(staffAuthority(as("viewer"), granted, tool, {})).toBe("grant");
      // A pack role's account: only by the grant.
      expect(staffAuthority(as("viewer"), { packRole: team, grants: [] }, tool, {})).toBeNull();
      expect(staffRightsReach({ packRole: team, grants: [] }, tool)).toBe(false);
      expect(
        staffAuthority(as("viewer"), { packRole: team, grants: ["rpack:manage"] }, tool, {}),
      ).toBe("grant");
      // Never another extension's code or an automation; an assistant only where no person is needed.
      expect(tool.actors).toEqual(["human", "assistant", "mcp"]);
    }
    // A person approves anyone else's call of the write.
    expect(op("assign").alwaysReview).toEqual(["assistant", "mcp", "automation", "extension"]);
    // The team's tools are not restricted: every member holds them, as any tool.
    expect(op("week").packRestricted).toBeUndefined();
    expect(staffAuthority(as("member"), none, op("week"), {})).toBe("role");
  });

  it("a grant stops counting once the pack no longer declares it grantable", () => {
    const { grantable: _, ...rest } = m;
    const tool = toolOperation(rest, "peek", m.tools.peek as (typeof m.tools)[string], "shipped");
    expect(staffAuthority(as("member"), granted, tool, {})).toBeNull();
    expect(staffAuthority(as("admin"), none, tool, {})).toBe("role");
  });

  it("a runtime extension's tool naming one is an admin's only (fail closed)", () => {
    const tool = op("peek", "runtime");
    expect(tool.packRestricted).toBe(true);
    expect(tool.packGrantable).toBeUndefined();
    expect(staffAuthority(as("admin"), none, tool, {})).toBe("role");
    expect(staffAuthority(as("member"), granted, tool, {})).toBeNull();
  });

  it("registry-wide: restricting closes nothing but the restricted tools, for a member and a viewer", () => {
    const tools = Object.keys(m.tools).map((name) => op(name));
    const all: AnyOperation[] = [...coreRegistry.list(), ...tools];
    for (const role of ["member", "viewer"] as Role[]) {
      const closed = all.filter(
        (o) => staffAuthority(as(role), none, o, { object: "person" }) === null,
      );
      const unrestricted = all.filter(
        (o) =>
          staffAuthority(as(role), none, { ...o, packRestricted: undefined } as AnyOperation, {
            object: "person",
          }) === null,
      );
      expect(
        closed.filter((o) => !unrestricted.includes(o)).map((o) => o.name),
        role,
      ).toEqual(role === "member" ? ["x.rpack.assign", "x.rpack.peek"] : ["x.rpack.peek"]);
    }
  });

  it("the audit log never keeps a tool's redacted input", () => {
    expect(op("assign").redact).toEqual(["agreements", "note"]);
  });

  it("the contract refuses what would leak a restricted permission", () => {
    expect(
      issues((c) => {
        c.restricted = ["rpack:manage", "rpack:nothing"];
      }),
    ).toEqual([expect.stringContaining("restricted.1")]);
    expect(
      issues((c) => {
        c.restricted = ["rpack:team"];
        c.staffing = { rosters: "rpack:team" };
      }),
    ).toEqual(
      expect.arrayContaining([
        expect.stringContaining("is held by a role of this extension"),
        expect.stringContaining("tools.week.permission: A tool naming a restricted permission"),
      ]),
    );
    expect(
      issues((c) => {
        (c.tools.peek as { permission: unknown }).permission = ["rpack:manage", "rpack:roster"];
      }),
    ).toEqual([expect.stringContaining("tools.peek.permission: A tool naming a restricted")]);
    expect(
      issues((c) => {
        c.staffing = { rosters: "rpack:roster" };
      }),
    ).toEqual([expect.stringContaining("staffing.rosters")]);
    expect(
      issues((c) => {
        c.staffing = { rosters: "rpack:manage", settings: { uncoveredDays: "nope" } };
      }),
    ).toEqual([expect.stringContaining("staffing.settings.uncoveredDays")]);
    // The roster's numbers are a person's to change: a setting an AI could write is refused.
    expect(
      issues((c) => {
        c.staffing = { rosters: "rpack:manage", settings: { uncoveredDays: "days" } };
      }),
    ).toEqual([expect.stringContaining("staffing.settings.uncoveredDays")]);
    expect(
      issues((c) => {
        (c.tools.assign as { redact?: string[] }).redact = ["missing"];
      }),
    ).toEqual([expect.stringContaining("tools.assign.redact")]);
  });
});

describe("the rosterers and the roster's numbers (ADR 0626)", () => {
  let admin: ActingUser;
  let member: ActingUser;
  let grantedMember: ActingUser;
  beforeAll(async () => {
    admin = await createUser("admin");
    member = await createUser("member");
    grantedMember = await createUser("member");
    const now = new Date().toISOString();
    await env.DB.prepare(
      "INSERT INTO core_extensions (id, source, status, version, commit_oid, manifest, user_id, installed_at, updated_at) VALUES ('rpack', 'shipped', 'active', '1.0.0', 'c1', ?, ?, ?, ?)",
    )
      .bind(JSON.stringify(m), admin.id, now, now)
      .run();
    await env.DB.prepare("UPDATE core_user SET granted_permissions = ? WHERE id = ?")
      .bind(JSON.stringify(["rpack:manage"]), grantedMember.id)
      .run();
  });

  it("admins and accounts granted the rosterers' permission roster; nobody else", async () => {
    expect(await isRosterer(db.query, admin.id)).toBe(true);
    expect(await isRosterer(db.query, grantedMember.id)).toBe(true);
    expect(await isRosterer(db.query, member.id)).toBe(false);
    const all = await rosterers(db.query);
    expect(all).toEqual(expect.arrayContaining([admin.id, grantedMember.id]));
    expect(all).not.toContain(member.id);
  });

  it("a deactivated account, or a pack no longer active, makes nobody a rosterer by grant", async () => {
    await env.DB.prepare("UPDATE core_extensions SET status = 'disabled' WHERE id = 'rpack'").run();
    try {
      expect(await isRosterer(db.query, grantedMember.id)).toBe(false);
      expect(await isRosterer(db.query, admin.id)).toBe(true);
      expect(await rosterers(db.query)).not.toContain(grantedMember.id);
    } finally {
      await env.DB.prepare("UPDATE core_extensions SET status = 'active' WHERE id = 'rpack'").run();
    }
    const gone = await createUser("admin");
    await env.DB.prepare("UPDATE core_user SET deactivated_at = ? WHERE id = ?")
      .bind(new Date().toISOString(), gone.id)
      .run();
    expect(await isRosterer(db.query, gone.id)).toBe(false);
  });

  it("the numbers are the pack's settings, stored or declared, within bounds", async () => {
    expect(await rosterNumbers(db.query)).toEqual({ cutoffMinutes: 45, uncoveredDays: 14 });
    await env.DB.prepare(
      "INSERT INTO core_extension_settings (extension_id, value, updated_at) VALUES ('rpack', ?, ?)",
    )
      .bind(JSON.stringify({ cutoff: 90 }), new Date().toISOString())
      .run();
    expect((await rosterNumbers(db.query)).cutoffMinutes).toBe(90);
    await env.DB.prepare(
      "UPDATE core_extension_settings SET value = ? WHERE extension_id = 'rpack'",
    )
      .bind(JSON.stringify({ cutoff: 1_000_000 }))
      .run();
    expect((await rosterNumbers(db.query)).cutoffMinutes).toBe(10_080);
  });
});
