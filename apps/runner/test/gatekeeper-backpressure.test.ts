// A gatekeeper's approval queue full is back-pressure (ADR 0573): its refusal reaches extension
// code as `rate_limited`, which a step retries and which never counts towards quarantine, so a
// busy day of member emails waiting for approval cannot quarantine the pack that sends them.
import { describe, expect, it } from "vitest";
import { CALLER_ERRORS } from "../src/executor/executor.ts";
import { gatekeeperErrorCode } from "../src/integrations/code.ts";

describe("a gatekeeper's queue full", () => {
  it("is rate_limited, a caller's error that does not count towards quarantine", () => {
    const full = new Error(
      "Too many pending actions; approve or reject some in the approval queue first.",
    );
    expect(gatekeeperErrorCode(full)).toBe("rate_limited");
    expect(CALLER_ERRORS.has("rate_limited")).toBe(true);
    // Anything else keeps its own code, or is an integration error, as before.
    expect(gatekeeperErrorCode(Object.assign(new Error("no"), { code: "forbidden" }))).toBe(
      "forbidden",
    );
    expect(gatekeeperErrorCode(new Error("boom"))).toBe("integration_error");
  });
});
