// The first admin's setup link on a host of many clients (stage 66 step 9, ADR 0618 "The first
// client's day one"): `https://<staff hostname>/sign-in#first-admin=<token>`, printed once to the
// operator by `cos client add --admin` or `cos client first-admin`. The token is in the fragment,
// which the browser never sends to a server, so no log holds it; the sign-in page reads it and
// sends it with the first account's sign-up, in a header the host checks
// (`@composable-os/auth` `FIRST_ADMIN_HEADER`; the two are held equal by a test).

/** The setup link's fragment key (`@composable-os/db/registry` `FIRST_ADMIN_FRAGMENT`). */
export const FIRST_ADMIN_FRAGMENT = "first-admin";

/** The header the sign-up carries the token in (`@composable-os/auth` `FIRST_ADMIN_HEADER`). */
export const FIRST_ADMIN_HEADER = "cos-first-admin-token";

/** The token in a page's fragment (`#first-admin=<token>`), or null. */
export function firstAdminTokenOf(hash: string): string | null {
  const params = new URLSearchParams(hash.replace(/^#/, ""));
  const token = params.get(FIRST_ADMIN_FRAGMENT)?.trim();
  return token && /^[A-Za-z0-9_-]{32,128}$/.test(token) ? token : null;
}
