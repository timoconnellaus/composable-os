// Stage 24, step 2: the client-app binding (ADR 0421). A company's own Worker reaches the host
// through the `ClientApp` entrypoint, which gets no more than the HTTP surface gives the same
// caller, and less: it is never staff, and never a customer who has not signed in.
//
// - Sign-in over the binding: the web app passes the address and the code, the host creates the
//   session and answers with a customer cookie for the web app's own hostname.
// - Acceptance criterion 3: a forged staff principal and a forged other-customer principal are
//   both refused, however they are sent.
// - Signing out and deleting the account end what the cookie can do.
import { env } from "cloudflare:workers";
import { createIdentityProvider, getCustomerIdentity } from "@composable-os/auth";
import { keepCustomerSignedIn } from "@composable-os/client";
import { inviteCustomer, issueDeviceSession } from "@composable-os/core";
import { createCrmDb } from "@composable-os/db";
import { beforeAll, describe, expect, it } from "vitest";
import { type ApiEnv, handleApi, handleCustomerAuth } from "../src/server/http/api.ts";
import { handleBound } from "../src/server/http/bound.ts";
import type { McpEnv } from "../src/server/mcp/handler.ts";
import { runOperation } from "../src/server/operations.ts";
import { ORIGIN, signUp, type TestUser, testEnv, unique } from "./mcp-helpers.ts";

const CUSTOMER_SECRET = "customer-secret-for-the-binding-789";
/** The company's web app. Customer cookies belong to it; the host is somewhere else. */
const WEB = "https://shop.test";
/** What a bound Worker puts in its URLs: the host part means nothing over a binding. */
const BOUND = "https://host.internal";

const boundEnv = {
  ...testEnv(),
  CUSTOMER_AUTH_SECRET: CUSTOMER_SECRET,
  CUSTOMER_AUTH_URL: WEB,
} as unknown as ApiEnv & McpEnv;
const db = createCrmDb(env.DB);

/** Codes the host would have emailed, by address. */
const codes = new Map<string, string>();
// The host sends codes through the customer mail connection; here the same identity (cached per
// env, as cos-app builds it) hands them to the test instead.
getCustomerIdentity(boundEnv, async ({ to, code }) => {
  codes.set(to.toLowerCase(), code);
});

interface Customer {
  email: string;
  personId: string;
  cookie: string;
}

let admin: TestUser;
let ada: Customer;
let bea: Customer;

const cookiesOf = (response: Response) =>
  response.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");

/** A request as the company's Worker sends it over the binding. */
function bound(
  path: string,
  init: { body?: unknown; headers?: Record<string, string>; method?: string } = {},
) {
  return handleBound(
    new Request(`${BOUND}${path}`, {
      method: init.method ?? "POST",
      headers: { "content-type": "application/json", ...init.headers },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    }),
    boundEnv,
  );
}

/** An operation call over the binding, as the typed client makes it. */
async function call(name: string, input: unknown, headers: Record<string, string> = {}) {
  const response = await bound(`/api/v1/op/${name}`, {
    body: input,
    headers: { "idempotency-key": crypto.randomUUID(), ...headers },
  });
  // biome-ignore lint/suspicious/noExplicitAny: a test reads whatever the envelope holds
  return { status: response.status, body: (await response.json()) as Record<string, any> };
}

/** Signs a customer in through the binding, as the web app's sign-in form does. */
async function signIn(email: string): Promise<Response> {
  // The browser posted to the web app, which forwards to the host with the browser's Origin.
  const asked = await bound("/api/customer-auth/email-otp/send-verification-otp", {
    body: { email, type: "sign-in" },
    headers: { origin: WEB },
  });
  expect(asked.status, await asked.clone().text()).toBe(200);
  const code = codes.get(email.toLowerCase());
  if (!code) throw new Error(`no code for ${email}`);
  return bound("/api/customer-auth/sign-in/email-otp", {
    body: { email, otp: code },
    headers: { origin: WEB },
  });
}

async function newCustomer(givenName: string): Promise<Customer> {
  const email = `${unique(givenName.toLowerCase())}@example.com`;
  const principal = await createIdentityProvider(boundEnv).resolve(
    new Request(BOUND, { headers: { cookie: admin.cookie } }),
  );
  const made = await runOperation(boundEnv, principal, {
    name: "person.create",
    input: { givenName, familyName: "Tester", emails: [{ email }] },
  });
  if (!made.ok) throw new Error(JSON.stringify(made));
  await inviteCustomer(db, email, admin.id, new Date().toISOString());
  const signedIn = await signIn(email);
  expect(signedIn.status).toBe(200);
  return { email, personId: (made.data as { id: string }).id, cookie: cookiesOf(signedIn) };
}

beforeAll(async () => {
  admin = await signUp(boundEnv, "admin");
  ada = await newCustomer("Ada");
  bea = await newCustomer("Bea");
}, 60_000);

/** HMAC-SHA256 of `value`, base64, as Better Auth signs a session cookie. */
async function sign(value: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return btoa(String.fromCharCode(...new Uint8Array(mac)));
}

/** The session token inside a customer's cookie (`<token>.<signature>`, URL-encoded). */
function tokenOf(customer: Customer): string {
  const value = decodeURIComponent(customer.cookie.split("=").slice(1).join("="));
  return value.slice(0, value.lastIndexOf("."));
}
const cookieName = (customer: Customer) => customer.cookie.split("=")[0] as string;

describe("customers sign in on the company's hostname, through the binding", () => {
  it("the host answers with a customer cookie for the web app's own hostname only", async () => {
    const email = `${unique("cara")}@example.com`;
    await inviteCustomer(db, email, admin.id, new Date().toISOString());
    const response = await signIn(email);
    expect(response.status).toBe(200);
    const [cookie, ...others] = response.headers.getSetCookie();
    expect(others).toEqual([]);
    // A host-only cookie: no Domain, so the browser keeps it for the hostname that answered,
    // which is the web app's (it passes this header through). Secure, because the web app's
    // origin is https; HttpOnly, so the web app's pages cannot read it.
    expect(cookie).toMatch(/^__Secure-cos-customer\.session_token=/);
    expect(cookie).not.toMatch(/;\s*domain=/i);
    expect(cookie).toMatch(/;\s*HttpOnly/i);
    expect(cookie).toMatch(/;\s*Secure/i);
    expect(cookie).toMatch(/;\s*SameSite=Lax/i);
  });

  it("the signed-in customer reads their own name with me.get", async () => {
    const me = await call("me.get", {}, { cookie: ada.cookie });
    expect(me.status, JSON.stringify(me.body)).toBe(200);
    expect(me.body.data).toMatchObject({ id: ada.personId, givenName: "Ada" });
  });

  it("refuses a sign-in posted from another site (Better Auth's origin check)", async () => {
    const response = await bound("/api/customer-auth/email-otp/send-verification-otp", {
      body: { email: ada.email, type: "sign-in" },
      headers: { origin: "https://evil.test", cookie: ada.cookie },
    });
    expect(response.status).toBe(403);
  });
});

describe("a bound Worker can never act as staff (criterion 3)", () => {
  const staffOps = ["organisation.list", "person.list", "deviceSession.list", "query.sql"];

  it("a real staff session cookie, forwarded, is not read: staff operations do not exist", async () => {
    for (const name of staffOps) {
      const withStaff = await call(name, {}, { cookie: admin.cookie });
      expect(withStaff, name).toEqual(await call(name, {}));
      expect(withStaff.status, name).toBe(404);
      expect(withStaff.body.error.code).toBe("unknown_operation");
    }
    // With both cookies the caller is the customer, never staff.
    const both = await call("me.get", {}, { cookie: `${admin.cookie}; ${ada.cookie}` });
    expect(both.body.data.id).toBe(ada.personId);
    const manifest = await bound("/api/v1/manifest", {
      method: "GET",
      headers: { cookie: admin.cookie },
    });
    expect(((await manifest.json()) as { data: { audience: string } }).data.audience).toBe(
      "public",
    );
  });

  it("headers claiming a staff caller change nothing", async () => {
    const forged = {
      "x-cos-principal": JSON.stringify({ kind: "staff", userId: admin.id, roles: ["admin"] }),
      "x-cos-user": admin.id,
      "x-cos-audience": "staff",
      "cf-access-authenticated-user-email": admin.email,
      "cf-access-jwt-assertion": "eyJhbGciOiJSUzI1NiJ9.eyJlbWFpbCI6ImFkbWluIn0.forged",
    };
    for (const name of staffOps) {
      expect(await call(name, {}, forged), name).toEqual(await call(name, {}));
    }
  });

  it("a staff device token is refused, and so is any bearer token", async () => {
    const staff = await issueDeviceSession(
      db,
      { audience: "staff", subjectId: admin.id },
      "Admin's tablet",
      new Date(),
    );
    const refused = await call(
      "organisation.list",
      {},
      {
        authorization: `Bearer ${staff.accessToken}`,
      },
    );
    expect(refused).toMatchObject({
      status: 401,
      body: { error: { code: "forbidden", details: { reason: "binding_takes_cookies_only" } } },
    });
    const account = await db.query
      .selectFrom("core_customer")
      .select("id")
      .where("person_id", "=", ada.personId)
      .executeTakeFirstOrThrow();
    const customer = await issueDeviceSession(
      db,
      { audience: "customer", subjectId: account.id },
      "Ada's phone",
      new Date(),
    );
    expect(
      (await call("me.get", {}, { authorization: `Bearer ${customer.accessToken}` })).status,
    ).toBe(401);
  });

  it("a company's own server checks a native app's customer with me.get on the host's public surface", async () => {
    // ADR 0421, amended 2026-11-21. The app signs in and exchanges its session for tokens
    // (ADR 0419). Its own server is sent the access token and asks the host who it is: me.get on
    // the public HTTPS surface with the token as a bearer credential. Not over the binding,
    // which takes cookies only.
    const HOST = "https://crm.test";
    const exchanged = await handleApi(
      new Request(`${HOST}/api/v1/auth/token`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie: ada.cookie },
        body: JSON.stringify({ deviceName: "Ada's phone" }),
      }),
      boundEnv,
    );
    expect(exchanged?.status, await exchanged?.clone().text()).toBe(200);
    if (!exchanged) throw new Error("no token route");
    const { accessToken } = ((await exchanged.json()) as { data: { accessToken: string } }).data;
    const asTheServer = (token: string) =>
      handleApi(
        new Request(`${HOST}/api/v1/op/me.get`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
          body: "{}",
        }),
        boundEnv,
      );
    const checked = await asTheServer(accessToken);
    expect(checked?.status).toBe(200);
    if (!checked) throw new Error("no surface");
    const me = ((await checked.json()) as { data: Record<string, unknown> }).data;
    // The address the emailed code verified: what the company links its own member records by.
    expect(me).toMatchObject({
      id: ada.personId,
      signInEmail: ada.email.toLowerCase(),
      signInEmailVerified: true,
    });
    // A token that is not a session's says nothing about anyone.
    const forged = await asTheServer(`${accessToken.slice(0, -4)}AAAA`);
    expect(forged?.status).toBe(401);
    // The binding still refuses the same token outright.
    expect(await call("me.get", {}, { authorization: `Bearer ${accessToken}` })).toMatchObject({
      status: 401,
      body: { error: { code: "forbidden", details: { reason: "binding_takes_cookies_only" } } },
    });
  });

  it("serves only the surface and customer sign-in: no staff UI, MCP or token routes", async () => {
    for (const [path, method] of [
      ["/", "GET"],
      ["/settings", "GET"],
      ["/mcp", "POST"],
      ["/api/auth/get-session", "GET"],
      ["/support/enter", "GET"],
    ] as const) {
      const response = await bound(path, { method, headers: { cookie: admin.cookie } });
      expect(response.status, path).toBe(404);
    }
    // A web app has no use for native tokens: the exchange is not served over the binding.
    const exchange = await bound("/api/v1/auth/token", {
      body: { deviceName: "Laptop" },
      headers: { cookie: ada.cookie },
    });
    expect(exchange.status).toBe(404);
  });
});

describe("a bound Worker can never act as a customer who has not signed in (criterion 3)", () => {
  it("sees only the signed-in customer's own rows", async () => {
    const other = await call(
      "my.get",
      { object: "person", id: bea.personId },
      { cookie: ada.cookie },
    );
    expect(other.status).toBe(404);
    expect(other.body.error.code).toBe("not_found");
    const own = await call("my.list", { object: "person" }, { cookie: ada.cookie });
    expect(own.body.data.items.map((r: { id: string }) => r.id)).toEqual([ada.personId]);
  });

  it("names no caller from the body or a header", async () => {
    const claims = {
      "x-cos-principal": JSON.stringify({ kind: "customer", personId: bea.personId }),
      "x-cos-customer": bea.personId,
    };
    const asHeader = await call("me.get", {}, { cookie: ada.cookie, ...claims });
    expect(asHeader.body.data.id).toBe(ada.personId);
    const noCookie = await call("me.get", {}, claims);
    expect(noCookie.status).toBe(404);
    // me.get takes no input: a caller in the body is not even accepted as input.
    const inBody = await call("my.get", {
      object: "person",
      id: bea.personId,
      principal: { kind: "customer", personId: bea.personId },
    });
    expect(inBody.status).toBe(404);
  });

  it("refuses another customer's session token without the host's signature", async () => {
    const beaToken = tokenOf(bea);
    const forgedCookies = [
      // The token alone, unsigned.
      `${cookieName(bea)}=${encodeURIComponent(beaToken)}`,
      // Signed with a secret the Worker guessed.
      `${cookieName(bea)}=${encodeURIComponent(`${beaToken}.${await sign(beaToken, "guess")}`)}`,
      // Ada's signature on Bea's token.
      `${cookieName(bea)}=${encodeURIComponent(`${beaToken}.${decodeURIComponent(ada.cookie).split(".").pop()}`)}`,
      // A token made up, signed with the staff secret.
      `${cookieName(bea)}=${encodeURIComponent(`made-up.${await sign("made-up", String(boundEnv.BETTER_AUTH_SECRET))}`)}`,
    ];
    for (const cookie of forgedCookies) {
      const me = await call("me.get", {}, { cookie });
      expect(me.status, cookie).toBe(404);
      const mine = await call("my.get", { object: "person", id: bea.personId }, { cookie });
      expect(mine.status, cookie).toBe(404);
    }
    // The real one, signed by the host, is Bea.
    expect((await call("me.get", {}, { cookie: bea.cookie })).body.data.id).toBe(bea.personId);
  });
});

describe("signing out and deleting the account end what the cookie can do", () => {
  it("signing out over the binding ends the session for that cookie", async () => {
    const cara = await newCustomer("Cara");
    expect((await call("me.get", {}, { cookie: cara.cookie })).status).toBe(200);
    const out = await bound("/api/customer-auth/sign-out", {
      body: {},
      headers: { cookie: cara.cookie, origin: WEB },
    });
    expect(out.status).toBe(200);
    // The web app passes the cleared cookie back to the browser.
    expect(out.headers.getSetCookie().join("\n")).toMatch(/cos-customer\.session_token=;/);
    expect((await call("me.get", {}, { cookie: cara.cookie })).status).toBe(404);
  });

  it("me.signOut over the binding does the same", async () => {
    const dan = await newCustomer("Dan");
    expect((await call("me.signOut", {}, { cookie: dan.cookie })).status).toBe(200);
    expect((await call("me.get", {}, { cookie: dan.cookie })).status).toBe(404);
  });

  it("deleting the account needs a recent sign-in, and an exchange keeps the sign-in's age (ADR 0712)", async () => {
    const fay = await newCustomer("Fay");
    // Fay signed in an hour ago (the session row's own start, which Better Auth wrote once).
    const anHourAgo = new Date(Date.now() - 3_600_000).toISOString();
    await env.DB.prepare("UPDATE core_customer_session SET created_at = ? WHERE token = ?")
      .bind(anHourAgo, tokenOf(fay))
      .run();
    const refused = await call("me.deleteAccount", {}, { cookie: fay.cookie });
    expect(refused.status, JSON.stringify(refused.body)).toBe(403);
    expect(refused.body.error).toMatchObject({
      code: "sign_in_again",
      details: { withinMinutes: 15 },
    });
    // Exchanged for an app's tokens, the session is still an hour old.
    const exchanged = await handleApi(
      new Request("https://crm.test/api/v1/auth/token", {
        method: "POST",
        headers: { "content-type": "application/json", cookie: fay.cookie },
        body: JSON.stringify({ deviceName: "Fay's phone" }),
      }),
      boundEnv,
    );
    expect(exchanged?.status).toBe(200);
    if (!exchanged) throw new Error("no token route");
    const { accessToken } = ((await exchanged.json()) as { data: { accessToken: string } }).data;
    const asTheApp = await handleApi(
      new Request("https://crm.test/api/v1/op/me.deleteAccount", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${accessToken}`,
          "idempotency-key": crypto.randomUUID(),
        },
        body: "{}",
      }),
      boundEnv,
    );
    expect(asTheApp?.status).toBe(403);
    if (!asTheApp) throw new Error("no surface");
    expect(((await asTheApp.json()) as { error: { code: string } }).error.code).toBe(
      "sign_in_again",
    );
    // Nothing was deleted.
    expect((await call("me.get", {}, { cookie: fay.cookie })).status).toBe(200);
  });

  it("deleting the account ends every session at once, and no new one starts", async () => {
    const eve = await newCustomer("Eve");
    const second = cookiesOf(await signIn(eve.email));
    const preview = await call("me.deleteAccount", {}, { cookie: eve.cookie });
    expect(preview.body.data).toMatchObject({ deleted: false });
    const deleted = await call(
      "me.deleteAccount",
      { confirm: true, expect: preview.body.data.expect },
      { cookie: eve.cookie },
    );
    expect(deleted.status, JSON.stringify(deleted.body)).toBe(200);
    for (const cookie of [eve.cookie, second]) {
      expect((await call("me.get", {}, { cookie })).status).toBe(404);
    }
    // A disabled account is sent no code: there is nothing to sign in with.
    codes.delete(eve.email.toLowerCase());
    await bound("/api/customer-auth/email-otp/send-verification-otp", {
      body: { email: eve.email, type: "sign-in" },
      headers: { origin: WEB },
    });
    expect(codes.has(eve.email.toLowerCase())).toBe(false);
  });
});

describe("cookies apart (criterion 4)", () => {
  it("the staff cookie is the host's, host-only", async () => {
    const response = await createIdentityProvider(boundEnv).handle?.(
      new Request(`${ORIGIN}/api/auth/sign-up/email`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: ORIGIN },
        body: JSON.stringify({
          email: `${unique("staff")}@example.com`,
          password: "correct-horse-battery",
          name: "Staff",
        }),
      }),
    );
    const cookies = response?.headers.getSetCookie() ?? [];
    expect(cookies.some((c) => c.includes("better-auth.session_token="))).toBe(true);
    for (const cookie of cookies) {
      expect(cookie).not.toMatch(/;\s*domain=/i);
      expect(cookie).not.toMatch(/cos-customer/);
    }
  });

  it("a browser on the host's own hostname cannot sign in as a customer there", async () => {
    // CUSTOMER_AUTH_URL names the web app, so Better Auth refuses a sign-in a page on the host's
    // address posts: no customer cookie is ever set beside the staff one. A native app sends no
    // Origin and still signs in at the host (stage 23's token exchange).
    const email = `${unique("fay")}@example.com`;
    await inviteCustomer(db, email, admin.id, new Date().toISOString());
    const fromHostPage = await handleCustomerAuth(
      new Request(`${ORIGIN}/api/customer-auth/email-otp/send-verification-otp`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: ORIGIN },
        body: JSON.stringify({ email, type: "sign-in" }),
      }),
      boundEnv,
    );
    expect(fromHostPage.status).toBe(403);
    expect(fromHostPage.headers.getSetCookie()).toEqual([]);
  });
});

describe("a customer stays signed in on the web app's hostname (the session helper)", () => {
  const DAY = 24 * 60 * 60 * 1000;
  const bindingFetch = (url: string, init: { method: string; headers: Record<string, string> }) =>
    handleBound(new Request(url, init), boundEnv);

  /** Moves a customer's session expiry by `ms`, as if that much time had passed (negative). */
  async function shiftExpiry(customer: Customer, to: (expires: number) => number) {
    const token = tokenOf(customer);
    const row = await env.DB.prepare("SELECT expires_at FROM core_customer_session WHERE token = ?")
      .bind(token)
      .first<{ expires_at: string | number }>();
    if (!row) throw new Error("no session row");
    const current =
      typeof row.expires_at === "number" ? row.expires_at : Date.parse(String(row.expires_at));
    const next = to(current);
    await env.DB.prepare("UPDATE core_customer_session SET expires_at = ? WHERE token = ?")
      .bind(typeof row.expires_at === "number" ? next : new Date(next).toISOString(), token)
      .run();
  }

  it("a session used on day 6 is still valid on day 8", async () => {
    const gil = await newCustomer("Gil");
    const maxAge = (cookie: string) => Number(/Max-Age=(\d+)/i.exec(cookie)?.[1]);
    // The cookie from sign-in lasts seven days: without a refresh the browser drops it on day 7.
    const first = (await signIn(gil.email)).headers.getSetCookie()[0] as string;
    expect(maxAge(first)).toBe(7 * 24 * 60 * 60);

    // Day 6: the session has a day left.
    await shiftExpiry(gil, () => Date.now() + DAY);
    const day6 = new Date();
    const refreshed = await keepCustomerSignedIn({
      cookieHeader: gil.cookie,
      fetch: bindingFetch,
      baseUrl: BOUND,
      now: day6,
    });
    expect(refreshed).toHaveLength(2);
    const [cookie, marker] = refreshed as [string, string];
    expect(cookie.startsWith(`${gil.cookie};`)).toBe(true);
    expect(cookie).toMatch(/HttpOnly/);
    // The host extended the session and the cookie now lasts as long: past day 8.
    expect(maxAge(cookie)).toBeGreaterThan(6.9 * 24 * 60 * 60);
    expect(marker).toMatch(/^cos-session-checked=\d+;/);

    // Later the same day the helper does nothing (once a day at most).
    const jar = `${gil.cookie}; ${marker.split(";")[0]}`;
    let asked = 0;
    const again = await keepCustomerSignedIn({
      cookieHeader: jar,
      fetch: (url, init) => {
        asked += 1;
        return bindingFetch(url, init);
      },
      baseUrl: BOUND,
      now: new Date(day6.getTime() + 60 * 60 * 1000),
    });
    expect(again).toEqual([]);
    expect(asked).toBe(0);

    // Day 8: two days on, the cookie the browser holds is still in date and still signs in.
    await shiftExpiry(gil, (expires) => expires - 2 * DAY);
    expect(maxAge(cookie) * 1000).toBeGreaterThan(2 * DAY);
    const me = await call("me.get", {}, { cookie: gil.cookie });
    expect(me.status).toBe(200);
    expect(me.body.data.id).toBe(gil.personId);
  });

  it("an ended session clears the cookie", async () => {
    const hal = await newCustomer("Hal");
    await shiftExpiry(hal, () => Date.now() - 1000);
    const cleared = await keepCustomerSignedIn({
      cookieHeader: hal.cookie,
      fetch: bindingFetch,
      baseUrl: BOUND,
    });
    expect(cleared.map((c) => c.split(";")[0])).toEqual([
      `${cookieName(hal)}=`,
      "cos-session-checked=",
    ]);
    expect(cleared.every((c) => /Max-Age=0/.test(c))).toBe(true);
  });

  it("does nothing without a customer cookie", async () => {
    expect(
      await keepCustomerSignedIn({
        cookieHeader: admin.cookie,
        fetch: bindingFetch,
        baseUrl: BOUND,
      }),
    ).toEqual([]);
  });
});
