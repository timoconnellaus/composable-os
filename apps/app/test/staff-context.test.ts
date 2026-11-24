// The context a signed-in person's call runs with (src/server/operations.ts `staffContext`).
import { env } from "cloudflare:workers";
import type { Principal } from "@composable-os/auth";
import { DEFAULT_APPROVAL_EXPIRY_DAYS } from "@composable-os/core";
import { describe, expect, it } from "vitest";
import { staffContext } from "../src/server/operations.ts";

const member: Principal = {
  userId: "usr_01JC00000000000000000000C1",
  email: "context@example.com",
  name: "Context",
  roles: [],
};

describe("staffContext", () => {
  it("reads APPROVAL_EXPIRY_DAYS the way the assistant and MCP do", async () => {
    const days = async (value: string | undefined) =>
      (await staffContext({ ...env, APPROVAL_EXPIRY_DAYS: value }, member, { surface: "ui" }))
        .approvalExpiryDays;
    expect(await days("3")).toBe(3);
    // A pending action never expires in the past or at once: these fall back to the default.
    expect(await days("-3")).toBe(DEFAULT_APPROVAL_EXPIRY_DAYS);
    expect(await days("0")).toBe(DEFAULT_APPROVAL_EXPIRY_DAYS);
    expect(await days(undefined)).toBe(DEFAULT_APPROVAL_EXPIRY_DAYS);
  });
});
