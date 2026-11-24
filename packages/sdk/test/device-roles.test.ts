// Device roles (stage 51 step 2, ADR 0781): what the contract checks of a declaration. A device
// role holds permissions of its own pack's tools open to `device` only, and names its screen (a
// web block of the pack); a tool open to `device` is open to nobody else, is a read or a write,
// and names a permission a device role holds, never a staff role's, a grant's or a restricted
// one. That only a shipped pack declares device roles is the host's check (core's checkManifest).
import { describe, expect, it } from "vitest";
import {
  defineExtension,
  defineTool,
  type StartedBy,
  TOOL_AUDIENCES,
  toManifest,
  validateManifest,
  z,
} from "../src/index.ts";

const tool = (extra: Record<string, unknown> = {}) =>
  defineTool({
    description: "Fixture: a tool a check-in tablet calls.",
    input: z.object({}),
    output: z.object({}),
    risk: "read",
    handler: () => ({}),
    ...extra,
  });

const role = {
  label: "Check-in tablet",
  description: "Checks members in at the door. Nothing else.",
  permissions: ["door:checkin"],
  screen: { block: "door-checkin-tablet", export: "CheckInTablet" },
};

function pack(extra: Record<string, unknown> = {}, tools: Record<string, unknown> = {}) {
  return defineExtension({
    id: "door",
    version: "1.0.0",
    contractVersion: 1,
    tools: {
      now: tool({ audiences: ["device"], permission: "door:checkin" }),
      checkIn: tool({ audiences: ["device"], permission: "door:checkin", risk: "write" }),
      list: tool({ permission: "door:desk" }),
      ...tools,
    } as never,
    deviceRoles: { checkin: role },
    ...extra,
  });
}

const issues = (extra: Record<string, unknown> = {}, tools: Record<string, unknown> = {}) =>
  validateManifest(toManifest(pack(extra, tools))).issues.map((i) => `${i.path}: ${i.message}`);

describe("device roles (ADR 0781)", () => {
  it("a device is a caller and an audience", () => {
    expect(TOOL_AUDIENCES).toContain("device");
    const caller: StartedBy = { kind: "device", deviceId: "dev_1", name: "Front door tablet" };
    expect(caller.kind).toBe("device");
  });

  it("a good declaration passes, and the manifest carries it", () => {
    expect(issues()).toEqual([]);
    const manifest = toManifest(pack());
    expect(manifest.deviceRoles).toEqual({ checkin: role });
    expect(manifest.tools.now?.audiences).toEqual(["device"]);
    // A pack with none carries none.
    expect(
      toManifest(pack({ deviceRoles: undefined }, { now: tool(), checkIn: tool() })),
    ).not.toHaveProperty("deviceRoles");
  });

  it("a tool open to device is open to nobody else, and names a role's permission", () => {
    expect(
      issues({}, { now: tool({ audiences: ["device", "staff"], permission: "door:checkin" }) }),
    ).toContain(
      'tools.now.audiences: A tool open to device is open to nobody else: audiences ["device"]',
    );
    expect(
      issues({}, { now: tool({ audiences: ["device", "public"], permission: "door:checkin" }) }),
    ).toContain(
      'tools.now.audiences: A tool open to device is open to nobody else: audiences ["device"]',
    );
    expect(issues({}, { now: tool({ audiences: ["device"] }) })).toContain(
      "tools.now.permission: A tool open to device names the permission a device role holds",
    );
    expect(
      issues({}, { now: tool({ audiences: ["device"], permission: "door:other" }) }),
    ).toContain('tools.now.permission: No device role of this pack holds "door:other"');
    expect(
      issues(
        {},
        { now: tool({ audiences: ["device"], permission: "door:checkin", risk: "destructive" }) },
      ),
    ).toContain(
      "tools.now.risk: A tool open to device callers must have risk read or write, not destructive",
    );
    expect(
      issues(
        {},
        { now: tool({ audiences: ["device"], permission: "door:checkin", humanOnly: true }) },
      ),
    ).toContain(
      "tools.now.humanOnly: A tool only a person on the staff may call cannot be open to device callers",
    );
  });

  it("a device role holds only its own pack's device tools", () => {
    // Another pack's permission.
    expect(
      issues({ deviceRoles: { checkin: { ...role, permissions: ["shop:checkin"] } } }),
    ).toContain(
      'deviceRoles.checkin.permissions: "shop:checkin" must be the permission of this pack\'s tools open to device only (audiences ["device"])',
    );
    // A staff tool's.
    expect(issues({ deviceRoles: { checkin: { ...role, permissions: ["door:desk"] } } })).toContain(
      'deviceRoles.checkin.permissions: "door:desk" must be the permission of this pack\'s tools open to device only (audiences ["device"])',
    );
    // A permission shared with a staff tool.
    expect(issues({}, { list: tool({ permission: "door:checkin" }) })).toContain(
      'deviceRoles.checkin.permissions: "door:checkin" must be the permission of this pack\'s tools open to device only (audiences ["device"])',
    );
    expect(issues({ deviceRoles: { checkin: { ...role, permissions: [] } } })).toContain(
      "deviceRoles.checkin.permissions: A device role holds at least one permission",
    );
  });

  it("a device role's permission is no staff role's, grant's or restriction's", () => {
    const staffRole = {
      label: "Door",
      description: "Fixture staff role.",
      permissions: ["door:checkin"],
      read: [],
    };
    const found = issues({ roles: { door: staffRole } });
    expect(found).toContain(
      "deviceRoles.checkin.permissions: \"door:checkin\" is a staff role's, grantable or restricted: a device role's permission is held by devices only",
    );
    expect(issues({ grantable: ["door:checkin"] })).toContain(
      "deviceRoles.checkin.permissions: \"door:checkin\" is a staff role's, grantable or restricted: a device role's permission is held by devices only",
    );
  });

  it("a device role names a web block of its own pack as its screen", () => {
    for (const block of ["shop-checkin", "door-native-checkin", "door"]) {
      expect(
        issues({ deviceRoles: { checkin: { ...role, screen: { ...role.screen, block } } } }),
      ).toContain(
        `deviceRoles.checkin.screen.block: "${block}" must be a web block of this pack (door-<name>, never a native one or another pack's)`,
      );
    }
    expect(
      issues({
        deviceRoles: { checkin: { ...role, screen: { ...role.screen, export: "checkIn" } } },
      }),
    ).toContain(
      'deviceRoles.checkin.screen.export: "checkIn" must be the name of a component (PascalCase)',
    );
    // No screen at all fails the structure.
    const { screen: _screen, ...noScreen } = role;
    const manifest = { ...toManifest(pack()), deviceRoles: { checkin: noScreen } };
    expect(validateManifest(manifest).issues.map((i) => i.path)).toContain(
      "deviceRoles.checkin.screen",
    );
  });
});
