// Stage 22 step 4 (ADR 0402): customer sign-in, against real D1 with a fake email-send gatekeeper.
// Acceptance criteria 7 (sessions apart), 10 (sign-in links, creates, refuses to guess, refuses
// erased addresses), 11 (invite only answers the same and sends nothing) and the part of 14 that
// says no client address is stored.
import { env } from "cloudflare:workers";
import {
  type ActingUser,
  type CallIntegration,
  inviteCustomer,
  invoke,
  sendCustomerCode,
} from "@composable-os/core";
import { createCrmDb } from "@composable-os/db";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  CUSTOMER_COOKIE_PREFIX,
  createCustomerAuth,
  createIdentityProvider,
  customerIdentity,
  getCustomerIdentity,
  IdentityConfigError,
} from "../src/index.ts";

const ORIGIN = "http://localhost:5173";
const STAFF_SECRET = "test-secret-test-secret-test-secret-123";
const CUSTOMER_SECRET = "customer-secret-customer-secret-456";
const CLIENT_IP = "203.0.113.77";
const CLIENT_AGENT = "TestBrowser/9.9 (client agent)";
const db = createCrmDb(env.DB);

// The email-send gatekeeper, faked as other tests fake it: every send applies at once.
type Call = Parameters<CallIntegration>[0];
const calls: Call[] = [];
const fakeCall: CallIntegration = async (input) => {
  calls.push(input);
  return { value: { status: "sent" }, pending: [], applied: [{ action: 1 }] };
};
const TARGET = { connectionId: "con_fake", resource: "sender-key" };

const customers = customerIdentity(
  createCustomerAuth({
    db: env.DB,
    secret: CUSTOMER_SECRET,
    baseURL: ORIGIN,
    sendCode: (message) => sendCustomerCode(fakeCall, TARGET, message),
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

function post(path: string, body: unknown, extra: Record<string, string> = {}) {
  return new Request(`${ORIGIN}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: ORIGIN,
      "x-forwarded-for": CLIENT_IP,
      "cf-connecting-ip": CLIENT_IP,
      "user-agent": CLIENT_AGENT,
      ...extra,
    },
    body: JSON.stringify(body),
  });
}

async function requestCode(email: string) {
  const sentBefore = calls.length;
  const response = await customers.handle(
    post("/api/customer-auth/email-otp/send-verification-otp", { email, type: "sign-in" }),
  );
  if (!response) throw new Error("not a customer route");
  const sent = calls.slice(sentBefore);
  const text = String((sent[0]?.args[0] as { text?: unknown } | undefined)?.text ?? "");
  return {
    status: response.status,
    body: await response.text(),
    sent,
    code: /\b(\d{6})\b/.exec(text)?.[1] ?? null,
  };
}

function cookieOf(response: Response): string {
  return response.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
}

async function signIn(email: string, code: string) {
  const response = await customers.handle(
    post("/api/customer-auth/sign-in/email-otp", { email, otp: code }),
  );
  if (!response) throw new Error("not a customer route");
  return { response, cookie: cookieOf(response) };
}

/** Requests a code and signs in with it. */
async function signInFully(email: string) {
  const { code } = await requestCode(email);
  if (!code) throw new Error(`no code was sent to ${email}`);
  const { response, cookie } = await signIn(email, code);
  expect(response.status).toBe(200);
  const body = (await response.clone().json()) as { account: string; user: { id: string } };
  return { cookie, body };
}

const asRequest = (cookie: string) => new Request(`${ORIGIN}/`, { headers: { cookie } });

async function customerRow(email: string) {
  return env.DB.prepare("SELECT * FROM core_customer WHERE email = ?")
    .bind(email)
    .first<{ id: string; person_id: string | null; link_state: string; status: string }>();
}

async function setSignup(mode: "open" | "invite_only") {
  await invoke(
    "customer.settings.update",
    { signup: mode },
    {
      actor: "human",
      user: admin,
      origin: { surface: "ui" },
      db,
    },
  );
}

async function createPerson(email: string) {
  return invoke(
    "person.create",
    { givenName: "Pat", familyName: email.split("@")[0], emails: [{ email }] },
    { actor: "human", user: admin, origin: { surface: "ui" }, db },
  );
}

async function erasedHash(email: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(email.trim().toLowerCase()),
  );
  return `sha256:${[...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

beforeAll(async () => {
  const id = "usr_01JCUSTOMERADMIN000000000A";
  const now = new Date().toISOString();
  await env.DB.prepare(
    "INSERT INTO core_user (id, name, email, email_verified, created_at, updated_at) VALUES (?, 'Admin', 'admin@org.example', 1, ?, ?)",
  )
    .bind(id, now, now)
    .run();
  await env.DB.prepare("UPDATE core_user SET role = 'admin' WHERE id = ?").bind(id).run();
  admin = { id, email: "admin@org.example", name: "Admin", role: "admin" };
});

beforeEach(async () => {
  await setSignup("invite_only");
});

describe("invite only (criterion 11)", () => {
  it("is the default", async () => {
    await env.DB.prepare("DELETE FROM core_settings WHERE key = 'customer_signup'").run();
    expect(
      await invoke(
        "customer.settings.get",
        {},
        {
          actor: "human",
          user: admin,
          origin: { surface: "ui" },
          db,
        },
      ),
    ).toEqual({ signup: "invite_only" });
  });

  it("answers an uninvited address exactly as an invited one, and sends it nothing", async () => {
    const invited = address("invited");
    const stranger = address("stranger");
    await inviteCustomer(db, invited, admin.id);

    const toInvited = await requestCode(invited);
    const toStranger = await requestCode(stranger);
    expect(toStranger.status).toBe(toInvited.status);
    expect(toStranger.body).toBe(toInvited.body);
    expect(toInvited.sent).toHaveLength(1);
    expect(toInvited.code).toMatch(/^\d{6}$/);
    expect(toStranger.sent).toHaveLength(0);

    // Nothing is kept for the stranger, so no code can be guessed into an account.
    const stored = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM core_customer_verification WHERE identifier LIKE ?",
    )
      .bind(`%${stranger}`)
      .first<{ n: number }>();
    expect(stored?.n).toBe(0);
    const guessed = await signIn(stranger, "123456");
    expect(guessed.response.ok).toBe(false);
    expect(await customerRow(stranger)).toBeNull();
  });

  it("sends the code through the email-send gatekeeper, stored only as a hash", async () => {
    const email = address("hash");
    await inviteCustomer(db, email, admin.id);
    const { sent, code } = await requestCode(email);
    expect(sent[0]).toMatchObject({
      connectionId: TARGET.connectionId,
      resource: TARGET.resource,
      method: "send",
    });
    expect(sent[0]?.args[0]).toMatchObject({ to: [email] });
    const row = await env.DB.prepare(
      "SELECT value FROM core_customer_verification WHERE identifier = ?",
    )
      .bind(`sign-in-otp-${email}`)
      .first<{ value: string }>();
    expect(row?.value).toBeTruthy();
    expect(row?.value).not.toContain(code ?? "missing");
  });

  it("sends a code to an address that already has an account", async () => {
    const email = address("returning");
    await inviteCustomer(db, email, admin.id);
    await signInFully(email);
    await env.DB.prepare("DELETE FROM core_customer_invite WHERE email = ?").bind(email).run();
    expect((await requestCode(email)).sent).toHaveLength(1);
  });

  it("refuses a disabled account a code, and resolves its session to the public", async () => {
    const email = address("disabled");
    await inviteCustomer(db, email, admin.id);
    const { cookie } = await signInFully(email);
    expect((await customers.resolve(asRequest(cookie))).kind).toBe("customer");
    await env.DB.prepare("UPDATE core_customer SET status = 'disabled' WHERE email = ?")
      .bind(email)
      .run();
    expect(await customers.resolve(asRequest(cookie))).toEqual({ kind: "public" });
    expect((await requestCode(email)).sent).toHaveLength(0);
  });

  it("customer.disable and customer.revokeSessions end a session, so it resolves to the public", async () => {
    const staff = { actor: "human", user: admin, origin: { surface: "ui" }, db } as const;
    const email = address("staffops");
    await inviteCustomer(db, email, admin.id);
    const first = await signInFully(email);
    const id = first.body.user.id;
    expect((await customers.resolve(asRequest(first.cookie))).kind).toBe("customer");

    await invoke("customer.revokeSessions", { id }, staff);
    expect(await customers.resolve(asRequest(first.cookie))).toEqual({ kind: "public" });

    const second = await signInFully(email);
    expect((await customers.resolve(asRequest(second.cookie))).kind).toBe("customer");
    await invoke("customer.disable", { id }, staff);
    expect(await customers.resolve(asRequest(second.cookie))).toEqual({ kind: "public" });
    expect((await requestCode(email)).sent).toHaveLength(0);

    // Enabled again, the old session stays ended; a new sign-in works.
    await invoke("customer.enable", { id }, staff);
    expect(await customers.resolve(asRequest(second.cookie))).toEqual({ kind: "public" });
    const third = await signInFully(email);
    expect((await customers.resolve(asRequest(third.cookie))).kind).toBe("customer");
  });
});

describe("first sign-in links the account (criterion 10)", () => {
  it("links to the one Person with the address", async () => {
    const email = address("one");
    const person = await createPerson(email);
    await inviteCustomer(db, email, admin.id);
    const { cookie, body } = await signInFully(email);
    expect(body.account).toBe("ready");

    const row = await customerRow(email);
    expect(row).toMatchObject({ person_id: person.id, link_state: "linked", status: "active" });
    expect(row?.id).toMatch(/^cus_[0-9A-Z]{26}$/);
    expect(await customers.resolve(asRequest(cookie))).toEqual({
      kind: "customer",
      customerId: row?.id,
      personId: person.id,
    });
    const audit = await env.DB.prepare(
      "SELECT actor, user_id, result FROM core_audit WHERE operation = 'customer.link' AND user_id = ?",
    )
      .bind(row?.id)
      .first<{ actor: string; result: string }>();
    expect(audit?.actor).toBe("customer");
    expect(JSON.parse(audit?.result ?? "{}")).toMatchObject({
      linkState: "linked",
      personId: person.id,
      created: false,
    });
  });

  it("creates a Person when none has the address (sign-up open)", async () => {
    await setSignup("open");
    const email = address("new");
    const { cookie, body } = await signInFully(email);
    expect(body.account).toBe("ready");
    const row = await customerRow(email);
    expect(row?.person_id).toMatch(/^per_/);
    const person = await invoke(
      "person.get",
      { id: row?.person_id as string },
      {
        actor: "human",
        user: admin,
        origin: { surface: "ui" },
        db,
      },
    );
    expect(person.emails.map((e) => e.email)).toEqual([email]);
    // Created by the same operation staff use, so it is audited and searchable like any Person.
    // Sign-up is open and nobody invited the address, so it is created for the first admin.
    const created = await env.DB.prepare(
      "SELECT actor, user_id, origin FROM core_audit WHERE operation = 'person.create' AND result LIKE ?",
    )
      .bind(`%${row?.person_id}%`)
      .first<{ actor: string; user_id: string; origin: string }>();
    expect(created).toMatchObject({ actor: "automation", user_id: admin.id });
    expect(JSON.parse(created?.origin ?? "{}")).toMatchObject({
      surface: "system",
      automationId: "customer.link",
    });
    expect((await customers.resolve(asRequest(cookie))).kind).toBe("customer");
  });

  it("links nothing when several people have the address, and notifies the admins", async () => {
    // Live emails are unique, so two live people with one address can only be made by stepping
    // around the index: the case the rule must still not guess at.
    const email = address("several");
    const first = await createPerson(email);
    const second = await createPerson(address("other"));
    await env.DB.prepare("DROP INDEX core_person_emails_live_email_uq").run();
    try {
      await env.DB.prepare(
        "INSERT INTO core_person_emails (id, person_id, email, is_primary, position, created_at) VALUES ('eml_several', ?, ?, 0, 1, ?)",
      )
        .bind(second.id, email, new Date().toISOString())
        .run();
      await inviteCustomer(db, email, admin.id);
      const { cookie, body } = await signInFully(email);
      expect(body.account).toBe("needs_attention");

      const row = await customerRow(email);
      expect(row).toMatchObject({ person_id: null, link_state: "needs_merge" });
      expect(await customers.resolve(asRequest(cookie))).toEqual({ kind: "public" });
      const notice = await env.DB.prepare(
        "SELECT title, body, link FROM core_notifications WHERE user_id = ? AND dedupe_key = ?",
      )
        .bind(admin.id, `customer.needs_merge:${row?.id}`)
        .first<{ title: string; body: string; link: string }>();
      expect(notice?.title).toBe("A customer account needs a merge");
      expect(notice?.body).toContain("2 people");
      expect([first.id, second.id]).toContain(JSON.parse(notice?.link ?? "{}").id);
    } finally {
      await env.DB.prepare("DELETE FROM core_person_emails WHERE id = 'eml_several'").run();
      await env.DB.prepare(
        "CREATE UNIQUE INDEX core_person_emails_live_email_uq ON core_person_emails (email) WHERE live = 1",
      ).run();
    }
    // Once staff have merged (here: the duplicate address is gone), the next sign-in links.
    const { body } = await signInFully(email);
    expect(body.account).toBe("ready");
    expect(await customerRow(email)).toMatchObject({ person_id: first.id, link_state: "linked" });
  });

  it("refuses an erased address: the same answer, nothing sent, no account", async () => {
    await setSignup("open");
    const email = address("erased");
    const control = await requestCode(address("control"));
    await env.DB.prepare(
      "INSERT INTO core_erased_address (hash, object_type, erased_at, erased_by) VALUES (?, 'person', ?, NULL)",
    )
      .bind(await erasedHash(email), new Date().toISOString())
      .run();
    const refused = await requestCode(email);
    expect(refused.status).toBe(control.status);
    expect(refused.body).toBe(control.body);
    expect(refused.sent).toHaveLength(0);
    expect((await signIn(email, "123456")).response.ok).toBe(false);
    expect(await customerRow(email)).toBeNull();
  });
});

describe("customer and staff sessions are apart (criterion 7)", () => {
  it("a customer cookie is refused by the staff resolver, under its own name or the staff one", async () => {
    const email = address("apart");
    await inviteCustomer(db, email, admin.id);
    const { cookie } = await signInFully(email);
    expect(cookie).toContain(`${CUSTOMER_COOKIE_PREFIX}.session_token=`);
    expect((await customers.resolve(asRequest(cookie))).kind).toBe("customer");

    expect(await staff.resolve(asRequest(cookie))).toBeNull();
    const renamed = cookie.replaceAll(`${CUSTOMER_COOKIE_PREFIX}.`, "better-auth.");
    expect(await staff.resolve(asRequest(renamed))).toBeNull();
  });

  it("a staff cookie is refused by the customer resolver, under its own name or the customer one", async () => {
    // biome-ignore lint/style/noNonNullAssertion: the Better Auth adapter always has routes.
    const response = await staff.handle!(
      post("/api/auth/sign-up/email", {
        email: address("staff"),
        password: "correct-horse-battery",
        name: "Staff",
      }),
    );
    expect(response?.status).toBe(200);
    const cookie = response ? cookieOf(response) : "";
    expect(await staff.resolve(asRequest(cookie))).not.toBeNull();

    expect(await customers.resolve(asRequest(cookie))).toEqual({ kind: "public" });
    const renamed = cookie.replaceAll("better-auth.", `${CUSTOMER_COOKIE_PREFIX}.`);
    expect(await customers.resolve(asRequest(renamed))).toEqual({ kind: "public" });
  });

  it("serves only the customer sign-in routes", async () => {
    const signUp = await customers.handle(
      post("/api/customer-auth/sign-up/email", {
        email: address("pw"),
        password: "correct-horse-battery",
        name: "X",
      }),
    );
    expect(signUp?.status).toBe(404);
    const reset = await customers.handle(
      post("/api/customer-auth/email-otp/request-password-reset", { email: address("pw") }),
    );
    expect(reset?.status).toBe(404);
    expect(await customers.handle(new Request(`${ORIGIN}/api/auth/get-session`))).toBeNull();
  });

  it("refuses to start without its own secret", () => {
    const send = async () => {};
    expect(() => getCustomerIdentity({ DB: env.DB }, send)).toThrow(IdentityConfigError);
    expect(() =>
      getCustomerIdentity(
        { DB: env.DB, CUSTOMER_AUTH_SECRET: STAFF_SECRET, BETTER_AUTH_SECRET: STAFF_SECRET },
        send,
      ),
    ).toThrow(IdentityConfigError);
  });
});

describe("no client address is stored (criterion 14)", () => {
  const TABLES = [
    "core_customer",
    "core_customer_session",
    "core_customer_verification",
    "core_customer_invite",
  ];

  it("the customer tables have no column for one", async () => {
    for (const table of TABLES) {
      const { results } = await env.DB.prepare(
        `SELECT name FROM pragma_table_info('${table}')`,
      ).all<{
        name: string;
      }>();
      expect(results.length).toBeGreaterThan(0);
      for (const { name } of results) expect(name).not.toMatch(/ip|address|agent/i);
    }
  });

  it("no customer row holds the client's address or user agent", async () => {
    const email = address("noip");
    await inviteCustomer(db, email, admin.id);
    await requestCode(address("noip-stranger"));
    await signInFully(email);
    for (const table of TABLES) {
      const { results } = await env.DB.prepare(`SELECT * FROM ${table}`).all();
      const text = JSON.stringify(results);
      expect(text).not.toContain(CLIENT_IP);
      expect(text).not.toContain(CLIENT_AGENT);
    }
  });
});
