// Stage 23 (ADR 0419): a customer's sign-in code is sent by the host itself, through the
// connection customer.settings names, with no staff user as its sender. The integration host
// accepts the system user (it has no core_user row); this is the security path's test.
//
// The real integration host and the fake provider's outbox, as notification-preferences.test.ts
// uses them.
import { env, exports } from "cloudflare:workers";
import {
  type ActingUser,
  CUSTOMER_MAIL_ORIGIN,
  customerCodeTarget,
  hostMailCall,
  type InvocationContext,
  invokeByName,
  SYSTEM_USER,
  sendCustomerCode,
} from "@composable-os/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fakeProviderStub } from "../src/integrations/fake.ts";
import { blobStore, integrationRuntime } from "../src/integrations/runtime.ts";
import { setPreset } from "./automation-fixture.ts";
import { createAdmin, db, host, unique } from "./helpers.ts";

const integrations = integrationRuntime(env);
const runner = exports.default as unknown as {
  gatekeeperFetch(vendor: string, request: Request): Promise<Response>;
};

function op<T>(user: ActingUser, name: string, input: unknown) {
  const ctx: InvocationContext = {
    actor: "human",
    user,
    origin: { surface: "ui" },
    db,
    integrations,
    blobs: blobStore(env),
    extensionHost: host,
  };
  return invokeByName(name, input, ctx) as Promise<T>;
}

/** The fake provider's consent page and handoff, for the org (see integrations.test.ts). */
async function connectFakeForOrg(owner: ActingUser, address: string): Promise<string> {
  const created = await op<{ connection: { id: string }; connect: { url: string; nonce: string } }>(
    owner,
    "connection.create",
    { vendor: "fake", scope: "org", sharingLevel: "full" },
  );
  const url = `http://crm.test${created.connect.url}`;
  await runner.gatekeeperFetch("fake", new Request(url));
  const done = await runner.gatekeeperFetch(
    "fake",
    new Request(url, { method: "POST", body: new URLSearchParams({ address }) }),
  );
  const ticket = /var ticket = "([^"]+)"/.exec(await done.text())?.[1] ?? "";
  await op(owner, "connection.completeConnect", {
    connectionId: created.connection.id,
    ticket,
    nonce: created.connect.nonce,
  });
  return created.connection.id;
}

let admin: ActingUser;
let outbox: string;

beforeAll(async () => {
  admin = await createAdmin();
  await op(admin, "integration.setVendor", { vendor: "fake", enabled: true });
  outbox = `${unique("customer-mail")}@example.com`;
  const connection = await connectFakeForOrg(admin, outbox);
  await op(admin, "connection.bindResource", {
    id: connection,
    url: `fake://outbox/${encodeURIComponent(outbox)}`,
  });
  // The deployment setting: the connection customer mail goes out from (human admins only).
  await op(admin, "customer.settings.update", { emailConnectionId: connection });
});

afterAll(() => setPreset("balanced"));

describe("a sign-in code, sent by the host", () => {
  it("goes out through the configured connection, sent by the system user, not a staff member", async () => {
    await setPreset("autonomous");
    const target = await customerCodeTarget(db.query);
    if ("problem" in target) throw new Error(target.problem);
    const to = `${unique("buyer")}@example.com`;
    await sendCustomerCode(hostMailCall(integrations), target.target, { to, code: "482913" });

    const sent = await fakeProviderStub(env, outbox).sent();
    const mine = sent.filter((m) => m.to.includes(to));
    expect(mine).toHaveLength(1);
    expect(mine[0]?.subject).toContain("482913");

    // The system user has no core_user row: it is no one on the staff.
    const systemRow = await env.DB.prepare("SELECT id FROM core_user WHERE id = ?")
      .bind(SYSTEM_USER.id)
      .first();
    expect(systemRow).toBeNull();
    // The send is recorded as the system's, from customer mail, and as no staff user's.
    const { results } = await env.DB.prepare(
      "SELECT actor, user_id, origin FROM core_audit WHERE origin LIKE ? ORDER BY at",
    )
      .bind(`%${CUSTOMER_MAIL_ORIGIN.automationId}%`)
      .all<{ actor: string; user_id: string; origin: string }>();
    expect(results.length).toBeGreaterThan(0);
    for (const row of results) {
      expect(row).toMatchObject({ actor: "automation", user_id: SYSTEM_USER.id });
      expect(row.user_id).not.toBe(admin.id);
    }
  });

  it("under a policy that reviews automations' sends, it is refused rather than queued", async () => {
    await setPreset("balanced");
    const target = await customerCodeTarget(db.query);
    if ("problem" in target) throw new Error(target.problem);
    const to = `${unique("late")}@example.com`;
    await expect(
      sendCustomerCode(hostMailCall(integrations), target.target, { to, code: "111111" }),
    ).rejects.toThrow(/queued for review/);
    const sent = await fakeProviderStub(env, outbox).sent();
    expect(sent.filter((m) => m.to.includes(to))).toEqual([]);
  });
});
