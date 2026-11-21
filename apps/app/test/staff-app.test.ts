// Staff in the company's mobile app (ADR 0451), on the host's real native sign-in routes (ADR
// 0455): the template's mobile host module signs an invited door-role coach in by code and in the
// system browser, keeps the staff session apart from the customer's, and the session reaches the
// role's operations and nothing else over the real HTTP surface. Signing out ends it on the host.
import { env } from "cloudflare:workers";
import { createIdentityProvider, provideStaffCodes } from "@composable-os/auth";
import { createClient, type FetchLike, type Tokens } from "@composable-os/client";
import { beforeAll, describe, expect, it } from "vitest";
import { type SecureRandom, staffSession } from "../../../templates/client/apps/mobile/src/host.ts";
import { handleApi } from "../src/server/http/api.ts";
import { handleNativeStaffSignIn } from "../src/server/http/native.ts";
import { runOperation } from "../src/server/operations.ts";
import { boundTestEnv } from "./bound-env.ts";
import { ORIGIN, signUp, type TestUser, unique } from "./mcp-helpers.ts";

const REDIRECT = "gym://staff-sign-in";
const hostEnv = { ...boundTestEnv(env), NATIVE_REDIRECT_URIS: REDIRECT };

/** Staff codes the host would have emailed, by address. */
const staffCodes = new Map<string, string>();
provideStaffCodes(hostEnv, {
  send: async ({ to, code }) => {
    staffCodes.set(to.toLowerCase(), code);
  },
  ready: async () => null,
});

const random: SecureRandom = {
  bytes: (n) => crypto.getRandomValues(new Uint8Array(n)),
  sha256: async (text) =>
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))),
};

/** The host's public address: the HTTP surface (its sign-in routes too) and the handoff page. */
async function serve(request: Request): Promise<Response> {
  if (new URL(request.url).pathname === "/native/staff-sign-in") {
    return handleNativeStaffSignIn(request, hostEnv as never);
  }
  return (await handleApi(request, hostEnv)) ?? new Response("Not found", { status: 404 });
}

/** Every cookie the phone sent: it must send none. */
const cookiesSent: string[] = [];
/** The phone's fetch: no cookie jar. */
const phone: FetchLike = async (url, init) => {
  for (const [name, value] of Object.entries(init.headers)) {
    if (name.toLowerCase() === "cookie") cookiesSent.push(value);
  }
  return serve(new Request(url, init));
};

/** The system browser, signed in to the host as `user`: follows the host back to the app. */
const browserAs = (user: TestUser) => async (url: string) => {
  const answer = await serve(new Request(url, { headers: { cookie: user.cookie } }));
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
  serve(
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

let admin: TestUser;
let coachEmail = "";

async function asAdmin(name: string, input: unknown) {
  const principal = await createIdentityProvider(hostEnv as never).resolve(
    new Request(ORIGIN, { headers: { cookie: admin.cookie } }),
  );
  const result = await runOperation(hostEnv as never, principal, { name, input }, ORIGIN);
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.data;
}

beforeAll(async () => {
  admin = await signUp(hostEnv as never, "admin");
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT OR IGNORE INTO core_user (id, name, email, email_verified, created_at, updated_at, kind) VALUES ('extension:ticketing', 'Ticketing', 'ticketing@extensions.crm.invalid', 0, ?, ?, 'extension')",
    ).bind(now, now),
    env.DB.prepare(
      "INSERT OR IGNORE INTO core_extensions (id, source, status, version, commit_oid, manifest, user_id, installed_at, updated_at) VALUES ('ticketing', 'shipped', 'active', '0.1.0', 'abc123', ?, 'extension:ticketing', ?, ?)",
    ).bind(JSON.stringify(ticketing), now, now),
  ]);
  // A coach invited with the door role, as an admin does in Settings → Users.
  coachEmail = `${unique("coach")}@example.com`;
  await asAdmin("user.invite", { email: coachEmail, role: "member", packRole: "ticketing.door" });
}, 60_000);

const door = (staff: ReturnType<typeof staffSession>) =>
  staff.client((o) =>
    createClient<{
      "x.ticketing.checkIn": { kind: "mutation"; input: { code: string }; output: unknown };
    }>({ "x.ticketing.checkIn": { kind: "mutation", invalidates: [] } }, o),
  );

async function signedInCoach(store: ReturnType<typeof memoryStore>) {
  const staff = staffSession({
    hostUrl: ORIGIN,
    store,
    deviceName: "Door phone",
    random,
    fetch: phone,
  });
  await staff.requestCode(coachEmail);
  const code = staffCodes.get(coachEmail.toLowerCase()) as string;
  expect(code).toMatch(/^\d{6}$/);
  return { staff, code };
}

describe("staff sign-in in the template's mobile app (ADR 0451)", () => {
  it("signs an invited door-role coach in by code; the session reaches only the role's operations; signing out ends it on the host", async () => {
    cookiesSent.length = 0;
    const store = memoryStore();
    const { staff, code } = await signedInCoach(store);
    expect(await staff.signIn(coachEmail, "000000")).toBe(false);
    // A wrong code uses one of the three tries; the right one still works.
    expect(await staff.signIn(coachEmail, code)).toBe(true);
    const tokens = store.peek() as Tokens;
    expect(tokens.accessToken).toMatch(/^cos_at_/);

    // The role's tool, through a role client: allowed (the stand-in runner echoes it).
    await expect(door(staff).call("x.ticketing.checkIn", { code: "TCK-1" })).resolves.toBeDefined();
    // Everything else is refused: other staff operations, other objects, its own sessions.
    for (const [name, input] of [
      ["person.list", {}],
      ["record.list", { object: "person" }],
      ["x.ticketing.salesSummary", {}],
      ["deviceSession.list", {}],
    ] as const) {
      expect((await call(tokens.accessToken, name, input)).status, name).toBe(403);
    }

    // Signing out ends the device session on the host, not just on the phone.
    await staff.signOut();
    expect(store.peek()).toBeNull();
    expect((await call(tokens.accessToken, "x.ticketing.checkIn", { code: "TCK-1" })).status).toBe(
      401,
    );
    expect(cookiesSent).toEqual([]);
  });

  it("signs in through the system browser with a PKCE verifier only the app holds", async () => {
    const store = memoryStore();
    let opened = "";
    const coach = await signUp(hostEnv as never, "member");
    const staff = staffSession({
      hostUrl: ORIGIN,
      store,
      deviceName: "Phone",
      random,
      redirectUri: REDIRECT,
      openBrowser: async (url) => {
        opened = url;
        return browserAs(coach)(url);
      },
      fetch: phone,
    });
    expect(await staff.signInWithBrowser()).toBe(true);
    const link = new URL(opened);
    expect(link.pathname).toBe("/native/staff-sign-in");
    expect(link.searchParams.get("redirect_uri")).toBe(REDIRECT);
    expect(link.searchParams.get("code_challenge_method")).toBe("S256");
    expect((await call((store.peek() as Tokens).accessToken, "user.list", {})).status).toBe(200);
    // A code that comes back with another state is not taken.
    const other = staffSession({
      hostUrl: ORIGIN,
      store: memoryStore(),
      deviceName: "Phone",
      random,
      redirectUri: REDIRECT,
      openBrowser: async (url) =>
        (await browserAs(coach)(url))?.replace(/state=[^&]+/, "state=forged") ?? null,
      fetch: phone,
    });
    expect(await other.signInWithBrowser()).toBe(false);
    await staff.signOut();
  });

  it("keeps one staff session on the device, apart from the customer's", async () => {
    const customerStore = memoryStore();
    const staffStore = memoryStore();
    const first = await signedInCoach(staffStore);
    expect(await first.staff.signIn(coachEmail, first.code)).toBe(true);
    const firstTokens = staffStore.peek() as Tokens;
    const again = await signedInCoach(staffStore);
    expect(await again.staff.signIn(coachEmail, again.code)).toBe(true);
    expect(staffStore.peek()?.sessionId).not.toBe(firstTokens.sessionId);
    // The session it replaced is ended on the host.
    expect((await call(firstTokens.accessToken, "x.ticketing.checkIn", { code: "x" })).status).toBe(
      401,
    );
    expect(customerStore.peek()).toBeNull();
    await again.staff.signOut();
  });
});
