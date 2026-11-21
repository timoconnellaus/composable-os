// Stage 41: permissions granted one by one (ADR 0449). A human admin grants a staff account a
// named permission on top of its role; it is read from the account on every call, additive to
// the role, replaced by a pack role, and never lets an AI actor do what only a person may.
import { env } from "cloudflare:workers";
import { defineExtension, defineTool, toManifest, z } from "@composable-os/sdk";
import { beforeAll, describe, expect, it } from "vitest";
import { toolOperation } from "../src/extensions/tools.ts";
import {
  type ActingUser,
  type AnyOperation,
  coreRegistry,
  GRANTABLE_PERMISSIONS,
  invoke,
  type Role,
  type StaffRights,
  staffMayCall,
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
              (op.permission === granted ||
                (op.packPermission === granted && op.packPermissionGrantable === true)) &&
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
