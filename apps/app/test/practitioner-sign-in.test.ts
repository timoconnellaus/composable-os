// Stage 43 step 3 in cos-app (ADR 0581): practitioner sign-in over the HTTP surface and the
// client-app binding, with real sessions.
//
// - A practitioner signs in by an emailed code at /api/practitioner-auth/* (on the host, and over
//   the binding, where the business's web app reaches it) and their cookie is that practitioner.
// - Criterion 1 over HTTP: their cookie reaches practitioner.me and nothing else; every other
//   operation answers as a name that does not exist, the answer no session gets for a staff
//   operation, and they read none of what the public may read.
// - Criterion 2 and 8 (three hats): one address holds a staff, a customer and a practitioner
//   account; each cookie alone is its own hat, two together are refused, and ending the
//   practitioner account ends its session at once and leaves the other two.
import { env } from "cloudflare:workers";
import { createCustomerAuth, customerIdentity, getPractitionerIdentity } from "@composable-os/auth";
import { inviteCustomer, invoke } from "@composable-os/core";
import { createCrmDb } from "@composable-os/db";
import { beforeAll, describe, expect, it } from "vitest";
import { type ApiEnv, handleApi, handlePractitionerAuth } from "../src/server/http/api.ts";
import { handleBound } from "../src/server/http/bound.ts";
import type { McpEnv } from "../src/server/mcp/handler.ts";
import { ORIGIN, signUp, type TestUser, testEnv, unique } from "./mcp-helpers.ts";

const CUSTOMER_SECRET = "customer-secret-for-practitioners-321";
const apiEnv = {
  ...testEnv(),
  CUSTOMER_AUTH_SECRET: CUSTOMER_SECRET,
  CUSTOMER_AUTH_URL: ORIGIN,
} as unknown as ApiEnv & McpEnv;
const db = createCrmDb(env.DB);

/** Codes the host would have emailed, by address and hat. */
const codes = new Map<string, string>();
// The host sends codes as its sign-in mail; here the same identity (cached per env, as cos-app
// builds it) hands them to the test instead.
getPractitionerIdentity(apiEnv, async ({ to, code }) => {
  codes.set(`practitioner:${to.toLowerCase()}`, code);
});
const customers = customerIdentity(
  createCustomerAuth({
    db: env.DB,
    secret: CUSTOMER_SECRET,
    baseURL: ORIGIN,
    sendCode: async ({ to, code }) => {
      codes.set(`customer:${to.toLowerCase()}`, code);
    },
  }),
  env.DB,
);

let admin: TestUser;

const json = (path: string, body: unknown) =>
  new Request(`${ORIGIN}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN },
    body: JSON.stringify(body),
  });
const cookiesOf = (response: Response | null) =>
  (response?.headers.getSetCookie() ?? []).map((c) => c.split(";")[0]).join("; ");
const asStaff = () =>
  ({
    actor: "human",
    user: { id: admin.id, email: admin.email, name: "Admin", role: "admin" },
    origin: { surface: "ui" },
    db,
  }) as const;

/** Signs a practitioner in at the host's own route; returns their session cookie. */
async function practitionerCookie(email: string, via: "host" | "binding" = "host") {
  const send = (path: string, body: unknown) =>
    via === "host"
      ? handlePractitionerAuth(json(path, body), apiEnv)
      : handleBound(
          new Request(`https://host.internal${path}`, {
            method: "POST",
            headers: { "content-type": "application/json", origin: ORIGIN },
            body: JSON.stringify(body),
          }),
          apiEnv,
        );
  const asked = await send("/api/practitioner-auth/email-otp/send-verification-otp", {
    email,
    type: "sign-in",
  });
  expect(asked.status).toBe(200);
  const code = codes.get(`practitioner:${email}`);
  if (!code) throw new Error(`no code for ${email}`);
  const signedIn = await send("/api/practitioner-auth/sign-in/email-otp", { email, otp: code });
  expect(signedIn.status).toBe(200);
  return cookiesOf(signedIn);
}

async function customerCookie(email: string) {
  await inviteCustomer(db, email, admin.id, new Date().toISOString());
  await customers.handle(
    json("/api/customer-auth/email-otp/send-verification-otp", { email, type: "sign-in" }),
  );
  const signedIn = await customers.handle(
    json("/api/customer-auth/sign-in/email-otp", { email, otp: codes.get(`customer:${email}`) }),
  );
  return cookiesOf(signedIn);
}

/** POST /api/v1/op/<name> with a cookie (or none). */
async function api(name: string, input: unknown, cookie?: string) {
  const response = await handleApi(
    new Request(`${ORIGIN}/api/v1/op/${name}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": crypto.randomUUID(),
        ...(cookie ? { cookie } : {}),
      },
      body: JSON.stringify(input),
    }),
    apiEnv,
  );
  if (!response) throw new Error("not served");
  // biome-ignore lint/suspicious/noExplicitAny: a test reads whatever the envelope holds
  return { status: response.status, body: (await response.json()) as Record<string, any> };
}

/** The same call over the client-app binding, as the business's web app makes it. */
async function boundCall(name: string, input: unknown, cookie?: string) {
  const response = await handleBound(
    new Request(`https://host.internal/api/v1/op/${name}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": crypto.randomUUID(),
        ...(cookie ? { cookie } : {}),
      },
      body: JSON.stringify(input),
    }),
    apiEnv,
  );
  // biome-ignore lint/suspicious/noExplicitAny: a test reads whatever the envelope holds
  return { status: response.status, body: (await response.json()) as Record<string, any> };
}

let physio: { id: string; email: string; cookie: string };

beforeAll(async () => {
  admin = await signUp(apiEnv, "admin");
  const email = `${unique("physio")}@practice.example`;
  const made = await invoke(
    "practitioner.invite",
    { email, name: "Pat Physio", discipline: "Physiotherapist" },
    asStaff(),
  );
  physio = { id: made.id, email, cookie: await practitionerCookie(email) };
}, 60_000);

describe("a practitioner over the HTTP surface (criteria 1 and 2)", () => {
  it("their cookie is that practitioner: practitioner.me answers with their own account", async () => {
    const me = await api("practitioner.me", {}, physio.cookie);
    expect(me).toEqual({
      status: 200,
      body: {
        data: {
          id: physio.id,
          name: "Pat Physio",
          email: physio.email,
          discipline: "Physiotherapist",
        },
      },
    });
    // Nobody else calls it.
    expect((await api("practitioner.me", {})).status).toBe(404);
    expect((await api("practitioner.me", {}, admin.cookie)).status).toBe(404);
  });

  it("any other operation answers as one that does not exist, as for no session", async () => {
    for (const name of [
      "organisation.list",
      "person.list",
      "record.list",
      "search.global",
      "query.sql",
      "dashboard.list",
      "export.csv",
      "assistant.threads",
      "me.get",
      "practitioner.list",
      "practitioner.invite",
    ]) {
      const theirs = await api(name, {}, physio.cookie);
      expect(theirs.status, name).toBe(404);
      expect(theirs.body.error.code, name).toBe("unknown_operation");
    }
  });

  it("they read nothing the public may read: public operations do not exist for them", async () => {
    const manifest = async (cookie?: string) => {
      const response = await handleApi(
        new Request(`${ORIGIN}/api/v1/manifest`, cookie ? { headers: { cookie } } : {}),
        apiEnv,
      );
      if (!response) throw new Error("not served");
      return ((await response.json()) as { data: { operations: { name: string }[] } }).data;
    };
    expect((await manifest(physio.cookie)).operations.map((o) => o.name)).toEqual([
      "practitioner.me",
    ]);
    const publicNames = (await manifest()).operations.map((o) => o.name);
    expect(publicNames.length).toBeGreaterThan(0);
    for (const name of publicNames) {
      expect((await api(name, {}, physio.cookie)).body.error?.code, name).toBe("unknown_operation");
    }
  });

  it("a practitioner's sign-in is not exchanged for app tokens", async () => {
    const response = await handleApi(
      new Request(`${ORIGIN}/api/v1/auth/token`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: ORIGIN, cookie: physio.cookie },
        body: JSON.stringify({ deviceName: "Phone" }),
      }),
      apiEnv,
    );
    expect(response?.status).toBe(401);
  });

  it("over the binding: the web app's practitioner signs in and is that practitioner", async () => {
    const email = `${unique("dietitian")}@practice.example`;
    const made = await invoke(
      "practitioner.invite",
      { email, name: "Dana Diet", discipline: "Dietitian" },
      asStaff(),
    );
    const cookie = await practitionerCookie(email, "binding");
    const me = await boundCall("practitioner.me", {}, cookie);
    expect(me.body.data).toMatchObject({ id: made.id });
    expect((await boundCall("me.get", {}, cookie)).body.error.code).toBe("unknown_operation");
  });
});

describe("three hats, three sign-ins (criteria 2 and 8)", () => {
  it("one address: each cookie alone is its own hat, two together are refused", async () => {
    const email = `${unique("three")}@practice.example`;
    // The staff account: signed up with the address (the fixture's own sign-up helper makes a
    // random one, so it is changed to this one).
    const coach = await signUp(apiEnv, "member");
    await env.DB.prepare("UPDATE core_user SET email = ? WHERE id = ?").bind(email, coach.id).run();
    const member = await customerCookie(email);
    const made = await invoke(
      "practitioner.invite",
      { email, name: "Dana Three", discipline: "Dietitian" },
      asStaff(),
    );
    const dietitian = await practitionerCookie(email);

    // Each is its own hat.
    expect((await api("user.me", {}, coach.cookie)).body.data).toMatchObject({ id: coach.id });
    expect((await api("me.get", {}, member)).status).toBe(200);
    expect((await api("practitioner.me", {}, dietitian)).body.data).toMatchObject({ id: made.id });
    // And no other.
    expect((await api("me.get", {}, dietitian)).status).toBe(404);
    expect((await api("user.me", {}, dietitian)).status).toBe(404);
    expect((await api("practitioner.me", {}, member)).status).toBe(404);
    expect((await api("practitioner.me", {}, coach.cookie)).status).toBe(404);
    // A practitioner's cookie under a customer's name is no one, and the reverse.
    const renamed = dietitian.replaceAll("cos-practitioner.", "cos-customer.");
    expect((await api("me.get", {}, renamed)).status).toBe(404);
    const asPractitioner = member.replaceAll("cos-customer.", "cos-practitioner.");
    expect((await api("practitioner.me", {}, asPractitioner)).status).toBe(404);

    // Two at once are refused, whichever two.
    for (const both of [
      `${coach.cookie}; ${dietitian}`,
      `${member}; ${dietitian}`,
      `${coach.cookie}; ${member}`,
    ]) {
      expect((await api("practitioner.me", {}, both)).status).toBe(403);
    }
    expect((await boundCall("practitioner.me", {}, `${member}; ${dietitian}`)).status).toBe(403);

    // Ending the practitioner account ends its session at once, and leaves the other two.
    await invoke("practitioner.end", { id: made.id, reason: "Fixture" }, asStaff());
    expect((await api("practitioner.me", {}, dietitian)).status).toBe(404);
    expect((await api("user.me", {}, coach.cookie)).status).toBe(200);
    expect((await api("me.get", {}, member)).status).toBe(200);
  });
});
