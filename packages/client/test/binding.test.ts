// What a web app forwards to the host over its binding (stage 24, ADR 0421): the customer's
// session cookie and nothing else.
import { describe, expect, it } from "vitest";
import { customerCookies, customerSession, keepCustomerSignedIn } from "../src/index.ts";

describe("customerSession", () => {
  it("keeps the customer cookies and drops every other one", () => {
    const header =
      "theme=dark; __Secure-cos-customer.session_token=abc.sig; better-auth.session_token=staff; " +
      "cos-customer.session_data=xyz; _ga=1";
    expect(customerCookies(header)).toBe(
      "__Secure-cos-customer.session_token=abc.sig; cos-customer.session_data=xyz",
    );
    expect(customerSession(header)).toEqual({
      cookie: "__Secure-cos-customer.session_token=abc.sig; cos-customer.session_data=xyz",
    });
  });

  it("sends no cookie header when there is no customer cookie", () => {
    expect(customerSession("better-auth.session_token=staff; theme=dark")).toEqual({});
    expect(customerSession(null)).toEqual({});
    expect(customerSession(undefined)).toEqual({});
  });

  it("forwards only `__Host-` customer cookies when the browser holds one (stage 66)", () => {
    // A many-client host sets `__Host-` names; an unprefixed one beside it was planted on the
    // parent domain by a sibling hostname, and is not passed on.
    const header =
      "cos-customer.session_token=planted; __Host-cos-customer.session_token=abc.sig; " +
      "__Host-cos-customer.session_data=xyz; theme=dark";
    expect(customerCookies(header)).toBe(
      "__Host-cos-customer.session_token=abc.sig; __Host-cos-customer.session_data=xyz",
    );
  });

  it("does not take a look-alike name", () => {
    expect(customerCookies("cos-customers.x=1; xcos-customer.y=2; cos-customer=3")).toBe("");
  });
});

describe("keepCustomerSignedIn", () => {
  const cookieHeader = "cos-customer.session_token=abc.sig";

  it("leaves the cookie as it is when the host cannot be reached", async () => {
    const cookies = await keepCustomerSignedIn({
      cookieHeader,
      baseUrl: "https://host",
      fetch: () => Promise.reject(new TypeError("The binding is not there")),
    });
    expect(cookies).toEqual([]);
  });

  it("on a host of many clients sets a `__Host-` session back with the `__Host-` rules, never one planted beside it (stage 66 step 8)", async () => {
    const now = new Date("2026-11-27T10:00:00Z");
    const expiresAt = new Date(now.getTime() + 7 * 24 * 3600 * 1000).toISOString();
    const sent: string[] = [];
    const cookies = await keepCustomerSignedIn({
      cookieHeader:
        "cos-customer.session_token=planted; __Host-cos-customer.session_token=abc.sig; cos-session-checked=9999999999999",
      baseUrl: "https://host",
      now,
      fetch: async (_url, init) => {
        sent.push(String((init?.headers as Record<string, string>).cookie));
        return {
          status: 200,
          headers: { get: () => null },
          text: async () => JSON.stringify({ session: { expiresAt } }),
        };
      },
    });
    // The planted marker without the prefix is not read either: the session is checked.
    expect(sent).toEqual(["__Host-cos-customer.session_token=abc.sig"]);
    const maxAge = 7 * 24 * 3600;
    expect(cookies).toEqual([
      `__Host-cos-customer.session_token=abc.sig; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=${maxAge}`,
      `__Host-cos-session-checked=${now.getTime()}; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=${maxAge}`,
    ]);
    for (const c of cookies) expect(c).not.toMatch(/Domain=/i);
    // Its marker, once set, is what holds the next check off.
    expect(
      await keepCustomerSignedIn({
        cookieHeader: `__Host-cos-customer.session_token=abc.sig; __Host-cos-session-checked=${now.getTime()}`,
        baseUrl: "https://host",
        now,
        fetch: async () => {
          throw new Error("not called");
        },
      }),
    ).toEqual([]);
  });

  it("leaves the cookie as it is when the host answers with a failure", async () => {
    const cookies = await keepCustomerSignedIn({
      cookieHeader,
      baseUrl: "https://host",
      fetch: async () => ({ status: 503, headers: { get: () => null }, text: async () => "" }),
    });
    expect(cookies).toEqual([]);
  });
});
