// deviceSession.* operations (stage 23, ADR 0419): a staff member's native-app sessions, listed
// and ended by device name, and how long any device session may go unused. A customer's are in
// me.sessions.*. Changing the period is admins only and humans only, like the other identity
// settings: no assistant, MCP client, automation or extension may lengthen how long a lost phone
// stays signed in.
import { z } from "zod";
import { NotFoundError } from "../errors.ts";
import {
  DEVICE_SESSION_IDLE_SETTING,
  deviceSessionIdleDaysSchema,
  loadDeviceSessionIdleDays,
} from "../http/tokens.ts";
import { defineOperation } from "../operation.ts";

const deviceSession = z.object({
  id: z.string(),
  deviceName: z.string(),
  createdAt: z.string(),
  lastUsedAt: z.string(),
  /** The session this call was made with. */
  current: z.boolean(),
});

export const deviceSessionList = defineOperation({
  name: "deviceSession.list",
  description:
    "Your own signed-in apps on phones and other devices (the HTTP surface's sessions): each " +
    "one's device name, when it began and when it was last used, and which is this one. " +
    "Browser sign-ins are not listed. Read-only.",
  input: z.object({}),
  output: z.object({ items: z.array(deviceSession) }),
  permission: "records:read",
  risk: "read",
  mcp: { expose: false },
  async handler(_input, ctx) {
    const rows = await ctx.db
      .selectFrom("core_device_session")
      .select(["id", "device_name", "created_at", "last_used_at"])
      .where("user_id", "=", ctx.user.id)
      .orderBy("created_at", "desc")
      .execute();
    return {
      items: rows.map((row) => ({
        id: row.id,
        deviceName: row.device_name,
        createdAt: row.created_at,
        lastUsedAt: row.last_used_at,
        current: row.id === ctx.origin.sessionId,
      })),
    };
  },
});

export const deviceSessionRevoke = defineOperation({
  name: "deviceSession.revoke",
  description:
    "Sign out one of your own apps on a device, by its id from deviceSession.list: its tokens " +
    "stop working at once. Another person's session is not found. Humans only.",
  input: z.object({ id: z.string().min(1).max(64).describe("Session id (dvs_…)") }),
  output: z.object({ id: z.string(), revoked: z.literal(true) }),
  permission: "records:read",
  risk: "write",
  actors: ["human"],
  mcp: { expose: false },
  async handler(input, ctx) {
    const row = await ctx.db
      .selectFrom("core_device_session")
      .select("device_name")
      .where("id", "=", input.id)
      .where("user_id", "=", ctx.user.id)
      .executeTakeFirst();
    if (!row) throw new NotFoundError("session", input.id);
    ctx.write(
      ctx.db
        .deleteFrom("core_device_session")
        .where("id", "=", input.id)
        .where("user_id", "=", ctx.user.id),
    );
    ctx.recordChange({
      object: "device_session",
      id: input.id,
      action: "delete",
      before: { deviceName: row.device_name },
    });
    return { id: input.id, revoked: true as const };
  },
});

const idleDays = deviceSessionIdleDaysSchema.describe(
  "Days a phone or other device may stay signed in without being used (default 90). Then it " +
    "must sign in again. Applies to staff and customer apps alike.",
);

export const deviceSessionSettingsGet = defineOperation({
  name: "deviceSession.settings.get",
  description:
    "How many days a signed-in app on a phone or other device may go unused before it must " +
    "sign in again. Read-only.",
  input: z.object({}),
  output: z.object({ idleDays }),
  permission: "records:read",
  risk: "read",
  mcp: { idempotent: true },
  async handler(_input, ctx) {
    return { idleDays: await loadDeviceSessionIdleDays(ctx.db) };
  },
});

export const deviceSessionSettingsUpdate = defineOperation({
  name: "deviceSession.settings.update",
  description:
    "Change how many days a signed-in app on a phone or other device may go unused before it " +
    "must sign in again. Admins only, and only a human can call it: AI assistants, MCP clients, " +
    "automations and extensions are refused.",
  input: z.object({ idleDays }),
  output: z.object({ idleDays, previous: z.object({ idleDays }) }),
  permission: "settings:manage",
  risk: "write",
  actors: ["human"],
  mcp: { expose: false },
  async handler(input, ctx) {
    const previous = { idleDays: await loadDeviceSessionIdleDays(ctx.db) };
    const value = JSON.stringify(input.idleDays);
    ctx.write(
      ctx.db
        .insertInto("core_settings")
        .values({
          key: DEVICE_SESSION_IDLE_SETTING,
          value,
          updated_at: ctx.now,
          updated_by: ctx.user.id,
        })
        .onConflict((oc) =>
          oc.column("key").doUpdateSet({ value, updated_at: ctx.now, updated_by: ctx.user.id }),
        ),
    );
    ctx.recordChange({
      object: "settings",
      id: DEVICE_SESSION_IDLE_SETTING,
      action: "update",
      before: previous,
      after: { idleDays: input.idleDays },
    });
    return { idleDays: input.idleDays, previous };
  },
});

export const deviceSessionOperations = [
  deviceSessionList,
  deviceSessionRevoke,
  deviceSessionSettingsGet,
  deviceSessionSettingsUpdate,
] as const;
