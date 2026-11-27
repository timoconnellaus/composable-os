// Rule (b) of the owner's decision of 2026-11-27 (stage 66 step 8, ADR 0619), with two clients
// whose staff hostnames are siblings under the fleet's one domain (`callbacks.test`, the
// callback hostname's): every state-changing request (operations, staff, customer and
// practitioner sign-in, uploads, MCP consent and OAuth, the desk, TanStack Start's server
// functions) is refused unless its Origin (or, absent it, Sec-Fetch-Site) is the exact same
// origin, with the exceptions that already existed: token calls, customer-facing calls from the
// client's own web address or its allowed origins (never a sibling's), and gatekeeper callbacks
// on the callback hostname. Reads are not this rule's.
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { createIdentityProvider } from "@composable-os/auth";
import { setUpTwoClients, TWO_CLIENTS } from "@composable-os/db/testing/two-clients";
import { beforeAll, describe, expect, it } from "vitest";
import { type AppParts, hostFetch } from "../src/server/entry.ts";
import { createAppHandler } from "../src/server/mcp/handler.ts";
import { requestEnv } from "../src/server/request-env.ts";
import { writeOriginRefusal, writeOriginResponse } from "../src/server/same-origin-writes.ts";

const { a, b } = TWO_CLIENTS;
const host = env as unknown as Env;
/** Each client's staff address, a sibling of the other's under the fleet's domain. */
const A = "gym-a-admin.callbacks.test";
const B = "gym-b-admin.callbacks.test";
const A_WEB = "shop.gym-a.test";

const reached: string[] = [];
const start = async (request: Request) => {
  if (new URL(request.url).pathname.startsWith("/api/auth/")) {
    const provider = createIdentityProvider(requestEnv() as never);
    return (await provider.handle?.(request)) ?? new Response("Not found", { status: 404 });
  }
  reached.push(`${request.method} ${new URL(request.url).pathname}`);
  return new Response("reached");
};
const parts: AppParts = { app: createAppHandler({ fetch: start }), start };

async function fetchAt(hostname: string, path: string, init: RequestInit = {}) {
  const ctx = createExecutionContext();
  const response = await hostFetch(
    new Request(`https://${hostname}${path}`, init),
    host,
    ctx,
    parts,
  );
  await waitOnExecutionContext(ctx);
  return response;
}

const REFUSED = await writeOriginResponse().text();
async function isRefused(response: Response): Promise<boolean> {
  return response.status === 403 && (await response.clone().text()) === REFUSED;
}

let staffCookie = "";

beforeAll(async () => {
  await setUpTwoClients(env);
  const registry = (env as unknown as { REGISTRY: D1Database }).REGISTRY;
  // Each client's staff address on the fleet's domain, marked; gym-a's allowed origins name its
  // own site and, wrongly, gym-b's staff address (a sibling, which the rule never lets in).
  await registry.batch([
    registry
      .prepare(
        "INSERT INTO registry_hostnames (hostname, client, surface, verified, is_primary) VALUES (?, ?, 'staff', 1, 1)",
      )
      .bind(A, a.id),
    registry
      .prepare(
        "INSERT INTO registry_hostnames (hostname, client, surface, verified, is_primary) VALUES (?, ?, 'staff', 1, 1)",
      )
      .bind(B, b.id),
    registry
      .prepare(
        "INSERT INTO registry_settings (client, name, value) VALUES (?, 'API_ALLOWED_ORIGINS', ?) ON CONFLICT (client, name) DO UPDATE SET value = excluded.value",
      )
      .bind(a.id, `https://partner.gym-a.test, https://${B}`),
  ]);
  const signUp = await fetchAt(A, "/api/auth/sign-up/email", {
    method: "POST",
    headers: { "content-type": "application/json", origin: `https://${A}` },
    body: JSON.stringify({
      email: `staff-${crypto.randomUUID()}@staff.test`,
      password: "correct-horse-battery",
      name: "Staff",
    }),
  });
  expect(signUp.status, await signUp.clone().text()).toBe(200);
  staffCookie = signUp.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  expect(staffCookie).toMatch(/__Host-better-auth\./);
});

/** Every kind of state-changing request a page on a sibling might try. */
const WRITES: { what: string; path: string; body?: string; type?: string }[] = [
  { what: "an operation", path: "/api/v1/op/person.create", body: '{"givenName":"X"}' },
  {
    what: "staff sign-in",
    path: "/api/auth/sign-in/email",
    body: '{"email":"x@y.test","password":"p"}',
  },
  { what: "staff sign-out", path: "/api/auth/sign-out", body: "{}" },
  {
    what: "customer sign-in",
    path: "/api/customer-auth/email-otp/send-verification-otp",
    body: '{"email":"x@y.test","type":"sign-in"}',
  },
  {
    what: "practitioner sign-in",
    path: "/api/practitioner-auth/email-otp/send-verification-otp",
    body: '{"email":"x@y.test","type":"sign-in"}',
  },
  { what: "an upload", path: "/api/v1/media", body: "x", type: "image/png" },
  {
    what: "MCP consent",
    path: "/oauth/consent",
    body: "decision=allow",
    type: "application/x-www-form-urlencoded",
  },
  { what: "MCP itself", path: "/mcp", body: "{}" },
  { what: "a server function", path: "/_serverFn/anything", body: "{}" },
  { what: "the assistant", path: "/api/assistant/threads", body: "{}" },
];

function write(hostname: string, w: (typeof WRITES)[number], headers: Record<string, string>) {
  return fetchAt(hostname, w.path, {
    method: "POST",
    headers: { "content-type": w.type ?? "application/json", ...headers },
    body: w.body ?? "",
  });
}

describe("a state-changing request on a many-client host (rule (b))", () => {
  it("is refused from a sibling client's hostname, every kind, with the session cookie or without, before any route runs", async () => {
    const before = reached.length;
    for (const w of WRITES) {
      for (const headers of <Record<string, string>[]>[
        { origin: `https://${B}`, cookie: staffCookie },
        { origin: `https://${B}` },
        // Sec-Fetch-Site alone, with no Origin: a sibling is same-site, never same-origin.
        { "sec-fetch-site": "same-site", cookie: staffCookie },
        // A sandboxed or referrer-withheld page from elsewhere.
        { origin: "null", "sec-fetch-site": "cross-site", cookie: staffCookie },
        // A cookie and no header at all: not a request a modern browser makes.
        { cookie: staffCookie },
        // A token does not make a cookie-carrying call from a sibling acceptable.
        { origin: `https://${B}`, cookie: staffCookie, authorization: "Bearer x" },
      ]) {
        const response = await write(A, w, headers);
        expect(await isRefused(response), `${w.what} ${JSON.stringify(Object.keys(headers))}`).toBe(
          true,
        );
      }
    }
    // gym-b's sibling is refused at gym-a's, and gym-a's at gym-b's.
    expect(await isRefused(await write(B, WRITES[0] as never, { origin: `https://${A}` }))).toBe(
      true,
    );
    expect(reached.length).toBe(before);
  });

  it("is refused at the desk from another hostname, even the same client's staff address", async () => {
    const desk = "desk.gym-a.test";
    for (const origin of [`https://${B}`, `https://${A}`]) {
      const response = await fetchAt(desk, "/api/desk/desk.status", {
        method: "POST",
        headers: { "content-type": "application/json", origin },
        body: "{}",
      });
      expect(await isRefused(response), origin).toBe(true);
    }
    const own = await fetchAt(desk, "/api/desk/desk.status", {
      method: "POST",
      headers: { "content-type": "application/json", origin: `https://${desk}` },
      body: "{}",
    });
    expect(await isRefused(own)).toBe(false);
  });

  it("goes on from the exact same origin, or with Sec-Fetch-Site: same-origin when the origin is withheld", async () => {
    const made = await fetchAt(A, "/api/v1/op/person.create", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": crypto.randomUUID(),
        origin: `https://${A}`,
        cookie: staffCookie,
      },
      body: '{"givenName":"Same origin"}',
    });
    expect(made.status, await made.clone().text()).toBe(200);
    const withheld = await fetchAt(A, "/api/v1/op/person.create", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": crypto.randomUUID(),
        origin: "null",
        "sec-fetch-site": "same-origin",
        cookie: staffCookie,
      },
      body: '{"givenName":"Withheld"}',
    });
    expect(await isRefused(withheld)).toBe(false);
  });

  it("keeps the exceptions that existed: a token call, the client's own web address and allowed origins, never a sibling listed as one", async () => {
    // A token, no cookie, from anywhere: nothing ambient to ride on (the surface decides reads).
    const token = await write(A, WRITES[0] as never, { authorization: "Bearer not-a-real-token" });
    expect(await isRefused(token)).toBe(false);
    const tokenElsewhere = await write(A, WRITES[0] as never, {
      authorization: "Bearer not-a-real-token",
      origin: "https://app.example",
    });
    expect(await isRefused(tokenElsewhere)).toBe(false);
    // A native app or cos: no Origin, no Sec-Fetch-Site, no cookie.
    expect(await isRefused(await write(A, WRITES[0] as never, {}))).toBe(false);
    // The client's own web address, and an origin it allows, on a customer-facing route.
    for (const origin of [`https://${A_WEB}`, "https://partner.gym-a.test"]) {
      expect(await isRefused(await write(A, WRITES[3] as never, { origin })), origin).toBe(false);
      expect(await isRefused(await write(A, WRITES[0] as never, { origin })), origin).toBe(false);
      // Never a staff route.
      expect(await isRefused(await write(A, WRITES[1] as never, { origin })), origin).toBe(true);
    }
    // A sibling written into the allowed origins is still a sibling.
    expect(await isRefused(await write(A, WRITES[3] as never, { origin: `https://${B}` }))).toBe(
      true,
    );
    // OAuth's token endpoint from a browser MCP client, with no cookie.
    const oauth = await fetchAt(A, "/oauth/token", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: "https://mcp.example",
      },
      body: "grant_type=authorization_code&code=x",
    });
    expect(await isRefused(oauth)).toBe(false);
  });

  it("leaves reads and gatekeeper callbacks on the callback hostname alone", async () => {
    const read = await fetchAt(A, "/api/v1/op/person.list", {
      headers: { origin: `https://${B}`, cookie: staffCookie },
    });
    expect(await isRefused(read)).toBe(false);
    const callback = await fetchAt("callbacks.test", "/gatekeeper/payments/in/stripe", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://stripe.example" },
      body: "{}",
    });
    expect(await callback.text()).toBe("callback for payments");
  });

  it("is a rule of the many-client host only: what it decides, case by case", () => {
    const env = { CUSTOMER_AUTH_URL: `https://${A_WEB}`, API_ALLOWED_ORIGINS: `https://${B}` };
    const at = (init: RequestInit & { path?: string }) =>
      writeOriginRefusal(new Request(`https://${A}${init.path ?? "/api/v1/op/x"}`, init), env, {
        COS_CALLBACK_HOSTNAME: "callbacks.test",
      });
    expect(at({ method: "GET", headers: { origin: `https://${B}` } })).toBeNull();
    expect(at({ method: "OPTIONS", headers: { origin: `https://${B}` } })).toBeNull();
    expect(at({ method: "POST", headers: { origin: `https://${A}` } })).toBeNull();
    expect(at({ method: "POST", headers: { origin: `https://${B}` } })).toBe("cross-origin");
    expect(at({ method: "DELETE", headers: { origin: `https://${B}` } })).toBe("cross-origin");
    expect(at({ method: "POST", headers: { "sec-fetch-site": "same-site" } })).toBe("cross-site");
    expect(at({ method: "POST", headers: { origin: "null" } })).toBe("opaque-origin");
    expect(at({ method: "POST", headers: { origin: `https://${A_WEB}` } })).toBeNull();
    expect(
      at({ method: "POST", path: "/api/auth/x", headers: { origin: `https://${A_WEB}` } }),
    ).toBe("cross-origin");
  });
});
