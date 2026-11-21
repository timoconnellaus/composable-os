// user.* operations: the deployment's users and their roles. Changing a role is admin-only and
// human-only (identity is not AI-configurable), and the last admin cannot be demoted.
import { sql } from "kysely";
import { z } from "zod";
import { ConflictError, NotFoundError, ValidationError } from "../errors.ts";
import { defineObject } from "../fields/types.ts";
import { listInputSchema, pageQuery, pageSchema, selectFields } from "../list.ts";
import { defineOperation } from "../operation.ts";
import { availablePackRoles, PACK_ROLE_NAME_RE } from "../pack-roles.ts";
import { ROLES } from "../principals.ts";

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
  image: string | null;
  created_at: string;
};

const toUser = (row: UserRow): User => ({
  id: row.id,
  name: row.name,
  email: row.email,
  role: row.role,
  packRole: row.pack_role,
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

export const userSetPackRole = defineOperation({
  name: "user.setPackRole",
  description:
    "Give a staff account one fixed role a pack declares (user.packRoles lists them), or take it " +
    "away with role null. While an account holds one, it may do exactly what the role lists and " +
    "nothing else, whatever its own role, and its role is set to viewer. An admin cannot be given " +
    "one (change their role first). Admins only, and only a human can call it. Returns the user.",
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
      if (!PACK_ROLE_NAME_RE.test(input.role)) {
        throw new ValidationError("A pack role is named <pack>.<role>", { field: "role" });
      }
      const roles = await availablePackRoles(ctx.db);
      if (!roles.some((role) => role.name === input.role)) {
        throw new ValidationError(
          `No installed pack declares the role ${input.role}. user.packRoles lists them.`,
          { field: "role", available: roles.map((role) => role.name) },
        );
      }
      if (before.role === "admin") {
        throw new ConflictError(
          "An admin holds everything. Change their role to member or viewer first.",
          { field: "role" },
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
    ctx.write(update);
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

export const userOperations = [userList, userUpdateRole, userPackRoles, userSetPackRole] as const;
