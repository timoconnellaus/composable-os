// What a web app forwards to the host over its binding (stage 24, ADR 0421): the customer's
// session cookie and nothing else.
import { describe, expect, it } from "vitest";
import { customerCookies, customerSession } from "../src/index.ts";

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
