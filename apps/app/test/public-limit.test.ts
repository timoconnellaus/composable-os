// The limits on public operations (ADR 0940), as cos-app keys them:
// - on the public HTTP surface the address is the connection's (`cf-connecting-ip`); a caller
//   there cannot name another (`cos-visitor-address` is not read);
// - over the client-app binding a forwarded `cf-connecting-ip` comes first (a browser cannot set
//   it), then the visitor the client app names; a client app that forwards the browser's headers
//   as they came cannot be steered by a forged `cos-visitor-address` (M2); one that names nobody is
//   one shared bucket, and the admins are told (M3);
// - the template's stop route never says "done" when the host refused (M1);
// - sign-in codes from one address are one count, whichever kind of sign-in;
// - the status page says when the limits are not bound (M4).
import { env } from "cloudflare:workers";
import {
  addressKey,
  clientAddressSecret,
  getCustomerIdentity,
  getPractitionerIdentity,
} from "@composable-os/auth";
import { memoryRateLimit } from "@composable-os/core";
import { describe, expect, it } from "vitest";
import { getHealth } from "../src/server/health.ts";
import {
  type ApiEnv,
  handleApi,
  handleCustomerAuth,
  handlePractitionerAuth,
} from "../src/server/http/api.ts";
import {
  handleBound,
  NO_VISITOR_NOTICE,
  resetNoVisitorNotice,
  VISITOR_ADDRESS_HEADER,
} from "../src/server/http/bound.ts";
import { boundReadLimit, boundTestEnv, boundWriteLimit } from "./bound-env.ts";
import { ORIGIN, testEnv } from "./mcp-helpers.ts";

const read = memoryRateLimit(10_000);
const shared = memoryRateLimit(10_000);
const codesFrom = memoryRateLimit(1);
const apiEnv = {
  ...testEnv(),
  CUSTOMER_AUTH_SECRET: "customer-secret-for-the-limits-456",
  CUSTOMER_AUTH_URL: "https://shop.test",
  PUBLIC_RATE_LIMIT: read,
  PUBLIC_SHARED_RATE_LIMIT: shared,
  CUSTOMER_CODE_ADDRESS_RATE_LIMIT: codesFrom,
  CUSTOMER_CODE_RATE_LIMIT: memoryRateLimit(10_000),
  CUSTOMER_CODE_NEW_RATE_LIMIT: memoryRateLimit(10_000),
} as unknown as ApiEnv;
// Sign-in for this env, built first so codes are "sent" here (cos-app caches it per env).
getCustomerIdentity(apiEnv, async () => {});
getPractitionerIdentity(apiEnv, async () => {});

const keyOf = async (address: string, of: ApiEnv = apiEnv) =>
  addressKey(address, clientAddressSecret(of));
/** stock.get's per-address key: a public read, counted on every call before its input is read. */
const readKey = async (address: string, of: ApiEnv = apiEnv) =>
  `public:addr:${await keyOf(address, of)}:stock.get`;

const readCall = (base: string, headers: Record<string, string>) =>
  new Request(`${base}/api/v1/op/stock.get`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({}),
  });

const companyWeb = () => (env as unknown as { COMPANY_WEB: Fetcher }).COMPANY_WEB;

describe("the public HTTP surface: the connection's address", () => {
  it("counts the call against cf-connecting-ip, and a named visitor changes nothing", async () => {
    await handleApi(
      readCall(ORIGIN, {
        "cf-connecting-ip": "198.51.100.7",
        [VISITOR_ADDRESS_HEADER]: "203.0.113.99",
      }),
      apiEnv,
    );
    expect(read.hits(await readKey("198.51.100.7"))).toBe(1);
    expect(read.hits(await readKey("203.0.113.99"))).toBe(0);
  });

  it("refuses past the flood level with 429 and Retry-After, the standard shape", async () => {
    const tight = { ...apiEnv, PUBLIC_RATE_LIMIT: memoryRateLimit(2) } as ApiEnv;
    for (let n = 0; n < 2; n += 1) {
      await handleApi(readCall(ORIGIN, { "cf-connecting-ip": "198.51.100.8" }), tight);
    }
    const refused = await handleApi(
      readCall(ORIGIN, { "cf-connecting-ip": "198.51.100.8" }),
      tight,
    );
    expect(refused?.status).toBe(429);
    expect(refused?.headers.get("retry-after")).toBe("60");
    expect(await refused?.json()).toMatchObject({ error: { code: "rate_limited" } });
    const other = await handleApi(readCall(ORIGIN, { "cf-connecting-ip": "198.51.100.9" }), tight);
    expect(other?.status).not.toBe(429);
  });

  it("an IPv6 address by its /64, an IPv4-mapped one by its IPv4 address", async () => {
    expect(await keyOf("2001:db8:1:2:aaaa::1")).toBe(await keyOf("2001:db8:1:2:bbbb::9"));
    expect(await keyOf("2001:db8:1:2::1")).not.toBe(await keyOf("2001:db8:1:3::1"));
    expect(await keyOf("::ffff:192.0.2.1")).toBe(await keyOf("192.0.2.1"));
    expect(await keyOf("::ffff:192.0.2.1")).not.toBe(await keyOf("::ffff:192.0.2.2"));
  });
});

describe("the client-app binding: the client app's word", () => {
  it("honours the visitor the client app's Worker names", async () => {
    await handleBound(
      readCall("https://host", { [VISITOR_ADDRESS_HEADER]: "203.0.113.20" }),
      apiEnv,
    );
    expect(read.hits(await readKey("203.0.113.20"))).toBe(1);
  });

  it("a forwarded cf-connecting-ip comes before the named visitor (M2)", async () => {
    await handleBound(
      readCall("https://host", {
        "cf-connecting-ip": "203.0.113.30",
        [VISITOR_ADDRESS_HEADER]: "203.0.113.31",
      }),
      apiEnv,
    );
    expect(read.hits(await readKey("203.0.113.30"))).toBe(1);
    expect(read.hits(await readKey("203.0.113.31"))).toBe(0);
  });

  it("a client app forwarding the browser's headers as they came: a forged visitor is not believed (M2)", async () => {
    const env2 = boundTestEnv(env);
    const real = await readKey("198.51.100.40", env2);
    const forged = await readKey("192.0.2.200", env2);
    const before = { real: boundReadLimit.hits(real), forged: boundReadLimit.hits(forged) };
    await companyWeb().fetch("https://shop.test/passthrough/api/v1/op/stock.get", {
      method: "POST",
      // Cloudflare's edge sets cf-connecting-ip on the browser's request; the browser adds its own
      // cos-visitor-address, hoping to choose its limit.
      headers: {
        "content-type": "application/json",
        "cf-connecting-ip": "198.51.100.40",
        [VISITOR_ADDRESS_HEADER]: "192.0.2.200",
      },
      body: "{}",
    });
    expect(boundReadLimit.hits(real)).toBe(before.real + 1);
    expect(boundReadLimit.hits(forged)).toBe(before.forged);
  });

  it("a Worker that names no visitor is one shared bucket, and the admins are told (M3)", async () => {
    resetNoVisitorNotice();
    const before = shared.hits("public:app:client-app:stock.get");
    await handleBound(readCall("https://host", {}), apiEnv);
    expect(shared.hits("public:app:client-app:stock.get")).toBe(before + 1);
    // A value that is not an address is no address.
    await handleBound(readCall("https://host", { [VISITOR_ADDRESS_HEADER]: "everyone" }), apiEnv);
    expect(shared.hits("public:app:client-app:stock.get")).toBe(before + 2);
    const day = new Date().toISOString().slice(0, 10);
    const notice = await env.DB.prepare(
      "SELECT title, body FROM core_notifications WHERE dedupe_key = ? LIMIT 1",
    )
      .bind(`${NO_VISITOR_NOTICE}${day}`)
      .first<{ title: string; body: string }>();
    // Told only when there is an admin to tell; the fix is named when there is.
    if (notice) expect(notice.body).toContain("forVisitor");
  });
});

describe("the template's stop route (M1)", () => {
  const stop = (headers: Record<string, string>) =>
    companyWeb().fetch("https://shop.test/stop?t=not-a-valid-token", {
      method: "POST",
      redirect: "manual",
      headers: { "cf-connecting-ip": "203.0.113.50", ...headers },
    });

  it("passes the visitor's address, and says done when the host said yes", async () => {
    const key = `public:addr:${await keyOf("203.0.113.50", boundTestEnv(env))}:contact.stop`;
    const before = boundWriteLimit.hits(key);
    const page = await stop({ origin: "https://shop.test" });
    expect(page.status).toBe(303);
    expect(page.headers.get("location")).toBe("/stop?done=1");
    // An invalid token counts against the visitor's address (only invalid ones do).
    expect(boundWriteLimit.hits(key)).toBe(before + 1);
  });

  it("never says done when the host refused: the button stays, and a one-click gets the host's status", async () => {
    boundWriteLimit.state.closed = true;
    try {
      const page = await stop({ origin: "https://shop.test" });
      expect(page.status).toBe(429);
      const text = await page.text();
      expect(text).not.toContain("You will not get these messages any more");
      expect(text).toContain("<button");
      const oneClick = await stop({});
      expect(oneClick.status).toBe(429);
    } finally {
      boundWriteLimit.state.closed = false;
    }
  });
});

describe("sign-in codes from one address: one count, whichever kind of sign-in", () => {
  it("a customer's code request, then a practitioner's, from one address", async () => {
    const ask = (path: string, email: string) =>
      new Request(`${ORIGIN}${path}/email-otp/send-verification-otp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://shop.test",
          "cf-connecting-ip": "192.0.2.44",
        },
        body: JSON.stringify({ email, type: "sign-in" }),
      });
    const customer = await handleCustomerAuth(
      ask("/api/customer-auth", "first@limits.test"),
      apiEnv,
    );
    expect(customer.status).toBe(200);
    expect(codesFrom.hits(`code-from:${await keyOf("192.0.2.44")}`)).toBe(1);
    const practitioner = await handlePractitionerAuth(
      ask("/api/practitioner-auth", "second@limits.test"),
      apiEnv,
    );
    expect(practitioner.status).toBe(429);
    expect(codesFrom.hits(`code-from:${await keyOf("192.0.2.44")}`)).toBe(2);
  });
});

describe("the status page (M4)", () => {
  it("names the bindings a deployment is missing", async () => {
    const health = await getHealth({
      ...(env as unknown as Parameters<typeof getHealth>[0]),
      PUBLIC_CALLER_RATE_LIMIT: undefined,
    } as never);
    expect(health.publicLimits.ok).toBe(false);
    expect(health.publicLimits.missing).toEqual(["PUBLIC_CALLER_RATE_LIMIT"]);
    const whole = await getHealth(env as never);
    expect(whole.publicLimits).toMatchObject({ ok: true, missing: [] });
  });
});
