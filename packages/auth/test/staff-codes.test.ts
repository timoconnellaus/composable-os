// Staff invites accepted by an emailed code (ADR 0455), through the real Better Auth staff
// configuration and D1. Each refusal names the check that makes it, so removing the check fails
// the test:
// - bound to its address: `loadPendingInvite`'s and `acceptInvite`'s address condition;
// - works once: `acceptInvite`'s `accepted_at IS NULL`, and the code is deleted when used;
// - expiry and revocation: `acceptInvite`'s `expires_at` and `revoked_at` conditions;
// - no takeover: `staffMayGetCode`'s verified-account rule, and the invite applying only in the
//   insert of a new account;
// - sign-up still closed: the user hook's `byCode` path, which accepts only an invite.
import { env } from "cloudflare:workers";
import { memoryRateLimit } from "@composable-os/core";
import { beforeAll, describe, expect, it } from "vitest";
import {
  createIdentityProvider,
  getBetterAuth,
  type IdentityEnv,
  provideStaffCodes,
  requestStaffCode,
  staffSignInWithCode,
} from "../src/index.ts";

const ORIGIN = "http://localhost:5173";
let n = 0;
const unique = (prefix: string) => `${prefix}-${Date.now()}-${++n}@example.com`;

/** Codes the host would have emailed, by address. */
const sent = new Map<string, string>();

function staffEnv(overrides: Partial<IdentityEnv> = {}): IdentityEnv {
  const e: IdentityEnv = {
    DB: env.DB,
    IDENTITY_PROVIDER: "better-auth",
    BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret-123",
    BETTER_AUTH_URL: ORIGIN,
    ...overrides,
  };
  provideStaffCodes(e, {
    send: async ({ to, code }) => {
      sent.set(to.toLowerCase(), code);
    },
    ready: async () => null,
  });
  return e;
}

const closed = staffEnv();
const provider = createIdentityProvider(closed);

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  // biome-ignore lint/style/noNonNullAssertion: the Better Auth adapter always has routes.
  provider.handle!(
    new Request(`${ORIGIN}/api/auth${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN, ...headers },
      body: JSON.stringify(body),
    }),
  ) as Promise<Response>;

const askCode = (email: string) =>
  post("/email-otp/send-verification-otp", { email, type: "sign-in" });
const signIn = (email: string, otp: string, extra: Record<string, unknown> = {}) =>
  post("/sign-in/email-otp", { email, otp, ...extra });

async function invite(
  email: string,
  options: { role?: string; packRole?: string | null; permissions?: string[]; expiresAt?: string } = {},
): Promise<string> {
  const id = `uin_${crypto.randomUUID().replace(/-/g, "").slice(0, 26).toUpperCase()}`;
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO core_user_invite (id, email, role, pack_role, granted_permissions, invited_by,
       created_at, updated_at, expires_at) VALUES (?, ?, ?, ?, ?, 'usr_admin', ?, ?, ?)`,
  )
    .bind(
      id,
      email.toLowerCase(),
      options.role ?? "member",
      options.packRole ?? null,
      options.permissions?.length ? JSON.stringify(options.permissions) : null,
      now,
      now,
      options.expiresAt ?? new Date(Date.now() + 86_400_000).toISOString(),
    )
    .run();
  return id;
}

const userRow = (email: string) =>
  env.DB.prepare(
    "SELECT id, role, pack_role, granted_permissions, email_verified FROM core_user WHERE email = ?",
  )
    .bind(email.toLowerCase())
    .first<{
      id: string;
      role: string;
      pack_role: string | null;
      granted_permissions: string | null;
      email_verified: number;
    }>();

const inviteRow = (id: string) =>
  env.DB.prepare("SELECT accepted_at, accepted_user_id FROM core_user_invite WHERE id = ?")
    .bind(id)
    .first<{ accepted_at: string | null; accepted_user_id: string | null }>();

/** What a failed code sign-in answers, whatever the reason (one answer, ADR 0455). */
const REFUSED = { status: 400, body: { code: "INVALID_OTP", message: "Invalid code" } };
async function refusal(response: Response) {
  return { status: response.status, body: await response.json() };
}

beforeAll(async () => {
  // Someone already uses the deployment, so nobody below is its first user.
  const open = createIdentityProvider(staffEnv({ AUTH_ALLOW_SIGNUP: "true" }));
  // biome-ignore lint/style/noNonNullAssertion: the Better Auth adapter always has routes.
  await open.handle!(
    new Request(`${ORIGIN}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN },
      body: JSON.stringify({
        email: unique("owner"),
        password: "correct-horse-battery",
        name: "Owner",
      }),
    }),
  );
});

describe("an invited person signs in with an emailed code", () => {
  it("makes the account with the invite's role, pack role and grants, once", async () => {
    const email = unique("coach");
    const id = await invite(email, { role: "viewer", packRole: "ticketing.door" });
    expect((await askCode(email)).status).toBe(200);
    const code = sent.get(email);
    expect(code).toMatch(/^\d{6}$/);

    const response = await signIn(email, code as string);
    expect(response.status).toBe(200);
    const cookie = response.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
    const principal = await provider.resolve(new Request(ORIGIN, { headers: { cookie } }));
    expect(principal?.email).toBe(email);

    const row = await userRow(email);
    expect(row).toMatchObject({ role: "viewer", pack_role: "ticketing.door", email_verified: 1 });
    expect(await inviteRow(id)).toMatchObject({ accepted_user_id: row?.id });
    expect((await inviteRow(id))?.accepted_at).toBeTruthy();

    // A second use of the same code: refused like any wrong code.
    expect(await refusal(await signIn(email, code as string))).toEqual(REFUSED);
  });

  it("gives grants from the invite", async () => {
    const email = unique("publisher");
    await invite(email, { role: "member", permissions: ["records:publish"] });
    await askCode(email);
    expect((await signIn(email, sent.get(email) as string)).status).toBe(200);
    expect(await userRow(email)).toMatchObject({
      role: "member",
      pack_role: null,
      granted_permissions: JSON.stringify(["records:publish"]),
    });
  });

  it("an accepted invite gives nothing a second time: a later code signs in as the account", async () => {
    const email = unique("twice");
    const id = await invite(email, { role: "viewer" });
    await askCode(email);
    await signIn(email, sent.get(email) as string);
    const first = await userRow(email);
    // An admin changes the account meanwhile; signing in again must not reapply the invite.
    await env.DB.prepare("UPDATE core_user SET role = 'member' WHERE id = ?").bind(first?.id).run();
    sent.delete(email);
    await askCode(email);
    expect((await signIn(email, sent.get(email) as string)).status).toBe(200);
    expect((await userRow(email))?.role).toBe("member");
    expect((await inviteRow(id))?.accepted_user_id).toBe(first?.id);
  });
});

describe("an invite works once", () => {
  it("an accepted invite whose account was removed makes no second account", async () => {
    const email = unique("removed");
    await invite(email, { role: "member" });
    await askCode(email);
    await signIn(email, sent.get(email) as string);
    await env.DB.prepare("DELETE FROM core_user WHERE email = ?").bind(email).run();
    sent.delete(email);
    await askCode(email);
    expect(sent.has(email)).toBe(false);
    expect(await refusal(await signIn(email, "123456"))).toEqual(REFUSED);
    expect(await userRow(email)).toBeNull();
  });
});

describe("refusals answer the same as a wrong code", () => {
  it("a person with no invite and no account gets no code and the wrong-code answer", async () => {
    const email = unique("stranger");
    const asked = await askCode(email);
    expect(asked.status).toBe(200);
    expect(await asked.json()).toEqual({ success: true });
    expect(sent.has(email)).toBe(false);
    expect(await refusal(await signIn(email, "123456"))).toEqual(REFUSED);
    expect(await userRow(email)).toBeNull();
  });

  it("is bound to its address: another address gets no code and no account from it", async () => {
    const invited = unique("invited");
    const other = unique("other");
    await invite(invited);
    await askCode(other);
    expect(sent.has(other)).toBe(false);
    // The invited address's code does not work for the other address either.
    await askCode(invited);
    expect(await refusal(await signIn(other, sent.get(invited) as string))).toEqual(REFUSED);
    expect(await userRow(other)).toBeNull();
  });

  it("an expired invite sends no code, and one that expires after the code makes nothing", async () => {
    const stale = unique("stale");
    await invite(stale, { expiresAt: new Date(Date.now() - 1000).toISOString() });
    await askCode(stale);
    expect(sent.has(stale)).toBe(false);

    const late = unique("late");
    const id = await invite(late);
    await askCode(late);
    await env.DB.prepare("UPDATE core_user_invite SET expires_at = ? WHERE id = ?")
      .bind(new Date(Date.now() - 1000).toISOString(), id)
      .run();
    expect(await refusal(await signIn(late, sent.get(late) as string))).toEqual(REFUSED);
    expect(await userRow(late)).toBeNull();
  });

  it("a revoked invite makes nothing, even with a code sent before", async () => {
    const email = unique("revoked");
    const id = await invite(email);
    await askCode(email);
    await env.DB.prepare("UPDATE core_user_invite SET revoked_at = ? WHERE id = ?")
      .bind(new Date().toISOString(), id)
      .run();
    expect(await refusal(await signIn(email, sent.get(email) as string))).toEqual(REFUSED);
    expect(await userRow(email)).toBeNull();
  });

  it("an expired code and too many tries answer as a wrong code", async () => {
    const email = unique("tries");
    await invite(email);
    await askCode(email);
    for (let i = 0; i < 4; i++) {
      expect(await refusal(await signIn(email, "000000"))).toEqual(REFUSED);
    }
    const expiring = unique("expiring");
    await invite(expiring);
    await askCode(expiring);
    await env.DB.prepare("UPDATE core_verification SET expires_at = ? WHERE identifier = ?")
      .bind(new Date(Date.now() - 1000).toISOString(), `sign-in-otp-${expiring}`)
      .run();
    expect(await refusal(await signIn(expiring, sent.get(expiring) as string))).toEqual(REFUSED);
  });

  it("a request cannot set the role itself", async () => {
    const email = unique("sneaky");
    await invite(email, { role: "viewer" });
    await askCode(email);
    expect(
      await refusal(await signIn(email, sent.get(email) as string, { role: "admin" })),
    ).toEqual(REFUSED);
    expect(await userRow(email)).toBeNull();
  });
});

describe("an invite never takes over an account", () => {
  it("an unverified password account gets no code, invite or not, and keeps its role", async () => {
    const email = unique("password");
    const open = createIdentityProvider(staffEnv({ AUTH_ALLOW_SIGNUP: "true" }));
    // biome-ignore lint/style/noNonNullAssertion: the Better Auth adapter always has routes.
    await open.handle!(
      new Request(`${ORIGIN}/api/auth/sign-up/email`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: ORIGIN },
        body: JSON.stringify({ email, password: "correct-horse-battery", name: "P" }),
      }),
    );
    const before = await userRow(email);
    expect(before?.email_verified).toBe(0);
    // user.invite refuses this address; a row put in by hand still gives nothing.
    await invite(email, { role: "admin" });
    await askCode(email);
    expect(sent.has(email)).toBe(false);
    expect(await refusal(await signIn(email, "123456"))).toEqual(REFUSED);
    expect(await userRow(email)).toEqual(before);
  });

  it("a verified account signs in as itself: the invite's role is not applied", async () => {
    const email = unique("verified");
    await invite(email, { role: "viewer" });
    await askCode(email);
    await signIn(email, sent.get(email) as string);
    const made = await userRow(email);
    const id = await invite(email, { role: "admin" });
    sent.delete(email);
    await askCode(email);
    expect((await signIn(email, sent.get(email) as string)).status).toBe(200);
    expect(await userRow(email)).toEqual(made);
    expect((await inviteRow(id))?.accepted_at).toBeNull();
  });

  it("a deactivated account gets no code", async () => {
    const email = unique("gone");
    await invite(email);
    await askCode(email);
    await signIn(email, sent.get(email) as string);
    await env.DB.prepare("UPDATE core_user SET deactivated_at = ? WHERE email = ?")
      .bind(new Date().toISOString(), email)
      .run();
    sent.delete(email);
    await askCode(email);
    expect(sent.has(email)).toBe(false);
  });
});

describe("sign-up stays closed", () => {
  it("password sign-up is refused for an invited address", async () => {
    const email = unique("pw-invited");
    await invite(email, { role: "admin" });
    const response = await post("/sign-up/email", {
      email,
      password: "correct-horse-battery",
      name: "X",
    });
    expect(response.ok).toBe(false);
    expect(await userRow(email)).toBeNull();
  });

  it("serves only the code plugin's request and sign-in routes", async () => {
    for (const path of [
      "/email-otp/request-password-reset",
      "/email-otp/reset-password",
      "/forget-password/email-otp",
      "/email-otp/verify-email",
      "/email-otp/check-verification-otp",
      "/email-otp/request-email-change",
      "/email-otp/change-email",
    ]) {
      expect((await post(path, { email: "a@example.com" })).status, path).toBe(404);
    }
  });
});

describe("code requests", () => {
  it("are limited per address asked for", async () => {
    const limited = staffEnv({ CUSTOMER_CODE_RATE_LIMIT: memoryRateLimit(1) });
    const p = createIdentityProvider(limited);
    const ask = () =>
      // biome-ignore lint/style/noNonNullAssertion: the Better Auth adapter always has routes.
      p.handle!(
        new Request(`${ORIGIN}/api/auth/email-otp/send-verification-otp`, {
          method: "POST",
          headers: { "content-type": "application/json", origin: ORIGIN },
          body: JSON.stringify({ email: "flood@example.com", type: "sign-in" }),
        }),
      ) as Promise<Response>;
    expect((await ask()).status).toBe(200);
    expect((await ask()).status).toBe(429);
  });

  it("answer not set up, the same for everyone, while the host cannot send mail", async () => {
    const e = staffEnv();
    provideStaffCodes(e, { send: async () => {}, ready: async () => "no mail connection" });
    const p = createIdentityProvider(e);
    const email = unique("setup");
    await invite(email);
    for (const address of [email, unique("nobody")]) {
      // biome-ignore lint/style/noNonNullAssertion: the Better Auth adapter always has routes.
      const response = (await p.handle!(
        new Request(`${ORIGIN}/api/auth/email-otp/send-verification-otp`, {
          method: "POST",
          headers: { "content-type": "application/json", origin: ORIGIN },
          body: JSON.stringify({ email: address, type: "sign-in" }),
        }),
      )) as Response;
      expect(response.status).toBe(503);
      expect(((await response.json()) as { code: string }).code).toBe("SIGN_IN_NOT_SET_UP");
    }
  });
});

describe("native staff sign-in (no cookie)", () => {
  it("returns who signed in and leaves no cookie session behind", async () => {
    const auth = getBetterAuth(closed);
    if (!auth) throw new Error("no Better Auth");
    const email = unique("native");
    await invite(email, { role: "viewer", packRole: "ticketing.door" });
    await requestStaffCode(auth, email, new Headers());
    const signedIn = await staffSignInWithCode(
      auth,
      env.DB,
      email,
      sent.get(email) as string,
      new Headers(),
    );
    const row = await userRow(email);
    expect(signedIn).toEqual({ userId: row?.id });
    const sessions = await env.DB.prepare("SELECT COUNT(*) AS n FROM core_session WHERE user_id = ?")
      .bind(row?.id)
      .first<{ n: number }>();
    expect(sessions?.n).toBe(0);
    // Used once.
    expect(
      await staffSignInWithCode(auth, env.DB, email, sent.get(email) as string, new Headers()),
    ).toBeNull();
    // No invite, no account: the same null.
    expect(await staffSignInWithCode(auth, env.DB, unique("x"), "123456", new Headers())).toBeNull();
  });
});
