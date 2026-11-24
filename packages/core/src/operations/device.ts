// Enrolled devices (stage 51 step 1, built with stage 44 step 6; ADR 0780): the business's own
// tablets, each enrolled by a human admin for one use.
//
//   device.enrol    an admin, a person: names the device and its use; answers the enrolment code
//   device.setUse   an admin, a person: changes what an enrolled device is for
//   device.revoke   an admin, a person: revokes it at once (its signing session ends with it)
//   device.list     admins: every device, with who enrolled it, when it was last seen, its flags
//   device.claim    the desk origin only: the tablet types the enrolment code at /enrol
//   desk.status     the desk origin only: whether this browser is an enrolled device, and its name
//
// Enrolling, changing and revoking are identity: a person's acts (`actors: ["human"]`), with
// users:manage, which no grant gives. Every admin is told of each, in the host. Nothing here is
// for an AI.
import { z } from "zod";
import {
  adminNotice,
  DEVICE_LIST_LIMIT,
  DEVICE_USES,
  type DeviceUse,
  deskRequestOf,
  deviceRoleDeclared,
  ENROL_MS,
  GRACE_MS,
  noticeTime,
  parseFlags,
  revokeStatements,
  userNamesOf,
  useWords,
} from "../devices/devices.ts";
import {
  ENROL_CODE_LENGTH,
  normaliseCode,
  randomCode,
  randomSecret,
  secretHash,
} from "../devices/secret.ts";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../errors.ts";
import { newId } from "../ids.ts";
import { defineOperation, type HandlerContext } from "../operation.ts";

const id = (what: string) => z.string().min(1).max(64).describe(what);
const name = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .describe('What the device is called ("Front desk iPad")');
const use = z
  .enum(DEVICE_USES)
  .describe(
    "signing: desk signing (stage 44). role: a device role a pack declares (role names it). till: a till (not yet).",
  );
const role = z
  .string()
  .max(80)
  .optional()
  .describe("For use role: the device role, <pack>.<role>, an installed pack declares");

const STATES = ["waiting", "unclaimed", "active", "revoked"] as const;

const deviceOut = z.object({
  id: z.string(),
  name: z.string(),
  use: z.enum(DEVICE_USES),
  role: z.string().nullable(),
  state: z
    .enum(STATES)
    .describe(
      "waiting: its enrolment code is not used yet; unclaimed: the code ran out; active; revoked",
    ),
  enrolledBy: z.object({ id: z.string(), name: z.string() }),
  enrolledAt: z.string(),
  claimedAt: z.string().nullable(),
  lastSeenAt: z.string().nullable(),
  browser: z
    .string()
    .nullable()
    .describe("The browser it last said it was (at the claim or a rotation)"),
  network: z.string().nullable().describe("The network address it last came from"),
  flags: z.array(z.object({ kind: z.enum(["browser", "network"]), at: z.string() })),
  lockedUntil: z.string().nullable().describe("Wrong desk codes locked it until then"),
  revokedAt: z.string().nullable(),
  revokedBy: z.string().nullable().describe("Who revoked it; null for a clone or a lapse"),
  revokeReason: z.enum(["admin", "clone", "lapsed"]).nullable(),
});
type DeviceOut = z.infer<typeof deviceOut>;

type Row = {
  id: string;
  name: string;
  use: DeviceUse;
  role: string | null;
  enrolled_by: string;
  enrolled_at: string;
  enrol_expires_at: string;
  claimed_at: string | null;
  last_seen_at: string | null;
  last_user_agent: string | null;
  last_address: string | null;
  flags: string;
  locked_until: string | null;
  revoked_at: string | null;
  revoked_by: string | null;
  revoke_reason: "admin" | "clone" | "lapsed" | null;
};

function toDevice(row: Row, names: Map<string, string>, now: string): DeviceOut {
  const state: DeviceOut["state"] = row.revoked_at
    ? "revoked"
    : row.claimed_at
      ? "active"
      : Date.parse(row.enrol_expires_at) > Date.parse(now)
        ? "waiting"
        : "unclaimed";
  return {
    id: row.id,
    name: row.name,
    use: row.use,
    role: row.role,
    state,
    enrolledBy: { id: row.enrolled_by, name: names.get(row.enrolled_by) ?? "An admin" },
    enrolledAt: row.enrolled_at,
    claimedAt: row.claimed_at,
    lastSeenAt: row.last_seen_at,
    browser: row.last_user_agent,
    network: row.last_address,
    flags: parseFlags(row.flags),
    lockedUntil:
      row.locked_until && Date.parse(row.locked_until) > Date.parse(now) ? row.locked_until : null,
    revokedAt: row.revoked_at,
    revokedBy: row.revoked_by ? (names.get(row.revoked_by) ?? "An admin") : null,
    revokeReason: row.revoke_reason,
  };
}

async function deviceOf(ctx: HandlerContext, deviceId: string): Promise<DeviceOut> {
  const row = await ctx.db
    .selectFrom("core_device")
    .selectAll()
    .where("id", "=", deviceId)
    .executeTakeFirst();
  if (!row) throw new NotFoundError("device", deviceId);
  const names = await userNamesOf(ctx.db, [row.enrolled_by, row.revoked_by]);
  return toDevice(row, names, ctx.now);
}

/** The desk's secret and origin, or why this deployment has no enrolled devices. */
function deskOf(ctx: HandlerContext): { secret: string; origin: string } {
  if (!ctx.desk?.secret) {
    throw new ConflictError(
      "Enrolled devices need the DESK_SECRET secret on this deployment (docs/deploying.md).",
      { rule: "desk_not_configured" },
    );
  }
  if (!ctx.desk.origin) {
    throw new ConflictError(
      "This deployment has no desk hostname (desk. before the host's name), so no device can be enrolled for the desk. A custom domain adds it.",
      { rule: "desk_not_configured" },
    );
  }
  return { secret: ctx.desk.secret, origin: ctx.desk.origin };
}

/** The use and role an admin asked for, checked: a declared role for `role`; no till yet. */
async function checkUse(
  ctx: HandlerContext,
  wanted: DeviceUse,
  roleName: string | undefined,
): Promise<string | null> {
  if (wanted === "till") {
    throw new ValidationError(
      "A till is enrolled with the Till (stage 50), which is not built yet.",
      {
        rule: "device_use",
        field: "use",
      },
    );
  }
  if (wanted === "role") {
    if (!roleName || !(await deviceRoleDeclared(ctx.db, roleName))) {
      throw new ValidationError(
        `No installed pack declares the device role ${roleName ?? "(none given)"}.`,
        { rule: "device_role", field: "role" },
      );
    }
    return roleName;
  }
  if (roleName) {
    throw new ValidationError("Only a device of use role holds a role.", {
      rule: "device_role",
      field: "role",
    });
  }
  return null;
}

const person = (ctx: HandlerContext, act: string) => {
  if (ctx.actor !== "human") throw new ForbiddenError(`Only a person ${act} a device`);
};

export const deviceEnrol = defineOperation({
  name: "device.enrol",
  description:
    "Enrol a tablet or other browser as the business's own device, for one use: desk signing " +
    "(stage 44), a device role a pack declares, or a till. Answers a single-use enrolment code, " +
    "good for 10 minutes, to type at the desk origin's /enrol on the device. Every admin is told. " +
    "An admin who is a person only; no grant gives it.",
  input: z.object({ name, use, role }).strict(),
  output: z.object({
    device: deviceOut,
    code: z.string().describe("The enrolment code: shown once, never stored in the clear"),
    expiresAt: z.string(),
    enrolUrl: z.string().describe("Where to type it, on the device"),
  }),
  permission: "users:manage",
  risk: "write",
  actors: ["human"],
  mcp: { expose: false },
  redactResult: ["code"],
  auditSummary: (output) => ({ deviceId: output.device.id, use: output.device.use }),
  async handler(input, ctx) {
    person(ctx, "enrols");
    const desk = deskOf(ctx);
    const roleName = await checkUse(ctx, input.use, input.role);
    const code = randomCode(ENROL_CODE_LENGTH);
    const deviceId = newId("device");
    const expiresAt = new Date(Date.parse(ctx.now) + ENROL_MS).toISOString();
    ctx.write(
      ctx.db.insertInto("core_device").values({
        id: deviceId,
        name: input.name,
        use: input.use,
        role: roleName,
        enrolled_by: ctx.user.id,
        enrolled_at: ctx.now,
        enrol_code_hash: await secretHash(desk.secret, "enrol", code),
        enrol_expires_at: expiresAt,
      }),
      ...(await adminNotice(ctx.db, ctx.now, {
        title: `${ctx.user.name} enrolled a device, ${input.name}, for ${useWords(input.use, roleName)}, at ${noticeTime(ctx.now)}`,
        body:
          "Every admin is told when a device is enrolled as the business's own. If you did not " +
          "expect it, revoke it in Settings, Devices.",
      })),
    );
    const device: DeviceOut = {
      id: deviceId,
      name: input.name,
      use: input.use,
      role: roleName,
      state: "waiting",
      enrolledBy: { id: ctx.user.id, name: ctx.user.name },
      enrolledAt: ctx.now,
      claimedAt: null,
      lastSeenAt: null,
      browser: null,
      network: null,
      flags: [],
      lockedUntil: null,
      revokedAt: null,
      revokedBy: null,
      revokeReason: null,
    };
    return { device, code, expiresAt, enrolUrl: `${desk.origin}/enrol` };
  },
});

export const deviceSetUse = defineOperation({
  name: "device.setUse",
  description:
    "Change what an enrolled device is for: desk signing, a device role, or a till. A signing " +
    "session open on it ends in the same change. Every admin is told. An admin who is a person " +
    "only.",
  input: z.object({ deviceId: id("The device (dev_…)"), use, role }).strict(),
  output: z.object({
    device: deviceOut,
    previous: z.object({ use: z.enum(DEVICE_USES), role: z.string().nullable() }),
  }),
  permission: "users:manage",
  risk: "write",
  actors: ["human"],
  mcp: { expose: false },
  auditSummary: (output) => ({
    deviceId: output.device.id,
    before: output.previous,
    after: { use: output.device.use, role: output.device.role },
  }),
  async handler(input, ctx) {
    person(ctx, "changes");
    const before = await deviceOf(ctx, input.deviceId);
    if (before.state === "revoked") {
      throw new ConflictError("This device was revoked: enrol it again.", {
        rule: "device_revoked",
      });
    }
    const roleName = await checkUse(ctx, input.use, input.role);
    const previous = { use: before.use, role: before.role };
    if (before.use === input.use && before.role === roleName) return { device: before, previous };
    ctx.write(
      // Its open signing session ends in the same statement (migration 1130's trigger).
      ctx.db
        .updateTable("core_device")
        .set({ use: input.use, role: roleName })
        .where("id", "=", input.deviceId)
        .where("revoked_at", "is", null),
      ...(await adminNotice(ctx.db, ctx.now, {
        title: `${ctx.user.name} changed the device ${before.name} from ${useWords(before.use, before.role)} to ${useWords(input.use, roleName)}, at ${noticeTime(ctx.now)}`,
        body: "Every admin is told when a device's use changes. Settings, Devices lists them.",
      })),
    );
    return { device: { ...before, use: input.use, role: roleName }, previous };
  },
});

export const deviceRevoke = defineOperation({
  name: "device.revoke",
  description:
    "Revoke an enrolled device at once: its credential opens nothing again, and a signing session " +
    "open on it ends in the same change. For a lost or stolen tablet, or one no longer used. " +
    "Every admin is told. An admin who is a person only.",
  input: z.object({ deviceId: id("The device (dev_…)") }).strict(),
  output: z.object({ device: deviceOut }),
  permission: "users:manage",
  risk: "destructive",
  actors: ["human"],
  mcp: { expose: false },
  auditSummary: (output) => ({ deviceId: output.device.id }),
  async handler(input, ctx) {
    person(ctx, "revokes");
    const before = await deviceOf(ctx, input.deviceId);
    if (before.state === "revoked") return { device: before };
    ctx.write(
      ...revokeStatements(ctx.db, input.deviceId, "admin", ctx.user.id, ctx.now),
      ...(await adminNotice(ctx.db, ctx.now, {
        title: `${ctx.user.name} revoked the device ${before.name}, at ${noticeTime(ctx.now)}`,
        body: "Its credential opens nothing again, and any signing session on it ended.",
      })),
    );
    return {
      device: {
        ...before,
        state: "revoked" as const,
        revokedAt: ctx.now,
        revokedBy: ctx.user.name,
        revokeReason: "admin" as const,
      },
    };
  },
});

export const deviceList = defineOperation({
  name: "device.list",
  description:
    "Every enrolled device, of every use: its name, use, who enrolled it and when, when it was last " +
    "seen, the browser and network it last came from and the changes flagged, a lock-out from " +
    "wrong codes, and whether it was revoked (by an admin, as a copied credential, or unused for " +
    "30 days). Also where the desk is. Admins. Read-only.",
  input: z.object({}).strict(),
  output: z.object({
    deskUrl: z
      .string()
      .nullable()
      .describe("The desk origin, or null when this deployment has none"),
    configured: z
      .boolean()
      .describe("Whether devices can be enrolled here (the secret and the hostname)"),
    devices: z.array(deviceOut),
  }),
  permission: "users:manage",
  risk: "read",
  mcp: { expose: false },
  async handler(_input, ctx) {
    const rows = await ctx.db
      .selectFrom("core_device")
      .selectAll()
      .orderBy("revoked_at", "asc")
      .orderBy("enrolled_at", "desc")
      .limit(DEVICE_LIST_LIMIT)
      .execute();
    const names = await userNamesOf(
      ctx.db,
      rows.flatMap((r) => [r.enrolled_by, r.revoked_by]),
    );
    const devices = rows.map((r) => toDevice(r, names, ctx.now));
    // Active and waiting first, then the rest.
    const order = { active: 0, waiting: 1, unclaimed: 2, revoked: 3 } as const;
    devices.sort((a, b) => order[a.state] - order[b.state]);
    return {
      deskUrl: ctx.desk?.origin ?? null,
      configured: Boolean(ctx.desk?.secret && ctx.desk.origin),
      devices,
    };
  },
});

export const deviceClaim = defineOperation({
  name: "device.claim",
  description:
    "On the desk origin's /enrol: the tablet types the enrolment code an admin was given, and " +
    "becomes that enrolled device. The host sets its credential in a cookie that only the desk " +
    "origin's calls read; it is never in the answer. Refused for a code that is wrong, used or " +
    "run out.",
  input: z.object({ code: z.string().min(1).max(40) }).strict(),
  output: z.object({ name: z.string(), use: z.enum(DEVICE_USES) }),
  permission: "records:write",
  risk: "write",
  audiences: ["public"],
  hostInternal: true,
  deskOnly: true,
  mcp: { expose: false },
  redact: ["code"],
  auditSummary: (output) => ({ use: output.use }),
  async handler(input, ctx) {
    const { desk, request } = deskRequestOf(ctx.desk);
    const hash = await secretHash(desk.secret, "enrol", normaliseCode(input.code));
    const device = await ctx.db
      .selectFrom("core_device")
      .selectAll()
      .where("enrol_code_hash", "=", hash)
      .executeTakeFirst();
    if (
      !device ||
      device.revoked_at ||
      device.claimed_at ||
      Date.parse(device.enrol_expires_at) <= Date.parse(ctx.now)
    ) {
      throw new ValidationError(
        "That code is not right, or it has run out. Ask an admin for a new one.",
        { rule: "device_code" },
      );
    }
    // A signing tablet and a check-in tablet live on the desk origin; a till does not.
    if (device.use === "till") {
      throw new ValidationError("A till is not enrolled here.", { rule: "device_use" });
    }
    // A browser already enrolled stays the device it is: an admin changes its use instead.
    if (request.credential) {
      const held = await ctx.db
        .selectFrom("core_device")
        .select("name")
        .where(
          "credential_hash",
          "=",
          await secretHash(desk.secret, "credential", request.credential),
        )
        .where("revoked_at", "is", null)
        .executeTakeFirst();
      if (held) {
        throw new ConflictError(
          `This browser is already enrolled as ${held.name}. An admin changes its use, or revokes it first.`,
          { rule: "device_enrolled" },
        );
      }
    }
    const credential = randomSecret();
    const userAgent = request.userAgent ? request.userAgent.slice(0, 400) : null;
    const address = request.address ? request.address.slice(0, 64) : null;
    ctx.write(
      ctx.db
        .updateTable("core_device")
        .set({
          claimed_at: ctx.now,
          enrol_code_hash: null,
          credential_hash: await secretHash(desk.secret, "credential", credential),
          rotated_at: ctx.now,
          last_seen_at: ctx.now,
          claim_user_agent: userAgent,
          claim_address: address,
          last_user_agent: userAgent,
          last_address: address,
        })
        .where("id", "=", device.id)
        .where("enrol_code_hash", "=", hash)
        .where("claimed_at", "is", null)
        .where("revoked_at", "is", null),
    );
    request.issue({ credential });
    return { name: device.name, use: device.use };
  },
});

export const deskStatus = defineOperation({
  name: "desk.status",
  description:
    "On the desk origin: whether this browser is an enrolled device, and if so its name and use, " +
    "so the tablet shows Enter code or Enrol. Reads nothing else. Read-only.",
  input: z.object({}).strict(),
  output: z.object({
    enrolled: z.boolean(),
    name: z.string().nullable(),
    use: z.enum(DEVICE_USES).nullable(),
  }),
  permission: "records:read",
  risk: "read",
  audiences: ["public"],
  hostInternal: true,
  deskOnly: true,
  mcp: { expose: false },
  async handler(_input, ctx) {
    const { desk, request } = deskRequestOf(ctx.desk);
    const none = { enrolled: false, name: null, use: null };
    if (!request.credential || request.credential.length > 200) return none;
    const hash = await secretHash(desk.secret, "credential", request.credential);
    const row = await ctx.db
      .selectFrom("core_device")
      .select(["name", "use", "rotated_at", "credential_hash", "previous_credential_hash"])
      .where((eb) =>
        eb.or([eb("credential_hash", "=", hash), eb("previous_credential_hash", "=", hash)]),
      )
      .where("revoked_at", "is", null)
      .executeTakeFirst();
    if (!row) return none;
    // The credential rotated away counts only within its grace window (the next call says more).
    if (
      row.credential_hash !== hash &&
      Date.parse(ctx.now) - Date.parse(row.rotated_at ?? ctx.now) > GRACE_MS
    ) {
      return none;
    }
    return { enrolled: true, name: row.name, use: row.use };
  },
});

export const deviceOperations = [
  deviceEnrol,
  deviceSetUse,
  deviceRevoke,
  deviceList,
  deviceClaim,
  deskStatus,
] as const;
