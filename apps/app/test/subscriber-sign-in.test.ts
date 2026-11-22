// Anyone starting a subscription (ADR 0459), through cos-app's real customer sign-in routes: with
// the setting on and a plan on sale to the public, a new address gets a code (web and native) and
// signs in to a new account linked to a new Person; with it off, or no plan on sale, the same
// address gets the same answer and no code. Codes to such new addresses are also limited for the
// whole host, and over that limit nothing is sent and the answer does not change.
import { env } from "cloudflare:workers";
import { createCustomerAuth, createIdentityProvider, customerIdentity } from "@composable-os/auth";
import {
  applyPlan,
  forgetPlanOnSale,
  inviteCustomer,
  memoryRateLimit,
  planReconcile,
  refreshSchemaRegistry,
} from "@composable-os/core";
import { createCrmDb } from "@composable-os/db";
import { manifestSchema } from "@composable-os/sdk";
import { beforeAll, describe, expect, it } from "vitest";
import { handleApi, handleCustomerAuth } from "../src/server/http/api.ts";
import { runOperation } from "../src/server/operations.ts";
import { boundTestEnv, sentCodes, WEB_ORIGIN } from "./bound-env.ts";
import { ORIGIN, signUp, type TestUser, unique } from "./mcp-helpers.ts";

const hostEnv = boundTestEnv(env);
const db = createCrmDb(env.DB);
const SCHOOL = `studio${Date.now().toString(36)}`;
const PLAN = `${SCHOOL}.plan`;
let admin: TestUser;
let plan: string;

async function asAdmin(name: string, input: unknown) {
  const principal = await createIdentityProvider(hostEnv as never).resolve(
    new Request(ORIGIN, { headers: { cookie: admin.cookie } }),
  );
  const result = await runOperation(hostEnv as never, principal, { name, input }, ORIGIN);
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  // biome-ignore lint/suspicious/noExplicitAny: a test reads whatever the operation returns
  return result.data as any;
}

const web = (path: string, body: unknown) =>
  handleCustomerAuth(
    new Request(`${WEB_ORIGIN}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: WEB_ORIGIN },
      body: JSON.stringify(body),
    }),
    hostEnv,
  );

async function native(path: string, body: unknown) {
  const response = await handleApi(
    new Request(`${ORIGIN}/api/v1${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    hostEnv,
  );
  if (!response) throw new Error("not served");
  return response;
}

/** The answers to a code request on the web and natively, as the client sees them. */
async function ask(email: string) {
  const onWeb = await web("/api/customer-auth/email-otp/send-verification-otp", {
    email,
    type: "sign-in",
  });
  const onPhone = await native("/auth/customer/code", { email });
  return [
    { status: onWeb.status, body: await onWeb.json() },
    { status: onPhone.status, body: await onPhone.json() },
  ];
}

const address = (label: string) => `${unique(label)}@visitors.test`.toLowerCase();
const count = async (table: string) =>
  (await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>())?.n ?? 0;

beforeAll(async () => {
  admin = await signUp(hostEnv as never, "admin");
  // A plan on sale to the public: a public, recurring sellable object with a priced record, the
  // orders' currency, and a payments connection.
  const manifest = manifestSchema.parse({
    id: SCHOOL,
    version: "1.0.0",
    contractVersion: 1,
    objects: {
      plan: {
        label: "Plan",
        plural: "Plans",
        titleField: "name",
        fields: {
          name: { type: "text", label: "Name", required: true },
          price: { type: "currency", label: "Price per month", currency: "AUD" },
          trialDays: { type: "number", label: "Trial days" },
        },
        sellable: { price: "price", recurring: { interval: "month", trialDays: "trialDays" } },
        public: { read: ["name", "price", "trialDays"] },
      },
    },
  });
  await applyPlan(
    (statements) => db.batch(statements),
    await planReconcile(db.query, manifest, { now: new Date().toISOString() }),
  );
  await refreshSchemaRegistry(db.query);
  await asAdmin("order.settings.update", { currency: "AUD", returnOrigins: [WEB_ORIGIN] });
  const now = new Date().toISOString();
  await env.DB.prepare(
    "INSERT INTO core_integration_connection (id, vendor, scope, owner_user_id, title, status, resources, created_at, updated_at) VALUES ('con_PAYTEST', 'payments', 'org', ?, 'Payments', 'active', ?, ?, ?)",
  )
    .bind(
      admin.id,
      JSON.stringify([
        {
          key: "merchant",
          url: "payments://merchant/fake",
          pattern: "payments://merchant/:provider",
        },
      ]),
      now,
      now,
    )
    .run();
  plan = (
    await asAdmin("record.create", {
      object: PLAN,
      values: { name: "Every class", price: 29, trialDays: 7 },
    })
  ).id;
  await asAdmin("customer.settings.update", { signup: "invite_only", startingSubscription: false });
}, 60_000);

describe("anyone starting a subscription", () => {
  it("off: a new address gets no code; on: it does; the answer is the same either way", async () => {
    const off = address("off");
    const offAnswers = await ask(off);
    expect(sentCodes.has(off)).toBe(false);

    await asAdmin("customer.settings.update", { startingSubscription: true });
    const on = address("on");
    const customersBefore = await count("core_customer");
    const peopleBefore = await count("core_person");
    expect(await ask(on)).toEqual(offAnswers);
    expect(sentCodes.has(on)).toBe(true);
    // Asking made nothing: no account and no Person until the code is entered.
    expect(await count("core_customer")).toBe(customersBefore);
    expect(await count("core_person")).toBe(peopleBefore);

    // Entering it makes the account, linked to a new Person with the address.
    const signedIn = await web("/api/customer-auth/sign-in/email-otp", {
      email: on,
      otp: sentCodes.get(on),
    });
    expect(signedIn.status).toBe(200);
    expect(((await signedIn.json()) as { account: string }).account).toBe("ready");
    const account = await db.query
      .selectFrom("core_customer")
      .select(["person_id", "link_state"])
      .where("email", "=", on)
      .executeTakeFirstOrThrow();
    expect(account.link_state).toBe("linked");
    const person = await db.query
      .selectFrom("core_person_emails")
      .select("person_id")
      .where("email", "=", on)
      .where("live", "=", 1)
      .executeTakeFirstOrThrow();
    expect(person.person_id).toBe(account.person_id);
  });

  it("signs in natively too", async () => {
    await asAdmin("customer.settings.update", { startingSubscription: true });
    const email = address("phone");
    await native("/auth/customer/code", { email });
    const signedIn = await native("/auth/customer/sign-in", {
      email,
      code: sentCodes.get(email),
      deviceName: "Visitor's phone",
    });
    expect(signedIn.status).toBe(200);
    expect(((await signedIn.json()) as { data: { account: string } }).data.account).toBe("ready");
  });

  it("with no plan on sale, nobody new gets a code, and no code is let in", async () => {
    await asAdmin("customer.settings.update", { startingSubscription: true });
    // A code sent while the plan was on sale is refused once it is not: the account is made only
    // while the rule still holds (the second check, at sign-up).
    const early = address("early");
    await ask(early);
    const code = sentCodes.get(early);
    expect(code).toMatch(/^\d{6}$/);
    await asAdmin("record.delete", { object: PLAN, id: plan });
    // A code request may reuse the answer for a minute in this isolate: forgotten here, as a
    // minute passing would. The account check below never reuses it.
    forgetPlanOnSale();
    const late = address("late");
    await ask(late);
    expect(sentCodes.has(late)).toBe(false);
    const refused = await web("/api/customer-auth/sign-in/email-otp", { email: early, otp: code });
    expect(refused.status).toBe(400);
    expect(
      await db.query
        .selectFrom("core_customer")
        .select("id")
        .where("email", "=", early)
        .executeTakeFirst(),
    ).toBeUndefined();
    await asAdmin("record.restore", { object: PLAN, id: plan });
  });
});

describe("codes to new addresses are limited for the whole host", () => {
  const sent: string[] = [];
  const limited = customerIdentity(
    createCustomerAuth({
      db: env.DB,
      secret: "customer-secret-for-the-limit-test-321",
      baseURL: WEB_ORIGIN,
      sendCode: async ({ to }) => {
        sent.push(to.toLowerCase());
      },
      codeNewRateLimit: memoryRateLimit(1),
    }),
    env.DB,
  );
  const request = async (email: string) => {
    const response = await limited.handle(
      new Request(`${WEB_ORIGIN}/api/customer-auth/email-otp/send-verification-otp`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: WEB_ORIGIN },
        body: JSON.stringify({ email, type: "sign-in" }),
      }),
    );
    if (!response) throw new Error("not a customer route");
    return { status: response.status, body: await response.text() };
  };

  it("over it, a new address gets nothing and the same answer; an invited one still gets its code", async () => {
    await asAdmin("customer.settings.update", { startingSubscription: true });
    const first = address("first");
    const second = address("second");
    const invited = address("member");
    await inviteCustomer(db, invited, admin.id);
    const one = await request(first);
    const two = await request(second);
    const three = await request(invited);
    expect(two).toEqual(one);
    expect(three).toEqual(one);
    expect(sent).toEqual([first, invited]);
    // Admins are told, once an hour while it lasts.
    await request(address("third"));
    const told = await db.query
      .selectFrom("core_notifications")
      .select("body")
      .where("user_id", "=", admin.id)
      .where("title", "=", "New visitors are not getting sign-in codes")
      .execute();
    expect(told).toHaveLength(1);
  });

  it("without the limit's binding, a new address gets no code (shut, not open); others still do", async () => {
    await asAdmin("customer.settings.update", { startingSubscription: true });
    const unbound: string[] = [];
    const identity = customerIdentity(
      createCustomerAuth({
        db: env.DB,
        secret: "customer-secret-for-the-unbound-test-654",
        baseURL: WEB_ORIGIN,
        sendCode: async ({ to }) => {
          unbound.push(to.toLowerCase());
        },
      }),
      env.DB,
    );
    const ask = async (email: string) => {
      const response = await identity.handle(
        new Request(`${WEB_ORIGIN}/api/customer-auth/email-otp/send-verification-otp`, {
          method: "POST",
          headers: { "content-type": "application/json", origin: WEB_ORIGIN },
          body: JSON.stringify({ email, type: "sign-in" }),
        }),
      );
      return { status: response?.status, body: await response?.text() };
    };
    const stranger = address("unbound");
    const invited = address("unbound-member");
    await inviteCustomer(db, invited, admin.id);
    expect(await ask(stranger)).toEqual(await ask(invited));
    expect(unbound).toEqual([invited]);
  });
});
