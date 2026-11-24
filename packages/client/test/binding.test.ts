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

  it("leaves the cookie as it is when the host answers with a failure", async () => {
    const cookies = await keepCustomerSignedIn({
      cookieHeader,
      baseUrl: "https://host",
      fetch: async () => ({ status: 503, headers: { get: () => null }, text: async () => "" }),
    });
    expect(cookies).toEqual([]);
  });
});
