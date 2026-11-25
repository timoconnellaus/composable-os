// Stage 52 step 4 (ADR 0793), the review of PR #474: payout matching through the real path. A
// guest pays a box office order on the fake provider's own page, and its signed webhook makes the
// order paid; another guest starts a subscription and pays its first period on the page, and the
// provider's verified invoice event makes a paid order; staff refund the first, a person approves,
// and the provider confirms it by webhook. The fake then pays out everything with its defaults
// (`makePayout()`), the host's sync reads it through the real payments gatekeeper, and every line
// matches its order by the references the host stored at checkout: nothing here is typed by hand.
import { env, exports } from "cloudflare:workers";
import {
  type ActingUser,
  applyPlan,
  invokeByName,
  planReconcile,
  refreshSchemaRegistry,
  runPayoutsDue,
} from "@composable-os/core";
import { manifestSchema, toManifest } from "@composable-os/sdk";
import { beforeAll, describe, expect, it, vi } from "vitest";
import boxOfficeExtension from "../../../packages/core/test/fixtures/boxoffice/index.ts";
import planExtension from "../../../packages/core/test/fixtures/onlineplan/index.ts";
import { integrationRuntime } from "../src/integrations/runtime.ts";
import { createAdmin, db, unique } from "./helpers.ts";

const integrations = integrationRuntime(env);
const runner = exports.default as unknown as {
  gatekeeperFetch(vendor: string, request: Request): Promise<Response>;
};
const RETURN = "https://shop.test/thanks";
const BOX = unique("pbx").slice(0, 20);
const PLANS = unique("ppl").slice(0, 20);
let admin: ActingUser;
let ticket: string;
let plan: string;

const staff = (user: ActingUser) => ({
  actor: "human" as const,
  user,
  origin: { surface: "ui" as const },
  db,
  integrations,
});
const guest = { principal: { kind: "public" as const }, db, integrations };

async function install(extension: unknown, from: string, to: string) {
  const json = JSON.stringify(toManifest(extension as never)).replaceAll(`"${from}`, `"${to}`);
  const plan = await planReconcile(db.query, manifestSchema.parse(JSON.parse(json)), {
    now: new Date().toISOString(),
  });
  expect(plan.issues).toEqual([]);
  await applyPlan((statements) => db.batch(statements), plan);
  await refreshSchemaRegistry(db.query);
}

const pay = (url: string) =>
  runner.gatekeeperFetch(
    "payments",
    new Request(url, {
      method: "POST",
      body: new URLSearchParams({ outcome: "pay" }),
      redirect: "manual",
    }),
  );

beforeAll(async () => {
  admin = await createAdmin();
  await install(boxOfficeExtension, "boxoffice", BOX);
  await install(planExtension, "onlineplan", PLANS);
  await invokeByName(
    "order.settings.update",
    { currency: "AUD", returnOrigins: ["https://shop.test"] },
    staff(admin),
  );
  const event = (await invokeByName(
    "record.create",
    { object: `${BOX}.event`, values: { name: "Camp", places: 100 } },
    staff(admin),
  )) as { id: string };
  ticket = (
    (await invokeByName(
      "record.create",
      { object: `${BOX}.tickettype`, values: { name: "General", price: 45, places: 50, event: event.id } },
      staff(admin),
    )) as { id: string }
  ).id;
  plan = (
    (await invokeByName(
      "record.create",
      { object: `${PLANS}.plan`, values: { name: "Every course", price: 29 } },
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
  await env.TEST_PAYMENTS.configurePayoutReads({ auto: false, pageSize: 100, reads: "ok" });
});

describe("a payout of what the fake provider was really paid", () => {
  it("matches a checkout's payment, a subscription period's and a refund to their orders", async () => {
    // A box office order paid on the provider's page.
    const order = (await invokeByName(
      "order.start",
      {
        lines: [{ object: `${BOX}.tickettype`, id: ticket, quantity: 2 }],
        email: `${unique("guest")}@buyers.test`.toLowerCase(),
      },
      guest,
    )) as { id: string; token: string };
    const checkout = (await invokeByName(
      "order.checkout",
      { id: order.id, token: order.token, returnUrl: RETURN },
      guest,
    )) as { url: string };
    await pay(checkout.url);
    const paidOf = async (id: string) =>
      env.DB.prepare(
        "SELECT payment_ref FROM core_order_payment WHERE order_id = ? AND outcome = 'applied'",
      )
        .bind(id)
        .first<{ payment_ref: string }>();
    await vi.waitFor(async () => expect(await paidOf(order.id)).not.toBeNull(), {
      timeout: 15_000,
    });

    // A subscription's first period, paid on the provider's page (a guest: no trial).
    const started = (await invokeByName(
      "subscription.start",
      {
        plan: { object: `${PLANS}.plan`, id: plan },
        returnUrl: RETURN,
        email: `${unique("member")}@buyers.test`.toLowerCase(),
      },
      guest,
    )) as { subscriptionId: string; url: string };
    await pay(started.url);
    const periodOrder = async () =>
      env.DB.prepare("SELECT id FROM core_order WHERE subscription_id = ?")
        .bind(started.subscriptionId)
        .first<{ id: string }>();
    await vi.waitFor(async () => expect(await paidOf((await periodOrder())?.id ?? "")).not.toBeNull(), {
      timeout: 15_000,
    });
    const period = (await periodOrder())?.id as string;

    // The box office order refunded: asked, approved by a person, confirmed by the provider.
    const asked = (await invokeByName(
      "order.refund",
      { id: order.id, reason: "Event moved" },
      staff(admin),
    )) as { refunds: { pendingActionId: string }[] };
    await invokeByName(
      "approval.approve",
      { actionIds: [asked.refunds[0]?.pendingActionId] },
      staff(admin),
    );
    await vi.waitFor(
      async () =>
        expect(
          await env.DB.prepare(
            "SELECT id FROM core_order_refund WHERE order_id = ? AND status = 'confirmed'",
          )
            .bind(order.id)
            .first(),
        ).not.toBeNull(),
      { timeout: 15_000 },
    );

    // The provider pays out everything it was paid, with its defaults.
    const payout = await env.TEST_PAYMENTS.makePayout({ currency: "AUD" });
    expect(payout).not.toBeNull();
    const result = await runPayoutsDue(db, { integrations, clock: () => new Date() });
    expect(result).toMatchObject({ state: "ok" });

    const preview = (await invokeByName(
      "finance.report",
      {
        report: "payouts",
        start: payout?.arrivalDate as string,
        end: payout?.arrivalDate as string,
      },
      staff(admin),
    )) as { rows: Record<string, unknown>[] };
    const lines = preview.rows.filter((r) => r.type === "line" && r.payoutRef === payout?.ref);
    // Ours: the checkout's payment, the period's payment, and the refund.
    const ours = lines.filter((l) => l.orderId === order.id || l.orderId === period);
    expect(ours.map((l) => [l.kind, l.orderId, l.matched]).sort()).toEqual(
      [
        ["payment", order.id, true],
        ["payment", period, true],
        ["refund", order.id, true],
      ].sort(),
    );
    // Every line of the payout matched something the host recorded.
    expect(lines.filter((l) => !l.matched)).toEqual([]);
  });
});
