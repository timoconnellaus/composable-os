// Stage 66 step 6 (ADR 0616): on a host that serves many clients (`COS_CLIENT_ID` in the client's
// environment), every session cookie is `__Host-` prefixed (Secure, Path=/, no Domain), so a page
// on a sibling hostname of the fleet's domain can never plant one; a cookie of the same base name
// without the prefix is not read. A single-client deployment keeps its names. The client-address
// key is the client's own derived key there, never the staff secret.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  CUSTOMER_COOKIE_PREFIX,
  clientAddressSecret,
  createCustomerAuth,
  createIdentityProvider,
  createPractitionerAuth,
  type IdentityEnv,
  isSessionCookie,
  PRACTITIONER_COOKIE_PREFIX,
} from "../src/index.ts";

const ORIGIN = "https://gym-a-admin.fleet.example";
const STAFF_SECRET = "s66e-staff-secret-s66e-staff-secret-0001";

function staffEnv(overrides: Partial<IdentityEnv> = {}): IdentityEnv {
  return {
    DB: env.DB,
    IDENTITY_PROVIDER: "better-auth",
    BETTER_AUTH_SECRET: STAFF_SECRET,
    BETTER_AUTH_URL: ORIGIN,
    AUTH_ALLOW_SIGNUP: "true",
    ...overrides,
  };
}

async function signUp(provider: ReturnType<typeof createIdentityProvider>, email: string) {
  // biome-ignore lint/style/noNonNullAssertion: the Better Auth adapter always has routes.
  return provider.handle!(
    new Request(`${ORIGIN}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN },
      body: JSON.stringify({ email, password: "correct-horse-battery", name: "Cookie Test" }),
    }),
  );
}

/** One Set-Cookie header as its name and attributes, lower-cased. */
function parsed(header: string) {
  const [pair, ...attributes] = header.split(";").map((part) => part.trim());
  const name = (pair ?? "").split("=")[0] as string;
  const attrs = attributes.map((a) => a.toLowerCase());
  return { name, value: (pair ?? "").slice(name.length + 1), attrs };
}

function expectHostOnly(cookie: { name: string; attrs: string[] }) {
  expect(cookie.name, cookie.name).toMatch(/^__Host-/);
  expect(cookie.attrs, cookie.name).toContain("secure");
  expect(cookie.attrs, cookie.name).toContain("path=/");
  expect(
    cookie.attrs.some((a) => a.startsWith("domain")),
    cookie.name,
  ).toBe(false);
}

describe("session cookies on a many-client host", () => {
  it("are __Host- prefixed with no Domain, and an unprefixed copy is not signed in", async () => {
    const provider = createIdentityProvider(staffEnv({ COS_CLIENT_ID: "gym-a" }));
    const response = await signUp(provider, `s66e-host-${Date.now()}@example.com`);
    expect(response?.status).toBe(200);
    const set = (response?.headers.getSetCookie() ?? []).map(parsed);
    expect(set.length).toBeGreaterThan(0);
    for (const cookie of set) expectHostOnly(cookie);
    const session = set.find((c) => c.name.endsWith(".session_token"));
    expect(session?.name).toBe("__Host-better-auth.session_token");
    const signedIn = await provider.resolve(
      new Request(`${ORIGIN}/`, { headers: { cookie: `${session?.name}=${session?.value}` } }),
    );
    expect(signedIn).not.toBeNull();
    // The same token under the names a sibling hostname could plant (Domain= forbids `__Host-`).
    for (const name of ["__Secure-better-auth.session_token", "better-auth.session_token"]) {
      const planted = await provider.resolve(
        new Request(`${ORIGIN}/`, { headers: { cookie: `${name}=${session?.value}` } }),
      );
      expect(planted, name).toBeNull();
    }
  });

  it("are the same for customer and practitioner sign-in: every cookie they would set", async () => {
    const options = {
      db: env.DB,
      secret: "s66e-customer-secret-s66e-customer-0002",
      baseURL: "https://gym-a.com",
      sendCode: async () => undefined,
      hostOnlyCookies: true,
    };
    for (const [auth, prefix] of [
      [createCustomerAuth(options), CUSTOMER_COOKIE_PREFIX],
      [createPractitionerAuth(options), PRACTITIONER_COOKIE_PREFIX],
    ] as const) {
      const context = await auth.$context;
      const cookies = Object.values(context.authCookies) as {
        name: string;
        attributes: { secure?: boolean; path?: string; domain?: string };
      }[];
      expect(cookies.length).toBeGreaterThan(2);
      for (const cookie of cookies) {
        expect(cookie.name.startsWith(`__Host-${prefix}.`), cookie.name).toBe(true);
        expect(cookie.attributes.secure, cookie.name).toBe(true);
        expect(cookie.attributes.path, cookie.name).toBe("/");
        expect(cookie.attributes.domain, cookie.name).toBeUndefined();
      }
    }
  });

  it("keep today's names on a single-client deployment, so nobody is signed out", async () => {
    const provider = createIdentityProvider(staffEnv());
    const response = await signUp(provider, `s66e-single-${Date.now()}@example.com`);
    const names = (response?.headers.getSetCookie() ?? []).map((h) => parsed(h).name);
    expect(names).toContain("__Secure-better-auth.session_token");
    expect(names.some((n) => n.startsWith("__Host-"))).toBe(false);
    const customer = await createCustomerAuth({
      db: env.DB,
      secret: "s66e-customer-secret-s66e-customer-0002",
      baseURL: "https://gym-a.com",
      sendCode: async () => undefined,
    }).$context;
    expect(customer.authCookies.sessionToken.name).toBe(
      `__Secure-${CUSTOMER_COOKIE_PREFIX}.session_token`,
    );
  });
});

describe("the client-address key on a many-client host", () => {
  it("is the client's own derived key, never the staff or customer secret", () => {
    expect(
      clientAddressSecret({
        COS_CLIENT_ID: "gym-a",
        CLIENT_ADDRESS_SECRET: "s66e-derived-address-key",
        BETTER_AUTH_SECRET: STAFF_SECRET,
      }),
    ).toBe("client-address\ns66e-derived-address-key");
    // Without its own key, never the staff one: a random key for the isolate instead.
    const fallback = clientAddressSecret({
      COS_CLIENT_ID: "gym-a",
      BETTER_AUTH_SECRET: STAFF_SECRET,
    });
    expect(fallback).not.toContain(STAFF_SECRET);
    // A single-client deployment: unchanged.
    expect(clientAddressSecret({ BETTER_AUTH_SECRET: STAFF_SECRET })).toBe(
      `client-address\n${STAFF_SECRET}`,
    );
  });
});

describe("which cookie names are sessions (isSessionCookie)", () => {
  it("on a many-client host, only the `__Host-` name: a planted unprefixed one is not", () => {
    expect(isSessionCookie("__Host-cos-customer.session_token=a", "cos-customer", true)).toBe(true);
    expect(isSessionCookie("cos-customer.session_token=a", "cos-customer", true)).toBe(false);
    expect(isSessionCookie("__Secure-cos-customer.x=a", "cos-customer", true)).toBe(false);
  });

  it("elsewhere, with or without `__Secure-` or `__Host-`, and never a look-alike", () => {
    for (const name of [
      "cos-customer.x=1",
      "__Secure-cos-customer.x=1",
      "__Host-cos-customer.x=1",
    ]) {
      expect(isSessionCookie(name, "cos-customer", false), name).toBe(true);
    }
    expect(isSessionCookie("cos-customers.x=1", "cos-customer", false)).toBe(false);
  });
});
