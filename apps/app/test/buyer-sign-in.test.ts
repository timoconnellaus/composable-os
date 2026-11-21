// A guest buyer signs in later (ADR 0458), through cos-app's real customer sign-in routes: with
// sign-up `buyers`, the buyer of a paid order gets a code, signs in on the web (cookie) and
// natively (tokens, no cookie), and reads their order. An address with only an abandoned
// checkout, and one with no order, get the same answer and no code.
import { env } from "cloudflare:workers";
import { createIdentityProvider } from "@composable-os/auth";
import { newId } from "@composable-os/core";
import { createCrmDb } from "@composable-os/db";
import { beforeAll, describe, expect, it } from "vitest";
import { handleApi, handleCustomerAuth } from "../src/server/http/api.ts";
import { runOperation } from "../src/server/operations.ts";
import { boundTestEnv, sentCodes, WEB_ORIGIN } from "./bound-env.ts";
import { ORIGIN, signUp, type TestUser, unique } from "./mcp-helpers.ts";

const hostEnv = boundTestEnv(env);
const db = createCrmDb(env.DB);
let admin: TestUser;

async function asAdmin(name: string, input: unknown) {
  const principal = await createIdentityProvider(hostEnv as never).resolve(
    new Request(ORIGIN, { headers: { cookie: admin.cookie } }),
  );
  const result = await runOperation(hostEnv as never, principal, { name, input }, ORIGIN);
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  // biome-ignore lint/suspicious/noExplicitAny: a test reads whatever the operation returns
  return result.data as any;
}

/** An order for `email` as stage 25 leaves one: its Person, its state, what was paid. */
async function order(email: string, state: string, paid: number): Promise<string> {
  const person = await asAdmin("person.create", { givenName: "Guest", emails: [{ email }] });
  const id = newId("order");
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO core_order (id, person_id, email, currency, total, paid, state, placed_as, created_at, updated_at)
     VALUES (?, ?, ?, 'EUR', 4500, ?, ?, 'public', ?, ?)`,
  )
    .bind(id, person.id, email, paid, state, now, now)
    .run();
  return id;
}

const web = (path: string, body: unknown, cookie?: string) =>
  handleCustomerAuth(
    new Request(`${WEB_ORIGIN}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: WEB_ORIGIN,
        ...(cookie ? { cookie } : {}),
      },
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

async function call(name: string, input: unknown, credential: Record<string, string>) {
  const response = await handleApi(
    new Request(`${ORIGIN}/api/v1/op/${name}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...credential },
      body: JSON.stringify(input),
    }),
    hostEnv,
  );
  // biome-ignore lint/suspicious/noExplicitAny: a test reads whatever the envelope holds
  return { status: response?.status, body: (await response?.json()) as Record<string, any> };
}

const address = (label: string) => `${unique(label)}@buyers.test`.toLowerCase();

beforeAll(async () => {
  admin = await signUp(hostEnv as never, "admin");
  await asAdmin("customer.settings.update", { signup: "buyers" });
}, 60_000);

describe("a guest buyer signs in later", () => {
  it("answers every address the same, and only the paid buyer gets a code", async () => {
    const buyer = address("paid");
    const abandoned = address("abandoned");
    const nobody = address("nobody");
    await order(buyer, "paid", 4500);
    await order(abandoned, "pending", 0);
    const answers: unknown[] = [];
    for (const email of [buyer, abandoned, nobody]) {
      const response = await web("/api/customer-auth/email-otp/send-verification-otp", {
        email,
        type: "sign-in",
      });
      answers.push({ status: response.status, body: await response.json() });
      const nativeAnswer = await native("/auth/customer/code", { email });
      answers.push({ status: nativeAnswer.status, body: await nativeAnswer.json() });
    }
    // Every answer the same, web and native, whoever the address is.
    expect(new Set(answers.map((a) => JSON.stringify(a))).size).toBe(2);
    expect(answers[0]).toEqual(answers[2]);
    expect(answers[0]).toEqual(answers[4]);
    expect(answers[1]).toEqual(answers[3]);
    expect(answers[1]).toEqual(answers[5]);
    expect(sentCodes.has(buyer)).toBe(true);
    expect(sentCodes.has(abandoned)).toBe(false);
    expect(sentCodes.has(nobody)).toBe(false);
  });

  it("signs in on the web with the code and reads the order", async () => {
    const buyer = address("web");
    const orderId = await order(buyer, "paid", 4500);
    await web("/api/customer-auth/email-otp/send-verification-otp", {
      email: buyer,
      type: "sign-in",
    });
    const signedIn = await web("/api/customer-auth/sign-in/email-otp", {
      email: buyer,
      otp: sentCodes.get(buyer),
    });
    expect(signedIn.status).toBe(200);
    expect(((await signedIn.json()) as { account: string }).account).toBe("ready");
    const cookie = signedIn.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");
    const mine = await call("order.get", { id: orderId }, { cookie });
    expect(mine.status).toBe(200);
    expect(mine.body.data).toMatchObject({ id: orderId, state: "paid" });
  });

  it("signs in natively with no cookie and reads the order", async () => {
    const buyer = address("native");
    const orderId = await order(buyer, "part_paid", 1000);
    await native("/auth/customer/code", { email: buyer });
    const signedIn = await native("/auth/customer/sign-in", {
      email: buyer,
      code: sentCodes.get(buyer),
      deviceName: "Buyer's phone",
    });
    expect(signedIn.status).toBe(200);
    expect(signedIn.headers.getSetCookie()).toEqual([]);
    const { data } = (await signedIn.json()) as { data: { accessToken: string; account: string } };
    expect(data.account).toBe("ready");
    const mine = await call(
      "order.get",
      { id: orderId },
      { authorization: `Bearer ${data.accessToken}` },
    );
    expect(mine.body.data).toMatchObject({ id: orderId, state: "part_paid" });
  });

  it("an address with only an abandoned checkout cannot sign in, whatever code it tries", async () => {
    const abandoned = address("gone");
    await order(abandoned, "expired", 0);
    await native("/auth/customer/code", { email: abandoned });
    const refused = await native("/auth/customer/sign-in", {
      email: abandoned,
      code: "123456",
      deviceName: "Phone",
    });
    expect(refused.status).toBe(401);
    expect(
      await db.query
        .selectFrom("core_customer")
        .select("id")
        .where("email", "=", abandoned)
        .executeTakeFirst(),
    ).toBeUndefined();
  });
});
