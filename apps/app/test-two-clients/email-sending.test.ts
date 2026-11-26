// Email sending per client, from the app's side (stage 66; ADR 0616, "Email sending per client"):
// each client's environment holds its own verified sender domains and never the deployment's
// list; the host's mail for gym-a (a staff invite, a sign-in code) goes to the runner as gym-a,
// on gym-a's own connection, with gym-a's own sign-in link, whatever origin the request had.
// The sending itself (the sender's domain, refusals) is the runner's suite's.
import { env } from "cloudflare:test";
import { CUSTOMER_EMAIL_CONNECTION_SETTING, newId } from "@composable-os/core";
import { environmentFor } from "@composable-os/db/client-environment";
import { setUpTwoClients, TWO_CLIENTS } from "@composable-os/db/testing/two-clients";
import { beforeAll, describe, expect, it } from "vitest";
import { hostMailFor, sendSignInCode } from "../src/server/host-mail.ts";

const { a, b } = TWO_CLIENTS;
const host = env as unknown as Env;

interface RunnerCall {
  client: string;
  method: string;
  args: unknown[];
}
const recorded = () => (host.RUNNER as unknown as { recorded(): Promise<RunnerCall[]> }).recorded();

async function clientEnv(id: string): Promise<Env> {
  const found = await environmentFor(host, id);
  if (!found.served) throw new Error(`no environment for ${id}`);
  return found.env;
}

/** A client's own email-send connection, bound to `sender`, chosen for the host's mail. */
async function hostMailConnection(clientEnvironment: Env, sender: string): Promise<string> {
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
  return connection;
}

let aEnv: Env;
let bEnv: Env;

beforeAll(async () => {
  await setUpTwoClients(env);
  aEnv = await clientEnv(a.id);
  bEnv = await clientEnv(b.id);
});

describe("each client's environment", () => {
  it("holds its own verified sender domains, and never the deployment's list", () => {
    const own = (e: Env) => e as unknown as Record<string, unknown>;
    expect(own(aEnv).COS_SENDER_DOMAINS).toBe("mail.gym-a.test");
    expect(own(bEnv).COS_SENDER_DOMAINS).toBe("mail.gym-b.test");
    for (const e of [aEnv, bEnv]) expect("ALLOWED_SENDER_DOMAINS" in own(e)).toBe(false);
  });
});

describe("gym-a's host mail", () => {
  let connection: string;
  beforeAll(async () => {
    connection = await hostMailConnection(aEnv, "hello@mail.gym-a.test");
  });

  /** The runner calls made since `before`, the method `integration` only. */
  const since = async (before: number) =>
    (await recorded()).slice(before).filter((call) => call.method === "integration");

  it("asks the runner as gym-a, on gym-a's connection, with gym-a's own sign-in link", async () => {
    const before = (await recorded()).length;
    // The request came in at gym-b's hostname: on a many-client host the link is never the
    // request's, only the client's own staff address (APP_ORIGIN).
    await hostMailFor(aEnv, `https://${b.hostname}`).sendStaffInvite({
      to: "new-staff@outside.test",
      invitedBy: "Admin",
    });
    const calls = await since(before);
    expect(calls).toHaveLength(1);
    const [call] = calls as [RunnerCall];
    expect(call.client).toBe(a.id);
    const text = JSON.stringify(call.args);
    expect(text).toContain(connection);
    expect(text).toContain(`https://${a.hostname}/sign-in`);
    expect(text).not.toMatch(/gym-b/);
  });

  it("sends a customer's sign-in code as gym-a's host mail, with nothing of gym-b's", async () => {
    const before = (await recorded()).length;
    await sendSignInCode(aEnv, "customer", { to: "member@outside.test", code: "482913" }).catch(
      () => undefined,
    );
    const calls = await since(before);
    expect(calls).toHaveLength(1);
    const [call] = calls as [RunnerCall];
    expect(call.client).toBe(a.id);
    const text = JSON.stringify(call.args);
    expect(text).toContain(connection);
    expect(text).toContain('"purpose":"sign-in"');
    expect(text).toContain("482913");
    expect(text).not.toMatch(/gym-b/);
  });

  it("invites a practitioner with gym-a's own customer sign-in address", async () => {
    const before = (await recorded()).length;
    const customerUrl = (aEnv as unknown as { CUSTOMER_AUTH_URL?: string }).CUSTOMER_AUTH_URL;
    expect(customerUrl).toBe("https://shop.gym-a.test");
    await hostMailFor(aEnv, `https://${b.hostname}`).sendPractitionerInvite?.({
      to: "physio@outside.test",
      invitedBy: "Admin",
      discipline: "Physiotherapy",
    });
    const [call] = (await since(before)) as [RunnerCall];
    expect(call.client).toBe(a.id);
    const text = JSON.stringify(call.args);
    expect(text).toContain(connection);
    expect(text).toContain("https://shop.gym-a.test");
    expect(text).not.toMatch(/gym-b/);
  });
});

describe("gym-b's host mail", () => {
  it("goes to the runner as gym-b, on gym-b's connection, with gym-b's link, never gym-a's", async () => {
    const connection = await hostMailConnection(bEnv, "desk@mail.gym-b.test");
    const before = (await recorded()).length;
    await hostMailFor(bEnv, `https://${a.hostname}`).sendStaffInvite({
      to: "new-staff@outside.test",
      invitedBy: "Admin",
    });
    const calls = (await recorded()).slice(before).filter((call) => call.method === "integration");
    expect(calls).toHaveLength(1);
    const [call] = calls as [RunnerCall];
    expect(call.client).toBe(b.id);
    const text = JSON.stringify(call.args);
    expect(text).toContain(connection);
    expect(text).toContain(`https://${b.hostname}/sign-in`);
    expect(text).not.toMatch(/gym-a/);
  });
});
