// Stage 47 (ADR 0660, from the review of PR #303): the admin's screens call the HTTP surface from
// the browser with the staff session's cookie, so that cookie is used only from the host's own
// pages. An origin API_ALLOWED_ORIGINS lets in (the company's website, for its customers) gets
// no staff session: a script there cannot act as the staff browser it runs in. A customer's cookie
// from that origin, a native app's bearer token, and the no-Origin content-type check are as
// before.
import { env } from "cloudflare:workers";
import { createCustomerAuth, customerIdentity } from "@composable-os/auth";
import { inviteCustomer, issueDeviceSession } from "@composable-os/core";
import { createCrmDb } from "@composable-os/db";
import { beforeAll, describe, expect, it } from "vitest";
import { type ApiEnv, handleApi } from "../src/server/http/api.ts";
import type { McpEnv } from "../src/server/mcp/handler.ts";
import { ORIGIN, signUp, type TestUser, testEnv, unique } from "./mcp-helpers.ts";

const ALLOWED = "https://www.company.test";
const CUSTOMER_SECRET = "customer-secret-customer-secret-789";
const apiEnv = {
  ...testEnv(),
  API_ALLOWED_ORIGINS: ALLOWED,
  CUSTOMER_AUTH_SECRET: CUSTOMER_SECRET,
  CUSTOMER_AUTH_URL: ORIGIN,
} as unknown as ApiEnv & McpEnv;
const db = createCrmDb(env.DB);

let admin: TestUser;
let customerCookie = "";
let code = "";
const customers = customerIdentity(
  createCustomerAuth({
    db: env.DB,
    secret: CUSTOMER_SECRET,
    baseURL: ORIGIN,
    sendCode: async (message) => {
      code = message.code;
    },
  }),
  env.DB,
);
const json = (path: string, body: unknown) =>
  new Request(`${ORIGIN}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN },
    body: JSON.stringify(body),
  });

beforeAll(async () => {
  admin = await signUp(apiEnv, "admin");
  const email = `${unique("customer")}@example.com`;
  await inviteCustomer(db, email, admin.id, new Date().toISOString());
  await customers.handle(
    json("/api/customer-auth/email-otp/send-verification-otp", { email, type: "sign-in" }),
  );
  const signedIn = await customers.handle(
    json("/api/customer-auth/sign-in/email-otp", { email, otp: code }),
  );
  customerCookie = (signedIn?.headers.getSetCookie() ?? []).map((c) => c.split(";")[0]).join("; ");
}, 60_000);

async function call(
  name: string,
  headers: Record<string, string>,
): Promise<{ status: number; cors: string | null; body: string }> {
  const response = await handleApi(
    new Request(`${ORIGIN}/api/v1/op/${name}`, { method: "POST", headers, body: "{}" }),
    apiEnv,
  );
  if (!response) throw new Error("not served");
  return {
    status: response.status,
    cors: response.headers.get("access-control-allow-origin"),
    body: await response.text(),
  };
}

const JSON_TYPE = { "content-type": "application/json" };

describe("a staff cookie on the HTTP surface (ADR 0660)", () => {
  it("runs from the host's own pages", async () => {
    const r = await call("organisation.list", {
      ...JSON_TYPE,
      origin: ORIGIN,
      cookie: admin.cookie,
    });
    expect(r.status).toBe(200);
  });

  it("is refused from an allowed client-app origin, and from any other", async () => {
    for (const origin of [ALLOWED, "https://evil.test", "null"]) {
      const r = await call("organisation.list", { ...JSON_TYPE, origin, cookie: admin.cookie });
      expect(r.status, origin).toBe(403);
      expect(r.body).not.toContain('"items"');
    }
  });

  it("a customer's cookie from the allowed origin still works", async () => {
    const r = await call("me.get", { ...JSON_TYPE, origin: ALLOWED, cookie: customerCookie });
    expect(r.status, r.body).toBe(200);
    expect(r.cors).toBe(ALLOWED);
  });

  it("no Origin and a simple content type is still refused before any session is read", async () => {
    for (const type of ["text/plain", "application/x-www-form-urlencoded"]) {
      const r = await call("organisation.list", { "content-type": type, cookie: admin.cookie });
      expect(r.status, type).toBe(415);
    }
  });

  it("a native app's bearer token still works, from any origin it sends", async () => {
    const tokens = await issueDeviceSession(
      db,
      { audience: "staff", subjectId: admin.id },
      "Test phone",
      new Date(),
    );
    const r = await call("organisation.list", {
      ...JSON_TYPE,
      authorization: `Bearer ${tokens.accessToken}`,
    });
    expect(r.status, r.body).toBe(200);
  });
});
