// A shipped pack's staff screens (stage 47, ADR 0660): what the contract checks of a declaration.
// Each names a web block of its own pack and a component, is gated by one or more of its own
// tools (at least one for staff only), and a record screen sits on one of its objects or a base
// one. That the block and the export exist is the admin's build's check; that only a shipped pack
// declares screens is the host's (core's checkManifest).
import { describe, expect, it } from "vitest";
import {
  defineExtension,
  defineTool,
  screenGateFingerprint,
  toManifest,
  validateManifest,
  z,
} from "../src/index.ts";

const tool = (extra: Record<string, unknown> = {}) =>
  defineTool({
    description: "Fixture: a tool a screen calls.",
    input: z.object({}),
    output: z.object({}),
    risk: "read",
    handler: () => ({}),
    ...extra,
  });

function pack(screens: Record<string, unknown>) {
  return defineExtension({
    id: "desk",
    version: "1.0.0",
    contractVersion: 1,
    objects: {
      visit: {
        label: "Visit",
        plural: "Visits",
        titleField: "name",
        fields: { name: { type: "text", label: "Name" } },
      },
    },
    tools: {
      day: tool(),
      book: tool({ risk: "write" }),
      timetable: tool({ audiences: ["customer", "public"] }),
      both: tool({ audiences: ["staff", "customer"] }),
    },
    screens: screens as never,
  });
}

const issues = (screens: Record<string, unknown>) =>
  validateManifest(toManifest(pack(screens))).issues.map((i) => `${i.path}: ${i.message}`);

const ok = {
  label: "Front desk",
  block: "desk-front",
  export: "FrontDesk",
  nav: { group: "Desk", order: 10 },
  opens: ["day", "book"],
};

describe("a pack's screens (ADR 0660)", () => {
  it("a good declaration passes, and the manifest carries it", () => {
    expect(issues({ front: ok })).toEqual([]);
    const record = { ...ok, nav: undefined, record: { object: "desk.visit", as: "visitId" } };
    expect(
      issues({
        visit: record,
        person: { ...record, record: { object: "person", as: "personId" } },
      }),
    ).toEqual([]);
    const manifest = toManifest(pack({ front: ok }));
    expect(manifest.screens).toEqual({ front: ok });
    // No screens, no key: an old manifest is unchanged.
    expect("screens" in toManifest(pack({}))).toBe(false);
  });

  it("refuses an empty gate, another pack's tool, and an unknown one", () => {
    expect(issues({ front: { ...ok, opens: [] } })).toEqual([
      "screens.front.opens: A screen names at least one tool (opens) or object (writes) that gates it",
    ]);
    expect(issues({ front: { ...ok, opens: ["x.other.book"] } })).toEqual([
      'screens.front.opens.0: "x.other.book" is not a tool of this pack: a screen is gated by its own pack\'s tools',
      "screens.front.opens: A screen's gate names at least one tool for staff only: a tool open to customers or the public is never the only gate",
    ]);
    expect(issues({ front: { ...ok, opens: ["day", "nope"] } })).toEqual([
      'screens.front.opens.1: "nope" is not a tool of this pack: a screen is gated by its own pack\'s tools',
    ]);
  });

  it("refuses a customer's or the public's tool as the only gate", () => {
    expect(issues({ front: { ...ok, opens: ["both"] } })).toEqual([
      "screens.front.opens: A screen's gate names at least one tool for staff only: a tool open to customers or the public is never the only gate",
    ]);
    // A tool staff cannot call at all is never a gate.
    expect(issues({ front: { ...ok, opens: ["day", "timetable"] } })).toEqual([
      'screens.front.opens.1: "timetable" is not for staff, so no member of staff could open this screen',
    ]);
    // Beside a staff-only tool, one staff and customers share is fine.
    expect(issues({ front: { ...ok, opens: ["day", "both"] } })).toEqual([]);
  });

  it("names a web block of this pack, never a native one or another pack's", () => {
    for (const block of ["other-front", "desk-native-front", "Desk", "desk"]) {
      expect(issues({ front: { ...ok, block } })).toEqual([
        `screens.front.block: "${block}" must be a web block of this pack (desk-<name>, never a native one or another pack's)`,
      ]);
    }
    expect(issues({ front: { ...ok, export: "frontDesk" } })).toEqual([
      'screens.front.export: "frontDesk" must be the name of a component (PascalCase)',
    ]);
  });

  it("puts a record screen on this pack's object or a base one", () => {
    expect(issues({ front: { ...ok, record: { object: "other.visit", as: "visitId" } } })).toEqual([
      'screens.front.record.object: "other.visit" must be an object of this pack (desk.<object>), person or organisation',
    ]);
    expect(issues({ front: { ...ok, record: { object: "task", as: "taskId" } } })).toEqual([
      'screens.front.record.object: "task" must be an object of this pack (desk.<object>), person or organisation',
    ]);
    expect(issues({ front: { ...ok, record: { object: "desk.visit", as: "visit-id" } } })).toEqual([
      'screens.front.record.as: "visit-id" must be a camelCase prop',
    ]);
  });

  it("may be gated by an object of this pack it writes, instead of or beside tools", () => {
    const { opens: _opens, ...noTools } = ok;
    expect(issues({ front: { ...noTools, writes: ["desk.visit"] } })).toEqual([]);
    expect(issues({ front: { ...noTools, writes: ["person"] } })).toEqual([
      'screens.front.writes.0: "person" must be an object of this pack (desk.<object>)',
    ]);
    // A write gates it as staff's, so a shared tool beside it is fine.
    expect(issues({ front: { ...ok, opens: ["both"], writes: ["desk.visit"] } })).toEqual([]);
    expect(
      toManifest(pack({ front: { ...noTools, writes: ["desk.visit"] } })).screens?.front,
    ).toEqual({
      ...noTools,
      opens: [],
      writes: ["desk.visit"],
    });
  });

  it("a record screen may be gated by tools staff share with customers (a staff record page)", () => {
    const record = { object: "desk.visit", as: "visitId" };
    expect(issues({ front: { ...ok, opens: ["both"], record } })).toEqual([]);
    // A tool staff cannot call is never a gate, on a record page either.
    expect(issues({ front: { ...ok, opens: ["timetable"], record } })).toEqual([
      'screens.front.opens.0: "timetable" is not for staff, so no member of staff could open this screen',
    ]);
  });

  it("a manifest's gate fingerprint changes with anything a gate is judged by", () => {
    const m = toManifest(pack({ front: ok }));
    const base = screenGateFingerprint(m);
    expect(base).toBeTypeOf("string");
    expect(screenGateFingerprint(toManifest(pack({})))).toBeNull();
    // The same manifest, keys in another order: the same.
    expect(screenGateFingerprint(JSON.parse(JSON.stringify(m)))).toBe(base);
    const changed = (change: (c: typeof m) => void) => {
      const copy = structuredClone(m);
      change(copy);
      return screenGateFingerprint(copy);
    };
    expect(changed((c) => (c.id = "other"))).not.toBe(base);
    expect(
      changed((c) => {
        if (c.screens?.front) c.screens.front.opens = ["day"];
      }),
    ).not.toBe(base);
    expect(
      changed((c) => ((c.tools.book as { permission?: string }).permission = "desk:x")),
    ).not.toBe(base);
    expect(
      changed((c) => ((c.tools.day as { audiences?: string[] }).audiences = ["public"])),
    ).not.toBe(base);
    expect(changed((c) => (c.restricted = ["desk:x"]))).not.toBe(base);
    // A tool no gate names, or a description, changes nothing.
    expect(changed((c) => ((c.tools.both as { risk: string }).risk = "write"))).toBe(base);
    expect(changed((c) => (c.description = "Another description"))).toBe(base);
  });

  it("refuses a bad key and fields it does not know", () => {
    expect(issues({ "front-desk": ok })).toEqual([
      'screens.front-desk: Screen name "front-desk" must be camelCase',
    ]);
    // The manifest as a host reads it: a key it does not know is refused, never kept.
    const raw = {
      ...toManifest(pack({})),
      screens: { front: { ...ok, props: { date: "today" } } },
    };
    expect(validateManifest(raw).issues.map((i) => `${i.path}: ${i.message}`)).toEqual([
      'screens.front: Unrecognized key: "props"',
    ]);
  });
});
