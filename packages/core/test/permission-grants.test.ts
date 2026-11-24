// Stage 41: permissions granted one by one (ADR 0449). A human admin grants a staff account a
// named permission on top of its role; it is read from the account on every call, additive to
// the role, replaced by a pack role, and never lets an AI actor do what only a person may.
import { env } from "cloudflare:workers";
import { defineExtension, defineTool, toManifest, validateManifest, z } from "@composable-os/sdk";
import { beforeAll, describe, expect, it } from "vitest";
import { toolOperation } from "../src/extensions/tools.ts";
import {
  type ActingUser,
  type AnyOperation,
  coreRegistry,
  FIXED_ROLE_CORE_GRANTS,
  GRANTABLE_PERMISSIONS,
  type HeldPackRole,
  invoke,
  type Permission,
  type Role,
  roleLimitsFor,
  type StaffRights,
  staffAuthority,
  staffMayCall,
  staffRightsReach,
} from "../src/index.ts";
import { extId, manifest, reconcile } from "./extension-helpers.ts";
import { auditChanges, context, createUser, unique } from "./helpers.ts";

const EXT = extId("grant");
const DOC = `${EXT}.doc`;
let admin: ActingUser;
let coach: ActingUser;

async function refusal(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return error as { code: string; message: string; details?: Record<string, unknown> };
  }
  throw new Error("expected a refusal");
}

const publish = async (user: ActingUser, extra: Record<string, unknown> = {}) => {
  const doc = await invoke(
    "record.create",
    { object: DOC, values: { title: unique("Doc") } },
    context(admin),
  );
  return invoke("record.publish", { object: DOC, id: doc.id }, context(user, extra as never));
};

const grant = (
  id: string,
  permissions: string[],
  by = admin,
  extra: Record<string, unknown> = {},
) => invoke("user.setPermissions", { id, permissions }, context(by, extra as never));

beforeAll(async () => {
  admin = await createUser("admin");
  coach = await createUser("member");
  await reconcile(
    manifest(EXT, {
      objects: {
        doc: {
          label: "Doc",
          plural: "Docs",
          titleField: "title",
          fields: { title: { type: "text", label: "Title", required: true } },
          publishable: { content: ["title"] },
        },
      },
    }),
  );
});

describe("granting records:publish to a member", () => {
  it("a member publishes once granted, is refused without, and the next call after revoking", async () => {
    expect(await refusal(publish(coach))).toMatchObject({
      code: "forbidden",
      details: { permission: "records:publish" },
    });
    const granted = await grant(coach.id, ["records:publish"]);
    expect(granted).toMatchObject({ permissions: ["records:publish"], previousPermissions: [] });
    // The account built by the adapter still says only `member`: the grant is read from the row.
    expect((await publish(coach)).version).toBe(1);
    await grant(coach.id, []);
    expect(await refusal(publish(coach))).toMatchObject({ code: "forbidden" });
  });

  it("an MCP client and the assistant acting as that member only ask: a person approves", async () => {
    await grant(coach.id, ["records:publish"]);
    const mcp = {
      actor: "mcp",
      origin: { surface: "mcp", clientId: "c", clientName: "Test", sessionId: unique("s") },
      grantedPermissions: ["records:read", "records:write", "records:publish"],
    };
    const assistant = {
      actor: "assistant",
      origin: { surface: "assistant", sessionId: unique("ath") },
    };
    for (const extra of [mcp, assistant]) {
      expect(await refusal(publish(coach, extra))).toMatchObject({ code: "pending_approval" });
    }
    await grant(coach.id, []);
  });

  it("is a human admin's, from the grantable list, audited with before and after", async () => {
    const other = await createUser("member");
    expect(await refusal(grant(other.id, ["records:publish"], coach))).toMatchObject({
      code: "forbidden",
    });
    expect(
      await refusal(
        grant(other.id, ["records:publish"], admin, {
          actor: "mcp",
          origin: { surface: "mcp", clientId: "c", clientName: "T", sessionId: unique("s") },
        }),
      ),
    ).toMatchObject({ code: "forbidden" });
    for (const bad of ["users:manage", "policy:manage", "records:erase", "nope:x"]) {
      expect(await refusal(grant(other.id, [bad]))).toMatchObject({ code: "invalid_input" });
    }
    await grant(other.id, ["orders:refund", "records:publish"]);
    await grant(other.id, ["records:publish"]);
    const changes = (await auditChanges(other.id)).filter(
      (c) => c.operation === "user.setPermissions",
    );
    expect(changes.map((c) => c.diff)).toEqual([
      { permissions: { before: [], after: ["orders:refund", "records:publish"] } },
      { permissions: { before: ["orders:refund", "records:publish"], after: ["records:publish"] } },
    ]);
    const listed = await invoke("user.grantablePermissions", {}, context(admin));
    expect(listed.items.map((i) => i.permission)).toEqual(
      expect.arrayContaining([...GRANTABLE_PERMISSIONS]),
    );
  });

  it("counts for nothing while a pack role is held", async () => {
    const row = await env.DB.prepare("SELECT granted_permissions FROM core_user WHERE id = ?")
      .bind(coach.id)
      .first<{ granted_permissions: string | null }>();
    expect(row?.granted_permissions).toBeNull();
    const rights: StaffRights = {
      packRole: { name: "x.door", extension: "x", label: "Door", permissions: [], read: [] },
      grants: ["records:publish"],
    };
    const op = coreRegistry.get("record.publish") as AnyOperation;
    expect(staffMayCall({ role: "member" }, rights, op, {})).toBe(false);
  });
});

describe("a grant opens only the operations that name that permission (registry-wide)", () => {
  // A pack with a tool permission it declares grantable, and one it does not.
  const pack = defineExtension({
    id: "grantpack",
    version: "1.0.0",
    contractVersion: 1,
    permissions: { modules: ["ops"] },
    grantable: ["grantpack:scan"],
    tools: {
      scan: defineTool({
        description: "Fixture: a write tool whose permission the pack declares grantable.",
        input: z.object({}),
        output: z.object({}),
        permission: "grantpack:scan",
        handler: () => ({}),
      }),
      wipe: defineTool({
        description: "Fixture: a write tool whose permission is not grantable.",
        input: z.object({}),
        output: z.object({}),
        permission: "grantpack:wipe",
        handler: () => ({}),
      }),
    },
  });
  const m = toManifest(pack);
  const tools = Object.entries(m.tools).map(([name, tool]) =>
    toolOperation(m, name, tool, "shipped"),
  );
  const all = [...coreRegistry.list(), ...tools];

  for (const role of ["viewer", "member"] as Role[]) {
    for (const granted of [...GRANTABLE_PERMISSIONS, "grantpack:scan", "grantpack:wipe"]) {
      it(`${role} granted ${granted}`, () => {
        const opened: string[] = [];
        for (const op of all) {
          const without = staffMayCall({ role }, { packRole: null, grants: [] }, op, {});
          const withGrant = staffMayCall({ role }, { packRole: null, grants: [granted] }, op, {});
          expect(without && !withGrant, op.name).toBe(false);
          if (withGrant && !without) opened.push(op.name);
        }
        const expected = all
          .filter(
            (op) =>
              (op.permission === granted || (op.packGrantable ?? []).includes(granted)) &&
              !staffMayCall({ role }, { packRole: null, grants: [] }, op, {}),
          )
          .map((op) => op.name);
        expect(opened.sort()).toEqual(expected.sort());
        if (granted === "records:publish") expect(opened).toContain("record.publish");
        if (granted === "orders:refund")
          expect(opened).toEqual(expect.arrayContaining(["order.refund"]));
        if (granted === "grantpack:scan" && role === "viewer")
          expect(opened).toEqual(["x.grantpack.scan"]);
        if (granted === "grantpack:wipe") expect(opened).toEqual([]);
      });
    }
  }
});

describe("a pack role and its grants add up, each call by one authority (ADR 0600, registry-wide)", () => {
  // A pack with a role limited to today, a role-only tool, a grantable tool, and a tool opened by
  // either (the shape of Bookings' coach role, its desk permission and its day view).
  const pack = defineExtension({
    id: "deskpack",
    version: "1.0.0",
    contractVersion: 1,
    permissions: { modules: ["ops"] },
    grantable: ["deskpack:desk"],
    objects: {
      slot: {
        label: "Slot",
        plural: "Slots",
        titleField: "title",
        fields: {
          title: { type: "text", label: "Title" },
          at: { type: "datetime", label: "At" },
        },
      },
    },
    roles: {
      coach: {
        label: "Coach",
        description: "Fixture: ticks today's slots.",
        permissions: ["deskpack:coach"],
        read: ["deskpack.slot"],
        today: { "deskpack.slot": "at" },
      },
    },
    tools: {
      tick: defineTool({
        description: "Fixture: the coach role's tool, held to the role's today.",
        input: z.object({}),
        output: z.object({}),
        permission: "deskpack:coach",
        handler: () => ({}),
      }),
      book: defineTool({
        description: "Fixture: the desk's tool, opened by the grantable permission only.",
        input: z.object({}),
        output: z.object({}),
        permission: "deskpack:desk",
        handler: () => ({}),
      }),
      day: defineTool({
        description: "Fixture: opened by either the coach role or the desk's grant.",
        input: z.object({}),
        output: z.object({}),
        risk: "read",
        permission: ["deskpack:coach", "deskpack:desk"],
        grantLiftsRoleLimits: true,
        handler: () => ({}),
      }),
      other: defineTool({
        description: "Fixture: a tool with no permission, which a role never reaches.",
        input: z.object({}),
        output: z.object({}),
        handler: () => ({}),
      }),
    },
  });
  const m = toManifest(pack);
  const tools = Object.fromEntries(
    Object.entries(m.tools).map(([name, tool]) => [name, toolOperation(m, name, tool, "shipped")]),
  ) as Record<string, AnyOperation>;
  const tool = (name: string) => tools[name] as AnyOperation;
  const all = [...coreRegistry.list(), ...Object.values(tools)];
  const today = { "deskpack.slot": "at" } as const;
  const role: HeldPackRole = {
    name: "deskpack.coach",
    extension: "deskpack",
    label: "Coach",
    permissions: ["deskpack:coach"],
    read: ["deskpack.slot"],
    today,
  };
  const viewer = { role: "viewer" as Role };
  const inputFor = (op: AnyOperation) =>
    op.name.startsWith("record.") ? { object: "deskpack.slot" } : {};
  const coachOnly: StaffRights = { packRole: role, grants: [] };
  const both: StaffRights = { packRole: role, grants: ["deskpack:desk"] };

  it("carries every permission of a tool; only the grantable one is grantable", () => {
    expect(tool("day").packPermissions).toEqual(["deskpack:coach", "deskpack:desk"]);
    expect(tool("day").packGrantable).toEqual(["deskpack:desk"]);
    expect(tool("tick").packGrantable).toBeUndefined();
  });

  it("without the grant the role alone, limited; with it the grant's tools, unlimited, and nothing more", () => {
    const opened: string[] = [];
    for (const op of all) {
      const input = inputFor(op);
      const before = staffAuthority(viewer, coachOnly, op, input);
      const after = staffAuthority(viewer, both, op, input);
      // A grant never closes anything the role allows.
      if (before !== null) expect(after, op.name).not.toBeNull();
      if (after !== null && before === null) opened.push(op.name);
      // The limit travels exactly when the role, not the grant, allows the call.
      if (after === "packRole") expect(roleLimitsFor(both, op), op.name).toEqual(today);
      if (after === "grant") expect(roleLimitsFor(both, op), op.name).toBeUndefined();
      // The check made before the input is parsed never refuses what is allowed.
      if (after !== null) expect(staffRightsReach(both, op), op.name).toBe(true);
    }
    // What the grant opens is exactly the tools naming the granted permission.
    expect(opened).toEqual(["x.deskpack.book"]);
    expect(staffAuthority(viewer, both, tool("book"), {})).toBe("grant");
    // A tool either opens: through the grant, so the role's limit does not block it.
    expect(staffAuthority(viewer, both, tool("day"), {})).toBe("grant");
    expect(roleLimitsFor(both, tool("day"))).toBeUndefined();
    expect(staffAuthority(viewer, coachOnly, tool("day"), {})).toBe("packRole");
    expect(roleLimitsFor(coachOnly, tool("day"))).toEqual(today);
    // The role's own tool and reads stay the role's, limited: the grant lifts nothing off them.
    expect(staffAuthority(viewer, both, tool("tick"), {})).toBe("packRole");
    expect(roleLimitsFor(both, tool("tick"))).toEqual(today);
    const list = coreRegistry.get("record.list") as AnyOperation;
    expect(staffAuthority(viewer, both, list, { object: "deskpack.slot" })).toBe("packRole");
    expect(roleLimitsFor(both, list)).toEqual(today);
    expect(staffAuthority(viewer, both, list, { object: "person" })).toBeNull();
    expect(staffAuthority(viewer, both, tool("other"), {})).toBeNull();
  });

  it("a core grant, or a role-held permission as a grant, changes nothing beside a pack role", () => {
    for (const granted of [...GRANTABLE_PERMISSIONS, "deskpack:coach", "records:write"]) {
      const rights: StaffRights = { packRole: role, grants: [granted] };
      for (const op of all) {
        const input = inputFor(op);
        // The few core grants a fixed role's account may hold open their own operations, and
        // nothing else (ADR 0783: people:cards, the card operations).
        if (FIXED_ROLE_CORE_GRANTS.includes(granted as Permission) && op.permission === granted) {
          expect(staffAuthority(viewer, rights, op, input), `${granted} ${op.name}`).toBe("grant");
          continue;
        }
        expect(staffAuthority(viewer, rights, op, input), `${granted} ${op.name}`).toEqual(
          staffAuthority(viewer, coachOnly, op, input),
        );
        expect(roleLimitsFor(rights, op), `${granted} ${op.name}`).toEqual(today);
      }
    }
  });

  it("the contract: a tool's permissions are its own; a role-held permission is never grantable", () => {
    expect(validateManifest(m).issues).toEqual([]);
    const issues = (change: (copy: typeof m) => void) => {
      const copy = structuredClone(m);
      change(copy);
      return validateManifest(copy).issues.map((i) => `${i.path}: ${i.message}`);
    };
    expect(
      issues((c) => {
        c.grantable = ["deskpack:desk", "deskpack:coach"];
      }),
    ).toEqual([
      expect.stringContaining('grantable.1: "deskpack:coach" is held by a role'),
      // And the coach's own tool would then be opened by a grant: refused too.
      expect.stringContaining("tools.tick.permission: This tool names a permission a role holds"),
    ]);
    expect(
      issues((c) => {
        (c.tools.day as { permission: unknown }).permission = [
          "deskpack:coach",
          "deskpack:desk",
          "other:desk",
        ];
      }),
    ).toEqual([expect.stringContaining('not "other:desk"')]);
    expect(
      issues((c) => {
        (c.tools.day as { permission: unknown }).permission = [
          "deskpack:coach",
          "deskpack:desk",
          "deskpack:desk",
        ];
      }),
    ).toEqual([expect.stringContaining("each permission once")]);
    expect(
      issues((c) => {
        c.grantableLabels = { "deskpack:coach": "Fixture words for a permission not grantable." };
      }),
    ).toEqual([expect.stringContaining("is not in grantable")]);
    // A role's own tool given the grantable permission too, without saying the grant lifts the
    // role's limits for it: refused, and the host would not open it to the grant either.
    const tickToo = (c: typeof m) => {
      (c.tools.tick as { permission: unknown }).permission = ["deskpack:coach", "deskpack:desk"];
    };
    expect(issues(tickToo)).toEqual([
      expect.stringContaining("tools.tick.permission: This tool names a permission a role holds"),
    ]);
    const copy = structuredClone(m);
    tickToo(copy);
    const tick = toolOperation(
      copy,
      "tick",
      copy.tools.tick as (typeof m.tools)[string],
      "shipped",
    );
    expect(tick.packGrantable).toBeUndefined();
    expect(staffAuthority(viewer, both, tick, {})).toBe("packRole");
    expect(roleLimitsFor(both, tick)).toEqual(today);
    // The flag where the tool does not name both: refused.
    expect(
      issues((c) => {
        (c.tools.book as { grantLiftsRoleLimits?: true }).grantLiftsRoleLimits = true;
      }),
    ).toEqual([expect.stringContaining("tools.book.grantLiftsRoleLimits")]);
  });

  it("a grant stops counting once the pack no longer declares it grantable", () => {
    const { grantable: _, ...rest } = m;
    const book = toolOperation(rest, "book", m.tools.book as (typeof m.tools)[string], "shipped");
    expect(staffAuthority(viewer, both, book, {})).toBeNull();
  });
});
