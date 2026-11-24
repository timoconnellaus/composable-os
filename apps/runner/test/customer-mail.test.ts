// Stage 23 (ADR 0419): a customer's sign-in code is sent by the host itself, through the
// connection customer.settings names, with no staff user as its sender. The integration host
// accepts the system user (it has no core_user row); this is the security path's test.
//
// The real integration host and the fake provider's outbox, as notification-preferences.test.ts
// uses them.
import { env } from "cloudflare:workers";
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
import { connectFake } from "./fake-connection.ts";
import { createAdmin, db, host, unique } from "./helpers.ts";

const integrations = integrationRuntime(env);

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

let admin: ActingUser;
let outbox: string;

beforeAll(async () => {
  admin = await createAdmin();
  await op(admin, "integration.setVendor", { vendor: "fake", enabled: true });
  outbox = `${unique("customer-mail")}@example.com`;
  const connection = await connectFake((name, input) => op(admin, name, input), outbox);
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
    // The code is in the body, never the subject the audit log keeps as the title (ADR 0455).
    expect(mine[0]?.text).toContain("482913");
    expect(mine[0]?.subject).not.toContain("482913");

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
