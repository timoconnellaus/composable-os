import { createLocalJWKSet } from "jose";
import { describe, expect, it, vi } from "vitest";
import {
  ACCESS_JWT_HEADER,
  cloudflareAccessProvider,
  createIdentityProvider,
  normaliseTeamDomain,
} from "../src/index.ts";
import { AUD, createAccessKeys, TEAM } from "./access-jwt.ts";

const keys = await createAccessKeys();
const provider = cloudflareAccessProvider({
  teamDomain: "crm-test",
  audience: AUD,
  jwks: createLocalJWKSet(keys.jwks),
});

function request(headers: Record<string, string> = {}) {
  return new Request("https://crm.example.com/", { headers });
}

describe("cloudflare-access adapter", () => {
  it("admits a request with a valid Access JWT", async () => {
    const token = await keys.sign({ sub: "user-1", email: "ada@example.com", name: "Ada" });
    const principal = await provider.resolve(request({ [ACCESS_JWT_HEADER]: token }));
    expect(principal).toEqual({
      userId: "user-1",
      email: "ada@example.com",
      name: "Ada",
      roles: [],
    });
  });

  it("reads the CF_Authorization cookie when the header is missing", async () => {
    const token = await keys.sign({ sub: "user-1", email: "ada@example.com" });
    const principal = await provider.resolve(request({ cookie: `a=b; CF_Authorization=${token}` }));
    expect(principal?.email).toBe("ada@example.com");
    expect(principal?.name).toBe("ada@example.com");
  });

  it("on a host of many clients reads only Access's header, never the CF_Authorization cookie a sibling could plant (stage 66 step 8, rule (c))", async () => {
    const headerOnly = cloudflareAccessProvider({
      teamDomain: "crm-test",
      audience: AUD,
      jwks: createLocalJWKSet(keys.jwks),
      headerOnly: true,
    });
    const token = await keys.sign({ sub: "user-1", email: "ada@example.com" });
    expect(await headerOnly.resolve(request({ cookie: `CF_Authorization=${token}` }))).toBeNull();
    expect((await headerOnly.resolve(request({ [ACCESS_JWT_HEADER]: token })))?.email).toBe(
      "ada@example.com",
    );
    // The provider a many-client host's environment makes is that one: the cookie is never read,
    // so not even the team's keys are fetched for it.
    const fetched = vi.spyOn(globalThis, "fetch");
    try {
      const provider = createIdentityProvider({
        IDENTITY_PROVIDER: "cloudflare-access",
        CF_ACCESS_TEAM_DOMAIN: "many-client-test",
        CF_ACCESS_AUD: AUD,
        COS_CLIENT_ID: "gym-a",
      } as never);
      expect(await provider.resolve(request({ cookie: `CF_Authorization=${token}` }))).toBeNull();
      expect(fetched).not.toHaveBeenCalled();
    } finally {
      fetched.mockRestore();
    }
  });

  it("rejects a request without a JWT", async () => {
    expect(await provider.resolve(request())).toBeNull();
  });

  it("rejects a JWT for another application", async () => {
    const token = await keys.sign({ sub: "u", email: "a@example.com" }, { audience: "other" });
    expect(await provider.resolve(request({ [ACCESS_JWT_HEADER]: token }))).toBeNull();
  });

  it("rejects a JWT from another team", async () => {
    const token = await keys.sign(
      { sub: "u", email: "a@example.com" },
      { issuer: "https://evil.cloudflareaccess.com" },
    );
    expect(await provider.resolve(request({ [ACCESS_JWT_HEADER]: token }))).toBeNull();
  });

  it("rejects a JWT signed by another key", async () => {
    const other = await createAccessKeys();
    const token = await other.sign({ sub: "u", email: "a@example.com" });
    expect(await provider.resolve(request({ [ACCESS_JWT_HEADER]: token }))).toBeNull();
  });

  it("rejects an expired JWT", async () => {
    const token = await keys.sign({ sub: "u", email: "a@example.com" }, { expiresIn: "-1m" });
    expect(await provider.resolve(request({ [ACCESS_JWT_HEADER]: token }))).toBeNull();
  });

  it("rejects service tokens, which have no email", async () => {
    const token = await keys.sign({ sub: "", common_name: "svc.access" });
    expect(await provider.resolve(request({ [ACCESS_JWT_HEADER]: token }))).toBeNull();
  });

  it("normalises team domains", () => {
    expect(normaliseTeamDomain("crm-test")).toBe(TEAM);
    expect(normaliseTeamDomain("crm-test.cloudflareaccess.com")).toBe(TEAM);
    expect(normaliseTeamDomain("https://crm-test.cloudflareaccess.com/")).toBe(TEAM);
  });
});
