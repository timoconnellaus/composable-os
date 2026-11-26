// The nav's permission gate: the Inbox is offered only to an account holding `inbox:read` (the
// session's navPermissions), and every staff role holds it, so the full shell keeps the item.
import { holdsPermission, ROLES } from "@composable-os/core";
import { describe, expect, it } from "vitest";
import { MAIN_NAV, navItemShown, SETTINGS_NAV } from "../src/lib/nav.ts";
import { NAV_PERMISSIONS } from "../src/lib/nav-permissions.ts";

const inbox = MAIN_NAV.find((item) => item.to === "/inbox");

describe("nav items gated on a permission", () => {
  it("shows the Inbox only to an account holding inbox:read", () => {
    expect(inbox?.permission).toBe("inbox:read");
    if (!inbox) return;
    expect(navItemShown(inbox, ["inbox:read"])).toBe(true);
    // A pack-role account's session holds none of the nav permissions.
    expect(navItemShown(inbox, [])).toBe(false);
  });

  it("leaves an item naming no permission shown to everyone", () => {
    const people = MAIN_NAV.find((item) => item.to === "/people");
    expect(people && navItemShown(people, [])).toBe(true);
  });

  it("gates only on permissions the session reports", () => {
    for (const item of [...MAIN_NAV, ...SETTINGS_NAV]) {
      if (item.permission) expect(NAV_PERMISSIONS).toContain(item.permission);
    }
  });

  it("keeps the Inbox for every staff role without a pack role", () => {
    for (const role of ROLES) expect(holdsPermission({ role }, [], "inbox:read")).toBe(true);
  });

  // The inbox's controls follow the host's inbox:work (components/inbox/access.tsx), not the role:
  // the session reports it, a viewer and a pack-role account do not hold it.
  it("reports inbox:work, held by admins and members and not by viewers", () => {
    expect(NAV_PERMISSIONS).toContain("inbox:work");
    expect(holdsPermission({ role: "admin" }, [], "inbox:work")).toBe(true);
    expect(holdsPermission({ role: "member" }, [], "inbox:work")).toBe(true);
    expect(holdsPermission({ role: "viewer" }, [], "inbox:work")).toBe(false);
  });
});
