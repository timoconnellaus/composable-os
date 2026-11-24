// Stage 51 step 2 (ADR 0781): a pack's tool called by an enrolled device holding a device role.
// The tool learns who started it (`ctx.caller` is `{ kind: "device", deviceId, name }`), and its
// own operation calls run as the extension, as a staff caller's do, never as the device: what it
// writes is the extension's, and no account is "me" in it. Real D1, the real workspace and the
// real sandbox; the device enrolled and claimed through the host's own operations.
import { env } from "cloudflare:workers";
import {
  type ActingUser,
  type DeskHost,
  type DeviceInvocationContext,
  invokeByName,
} from "@composable-os/core";
import { beforeAll, describe, expect, it } from "vitest";
import { context, createAdmin, db, host, install, source, unique } from "./helpers.ts";

const DESK: DeskHost = {
  secret: "fixture-desk-secret-fixture-desk-secret",
  origin: "https://desk.crm.example.test",
};
const id = unique("door");
const VISIT = `${id}.visit`;

let admin: ActingUser;
let credential: string | null = null;
let deviceId: string;
const NAME = "Fixture front door tablet";

const request = (pending: { credential?: string }) => ({
  credential,
  token: null,
  userAgent: "Fixture tablet browser",
  address: "192.0.2.30",
  issue: (cookies: { credential?: string }) => Object.assign(pending, cookies),
});

/** As the desk origin's handler calls a device's operation. */
async function asDevice(name: string, input: unknown = {}): Promise<unknown> {
  const pending: { credential?: string } = {};
  const ctx: DeviceInvocationContext = {
    principal: { kind: "device" },
    db,
    extensionHost: host,
    desk: { ...DESK, request: request(pending) },
  };
  const value = await invokeByName(name, input, ctx);
  if (pending.credential !== undefined) credential = pending.credential;
  return value;
}

/** A runtime install made into what a shipped pack declaring a device role would be. */
async function ship(): Promise<void> {
  const row = await env.DB.prepare("SELECT manifest FROM core_extensions WHERE id = ?")
    .bind(id)
    .first<{ manifest: string }>();
  const manifest = JSON.parse(row?.manifest ?? "{}");
  for (const name of ["who", "log"]) {
    manifest.tools[name].audiences = ["device"];
    manifest.tools[name].permission = `${id}:checkin`;
  }
  manifest.deviceRoles = {
    checkin: {
      label: "Check-in tablet",
      description: "Fixture: checks people in at the door. Nothing else.",
      permissions: [`${id}:checkin`],
      screen: { block: `${id}-tablet`, export: "Tablet" },
    },
  };
  await env.DB.prepare("UPDATE core_extensions SET source = 'shipped', manifest = ? WHERE id = ?")
    .bind(JSON.stringify(manifest), id)
    .run();
}

beforeAll(async () => {
  admin = await createAdmin();
  await install(
    admin,
    id,
    source(
      id,
      `permissions: { modules: ["ops"] },
  objects: {
    visit: {
      label: "Visit", plural: "Visits", titleField: "title",
      fields: {
        title: { type: "text", label: "Title", required: true },
        by: { type: "text", label: "Ticked by" },
      },
    },
  },
  tools: {
    who: defineTool({
      description: "A test tool that answers who started it.",
      input: z.object({}),
      output: z.unknown(),
      risk: "read",
      handler: async (_input, ctx) => ({ caller: ctx.caller ?? null }),
    }),
    log: defineTool({
      description: "A test tool that records a visit, as the door would.",
      input: z.object({}),
      output: z.unknown(),
      handler: async (_input, ctx) => {
        const by = ctx.caller?.kind === "device" ? ctx.caller.name : "?";
        return ctx.ops.call("record.create", { object: "${VISIT}", values: { title: "Came", by } });
      },
    }),
  },`,
    ),
  );
  await ship();
  const made = (await invokeByName(
    "device.enrol",
    { name: NAME, use: "role", role: `${id}.checkin` },
    context(admin, { desk: DESK }),
  )) as { code: string; device: { id: string } };
  deviceId = made.device.id;
  const pending: { credential?: string } = {};
  await invokeByName(
    "device.claim",
    { code: made.code },
    { principal: { kind: "public" }, db, desk: { ...DESK, request: request(pending) } },
  );
  credential = pending.credential ?? null;
}, 120_000);

describe("a pack's tool called by an enrolled device (ADR 0781)", () => {
  it("knows the device that started it", async () => {
    expect(await asDevice(`x.${id}.who`)).toEqual({
      caller: { kind: "device", deviceId, name: NAME },
    });
  });

  it("writes as the extension, recording the device as who ticked it", async () => {
    const made = (await asDevice(`x.${id}.log`)) as { id: string };
    const row = await env.DB.prepare(`SELECT title, by FROM x_${id}_visit WHERE id = ?`)
      .bind(made.id)
      .first<{ title: string; by: string }>();
    expect(row).toEqual({ title: "Came", by: NAME });
    // The tool's call is the device's; the record.create inside it is the extension's.
    const audits = await env.DB.prepare(
      `SELECT operation, actor FROM core_audit WHERE operation IN (?, 'record.create')
       AND at >= datetime('now', '-5 minutes') AND (user_id = ? OR origin LIKE ?) ORDER BY at`,
    )
      .bind(`x.${id}.log`, deviceId, `%${id}%`)
      .all<{ operation: string; actor: string }>();
    expect(audits.results).toEqual(
      expect.arrayContaining([
        { operation: `x.${id}.log`, actor: "device" },
        { operation: "record.create", actor: "extension" },
      ]),
    );
  });

  it("is not a staff caller's tool", async () => {
    const refused = await invokeByName(`x.${id}.who`, {}, context(admin)).catch((e) => e);
    expect((refused as { code?: string }).code).toBe("unknown_operation");
  });
});
