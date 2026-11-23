// The Users page's grant saves (ADR 0600): only grants the account may hold are sent, so a stored
// grant that no longer applies never makes a tick fail; it is split out for the admin to see.
import { describe, expect, it } from "vitest";
import { splitGrants, toggledGrants } from "../src/lib/grants.ts";

describe("grants the Users page saves", () => {
  const allowed = ["bookings:desk", "memberships:passes"];
  const stored = ["records:publish", "bookings:desk", "gone:pack"];

  it("splits what applies from what no longer does", () => {
    expect(splitGrants(stored, allowed)).toEqual({
      held: ["bookings:desk"],
      stale: ["records:publish", "gone:pack"],
    });
  });

  it("a tick or an untick sends only grants the account may hold", () => {
    expect(toggledGrants(stored, allowed, "memberships:passes", true)).toEqual([
      "bookings:desk",
      "memberships:passes",
    ]);
    expect(toggledGrants(stored, allowed, "bookings:desk", false)).toEqual([]);
    // Ticking twice, or something not on offer, adds nothing.
    expect(toggledGrants(stored, allowed, "bookings:desk", true)).toEqual(["bookings:desk"]);
    expect(toggledGrants(stored, allowed, "gone:pack", true)).toEqual(["bookings:desk"]);
  });
});
