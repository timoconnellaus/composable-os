// Stage 32a, steps 1 and 2 end to end through the real payments gatekeeper and its fake provider
// (ADRs 0485 to 0487): a guest subscribes on the provider's page and the verified events make the
// subscription, on trial; a renewal the provider reports, signed, is a paid order; one not signed
// is refused and changes nothing; a cancel at the period's end goes through the gatekeeper's
// action and shows only once the provider's event says so. What is subscribed to is the online
// plan fixture (packages/core/test/fixtures/onlineplan), reconciled as a shipped pack would be.
import { env, exports } from "cloudflare:workers";
import {
  type ActingUser,
  applyPlan,
  invokeByName,
  planReconcile,
  refreshSchemaRegistry,
} from "@composable-os/core";
import { manifestSchema, toManifest } from "@composable-os/sdk";
import { beforeAll, describe, expect, it, vi } from "vitest";
import planExtension from "../../../packages/core/test/fixtures/onlineplan/index.ts";
import { signatureHeader } from "../../../packages/gatekeeper-payments/src/signature.ts";
import { integrationRuntime } from "../src/integrations/runtime.ts";
import { createAdmin, db, unique } from "./helpers.ts";

const integrations = integrationRuntime(env);
const runner = exports.default as unknown as {
  gatekeeperFetch(vendor: string, request: Request): Promise<Response>;
};
const RETURN = "https://shop.test/account";
/** The fake provider's signing secret in these tests (vitest.config.ts): off localhost it needs one. */
const FAKE_SECRET = "fake-payments-test-secret";
const ext = unique("sub").slice(0, 20);
const PLAN = `${ext}.plan`;
let admin: ActingUser;
let plan: string;
let connectionId: string;

function staff(user: ActingUser) {
  return { actor: "human" as const, user, origin: { surface: "ui" as const }, db, integrations };
}
const guest = { principal: { kind: "public" as const }, db, integrations };

async function subscription(id: string) {
  return env.DB.prepare("SELECT * FROM core_subscription WHERE id = ?")
    .bind(id)
    .first<Record<string, unknown>>();
}

/** Posts a provider delivery to the gatekeeper's webhook, signed with `secret`. */
async function deliver(body: Record<string, unknown>, secret = FAKE_SECRET) {
  const text = JSON.stringify(body);
  const signature = await signatureHeader(secret, text, Math.floor(Date.now() / 1000));
  return runner.gatekeeperFetch(
    "payments",
    new Request("http://crm.test/gatekeeper/payments/in/fake", {
      method: "POST",
      headers: { "content-type": "application/json", "x-fake-signature": signature },
      body: text,
    }),
  );
}

beforeAll(async () => {
  admin = await createAdmin();
  const json = JSON.stringify(toManifest(planExtension)).replaceAll('"onlineplan', `"${ext}`);
  const reconciled = await planReconcile(db.query, manifestSchema.parse(JSON.parse(json)), {
    now: new Date().toISOString(),
  });
  expect(reconciled.issues).toEqual([]);
  await applyPlan((statements) => db.batch(statements), reconciled);
  await refreshSchemaRegistry(db.query);
  await invokeByName(
    "order.settings.update",
    { currency: "AUD", returnOrigins: ["https://shop.test"] },
    staff(admin),
  );
  plan = (
    (await invokeByName(
      "record.create",
      { object: PLAN, values: { name: "Every course", price: 29, trialDays: 7 } },
      staff(admin),
    )) as { id: string }
  ).id;
  await invokeByName("integration.setVendor", { vendor: "payments", enabled: true }, staff(admin));
  const connection = (await invokeByName(
    "connection.create",
    { vendor: "payments", scope: "org" },
    staff(admin),
  )) as { connection: { id: string } };
  await invokeByName(
    "connection.bindResource",
    { id: connection.connection.id, url: "payments://merchant/fake" },
    staff(admin),
  );
  connectionId = connection.connection.id;
});

describe("the billing portal through the integration host", () => {
  it("opens for the host's own call only: an AI actor's and an extension's session are refused", async () => {
    const resource = "merchant";
    const bound = await db.query
      .selectFrom("core_integration_connection")
      .select("resources")
      .where("id", "=", connectionId)
      .executeTakeFirstOrThrow();
    const key = (JSON.parse(bound.resources) as { key: string }[])[0]?.key ?? resource;
    const args = [{ customerRef: "fcus_someone", returnUrl: RETURN }];
    for (const [actor, origin] of [
      ["mcp", { surface: "mcp" }],
      ["assistant", { surface: "assistant" }],
      ["extension", { surface: "extension", extensionId: "x" }],
    ] as const) {
      await expect(
        integrations.call({
          connectionId,
          resource: key,
          method: "openPortal",
          args,
          caller: {
            actor,
            userId: admin.id,
            userName: admin.name,
            role: admin.role,
            origin: origin as never,
          },
        }),
        actor,
      ).rejects.toThrow(/only by the host/);
    }
    const host = await integrations.callAsHost?.({
      connectionId,
      resource: key,
      method: "openPortal",
      args,
      purpose: "orders",
    });
    expect((host?.value as { url?: string } | undefined)?.url).toMatch(
      /\/fake\/portal\/fcus_someone$/,
    );
  });
});

describe("a subscription through the fake provider", () => {
  it("starts on trial from verified events, renews as a paid order, refuses a forged event, and cancels at period end", async () => {
    const started = (await invokeByName(
      "subscription.start",
      {
        plan: { object: PLAN, id: plan },
        returnUrl: RETURN,
        email: `${unique("guest")}@buyers.test`.toLowerCase(),
      },
      guest,
    )) as { subscriptionId: string; url: string; trialDays: number };
    expect(started.trialDays).toBe(7);
    expect(started.url).toMatch(/\/gatekeeper\/payments\/fake\/pay\//);
    // On the provider's page, or back without submitting it: no subscription exists.
    expect(await subscription(started.subscriptionId)).toBeNull();

    const page = await runner.gatekeeperFetch(
      "payments",
      new Request(started.url, {
        method: "POST",
        body: new URLSearchParams({ outcome: "pay" }),
        redirect: "manual",
      }),
    );
    expect(page.status).toBe(303);
    await vi.waitFor(
      async () => expect((await subscription(started.subscriptionId))?.state).toBe("trialing"),
      { timeout: 15_000 },
    );
    const sub = (await subscription(started.subscriptionId)) as Record<string, unknown>;
    expect(sub.provider_ref).toMatch(/^fsub_/);
    // The trial's zero invoice is no order.
    const none = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM core_order WHERE subscription_id = ?",
    )
      .bind(started.subscriptionId)
      .first<{ n: number }>();
    expect(none?.n).toBe(0);

    // The trial ends and the provider charges the first period: it reports it, signed.
    const periodStart = sub.current_period_end as string;
    const periodEnd = new Date(Date.parse(periodStart) + 30 * 86_400_000).toISOString();
    const read = {
      provider: "fake",
      ref: sub.provider_ref,
      customerRef: sub.customer_ref,
      subscriptionId: started.subscriptionId,
      status: "active",
      amount: 2900,
      currency: "AUD",
      interval: "month",
      cancelAtPeriodEnd: false,
      trialEnd: sub.trial_end,
      currentPeriodStart: periodStart,
      currentPeriodEnd: periodEnd,
      canceledAt: null,
      endedAt: null,
      endReason: null,
      observedAt: new Date().toISOString(),
    };
    const renewal = {
      id: unique("fevt_renew"),
      type: "subscription.event",
      created: Math.floor(Date.now() / 1000),
      data: {
        trigger: "invoice_paid",
        subscription: read,
        invoice: {
          ref: unique("fin"),
          status: "paid",
          amountPaid: 2900,
          amountDue: 2900,
          currency: "AUD",
          paymentRef: unique("fpi"),
          periodStart,
          periodEnd,
          billingReason: "subscription_cycle",
          attemptCount: 1,
          nextAttemptAt: null,
          hostedUrl: null,
        },
      },
    };
    // Not signed with the provider's secret: refused at the gatekeeper, nothing changes.
    expect((await deliver(renewal, "not-the-secret")).status).toBe(401);
    expect((await deliver(renewal)).status).toBe(200);
    await vi.waitFor(
      async () => {
        const order = await env.DB.prepare(
          "SELECT state, total, period_start FROM core_order WHERE subscription_id = ?",
        )
          .bind(started.subscriptionId)
          .first();
        expect(order).toEqual({ state: "paid", total: 2900, period_start: periodStart });
      },
      { timeout: 15_000 },
    );
    expect((await subscription(started.subscriptionId))?.state).toBe("active");
    // Delivered again: acknowledged, and still one order.
    expect((await deliver(renewal)).status).toBe(200);

    // Staff end it at the period's end: the gatekeeper's action is applied, and the fake
    // provider's event (not the operation) shows it.
    await invokeByName(
      "subscription.cancel",
      { id: started.subscriptionId, reason: "Asked by phone" },
      staff(admin),
    );
    await vi.waitFor(
      async () =>
        expect((await subscription(started.subscriptionId))?.cancel_at_period_end).toBe(1),
      { timeout: 15_000 },
    );
    const orders = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM core_order WHERE subscription_id = ?",
    )
      .bind(started.subscriptionId)
      .first<{ n: number }>();
    expect(orders?.n).toBe(1);
  });
});
