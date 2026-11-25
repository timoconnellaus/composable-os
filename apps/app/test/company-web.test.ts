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
import { formPageRoute } from "../../../templates/client/apps/web/src/host.ts";
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

  // Stage 48 (ADR 0715, amended 2026-11-26): the account blocks sign in again in place through
  // this site's /auth/sign-in; the host ends the session the browser's cookie named.
  it("signing in again in place ends the session the cookie held", async () => {
    const email = await invitedPerson("Mary");
    await browse("/auth/code", { body: { email } });
    const first = await browse("/auth/sign-in", {
      body: { email, code: sentCodes.get(email.toLowerCase()) },
    });
    const old = (first.cookies[0] as string).split(";")[0] as string;
    await browse("/auth/code", { body: { email }, cookie: old });
    const again = await browse("/auth/sign-in", {
      body: { email, code: sentCodes.get(email.toLowerCase()) },
      cookie: old,
    });
    expect(again.status, again.text).toBe(200);
    const jar = (again.cookies[0] as string).split(";")[0] as string;
    expect((await browse("/account", { cookie: jar })).status).toBe(200);
    expect((await browse("/account", { cookie: old })).status).toBe(401);
  });

  it("the operation route passes the browser's allowed calls, same origin only (ADR 0451)", async () => {
    const email = await invitedPerson("Grace");
    await browse("/auth/code", { body: { email } });
    const code = sentCodes.get(email.toLowerCase());
    const signedIn = await browse("/auth/sign-in", { body: { email, code } });
    const jar = (signedIn.cookies[0] as string).split(";")[0] as string;
    const op = (name: string, headers: Record<string, string>, body: string | undefined = "{}") =>
      env.COMPANY_WEB.fetch(`${WEB_ORIGIN}/api/v1/op/${name}`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie: jar, ...headers },
        body,
      });

    // The browser's typed client, from this site, as the signed-in customer.
    const me = await op("me.get", { origin: WEB_ORIGIN });
    expect(me.status).toBe(200);
    expect(((await me.json()) as { data: { displayName: string } }).data.displayName).toBe(
      "Grace Lovelace",
    );
    // No Set-Cookie or other host header comes back through it.
    expect(me.headers.getSetCookie()).toEqual([]);
    // A read with no Origin is allowed; a write with none is not.
    expect((await op("me.get", {})).status).toBe(200);
    expect((await op("me.update", { "idempotency-key": "k-1" }, '{"givenName":"G"}')).status).toBe(
      403,
    );
    const written = await op(
      "me.update",
      { origin: WEB_ORIGIN, "idempotency-key": crypto.randomUUID() },
      JSON.stringify({ givenName: "Gracie" }),
    );
    expect(written.status, await written.clone().text()).toBe(200);
    // Another site, an operation not allowed, a body that is not JSON: refused.
    expect((await op("me.get", { origin: "https://evil.example" })).status).toBe(403);
    expect((await op("me.sessions.list", { origin: WEB_ORIGIN })).status).toBe(404);
    expect((await op("me.get", { origin: WEB_ORIGIN, "content-type": "text/plain" })).status).toBe(
      415,
    );
    // An Authorization header is never forwarded: a staff token here is nobody.
    const staffToken = await issueDeviceSession(
      db,
      { audience: "staff", subjectId: admin.id },
      "Laptop",
      new Date(),
    );
    const asToken = await env.COMPANY_WEB.fetch(`${WEB_ORIGIN}/api/v1/op/me.get`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: WEB_ORIGIN,
        authorization: `Bearer ${staffToken.accessToken}`,
      },
      body: "{}",
    });
    expect(asToken.status).toBe(404);
    expect(((await asToken.json()) as { error: { code: string } }).error.code).toBe(
      "unknown_operation",
    );
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

describe("the form page on the company's own hostname (stage 29, ADR 0728)", () => {
  const TOKEN = "A".repeat(43);

  it("forwards /form and /f/<slug> to the host's page, with no referrer and the page's own policy", async () => {
    // No Forms on this host: both pages are the plain not-found answer, drawn by the host.
    const link = await env.COMPANY_WEB.fetch(`${WEB_ORIGIN}/form?t=${TOKEN}`);
    expect(link.status).toBe(404);
    expect(link.headers.get("referrer-policy")).toBe("no-referrer");
    expect(link.headers.get("cache-control")).toBe("no-store");
    expect(link.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(link.headers.get("set-cookie")).toBeNull();
    const html = await link.text();
    expect(html).toContain("This link cannot be used");
    expect(html).not.toMatch(/<script[^>]*\ssrc=/);
    const form = await env.COMPANY_WEB.fetch(`${WEB_ORIGIN}/f/ask-about-a-trial`);
    expect(form.status).toBe(404);
    expect(await form.text()).toContain("This form is not open");
    // Not the page's: the site's own.
    expect((await env.COMPANY_WEB.fetch(`${WEB_ORIGIN}/forms`)).status).toBe(404);
  });

  it("refuses a send from another site or a sibling subdomain before it reaches the host", async () => {
    const send = (headers: Record<string, string>) =>
      env.COMPANY_WEB.fetch(`${WEB_ORIGIN}/f/newsletter`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
        body: "a.news=yes",
      });
    for (const headers of <Record<string, string>[]>[
      { origin: "https://elsewhere.example" },
      { "sec-fetch-site": "cross-site" },
      // A page on a sibling subdomain, with the signed-in customer's cookie going along.
      { "sec-fetch-site": "same-site", origin: "null", cookie: "cos-customer.session_token=c.sig" },
      // Neither header (an old browser): no proof it is this site's page.
      {},
    ]) {
      const refused = await send(headers);
      expect(refused.status, JSON.stringify(headers)).toBe(403);
      // The route's own refusals are never cached and send no referrer, as its pages.
      expect(refused.headers.get("referrer-policy")).toBe("no-referrer");
      expect(refused.headers.get("cache-control")).toBe("no-store");
    }
    // This site's own page: through to the host (no Forms here: the form is not open).
    expect((await send({ "sec-fetch-site": "same-origin" })).status).toBe(404);
    expect((await send({ origin: "null" })).status).toBe(404);
    // The host's page itself refuses the same, on the host's own address.
    const direct = await env.COMPANY_WEB_HOST.fetch("https://host/form", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "x",
    });
    expect(direct.status).toBe(415);
  });
});

describe("the template's form route, alone (review of PR #461)", () => {
  /** A HOST that records what the route sends it, answering as the host's page would. */
  function recordingHost() {
    const sent: { url: string; init: RequestInit }[] = [];
    return {
      sent,
      env: {
        HOST: {
          fetch: async (url: string, init: RequestInit = {}) => {
            sent.push({ url, init });
            return new Response("<p>page</p>", {
              status: 200,
              headers: { "content-type": "text/html", "set-cookie": "x=y", "x-other": "1" },
            });
          },
        },
      },
    };
  }

  it("sends the host the customer's cookie, Cloudflare's address and the form's fields, and nothing else", async () => {
    const { sent, env: hostEnv } = recordingHost();
    const answer = await formPageRoute(
      new Request(`${WEB_ORIGIN}/f/newsletter`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "sec-fetch-site": "same-origin",
          origin: WEB_ORIGIN,
          authorization: "Bearer staff",
          cookie: "cos-customer.session_token=c.sig; other=1",
          "cf-connecting-ip": "198.51.100.90",
          // The browser naming its own address, hoping to choose its limit.
          "cos-visitor-address": "192.0.2.250",
        },
        body: "a.news=yes",
      }),
      hostEnv,
    );
    expect(answer?.status).toBe(200);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.url).toBe("https://host/f/newsletter");
    expect(sent[0]?.init.headers).toEqual({
      cookie: "cos-customer.session_token=c.sig",
      "cos-visitor-address": "198.51.100.90",
      "content-type": "application/x-www-form-urlencoded",
    });
    expect(sent[0]?.init.body).toBe("a.news=yes");
    // The page's answer comes back with no cookie and no header the route does not pass.
    expect(answer?.headers.get("set-cookie")).toBeNull();
    expect(answer?.headers.get("x-other")).toBeNull();
    expect(answer?.headers.get("referrer-policy")).toBe("no-referrer");
    expect(answer?.headers.get("cache-control")).toBe("no-store");
  });

  it("answers 405, 413 and 415 itself, and HEAD with no body", async () => {
    const { sent, env: hostEnv } = recordingHost();
    const put = await formPageRoute(new Request(`${WEB_ORIGIN}/form`, { method: "PUT" }), hostEnv);
    expect(put?.status).toBe(405);
    expect(put?.headers.get("allow")).toBe("GET, HEAD, POST");
    expect(put?.headers.get("referrer-policy")).toBe("no-referrer");
    const post = (body: string, headers: Record<string, string> = {}) =>
      formPageRoute(
        new Request(`${WEB_ORIGIN}/form`, {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            "sec-fetch-site": "same-origin",
            ...headers,
          },
          body,
        }),
        hostEnv,
      );
    const declared = await post("a=1", { "content-length": "200000" });
    expect(declared?.status).toBe(413);
    expect(declared?.headers.get("cache-control")).toBe("no-store");
    expect((await post("a=".padEnd(140_000, "x")))?.status).toBe(413);
    expect((await post("{}", { "content-type": "application/json" }))?.status).toBe(415);
    expect(sent).toEqual([]);
    const head = await formPageRoute(
      new Request(`${WEB_ORIGIN}/form?t=x`, { method: "HEAD" }),
      hostEnv,
    );
    expect(head?.status).toBe(200);
    expect(await head?.text()).toBe("");
    expect(sent[0]?.url).toBe("https://host/form?t=x");
  });
});
