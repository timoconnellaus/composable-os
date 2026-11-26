// The permissions the app's shell is gated on: its nav items (lib/nav.ts) and the inbox's
// controls (components/inbox/access.tsx). The session (server/session.public.ts) returns the ones
// the signed-in account holds, as the host decides them. No imports, so the server function does
// not pull in the nav's icons.
//
// - `inbox:read`: the Inbox in the nav, and its pages.
// - `inbox:work`: the inbox's controls (take, assign, file, notes, the reply box, saved replies).
export const NAV_PERMISSIONS = ["inbox:read", "inbox:work"] as const;
export type NavPermission = (typeof NAV_PERMISSIONS)[number];
