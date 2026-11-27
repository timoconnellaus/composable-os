// Server functions anonymous callers may use (see PUBLIC_SERVER_FN_FILE in identity.ts).

import {
  awaitingFirstUser,
  createIdentityProvider,
  firstAdminByLink,
  signInMethods,
} from "@composable-os/auth";
import {
  holdsPermission,
  loadStaffRights,
  loadSupportGrant,
  resolveActingUser,
  SUPPORT_EMAIL_DOMAIN,
} from "@composable-os/core";
import { type CrmDb, createCrmDb } from "@composable-os/db";
import { createServerFn } from "@tanstack/react-start";
import { NAV_PERMISSIONS } from "../lib/nav-permissions.ts";
import { requestEnv } from "./request-env.ts";

/**
 * The signed-in Principal (or null), the CRM user it acts as (id and role, so the UI can hide
 * admin-only screens; operations still enforce permissions) and how to sign out. The identity
 * middleware has already resolved the Principal for this request; route guards call this on
 * every navigation.
 */
export const getSession = createServerFn({ method: "GET" }).handler(async ({ context }) => {
  const provider = createIdentityProvider(requestEnv());
  const principal = context.principal ?? null;
  const db = createCrmDb(requestEnv().DB);
  const user = principal ? await resolveActingUser(db, principal) : null;
  // A fixed-role account (ADR 0436) gets the admin's small shell: its screens, its account, sign
  // out (stage 47, ADR 0660). Read from the account here, by the host, on every navigation; a
  // page that showed the full shell anyway would have every call it made refused by the host.
  const rights = user ? await loadStaffRights(db.query, user.id) : null;
  const packRole = rights?.packRole ?? null;
  return {
    principal,
    user: user ? { id: user.id, role: user.role } : null,
    packRole: packRole ? { name: packRole.name, label: packRole.label } : null,
    // The nav items' permissions (NAV_PERMISSIONS) the account holds, so the shell offers only the
    // sections it may open (the Inbox needs `inbox:read`). A pack role replaces the account's role
    // and grants (ADR 0436): it holds none of them.
    navPermissions:
      user && rights && !packRole
        ? NAV_PERMISSIONS.filter((p) => holdsPermission(user, rights.grants, p))
        : [],
    // A support session (ADR 0212): the app shows a banner with when access ends.
    support: user ? await supportSession(db, user) : null,
    signOutUrl: provider.signOutUrl,
    identityProvider: provider.kind,
    // The first-run setup wizard (ADR 0167) opens for admins until it is completed or skipped.
    setupOpen: user?.role === "admin" ? await setupOpen() : false,
  };
});

/** When the user is a support user: its grant's staff email and expiry. No read for anyone else. */
async function supportSession(
  db: CrmDb,
  user: { id: string; email: string },
): Promise<{ staffEmail: string; expiresAt: string } | null> {
  if (!user.email.endsWith(`@${SUPPORT_EMAIL_DOMAIN}`)) return null;
  const userId = user.id;
  const row = await db.query
    .selectFrom("core_user")
    .select("support_grant_id")
    .where("id", "=", userId)
    .executeTakeFirst();
  if (!row?.support_grant_id) return null;
  const grant = await loadSupportGrant(db.query, row.support_grant_id);
  if (!grant?.expires_at) return null;
  return { staffEmail: grant.staff_email, expiresAt: grant.expires_at };
}

async function setupOpen(): Promise<boolean> {
  try {
    const row = await requestEnv().DB.prepare("SELECT status FROM core_setup WHERE id = 1").first<{
      status: string;
    }>();
    return row?.status === "pending" || row?.status === "in_progress";
  } catch {
    // Before migration 0161 there is no wizard.
    return false;
  }
}

/** Which sign-in methods the sign-in page should offer, and whether to create the first account. */
export const getSignInMethods = createServerFn({ method: "GET" }).handler(async () => {
  const methods = signInMethods(requestEnv());
  return {
    ...methods,
    firstAccount: methods.email && (await awaitingFirstUser(requestEnv().DB)),
    // On a host of many clients the first account is made only by the operator's setup link
    // (stage 66 step 9): the page asks for it rather than offering the form to anyone.
    firstAdminByLink: firstAdminByLink(requestEnv()),
  };
});
