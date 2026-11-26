// What a gatekeeper may say about an upstream failure: the status, the provider's code and its
// description scrubbed of everything that was sent; never the raw body.
import { describe, expect, it } from "vitest";
import {
  providerErrorOf,
  scrubSent,
  upstreamErrorMessage,
  upstreamFailure,
} from "../src/upstream-error.ts";

const SECRET = "s66e-client-secret-Ab3dEf6hIj9kLm2n";
const TOKEN = "s66e-refresh-token-1//0gZx9Yw8Vu7Ts6";

const spellings = (s: string) => [
  s,
  encodeURIComponent(s),
  JSON.stringify(s).slice(1, -1).replace(/\//g, "\\/"),
  btoa(s),
  s.slice(0, 14),
  s.slice(-14),
];

describe("upstream errors", () => {
  it("quote the code and description only, scrubbed of what was sent, never the raw body", async () => {
    const echo = `client_secret=${encodeURIComponent(SECRET)}&refresh_token=${TOKEN} Authorization: Basic ${btoa(`id:${SECRET}`)}`;
    const response = new Response(
      JSON.stringify({ error: "invalid_client", error_description: `bad: ${echo}`, echo }),
      { status: 401, headers: { "content-type": "application/json" } },
    );
    const message = await upstreamFailure("The token endpoint", response, [SECRET, TOKEN]);
    expect(message).toMatch(/^The token endpoint failed: 401 invalid_client - bad: /);
    for (const s of [SECRET, TOKEN]) {
      for (const form of spellings(s)) expect(message, form).not.toContain(form);
    }
    // A body that is not JSON gives the status alone.
    const text = new Response(`proxy says ${SECRET}`, { status: 502 });
    expect(await upstreamFailure("Calendar", text, [])).toBe("Calendar failed: 502");
  });

  it("read the shapes providers use", () => {
    expect(providerErrorOf({ error: { code: "403", status: "PERMISSION_DENIED", message: "m" } })).toEqual({
      code: "PERMISSION_DENIED",
      description: "m",
    });
    expect(providerErrorOf({ errors: [{ code: "x_y", detail: "d" }] })).toEqual({ code: "x_y", description: "d" });
    // A code that is not an identifier is not quoted.
    expect(providerErrorOf({ error: `echo ${SECRET}` })).toEqual({});
    expect(upstreamErrorMessage("X", 400, { message: "a\nb\u0000c" }, [])).toBe("X failed: 400 - a b c");
  });

  it("cut a bearer or basic token, but not ordinary words after the scheme", () => {
    expect(scrubSent("Authorization: Bearer ya29.AbC123xyzQQ", [])).toBe("Authorization: Bearer [redacted]");
    expect(scrubSent("Basic auth is disabled", [])).toBe("Basic auth is disabled");
  });
});
