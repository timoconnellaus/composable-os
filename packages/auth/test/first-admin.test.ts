// The first account (stage 66 step 9, ADR 0618 "The first client's day one"). On a single-client
// deployment the first person to sign up becomes its admin, as before; an installed pack's
// principal (migration 0020) is not a person and does not close that. On a host of many clients a
// client's staff hostname is public from the moment `cos client add` makes it, so only the address
// the operator named, carrying the setup link's token, before it expires, makes the first account.
import { env } from "cloudflare:workers";
import { firstAdminValue } from "@composable-os/db/registry";
import { beforeEach, describe, expect, it } from "vitest";
import {
  awaitingFirstUser,
  createIdentityProvider,
  FIRST_ADMIN_HEADER,
  type IdentityEnv,
} from "../src/index.ts";

const ORIGIN = "https://gym-a.test";
const TOKEN = "first-admin-token-0123456789abcdefghijklmnopqrstuv";

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

let clientCount = 0;

/** An env object of its own per call: Better Auth is built once per env. */
function authEnv(overrides: Partial<IdentityEnv> = {}): IdentityEnv {
  return {
    DB: env.DB,
    IDENTITY_PROVIDER: "better-auth",
    BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret-123",
    BETTER_AUTH_URL: ORIGIN,
    ...overrides,
  };
}

/** A client of a many-client host whose first admin is `email`, the link expiring at `expires`. */
async function clientEnv(rule?: { email: string; expires: string }): Promise<IdentityEnv> {
  clientCount += 1;
  return authEnv({
    COS_CLIENT_ID: `gym-${clientCount}`,
    ...(rule
      ? {
          COS_FIRST_ADMIN: firstAdminValue({
            email: rule.email,
            sha256: await sha256Hex(TOKEN),
            expires: rule.expires,
          }),
        }
      : {}),
  });
}

async function signUp(
  identity: IdentityEnv,
  email: string,
  token?: string,
): Promise<Response | null> {
  const provider = createIdentityProvider(identity);
  // biome-ignore lint/style/noNonNullAssertion: the Better Auth adapter always has routes.
  return provider.handle!(
    new Request(`${ORIGIN}/api/auth/sign-up/email`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: ORIGIN,
        ...(token ? { [FIRST_ADMIN_HEADER]: token } : {}),
      },
      body: JSON.stringify({ email, password: "correct-horse-battery", name: "First" }),
    }),
  );
}

async function people(): Promise<{ email: string; role: string }[]> {
  const { results } = await env.DB.prepare(
    "SELECT email, role FROM core_user WHERE kind = 'human' ORDER BY created_at",
  ).all<{ email: string; role: string }>();
  return results;
}

const LATER = new Date(Date.now() + 3_600_000).toISOString();

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM core_session"),
    env.DB.prepare("DELETE FROM core_account"),
    env.DB.prepare("DELETE FROM core_user"),
    // An installed pack's principal, as `extension.install` makes one (migration 0020).
    env.DB.prepare(
      "INSERT INTO core_user (id, name, email, email_verified, created_at, updated_at, role, kind) VALUES ('extension:ticketing', 'Ticketing', 'ticketing@extensions.crm.invalid', 0, '2026-11-27T00:00:00Z', '2026-11-27T00:00:00Z', 'member', 'extension')",
    ),
  ]);
});

describe("a single-client deployment", () => {
  it("lets the first person sign up and makes them admin, an installed pack's principal notwithstanding", async () => {
    expect(await awaitingFirstUser(env.DB)).toBe(true);
    const response = await signUp(authEnv(), "owner@example.com");
    expect(response?.status).toBe(200);
    expect(await people()).toEqual([{ email: "owner@example.com", role: "admin" }]);
    expect(await awaitingFirstUser(env.DB)).toBe(false);
  });
});

describe("a client of a host of many clients", () => {
  it("makes no first account when the operator has named no first admin", async () => {
    const identity = await clientEnv();
    expect((await signUp(identity, "anyone@example.com", TOKEN))?.ok).toBe(false);
    expect(await people()).toEqual([]);
  });

  it("refuses another address, a missing or wrong token and an expired link", async () => {
    const identity = await clientEnv({ email: "owner@gym-a.test", expires: LATER });
    expect((await signUp(identity, "squatter@example.com", TOKEN))?.ok).toBe(false);
    expect((await signUp(identity, "owner@gym-a.test"))?.ok).toBe(false);
    expect((await signUp(identity, "owner@gym-a.test", `${TOKEN.slice(0, -1)}x`))?.ok).toBe(false);
    const expired = await clientEnv({
      email: "owner@gym-a.test",
      expires: new Date(Date.now() - 1000).toISOString(),
    });
    expect((await signUp(expired, "owner@gym-a.test", TOKEN))?.ok).toBe(false);
    expect(await people()).toEqual([]);
  });

  it("makes the named address, with the link's token, the admin, and the link works once", async () => {
    const identity = await clientEnv({ email: "owner@gym-a.test", expires: LATER });
    // The address as typed, in any case.
    const response = await signUp(identity, "Owner@Gym-A.test", TOKEN);
    expect(response?.status, await response?.clone().text()).toBe(200);
    expect(await people()).toEqual([{ email: "owner@gym-a.test", role: "admin" }]);
    // The client has its admin: the same link makes no second account.
    expect((await signUp(identity, "other@gym-a.test", TOKEN))?.ok).toBe(false);
    expect(await people()).toHaveLength(1);
  });

  it("reads a first admin that is not exactly its shape as none", async () => {
    const identity = authEnv({ COS_CLIENT_ID: "gym-bad", COS_FIRST_ADMIN: '{"email":"x"}' });
    expect((await signUp(identity, "x", TOKEN))?.ok).toBe(false);
    expect(await people()).toEqual([]);
  });
});
