// Stage 6b, AC6 (notification delivery per preference), moved here from the Playwright spec of the
// same name, which waited out the real 30 s delivery lag and polled the cron for about 90 s. The
// browser half (the Delivery picker and the Notifications checkbox) stays in
// apps/app/e2e/notification-preferences.spec.ts; this file covers the rest with the real
// integration host, the fake provider's outbox and the approval gate, ticking the cron on a clock
// moved past the lag.
//
// An admin connects a fake outbox for the org and picks it for email delivery, and turns on email
// for "Approvals waiting". An MCP agent's change then waits for approval: the minute cron sends
// that notice by email, which as an outbound action under Balanced waits in Approvals with its
// preview; approved, the fake outbox has sent it to the user. With email turned off again, the
// next notice stays in-app: nothing goes out.

import { env, exports } from "cloudflare:workers";
import {
  type ActingUser,
  type InvocationContext,
  invokeByName,
  PendingApprovalError,
} from "@composable-os/core";
import { product } from "@composable-os/products/active";
import { beforeAll, describe, expect, it } from "vitest";
import { fakeProviderStub } from "../src/integrations/fake.ts";
import { blobStore, integrationRuntime } from "../src/integrations/runtime.ts";
import { runNotificationCron } from "../src/notifications/deliver.ts";
import { setPreset } from "./automation-fixture.ts";
import { createAdmin, db, host, unique } from "./helpers.ts";

const integrations = integrationRuntime(env);
const runner = exports.default as unknown as {
  gatekeeperFetch(vendor: string, request: Request): Promise<Response>;
};

function baseContext(user: ActingUser): InvocationContext {
  return {
    actor: "human",
    user,
    origin: { surface: "ui" },
    db,
    integrations,
    blobs: blobStore(env),
    extensionHost: host,
  };
}

function op<T>(user: ActingUser, name: string, input: unknown) {
  return invokeByName(name, input, baseContext(user)) as Promise<T>;
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

/**
 * An MCP client (its own session, so its own change set) creates a person and asks to delete it:
 * under Balanced the delete waits for approval, which notifies the user. Returns the client's name.
 */
async function queueApproval(user: ActingUser): Promise<string> {
  const clientName = unique("E2E notify ");
  const agent = (): InvocationContext => ({
    ...baseContext(user),
    actor: "mcp",
    origin: { surface: "mcp", clientId: unique("client"), clientName, sessionId: unique("cap_") },
    reason: "Notification preference test",
  });
  const created = (await invokeByName(
    "person.create",
    { displayName: unique("Notify Pending") },
    agent(),
  )) as { id: string };
  const error = await invokeByName("person.deleteMany", { ids: [created.id] }, agent()).then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(PendingApprovalError);
  return clientName;
}

/** One cron tick, past the 30 s lag behind writes. */
const tick = () => runNotificationCron(env, new Date(Date.now() + 31_000));

/** The id of the "Approvals waiting" notice titled for `clientName`. */
async function noticeFor(clientName: string): Promise<string> {
  const row = await env.DB.prepare(
    "SELECT id FROM core_notifications WHERE type = 'approval.pending' AND title = ?",
  )
    .bind(`${clientName} is waiting for your approval`)
    .first<{ id: string }>();
  expect(row?.id).toBeTruthy();
  return row?.id ?? "";
}

/** Pending outbound sends on the fake outbox. */
async function pendingSends() {
  const { results } = await env.DB.prepare(
    "SELECT change_set_id, input FROM core_pending_action WHERE action_kind IN ('fake.send', 'fake.internal') AND status = 'pending'",
  ).all<{ change_set_id: string; input: string }>();
  return results.map((r) => ({ changeSetId: r.change_set_id, input: JSON.parse(r.input) }));
}

/** What notification.setPreferences returns, as far as this test reads it. */
interface Preferences {
  types: { type: string; channels: string[] }[];
  available: { email: boolean; slack: boolean };
}
const approvalChannels = (prefs: Preferences) =>
  prefs.types.find((t) => t.type === "approval.pending")?.channels;

let admin: ActingUser;
let address: string;

beforeAll(async () => {
  admin = await createAdmin();
  await setPreset("balanced");
  await op(admin, "integration.setVendor", { vendor: "fake", enabled: true });
  address = `${unique("notify")}@example.com`;
  const connection = await connectFakeForOrg(admin, address);
  await op(admin, "connection.bindResource", {
    id: connection,
    url: `fake://outbox/${encodeURIComponent(address)}`,
  });
  await op(admin, "notification.updateDeliverySettings", { email: connection });
});

describe("a notification preference is honoured", () => {
  it("emails an approval notice when email is on, through Approvals, and nothing when it is off", async () => {
    // The user's preference: approvals waiting also by email.
    const prefs = await op<Preferences>(admin, "notification.setPreferences", {
      channels: { "approval.pending": ["email"] },
    });
    expect(prefs.available.email).toBe(true);
    expect(approvalChannels(prefs)).toEqual(["email"]);

    // An agent's change waits for approval: its notice goes out by email, an outbound action that
    // waits in Approvals under Balanced.
    const first = await queueApproval(admin);
    const firstNotice = await noticeFor(first);
    const subject = `[${product.strings.name}] ${first} is waiting for your approval`;
    const report = await tick();
    expect(report.notifications).toContainEqual({
      key: `n:${firstNotice}:email`,
      status: "pending",
    });
    expect(await fakeProviderStub(env, address).sent()).toEqual([]);
    const waiting = (await pendingSends()).filter(
      (s) => s.input.title === `Send email: ${subject}`,
    );
    expect(waiting).toHaveLength(1);
    // The preview the Approvals inbox shows: who it goes to.
    expect(JSON.stringify(waiting[0]?.input)).toContain(admin.email);

    // Approved, the fake outbox has sent it to the user, once.
    await op(admin, "approval.approve", { changeSetId: waiting[0]?.changeSetId });
    const sent = await fakeProviderStub(env, address).sent();
    expect(sent.map((m) => m.subject)).toEqual([subject]);
    expect(sent[0]?.to).toEqual([admin.email]);
    await tick();
    expect(await fakeProviderStub(env, address).sent()).toHaveLength(1);

    // Email off again: the next notice stays in-app.
    const off = await op<Preferences>(admin, "notification.setPreferences", {
      channels: { "approval.pending": [] },
    });
    expect(approvalChannels(off)).toEqual([]);
    const second = await queueApproval(admin);
    const secondNotice = await noticeFor(second);
    const quiet = await tick();
    await tick();
    expect(quiet.notifications.map((n) => n.key)).not.toContain(`n:${secondNotice}:email`);
    const ledger = await env.DB.prepare(
      "SELECT count(*) AS n FROM core_notification_delivery WHERE key LIKE ?",
    )
      .bind(`n:${secondNotice}:%`)
      .first<{ n: number }>();
    expect(ledger?.n).toBe(0);
    const quietSubject = `Send email: [${product.strings.name}] ${second} is waiting for your approval`;
    expect((await pendingSends()).map((s) => s.input.title)).not.toContain(quietSubject);
    expect(await fakeProviderStub(env, address).sent()).toHaveLength(1);
    // The notice itself is still there, in the app.
    const inApp = await env.DB.prepare("SELECT user_id FROM core_notifications WHERE id = ?")
      .bind(secondNotice)
      .first<{ user_id: string }>();
    expect(inApp?.user_id).toBe(admin.id);
  });
});
