// Staff in the company's mobile app (ADR 0451): the template's mobile host module signs a staff
// member in and keeps the staff session apart from the customer's, and a door-role account's
// device session reaches the role's operations and nothing else, over the real HTTP surface.
//
// The staff token routes are the identity branch's (ADR 0455). Until it merges, this host serves
// them through a stand-in that answers as ADR 0455 fixes them, made of the host's real parts: the
// sign-in a browser would make (Better Auth's cookie) exchanged at the real /api/v1/auth/token.
// Everything after sign-in is the real host.
import { env } from "cloudflare:workers";
import { createClient, type FetchLike, type Tokens } from "@composable-os/client";
import { beforeAll, describe, expect, it } from "vitest";
import { type SecureRandom, staffSession } from "../../../templates/client/apps/mobile/src/host.ts";
import { handleApi } from "../src/server/http/api.ts";
import { boundTestEnv } from "./bound-env.ts";
import { ORIGIN, signUp, type TestUser } from "./mcp-helpers.ts";

const REDIRECT = "gym://staff-sign-in";
const hostEnv = boundTestEnv(env);
const random: SecureRandom = {
  bytes: (n) => crypto.getRandomValues(new Uint8Array(n)),
  sha256: async (text) =>
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))),
};

let coach: TestUser;
/** The staff accounts the stand-in knows, by address: the cookie their browser sign-in made. */
const browsers = new Map<string, TestUser>();
/** Codes the stand-in "emailed". */
const codes = new Map<string, string>();
/** Browser handoffs: code → who, and the challenge it is bound to. */
const handoffs = new Map<string, { user: TestUser; challenge: string; redirect: string }>();

const envelope = (data: unknown, status = 200) =>
  Response.json(status === 200 ? { data } : { error: data }, { status });
const invalidCode = () =>
  envelope(
    { code: "forbidden", message: "That code did not work", details: { reason: "invalid_code" } },
    401,
  );

async function exchange(user: TestUser, deviceName: string): Promise<Response> {
  const answer = await handleApi(
    new Request(`${ORIGIN}/api/v1/auth/token`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: user.cookie },
      body: JSON.stringify({ deviceName }),
    }),
    hostEnv,
  );
  return answer as Response;
}

/** The host's public address, as the phone (and its browser) reach it. */
const host: FetchLike = async (url, init) => {
  const { pathname, searchParams } = new URL(url);
  const body = init?.body ? JSON.parse(String(init.body)) : {};
  // The stand-in for ADR 0455's staff routes.
  if (pathname === "/api/v1/auth/staff/code") {
    if (browsers.has(body.email)) codes.set(body.email, "123456");
    return envelope({ ok: true });
  }
  if (pathname === "/api/v1/auth/staff/sign-in") {
    const user = browsers.get(body.email);
    if (!user || codes.get(body.email) !== body.code) return invalidCode();
    codes.delete(body.email);
    return exchange(user, body.deviceName);
  }
  if (pathname === "/native/staff-sign-in") {
    const code = crypto.randomUUID();
    handoffs.set(code, {
      user: coach,
      challenge: searchParams.get("code_challenge") as string,
      redirect: searchParams.get("redirect_uri") as string,
    });
    return new Response(null, {
      status: 302,
      headers: {
        location: `${searchParams.get("redirect_uri")}?code=${code}&state=${searchParams.get("state")}`,
      },
    });
  }
  if (pathname === "/api/v1/auth/staff/exchange") {
    const handoff = handoffs.get(body.code);
    handoffs.delete(body.code);
    const challenge = await random.sha256(body.codeVerifier);
    const b64 = btoa(String.fromCharCode(...challenge))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    if (!handoff || handoff.challenge !== b64 || handoff.redirect !== body.redirectUri) {
      return invalidCode();
    }
    return exchange(handoff.user, body.deviceName);
  }
  return (
    (await handleApi(new Request(url, init), hostEnv)) ?? new Response("Not found", { status: 404 })
  );
};

/** The system browser: follows the host's redirect back to the app. */
const browser = async (url: string) => {
  const answer = await host(url, { method: "GET", headers: {} });
  return answer.status === 302 ? answer.headers.get("location") : null;
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
  browsers.set(coach.email, coach);
  await env.DB.prepare("UPDATE core_user SET pack_role = 'ticketing.door' WHERE id = ?")
    .bind(coach.id)
    .run();
}, 60_000);

const door = (staff: ReturnType<typeof staffSession>) =>
  staff.client((o) =>
    createClient<{
      "x.ticketing.checkIn": { kind: "mutation"; input: { code: string }; output: unknown };
    }>({ "x.ticketing.checkIn": { kind: "mutation", invalidates: [] } }, o),
  );

describe("staff sign-in in the template's mobile app (ADR 0451)", () => {
  it("signs a door-role account in by code; its session reaches only the role's operations", async () => {
    const store = memoryStore();
    const staff = staffSession({
      hostUrl: ORIGIN,
      store,
      deviceName: "Door phone",
      random,
      fetch: host,
    });
    expect(await staff.signedIn()).toBe(false);
    await staff.requestCode(coach.email);
    expect(await staff.signIn(coach.email, "000000")).toBe(false);
    expect(await staff.signIn(coach.email, "123456")).toBe(true);
    const token = store.peek()?.accessToken as string;
    expect(token).toMatch(/^cos_at_/);

    // The role's tool, through a role client: allowed (the stand-in runner echoes it).
    await expect(door(staff).call("x.ticketing.checkIn", { code: "TCK-1" })).resolves.toBeDefined();
    // Everything else is refused: other staff operations, other objects, its own sessions.
    for (const [name, input] of [
      ["person.list", {}],
      ["record.list", { object: "person" }],
      ["x.ticketing.salesSummary", {}],
      ["deviceSession.list", {}],
    ] as const) {
      expect((await call(token, name, input)).status, name).toBe(403);
    }
    await staff.signOut();
    expect(store.peek()).toBeNull();
  });

  it("signs in through the system browser with a PKCE verifier only the app holds", async () => {
    const store = memoryStore();
    let opened = "";
    const staff = staffSession({
      hostUrl: ORIGIN,
      store,
      deviceName: "Door phone",
      random,
      redirectUri: REDIRECT,
      openBrowser: async (url) => {
        opened = url;
        return browser(url);
      },
      fetch: host,
    });
    expect(await staff.signInWithBrowser()).toBe(true);
    const link = new URL(opened);
    expect(link.pathname).toBe("/native/staff-sign-in");
    expect(link.searchParams.get("redirect_uri")).toBe(REDIRECT);
    expect(link.searchParams.get("code_challenge_method")).toBe("S256");
    expect(link.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    await expect(door(staff).call("x.ticketing.checkIn", { code: "TCK-2" })).resolves.toBeDefined();
    // A code that came back with another state is not taken.
    const other = staffSession({
      hostUrl: ORIGIN,
      store: memoryStore(),
      deviceName: "Phone",
      random,
      redirectUri: REDIRECT,
      openBrowser: async (url) =>
        (await browser(url))?.replace(/state=[^&]+/, "state=forged") ?? null,
      fetch: host,
    });
    expect(await other.signInWithBrowser()).toBe(false);
    await staff.signOut();
  });

  it("keeps one staff session on the device, apart from the customer's", async () => {
    const customerStore = memoryStore();
    const staffStore = memoryStore();
    const staff = staffSession({
      hostUrl: ORIGIN,
      store: staffStore,
      deviceName: "Phone",
      random,
      fetch: host,
    });
    await staff.requestCode(coach.email);
    expect(await staff.signIn(coach.email, "123456")).toBe(true);
    const first = staffStore.peek()?.sessionId;
    await staff.requestCode(coach.email);
    expect(await staff.signIn(coach.email, "123456")).toBe(true);
    expect(staffStore.peek()?.sessionId).not.toBe(first);
    expect(customerStore.peek()).toBeNull();
    await staff.signOut();
  });

  // Waits on the identity branch (ADR 0455): tokenSession.signOut() will call
  // POST /api/v1/auth/sign-out, which ends the device session on the host. Until then signOut
  // only forgets the tokens on the phone.
  it.todo("signing out ends the staff device session on the host");
});
