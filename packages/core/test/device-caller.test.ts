// Stage 51 step 2 (ADR 0781): a device as a caller, and device roles. A shipped pack declares a
// device role; an admin who is a person enrols a tablet for it; the tablet's credential, on the
// desk origin, calls exactly the role's tools (open to `device` only) and `device.heartbeat`, as
// the device (`ctx.caller` names it), and is refused every other operation in the registry
// before its input is looked at. A signing tablet calls none of them, and a check-in tablet claims
// no signing session. Nobody else (staff, a customer, the public, an AI, an automation) reaches a
// device's operation. All names here are fixture names.
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { toolOperation } from "../src/extensions/tools.ts";
import {
  type ActingUser,
  type AnyOperation,
  checkManifest,
  coreRegistry,
  type DeskHost,
  type DeviceInvocationContext,
  type ExtensionHost,
  invoke,
  invokeByName,
  invokeOperation,
  listOperations,
  loadExtensionOperations,
  type OutsideInvocationContext,
  type RunToolInput,
} from "../src/index.ts";
import { outside } from "./customer-fixtures.ts";
import { extId, manifest } from "./extension-helpers.ts";
import { context, createUser, db, unique } from "./helpers.ts";
import { releasePackTools } from "./release-packs.ts";

const SECRET = "fixture-desk-secret-fixture-desk-secret";
const ORIGIN = "https://desk.crm.example.test";
const DESK: DeskHost = { secret: SECRET, origin: ORIGIN };

const PACK = extId("dv");
const CHECKIN = `${PACK}.checkin`;

const tool = (extra: Record<string, unknown>) => ({
  description: "Fixture: a tool an enrolled device calls at the door.",
  risk: "read",
  inputSchema: { type: "object", properties: {} },
  outputSchema: { type: "object", properties: {} },
  ...extra,
});

const MANIFEST = manifest(PACK, {
  tools: {
    now: tool({ audiences: ["device"], permission: `${PACK}:checkin` }),
    tick: tool({ audiences: ["device"], permission: `${PACK}:checkin`, risk: "write" }),
    count: tool({ audiences: ["device"], permission: `${PACK}:stock` }),
    list: tool({}),
  } as never,
  deviceRoles: {
    checkin: {
      label: "Check-in tablet",
      description: "Fixture: checks people in at the door. Nothing else.",
      permissions: [`${PACK}:checkin`],
      screen: { block: `${PACK}-tablet`, export: "Tablet" },
    },
    stock: {
      label: "Stock tablet",
      description: "Fixture: counts the stock room. Nothing else.",
      permissions: [`${PACK}:stock`],
      screen: { block: `${PACK}-stock`, export: "Stock" },
    },
  },
});

let admin: ActingUser;
let member: ActingUser;

/** What the fixture runtime was asked to run, newest last. */
const runs: RunToolInput[] = [];
const extensionHost = {
  async runTool(input: RunToolInput) {
    runs.push(input);
    return { ok: true, value: {}, runId: "run_fixture" };
  },
} as unknown as ExtensionHost;

async function refusal(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return error as { code: string; message: string; details?: Record<string, unknown> };
  }
  throw new Error("expected a refusal");
}

/** A browser on the desk origin: its credential, set only by answers that succeeded. */
class Tablet {
  credential: string | null = null;

  request(pending: { credential?: string }) {
    return {
      credential: this.credential,
      token: null,
      userAgent: "Fixture tablet browser",
      address: "192.0.2.20",
      issue: (cookies: { credential?: string }) => Object.assign(pending, cookies),
    };
  }

  /** As the desk origin's handler calls a device's operation. */
  deviceCtx(pending: { credential?: string } = {}): DeviceInvocationContext {
    return {
      principal: { kind: "device" },
      db,
      extensionHost,
      desk: { ...DESK, request: this.request(pending) },
    };
  }

  /** As the desk origin's handler calls a desk call (public, deskOnly). */
  publicCtx(pending: { credential?: string } = {}): OutsideInvocationContext {
    return outside({ kind: "public" }, { desk: { ...DESK, request: this.request(pending) } });
  }

  async call(name: string, input: unknown = {}): Promise<Record<string, unknown>> {
    const pending: { credential?: string } = {};
    const result = await invokeByName(name, input, this.deviceCtx(pending));
    if (pending.credential !== undefined) this.credential = pending.credential;
    return result as Record<string, unknown>;
  }

  async claim(code: string) {
    const pending: { credential?: string } = {};
    await invokeByName("device.claim", { code }, this.publicCtx(pending));
    this.credential = pending.credential ?? null;
  }
}

async function enrolled(use: "signing" | "role", role?: string) {
  const name = unique("Front door tablet");
  const made = await invoke(
    "device.enrol",
    { name, use, ...(role ? { role } : {}) },
    context(admin, { desk: DESK }),
  );
  const tablet = new Tablet();
  await tablet.claim(made.code);
  return { tablet, deviceId: made.device.id as string, name };
}

async function setPack(status: "active" | "disabled", source: "shipped" | "runtime") {
  await env.DB.prepare("UPDATE core_extensions SET status = ?, source = ? WHERE id = ?")
    .bind(status, source, PACK)
    .run();
}

beforeAll(async () => {
  admin = await createUser("admin");
  member = await createUser("member");
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO core_extensions (id, source, status, version, commit_oid, manifest, user_id,
       installed_at, updated_at)
     VALUES (?, 'shipped', 'active', '1.0.0', 'fixture', ?, ?, ?, ?)`,
  )
    .bind(PACK, JSON.stringify(MANIFEST), admin.id, now, now)
    .run();
}, 60_000);

describe("a device role (ADR 0781)", () => {
  it("lets an admin enrol a device for it; an undeclared role is still refused", async () => {
    const { deviceId } = await enrolled("role", CHECKIN);
    const listed = await invoke("device.list", {}, context(admin, { desk: DESK }));
    const row = listed.devices.find((d) => d.id === deviceId);
    expect(row).toMatchObject({ use: "role", role: CHECKIN, state: "active" });
    const bad = await refusal(
      invoke(
        "device.enrol",
        { name: "Fixture", use: "role", role: `${PACK}.nothing` },
        context(admin, { desk: DESK }),
      ),
    );
    expect(bad.details).toMatchObject({ rule: "device_role" });
  });

  it("calls its heartbeat, seen in the same call", async () => {
    const { tablet, deviceId, name } = await enrolled("role", CHECKIN);
    // Seen a minute ago (the claim): the heartbeat sees it again, in its own call's batch.
    const back = new Date(Date.now() - 60_000).toISOString();
    await env.DB.prepare("UPDATE core_device SET last_seen_at = ? WHERE id = ?")
      .bind(back, deviceId)
      .run();
    expect(await tablet.call("device.heartbeat")).toEqual({ name, role: CHECKIN });
    const seen = await env.DB.prepare("SELECT last_seen_at FROM core_device WHERE id = ?")
      .bind(deviceId)
      .first<{ last_seen_at: string }>();
    expect(Date.parse(seen?.last_seen_at ?? "")).toBeGreaterThan(Date.parse(back));
  });

  it("calls its role's tools as the device: ctx.caller names it, the run is the extension's", async () => {
    const { tablet, deviceId, name } = await enrolled("role", CHECKIN);
    runs.length = 0;
    await tablet.call(`x.${PACK}.now`);
    await tablet.call(`x.${PACK}.tick`);
    expect(runs.map((r) => r.tool)).toEqual(["now", "tick"]);
    for (const run of runs) {
      expect(run.caller).toEqual({
        actor: "device",
        userId: deviceId,
        name,
        device: { deviceId, name },
      });
      // Not a customer's or the public's run: its calls are the extension's, never a principal's.
      expect(run.caller.principal).toBeUndefined();
    }
    // The write is audited as the device's.
    const audit = await env.DB.prepare(
      "SELECT actor, user_id, outcome FROM core_audit WHERE operation = ? AND user_id = ?",
    )
      .bind(`x.${PACK}.tick`, deviceId)
      .first<{ actor: string; user_id: string; outcome: string }>();
    expect(audit).toEqual({ actor: "device", user_id: deviceId, outcome: "ok" });
  });

  it("reaches nothing outside its role (registry walk)", async () => {
    const { tablet, deviceId } = await enrolled("role", CHECKIN);
    const everything: AnyOperation[] = [
      ...coreRegistry.list(),
      ...releasePackTools,
      ...(await loadExtensionOperations(db.query)),
    ];
    const reached: string[] = [];
    for (const op of everything) {
      try {
        await invokeOperation(op, {}, tablet.deviceCtx());
        reached.push(op.name);
      } catch (error) {
        const code = (error as { code?: string }).code;
        // Told no such operation exists, or (a device's operation outside its role) forbidden.
        expect([op.name, code]).toEqual([
          op.name,
          expect.stringMatching(/^(unknown_operation|forbidden)$/),
        ]);
        if (code === "forbidden") {
          expect((error as { details?: unknown }).details).toMatchObject({ rule: "device_role" });
        }
      }
    }
    expect([...new Set(reached)].sort()).toEqual(
      ["device.heartbeat", `x.${PACK}.now`, `x.${PACK}.tick`].sort(),
    );
    // Another device role's tool is refused, audited as this device's.
    const other = await refusal(tablet.call(`x.${PACK}.count`));
    expect(other.code).toBe("forbidden");
    const audit = await env.DB.prepare(
      "SELECT actor, outcome, input FROM core_audit WHERE operation = ? AND user_id = ?",
    )
      .bind(`x.${PACK}.count`, deviceId)
      .first<{ actor: string; outcome: string; input: string }>();
    expect(audit).toEqual({ actor: "device", outcome: "forbidden", input: "null" });
  });

  it("holds nothing while its pack is disabled or not shipped", async () => {
    const { tablet } = await enrolled("role", CHECKIN);
    try {
      await setPack("disabled", "shipped");
      expect((await refusal(tablet.call("device.heartbeat"))).code).toBe("forbidden");
      await setPack("active", "runtime");
      expect((await refusal(tablet.call("device.heartbeat"))).code).toBe("forbidden");
    } finally {
      await setPack("active", "shipped");
    }
    await expect(tablet.call("device.heartbeat")).resolves.toHaveProperty("role", CHECKIN);
  });
});

describe("one use per device (ADR 0780, criterion 2)", () => {
  it("a signing device calls no device tool", async () => {
    const { tablet } = await enrolled("signing");
    for (const name of ["device.heartbeat", `x.${PACK}.now`]) {
      const refused = await refusal(tablet.call(name));
      expect(refused.code).toBe("forbidden");
      expect(refused.details).toMatchObject({ rule: "device_role" });
    }
  });

  it("a check-in device claims no signing session", async () => {
    const { tablet } = await enrolled("role", CHECKIN);
    const refused = await refusal(
      invokeByName("desk.claim", { code: "ABCDEF" }, tablet.publicCtx()),
    );
    expect(refused.code).toBe("forbidden");
    expect(refused.details).toMatchObject({ rule: "device_use" });
  });
});

describe("who else reaches a device's operation (criteria 14 and 16)", () => {
  it("not a browser without an enrolled credential, nor a revoked device", async () => {
    const stranger = new Tablet();
    const none = await refusal(stranger.call("device.heartbeat"));
    expect(none.details).toMatchObject({ rule: "device_not_enrolled" });
    stranger.credential = "a".repeat(43);
    expect((await refusal(stranger.call(`x.${PACK}.now`))).details).toMatchObject({
      rule: "device_not_enrolled",
    });
    const { tablet, deviceId } = await enrolled("role", CHECKIN);
    await tablet.call("device.heartbeat");
    await invoke("device.revoke", { deviceId }, context(admin, { desk: DESK }));
    expect((await refusal(tablet.call("device.heartbeat"))).details).toMatchObject({
      rule: "device_not_enrolled",
    });
  });

  it("not a device call made anywhere but the desk origin's handler", async () => {
    const { tablet } = await enrolled("role", CHECKIN);
    const { desk: _desk, ...noRequest } = tablet.deviceCtx();
    expect((await refusal(invokeByName("device.heartbeat", {}, noRequest))).code).toBe(
      "unknown_operation",
    );
    // Nor from inside a tool's run.
    expect(
      (
        await refusal(
          invokeByName(
            "device.heartbeat",
            {},
            {
              ...tablet.deviceCtx(),
              tool: { extension: PACK, tool: "now" },
            },
          ),
        )
      ).code,
    ).toBe("unknown_operation");
  });

  it("not staff, an AI, an automation, a customer or the public", async () => {
    for (const name of ["device.heartbeat", `x.${PACK}.now`]) {
      for (const actor of ["human", "assistant", "mcp", "automation"] as const) {
        const refused = await refusal(invokeByName(name, {}, context(admin, { actor })));
        expect([name, actor, refused.code]).toEqual([name, actor, "unknown_operation"]);
      }
      expect((await refusal(invokeByName(name, {}, context(member)))).code).toBe(
        "unknown_operation",
      );
      // The public, even with a device's credential on the desk origin.
      const { tablet } = await enrolled("role", CHECKIN);
      expect((await refusal(invokeByName(name, {}, tablet.publicCtx()))).code).toBe(
        "unknown_operation",
      );
    }
    // Staff surfaces (MCP, the assistant) list none of them.
    const listed = (await listOperations(db.query)).map((op) => op.name);
    expect(listed).not.toContain("device.heartbeat");
    expect(listed).not.toContain(`x.${PACK}.now`);
    expect(listed).toContain(`x.${PACK}.list`);
  });

  it("a staff account's pack role or grants never reach a device's tool", async () => {
    const op = toolOperation(MANIFEST, "now", MANIFEST.tools.now as never, "shipped");
    expect(op.audiences).toEqual(["device"]);
    expect(op.packPermissions).toEqual([`${PACK}:checkin`]);
  });
});

describe("only a shipped pack declares a device role (criterion 15)", () => {
  it("check and install refuse a runtime extension's; its tools are staff's at run time", async () => {
    const now = new Date().toISOString();
    const id = extId("dvrun");
    const copy = { ...MANIFEST, id } as typeof MANIFEST;
    copy.tools = Object.fromEntries(
      Object.entries(MANIFEST.tools).map(([name, t]) => [
        name,
        { ...t, ...(t.permission ? { permission: String(t.permission).replace(PACK, id) } : {}) },
      ]),
    ) as typeof MANIFEST.tools;
    copy.deviceRoles = {
      checkin: {
        ...(MANIFEST.deviceRoles?.checkin as NonNullable<typeof MANIFEST.deviceRoles>["checkin"]),
        permissions: [`${id}:checkin`],
        screen: { block: `${id}-tablet`, export: "Tablet" },
      },
      stock: {
        ...(MANIFEST.deviceRoles?.stock as NonNullable<typeof MANIFEST.deviceRoles>["stock"]),
        permissions: [`${id}:stock`],
        screen: { block: `${id}-stock`, export: "Stock" },
      },
    };
    const runtime = await checkManifest(db.query, id, copy, now, { source: "runtime" });
    expect(runtime.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "outside_audience", path: "deviceRoles.checkin" }),
        expect.objectContaining({ code: "outside_audience", path: "tools.now.audiences" }),
      ]),
    );
    const shipped = await checkManifest(db.query, id, copy, now, { source: "shipped" });
    expect(shipped.issues.filter((i) => i.path.startsWith("deviceRoles"))).toEqual([]);
    // In the database anyway, a runtime extension's tool is for staff and holds no permission.
    const op = toolOperation(copy, "now", copy.tools.now as never, "runtime");
    expect(op.audiences).toBeUndefined();
    expect(op.packPermissions).toBeUndefined();
  });
});
