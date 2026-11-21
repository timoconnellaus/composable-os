// Stage 24, acceptance criterion 5: the template's mobile app signs in against a local host and
// shows the same record the web app does, with the same client package. Its host module
// (templates/client/apps/mobile/src/host.ts) runs here as the app runs it, over HTTP to the host's
// public routes (/api/customer-auth/*, /api/v1/*); only the secure store is a test's memory. The
// screens (App.tsx) and Expo itself are not run here: there is no simulator in this suite.
import { env } from "cloudflare:workers";
import { createIdentityProvider } from "@composable-os/auth";
import type { FetchLike, Tokens } from "@composable-os/client";
import { inviteCustomer } from "@composable-os/core";
import { createCrmDb } from "@composable-os/db";
import { beforeAll, describe, expect, it } from "vitest";
import { hostSession, type SecureRandom } from "../../../templates/client/apps/mobile/src/host.ts";
import { handleApi, handleCustomerAuth } from "../src/server/http/api.ts";
import { runOperation } from "../src/server/operations.ts";
import { boundTestEnv, sentCodes } from "./bound-env.ts";
import { ORIGIN, signUp, type TestUser, unique } from "./mcp-helpers.ts";

const hostEnv = boundTestEnv(env);
const db = createCrmDb(env.DB);
let admin: TestUser;

const random: SecureRandom = {
  bytes: (n) => crypto.getRandomValues(new Uint8Array(n)),
  sha256: async (text) =>
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))),
};

const post = (url: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

/**
 * The host's public address, as the phone reaches it. The customer token routes are the identity
 * branch's (ADR 0455); until it merges, a stand-in answers as ADR 0455 fixes them, made of the
 * host's real parts: the customer sign-in by code, then the real /api/v1/auth/token exchange.
 */
const host: FetchLike = async (url, init) => {
  const { pathname } = new URL(url);
  const body = init?.body ? JSON.parse(String(init.body)) : {};
  if (pathname === "/api/v1/auth/customer/code") {
    await handleCustomerAuth(
      post(`${ORIGIN}/api/customer-auth/email-otp/send-verification-otp`, {
        email: body.email,
        type: "sign-in",
      }),
      hostEnv,
    );
    return Response.json({ data: { ok: true } });
  }
  if (pathname === "/api/v1/auth/customer/sign-in") {
    const signedIn = await handleCustomerAuth(
      post(`${ORIGIN}/api/customer-auth/sign-in/email-otp`, { email: body.email, otp: body.code }),
      hostEnv,
    );
    const cookie = signedIn.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");
    if (signedIn.status !== 200 || !cookie) {
      return Response.json(
        {
          error: {
            code: "forbidden",
            message: "That code did not work",
            details: { reason: "invalid_code" },
          },
        },
        { status: 401 },
      );
    }
    const tokens = (await handleApi(
      post(`${ORIGIN}/api/v1/auth/token`, { deviceName: body.deviceName }, { cookie }),
      hostEnv,
    )) as Response;
    const { data } = (await tokens.json()) as { data: Record<string, unknown> };
    return Response.json({ data: { ...data, account: "ready" } });
  }
  return (
    (await handleApi(new Request(url, init), hostEnv)) ?? new Response("Not found", { status: 404 })
  );
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

beforeAll(async () => {
  admin = await signUp(hostEnv as never, "admin");
}, 60_000);

describe("the template's mobile app against a local host", () => {
  it("signs in with an emailed code, keeps a device session and shows the customer's record", async () => {
    const email = `${unique("ada")}@example.com`;
    const principal = await createIdentityProvider(hostEnv as never).resolve(
      new Request(ORIGIN, { headers: { cookie: admin.cookie } }),
    );
    const made = await runOperation(hostEnv as never, principal, {
      name: "person.create",
      input: { givenName: "Ada", familyName: "Lovelace", emails: [{ email }] },
    });
    if (!made.ok) throw new Error(JSON.stringify(made));
    await inviteCustomer(db, email, admin.id, new Date().toISOString());

    const store = memoryStore();
    const app = hostSession({
      hostUrl: ORIGIN,
      store,
      deviceName: "Ada's phone",
      random,
      fetch: host,
    });
    expect(await app.signedIn()).toBe(false);
    expect(await app.requestCode(email)).toBe(true);
    const code = sentCodes.get(email.toLowerCase());
    expect(code).toMatch(/^\d{6}$/);
    expect(await app.signIn(email, code as string)).toBe(true);
    // The phone keeps tokens, not the sign-in's cookie.
    expect(store.peek()?.accessToken).toMatch(/^cos_at_/);
    expect(JSON.stringify(store.peek())).not.toContain("cos-customer");

    // The same record the web app's account page shows.
    const me = await app.api.call("me.get", {});
    expect(me).toMatchObject({ id: (made.data as { id: string }).id, displayName: "Ada Lovelace" });
    const sessions = await app.api.call("me.sessions.list", {});
    expect(sessions.items).toContainEqual(
      expect.objectContaining({ deviceName: "Ada's phone", current: true }),
    );

    // Signing out ends the device session on the host, not just on the phone.
    const token = store.peek()?.accessToken as string;
    await app.signOut();
    expect(store.peek()).toBeNull();
    const after = await host(`${ORIGIN}/api/v1/op/me.get`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: "{}",
    });
    expect(after.status).toBe(401);
  });

  it("refuses a wrong code and keeps nothing", async () => {
    const store = memoryStore();
    const app = hostSession({ hostUrl: ORIGIN, store, deviceName: "Phone", random, fetch: host });
    expect(await app.signIn(`${unique("nobody")}@example.com`, "000000")).toBe(false);
    expect(store.peek()).toBeNull();
  });
  // The same client package and generated client as the web app: both templates' customer.ts
  // are held to the generator's one output by packages/client-gen/test/targets.test.ts.
});
