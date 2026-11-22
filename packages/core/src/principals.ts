// Who is calling, how dangerous the call is, and what a role may do (ADR 0003, 0011, 0015).
import { z } from "zod";

/** How dangerous an operation is. The gate decides per actor × risk class. */
export const RISK_CLASSES = [
  "read",
  "write",
  "bulk-write",
  "destructive",
  "schema",
  "extension",
  "outbound",
] as const;
export type RiskClass = (typeof RISK_CLASSES)[number];

/** Who initiated an operation. */
/** `extension`: extension code calling operations through `codemode:ops` (ADR 0025). */
export const ACTORS = ["human", "assistant", "mcp", "automation", "extension"] as const;
export type Actor = (typeof ACTORS)[number];

/** Where a call came from, recorded in the audit log. */
export const originSchema = z.object({
  // `client`: a client app or site: a customer or the public (stage 22), or any caller of the
  // HTTP surface (stage 23).
  surface: z.enum(["ui", "mcp", "automation", "system", "extension", "assistant", "client"]),
  /** The MCP client id (OAuth client_id). */
  clientId: z.string().optional(),
  /** The MCP client's display name, as registered (self-asserted). */
  clientName: z.string().optional(),
  /**
   * The MCP session: the connected app (cap_…) the token belongs to (ADR 0032). Pending actions
   * group by it, and only it sees their simulated state.
   */
  // For the in-app assistant (surface `assistant`, ADR 0340) the session is the thread (ath_…).
  sessionId: z.string().optional(),
  /** The automation id (`<extension>.<key>`, or a system job such as `trash.purge`). */
  automationId: z.string().optional(),
  /** An automation run (arn_…): its pending actions go in one change set per run (ADR 0130). */
  runId: z.string().optional(),
  /** Cascade tags (ADR 0130): how deep in an automation cascade this call is, and its chain. */
  depth: z.number().int().min(0).optional(),
  chain: z.array(z.string()).max(10).optional(),
  rootEventId: z.string().optional(),
  /** Test mode: the call is simulated, nothing is written (ADR 0133). */
  test: z.boolean().optional(),
  /** The extension whose code made the call (actor `extension`). */
  extensionId: z.string().optional(),
  /** The agent that made the call (job_…, ADR 0344). Its session is `job:<id>`. */
  jobId: z.string().optional(),
});
export type Origin = z.infer<typeof originSchema>;

export const ROLES = ["admin", "member", "viewer"] as const;
export type Role = (typeof ROLES)[number];

/**
 * What an operation requires. Roles grant permissions (below); operations name one.
 * - `records:read`  read any record, list, search, view own saved views
 * - `records:write` create, update, soft-delete and restore records; manage own saved views
 * - `records:erase` hard-delete (GDPR erase)
 * - `audit:read`    the admin Audit page
 * - `users:manage`  change users' roles
 * - `policy:manage` change the approval policy (also human-only, see `actors`)
 * - `extensions:manage` install, check, disable, enable and roll back extensions (stage 3)
 * - `integrations:manage` enable gatekeepers, create and manage org connections (stage 6)
 * - `settings:manage` org settings such as the base currency (stage 4b)
 * - `orders:refund` propose and approve a refund of an order's payment (stage 25, ADR 0429).
 *   Admins only by default. Approving one also needs a person: no AI actor approves a refund.
 * - `records:publish` publish a version of a publishable record's content (stage 41, ADR 0446).
 *   Admins only by default, as `orders:refund` is. An AI actor acting for an account that holds
 *   it may ask for a publish, never make one: its request always waits for a person who holds
 *   it too (ADR 0480).
 * - `subscriptions:manage` end or keep going someone else's subscription (stage 32a, ADR 0485).
 *   Admins only by default, grantable as `orders:refund` is. A customer ends or keeps going their
 *   own without it (the operation's audience, not a role, lets them).
 * - `people:link` link a guardian to a dependant and end the link (stage 31a, ADR 0540): who may
 *   act for whom. Admins only by default, grantable as `orders:refund` is, and a person only
 *   whatever is granted (the operations are `actors: ["human"]`).
 */
export const PERMISSIONS = [
  "records:read",
  "records:write",
  "records:erase",
  "audit:read",
  "users:manage",
  "policy:manage",
  "extensions:manage",
  "integrations:manage",
  "settings:manage",
  "orders:refund",
  "records:publish",
  "subscriptions:manage",
  "people:link",
] as const;
export type Permission = (typeof PERMISSIONS)[number];

export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  viewer: ["records:read"],
  member: ["records:read", "records:write"],
  admin: PERMISSIONS,
};

export function roleHasPermission(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}

/**
 * Core permissions a human admin may grant to a staff account one by one, on top of its role
 * (ADR 0449): a coach who is a member publishing programs, a manager refunding. A pack adds the
 * permissions of its own tools it declares `grantable`. Nothing that changes identity, policy,
 * users or extensions is grantable.
 */
export const GRANTABLE_PERMISSIONS = [
  "records:publish",
  "orders:refund",
  "subscriptions:manage",
  "people:link",
] as const;

/**
 * The account's role, or a permission granted to it (ADR 0449), allows `permission`. A pack role
 * replaces both (ADR 0436): the pipeline asks the role then, never this.
 */
export function holdsPermission(
  user: { role: Role },
  grants: readonly string[] | undefined,
  permission: Permission,
): boolean {
  return (
    roleHasPermission(user.role, permission) ||
    ((GRANTABLE_PERMISSIONS as readonly string[]).includes(permission) &&
      (grants ?? []).includes(permission))
  );
}

/**
 * OAuth scopes an MCP client can be granted (ADR 0021). Each scope implies the ones before it.
 * A token's effective permissions are its user's role ∩ its scopes (`effectivePermissions`).
 * Policy changes stay human-only whatever the scope: `policy.update` is `actors: ["human"]`.
 * `write` carries `records:publish` (ADR 0480): with it a client may only ask for a publish, for
 * an account that holds the permission, and a person approves every request.
 */
export const MCP_SCOPES = ["read", "write", "admin"] as const;
export type McpScope = (typeof MCP_SCOPES)[number];

export const SCOPE_PERMISSIONS: Record<McpScope, readonly Permission[]> = {
  read: ["records:read"],
  write: ["records:read", "records:write", "records:publish"],
  admin: PERMISSIONS,
};

/** Scopes a role may be granted: `admin` only for admins. */
export function grantableScopes(role: Role): McpScope[] {
  return role === "admin" ? [...MCP_SCOPES] : ["read", "write"];
}

/** The permissions granted scopes allow, before intersecting with the role. */
export function scopePermissions(scopes: readonly string[]): Permission[] {
  const out = new Set<Permission>();
  for (const scope of scopes) {
    if ((MCP_SCOPES as readonly string[]).includes(scope)) {
      for (const p of SCOPE_PERMISSIONS[scope as McpScope]) out.add(p);
    }
  }
  return PERMISSIONS.filter((p) => out.has(p));
}

/** Role ∩ scopes. */
export function effectivePermissions(role: Role, scopes: readonly string[]): Permission[] {
  return scopePermissions(scopes).filter((p) => roleHasPermission(role, p));
}

/** The CRM user an invocation acts for: the Principal resolved to a `core_user` row. */
export interface ActingUser {
  id: string;
  email: string;
  name: string;
  role: Role;
}

/**
 * Who a call is made for (ADR 0402): the three audiences as principals.
 * - `staff`: a user of the org, every `ActingUser`.
 * - `customer`: a Person who signed in to their own account. Never a `core_user`, never a role.
 * - `public`: a caller with no account.
 * The visibility seam and the audience check read nothing else about the caller.
 */
export interface StaffPrincipal {
  readonly kind: "staff";
  readonly userId: string;
  readonly role: Role;
}

export interface CustomerPrincipal {
  readonly kind: "customer";
  /** The customer account (cus_…). */
  readonly customerId: string;
  /** The Person the account is linked to (per_…): whose records the caller may see. */
  readonly personId: string;
}

export interface PublicPrincipal {
  readonly kind: "public";
}

export type OutsidePrincipal = CustomerPrincipal | PublicPrincipal;
export type Principal = StaffPrincipal | OutsidePrincipal;

export function staffPrincipal(user: Pick<ActingUser, "id" | "role">): StaffPrincipal {
  return Object.freeze({ kind: "staff", userId: user.id, role: user.role });
}

/**
 * The actors of calls from outside the org, as the audit log records them. They are not in
 * `ACTORS`: the approval policy, the queue and an operation's `actors` are about staff-side
 * callers, and a customer's or the public's call is never queued.
 */
export const OUTSIDE_ACTORS = ["customer", "public"] as const;
export type OutsideActor = (typeof OUTSIDE_ACTORS)[number];
/** Every actor a handler can be called by and the audit log can hold. */
export const ALL_ACTORS = [...ACTORS, ...OUTSIDE_ACTORS] as const;
export type AnyActor = (typeof ALL_ACTORS)[number];
