// Pack roles (stage 27, ADR 0436): a fixed staff role a pack declares (`roles` in its manifest),
// such as Ticketing's door role, which an admin gives to a staff account.
//
// A staff account's permissions come from its role (admin, member, viewer; principals.ts), and
// every one of those roles reads every record. A pack role is the one way for an account to hold
// less: while `core_user.pack_role` is set, the account may call exactly
//   - the tools of that pack whose declared permission the role lists, and
//   - `record.get` and `record.list` on the objects of that pack the role lists,
// and is refused every other operation, by the pipeline, before its input is looked at. Its own
// `role` grants nothing while the pack role is held.
//
// The pipeline reads the column on every staff call (one statement, joined to the pack's
// manifest), rather than trusting what an adapter put in `ActingUser`: an account built from a
// `core_user` row anywhere (MCP, the assistant, run-as, approvals) is held to it all the same.
// An unknown role, or one whose pack is not installed, active and shipped, holds nothing.
import type { CoreDatabase, CrmDb } from "@composable-os/db";
import type { ExtensionManifest, RoleManifest } from "@composable-os/sdk";
import { type Kysely, sql } from "kysely";
import type { AnyOperation } from "./operation.ts";

/** A pack role as an account holds it. */
export interface HeldPackRole {
  /** `<extension>.<role>`, as stored on the account. */
  readonly name: string;
  readonly extension: string;
  readonly label: string;
  /** Tool permissions (`<extension>:<word>`) the role holds. */
  readonly permissions: readonly string[];
  /** Objects (`<extension>.<object>`) whose records the role may read. */
  readonly read: readonly string[];
}

/** The reads a pack role's `read` opens, on the objects it lists. Nothing else reads for it. */
export const PACK_ROLE_READS: readonly string[] = ["record.get", "record.list"];

/** `<extension>.<role>`. */
export const PACK_ROLE_NAME_RE = /^([a-z][a-z0-9]{1,29})\.([a-z][a-zA-Z0-9]{0,39})$/;

/** The roles an installed manifest declares, if its extension may declare any (shipped). */
function rolesOf(
  row: { manifest: string | null; status: string | null; source: string | null } | undefined,
): Record<string, RoleManifest> {
  if (!row?.manifest || row.status !== "active" || row.source !== "shipped") return {};
  const manifest = JSON.parse(row.manifest) as Partial<ExtensionManifest>;
  return manifest.roles ?? {};
}

function held(name: string, role: RoleManifest | undefined): HeldPackRole {
  const extension = PACK_ROLE_NAME_RE.exec(name)?.[1] ?? "";
  // Fail closed: a role that cannot be found holds nothing.
  return Object.freeze({
    name,
    extension,
    label: role?.label ?? name,
    permissions: Object.freeze([...(role?.permissions ?? [])]),
    read: Object.freeze([...(role?.read ?? [])]),
  });
}

/**
 * The pack role the account `userId` holds, or null. One statement: the account's column and
 * its pack's manifest.
 */
export async function loadPackRole(
  db: Kysely<CoreDatabase>,
  userId: string,
): Promise<HeldPackRole | null> {
  const result = await sql<{
    pack_role: string | null;
    manifest: string | null;
    status: string | null;
    source: string | null;
  }>`
    SELECT u.pack_role, e.manifest, e.status, e.source
    FROM core_user u
    LEFT JOIN core_extensions e
      ON u.pack_role IS NOT NULL AND e.id = substr(u.pack_role, 1, instr(u.pack_role, '.') - 1)
    WHERE u.id = ${userId}
  `.execute(db);
  const row = result.rows[0];
  if (!row?.pack_role) return null;
  const local = PACK_ROLE_NAME_RE.exec(row.pack_role)?.[2] ?? "";
  return held(row.pack_role, rolesOf(row)[local]);
}

/** Every pack role an admin can give now: those of installed, active, shipped packs. */
export async function availablePackRoles(
  db: CrmDb["query"],
): Promise<(HeldPackRole & { description: string })[]> {
  const rows = await db
    .selectFrom("core_extensions")
    .select(["id", "manifest", "status", "source"])
    .where("status", "=", "active")
    .where("source", "=", "shipped")
    .orderBy("id")
    .execute();
  return rows.flatMap((row) =>
    Object.entries(rolesOf(row)).map(([local, role]) => ({
      ...held(`${row.id}.${local}`, role),
      description: role.description,
    })),
  );
}

/**
 * Whether the role could allow `op` for some input: a tool whose permission it holds, or one of
 * the reads its objects open. Checked before the input is parsed, so an account with a pack role
 * learns nothing about any other operation, not even whether its input was valid.
 */
export function packRoleReaches(role: HeldPackRole, op: AnyOperation): boolean {
  if (op.packPermission !== undefined) return role.permissions.includes(op.packPermission);
  return role.read.length > 0 && PACK_ROLE_READS.includes(op.name);
}

/** Whether the role allows `op` with this (parsed) input. */
export function packRoleAllows(role: HeldPackRole, op: AnyOperation, input: unknown): boolean {
  if (!packRoleReaches(role, op)) return false;
  if (op.packPermission !== undefined) return true;
  // record.get and record.list name their object in the input.
  const object = (input as { object?: unknown } | null)?.object;
  return typeof object === "string" && role.read.includes(object);
}
