// Microsoft Graph (or a proxy) echoing the access token it was sent in its error message: the
// gatekeeper's error never carries it. Token-endpoint failures go through the kit's OAuth client,
// which quotes the HTTP status and the OAuth error code only (oauth-client.test.ts).
import { describe, expect, it } from "vitest";
import { GraphApi } from "../src/graph-api";

const TOKEN = "eyJ0eXAiOi.s66e-graph-access-token-Ab3dEf6hIj9kLm2n";

describe("Microsoft Graph errors from an echoing upstream", () => {
  it("never carry the access token, in any spelling or piece", async () => {
    const api = new GraphApi(TOKEN, {
      fetch: async (_input, init) => {
        const auth = new Headers(init?.headers).get("authorization") ?? "";
        return new Response(
          JSON.stringify({
            error: {
              code: "InvalidAuthenticationToken",
              message: `Token ${auth.replace(/^Bearer /, "")} (${encodeURIComponent(TOKEN)}) is bad; ${TOKEN.slice(-16)}`,
            },
          }),
          { status: 400, headers: { "content-type": "application/json" } },
        );
      },
    });
    const error = await api.get("/me").then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(error?.message).toBeTruthy();
    for (const form of [TOKEN, encodeURIComponent(TOKEN), TOKEN.slice(-16), TOKEN.slice(0, 14)]) {
      expect(error?.message, form).not.toContain(form);
    }
  });
});
