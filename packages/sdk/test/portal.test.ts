// A shipped pack's sections of My account (stage 48, ADR 0710): what the contract checks of a
// `portal` declaration from the manifest alone. Each names a web block and a native block of its
// own pack (at least one), a component each exports, an order before the base sections, and the
// objects of its own pack that declare a customer (`has`, never empty). What the blocks call is
// read from their block.json by `cos ext check`; that only a shipped pack declares sections is the
// host's check (core's checkManifest).
import { describe, expect, it } from "vitest";
import { defineExtension, toManifest, validateManifest } from "../src/index.ts";

function pack(portal: Record<string, unknown>) {
  return defineExtension({
    id: "gym",
    version: "1.0.0",
    contractVersion: 1,
    objects: {
      visit: {
        label: "Visit",
        plural: "Visits",
        titleField: "name",
        fields: {
          name: { type: "text", label: "Name" },
          person: { type: "relation", label: "Person", to: "person" },
        },
        customer: { field: "person", read: ["name"], write: [] },
      },
      room: {
        label: "Room",
        plural: "Rooms",
        titleField: "name",
        fields: { name: { type: "text", label: "Name" } },
      },
    },
    portal: portal as never,
  });
}

const issues = (portal: Record<string, unknown>) =>
  validateManifest(toManifest(pack(portal))).issues.map((i) => `${i.path}: ${i.message}`);

const ok = {
  label: "Your visits",
  web: { block: "gym-visits", export: "MyVisits" },
  native: { block: "gym-native-visits", export: "MyVisitsScreen" },
  order: 20,
  has: ["gym.visit"],
};

describe("a pack's sections of My account (ADR 0710)", () => {
  it("a good declaration passes, and the manifest carries it", () => {
    expect(issues({ visits: ok })).toEqual([]);
    expect(toManifest(pack({ visits: ok })).portal).toEqual({ visits: ok });
    // One skin alone is a section too.
    const { native: _native, ...webOnly } = ok;
    expect(issues({ visits: webOnly })).toEqual([]);
    // No sections, no key: an old manifest is unchanged.
    expect("portal" in toManifest(pack({}))).toBe(false);
  });

  it("refuses another pack's block, and a native block in web or a web one in native", () => {
    for (const block of ["other-visits", "gym-native-visits", "Gym", "gym"]) {
      expect(issues({ visits: { ...ok, web: { ...ok.web, block } } })).toEqual([
        `portal.visits.web.block: "${block}" must be a web block of this pack (gym-<name>, never a native one or another pack's)`,
      ]);
    }
    for (const block of ["gym-visits", "other-native-visits"]) {
      expect(issues({ visits: { ...ok, native: { ...ok.native, block } } })).toEqual([
        `portal.visits.native.block: "${block}" must be a native block of this pack (gym-native-<name>, never a web one or another pack's)`,
      ]);
    }
    expect(issues({ visits: { ...ok, web: { ...ok.web, export: "myVisits" } } })).toEqual([
      'portal.visits.web.export: "myVisits" must be the name of a component (PascalCase)',
    ]);
  });

  it("refuses an empty has, another pack's object and an object without a customer", () => {
    expect(issues({ visits: { ...ok, has: [] } })).toEqual([
      "portal.visits.has: A section names at least one object whose records are the customer's: a page anyone may open is a page the client links to, not a section",
    ]);
    expect(issues({ visits: { ...ok, has: ["other.visit"] } })).toEqual([
      'portal.visits.has.0: "other.visit" must be an object of this pack (gym.<object>)',
    ]);
    expect(issues({ visits: { ...ok, has: ["person"] } })).toEqual([
      'portal.visits.has.0: "person" must be an object of this pack (gym.<object>)',
    ]);
    expect(issues({ visits: { ...ok, has: ["gym.room"] } })).toEqual([
      'portal.visits.has.0: "gym.room" declares no customer: a section shows on records that are the customer\'s own',
    ]);
  });

  it("names a block, sits before the base sections, and has a camelCase key", () => {
    const { web: _web, native: _native, ...none } = ok;
    expect(issues({ visits: none })).toEqual([
      "portal.visits: A section names its web block, its native block, or both",
    ]);
    for (const order of [0, 60]) {
      expect(issues({ visits: { ...ok, order } })).toEqual([
        "portal.visits.order: A section's order is 1 to 59: the base sections come after",
      ]);
    }
    expect(issues({ "my-visits": ok })).toEqual([
      'portal.my-visits: Section key "my-visits" must be camelCase',
    ]);
  });
});
