// A client's first day on a host of many clients (stage 66 step 9, ADR 0618 "The first client's
// day one"), through the app's real entry:
// - its first account is made only by the address the operator named, with the setup link's
//   token, at its own staff hostname: never by someone who found the hostname first, never with
//   another client's link, and never at a client that names no first admin;
// - its people read its own product label, on the sign-in page and in its mail, and never the
//   other client's.
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { createIdentityProvider, FIRST_ADMIN_HEADER } from "@composable-os/auth";
import { CUSTOMER_EMAIL_CONNECTION_SETTING, newId } from "@composable-os/core";
import { environmentFor } from "@composable-os/db/client-environment";
import {
  setUpTwoClients,
  TWO_CLIENT_FIRST_ADMIN,
  TWO_CLIENT_LABELS,
  TWO_CLIENTS,
} from "@composable-os/db/testing/two-clients";
import { beforeAll, describe, expect, it } from "vitest";
import { currentProductName } from "../src/components/product-name.ts";
import { type AppParts, hostFetch } from "../src/server/entry.ts";
import { sendSignInCode } from "../src/server/host-mail.ts";
import { createAppHandler } from "../src/server/mcp/handler.ts";
import { requestEnv, runInClientEnv } from "../src/server/request-env.ts";

const { a, b } = TWO_CLIENTS;
const host = env as unknown as Env;

/** What the sign-in page's <head> would name the product as: TanStack Start's render, stood in. */
const named: { hostname: string; name: string }[] = [];
const start = async (request: Request) => {
  if (new URL(request.url).pathname.startsWith("/api/auth/")) {
    const provider = createIdentityProvider(requestEnv() as never);
    return (await provider.handle?.(request)) ?? new Response("Not found", { status: 404 });
  }
  // The root route writes `currentProductName()` into the page's <meta> on the server.
  named.push({ hostname: new URL(request.url).hostname, name: currentProductName() });
  return new Response("page");
};
const parts: AppParts = { app: createAppHandler({ fetch: start }), start };

async function fetchAt(hostname: string, path: string, init: RequestInit = {}): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await hostFetch(
    new Request(`https://${hostname}${path}`, init),
    host,
    ctx,
    parts,
  );
  await waitOnExecutionContext(ctx);
  return response;
}

async function clientEnv(id: string): Promise<Env> {
  const found = await environmentFor(host, id);
  if (!found.served) throw new Error(`no environment for ${id}`);
  return found.env;
}

/** A password sign-up at `hostname`, with the setup link's token when given. */
function signUp(hostname: string, email: string, token?: string): Promise<Response> {
  return fetchAt(hostname, "/api/auth/sign-up/email", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: `https://${hostname}`,
      ...(token ? { [FIRST_ADMIN_HEADER]: token } : {}),
    },
    body: JSON.stringify({ email, password: "correct-horse-battery", name: "First" }),
  });
}

async function people(id: string): Promise<{ email: string; role: string }[]> {
  const { results } = await (await clientEnv(id)).DB.prepare(
    "SELECT email, role FROM core_user WHERE kind = 'human' ORDER BY created_at",
  ).all<{ email: string; role: string }>();
  return results;
}

beforeAll(async () => {
  await setUpTwoClients(env);
});

describe("the first account of a client (G5)", () => {
  const { email, token } = TWO_CLIENT_FIRST_ADMIN;

  it("is refused to anyone who is not the named address with its link, and at another client", async () => {
    // Someone who found gym-a's staff hostname first, with no link.
    expect((await signUp(a.hostname, "squatter@outside.test")).ok).toBe(false);
    // The named address, without the link, and with a link that is not it.
    expect((await signUp(a.hostname, email)).ok).toBe(false);
    expect((await signUp(a.hostname, email, `${token.slice(0, -1)}X`)).ok).toBe(false);
    // Another address carrying gym-a's link.
    expect((await signUp(a.hostname, "squatter@outside.test", token)).ok).toBe(false);
    // gym-a's link at gym-b, which names no first admin: nobody makes gym-b's first account.
    expect((await signUp(b.hostname, email, token)).ok).toBe(false);
    expect(await people(a.id)).toEqual([]);
    expect(await people(b.id)).toEqual([]);
  });

  it("is made by the named address with its link, as the admin, once", async () => {
    const response = await signUp(a.hostname, email, token);
    expect(response.status, await response.clone().text()).toBe(200);
    expect(response.headers.getSetCookie().join(";")).toMatch(/__Host-/);
    expect(await people(a.id)).toEqual([{ email, role: "admin" }]);
    expect(await people(b.id)).toEqual([]);
    // The link has done its work: it makes no second admin. (The suite's clients open staff
    // sign-up, AUTH_ALLOW_SIGNUP, so a second sign-up is a member's.)
    await signUp(a.hostname, "second@gym-a.test", token);
    expect((await people(a.id)).filter((p) => p.role === "admin")).toEqual([
      { email, role: "admin" },
    ]);
  });
});

describe("each client's product label (G8)", () => {
  it("is what its sign-in page names the product, and never the other's", async () => {
    named.length = 0;
    await fetchAt(a.hostname, "/sign-in");
    await fetchAt(b.hostname, "/sign-in");
    await fetchAt(a.hostname, "/sign-in");
    expect(named).toEqual([
      { hostname: a.hostname, name: TWO_CLIENT_LABELS.a },
      { hostname: b.hostname, name: TWO_CLIENT_LABELS.b },
      { hostname: a.hostname, name: TWO_CLIENT_LABELS.a },
    ]);
  });

  it("is what its sign-in mail names the product, and never the other's", async () => {
    const recorded = () =>
      (
        host.RUNNER as unknown as {
          recorded(): Promise<{ client: string; method: string; args: unknown[] }[]>;
        }
      ).recorded();
    for (const [c, label, other] of [
      [a, TWO_CLIENT_LABELS.a, TWO_CLIENT_LABELS.b],
      [b, TWO_CLIENT_LABELS.b, TWO_CLIENT_LABELS.a],
    ] as const) {
      const clientEnvironment = await clientEnv(c.id);
      await mailConnection(clientEnvironment, `hello@mail.${c.hostname}`);
      const before = (await recorded()).length;
      // As the entry sends it: in the client's own scope.
      await runInClientEnv(clientEnvironment, () =>
        sendSignInCode(clientEnvironment, "staff", { to: "staff@outside.test", code: "482913" }),
      ).catch(() => undefined);
      const calls = (await recorded()).slice(before).filter((x) => x.method === "integration");
      expect(calls).toHaveLength(1);
      const text = JSON.stringify(calls[0]?.args);
      expect(calls[0]?.client).toBe(c.id);
      expect(text).toContain(`Your ${label} sign-in code`);
      expect(text).toContain(`Your sign-in code for ${label} is 482913.`);
      expect(text).not.toContain(other);
    }
  });
});

/** A client's own email-send connection, bound to `sender`, chosen for the host's mail. */
async function mailConnection(clientEnvironment: Env, sender: string): Promise<void> {
  const now = new Date().toISOString();
  const user = newId("user");
  const connection = `con_${crypto.randomUUID().replace(/-/g, "")}`;
  const resources = JSON.stringify([
    {
      key: "sender1",
      url: `email-send://sender/${encodeURIComponent(sender)}`,
      pattern: "email-send://sender/:address",
      title: `Email from ${sender}`,
      tsType: "EmailSendSession",
      bindingName: "EMAIL_SEND",
    },
  ]);
  await clientEnvironment.DB.batch([
    clientEnvironment.DB.prepare(
      "INSERT INTO core_user (id, name, email, email_verified, created_at, updated_at, role) VALUES (?, 'Admin', ?, 1, ?, ?, 'admin')",
    ).bind(user, `${user}@staff.test`, now, now),
    clientEnvironment.DB.prepare(
      "INSERT INTO core_integration_connection (id, vendor, scope, owner_user_id, title, status, resources, created_at, updated_at) VALUES (?, 'email-send', 'org', ?, 'Mail', 'active', ?, ?, ?)",
    ).bind(connection, user, resources, now, now),
    clientEnvironment.DB.prepare(
      "INSERT OR REPLACE INTO core_settings (key, value, updated_at) VALUES (?, ?, ?)",
    ).bind(CUSTOMER_EMAIL_CONNECTION_SETTING, JSON.stringify(connection), now),
  ]);
}
