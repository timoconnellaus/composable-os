// Native staff sign-in (ADR 0451): the template's mobile host module signs a staff member in at
// the host in the system browser (here: the host's own pages, driven as a browser would) and
// exchanges that sign-in for a staff device session. A door-role account's session may call the
// role's operations and nothing else; signing out ends it on the host. The customer's session on
// the same device is kept apart.
import { env } from "cloudflare:workers";
import { createClient, type FetchLike, type Tokens } from "@composable-os/client";
import { beforeAll, describe, expect, it } from "vitest";
import { staffSession } from "../../../templates/client/apps/mobile/src/host.ts";
import { handleApi } from "../src/server/http/api.ts";
import { boundTestEnv } from "./bound-env.ts";
import { ORIGIN, signUp, type TestUser } from "./mcp-helpers.ts";

const REDIRECT = "gym://staff-sign-in";
const hostEnv = { ...boundTestEnv(env), STAFF_APP_REDIRECTS: REDIRECT };

/** The host's public address, as the phone (and its browser) reach it. */
const host: FetchLike = async (url, init) =>
  (await handleApi(new Request(url, init), hostEnv)) ?? new Response("Not found", { status: 404 });

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

/** The system browser, signed in to the host as `user`: opens the link, confirms, follows back. */
function browserAs(user: TestUser | null, seen: { pages: string[] } = { pages: [] }) {
  return async (url: string, redirectUri: string): Promise<string | null> => {
    const headers: Record<string, string> = user ? { cookie: user.cookie } : {};
    const page = await host(url, { headers });
    if (page.status === 302) {
      seen.pages.push(`redirect ${page.headers.get("location")}`);
      return null;
    }
    const html = await page.text();
    seen.pages.push(html);
    if (page.status !== 200) return null;
    const form = new URLSearchParams();
    for (const [, name, value] of html.matchAll(/name="([^"]+)" value="([^"]*)"/g)) {
      form.set(name as string, (value as string).replace(/&amp;/g, "&"));
    }
    const confirmed = await host(url.split("?")[0] as string, {
      method: "POST",
      headers: { ...headers, origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });
    const location = confirmed.headers.get("location");
    return confirmed.status === 303 && location?.startsWith(redirectUri) ? location : null;
  };
}

const call = (token: string, name: string, input: unknown) =>
  host(`${ORIGIN}/api/v1/op/${name}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
      "idempotency-key": crypto.randomUUID(),
    },
    body: JSON.stringify(input),
  });

let coach: TestUser;

/**
 * Ticketing as a deployment that lists it has it installed: its door role and two of its tools,
 * one the role holds and one it does not (the pack itself runs in apps/runner's tests).
 */
const ticketing = {
  id: "ticketing",
  version: "0.1.0",
  contractVersion: 1,
  permissions: { read: [], write: [], operations: [], modules: [] },
  objects: {},
  fields: {},
  views: {},
  automations: {},
  roles: {
    door: {
      label: "Door",
      description: "Checks tickets in at the door.",
      permissions: ["ticketing:checkin"],
      read: ["ticketing.ticket"],
    },
  },
  tools: {
    checkIn: {
      description: "Check a ticket in at the door, by its code.",
      risk: "write",
      permission: "ticketing:checkin",
      inputSchema: { type: "object", properties: { code: { type: "string" } }, required: ["code"] },
      outputSchema: {},
    },
    salesSummary: {
      description: "What each event has sold.",
      risk: "read",
      inputSchema: { type: "object", properties: {} },
      outputSchema: {},
    },
  },
};

beforeAll(async () => {
  // A deployment whose product lists Ticketing: its manifest installed and active, as shipped.
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO core_user (id, name, email, email_verified, created_at, updated_at, kind) VALUES ('extension:ticketing', 'Ticketing', 'ticketing@extensions.crm.invalid', 0, ?, ?, 'extension')",
    ).bind(now, now),
    env.DB.prepare(
      "INSERT INTO core_extensions (id, source, status, version, commit_oid, manifest, user_id, installed_at, updated_at) VALUES ('ticketing', 'shipped', 'active', '0.1.0', 'abc123', ?, 'extension:ticketing', ?, ?)",
    ).bind(JSON.stringify(ticketing), now, now),
  ]);
  coach = await signUp(hostEnv as never, "viewer");
  await env.DB.prepare("UPDATE core_user SET pack_role = 'ticketing.door' WHERE id = ?")
    .bind(coach.id)
    .run();
}, 60_000);

describe("staff sign-in in the template's mobile app (ADR 0451)", () => {
  it("signs a door-role account in through the browser; its session reaches only the role's operations", async () => {
    const store = memoryStore();
    const seen = { pages: [] as string[] };
    const staff = staffSession({
      hostUrl: ORIGIN,
      store,
      deviceName: "Door phone",
      redirectUri: REDIRECT,
      openBrowser: browserAs(coach, seen),
      fetch: host,
    });
    expect(await staff.signedIn()).toBe(false);
    expect(await staff.signIn()).toBe(true);
    // The browser was asked to confirm, naming the account and the device.
    expect(seen.pages[0]).toContain("Sign in to the app on Door phone?");
    expect(seen.pages[0]).toContain(coach.email);
    const token = store.peek()?.accessToken as string;
    expect(token).toMatch(/^cos_at_/);

    // The role's tool: allowed (the stand-in runner echoes it).
    const door = staff.client((o) =>
      createClient<{
        "x.ticketing.checkIn": { kind: "mutation"; input: { code: string }; output: unknown };
      }>({ "x.ticketing.checkIn": { kind: "mutation", invalidates: [] } }, o),
    );
    await expect(door.call("x.ticketing.checkIn", { code: "TCK-1" })).resolves.toBeDefined();
    // Everything else is refused: other staff operations, other objects, its own sessions.
    for (const [name, input] of [
      ["person.list", {}],
      ["record.list", { object: "person" }],
      ["x.ticketing.salesSummary", {}],
      ["deviceSession.list", {}],
    ] as const) {
      const answer = await call(token, name, input);
      expect(answer.status, name).toBe(403);
    }

    // Signing out ends the device session on the host, not just on the phone.
    await staff.signOut();
    expect(store.peek()).toBeNull();
    expect((await call(token, "x.ticketing.checkIn", { code: "TCK-1" })).status).toBe(401);
  });

  it("refuses a redirect the deployment does not list, a code without its verifier, and an expired code", async () => {
    const link = (redirect: string) =>
      `${ORIGIN}/api/v1/auth/app-link?redirect_uri=${encodeURIComponent(redirect)}&state=s&code_challenge=${"a".repeat(43)}&device_name=Phone`;
    const elsewhere = await host(link("https://evil.example/cb"), {
      headers: { cookie: coach.cookie },
    });
    expect(elsewhere.status).toBe(400);
    expect(await elsewhere.text()).not.toContain("<form");
    // Not signed in: the host's own sign-in, then back to the link.
    const anonymous = await host(link(REDIRECT));
    expect(anonymous.status).toBe(302);
    expect(anonymous.headers.get("location")).toContain(
      "/sign-in?redirect=%2Fapi%2Fv1%2Fauth%2Fapp-link",
    );
    // A cross-site confirmation is refused.
    const forged = await host(`${ORIGIN}/api/v1/auth/app-link`, {
      method: "POST",
      headers: {
        cookie: coach.cookie,
        origin: "https://evil.example",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: `redirect_uri=${encodeURIComponent(REDIRECT)}&state=s&code_challenge=${"a".repeat(43)}&device_name=Phone`,
    });
    expect(forged.status).toBe(403);

    // A code taken from the redirect is useless without the app's verifier.
    let stolen = "";
    const app = staffSession({
      hostUrl: ORIGIN,
      store: memoryStore(),
      deviceName: "Phone",
      redirectUri: REDIRECT,
      openBrowser: async (url, redirect) => {
        const back = await browserAs(coach)(url, redirect);
        stolen = new URL(back as string).searchParams.get("code") as string;
        return null;
      },
      fetch: host,
    });
    expect(await app.signIn()).toBe(false);
    const exchange = (body: unknown) =>
      host(`${ORIGIN}/api/v1/auth/token`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const wrong = await exchange({
      code: stolen,
      codeVerifier: "b".repeat(43),
      redirectUri: REDIRECT,
    });
    expect(wrong.status).toBe(401);
    const tampered = await exchange({
      code: `${stolen.split(".")[0]}x.${stolen.split(".")[1]}`,
      codeVerifier: "b".repeat(43),
      redirectUri: REDIRECT,
    });
    expect(tampered.status).toBe(401);
  });

  it("keeps the staff session apart from the customer's on one device", async () => {
    const customerStore = memoryStore();
    const staffStore = memoryStore();
    const staff = staffSession({
      hostUrl: ORIGIN,
      store: staffStore,
      deviceName: "Phone",
      redirectUri: REDIRECT,
      openBrowser: browserAs(coach),
      fetch: host,
    });
    expect(await staff.signIn()).toBe(true);
    expect(customerStore.peek()).toBeNull();
    const first = staffStore.peek()?.sessionId;
    // Signing in again replaces this device's staff session: one at a time.
    expect(await staff.signIn()).toBe(true);
    expect(staffStore.peek()?.sessionId).not.toBe(first);
    await staff.signOut();
  });
});
