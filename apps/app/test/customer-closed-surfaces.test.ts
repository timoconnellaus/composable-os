// Stage 22, acceptance criterion 6: closed surfaces. A request carrying a customer session gets
// exactly the answer a request with no session gets from the admin pages, the server functions
// (through which the UI runs query.sql, dashboards and exports), the API routes and /mcp. A staff
// session, for contrast, is let in. The customer session here is a real one: a code, a sign-in.
import { env } from "cloudflare:workers";
import { createCustomerAuth, customerIdentity } from "@composable-os/auth";
import { inviteCustomer } from "@composable-os/core";
import { createCrmDb } from "@composable-os/db";
import { beforeAll, describe, expect, it } from "vitest";
import { authorize } from "../src/server/identity.ts";
import { appFor, ORIGIN, signUp, type TestUser, testEnv, unique } from "./mcp-helpers.ts";

const mcpEnv = testEnv();
const fetchApp = appFor(mcpEnv);
let admin: TestUser;
let customerCookie = "";
let code = "";

const customers = customerIdentity(
  createCustomerAuth({
    db: env.DB,
    secret: "customer-secret-customer-secret-456",
    baseURL: ORIGIN,
    sendCode: async (message) => {
      code = message.code;
    },
  }),
  env.DB,
);

const post = (path: string, body: unknown) =>
  new Request(`${ORIGIN}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN },
    body: JSON.stringify(body),
  });

beforeAll(async () => {
  admin = await signUp(mcpEnv, "admin");
  const email = `${unique("customer")}@example.com`;
  await inviteCustomer(createCrmDb(env.DB), email, admin.id, new Date().toISOString());
  await customers.handle(
    post("/api/customer-auth/email-otp/send-verification-otp", { email, type: "sign-in" }),
  );
  const signedIn = await customers.handle(
    post("/api/customer-auth/sign-in/email-otp", { email, otp: code }),
  );
  customerCookie = (signedIn?.headers.getSetCookie() ?? []).map((c) => c.split(";")[0]).join("; ");
});

/** What a response says to its caller: status, where it sends them, and its body. */
async function said(result: Awaited<ReturnType<typeof authorize>>) {
  if (result.ok) return { ok: true, principal: result.principal };
  return {
    ok: false,
    status: result.response.status,
    location: result.response.headers.get("location"),
    body: await result.response.text(),
  };
}

const REQUESTS = [
  ["the admin home", "/", { handlerType: "router" }],
  ["a person's page", "/people/per_x", { handlerType: "router" }],
  ["settings", "/settings/audit", { handlerType: "router" }],
  ["dashboards", "/dashboards", { handlerType: "router" }],
  ["an API route", "/api/assistant/thread", { handlerType: "router" }],
  [
    "a server function (query.sql, dashboards, exports run through one)",
    "/_serverFn/x",
    { handlerType: "serverFn", serverFnFile: "src/server/call-operation.ts" },
  ],
] as const;

describe("a customer session on the staff surfaces", () => {
  it("is a real session: the customer resolver knows it", async () => {
    expect(customerCookie).toContain("cos-customer");
    const principal = await customers.resolve(
      new Request(ORIGIN, { headers: { cookie: customerCookie } }),
    );
    expect(principal.kind).toBe("customer");
  });

  for (const [name, path, kind] of REQUESTS) {
    it(`${name}: the answer no session gets`, async () => {
      const request = (cookie?: string) =>
        new Request(`${ORIGIN}${path}`, cookie ? { headers: { cookie } } : {});
      const none = await said(await authorize(request(), mcpEnv, kind));
      const customer = await said(await authorize(request(customerCookie), mcpEnv, kind));
      expect(none.ok).toBe(false);
      expect(customer).toEqual(none);
      // And it is the session that is refused, not the path: staff are let in.
      const staff = await authorize(request(admin.cookie), mcpEnv, kind);
      expect(staff.ok).toBe(true);
    });
  }

  it("/mcp: the challenge no session gets", async () => {
    const call = (cookie?: string) =>
      fetchApp("/mcp", {
        method: "POST",
        body: "{}",
        ...(cookie ? { headers: { cookie } } : {}),
      });
    const none = await call();
    const customer = await call(customerCookie);
    expect(customer.status).toBe(401);
    expect(customer.status).toBe(none.status);
    expect(customer.headers.get("www-authenticate")).toBe(none.headers.get("www-authenticate"));
    expect(await customer.text()).toBe(await none.text());
  });

  it("the customer cookie renamed as the staff cookie is still no session", async () => {
    const renamed = customerCookie.replaceAll("cos-customer", "better-auth");
    const request = new Request(`${ORIGIN}/`, { headers: { cookie: renamed } });
    const result = await authorize(request, mcpEnv, { handlerType: "router" });
    expect(result.ok).toBe(false);
  });
});
