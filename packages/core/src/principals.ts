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
 * - `agreements:manage` write agreement documents, and publish, attach, detach and retire them
 *   (stage 44, ADR 0640). Admins only by default, grantable as `orders:refund` is. Publishing,
 *   attaching, detaching and retiring are a person's whatever is granted (`actors: ["human"]`);
 *   an AI acting for an account that holds it may only write a document's working copy.
 * - `agreements:paper` record that a person signed a document on paper (stage 44, ADR 0642): a
 *   staff entry, never shown as the member's own acceptance. Admins by default, grantable; a
 *   person only whatever is granted.
 * - `agreements:health` read a health form's answers (stage 44, ADR 0643): health information.
 *   Admins by default, grantable; a person only whatever is granted, and every read is audited.
 *   No AI actor reads them, with any grant.
 * - `agreements:desk` start and end a desk signing session for a named Person on a tablet an
 *   admin enrolled (stage 44 step 6, ADR 0649): it shows the titles of what that Person has due
 *   and nothing else of their record, and records no acceptance itself (the member signs).
 *   Admins by default, grantable, and the one core permission grantable to a fixed-role account
 *   (a coach at the desk, `FIXED_ROLE_CORE_GRANTS`, ADR 0600 amended). A person only.
 * - `checklists:write` write the business's checklist templates (stage 45 step 4b, ADR 0650).
 *   Admins by default, grantable as `orders:refund` is. An AI acting for an account that holds it
 *   may draft one; its write always waits for a person who holds it too, so a checklist staff are
 *   asked to follow is always one a person approved.
 * - `notes:clients` read notes kept to a client's coaches (level `coaches`) of every client
 *   (stage 56, ADR 0832): how a business's managers read them. Admins by default; grantable,
 *   restricted (never to oneself, never to a pack role's account), and nothing for an AI actor.
 * - `notes:sensitive` read sensitive notes (level `sensitive`), every opening audited. Admins by
 *   default; grantable and restricted as `notes:clients` is.
 * - `notes:manage` change and delete others' notes it can read, and lower a note's level (a
 *   person only). Admins by default; grantable and restricted as `notes:clients` is.
 * - `journeys:read` read journeys, their versions, previews, entries and step log (stage 53,
 *   ADR 0800). Admins and members.
 * - `journeys:manage` write a journey's working copy, archive it, set it live, pause and resume
 *   it, and add people to it (ADR 0800). Admins by default, grantable. Going live and resuming
 *   are a person's whatever is granted (`actors: ["human"]`); an AI may draft and pause.
 * - `journeys:publish` publish a journey's version: the approval of its wording (decision 3).
 *   Admins by default, grantable. An AI acting for an account that holds it may ask; its request
 *   always waits for a person who holds it too (ADR 0480), never the adjudicator.
 * - `orders:discount` give money off a pending order with a reason, and take it off again
 *   (stage 34, ADR 0691). Admins by default, grantable as `orders:refund` is. Within the limit a
 *   human admin sets it applies at once; above it, and always for an AI, it waits for a human
 *   admin's approval.
 * - `people:cards` issue, revoke and list the check-in cards a business gives its members (stage
 *   51, ADR 0783). Admins and members by default, grantable to any staff account (a fixed-role
 *   one included, ADR 0600). A person only whatever is granted (`actors: ["human"]`).
 * - `stock:adjust` record a record's opening stock and correct it (stage 37, ADR 0680). Admins by
 *   default, grantable as `orders:refund` is. An AI acting for an account that holds it may ask,
 *   never make one: its call always waits for a person who holds it too.
 * - `finance:read` see the finance reports and their periods, and download their files (stage 52,
 *   ADR 0794). Admins by default, grantable as `orders:refund` is (a manager, a bookkeeper). An AI
 *   acting for an account that holds it may read figures; downloading a file is a person's only.
 * - `finance:close` close and reopen a month's figures (stage 52, ADR 0794). Admins by default,
 *   grantable; a person only whatever is granted (the operations are `actors: ["human"]`).
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
  "agreements:manage",
  "agreements:paper",
  "agreements:health",
  "agreements:desk",
  "checklists:write",
  "notes:clients",
  "notes:sensitive",
  "notes:manage",
  "journeys:read",
  "journeys:manage",
  "journeys:publish",
  "orders:discount",
  "people:cards",
  "stock:adjust",
  "finance:read",
  "finance:close",
] as const;
export type Permission = (typeof PERMISSIONS)[number];

/**
 * The namespaces of the core permissions (`agreements`, `orders`, `people`, …): no extension may
 * take one as its id, or it could declare a core permission as its own grantable one (stage 44
 * review). Derived from PERMISSIONS, so a new core permission reserves its namespace by itself.
 */
export const CORE_PERMISSION_NAMESPACES: readonly string[] = [
  ...new Set(PERMISSIONS.map((p) => p.split(":")[0] as string)),
];

export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  viewer: ["records:read"],
  member: ["records:read", "records:write", "journeys:read", "people:cards"],
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
  "agreements:manage",
  "agreements:paper",
  "agreements:health",
  "agreements:desk",
  "checklists:write",
  "notes:clients",
  "notes:sensitive",
  "notes:manage",
  "journeys:manage",
  "journeys:publish",
  "orders:discount",
  "people:cards",
  "stock:adjust",
  "finance:read",
  "finance:close",
] as const;

/**
 * Core grantable permissions that are restricted (stage 56, ADR 0832, extending ADR 0625 to core
 * permissions): held by admins and by a human admin's grant only, never granted to oneself, never
 * to an account with a pack's fixed role, and never anything for an AI actor.
 */
export const RESTRICTED_CORE_PERMISSIONS: readonly Permission[] = [
  "notes:clients",
  "notes:sensitive",
  "notes:manage",
];

/**
 * The core permissions a human admin may also grant to an account holding a pack's fixed role
 * (ADR 0600, amended by ADR 0783): each opens a few person-scoped core operations a desk or door
 * account needs, never a record read, list or search. Every other core permission counts for
 * nothing beside a pack role.
 */
export const FIXED_ROLE_CORE_GRANTS: readonly Permission[] = ["people:cards", "agreements:desk"];

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
  read: ["records:read", "journeys:read"],
  write: [
    "records:read",
    "records:write",
    "records:publish",
    "journeys:read",
    "journeys:manage",
    "journeys:publish",
  ],
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
 * Who a call is made for (ADR 0402): the audiences as principals.
 * - `staff`: a user of the org, every `ActingUser`.
 * - `customer`: a Person who signed in to their own account. Never a `core_user`, never a role.
 * - `public`: a caller with no account.
 * - `device`: an enrolled device holding a device role (ADR 0781, `DevicePrincipal` below).
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

/**
 * An enrolled device holding a device role (stage 51, ADR 0781): the business's own tablet, signed
 * in as nobody. Resolved by the pipeline from the device's credential on the desk origin, never
 * given by an adapter: the adapter says only `{ kind: "device" }` (`DeviceCaller`). It reads no
 * record through the seam, and calls only its role's tools and `device.heartbeat`.
 */
export interface DevicePrincipal {
  readonly kind: "device";
  /** The enrolled device (dev_…). */
  readonly deviceId: string;
  /** The name an admin gave it ("Front door tablet"). */
  readonly name: string;
  /** The device role it holds (`<pack>.<role>`). */
  readonly role: string;
}

/** What the desk origin's handler says of a device call: the pipeline resolves the rest. */
export interface DeviceCaller {
  readonly kind: "device";
}

export type Principal = StaffPrincipal | OutsidePrincipal | DevicePrincipal;

/**
 * Who placed an order or a checkout (`placed_as`): staff, a customer or the public. An enrolled
 * device places none (ADR 0781): its role's tools reach no checkout, and this holds if one did.
 */
export function placedAs(principal: Principal): "staff" | "customer" | "public" {
  if (principal.kind === "device") throw new Error("An enrolled device places no order");
  return principal.kind;
}

export function staffPrincipal(user: Pick<ActingUser, "id" | "role">): StaffPrincipal {
  return Object.freeze({ kind: "staff", userId: user.id, role: user.role });
}

/**
 * The actors of calls from outside the org, as the audit log records them. They are not in
 * `ACTORS`: the approval policy, the queue and an operation's `actors` are about staff-side
 * callers, and a customer's, the public's or an enrolled device's call is never queued.
 */
export const OUTSIDE_ACTORS = ["customer", "public", "device"] as const;
export type OutsideActor = (typeof OUTSIDE_ACTORS)[number];
/** Every actor a handler can be called by and the audit log can hold. */
export const ALL_ACTORS = [...ACTORS, ...OUTSIDE_ACTORS] as const;
export type AnyActor = (typeof ALL_ACTORS)[number];
