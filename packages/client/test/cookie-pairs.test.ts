// keepCustomerSignedIn reads only real `name=value` pairs from the Cookie header.
import { describe, expect, it } from "vitest";
import { keepCustomerSignedIn } from "../src/index.ts";

describe("keepCustomerSignedIn's cookie pairs", () => {
  it("does not take a pair with no '=' for the session cookie", async () => {
    let asked = false;
    const cookies = await keepCustomerSignedIn({
      // All but its last character is the session cookie's name.
      cookieHeader: "theme=dark; cos-customer.session_tokenX",
      baseUrl: "https://host",
      fetch: async () => {
        asked = true;
        return new Response("{}", { status: 200 });
      },
    });
    expect(asked).toBe(false);
    expect(cookies).toEqual([]);
  });
});
