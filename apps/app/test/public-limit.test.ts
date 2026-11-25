// The limit per client address on public operations (ADR 0940), as cos-app keys it:
// - on the public HTTP surface the address is the connection's (`cf-connecting-ip`); a caller
//   there cannot name another (`cos-visitor-address` is not read);
// - over the client-app binding the client app's Worker names its visitor, and the host honours
//   it, including through the template's own routes; a Worker that names none is one shared
//   bucket, never unlimited;
// - sign-in codes asked for from one address are one count, whichever kind of sign-in.
import { env } from "cloudflare:workers";
import {
  addressKey,
  clientAddressSecret,
  getCustomerIdentity,
  getPractitionerIdentity,
} from "@composable-os/auth";
import { memoryRateLimit } from "@composable-os/core";
import { describe, expect, it } from "vitest";
import {
  type ApiEnv,
  handleApi,
  handleCustomerAuth,
  handlePractitionerAuth,
} from "../src/server/http/api.ts";
import { handleBound, VISITOR_ADDRESS_HEADER } from "../src/server/http/bound.ts";
import { boundStrictLimit, boundTestEnv } from "./bound-env.ts";
import { ORIGIN, testEnv } from "./mcp-helpers.ts";

const strict = memoryRateLimit(10_000);
const shared = memoryRateLimit(10_000);
const codesFrom = memoryRateLimit(1);
const apiEnv = {
  ...testEnv(),
  CUSTOMER_AUTH_SECRET: "customer-secret-for-the-limits-456",
  CUSTOMER_AUTH_URL: "https://shop.test",
  PUBLIC_STRICT_RATE_LIMIT: strict,
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
const stopKey = async (address: string, of: ApiEnv = apiEnv) =>
  `public:addr:${await keyOf(address, of)}:contact.stop`;

const stopCall = (base: string, headers: Record<string, string>) =>
  new Request(`${base}/api/v1/op/contact.stop`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": crypto.randomUUID(),
      ...headers,
    },
    body: JSON.stringify({ token: "not-a-token" }),
  });

describe("the public HTTP surface: the connection's address", () => {
  it("counts the call against cf-connecting-ip, and a named visitor changes nothing", async () => {
    const response = await handleApi(
      stopCall(ORIGIN, {
        "cf-connecting-ip": "198.51.100.7",
        [VISITOR_ADDRESS_HEADER]: "203.0.113.99",
      }),
      apiEnv,
    );
    expect(response?.status).toBe(200);
    expect(strict.hits(await stopKey("198.51.100.7"))).toBe(1);
    expect(strict.hits(await stopKey("203.0.113.99"))).toBe(0);
  });

  it("refuses the 11th strict call in a minute with 429 and Retry-After, the standard shape", async () => {
    const tight = { ...apiEnv, PUBLIC_STRICT_RATE_LIMIT: memoryRateLimit(10) } as ApiEnv;
    for (let n = 0; n < 10; n += 1) {
      const ok = await handleApi(stopCall(ORIGIN, { "cf-connecting-ip": "198.51.100.8" }), tight);
      expect(ok?.status).toBe(200);
    }
    const refused = await handleApi(
      stopCall(ORIGIN, { "cf-connecting-ip": "198.51.100.8" }),
      tight,
    );
    expect(refused?.status).toBe(429);
    expect(refused?.headers.get("retry-after")).toBe("60");
    expect(await refused?.json()).toMatchObject({ error: { code: "rate_limited" } });
    // Another address, and another address in the same IPv6 /64 is the same one.
    const other = await handleApi(stopCall(ORIGIN, { "cf-connecting-ip": "198.51.100.9" }), tight);
    expect(other?.status).toBe(200);
  });

  it("limits an IPv6 address by its /64", async () => {
    expect(await keyOf("2001:db8:1:2:aaaa::1")).toBe(await keyOf("2001:db8:1:2:bbbb::9"));
    expect(await keyOf("2001:db8:1:2::1")).not.toBe(await keyOf("2001:db8:1:3::1"));
  });
});

describe("the client-app binding: the client app's word", () => {
  it("honours the visitor's address the client app's Worker names", async () => {
    const response = await handleBound(
      stopCall("https://host", { [VISITOR_ADDRESS_HEADER]: "203.0.113.20" }),
      apiEnv,
    );
    expect(response.status).toBe(200);
    expect(strict.hits(await stopKey("203.0.113.20"))).toBe(1);
  });

  it("through the template's own stop route: the visitor's address reaches the host", async () => {
    const before = boundStrictLimit.hits(await stopKey("203.0.113.21", boundTestEnv(env)));
    const page = await (env as unknown as { COMPANY_WEB: Fetcher }).COMPANY_WEB.fetch(
      "https://shop.test/stop?t=not-a-token",
      { method: "POST", headers: { "cf-connecting-ip": "203.0.113.21" } },
    );
    expect(page.status).toBe(200);
    expect(boundStrictLimit.hits(await stopKey("203.0.113.21", boundTestEnv(env)))).toBe(
      before + 1,
    );
  });

  it("a Worker that names no visitor is one shared bucket for the client app, never unlimited", async () => {
    const before = shared.hits("public:app:client-app:contact.stop");
    const response = await handleBound(stopCall("https://host", {}), apiEnv);
    expect(response.status).toBe(200);
    expect(shared.hits("public:app:client-app:contact.stop")).toBe(before + 1);
  });

  it("a name that is not an address is no address", async () => {
    const before = shared.hits("public:app:client-app:contact.stop");
    await handleBound(stopCall("https://host", { [VISITOR_ADDRESS_HEADER]: "everyone" }), apiEnv);
    expect(shared.hits("public:app:client-app:contact.stop")).toBe(before + 1);
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
