// cos-front (stage 66 step 8, ADR 0619), with two clients in one registry: a client's verified web
// hostname gets the holding page with the client fixed from the registry; an unknown, unverified,
// another environment's, staff or desk hostname, and anything under the fleet's registrable
// domain, the same 404 reaching no client (criterion 8); a paused client "being updated"; headers
// that could name a client never reach the target; and every answer carries the security headers.
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  type FrontClient,
  type FrontEnv,
  frontFetch,
  holdingPage,
  isClientNamingHeader,
  ownPagePolicy,
  type WebTarget,
} from "../src/front.ts";
import {
  emptyRegistry,
  insertClient,
  insertHostname,
  migrateRegistry,
} from "./registry-fixtures.ts";

const registry = (env as unknown as { REGISTRY: D1Database }).REGISTRY;
const front: FrontEnv = {
  REGISTRY: registry,
  COS_HOST_ENVIRONMENT: "live",
  COS_FLEET_DOMAIN: "fleet.example",
};

beforeAll(async () => {
  await migrateRegistry();
});

beforeEach(async () => {
  await emptyRegistry();
  await registry.batch([
    insertClient(registry, { id: "gym-a" }),
    insertClient(registry, { id: "gym-b" }),
    insertClient(registry, { id: "gym-s", environment: "staging" }),
    insertHostname(registry, "gym-a-admin.fleet.example", "gym-a", "staff"),
    insertHostname(registry, "gym-b-admin.fleet.example", "gym-b", "staff"),
    insertHostname(registry, "gym-a-desk.fleet.example", "gym-a", "desk"),
    insertHostname(registry, "www.gym-a.example", "gym-a", "web"),
    insertHostname(registry, "gym-b.example", "gym-b", "web"),
    insertHostname(registry, "shop.gym-b.example", "gym-b", "web", false),
    insertHostname(registry, "staging.gym-s.example", "gym-s", "web"),
  ]);
});

/** A target that records the client and request it was handed. */
function recorder(): WebTarget & { seen: { client: FrontClient; request: Request }[] } {
  const seen: { client: FrontClient; request: Request }[] = [];
  return {
    name: "recorder",
    seen,
    async serve(request, client) {
      seen.push({ client, request });
      return new Response(`for ${client.id}`);
    },
  };
}

const get = (url: string, headers: Record<string, string> = {}) =>
  new Request(url, { headers: { accept: "text/html", ...headers } });

function expectSecurityHeaders(response: Response) {
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  expect(response.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
  expect(response.headers.get("x-frame-options")).toBe("DENY");
  expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
}

describe("cos-front with two clients", () => {
  it("serves each client's verified web hostname with that client, fixed from the registry", async () => {
    const target = recorder();
    const a = await frontFetch(get("https://www.gym-a.example/"), front, target);
    const b = await frontFetch(get("https://gym-b.example/classes"), front, target);
    expect(await a.text()).toBe("for gym-a");
    expect(await b.text()).toBe("for gym-b");
    expect(target.seen.map((s) => s.client)).toEqual([
      { id: "gym-a", environment: "live", hostname: "www.gym-a.example" },
      { id: "gym-b", environment: "live", hostname: "gym-b.example" },
    ]);
    expectSecurityHeaders(a);
  });

  it("decides the client by the hostname alone: a header naming another client never reaches the target", async () => {
    const target = recorder();
    const response = await frontFetch(
      get("https://www.gym-a.example/", {
        "x-cos-client": "gym-b",
        "cos-client": "gym-b",
        "x-forwarded-host": "gym-b.example",
        forwarded: "host=gym-b.example",
        "x-original-host": "gym-b.example",
        cookie: "a=1",
      }),
      front,
      target,
    );
    expect(await response.text()).toBe("for gym-a");
    const seen = target.seen[0]?.request as Request;
    for (const name of [
      "x-cos-client",
      "cos-client",
      "x-forwarded-host",
      "forwarded",
      "x-original-host",
    ]) {
      expect(seen.headers.has(name), name).toBe(false);
    }
    // What is the client's own is passed on.
    expect(seen.headers.get("cookie")).toBe("a=1");
    expect(isClientNamingHeader("X-COS-Anything")).toBe(true);
    expect(isClientNamingHeader("accept")).toBe(false);
  });

  it("answers the same 404 for every hostname that is not a verified web hostname of this environment, reaching no client (criterion 8)", async () => {
    const target = recorder();
    const refused = [
      "https://nobody.example/", // unknown
      "https://shop.gym-b.example/", // unverified
      "https://staging.gym-s.example/", // another environment's client
      "https://gym-a-admin.fleet.example/", // a staff hostname
      "https://gym-a-desk.fleet.example/", // a desk hostname
      "https://clients.fleet.example/", // the CNAME target itself
      "https://anything.fleet.example/",
      "https://127.0.0.1/",
    ];
    const bodies = new Set<string>();
    for (const url of refused) {
      const response = await frontFetch(get(url), front, target);
      expect(response.status, url).toBe(404);
      expectSecurityHeaders(response);
      bodies.add(await response.text());
    }
    expect(bodies.size).toBe(1);
    expect(target.seen).toEqual([]);
  });

  it("serves nothing under the fleet's registrable domain, even a web hostname the registry holds there", async () => {
    // A row no command would write (cos refuses it): cos-front refuses it on its own.
    await registry.batch([insertHostname(registry, "shop.fleet.example", "gym-a", "web")]);
    const target = recorder();
    expect((await frontFetch(get("https://shop.fleet.example/"), front, target)).status).toBe(404);
    // A fleet domain one level down keeps the whole registrable domain off.
    await registry.batch([insertHostname(registry, "www.fleet.example", "gym-b", "web")]);
    const deeper = { ...front, COS_FLEET_DOMAIN: "clients.fleet.example" };
    expect((await frontFetch(get("https://www.fleet.example/"), deeper, target)).status).toBe(404);
    // With no fleet domain at all, it serves nothing.
    const none = { ...front, COS_FLEET_DOMAIN: "" };
    expect((await frontFetch(get("https://www.gym-a.example/"), none, target)).status).toBe(404);
    expect(target.seen).toEqual([]);
  });

  it("answers a paused or moving client with 'being updated', and the other client as before", async () => {
    await registry
      .prepare("UPDATE registry_clients SET status = 'paused' WHERE id = 'gym-a'")
      .run();
    const target = recorder();
    const paused = await frontFetch(get("https://www.gym-a.example/"), front, target);
    expect(paused.status).toBe(503);
    expect(paused.headers.get("retry-after")).toBe("120");
    expectSecurityHeaders(paused);
    expect(await (await frontFetch(get("https://gym-b.example/"), front, target)).text()).toBe(
      "for gym-b",
    );
    expect(target.seen.map((s) => s.client.id)).toEqual(["gym-b"]);
  });

  it("serves the holding page with nothing of the client in it and a policy that allows only its own style", async () => {
    const response = await frontFetch(get("https://www.gym-a.example/"), front);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("Coming soon");
    expect(html).not.toContain("gym-a");
    expect(response.headers.get("content-security-policy")).toBe(await ownPagePolicy());
    expect(response.headers.get("content-security-policy")).toMatch(
      /^default-src 'none'; style-src 'sha256-[A-Za-z0-9+/=]+'; img-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'$/,
    );
    expectSecurityHeaders(response);
    const post = await frontFetch(
      new Request("https://www.gym-a.example/", { method: "POST" }),
      front,
      holdingPage,
    );
    expect(post.status).toBe(405);
    expectSecurityHeaders(post);
  });

  it("keeps a target's own stricter policy, and adds the headers it lacks", async () => {
    const strict: WebTarget = {
      name: "strict",
      async serve() {
        return new Response("x", {
          headers: { "content-security-policy": "default-src 'self'; frame-ancestors 'none'" },
        });
      },
    };
    const response = await frontFetch(get("https://www.gym-a.example/"), front, strict);
    expect(response.headers.get("content-security-policy")).toBe(
      "default-src 'self'; frame-ancestors 'none'",
    );
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("answers a registry failure with nothing about it", async () => {
    const broken: FrontEnv = {
      ...front,
      REGISTRY: {
        prepare() {
          throw new Error("D1_ERROR: secret detail");
        },
      } as unknown as D1Database,
    };
    const response = await frontFetch(get("https://www.gym-a.example/"), broken);
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("secret detail");
  });
});
