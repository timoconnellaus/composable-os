// The permissions the app's nav items are gated on (lib/nav.ts). The session
// (server/session.public.ts) returns the ones the signed-in account holds. No imports, so the
// server function does not pull in the nav's icons.
export const NAV_PERMISSIONS = ["inbox:read"] as const;
export type NavPermission = (typeof NAV_PERMISSIONS)[number];
