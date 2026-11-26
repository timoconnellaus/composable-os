// Local (issue #517 follow-up): an observer's access check during a token-endpoint failure must fail
// loudly, never read as "no access". A wrong client secret makes Google's token endpoint answer
// 401 `invalid_client`; that 401 is a broken connection, not the observer's own access, so the
// status the verifier reads from the error must not be 401/403/404.
import { afterEach, describe, expect, it, vi } from "vitest";
import { getAccessToken } from "../../src/google-api";
import { httpStatusFromError } from "../../src/google";

afterEach(() => {
  vi.restoreAllMocks();
});

async function refreshFailure(status: number, body: unknown): Promise<Error> {
  vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
  const error = await getAccessToken("1//s66e-refresh-0123456789", "client-id", "s66e-secret-0123456789")
    .then(() => null, (e: unknown) => e);
  expect(error).toBeInstanceOf(Error);
  return error as Error;
}

describe("an observer check during a token-refresh failure", () => {
  it("surfaces as an error, not as no access", async () => {
    for (const [status, code] of [[401, "invalid_client"], [403, "unauthorized_client"], [400, "invalid_request"]] as const) {
      const error = await refreshFailure(status, { error: code, error_description: "Unauthorized" });
      expect(httpStatusFromError(error), error.message).toBeUndefined();
      // Across an RPC hop the class is gone and only the message is left: still not a status.
      expect(httpStatusFromError(new Error(error.message)), error.message).toBeUndefined();
    }
  });

  it("reads no status from a token-endpoint message of any shape, by its name or its words", () => {
    // The shape the first follow-up wrote, with the status where API errors put theirs.
    const old = new Error("Google token refresh failed: 401 invalid_client - Unauthorized");
    expect(httpStatusFromError(old)).toBeUndefined();
    const named = new Error("failed: 401 invalid_client");
    named.name = "GoogleTokenError";
    expect(httpStatusFromError(named)).toBeUndefined();
  });

  it("still reads an API's own status", () => {
    expect(httpStatusFromError(new Error("Google Calendar API request failed: 404 - Not Found"))).toBe(404);
    expect(httpStatusFromError(new Error("Google Docs get failed [http=403]"))).toBe(403);
  });
});
