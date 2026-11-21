// Stage 24: a customer signs in on the company's own hostname, end to end over a real service
// binding. `company-web` is a stand-in for the company's web app (test/fixtures/company-web): its
// own Worker, bound to cos-app's real ClientApp entrypoint, with no database and no secret. The
// test is the browser: it talks only to https://shop.test.
//
// - Acceptance criterion 1's sign-in part: the customer signs in on the web app's hostname and the
//   signed-in page shows their name from me.get, called with the typed client over the binding.
// - Criterion 4's customer half: the cookie the browser gets is the web app's, host-only.
// - Criterion 3 over the real binding: the web app forwarding a staff cookie or a staff token
//   gets nothing a staff session would.
import { env } from "cloudflare:workers";
import { createIdentityProvider } from "@composable-os/auth";
import { inviteCustomer, issueDeviceSession } from "@composable-os/core";
import { createCrmDb } from "@composable-os/db";
import { beforeAll, describe, expect, it } from "vitest";
import { runOperation } from "../src/server/operations.ts";
import { boundTestEnv, sentCodes, WEB_ORIGIN } from "./bound-env.ts";
import { signUp, type TestUser, unique } from "./mcp-helpers.ts";

const hostEnv = boundTestEnv(env);
const db = createCrmDb(env.DB);
let admin: TestUser;

/** The browser: one request to the web app, with its cookie jar for shop.test. */
async function browse(
  path: string,
  init: { body?: unknown; cookie?: string; headers?: Record<string, string> } = {},
) {
  const response = await env.COMPANY_WEB.fetch(`${WEB_ORIGIN}${path}`, {
    method: init.body === undefined ? "GET" : "POST",
    headers: {
      ...(init.body === undefined
        ? {}
        : { "content-type": "application/json", origin: WEB_ORIGIN }),
      ...(init.cookie ? { cookie: init.cookie } : {}),
      ...init.headers,
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  return {
    status: response.status,
    text: await response.text(),
    cookies: response.headers.getSetCookie(),
  };
}

beforeAll(async () => {
  admin = await signUp(hostEnv as never, "admin");
}, 60_000);

async function invitedPerson(givenName: string) {
  const email = `${unique(givenName.toLowerCase())}@example.com`;
  const principal = await createIdentityProvider(hostEnv as never).resolve(
    new Request(WEB_ORIGIN, { headers: { cookie: admin.cookie } }),
  );
  const made = await runOperation(hostEnv as never, principal, {
    name: "person.create",
    input: { givenName, familyName: "Lovelace", emails: [{ email }] },
  });
  if (!made.ok) throw new Error(JSON.stringify(made));
  await inviteCustomer(db, email, admin.id, new Date().toISOString());
  return email;
}

describe("a customer signs in on the company's own hostname", () => {
  it("signs in with an emailed code, sees their name, and signs out", async () => {
    const email = await invitedPerson("Ada");
    expect((await browse("/account")).status).toBe(401);

    const asked = await browse("/auth/code", { body: { email } });
    expect(asked.status, asked.text).toBe(200);
    const code = sentCodes.get(email.toLowerCase());
    expect(code).toMatch(/^\d{6}$/);

    const signedIn = await browse("/auth/sign-in", { body: { email, code } });
    expect(signedIn.status, signedIn.text).toBe(200);
    // The browser keeps this cookie for shop.test: it came from shop.test and names no Domain.
    expect(signedIn.cookies).toHaveLength(1);
    const [setCookie] = signedIn.cookies as [string];
    expect(setCookie).toMatch(/^__Secure-cos-customer\.session_token=/);
    expect(setCookie).not.toMatch(/;\s*domain=/i);
    expect(setCookie).toMatch(/;\s*HttpOnly/i);
    const jar = setCookie.split(";")[0] as string;

    const account = await browse("/account", { cookie: jar });
    expect(account).toMatchObject({ status: 200, text: "Signed in as Ada Lovelace" });

    const out = await browse("/auth/sign-out", { body: {}, cookie: jar });
    expect(out.status).toBe(200);
    expect(out.cookies.join("\n")).toMatch(/cos-customer\.session_token=;/);
    // The old cookie is dead even if the browser kept it.
    expect((await browse("/account", { cookie: jar })).status).toBe(401);
  });

  it("a staff cookie or token the web app forwards is not staff over the binding", async () => {
    // The web app's own client forwards only customer cookies; call the binding as a careless or
    // compromised web app would, with everything.
    const staffToken = await issueDeviceSession(
      db,
      { audience: "staff", subjectId: admin.id },
      "Admin's laptop",
      new Date(),
    );
    const call = (headers: Record<string, string>) =>
      env.COMPANY_WEB_HOST.fetch("https://host/api/v1/op/organisation.list", {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: "{}",
      });
    const asStaffCookie = await call({ cookie: admin.cookie });
    expect(asStaffCookie.status).toBe(404);
    expect(((await asStaffCookie.json()) as { error: { code: string } }).error.code).toBe(
      "unknown_operation",
    );
    const asStaffToken = await call({ authorization: `Bearer ${staffToken.accessToken}` });
    expect(asStaffToken.status).toBe(401);
  });
});
