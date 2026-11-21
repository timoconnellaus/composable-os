// Staff invites (ADR 0455): a human admin invites a person by address, with the role, pack role
// and grants the account will hold from the start. Inviting, changing and revoking are admins
// only, humans only, not on MCP, and audited (object `user_invite`). Accepting is not an
// operation: it is signing in with a code emailed to the address (packages/auth), or the first
// request under Cloudflare Access (resolveActingUser).
import type { CoreDatabase, CoreUserInviteTable } from "@composable-os/db";
import type { Kysely, Selectable } from "kysely";
import { z } from "zod";
import { assertUserCapacity } from "../entitlements.ts";
import { ConflictError, NotFoundError, ValidationError } from "../errors.ts";
import { newId } from "../ids.ts";
import { INVITE_TTL_DAYS, normaliseStaffEmail } from "../invites.ts";
import { defineOperation, type HandlerContext } from "../operation.ts";
import { parseGrants } from "../pack-roles.ts";
import { ROLES } from "../principals.ts";
import { checkGrants, checkPackRole } from "./user.ts";

const inviteSchema = z.object({
  id: z.string(),
  email: z.string(),
  role: z.enum(ROLES),
  /** The pack role the account will hold (ADR 0436); its role is then viewer. */
  packRole: z.string().nullable(),
  /** Permissions granted one by one (ADR 0449). */
  permissions: z.array(z.string()),
  invitedBy: z.string(),
  createdAt: z.string(),
  expiresAt: z.string(),
  /** `expired` invites can no longer be accepted; invite again to renew. */
  status: z.enum(["pending", "expired"]),
});

type InviteRow = Selectable<CoreUserInviteTable>;

const toInvite = (row: InviteRow, now: string): z.infer<typeof inviteSchema> => ({
  id: row.id,
  email: row.email,
  role: row.role,
  packRole: row.pack_role,
  permissions: parseGrants(row.granted_permissions),
  invitedBy: row.invited_by,
  createdAt: row.created_at,
  expiresAt: row.expires_at,
  status: row.expires_at > now ? "pending" : "expired",
});

const accessInput = {
  role: z.enum(ROLES).default("member").describe("The account's role: admin, member or viewer"),
  packRole: z
    .string()
    .max(80)
    .nullable()
    .default(null)
    .describe("A pack's fixed role (`ticketing.door`), or null. Makes the role viewer."),
  permissions: z
    .array(z.string().min(1).max(80))
    .max(20)
    .default([])
    .describe("Permissions granted one by one (user.grantablePermissions lists them)"),
};

/** What an invite will give, checked as user.setPackRole and user.setPermissions check it. */
async function checkAccess(
  ctx: HandlerContext,
  input: { role: (typeof ROLES)[number]; packRole: string | null; permissions: string[] },
) {
  if (input.packRole !== null) await checkPackRole(ctx, input.packRole, input.role, "packRole");
  const permissions = await checkGrants(ctx, input.permissions, "permissions");
  return {
    role: input.packRole !== null ? ("viewer" as const) : input.role,
    pack_role: input.packRole,
    granted_permissions: permissions.length ? JSON.stringify(permissions) : null,
  };
}

async function pendingInvite(db: Kysely<CoreDatabase>, id: string) {
  const row = await db
    .selectFrom("core_user_invite")
    .selectAll()
    .where("id", "=", id)
    .where("accepted_at", "is", null)
    .where("revoked_at", "is", null)
    .executeTakeFirst();
  if (!row) throw new NotFoundError("user_invite", id);
  return row;
}

const audited = (row: Pick<InviteRow, "email" | "role" | "pack_role" | "granted_permissions">) => ({
  email: row.email,
  role: row.role,
  packRole: row.pack_role,
  permissions: parseGrants(row.granted_permissions),
});

export const userInvites = defineOperation({
  name: "user.invites",
  description:
    "List the invites for staff accounts that have not been accepted or revoked, with the role, " +
    "pack role and permissions each will give, and whether it has expired. Admins only. Read-only.",
  input: z.object({}),
  output: z.object({ items: z.array(inviteSchema) }),
  permission: "users:manage",
  risk: "read",
  actors: ["human"],
  mcp: { expose: false },
  async handler(_input, ctx) {
    const rows = await ctx.db
      .selectFrom("core_user_invite")
      .selectAll()
      .where("accepted_at", "is", null)
      .where("revoked_at", "is", null)
      .orderBy("created_at", "desc")
      .limit(200)
      .execute();
    return { items: rows.map((row) => toInvite(row, ctx.now)) };
  },
});

export const userInvite = defineOperation({
  name: "user.invite",
  description:
    "Invite a person to a staff account by email, with the role, and optionally the pack role " +
    "and permissions, the account will hold from the start. With the built-in sign-in they accept " +
    "by signing in with a code emailed to that address; under Cloudflare Access, by their first " +
    "visit once Access lets them in. Sign-up stays closed to everyone else. An address with an " +
    "account cannot be invited; inviting an address again replaces its pending invite. Expires " +
    "in 7 days. Admins only, and only a human can call it.",
  input: z.object({
    email: z.string().min(3).max(254).describe("Their email address"),
    ...accessInput,
  }),
  output: inviteSchema.extend({
    /** How they get in: an emailed code (`code`) or Cloudflare Access (`access`). */
    signIn: z.enum(["code", "access"]),
    /** Whether the invite notice was emailed, waits for review (it holds no secret), or not. */
    invitationEmail: z.enum(["sent", "pending", "not_sent", "not_needed"]),
  }),
  permission: "users:manage",
  risk: "write",
  actors: ["human"],
  mcp: { expose: false },
  async handler(input, ctx) {
    const email = normaliseStaffEmail(input.email);
    if (!email) throw new ValidationError("Not an email address", { field: "email" });
    const account = await ctx.db
      .selectFrom("core_user")
      .select("id")
      .where((eb) => eb(eb.fn("lower", ["email"]), "=", email))
      .executeTakeFirst();
    if (account) {
      // An invite never applies to an account that exists (ADR 0455): change that account instead.
      throw new ConflictError("This address already has an account. Change its role instead.", {
        field: "email",
        userId: account.id,
      });
    }
    const access = await checkAccess(ctx, input);
    await assertUserCapacity(ctx.db, 1);
    const previous = await ctx.db
      .selectFrom("core_user_invite")
      .selectAll()
      .where("email", "=", email)
      .where("accepted_at", "is", null)
      .where("revoked_at", "is", null)
      .executeTakeFirst();
    const id = newId("userInvite");
    const expiresAt = new Date(Date.parse(ctx.now) + INVITE_TTL_DAYS * 86_400_000).toISOString();
    const row: InviteRow = {
      id,
      email,
      ...access,
      invited_by: ctx.user.id,
      created_at: ctx.now,
      updated_at: ctx.now,
      expires_at: expiresAt,
      accepted_at: null,
      accepted_user_id: null,
      revoked_at: null,
      revoked_by: null,
    };
    if (previous) {
      // One pending invite per address: the new one replaces it.
      ctx.write(
        ctx.db
          .updateTable("core_user_invite")
          .set({ revoked_at: ctx.now, revoked_by: ctx.user.id, updated_at: ctx.now })
          .where("id", "=", previous.id),
      );
      ctx.recordChange({
        object: "user_invite",
        id: previous.id,
        action: "delete",
        before: audited(previous),
      });
    }
    ctx.write(ctx.db.insertInto("core_user_invite").values(row));
    ctx.recordChange({ object: "user_invite", id, action: "create", after: audited(row) });
    const signIn = ctx.hostMail?.staffSignIn ?? "code";
    const hostMail = ctx.hostMail;
    const invitedBy = ctx.user.name || ctx.user.email;
    return ctx.afterCommit(async () => ({
      ...toInvite(row, ctx.now),
      signIn,
      // Under Access there is nothing to sign in to here: Access lets them in.
      invitationEmail:
        signIn === "access"
          ? ("not_needed" as const)
          : hostMail
            ? await hostMail.sendStaffInvite({ to: email, invitedBy })
            : ("not_sent" as const),
    }));
  },
});

export const userUpdateInvite = defineOperation({
  name: "user.updateInvite",
  description:
    "Change what a pending staff invite will give: its role, pack role and permissions (checked " +
    "as user.setPackRole and user.setPermissions check them). Admins only, and only a human can " +
    "call it. Returns the invite.",
  input: z.object({ id: z.string().min(1).max(64).describe("Invite id (uin_…)"), ...accessInput }),
  output: inviteSchema,
  permission: "users:manage",
  risk: "write",
  actors: ["human"],
  mcp: { expose: false },
  async handler(input, ctx) {
    const before = await pendingInvite(ctx.db, input.id);
    const access = await checkAccess(ctx, input);
    ctx.write(
      ctx.db
        .updateTable("core_user_invite")
        .set({ ...access, updated_at: ctx.now })
        .where("id", "=", before.id)
        .where("accepted_at", "is", null)
        .where("revoked_at", "is", null),
    );
    const after = { ...before, ...access, updated_at: ctx.now };
    ctx.recordChange({
      object: "user_invite",
      id: before.id,
      action: "update",
      before: audited(before),
      after: audited(after),
    });
    return toInvite(after, ctx.now);
  },
});

export const userRevokeInvite = defineOperation({
  name: "user.revokeInvite",
  description:
    "Revoke a pending staff invite: its address can no longer get a sign-in code or an account " +
    "from it. Admins only, and only a human can call it.",
  input: z.object({ id: z.string().min(1).max(64).describe("Invite id (uin_…)") }),
  output: z.object({ id: z.string(), revokedAt: z.string() }),
  permission: "users:manage",
  risk: "write",
  actors: ["human"],
  mcp: { expose: false },
  async handler(input, ctx) {
    const before = await pendingInvite(ctx.db, input.id);
    ctx.write(
      ctx.db
        .updateTable("core_user_invite")
        .set({ revoked_at: ctx.now, revoked_by: ctx.user.id, updated_at: ctx.now })
        .where("id", "=", before.id),
    );
    ctx.recordChange({
      object: "user_invite",
      id: before.id,
      action: "delete",
      before: audited(before),
    });
    return { id: before.id, revokedAt: ctx.now };
  },
});

export const inviteOperations = [
  userInvites,
  userInvite,
  userUpdateInvite,
  userRevokeInvite,
] as const;
