// Pack roles (stage 27, ADR 0436): a fixed staff role a pack declares (`roles` in its manifest),
// such as Ticketing's door role, which an admin gives to a staff account.
//
// A staff account's permissions come from its role (admin, member, viewer; principals.ts), and
// every one of those roles reads every record. A pack role is the one way for an account to hold
// less: while `core_user.pack_role` is set, the account may call exactly
//   - the tools of that pack whose declared permission the role lists, and
//   - `record.get` and `record.list` on the objects of that pack the role lists, and
//   - `screens.mine`, the screens of the admin it may open (stage 47, ADR 0660),
//   - its own read-and-understood list and confirmations (`ack.mine`, `ack.confirm`, ADR 0702),
//   - a shipped pack's tools open to every staff account (`anyStaff`, ADR 0652), whose host
//     operation decides by its own rule (Daily checklists: the checklist's "who may do it"),
// and is refused every other operation, by the pipeline, before its input is looked at. Its own
// `role` grants nothing while the pack role is held.
//
// The pipeline reads the column on every staff call (one statement, joined to the pack's
// manifest), rather than trusting what an adapter put in `ActingUser`: an account built from a
// `core_user` row anywhere (MCP, the assistant, run-as, approvals) is held to it all the same.
// An unknown role, or one whose pack is not installed, active and shipped, holds nothing.
//
// Roles and grants add up (ADR 0600): an account holding a pack role may also be granted pack
// permissions a pack declares grantable (Bookings' `bookings:desk`), and the few core permissions
// core declares grantable to such an account (`FIXED_ROLE_CORE_GRANTS`: `people:cards`,
// `agreements:desk`), never another core permission.
// Each call is allowed by one authority, decided here (`staffAuthority`): a grant that opens the
// tool, else the pack role. The role's limits (today's records only, ADR 0553; the People its
// holder looks after, ADR 0881) bind what the role gives and nothing else, and the pipeline
// carries them only on a call the role allowed.
import type { CoreDatabase, CrmDb } from "@composable-os/db";
import type { ExtensionManifest, RoleManifest } from "@composable-os/sdk";
import { type Kysely, sql } from "kysely";
import type { AnyOperation } from "./operation.ts";
import type { LooksAfter, LooksAfterLimit, LooksAfterTeam } from "./pack-role-looks-after.ts";
import { FIXED_ROLE_CORE_GRANTS, holdsPermission, type Role } from "./principals.ts";

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
  /** Objects reached only on the organisation's local today, by the datetime path (ADR 0553). */
  readonly today?: import("./pack-role-today.ts").TodayLimits;
  /** Objects reached only for the People the holder looks after, and the teams saying so (ADR 0881). */
  readonly looksAfter?: LooksAfter;
}

/** The reads a pack role's `read` opens, on the objects it lists. Nothing else reads for it. */
export const PACK_ROLE_READS: readonly string[] = ["record.get", "record.list"];

/**
 * The core reads every pack role reaches whatever it lists (stage 47, ADR 0660): only
 * `screens.mine`, which answers with the screens the account itself may open, so a coach, a door
 * or a team account signed in to the admin gets its own screens and nothing else. It reads no
 * record. Nothing else is opened to pack roles.
 */
export const PACK_ROLE_CORE_READS: readonly string[] = ["screens.mine"];

/**
 * The operations every pack role reaches, about the account itself (stage 38, ADR 0702): its
 * own list of what to read, and confirming it read one. Each acts only for the calling person.
 */
export const PACK_ROLE_OWN: readonly string[] = ["ack.mine", "ack.confirm"];

/** `<extension>.<role>`. */
export const PACK_ROLE_NAME_RE = /^([a-z][a-z0-9]{1,29})\.([a-z][a-zA-Z0-9]{0,39})$/;

type ManifestRow = { manifest: string | null; status: string | null; source: string | null };

/** The installed manifest, if its extension may declare roles (active and shipped). */
function manifestOf(row: ManifestRow | undefined): Partial<ExtensionManifest> | null {
  if (!row?.manifest || row.status !== "active" || row.source !== "shipped") return null;
  return JSON.parse(row.manifest) as Partial<ExtensionManifest>;
}

/** The roles an installed manifest declares, if its extension may declare any (shipped). */
function rolesOf(row: ManifestRow | undefined): Record<string, RoleManifest> {
  return manifestOf(row)?.roles ?? {};
}

/** The objects of the manifest that say who looks after whom (`team`, ADR 0831). */
function teamsOf(extension: string, manifest: Partial<ExtensionManifest> | null): LooksAfterTeam[] {
  return Object.entries(manifest?.objects ?? {}).flatMap(([local, object]) => {
    if (!object.team) return [];
    const live =
      object.team.live && object.states
        ? { field: object.states.field, states: Object.freeze([...object.team.live]) }
        : undefined;
    // `live` names states the object no longer has: it counts nothing (fail closed).
    if (object.team.live && !live) return [];
    return [
      Object.freeze({
        object: `${extension}.${local}`,
        person: object.team.person,
        staff: Object.freeze([...object.team.staff]),
        ...(live ? { live: Object.freeze(live) } : {}),
      }),
    ];
  });
}

function held(
  name: string,
  role: RoleManifest | undefined,
  manifest: Partial<ExtensionManifest> | null = null,
): HeldPackRole {
  const extension = PACK_ROLE_NAME_RE.exec(name)?.[1] ?? "";
  // Fail closed: a role that cannot be found holds nothing.
  return Object.freeze({
    name,
    extension,
    label: role?.label ?? name,
    permissions: Object.freeze([...(role?.permissions ?? [])]),
    read: Object.freeze([...(role?.read ?? [])]),
    ...(role?.today ? { today: Object.freeze({ ...role.today }) } : {}),
    ...(role?.looksAfter
      ? {
          looksAfter: Object.freeze({
            teams: Object.freeze(teamsOf(extension, manifest)),
            reach: Object.freeze({ ...role.looksAfter }),
          }),
        }
      : {}),
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
  return (await loadStaffRights(db, userId)).packRole;
}

/** What an account holds beyond its role: its pack role, and the permissions granted to it. */
export interface StaffRights {
  readonly packRole: HeldPackRole | null;
  /** Permissions a human admin granted the account one by one (ADR 0449). */
  readonly grants: readonly string[];
}

/**
 * The account's pack role (ADR 0436) and its granted permissions (ADR 0449), in one statement:
 * the account's row and its pack's manifest. The grants are columns of the same row, so reading
 * them costs nothing beyond the pack role's read.
 */
export async function loadStaffRights(
  db: Kysely<CoreDatabase>,
  userId: string,
): Promise<StaffRights> {
  const result = await sql<{
    pack_role: string | null;
    granted_permissions: string | null;
    manifest: string | null;
    status: string | null;
    source: string | null;
  }>`
    SELECT u.pack_role, u.granted_permissions, e.manifest, e.status, e.source
    FROM core_user u
    LEFT JOIN core_extensions e
      ON u.pack_role IS NOT NULL AND e.id = substr(u.pack_role, 1, instr(u.pack_role, '.') - 1)
    WHERE u.id = ${userId}
  `.execute(db);
  const row = result.rows[0];
  const grants = parseGrants(row?.granted_permissions ?? null);
  if (!row?.pack_role) return { packRole: null, grants };
  const local = PACK_ROLE_NAME_RE.exec(row.pack_role)?.[2] ?? "";
  const manifest = manifestOf(row);
  return { packRole: held(row.pack_role, manifest?.roles?.[local], manifest), grants };
}

/** The stored grants: a JSON list of permission names; anything else is none (fail closed). */
export function parseGrants(stored: string | null): string[] {
  if (!stored) return [];
  try {
    const value = JSON.parse(stored) as unknown;
    return Array.isArray(value) ? value.filter((p): p is string => typeof p === "string") : [];
  } catch {
    return [];
  }
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
      ...held(`${row.id}.${local}`, role, manifestOf(row)),
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
  // A pack's tool open to every staff account (ADR 0652): its host operation decides who may do
  // what, by a rule of its own (a checklist's "who may do it").
  if (op.packAnyStaff === true) return true;
  if (op.packPermissions === undefined && PACK_ROLE_OWN.includes(op.name)) return true;
  if (op.packPermissions !== undefined) {
    return op.packPermissions.some((p) => role.permissions.includes(p));
  }
  if (PACK_ROLE_CORE_READS.includes(op.name)) return true;
  return role.read.length > 0 && PACK_ROLE_READS.includes(op.name);
}

/**
 * Whether a permission granted to the account opens the pack tool `op`: one of the tool's
 * permissions its installed pack still declares grantable (ADR 0449), or a core operation whose
 * permission is one of FIXED_ROLE_CORE_GRANTS (ADRs 0783 and 0649). So for an account holding a pack role a
 * grant opens exactly the tools naming the granted permission and those few core operations, and
 * no record read, list, search or setting (ADR 0600).
 */
export function grantOpens(grants: readonly string[], op: AnyOperation): boolean {
  // The few core permissions a fixed role's account may be granted (ADRs 0783 and 0649).
  if (FIXED_ROLE_CORE_GRANTS.includes(op.permission) && grants.includes(op.permission)) return true;
  return (op.packGrantable ?? []).some((p) => grants.includes(p));
}

/**
 * Whether what the account holds could allow `op` for some input (its pack role, or a grant of
 * one of the tool's grantable permissions). Checked before the input is parsed, as for the role.
 */
export function staffRightsReach(rights: StaffRights, op: AnyOperation): boolean {
  if (!rights.packRole) return true;
  return grantOpens(rights.grants, op) || packRoleReaches(rights.packRole, op);
}

/**
 * What allows a staff call (ADR 0600): `grant`, a permission granted one by one (judged first, so a
 * role's limit never blocks what a grant allows); `packRole`, the pack role the account holds (and
 * only then are its limits carried); `role`, the account's own role or a core grant (an account
 * without a pack role); null, nothing (refused).
 */
export type StaffAuthority = "grant" | "packRole" | "role";

/**
 * Which authority allows a staff account to call `op` with this parsed input, or null. The one
 * decision the pipeline makes for a staff call (`staffMayCall`), and the one that says whether
 * the pack role's limits travel with it (`roleLimitsFor`).
 *   - With a pack role: a grant of one of the tool's grantable pack permissions (never a core
 *     permission: those count for nothing beside a pack role), else the pack role itself.
 *   - Without one: the account's role, or a core permission granted to it (`role`), else a
 *     grant of the tool's grantable pack permission (`grant`).
 */
export function staffAuthority(
  user: { role: Role },
  rights: StaffRights,
  op: AnyOperation,
  input: unknown,
): StaffAuthority | null {
  if (rights.packRole) {
    if (grantOpens(rights.grants, op)) return "grant";
    // A role never holds a restricted permission (the contract refuses it); fail closed anyway.
    if (op.packRestricted) return null;
    return packRoleAllows(rights.packRole, op, input) ? "packRole" : null;
  }
  // A restricted tool (ADR 0625): an admin holds it; anyone else only by a grant of it. The
  // tool's own core permission (`records:write`, which every member holds) is not enough.
  if (op.packRestricted) {
    if (user.role === "admin") return "role";
    return grantOpens(rights.grants, op) ? "grant" : null;
  }
  if (holdsPermission(user, rights.grants, op.permission)) return "role";
  return grantOpens(rights.grants, op) ? "grant" : null;
}

/**
 * The pack role's limit to today a call of `op` holds (ADR 0553): the role's, unless a grant
 * opens the operation, in which case the grant, not the role, allows it and the role's limit
 * does not apply (ADR 0600). Input-independent (a grant opens a tool whatever its input), so the
 * pipeline decides it before the input is parsed.
 */
export function roleLimitsFor(
  rights: StaffRights,
  op: AnyOperation,
): import("./pack-role-today.ts").TodayLimits | undefined {
  if (!rights.packRole?.today) return undefined;
  return grantOpens(rights.grants, op) ? undefined : rights.packRole.today;
}

/**
 * The pack role's limit to the People its holder looks after a call of `op` holds (ADR 0881): as
 * for today's (`roleLimitsFor`), the role's unless a grant opens the operation. `userId` is the
 * account itself, whose People they are.
 */
export function roleLooksAfterFor(
  rights: StaffRights,
  op: AnyOperation,
  userId: string,
): LooksAfterLimit | undefined {
  const looksAfter = rights.packRole?.looksAfter;
  if (!looksAfter) return undefined;
  return grantOpens(rights.grants, op) ? undefined : { userId, ...looksAfter };
}

/**
 * Whether a staff account may call `op` (with this parsed input), by what it holds
 * (`staffAuthority`): a pack role and the pack permissions granted to it (ADRs 0436, 0600); or
 * its role, or a permission granted to it that is still grantable (ADR 0449): a core one by
 * `op.permission`, a pack's by the tool's own permission when its pack declares it grantable.
 * The pipeline asks this on every staff call. Actors, MCP scopes and the gate are judged beside
 * it, so a grant never lets an AI actor make a call that is for a person.
 */
export function staffMayCall(
  user: { role: Role },
  rights: StaffRights,
  op: AnyOperation,
  input: unknown,
): boolean {
  return staffAuthority(user, rights, op, input) !== null;
}

/** Whether the role allows `op` with this (parsed) input. */
export function packRoleAllows(role: HeldPackRole, op: AnyOperation, input: unknown): boolean {
  if (!packRoleReaches(role, op)) return false;
  if (
    op.packPermissions !== undefined ||
    op.packAnyStaff === true ||
    PACK_ROLE_OWN.includes(op.name)
  )
    return true;
  // The account's own screens (ADR 0660): its input is empty, and its answer is the account's.
  if (PACK_ROLE_CORE_READS.includes(op.name)) return true;
  // record.get and record.list name their object in the input.
  const object = (input as { object?: unknown } | null)?.object;
  return typeof object === "string" && role.read.includes(object);
}
