// The search service (or a proxy) echoing what it was sent: the gatekeeper's error is the HTTP
// status only, never the body. It sends no credential of its own (the Workers AI binding holds the
// account's), so there is nothing else to scrub.
import { describe, expect, it } from "vitest";
import { search } from "../src/search";

describe("web search errors from an echoing upstream", () => {
  it("quote the status only", async () => {
    const env = {
      AI: {
        websearch: async (input: unknown) =>
          new Response(`echo: ${JSON.stringify(input)} cf-aig-authorization: s66e-gateway-token-1234567890`, {
            status: 502,
          }),
      },
    } as unknown as Parameters<typeof search>[0];
    const error = await search(env, "s66e query", async () => {}).then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(error?.message).toBe("Web search failed with HTTP 502.");
  });
});
