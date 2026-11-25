// user.* operations: the deployment's users and their roles. Changing a role is admin-only and
// human-only (identity is not AI-configurable), and the last admin cannot be demoted.

import { toolPermissions } from "@composable-os/sdk";
import { sql } from "kysely";
import { z } from "zod";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../errors.ts";
import { defineObject } from "../fields/types.ts";
import { listInputSchema, pageQuery, pageSchema, selectFields } from "../list.ts";
import { defineOperation } from "../operation.ts";
import { availablePackRoles, PACK_ROLE_NAME_RE, parseGrants } from "../pack-roles.ts";
import {
  FIXED_ROLE_CORE_GRANTS,
  GRANTABLE_PERMISSIONS,
  holdsPermission,
  PERMISSIONS,
  RESTRICTED_CORE_PERMISSIONS,
  ROLES,
} from "../principals.ts";
import { feedRevocations } from "../staffing/feed.ts";

/** Users are not a record object (no tags, links or timeline); this only drives user.list. */
export const userObject = defineObject({
  name: "user",
  label: "User",
  source: "rec_user",
  defaultSort: { field: "name", direction: "asc" },
  fields: [
    { name: "id", label: "ID", type: "id", column: "id", filterable: true, sortable: true },
    { name: "name", label: "Name", type: "text", column: "name", filterable: true, sortable: true },
    {
      name: "email",
      label: "Email",
      type: "text",
      column: "email",
      filterable: true,
      sortable: true,
    },
    {
      name: "role",
      label: "Role",
      type: "enum",
      enumValues: ROLES,
      column: "role",
      filterable: true,
      sortable: true,
    },
    {
      name: "packRole",
      label: "Pack role",
      type: "text",
      column: "pack_role",
      filterable: true,
      sortable: true,
    },
    {
      name: "createdAt",
      label: "Created",
      type: "datetime",
      column: "created_at",
      filterable: true,
      sortable: true,
    },
  ],
});

export const userSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string(),
  role: z.enum(ROLES),
  /** A pack's fixed role (`ticketing.door`, ADR 0436): while set, it is all the user may do. */
  packRole: z.string().nullable(),
  /** Permissions a human admin granted one by one, on top of the role (ADR 0449). */
  permissions: z.array(z.string()),
  image: z.string().nullable(),
  createdAt: z.string(),
});
export type User = z.infer<typeof userSchema>;
const USER_FIELDS = Object.keys(userSchema.shape);

type UserRow = {
  id: string;
  name: string;
  email: string;
  role: (typeof ROLES)[number];
  pack_role: string | null;
  granted_permissions: string | null;
  image: string | null;
  created_at: string;
};

const toUser = (row: UserRow): User => ({
  id: row.id,
  name: row.name,
  email: row.email,
  role: row.role,
  packRole: row.pack_role,
  permissions: parseGrants(row.granted_permissions),
  image: row.image,
  createdAt: String(row.created_at),
});

export const userList = defineOperation({
  name: "user.list",
  description:
    "List the CRM's users (people who can sign in) with their role: admin, member or viewer. " +
    "Use it to find a user id for an owner or assignee. Filter with structured filter JSON " +
    "over id, name, email, role and createdAt; sort by any of them (default name). Read-only.",
  input: listInputSchema,
  output: pageSchema(userSchema.partial().required({ id: true })),
  permission: "records:read",
  risk: "read",
  mcp: { idempotent: true },
  async handler(input, ctx) {
    const page = await pageQuery(ctx.db.selectFrom("rec_user").selectAll(), userObject, input);
    return {
      items: selectFields(page.rows.map(toUser), input.fields, USER_FIELDS),
      nextCursor: page.nextCursor,
    };
  },
});

export const userUpdateRole = defineOperation({
  name: "user.updateRole",
  description:
    "Change a user's role: admin (everything, including erase, users and the approval " +
    "policy), member (read and write records) or viewer (read only). Admins only, and only a " +
    "human can call it. The last admin cannot be demoted. Returns the user.",
  input: z.object({
    id: z.string().min(1).max(64).describe("User id (usr_…)"),
    role: z.enum(ROLES),
  }),
  output: userSchema.extend({ previousRole: z.enum(ROLES) }),
  permission: "users:manage",
  risk: "write",
  actors: ["human"],
  mcp: { expose: false },
  async handler(input, ctx) {
    const before = await ctx.db
      .selectFrom("rec_user")
      .selectAll()
      .where("id", "=", input.id)
      .executeTakeFirst();
    if (!before) throw new NotFoundError("user", input.id);
    // While a pack role is held it is all the account may do, and its role stays viewer
    // (ADR 0436): the pack role is removed first.
    if (before.pack_role && input.role !== before.role) {
      throw new ConflictError(
        `This user holds the ${before.pack_role} role, which is all they may do. Remove it first ` +
          "(user.setPackRole with role null), then change their role.",
        { field: "role", packRole: before.pack_role },
      );
    }
    const demotingAdmin = before.role === "admin" && input.role !== "admin";
    if (demotingAdmin) {
      const other = await ctx.db
        .selectFrom("core_user")
        .select("id")
        .where("role", "=", "admin")
        .where("id", "<>", input.id)
        // A support user (ADR 0212) is temporary: it never counts as the remaining admin.
        .where("support_grant_id", "is", null)
        .executeTakeFirst();
      if (!other) {
        throw new ConflictError("The last admin cannot be demoted; make someone else admin first", {
          field: "role",
        });
      }
    }
    // Backstop for a concurrent demotion of the other admin: if no other admin remains when
    // the batch runs, the CASE writes a value the role CHECK rejects and nothing is applied.
    const role = demotingAdmin
      ? sql<
          (typeof ROLES)[number]
        >`CASE WHEN EXISTS (SELECT 1 FROM core_user WHERE role = 'admin' AND id <> ${input.id} AND support_grant_id IS NULL) THEN ${input.role} ELSE 'no-admin-left' END`
      : input.role;
    ctx.write(
      ctx.db.updateTable("core_user").set({ role, updated_at: ctx.now }).where("id", "=", input.id),
      // A calendar feed the new role no longer lets them have is revoked with it (ADR 0628).
      ...(await feedRevocations(ctx.db, input.id, { role: input.role })),
    );
    ctx.recordChange({
      object: "user",
      id: input.id,
      action: "update",
      before: { role: before.role },
      after: { role: input.role },
    });
    return { ...toUser({ ...before, role: input.role }), previousRole: before.role };
  },
});

export const userPackRoles = defineOperation({
  name: "user.packRoles",
  description:
    "List the fixed staff roles the installed packs declare that an admin can give to a staff " +
    "account (for example Ticketing's door role: check tickets in and read events, ticket types " +
    "and tickets, nothing else), with what each holds. Read-only.",
  input: z.object({}),
  output: z.object({
    items: z.array(
      z.object({
        name: z.string(),
        label: z.string(),
        description: z.string(),
        permissions: z.array(z.string()),
        read: z.array(z.string()),
      }),
    ),
  }),
  permission: "users:manage",
  risk: "read",
  mcp: { expose: false },
  async handler(_input, ctx) {
    const roles = await availablePackRoles(ctx.db);
    return {
      items: roles.map((role) => ({
        name: role.name,
        label: role.label,
        description: role.description,
        permissions: [...role.permissions],
        read: [...role.read],
      })),
    };
  },
});

/**
 * Refuses a pack role that is not `<pack>.<role>`, that no installed pack declares, or that would
 * go to an admin (ADR 0436). Shared by user.setPackRole and the invites (ADR 0455).
 */
export async function checkPackRole(
  ctx: Pick<Parameters<typeof userPackRoles.handler>[1], "db">,
  packRole: string,
  accountRole: (typeof ROLES)[number],
  field: string,
): Promise<void> {
  if (!PACK_ROLE_NAME_RE.test(packRole)) {
    throw new ValidationError("A pack role is named <pack>.<role>", { field });
  }
  const roles = await availablePackRoles(ctx.db);
  if (!roles.some((role) => role.name === packRole)) {
    throw new ValidationError(
      `No installed pack declares the role ${packRole}. user.packRoles lists them.`,
      { field, available: roles.map((role) => role.name) },
    );
  }
  if (accountRole === "admin") {
    throw new ConflictError(
      "An admin holds everything. Change their role to member or viewer first.",
      { field },
    );
  }
}

/**
 * Refuses permissions that cannot be granted (ADR 0449); returns the list sorted, once each. An
 * account holding a pack role (`packRole`) may be granted pack permissions only, never a core one
 * (ADR 0600): a core permission opens a core operation over every record, which is not what a
 * fixed role's account is for, and it would count for nothing beside the role. The exceptions are
 * FIXED_ROLE_CORE_GRANTS (ADR 0783): `people:cards`, for a desk account issuing members' cards.
 */
export async function checkGrants(
  ctx: Pick<Parameters<typeof userPackRoles.handler>[1], "db">,
  permissions: readonly string[],
  field: string,
  packRole: string | null = null,
): Promise<string[]> {
  const choices = await grantable(ctx);
  const available = new Set(
    choices.filter((g) => packRole === null || g.forFixedRole).map((g) => g.permission),
  );
  const unknown = permissions.filter((p) => !available.has(p));
  if (unknown.length) {
    throw new ValidationError(
      packRole === null
        ? `${unknown.join(", ")} cannot be granted. user.grantablePermissions lists what can.`
        : `${unknown.join(", ")} cannot be granted to an account with the fixed role ${packRole}: it may be granted a pack's permissions only (user.grantablePermissions, forFixedRole).`,
      { field, unknown, available: [...available] },
    );
  }
  return [...new Set(permissions)].sort();
}

export const userSetPackRole = defineOperation({
  name: "user.setPackRole",
  description:
    "Give a staff account one fixed role a pack declares (user.packRoles lists them), or take it " +
    "away with role null. While an account holds one, it may do exactly what the role lists, " +
    "and what the pack permissions granted to it open (user.setPermissions), and nothing else, " +
    "whatever its own role; its role is set to viewer. An admin cannot be given one (change their " +
    "role first), nor an account granted a core permission (take it away first). Admins only, " +
    "and only a human can call it. Returns the user.",
  input: z.object({
    id: z.string().min(1).max(64).describe("User id (usr_…)"),
    role: z
      .string()
      .max(80)
      .nullable()
      .describe("The pack role, `<pack>.<role>` (`ticketing.door`), or null to remove it"),
  }),
  output: userSchema.extend({ previousPackRole: z.string().nullable() }),
  permission: "users:manage",
  risk: "write",
  actors: ["human"],
  mcp: { expose: false },
  async handler(input, ctx) {
    const before = await ctx.db
      .selectFrom("rec_user")
      .selectAll()
      .where("id", "=", input.id)
      .executeTakeFirst();
    if (!before) throw new NotFoundError("user", input.id);
    if (input.role !== null) {
      await checkPackRole(ctx, input.role, before.role, "role");
      // Its grants must be ones a fixed role's account may hold (ADR 0600): a core grant would
      // count for nothing beside the role, so it is taken away by a person first, not silently.
      const core = parseGrants(before.granted_permissions).filter(
        (p) =>
          (GRANTABLE_PERMISSIONS as readonly string[]).includes(p) &&
          !(FIXED_ROLE_CORE_GRANTS as readonly string[]).includes(p),
      );
      if (core.length) {
        throw new ConflictError(
          `Take away ${core.join(", ")} first: an account with a fixed role may be granted a pack's permissions only.`,
          { field: "role", permissions: core },
        );
      }
    }
    const role = input.role === null ? before.role : "viewer";
    let update = ctx.db
      .updateTable("core_user")
      .set({ pack_role: input.role, role, updated_at: ctx.now })
      .where("id", "=", input.id);
    // Never an admin row: an admin cannot hold a pack role, even if promoted meanwhile.
    if (input.role !== null) update = update.where("role", "<>", "admin");
    ctx.write(
      update,
      // A calendar feed the new pack role no longer lets them have is revoked with it (ADR 0628).
      ...(await feedRevocations(ctx.db, input.id, { role, packRole: input.role })),
    );
    ctx.recordChange({
      object: "user",
      id: input.id,
      action: "update",
      before: { packRole: before.pack_role, role: before.role },
      after: { packRole: input.role, role },
    });
    return {
      ...toUser({ ...before, role, pack_role: input.role }),
      previousPackRole: before.pack_role,
    };
  },
});

/** What an admin may grant now: the core list and the grantable permissions of installed packs. */
export async function grantable(
  ctx: Pick<Parameters<typeof userPackRoles.handler>[1], "db">,
): Promise<
  { permission: string; label: string; from: string; forFixedRole: boolean; restricted: boolean }[]
> {
  const rows = await ctx.db
    .selectFrom("core_extensions")
    .select(["id", "manifest"])
    .where("status", "=", "active")
    .where("source", "=", "shipped")
    .orderBy("id")
    .execute();
  const packs = rows.flatMap((row) => {
    const manifest = JSON.parse(row.manifest ?? "{}") as {
      label?: string;
      grantable?: string[];
      grantableLabels?: Record<string, string>;
      restricted?: string[];
      tools?: Record<string, { permission?: string | string[]; description?: string }>;
    };
    return (manifest.grantable ?? []).map((permission) => {
      const tools = Object.entries(manifest.tools ?? {})
        .filter(([, tool]) => toolPermissions(tool).includes(permission))
        .map(([name]) => name);
      const words = manifest.grantableLabels?.[permission];
      return {
        permission,
        label: `${manifest.label ?? row.id}: ${words ?? (tools.join(", ") || permission)}`,
        from: row.id,
        // A pack permission opens that pack's named tools only (ADR 0600).
        forFixedRole: true,
        // Held by admins and by grant only (ADR 0625): never self-granted.
        restricted: (manifest.restricted ?? []).includes(permission),
      };
    });
  });
  const labels: Record<(typeof GRANTABLE_PERMISSIONS)[number], string> = {
    "records:publish": "Publish versions of publishable records (programs)",
    "orders:refund": "Refund orders and keep late payments",
    "subscriptions:manage": "End or keep going customers' subscriptions",
    "people:link": "Link a parent or guardian to a child, and end the link",
    "practitioners:manage": "Invite outside practitioners and end their accounts",
    "agreements:manage": "Write agreement documents, and publish, attach and retire them",
    "agreements:paper": "Record that someone signed an agreement on paper",
    "agreements:health": "Read members' health form answers (every read is logged)",
    "agreements:desk": "Start a desk signing session for a member on an enrolled tablet",
    "checklists:write": "Write the checklists staff tick off (their steps, and which are in use)",
    "invoices:write": "Draft quotes, invoices and credit notes",
    "invoices:send": "Send quotes, and issue and send invoices",
    "invoices:credit": "Issue credit notes and void invoices",
    "invoices:payments":
      "Record payments taken another way (transfer, cash, card machine), and read the invoice log",
    "accounting:manage":
      "Run the accounting sync: map the books' accounts, approve days, fix what is held",
    "notes:clients": "Read every client's notes kept to their coaches (every read is logged)",
    "notes:sensitive": "Read sensitive notes (every opening is logged)",
    "notes:manage": "Change and delete others' notes, and lower a note's level",
    "journeys:manage": "Write journeys, set them live, pause them and add people to them",
    "journeys:publish": "Approve a journey's wording by publishing it",
    "orders:discount": "Give money off an order at the desk, with a reason (up to the set limit)",
    "orders:payments": "Record a payment taken another way (transfer, cash), and reverse one",
    "people:cards": "Issue and revoke members' check-in cards",
    "stock:adjust": "Record opening stock and correct how many are on hand",
    "finance:read": "See the finance reports and download their files",
    "finance:close": "Close and reopen a month's finance figures",
    "bookingSystem:manage": "Load the booking system's lists and link its people and coaches",
  };
  return [
    ...GRANTABLE_PERMISSIONS.map((permission) => ({
      permission,
      label: labels[permission],
      from: "core",
      // A few core permissions open person-scoped operations a desk account needs (ADR 0783).
      forFixedRole: FIXED_ROLE_CORE_GRANTS.includes(permission),
      // The notes permissions (stage 56, ADR 0832) are restricted as a pack's may be (ADR 0625).
      restricted: RESTRICTED_CORE_PERMISSIONS.includes(permission),
    })),
    ...packs,
  ];
}

export const userGrantablePermissions = defineOperation({
  name: "user.grantablePermissions",
  description:
    "List the permissions an admin can grant a staff account one by one, on top of its role: " +
    "publishing versions of programs and other publishable records, refunding orders, and the " +
    "tool permissions installed packs declare grantable. An account with a pack's fixed role may " +
    "be granted the packs' permissions only (forFixedRole). Read-only.",
  input: z.object({}),
  output: z.object({
    items: z.array(
      z.object({
        permission: z.string(),
        label: z.string(),
        from: z.string(),
        forFixedRole: z
          .boolean()
          .describe("Whether an account with a pack's fixed role may be granted it (ADR 0600)"),
        restricted: z
          .boolean()
          .describe(
            "Held by admins and by grant only: no member holds it otherwise, and nobody grants it to themselves (ADR 0625)",
          ),
      }),
    ),
  }),
  permission: "users:manage",
  risk: "read",
  mcp: { expose: false },
  async handler(_input, ctx) {
    return { items: await grantable(ctx) };
  },
});

export const userSetPermissions = defineOperation({
  name: "user.setPermissions",
  description:
    "Set the permissions a staff account is granted one by one, on top of its role " +
    "(user.grantablePermissions lists them; an empty list takes them all away). A member granted " +
    "records:publish publishes programs; one granted orders:refund approves refunds. A grant never " +
    "lets an AI assistant or MCP client do what only a person may. An account with a pack's " +
    "fixed role may be granted the packs' permissions (a coach given the Bookings desk) and " +
    "agreements:desk only, " +
    "which add up with the role. Admins only, and only a human can call it. Returns the user.",
  input: z.object({
    id: z.string().min(1).max(64).describe("User id (usr_…)"),
    permissions: z.array(z.string().min(1).max(80)).max(20),
  }),
  output: userSchema.extend({ previousPermissions: z.array(z.string()) }),
  permission: "users:manage",
  risk: "write",
  actors: ["human"],
  mcp: { expose: false },
  async handler(input, ctx) {
    const before = await ctx.db
      .selectFrom("rec_user")
      .selectAll()
      .where("id", "=", input.id)
      .executeTakeFirst();
    if (!before) throw new NotFoundError("user", input.id);
    const permissions = await checkGrants(ctx, input.permissions, "permissions", before.pack_role);
    const previous = parseGrants(before.granted_permissions);
    // A restricted permission (ADR 0625) is never granted to oneself: an admin who granted it to
    // their own account would keep it after being made a member.
    if (input.id === ctx.user.id) {
      const restricted = new Set(
        (await grantable(ctx)).filter((g) => g.restricted).map((g) => g.permission),
      );
      const added = permissions.filter((p) => restricted.has(p) && !previous.includes(p));
      if (added.length) {
        throw new ForbiddenError(
          `${added.join(", ")} cannot be granted to your own account: another admin grants it.`,
          { field: "permissions", rule: "self_grant", permissions: added },
        );
      }
    }
    ctx.write(
      ctx.db
        .updateTable("core_user")
        .set({
          granted_permissions: permissions.length ? JSON.stringify(permissions) : null,
          updated_at: ctx.now,
        })
        .where("id", "=", input.id),
      // A calendar feed the grants no longer let them have is revoked with them (ADR 0628).
      ...(await feedRevocations(ctx.db, input.id, { grants: permissions })),
    );
    ctx.recordChange({
      object: "user",
      id: input.id,
      action: "update",
      before: { permissions: previous },
      after: { permissions },
    });
    return {
      ...toUser({
        ...before,
        granted_permissions: permissions.length ? JSON.stringify(permissions) : null,
      }),
      previousPermissions: previous,
    };
  },
});

export const userMe = defineOperation({
  name: "user.me",
  description:
    "The signed-in staff account: id, name, role, the permissions granted to it one by one, and " +
    "every permission it holds (its role's and its grants). For an app to offer what the account " +
    "may do (publish a program); the host still decides each call. Read-only.",
  input: z.object({}),
  output: z.object({
    id: z.string(),
    name: z.string(),
    role: z.enum(ROLES),
    granted: z.array(z.string()),
    permissions: z.array(z.string()),
  }),
  permission: "records:read",
  risk: "read",
  mcp: { idempotent: true },
  async handler(_input, ctx) {
    const granted = [...(ctx.permissionGrants ?? [])].filter((p) =>
      (GRANTABLE_PERMISSIONS as readonly string[]).includes(p),
    );
    const permissions = PERMISSIONS.filter((p) => holdsPermission(ctx.user, granted, p));
    return { id: ctx.user.id, name: ctx.user.name, role: ctx.user.role, granted, permissions };
  },
});

export const userOperations = [
  userMe,
  userList,
  userUpdateRole,
  userPackRoles,
  userSetPackRole,
  userGrantablePermissions,
  userSetPermissions,
] as const;
