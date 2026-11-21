// Staff invites (ADR 0455): the rules sign-in calls. The operations are in operations/invite.ts.
//
// - A sign-in code goes to an address with a pending, unexpired invite and no account, or to an
//   active staff account whose address is verified. Nobody else gets one, and the answer is the
//   same (packages/auth).
// - Accepting marks the invite accepted in one conditional statement, before the account is
//   inserted with what the invite says: an expired, revoked or already accepted invite makes
//   nothing, and two sign-ins racing on one invite make one account.
// - An invite never applies to an account that exists: it is refused at invite, and the code
//   sign-in of an existing account is that account's own.
import type { CoreDatabase, UserRole } from "@composable-os/db";
import type { Kysely } from "kysely";
import { z } from "zod";
import { parseGrants } from "./pack-roles.ts";

/** How long an invite can be accepted. */
export const INVITE_TTL_DAYS = 7;

const emailSchema = z.string().trim().toLowerCase().email().max(254);

/** The address as invites store it (lower case), or null when it is not one. */
export function normaliseStaffEmail(email: string): string | null {
  const parsed = emailSchema.safeParse(email);
  return parsed.success ? parsed.data : null;
}

/** What an accepted invite gives the account it makes. */
export interface InviteGrant {
  inviteId: string;
  role: UserRole;
  packRole: string | null;
  permissions: string[];
}

/** A human staff account with this address (any state), if there is one. */
async function accountFor(db: Kysely<CoreDatabase>, address: string) {
  return db
    .selectFrom("core_user")
    .select(["id", "kind", "email_verified", "deactivated_at", "support_grant_id"])
    .where((eb) => eb(eb.fn("lower", ["email"]), "=", address))
    .executeTakeFirst();
}

/** The pending invite for an address that has not expired at `now`, if there is one. */
export async function loadPendingInvite(db: Kysely<CoreDatabase>, email: string, now: Date) {
  const address = normaliseStaffEmail(email);
  if (!address) return null;
  return (
    (await db
      .selectFrom("core_user_invite")
      .selectAll()
      .where("email", "=", address)
      .where("accepted_at", "is", null)
      .where("revoked_at", "is", null)
      .where("expires_at", ">", now.toISOString())
      .executeTakeFirst()) ?? null
  );
}

/**
 * Whether a staff sign-in code may be sent to `email`: an active, verified human account (not a
 * support user), or a pending invite for an address no account has.
 */
export async function staffMayGetCode(
  db: Kysely<CoreDatabase>,
  email: string,
  now: Date,
): Promise<boolean> {
  const address = normaliseStaffEmail(email);
  if (!address) return false;
  const account = await accountFor(db, address);
  if (account) {
    return (
      account.kind === "human" &&
      Boolean(account.email_verified) &&
      !account.deactivated_at &&
      !account.support_grant_id
    );
  }
  return (await loadPendingInvite(db, address, now)) !== null;
}

/**
 * Accepts the pending invite for `email` if one is still good at `now`, and says what it gives.
 * The update is conditional, so it succeeds once. Null: no invite to accept; make no account.
 */
export async function acceptInvite(
  db: Kysely<CoreDatabase>,
  email: string,
  now: Date,
): Promise<InviteGrant | null> {
  const address = normaliseStaffEmail(email);
  if (!address) return null;
  const at = now.toISOString();
  const row = await db
    .updateTable("core_user_invite")
    .set({ accepted_at: at, updated_at: at })
    .where("email", "=", address)
    .where("accepted_at", "is", null)
    .where("revoked_at", "is", null)
    .where("expires_at", ">", at)
    .returning(["id", "role", "pack_role", "granted_permissions"])
    .executeTakeFirst();
  if (!row) return null;
  return {
    inviteId: row.id,
    role: row.role,
    packRole: row.pack_role,
    permissions: parseGrants(row.granted_permissions),
  };
}

/** Records which account an accepted invite made. */
export async function recordInviteAccount(
  db: Kysely<CoreDatabase>,
  inviteId: string,
  userId: string,
): Promise<void> {
  await db
    .updateTable("core_user_invite")
    .set({ accepted_user_id: userId })
    .where("id", "=", inviteId)
    .execute();
}

/**
 * The host's own mail, for staff (ADR 0455): what cos-app gives a staff call. It sends through
 * the connection the host's mail goes out from, as the system user (`hostMailCall`).
 */
export interface HostMail {
  /** How staff sign in here: by an emailed code (Better Auth) or through Cloudflare Access. */
  readonly staffSignIn: "code" | "access";
  /** Sends the invite notice, which holds no secret: sent, waiting for review, or not. Never throws. */
  sendStaffInvite(message: {
    to: string;
    invitedBy: string;
  }): Promise<"sent" | "pending" | "not_sent">;
  /** Null when a sign-in code would go out at once now, or why not (ADR 0456). */
  signInMailProblem(): Promise<string | null>;
  /** Sends one code as the host's sign-in mail to a staff address; throws unless sent (ADR 0457). */
  sendSignInCode(message: { to: string; code: string }): Promise<void>;
}

/** The invite notice: who invited them and where to sign in. Plain text, nothing secret. */
export function staffInviteEmail(
  productLabel: string,
  invitedBy: string,
  signInUrl: string,
): { subject: string; text: string } {
  return {
    subject: `${invitedBy} invited you to ${productLabel}`,
    text:
      `${invitedBy} invited you to ${productLabel}.\n\n` +
      `To accept, go to ${signInUrl}, enter this email address and ask for a sign-in code. ` +
      `The invite works for ${INVITE_TTL_DAYS} days.\n\n` +
      "If you did not expect it, ignore this email.",
  };
}

/** The subject and text of a staff sign-in code email. The code is the only variable. */
export function staffCodeEmail(
  productLabel: string,
  code: string,
): { subject: string; text: string } {
  return {
    // Not in the subject: a subject is kept in the audit log as the send's title (ADR 0455).
    subject: `Your ${productLabel} sign-in code`,
    text:
      `Your sign-in code for ${productLabel} is ${code}.\n\n` +
      "It works once and expires in five minutes. If you did not ask for it, ignore this email.",
  };
}

/** The columns an account made from an invite is inserted with. */
export function inviteColumns(grant: InviteGrant) {
  return {
    role: grant.role,
    pack_role: grant.packRole,
    granted_permissions: grant.permissions.length ? JSON.stringify(grant.permissions) : null,
  };
}
