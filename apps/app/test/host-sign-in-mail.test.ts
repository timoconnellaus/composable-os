// Sign-in by code waits for the host's sign-in mail to be set up (ADR 0456): while the chosen
// connection's sign-in kind would be reviewed, a code request (customer or staff, browser or
// native) answers that sign-in is not set up, the same for every address, and no code is made.
// Once a human admin lets the kind apply, the request is accepted. The send itself is cos-runner's
// (apps/runner/test/sign-in-mail.test.ts); this suite's runner is a stub, so the code it would
// send is then deleted as an unsent one (ADR 0455).
import { env } from "cloudflare:workers";
import { createIdentityProvider } from "@composable-os/auth";
import { inviteCustomer, newId } from "@composable-os/core";
import { createCrmDb } from "@composable-os/db";
import { beforeAll, describe, expect, it } from "vitest";
import { type ApiEnv, handleApi } from "../src/server/http/api.ts";
import { runOperation } from "../src/server/operations.ts";
import { ORIGIN, signUp, type TestUser, testEnv, unique } from "./mcp-helpers.ts";

// Its own env object: cos-app builds customer sign-in once per env, with the real sender and
// readiness check (not bound-env.ts's capturing one).
const hostEnv = {
  ...testEnv(),
  CUSTOMER_AUTH_SECRET: "customer-secret-for-host-mail-0123",
  CUSTOMER_AUTH_URL: ORIGIN,
} as unknown as ApiEnv;
const db = createCrmDb(env.DB);
let admin: TestUser;

async function post(path: string, body: unknown) {
  const response = await handleApi(
    new Request(`${ORIGIN}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    hostEnv,
  );
  if (!response) throw new Error("not served");
  // biome-ignore lint/suspicious/noExplicitAny: a test reads whatever the envelope holds
  return { status: response.status, body: (await response.json()) as Record<string, any> };
}

async function asAdmin(name: string, input: unknown) {
  const principal = await createIdentityProvider(hostEnv as never).resolve(
    new Request(ORIGIN, { headers: { cookie: admin.cookie } }),
  );
  const result = await runOperation(hostEnv as never, principal, { name, input }, ORIGIN);
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  // biome-ignore lint/suspicious/noExplicitAny: a test reads whatever the operation returns
  return result.data as any;
}

const codesFor = async (identifier: string) =>
  (
    await env.DB.prepare(
      "SELECT (SELECT COUNT(*) FROM core_customer_verification WHERE identifier = ?) + (SELECT COUNT(*) FROM core_verification WHERE identifier = ?) AS n",
    )
      .bind(identifier, identifier)
      .first<{ n: number }>()
  )?.n;

beforeAll(async () => {
  admin = await signUp(hostEnv as never, "admin");
  // An org outbox of the fake provider, with its sender bound, as the host's mail connection.
  const id = newId("connection");
  const now = new Date().toISOString();
  await db.query
    .insertInto("core_integration_connection")
    .values({
      id,
      vendor: "fake",
      scope: "org",
      owner_user_id: admin.id,
      title: "Host mail",
      status: "active",
      resources: JSON.stringify([{ key: "OUTBOX", pattern: "fake://outbox/:address" }]),
      created_at: now,
      updated_at: now,
    })
    .execute();
  await asAdmin("customer.settings.update", { emailConnectionId: id });
}, 60_000);

describe("sign-in by code needs the host's sign-in mail", () => {
  it("answers not set up, the same for every address, and makes no code, while it is reviewed", async () => {
    const settings = await asAdmin("customer.settings.get", {});
    expect(settings.signInMail).toMatchObject({
      ready: false,
      kind: { tag: "fake.signin", label: "Send sign-in codes" },
    });
    const invited = `${unique("invited")}@outside.test`;
    await inviteCustomer(db, invited, admin.id, new Date().toISOString());
    for (const [path, email] of [
      ["/api/v1/auth/customer/code", invited],
      ["/api/v1/auth/customer/code", `${unique("nobody")}@outside.test`],
      ["/api/v1/auth/staff/code", `${unique("staff")}@outside.test`],
    ] as const) {
      const answer = await post(path, { email });
      expect(answer.status, path).toBe(503);
      expect(answer.body.error.details.reason).toBe("sign_in_not_set_up");
      expect(answer.body.error.message).toContain("Send sign-in codes");
    }
    expect(await codesFor(`sign-in-otp-${invited}`)).toBe(0);
  });

  it("accepts the request once a human admin lets the kind apply", async () => {
    await asAdmin("outbound.setAutoApprove", { tag: "fake.signin", enabled: true });
    expect((await asAdmin("customer.settings.get", {})).signInMail).toMatchObject({
      ready: true,
      problem: null,
    });
    const invited = `${unique("ready")}@outside.test`;
    await inviteCustomer(db, invited, admin.id, new Date().toISOString());
    const answer = await post("/api/v1/auth/customer/code", { email: invited });
    expect(answer).toMatchObject({ status: 200, body: { data: { ok: true } } });
    // The stub runner sends nothing, so the code is deleted as unsent (ADR 0455).
    expect(await codesFor(`sign-in-otp-${invited}`)).toBe(0);
    await asAdmin("outbound.setAutoApprove", { tag: "fake.signin", enabled: false });
  });

  it("is turned on only by a human: an MCP client and the assistant are refused", async () => {
    const principal = await createIdentityProvider(hostEnv as never).resolve(
      new Request(ORIGIN, { headers: { cookie: admin.cookie } }),
    );
    // runOperation is the UI's (actor human); the operation itself refuses other actors.
    const { coreRegistry } = await import("@composable-os/core");
    const op = coreRegistry.get("outbound.setAutoApprove");
    expect(op?.actors).toEqual(["human"]);
    expect(op?.mcp?.expose).toBe(false);
    expect(principal).not.toBeNull();
  });
});
