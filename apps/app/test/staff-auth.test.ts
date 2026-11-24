// The staff sign-in page's posts (src/lib/staff-auth.ts): an offline browser is told so, not
// that its code is wrong.
import { afterEach, describe, expect, it, vi } from "vitest";
import { authPost } from "../src/lib/staff-auth.ts";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("authPost", () => {
  it("tells a refusal from the app not being reached", async () => {
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 200 }));
    expect(await authPost("/sign-in/email-otp", {})).toBe("ok");
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 401 }));
    expect(await authPost("/sign-in/email-otp", {})).toBe("refused");
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("Failed to fetch");
    });
    expect(await authPost("/sign-in/email-otp", {})).toBe("offline");
  });
});
