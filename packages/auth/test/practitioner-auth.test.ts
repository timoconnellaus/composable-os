// Stage 43 step 3 (ADR 0581): practitioner sign-in, against real D1. A practitioner account is
// made only by a staff invite; its sign-in is a code by email through a third Better Auth
// configuration with its own tables, cookie and key. Criterion 2 (sign-in by code; ending the
// account ends its sessions at once; one address holds a staff, a customer and a practitioner
// account, each signed in alone, and no session of one resolves to another) and criterion 8's
// part about sessions (three hats, three sign-ins).
import { env } from "cloudflare:workers";
import { type ActingUser, inviteCustomer, invoke } from "@composable-os/core";
import { createCrmDb } from "@composable-os/db";
import { beforeAll, describe, expect, it } from "vitest";
import {
  CUSTOMER_COOKIE_PREFIX,
  createCustomerAuth,
  createIdentityProvider,
  createPractitionerAuth,
  customerIdentity,
  getPractitionerIdentity,
  IdentityConfigError,
  PRACTITIONER_COOKIE_PREFIX,
  practitionerIdentity,
  practitionerSessionSecret,
} from "../src/index.ts";

const ORIGIN = "http://localhost:5173";
const STAFF_SECRET = "test-secret-test-secret-test-secret-123";
const CUSTOMER_SECRET = "customer-secret-customer-secret-456";
const CLIENT_IP = "203.0.113.78";
const db = createCrmDb(env.DB);

/** Codes each sign-in sent, by address. */
const sent: { to: string; code: string; hat: string }[] = [];

const practitioners = practitionerIdentity(
  practitionerSessionSecret(CUSTOMER_SECRET).then((secret) =>
    createPractitionerAuth({
      db: env.DB,
      secret,
      baseURL: ORIGIN,
      sendCode: async (message) => {
        sent.push({ ...message, hat: "practitioner" });
      },
    }),
  ),
  env.DB,
);
const customers = customerIdentity(
  createCustomerAuth({
    db: env.DB,
    secret: CUSTOMER_SECRET,
    baseURL: ORIGIN,
    sendCode: async (message) => {
      sent.push({ ...message, hat: "customer" });
    },
  }),
  env.DB,
);
const staff = createIdentityProvider({
  DB: env.DB,
  IDENTITY_PROVIDER: "better-auth",
  BETTER_AUTH_SECRET: STAFF_SECRET,
  BETTER_AUTH_URL: ORIGIN,
  AUTH_ALLOW_SIGNUP: "true",
});

let admin: ActingUser;
let counter = 0;
const address = (label: string) => `${label}-${Date.now().toString(36)}-${++counter}@example.com`;
const asStaff = () => ({ actor: "human", user: admin, origin: { surface: "ui" }, db }) as const;

function post(path: string, body: unknown) {
  return new Request(`${ORIGIN}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN, "cf-connecting-ip": CLIENT_IP },
    body: JSON.stringify(body),
  });
}

const cookieOf = (response: Response) =>
  response.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
const asRequest = (cookie: string) => new Request(`${ORIGIN}/`, { headers: { cookie } });

async function requestPractitionerCode(email: string) {
  const before = sent.length;
  const response = await practitioners.handle(
    post("/api/practitioner-auth/email-otp/send-verification-otp", { email, type: "sign-in" }),
  );
  if (!response) throw new Error("not a practitioner route");
  return {
    status: response.status,
    body: await response.text(),
    code: sent.slice(before).find((s) => s.to === email)?.code ?? null,
    sent: sent.slice(before),
  };
}

async function practitionerSignIn(email: string, code: string) {
  const response = await practitioners.handle(
    post("/api/practitioner-auth/sign-in/email-otp", { email, otp: code }),
  );
  if (!response) throw new Error("not a practitioner route");
  return { response, cookie: cookieOf(response) };
}

async function signInPractitioner(email: string) {
  const { code } = await requestPractitionerCode(email);
  if (!code) throw new Error(`no practitioner code was sent to ${email}`);
  const { response, cookie } = await practitionerSignIn(email, code);
  expect(response.status).toBe(200);
  return cookie;
}

async function signInCustomer(email: string) {
  await inviteCustomer(db, email, admin.id);
  const before = sent.length;
  await customers.handle(
    post("/api/customer-auth/email-otp/send-verification-otp", { email, type: "sign-in" }),
  );
  const code = sent.slice(before).find((s) => s.hat === "customer")?.code;
  if (!code) throw new Error("no customer code");
  const response = await customers.handle(
    post("/api/customer-auth/sign-in/email-otp", { email, otp: code }),
  );
  if (!response?.ok) throw new Error("customer sign-in failed");
  return cookieOf(response);
}

async function signUpStaff(email: string) {
  // biome-ignore lint/style/noNonNullAssertion: the Better Auth adapter always has routes.
  const response = await staff.handle!(
    post("/api/auth/sign-up/email", { email, password: "correct-horse-battery", name: "Staff" }),
  );
  if (response?.status !== 200) throw new Error("staff sign-up failed");
  return cookieOf(response);
}

async function invite(email: string, discipline = "Dietitian") {
  return invoke("practitioner.invite", { email, name: "Dana Diet", discipline }, asStaff());
}

async function row(email: string) {
  return env.DB.prepare("SELECT * FROM core_practitioner WHERE email = ?")
    .bind(email)
    .first<{ id: string; person_id: string; status: string; activated_at: string | null }>();
}

beforeAll(async () => {
  const id = "usr_01JPRACTITIONERADMIN00000A";
  const now = new Date().toISOString();
  await env.DB.prepare(
    "INSERT INTO core_user (id, name, email, email_verified, created_at, updated_at) VALUES (?, 'Admin', 'admin@practice.example', 1, ?, ?)",
  )
    .bind(id, now, now)
    .run();
  await env.DB.prepare("UPDATE core_user SET role = 'admin' WHERE id = ?").bind(id).run();
  admin = { id, email: "admin@practice.example", name: "Admin", role: "admin" };
});

describe("practitioner sign-in by code (criterion 2)", () => {
  it("sends a code only to an invited or active account, and answers everyone the same", async () => {
    const invited = address("invited");
    const stranger = address("stranger");
    await invite(invited);
    const toInvited = await requestPractitionerCode(invited);
    const toStranger = await requestPractitionerCode(stranger);
    expect(toStranger.status).toBe(toInvited.status);
    expect(toStranger.body).toBe(toInvited.body);
    expect(toInvited.code).toMatch(/^\d{6}$/);
    expect(toStranger.sent).toHaveLength(0);
    // Nothing is kept for the stranger, and no account is made by signing in.
    const stored = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM core_practitioner_verification WHERE identifier LIKE ?",
    )
      .bind(`%${stranger}`)
      .first<{ n: number }>();
    expect(stored?.n).toBe(0);
    const guessed = await practitionerSignIn(stranger, "123456");
    expect(guessed.response.ok).toBe(false);
    expect(await row(stranger)).toBeNull();
  });

  it("a customer or staff account with the address gets no practitioner code", async () => {
    const member = address("member-only");
    await signInCustomer(member);
    const asked = await requestPractitionerCode(member);
    expect(asked.sent).toHaveLength(0);
    const staffOnly = address("staff-only");
    await signUpStaff(staffOnly);
    expect((await requestPractitionerCode(staffOnly)).sent).toHaveLength(0);
  });

  it("the first sign-in makes the account active; its session is that practitioner", async () => {
    const email = address("first");
    const invited = await invite(email);
    expect(invited.status).toBe("invited");
    const cookie = await signInPractitioner(email);
    expect(cookie).toContain(`${PRACTITIONER_COOKIE_PREFIX}.session_token=`);
    const account = await row(email);
    expect(account).toMatchObject({ status: "active" });
    expect(account?.activated_at).toBeTruthy();
    expect(await practitioners.resolve(asRequest(cookie))).toEqual({
      kind: "practitioner",
      practitionerId: invited.id,
      personId: invited.personId,
    });
    // No client address is stored: the table has no column for one.
    const columns = await env.DB.prepare("PRAGMA table_info(core_practitioner_session)").all<{
      name: string;
    }>();
    expect(columns.results.map((c) => c.name)).not.toContain("ip_address");
    expect(columns.results.map((c) => c.name)).not.toContain("user_agent");
  });

  it("a wrong code says only that it is wrong", async () => {
    const email = address("wrong");
    await invite(email);
    await requestPractitionerCode(email);
    const { response } = await practitionerSignIn(email, "000000");
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ code: "INVALID_OTP", message: "Invalid code" });
  });

  it("practitioner.end ends every session at once and the address gets no code after", async () => {
    const email = address("ended");
    const invited = await invite(email);
    const first = await signInPractitioner(email);
    const second = await signInPractitioner(email);
    expect(await practitioners.resolve(asRequest(first))).not.toBeNull();
    await invoke("practitioner.end", { id: invited.id, reason: "Left the practice" }, asStaff());
    expect(await practitioners.resolve(asRequest(first))).toBeNull();
    expect(await practitioners.resolve(asRequest(second))).toBeNull();
    const left = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM core_practitioner_session WHERE practitioner_id = ?",
    )
      .bind(invited.id)
      .first<{ n: number }>();
    expect(left?.n).toBe(0);
    expect((await requestPractitionerCode(email)).sent).toHaveLength(0);
  });

  it("a session left on an account that is no longer active resolves to no one", async () => {
    const email = address("stale");
    await invite(email);
    const cookie = await signInPractitioner(email);
    await env.DB.prepare(
      "UPDATE core_practitioner SET status = 'ended', ended_at = ?, ended_by = 'x', ended_reason = 'x' WHERE email = ?",
    )
      .bind(new Date().toISOString(), email)
      .run();
    expect(await practitioners.resolve(asRequest(cookie))).toBeNull();
  });

  it("serves only the practitioner sign-in routes", async () => {
    const signUp = await practitioners.handle(
      post("/api/practitioner-auth/sign-up/email", {
        email: address("pw"),
        password: "correct-horse-battery",
        name: "X",
      }),
    );
    expect(signUp?.status).toBe(404);
    expect(await practitioners.handle(post("/api/customer-auth/sign-out", {}))).toBeNull();
  });

  it("fails closed without CUSTOMER_AUTH_SECRET, and with the staff secret", () => {
    const send = async () => {};
    expect(() => getPractitionerIdentity({ DB: env.DB }, send)).toThrow(IdentityConfigError);
    expect(() =>
      getPractitionerIdentity(
        { DB: env.DB, CUSTOMER_AUTH_SECRET: STAFF_SECRET, BETTER_AUTH_SECRET: STAFF_SECRET },
        send,
      ),
    ).toThrow(IdentityConfigError);
  });
});

describe("three hats, three sign-ins (criteria 2 and 8)", () => {
  it("one address holds a staff, a customer and a practitioner account, each its own session", async () => {
    const email = address("three-hats");
    const staffCookie = await signUpStaff(email);
    const customerCookie = await signInCustomer(email);
    const invited = await invite(email);
    const practitionerCookie = await signInPractitioner(email);

    // Each session resolves to its own hat.
    expect(await staff.resolve(asRequest(staffCookie))).toMatchObject({ email });
    expect((await customers.resolve(asRequest(customerCookie))).kind).toBe("customer");
    expect(await practitioners.resolve(asRequest(practitionerCookie))).toMatchObject({
      kind: "practitioner",
      practitionerId: invited.id,
    });

    // And to nothing else: no resolver reads another's cookie, under its own name or theirs.
    const rename = (cookie: string, from: string, to: string) =>
      cookie.replaceAll(`${from}.`, `${to}.`);
    expect(await practitioners.resolve(asRequest(staffCookie))).toBeNull();
    expect(await practitioners.resolve(asRequest(customerCookie))).toBeNull();
    expect(
      await practitioners.resolve(
        asRequest(rename(staffCookie, "better-auth", PRACTITIONER_COOKIE_PREFIX)),
      ),
    ).toBeNull();
    expect(
      await practitioners.resolve(
        asRequest(rename(customerCookie, CUSTOMER_COOKIE_PREFIX, PRACTITIONER_COOKIE_PREFIX)),
      ),
    ).toBeNull();
    expect(await staff.resolve(asRequest(practitionerCookie))).toBeNull();
    expect(
      await staff.resolve(
        asRequest(rename(practitionerCookie, PRACTITIONER_COOKIE_PREFIX, "better-auth")),
      ),
    ).toBeNull();
    expect(await customers.resolve(asRequest(practitionerCookie))).toEqual({ kind: "public" });
    expect(
      await customers.resolve(
        asRequest(rename(practitionerCookie, PRACTITIONER_COOKIE_PREFIX, CUSTOMER_COOKIE_PREFIX)),
      ),
    ).toEqual({ kind: "public" });

    // Ending the practitioner account leaves the other two signed in, and the reverse holds for
    // the customer account: nothing joins the three.
    await invoke("practitioner.end", { id: invited.id, reason: "Fixture" }, asStaff());
    expect(await practitioners.resolve(asRequest(practitionerCookie))).toBeNull();
    expect(await staff.resolve(asRequest(staffCookie))).toMatchObject({ email });
    expect((await customers.resolve(asRequest(customerCookie))).kind).toBe("customer");
  });
});
