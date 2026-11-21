// Stage 24, acceptance criterion 5: the template's mobile app signs in against a local host and
// shows the same record the web app does, with the same client package. Its host module
// (templates/client/apps/mobile/src/host.ts) runs here as the app runs it, over HTTP to the host's
// native sign-in routes (/api/v1/auth/customer/*, ADR 0455) and the surface (/api/v1/*); only the secure store is a test's memory. The
// screens (App.tsx) and Expo itself are not run here: there is no simulator in this suite.
import { env } from "cloudflare:workers";
import { createIdentityProvider } from "@composable-os/auth";
import type { FetchLike, Tokens } from "@composable-os/client";
import { inviteCustomer } from "@composable-os/core";
import { createCrmDb } from "@composable-os/db";
import { beforeAll, describe, expect, it } from "vitest";
import {
  hostSession,
  mediaUrlFor,
  type SecureRandom,
} from "../../../templates/client/apps/mobile/src/host.ts";
import { handleApi } from "../src/server/http/api.ts";
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

/** Every cookie the phone sent or an answer set: both must stay empty (ADR 0455). */
const cookies: string[] = [];

/**
 * The host's public address, as the phone reaches it: the HTTP surface, whose native sign-in
 * routes (`/api/v1/auth/customer/*`, `/api/v1/auth/sign-out`) answer with tokens and no cookie.
 */
const host: FetchLike = async (url, init) => {
  for (const [name, value] of Object.entries(init.headers)) {
    if (name.toLowerCase() === "cookie") cookies.push(`sent ${value}`);
  }
  const response =
    (await handleApi(new Request(url, init), hostEnv)) ??
    new Response("Not found", { status: 404 });
  for (const set of response.headers.getSetCookie()) cookies.push(`set ${set}`);
  return response;
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
    // No cookie, sent or set, at any step.
    expect(cookies).toEqual([]);
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

describe("the template's mobile app asks the host for pictures (issue #181)", () => {
  it("at the host's public media route, beside the HTTP surface", () => {
    const url = mediaUrlFor({ hostUrl: "https://admin.example.com/" });
    expect(url("med_01ABC", 750)).toBe("https://admin.example.com/api/v1/media/med_01ABC?w=750");
  });
});
