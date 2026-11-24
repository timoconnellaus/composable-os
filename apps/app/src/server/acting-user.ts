// The person a server-run call acts for, read from core_user: the assistant's turns, agent jobs,
// routine agents and MCP. A role the host no longer knows reads as viewer.
import { type ActingUser, ROLES, type Role } from "@composable-os/core";
import type { CrmDb } from "@composable-os/db";

type UserRow = { id: string; email: string; name: string; role: string };

export function actingUserOf(row: UserRow): ActingUser {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: (ROLES as readonly string[]).includes(row.role) ? (row.role as Role) : "viewer",
  };
}

/** The user `userId`, or null when there is none or the account is deactivated. */
export async function activeUser(db: CrmDb, userId: string): Promise<ActingUser | null> {
  const row = await db.query
    .selectFrom("core_user")
    .select(["id", "email", "name", "role", "deactivated_at"])
    .where("id", "=", userId)
    .executeTakeFirst();
  return row && !row.deactivated_at ? actingUserOf(row) : null;
}
