// Stage 47 (ADR 0660, from the review of PR #303): the admin's screens call the HTTP surface from
// the browser with the staff session's cookie, so that cookie is used only from the host's own
// pages. An origin API_ALLOWED_ORIGINS lets in (the company's website, for its customers) gets
// no staff session: a script there cannot act as the staff browser it runs in. A customer's cookie
// from that origin, a native app's bearer token, and the no-Origin content-type check are as
// before.
//
// The same rule (`staffCookieAllowed`, src/server/staff-origin.ts) holds wherever a staff cookie is
// read: the token exchange (the second review's exploit), media, the agreement PDFs, TanStack
// Start's server functions and /api/* routes, the assistant's socket and the MCP consent page.
import { env } from "cloudflare:workers";
import { createCustomerAuth, customerIdentity } from "@composable-os/auth";
import { coreInvoker, handleMedia, inviteCustomer, issueDeviceSession } from "@composable-os/core";
import { createCrmDb } from "@composable-os/db";
import { beforeAll, describe, expect, it } from "vitest";
import { SOCKET_PATH } from "../src/server/assistant/http.ts";
import { handleAgreementPdf } from "../src/server/http/agreement-pdf.ts";
import { type ApiEnv, apiContext, handleApi } from "../src/server/http/api.ts";
import { NATIVE_STAFF_SIGN_IN_PATH } from "../src/server/http/native.ts";
import { authorize } from "../src/server/identity.ts";
import type { McpEnv } from "../src/server/mcp/handler.ts";
import { mediaStoreFor } from "../src/server/media.ts";
import { staffCookieAllowed } from "../src/server/staff-origin.ts";
import {
  appFor,
  ORIGIN,
  openConsent,
  registerClient,
  signUp,
  type TestUser,
  testEnv,
  unique,
} from "./mcp-helpers.ts";

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

/** Headers a browser sends that a page cannot set, for each place a request can come from. */
const FROM = {
  allowed: { origin: ALLOWED },
  evil: { origin: "https://evil.test" },
  nullOrigin: { origin: "null" },
  crossSite: { "sec-fetch-site": "cross-site" },
  sameSite: { "sec-fetch-site": "same-site" },
} as const;
const ELSEWHERE = Object.entries(FROM);
/** A top-level navigation from another site: a link into the admin from an email. */
const LINK = {
  "sec-fetch-site": "cross-site",
  "sec-fetch-mode": "navigate",
  "sec-fetch-dest": "document",
};

describe("the rule (staffCookieAllowed)", () => {
  const allowed = (headers: Record<string, string>, method = "POST") =>
    staffCookieAllowed(new Request(`${ORIGIN}/x`, { method, headers }));

  it("passes the host's own pages and requests that are not a browser's", () => {
    expect(allowed({ origin: ORIGIN })).toBe(true);
    expect(allowed({ "sec-fetch-site": "same-origin" })).toBe(true);
    expect(allowed({ origin: "null", "sec-fetch-site": "same-origin" })).toBe(true);
    expect(allowed({})).toBe(true);
    expect(allowed(LINK, "GET")).toBe(true);
    expect(allowed({ ...LINK, "sec-fetch-site": "none" }, "GET")).toBe(true);
  });

  it("refuses every other origin, an Origin of null alone and any other fetch site", () => {
    for (const [from, headers] of ELSEWHERE) expect(allowed(headers), from).toBe(false);
    expect(allowed({ origin: "https://crm.test:8443" })).toBe(false);
    expect(allowed({ origin: ORIGIN.toUpperCase() })).toBe(false);
    expect(allowed({ "sec-fetch-site": "none" })).toBe(false);
    // A navigation that posts (a cross-site form), or one into a frame, is not a link.
    expect(allowed(LINK, "POST")).toBe(false);
    expect(allowed({ ...LINK, "sec-fetch-dest": "iframe" }, "GET")).toBe(false);
  });
});

describe("the token exchange (the second review's exploit)", () => {
  const exchange = (headers: Record<string, string>, type = "application/json") =>
    handleApi(
      new Request(`${ORIGIN}/api/v1/auth/token`, {
        method: "POST",
        headers: { "content-type": type, cookie: admin.cookie, ...headers },
        body: JSON.stringify({ deviceName: "x" }),
      }),
      apiEnv,
    ) as Promise<Response>;

  it("an allowed origin's simple text/plain POST gets no tokens", async () => {
    const r = await exchange(FROM.allowed, "text/plain");
    const body = await r.text();
    expect(r.status).not.toBe(200);
    expect(body).not.toContain("accessToken");
    expect(body).not.toContain("refreshToken");
  });

  it("is refused as JSON too, from every other origin and fetch site", async () => {
    for (const [from, headers] of ELSEWHERE) {
      const r = await exchange(headers);
      const body = await r.text();
      expect(r.status, from).toBe(403);
      // An origin no list names is refused by the surface before any session is read.
      if (from !== "evil" && from !== "nullOrigin")
        expect(body, from).toContain("staff_cross_origin");
      expect(body, from).not.toContain("accessToken");
    }
  });

  it("needs application/json even from the host's own pages", async () => {
    const r = await exchange({ origin: ORIGIN }, "text/plain");
    expect(r.status).toBe(415);
  });

  it("still exchanges from the host's own pages, and for a client with no Origin", async () => {
    for (const headers of [{ origin: ORIGIN }, {}] as Record<string, string>[]) {
      const r = await exchange(headers);
      expect(r.status).toBe(200);
      expect(await r.text()).toContain("accessToken");
    }
  });
});

describe("the other places a staff cookie is read", () => {
  const media = (path: string, headers: Record<string, string>, method = "GET") =>
    handleMedia(
      new Request(`${ORIGIN}${path}`, {
        method,
        headers: { cookie: admin.cookie, ...headers },
        ...(method === "POST" ? { body: "x" } : {}),
      }),
      {
        invoker: coreInvoker,
        context: (req) => apiContext(req, apiEnv),
        media: mediaStoreFor(apiEnv as never),
        uploads: true,
        tokenUploads: true,
      },
    );

  it("the operations' manifest and a sending op without an Origin", async () => {
    for (const [from, headers] of ELSEWHERE) {
      const r = await handleApi(
        new Request(`${ORIGIN}/api/v1/manifest`, { headers: { cookie: admin.cookie, ...headers } }),
        apiEnv,
      );
      expect(r?.status, from).toBe(403);
    }
    const r = await call("organisation.list", {
      ...JSON_TYPE,
      ...FROM.crossSite,
      cookie: admin.cookie,
    });
    expect(r.status).toBe(403);
  });

  it("media: a picture and an upload", async () => {
    // Same origin, an unknown picture is not found; from elsewhere the cookie is refused first.
    expect((await media("/api/media/med_nope", { origin: ORIGIN })).status).toBe(404);
    for (const path of ["/api/media/med_nope", "/api/v1/media/med_nope"]) {
      for (const [from, headers] of [...ELSEWHERE, ["nullOrigin", FROM.nullOrigin] as const]) {
        const r = await media(path, headers);
        expect(r.status, `${path} ${from}`).toBe(403);
      }
    }
    for (const [from, headers] of ELSEWHERE) {
      const r = await media("/api/media?name=a.png&alt=a", headers, "POST");
      expect(r.status, from).toBe(403);
    }
  });

  it("the agreement PDFs", async () => {
    const pdf = (headers: Record<string, string>) =>
      handleAgreementPdf(
        new Request(`${ORIGIN}/api/agreements/versions/agv_nope.pdf`, {
          headers: { cookie: admin.cookie, ...headers },
        }),
        { context: (req) => apiContext(req, apiEnv) },
      );
    expect((await pdf({ origin: ORIGIN })).status).toBe(404);
    for (const [from, headers] of ELSEWHERE) expect((await pdf(headers)).status, from).toBe(403);
  });

  it("TanStack Start's server functions, /api/* routes and the assistant's socket", async () => {
    const asks = [
      {
        path: "/_serverFn/x",
        kind: { handlerType: "serverFn", serverFnFile: "src/server/system.ts" },
      },
      {
        path: "/_serverFn/x",
        kind: { handlerType: "serverFn", serverFnFile: "src/server/session.public.ts" },
      },
      { path: "/api/assistant/thread", kind: { handlerType: "router" } },
      { path: "/api/auth/get-session", kind: { handlerType: "router" } },
      { path: SOCKET_PATH, kind: { handlerType: "router" } },
      { path: NATIVE_STAFF_SIGN_IN_PATH, kind: { handlerType: "router" } },
      { path: "/people", kind: { handlerType: "router" } },
    ] as const;
    for (const { path, kind } of asks) {
      const own = await authorize(
        new Request(`${ORIGIN}${path}`, { headers: { cookie: admin.cookie, origin: ORIGIN } }),
        apiEnv,
        kind,
      );
      expect(own.ok && own.principal?.email, path).toBe(admin.email);
      for (const [from, headers] of ELSEWHERE) {
        const r = await authorize(
          new Request(`${ORIGIN}${path}`, {
            method: "POST",
            headers: { cookie: admin.cookie, ...headers },
          }),
          apiEnv,
          kind,
        );
        expect(r.ok, `${path} ${from}`).toBe(false);
        if (!r.ok) expect(r.response.status, `${path} ${from}`).toBe(403);
      }
    }
  });

  it("a link into the admin still opens it; a public page from elsewhere is anyone's", async () => {
    for (const path of ["/people", NATIVE_STAFF_SIGN_IN_PATH]) {
      const r = await authorize(
        new Request(`${ORIGIN}${path}`, { headers: { cookie: admin.cookie, ...LINK } }),
        apiEnv,
        { handlerType: "router" },
      );
      expect(r.ok && r.principal?.email, path).toBe(admin.email);
    }
    const r = await authorize(
      new Request(`${ORIGIN}/gatekeeper/x/callback`, {
        method: "POST",
        headers: { cookie: admin.cookie, ...FROM.crossSite },
      }),
      apiEnv,
      { handlerType: "router" },
    );
    expect(r).toEqual({ ok: true, principal: null });
  });

  it("the MCP consent page", async () => {
    const fetchApp = appFor(apiEnv);
    const clientId = await registerClient(fetchApp, "Cross-origin test");
    const opened = await openConsent(fetchApp, admin, clientId, "y".repeat(43));
    expect(opened.response.status).toBe(200);
    expect(opened.handle).toBeTruthy();
    for (const [from, headers] of ELSEWHERE) {
      const decided = await fetchApp("/oauth/consent", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          cookie: [admin.cookie, ...opened.cookies].join("; "),
          ...headers,
        },
        body: new URLSearchParams({ handle: opened.handle ?? "", decision: "allow" }),
        redirect: "manual",
      });
      expect(decided.status, from).toBe(403);
    }
  });
});
