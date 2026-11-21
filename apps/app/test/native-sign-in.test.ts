// Native sign-in that answers with tokens (ADR 0455), against the real host routes with real D1,
// Better Auth and the operations pipeline. The phone here is the stand-in a React Native app is:
// no cookie jar, a `fetch` that cannot read `set-cookie`, and the runtime client given what the
// app passes in. Any request that sends a cookie, and any answer that sets one, fails the test.
//
// - A customer signs in with an emailed code and calls an operation; no cookie is ever set.
// - A staff account invited with a pack role does the same and is refused everything but the
//   role's operations; it signs itself out with its refresh token, and its access token stops
//   working at once.
// - Staff whose sign-in is browser-based use the system-browser handoff.
// - Disabling a staff account ends its device sessions too.
// - The browser cookie flow is unchanged.
import { env } from "cloudflare:workers";
import { createIdentityProvider, provideStaffCodes } from "@composable-os/auth";
import {
  ApiError,
  type FetchLike,
  startBrowserSignIn,
  type Tokens,
  tokenSession,
} from "@composable-os/client";
import { inviteCustomer } from "@composable-os/core";
import { createCrmDb } from "@composable-os/db";
import { beforeAll, describe, expect, it } from "vitest";
import { handleApi, handleCustomerAuth } from "../src/server/http/api.ts";
import { handleNativeStaffSignIn } from "../src/server/http/native.ts";
import { runOperation } from "../src/server/operations.ts";
import { boundTestEnv, sentCodes } from "./bound-env.ts";
import { ORIGIN, signUp, type TestUser, unique } from "./mcp-helpers.ts";

const hostEnv = boundTestEnv(env);
const db = createCrmDb(env.DB);
let admin: TestUser;

/** Staff codes the host would have emailed, by address. */
const staffCodes = new Map<string, string>();
provideStaffCodes(hostEnv, {
  send: async ({ to, code }) => {
    staffCodes.set(to.toLowerCase(), code);
  },
  ready: async () => null,
});

/** The host's public address: sign-in, the HTTP surface and the staff handoff page. */
async function host(request: Request, e = hostEnv): Promise<Response> {
  const { pathname } = new URL(request.url);
  if (pathname.startsWith("/api/customer-auth/")) return handleCustomerAuth(request, e);
  if (pathname === "/native/staff-sign-in") return handleNativeStaffSignIn(request, e);
  return (await handleApi(request, e)) ?? new Response("Not found", { status: 404 });
}

/** Every cookie a native request sent or an answer set, which must stay empty. */
const cookies: string[] = [];

/** The phone's fetch: no cookie jar, and `set-cookie` cannot be read (React Native's may not). */
const phone: FetchLike = async (url, init) => {
  for (const [name, value] of Object.entries(init.headers)) {
    if (name.toLowerCase() === "cookie") cookies.push(`sent ${value}`);
  }
  const response = await host(new Request(url, init));
  for (const set of response.headers.getSetCookie()) cookies.push(`set ${set}`);
  const text = await response.text();
  return {
    status: response.status,
    headers: {
      get: (name) => (name.toLowerCase() === "set-cookie" ? null : response.headers.get(name)),
    },
    text: async () => text,
  };
};

function memoryStore() {
  let saved: Tokens | null = null;
  return {
    load: async () => saved,
    save: async (tokens: Tokens | null) => {
      saved = tokens;
    },
    peek: () => saved,
  };
}

/** One call over the surface with a bearer token, as the generated client makes it. */
async function call(token: string, name: string, input: unknown = {}) {
  const response = await host(
    new Request(`${ORIGIN}/api/v1/op/${name}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
        "idempotency-key": crypto.randomUUID(),
      },
      body: JSON.stringify(input),
    }),
  );
  // biome-ignore lint/suspicious/noExplicitAny: a test reads whatever the envelope holds
  return { status: response.status, body: (await response.json()) as Record<string, any> };
}

async function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  const response = await host(
    new Request(`${ORIGIN}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    }),
  );
  return {
    status: response.status,
    setCookie: response.headers.getSetCookie(),
    // biome-ignore lint/suspicious/noExplicitAny: a test reads whatever the envelope holds
    body: (await response.json()) as Record<string, any>,
  };
}

async function asAdmin(name: string, input: unknown) {
  const principal = await createIdentityProvider(hostEnv as never).resolve(
    new Request(ORIGIN, { headers: { cookie: admin.cookie } }),
  );
  const result = await runOperation(hostEnv as never, principal, { name, input }, ORIGIN);
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  // biome-ignore lint/suspicious/noExplicitAny: a test reads whatever the operation returns
  return result.data as any;
}

/** A shipped pack with one tool its door role holds and one it does not. */
const DOOR_PACK = {
  id: "doorfix",
  label: "Door fixture",
  version: "1.0.0",
  contractVersion: 1,
  objects: {},
  tools: {
    scan: {
      description: "Fixture: scans a ticket at the door.",
      risk: "write",
      permission: "doorfix:scan",
      inputSchema: { type: "object" },
      outputSchema: {},
    },
    sales: {
      description: "Fixture: the takings so far.",
      risk: "read",
      inputSchema: { type: "object" },
      outputSchema: {},
    },
  },
  roles: {
    door: {
      label: "Door",
      description: "Scans tickets, nothing else",
      permissions: ["doorfix:scan"],
      read: [],
    },
  },
};

beforeAll(async () => {
  admin = await signUp(hostEnv as never, "admin");
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT OR IGNORE INTO core_extensions (id, source, status, version, commit_oid, manifest,
       user_id, installed_at, updated_at) VALUES ('doorfix', 'shipped', 'active', '1.0.0', 'c1', ?, ?, ?, ?)`,
  )
    .bind(JSON.stringify(DOOR_PACK), admin.id, now, now)
    .run();
}, 60_000);

describe("a customer signs in natively and never holds a cookie", () => {
  it("asks for a code, signs in with it and calls an operation", async () => {
    cookies.length = 0;
    const email = `${unique("ada")}@example.com`;
    await asAdmin("person.create", {
      givenName: "Ada",
      familyName: "Lovelace",
      emails: [{ email }],
    });
    await inviteCustomer(db, email, admin.id, new Date().toISOString());
    const store = memoryStore();
    const session = tokenSession({ baseUrl: ORIGIN, store, fetch: phone });
    await session.requestCode(email);
    const code = sentCodes.get(email.toLowerCase()) as string;
    const signedIn = await session.signInWithCode(email, code, "Ada's phone");
    expect(signedIn).toMatchObject({
      account: "ready",
      accessToken: expect.stringMatching(/^cos_at_/),
    });
    expect(store.peek()).not.toHaveProperty("account");

    const headers = await session.headers();
    const me = await call(headers.authorization?.slice(7) as string, "me.get");
    expect(me.body.data).toMatchObject({ displayName: "Ada Lovelace" });
    // No browser session was left behind for the phone's sign-in.
    const browser = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM core_customer_session WHERE customer_id = (SELECT id FROM core_customer WHERE email = ?)",
    )
      .bind(email.toLowerCase())
      .first<{ n: number }>();
    expect(browser?.n).toBe(0);

    // A second use of the code is refused like any wrong code.
    await expect(session.signInWithCode(email, code, "Again")).rejects.toMatchObject({
      code: "forbidden",
      status: 401,
      details: { reason: "invalid_code" },
    });
    expect(cookies).toEqual([]);
  });

  it("answers the same for an address nobody has, and refuses a wrong code the same way", async () => {
    cookies.length = 0;
    const session = tokenSession({ baseUrl: ORIGIN, store: memoryStore(), fetch: phone });
    const nobody = `${unique("nobody")}@example.com`;
    await session.requestCode(nobody);
    expect(sentCodes.has(nobody)).toBe(false);
    const refused = await session.signInWithCode(nobody, "123456", "Phone").catch((e) => e);
    expect(refused).toBeInstanceOf(ApiError);
    expect(refused).toMatchObject({ status: 401, details: { reason: "invalid_code" } });
    expect(cookies).toEqual([]);
  });

  it("never sets a cookie, even for a request that carries one, and refuses a bearer token", async () => {
    const email = `${unique("both")}@example.com`;
    await inviteCustomer(db, email, admin.id, new Date().toISOString());
    await post("/api/v1/auth/customer/code", { email });
    const answer = await post(
      "/api/v1/auth/customer/sign-in",
      { email, code: sentCodes.get(email.toLowerCase()), deviceName: "Phone" },
      { cookie: admin.cookie },
    );
    expect(answer.status).toBe(200);
    expect(answer.setCookie).toEqual([]);
    expect(answer.body.data.refreshToken).toMatch(/^cos_rt_/);
    const bearer = await post(
      "/api/v1/auth/customer/code",
      { email },
      { authorization: `Bearer ${answer.body.data.accessToken}` },
    );
    expect(bearer.status).toBe(400);
  });
});

describe("the browser cookie flow is unchanged", () => {
  it("answers with a cookie and no tokens", async () => {
    const email = `${unique("web")}@example.com`;
    await inviteCustomer(db, email, admin.id, new Date().toISOString());
    const asked = await post(
      "/api/customer-auth/email-otp/send-verification-otp",
      { email, type: "sign-in" },
      { origin: "https://shop.test" },
    );
    expect(asked.status).toBe(200);
    const signedIn = await post(
      "/api/customer-auth/sign-in/email-otp",
      { email, otp: sentCodes.get(email.toLowerCase()) },
      { origin: "https://shop.test" },
    );
    expect(signedIn.status).toBe(200);
    expect(signedIn.setCookie.join(";")).toContain("cos-customer.session_token");
    expect(signedIn.body).not.toHaveProperty("accessToken");
    expect(signedIn.body).not.toHaveProperty("refreshToken");
  });
});

describe("a door account signs in natively", () => {
  let coachEmail = "";
  const store = memoryStore();
  const session = tokenSession({ baseUrl: ORIGIN, store, fetch: phone });

  beforeAll(async () => {
    coachEmail = `${unique("coach")}@example.com`;
    const invited = await asAdmin("user.invite", {
      email: coachEmail,
      role: "member",
      packRole: "doorfix.door",
    });
    expect(invited).toMatchObject({ role: "viewer", packRole: "doorfix.door", signIn: "code" });
  });

  it("signs in by code with no cookie and holds only the role's operations", async () => {
    cookies.length = 0;
    await session.requestCode(coachEmail, "staff");
    const code = staffCodes.get(coachEmail.toLowerCase()) as string;
    expect(code).toMatch(/^\d{6}$/);
    const tokens = await session.signInWithCode(coachEmail, code, "Door phone", "staff");
    const row = await db.query
      .selectFrom("core_user")
      .select(["id", "role", "pack_role"])
      .where("email", "=", coachEmail.toLowerCase())
      .executeTakeFirstOrThrow();
    expect(row).toMatchObject({ role: "viewer", pack_role: "doorfix.door" });
    const browser = await db.query
      .selectFrom("core_session")
      .select("id")
      .where("user_id", "=", row.id)
      .execute();
    expect(browser).toEqual([]);

    const token = tokens.accessToken;
    expect((await call(token, "x.doorfix.scan", { ticket: "t1" })).body.data).toMatchObject({
      tool: "scan",
    });
    for (const name of [
      "x.doorfix.sales",
      "person.list",
      "user.list",
      "user.invite",
      "policy.get",
    ]) {
      const refused = await call(token, name, {});
      expect(refused.body.error?.code, name).toBe("forbidden");
    }
    expect(cookies).toEqual([]);
  });

  it("signs itself out with its refresh token, and its access token stops at once", async () => {
    const before = store.peek() as Tokens;
    // The door role may not call deviceSession.revoke or me.signOut.
    expect(
      (await call(before.accessToken, "deviceSession.revoke", { id: before.sessionId })).body.error
        ?.code,
    ).toBe("forbidden");
    await session.signOut();
    expect(store.peek()).toBeNull();
    const after = await call(before.accessToken, "x.doorfix.scan", {});
    expect(after.status).toBe(401);
    expect(after.body.error.details.reason).toBe("token_invalid");
    // The refresh token is spent.
    const refreshed = await post("/api/v1/auth/refresh", { refreshToken: before.refreshToken });
    expect(refreshed.status).toBe(401);
    const audit = await db.query
      .selectFrom("core_audit")
      .select(["operation", "actor", "user_id"])
      .where("operation", "=", "deviceSession.signOut")
      .where("input", "like", `%${before.sessionId}%`)
      .executeTakeFirst();
    expect(audit).toMatchObject({ actor: "human" });
  });

  it("an unknown or already spent token gets the same answer", async () => {
    for (const refreshToken of ["cos_rt_nothing", "cos_rt_dvs_01KA8ZQ7Y2V3N4M5P6R7S8T9W0.x", "x"]) {
      const answer = await post("/api/v1/auth/sign-out", { refreshToken });
      expect(answer).toMatchObject({ status: 200, body: { data: { ok: true } }, setCookie: [] });
    }
  });
});

describe("disabling a staff account ends its device sessions", () => {
  it("reactivating does not bring an old device session back", async () => {
    const member = await signUp(hostEnv as never, "member");
    const exchanged = await post(
      "/api/v1/auth/token",
      { deviceName: "Laptop" },
      { cookie: member.cookie },
    );
    const { refreshToken } = exchanged.body.data as Tokens;
    await asAdmin("user.deactivate", { id: member.id });
    await asAdmin("user.reactivate", { id: member.id });
    const refreshed = await post("/api/v1/auth/refresh", { refreshToken });
    expect(refreshed.status).toBe(401);
    expect(refreshed.body.error.details.reason).toBe("session_ended");
  });
});

describe("browser-based staff sign-in hands the app a code (system browser)", () => {
  const REDIRECT = "gymapp://signed-in";
  const browserEnv = { ...hostEnv, NATIVE_REDIRECT_URIS: `${REDIRECT}, other://x` };
  /** The app's crypto, passed in: React Native has none of its own. */
  const sha256 = async (text: string) =>
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  let n = 0;
  const randomKey = () => `k${++n}-0123456789abcdefghijklmnopqrstuvwxyz`;

  const open = (url: string, cookie?: string) =>
    host(new Request(url, { headers: cookie ? { cookie } : {} }), browserEnv as never);

  it("signs in, exchanges the code once, and refuses a wrong verifier or address", async () => {
    const start = await startBrowserSignIn({
      hostUrl: ORIGIN,
      redirectUri: REDIRECT,
      randomKey,
      sha256,
    });
    // Signed out, the browser is sent to sign in first.
    const signedOut = await open(start.url);
    expect(signedOut.status).toBe(302);
    expect(signedOut.headers.get("location")).toContain("/sign-in?redirect=");

    const back = await open(start.url, admin.cookie);
    expect(back.status).toBe(302);
    const callbackUrl = back.headers.get("location") as string;
    expect(callbackUrl.startsWith(`${REDIRECT}?code=cos_hc_`)).toBe(true);

    const store = memoryStore();
    const session = tokenSession({ baseUrl: ORIGIN, store, fetch: phone });
    await expect(
      session.finishBrowserSignIn({
        callbackUrl,
        state: "not-the-state",
        verifier: start.verifier,
        redirectUri: REDIRECT,
        deviceName: "Admin's phone",
      }),
    ).rejects.toMatchObject({ details: { reason: "invalid_code" } });
    const tokens = await session.finishBrowserSignIn({
      callbackUrl,
      state: start.state,
      verifier: start.verifier,
      redirectUri: REDIRECT,
      deviceName: "Admin's phone",
    });
    expect((await call(tokens.accessToken, "user.list", {})).status).toBe(200);
    // Spent.
    await expect(
      session.finishBrowserSignIn({
        callbackUrl,
        state: start.state,
        verifier: start.verifier,
        redirectUri: REDIRECT,
        deviceName: "Again",
      }),
    ).rejects.toMatchObject({ details: { reason: "invalid_code" } });

    // A code exchanged with another verifier, or for another address, is spent and refused.
    for (const wrong of [
      { verifier: "x".repeat(43), redirectUri: REDIRECT },
      { verifier: undefined, redirectUri: "other://x" },
    ]) {
      const again = await startBrowserSignIn({
        hostUrl: ORIGIN,
        redirectUri: REDIRECT,
        randomKey,
        sha256,
      });
      const location = (await open(again.url, admin.cookie)).headers.get("location") as string;
      const code = new URL(location).searchParams.get("code");
      const refused = await post("/api/v1/auth/staff/exchange", {
        code,
        codeVerifier: wrong.verifier ?? again.verifier,
        redirectUri: wrong.redirectUri,
        deviceName: "X",
      });
      expect(refused.status).toBe(401);
      const retried = await post("/api/v1/auth/staff/exchange", {
        code,
        codeVerifier: again.verifier,
        redirectUri: REDIRECT,
        deviceName: "X",
      });
      expect(retried.status).toBe(401);
    }
    expect(cookies).toEqual([]);
  });

  it("never sends a code to an address the deployment does not list", async () => {
    const start = await startBrowserSignIn({
      hostUrl: ORIGIN,
      redirectUri: "evil://steal",
      randomKey,
      sha256,
    });
    const answer = await open(start.url, admin.cookie);
    expect(answer.status).toBe(400);
    expect(answer.headers.get("location")).toBeNull();
    // Unset, the page is not there at all.
    const unset = await host(new Request(start.url, { headers: { cookie: admin.cookie } }));
    expect(unset.status).toBe(404);
  });
});
