// Stage 25, the gatekeeper half, end to end through the real payments gatekeeper and its fake
// provider: a guest starts an order and opens the provider's page; coming back changes nothing;
// the provider's verified webhook makes it paid, once; an unverified one is refused; a refund
// waits for a person, is sent when approved, and the order is refunded only when the provider
// confirms it (acceptance criteria 4, 7 and 8, ADR 0429). What is sold is the box office fixture
// (packages/core/test/fixtures/boxoffice): its ticket type declares `sellable` (stage 27, ADR
// 0435), so the paid order grants a ticket per place, and the refund voids them. As a runtime
// extension it is refused; it is reconciled as a shipped one would be.
import { env, exports } from "cloudflare:workers";
import {
  type ActingUser,
  applyPlan,
  invokeByName,
  planReconcile,
  refreshSchemaRegistry,
} from "@composable-os/core";
import { manifestSchema, toManifest } from "@composable-os/sdk";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import boxOfficeExtension from "../../../packages/core/test/fixtures/boxoffice/index.ts";
import courseExtension from "../../../packages/core/test/fixtures/onlinecourse/index.ts";
import { integrationRuntime } from "../src/integrations/runtime.ts";
import { createAdmin, db, install, unique } from "./helpers.ts";

const boxOffice = Object.values(
  import.meta.glob<string>("../../../packages/core/test/fixtures/boxoffice/index.ts", {
    query: "?raw",
    import: "default",
    eager: true,
  }),
)[0] as string;

const integrations = integrationRuntime(env);
const runner = exports.default as unknown as {
  gatekeeperFetch(vendor: string, request: Request): Promise<Response>;
};
const RETURN = "https://shop.test/thanks";

let admin: ActingUser;
let ticket: string;
const ext = unique("pay").slice(0, 20);
const TICKET_TYPE = `${ext}.tickettype`;
const TICKET = `${ext}.ticket`;

/** The tickets an order granted, as staff read them. */
async function ticketsOf(orderId: string) {
  const { results } = await env.DB.prepare(
    "SELECT record_id FROM core_order_grant WHERE order_id = ? ORDER BY record_id",
  )
    .bind(orderId)
    .all<{ record_id: string }>();
  return Promise.all(
    results.map(
      async (row) =>
        (
          (await invokeByName(
            "record.get",
            { object: TICKET, id: row.record_id },
            staff(admin),
          )) as {
            values: Record<string, unknown>;
          }
        ).values,
    ),
  );
}

function staff(user: ActingUser, extra: Record<string, unknown> = {}) {
  return {
    actor: "human" as const,
    user,
    origin: { surface: "ui" as const },
    db,
    integrations,
    ...extra,
  };
}
const guest = { principal: { kind: "public" as const }, db, integrations };

async function view(id: string, token: string) {
  return (await invokeByName("order.view", { id, token }, guest)) as {
    state: string;
    paid: number;
  };
}

beforeAll(async () => {
  admin = await createAdmin();
  expect(boxOffice).toContain('id: "boxoffice"');
  // A runtime extension may not declare `sellable` (ADR 0435): installing the source through the
  // workspace is refused by the check, and nothing is reconciled.
  const refused = await install(admin, ext, {
    "index.ts": boxOffice.replaceAll('"boxoffice', `"${ext}`),
  }).then(
    () => null,
    (error: unknown) => error as { code?: string; details?: unknown },
  );
  expect(refused?.code).toBe("invalid_input");
  expect(JSON.stringify(refused?.details)).toContain("objects.tickettype.sellable");
  expect(
    await db.query
      .selectFrom("core_extensions")
      .select("id")
      .where("id", "=", ext)
      .executeTakeFirst(),
  ).toBeUndefined();
  // Installed the way a shipped pack or the org's own extension is: its manifest reconciled.
  const json = JSON.stringify(toManifest(boxOfficeExtension)).replaceAll('"boxoffice', `"${ext}`);
  const plan = await planReconcile(db.query, manifestSchema.parse(JSON.parse(json)), {
    now: new Date().toISOString(),
  });
  expect(plan.issues).toEqual([]);
  await applyPlan((statements) => db.batch(statements), plan);
  await refreshSchemaRegistry(db.query);
  await invokeByName(
    "order.settings.update",
    { currency: "AUD", returnOrigins: ["https://shop.test"] },
    staff(admin),
  );
  const event = (await invokeByName(
    "record.create",
    { object: `${ext}.event`, values: { name: "Camp", places: 100 } },
    staff(admin),
  )) as { id: string };
  const created = (await invokeByName(
    "record.create",
    { object: TICKET_TYPE, values: { name: "General", price: 45, places: 50, event: event.id } },
    staff(admin),
  )) as { id: string };
  ticket = created.id;

  await invokeByName("integration.setVendor", { vendor: "payments", enabled: true }, staff(admin));
  const connection = (await invokeByName(
    "connection.create",
    { vendor: "payments", scope: "org" },
    staff(admin),
  )) as { connection: { id: string; status: string } };
  expect(connection.connection.status).toBe("active");
  await invokeByName(
    "connection.bindResource",
    { id: connection.connection.id, url: "payments://merchant/fake" },
    staff(admin),
  );
});

async function startAndOpen() {
  const email = `${unique("guest")}@buyers.test`.toLowerCase();
  const order = (await invokeByName(
    "order.start",
    { lines: [{ object: TICKET_TYPE, id: ticket, quantity: 2 }], email },
    guest,
  )) as { id: string; token: string; total: number };
  const checkout = (await invokeByName(
    "order.checkout",
    { id: order.id, token: order.token, returnUrl: RETURN },
    guest,
  )) as { url: string; amount: number };
  return { order, checkout };
}

async function pay(url: string) {
  return runner.gatekeeperFetch(
    "payments",
    // The provider's page answers with a redirect to the return page: not followed here.
    new Request(url, {
      method: "POST",
      body: new URLSearchParams({ outcome: "pay" }),
      redirect: "manual",
    }),
  );
}

describe("paid only by the provider's verified webhook (criterion 4)", () => {
  it("coming back leaves it pending; the webhook pays it once; a replay changes nothing", async () => {
    const { order, checkout } = await startAndOpen();
    expect(order.total).toBe(9000);
    expect(checkout.amount).toBe(9000);
    expect(checkout.url).toMatch(/^http:\/\/crm\.test\/gatekeeper\/payments\/fake\/pay\//);

    // The buyer is on the provider's page, or back on the return page without paying: nothing
    // the buyer's side does moves the order, and nothing is granted.
    expect((await view(order.id, order.token)).state).toBe("pending");
    expect(await ticketsOf(order.id)).toEqual([]);

    const paid = await pay(checkout.url);
    expect(paid.status).toBe(303);
    expect(paid.headers.get("location")).toBe(RETURN);
    await vi.waitFor(async () => expect((await view(order.id, order.token)).state).toBe("paid"), {
      timeout: 15_000,
    });

    // Paying again (a replayed delivery) is acknowledged and changes nothing.
    await pay(checkout.url);
    const payments = await env.DB.prepare(
      "SELECT outcome FROM core_order_payment WHERE order_id = ?",
    )
      .bind(order.id)
      .all();
    expect(payments.results).toEqual([{ outcome: "applied" }]);
    expect((await view(order.id, order.token)).paid).toBe(9000);
    // The paid order granted one ticket per place (stage 27), each with its own code, once.
    const tickets = await ticketsOf(order.id);
    expect(tickets).toHaveLength(2);
    expect(tickets.map((t) => t.state)).toEqual(["valid", "valid"]);
    expect(new Set(tickets.map((t) => t.code)).size).toBe(2);
    expect(tickets.every((t) => t.ticketType === ticket && t.order === order.id)).toBe(true);
  });

  it("refuses an unverified webhook at the gatekeeper", async () => {
    const { order, checkout } = await startAndOpen();
    const ref = checkout.url.split("/").pop();
    const body = JSON.stringify({
      id: unique("fevt"),
      type: "payment.succeeded",
      data: {
        orderId: order.id,
        checkoutRef: ref,
        amount: 9000,
        currency: "AUD",
        paymentRef: "fpi_x",
      },
    });
    const forged = await runner.gatekeeperFetch(
      "payments",
      new Request("http://crm.test/gatekeeper/payments/in/fake", {
        method: "POST",
        headers: { "content-type": "application/json", "x-fake-signature": "t=1,v1=00" },
        body,
      }),
    );
    expect(forged.status).toBe(401);
    expect((await view(order.id, order.token)).state).toBe("pending");
  });
});

describe("refunds (criterion 8)", () => {
  it("waits for a person, is sent on approval, and refunds only when the provider confirms", async () => {
    const { order, checkout } = await startAndOpen();
    await pay(checkout.url);
    await vi.waitFor(async () => expect((await view(order.id, order.token)).state).toBe("paid"), {
      timeout: 15_000,
    });

    const asked = (await invokeByName(
      "order.refund",
      { id: order.id, reason: "Event moved" },
      staff(admin),
    )) as { refunds: { amount: number; pendingActionId: string | null }[] };
    expect(asked.refunds).toHaveLength(1);
    expect(asked.refunds[0]?.amount).toBe(9000);
    const actionId = asked.refunds[0]?.pendingActionId as string;
    // Nothing is sent until a person approves: still paid, nothing refunded.
    expect((await view(order.id, order.token)).state).toBe("paid");

    await invokeByName("approval.approve", { actionIds: [actionId] }, staff(admin));
    await vi.waitFor(
      async () => expect((await view(order.id, order.token)).state).toBe("refunded"),
      { timeout: 15_000 },
    );
    const refund = await env.DB.prepare(
      "SELECT status, amount FROM core_order_refund WHERE order_id = ?",
    )
      .bind(order.id)
      .first();
    expect(refund).toEqual({ status: "confirmed", amount: 9000 });
    // Refunded in full: what it granted is void (stage 27).
    expect((await ticketsOf(order.id)).map((t) => t.state)).toEqual(["void", "void"]);
  });
});

// --- Stage 42 section 4: tax at checkout (ADR 0479), criteria 11 and 12 --------------------------

describe("tax at checkout through the fake provider (stage 42 criteria 11 and 12)", () => {
  const COURSE_EXT = unique("crs").slice(0, 20);
  let course: string;

  /** The fake page: Pay, from `country` (the billing address the provider requires with tax). */
  async function payFrom(url: string, country?: string) {
    return runner.gatekeeperFetch(
      "payments",
      new Request(url, {
        method: "POST",
        body: new URLSearchParams({ outcome: "pay", ...(country ? { country } : {}) }),
        redirect: "manual",
      }),
    );
  }

  async function buyCourse() {
    const order = (await invokeByName(
      "order.start",
      {
        lines: [{ object: `${COURSE_EXT}.course`, id: course }],
        email: `${unique("learner")}@buyers.test`.toLowerCase(),
      },
      guest,
    )) as { id: string; token: string; total: number };
    const checkout = (await invokeByName(
      "order.checkout",
      { id: order.id, token: order.token, returnUrl: RETURN },
      guest,
    )) as { url: string; amount: number };
    return { order, checkout };
  }

  const taxLinesOf = async (orderId: string) =>
    (
      await env.DB.prepare("SELECT tax_lines FROM core_order_checkout WHERE order_id = ?")
        .bind(orderId)
        .first<{ tax_lines: string | null }>()
    )?.tax_lines;

  beforeAll(async () => {
    const json = JSON.stringify(toManifest(courseExtension)).replaceAll(
      '"onlinecourse',
      `"${COURSE_EXT}`,
    );
    const plan = await planReconcile(db.query, manifestSchema.parse(JSON.parse(json)), {
      now: new Date().toISOString(),
    });
    expect(plan.issues).toEqual([]);
    await applyPlan((statements) => db.batch(statements), plan);
    await refreshSchemaRegistry(db.query);
    course = (
      (await invokeByName(
        "record.create",
        { object: `${COURSE_EXT}.course`, values: { name: "Mobility", price: 99 } },
        staff(admin),
      )) as { id: string }
    ).id;
  });
  afterAll(async () => {
    await invokeByName("order.settings.update", { tax: false }, staff(admin));
  });

  it("off: the course's checkout is as before tax, and is paid with no address (12)", async () => {
    const { order, checkout } = await buyCourse();
    expect(await taxLinesOf(order.id)).toBeNull();
    const page = await (await runner.gatekeeperFetch("payments", new Request(checkout.url))).text();
    expect(page).not.toContain('name="country"');
    expect((await payFrom(checkout.url)).status).toBe(303);
    await vi.waitFor(async () => expect((await view(order.id, order.token)).state).toBe("paid"), {
      timeout: 15_000,
    });
    const row = await env.DB.prepare(
      "SELECT tax_amount, tax_country FROM core_order_payment WHERE order_id = ?",
    )
      .bind(order.id)
      .first();
    expect(row).toEqual({ tax_amount: null, tax_country: null });
  });

  it("on: automatic tax, inclusive, address required; the provider's tax stored (11)", async () => {
    await invokeByName("order.settings.update", { tax: true }, staff(admin));
    // The box office's ticket type declares no code: exactly as before, with tax on (12).
    const plain = await startAndOpen();
    expect(await taxLinesOf(plain.order.id)).toBeNull();

    const { order, checkout } = await buyCourse();
    expect(order.total).toBe(9900);
    expect(checkout.amount).toBe(9900);
    expect(JSON.parse((await taxLinesOf(order.id)) ?? "null")).toEqual([
      expect.objectContaining({ amount: 9900, taxCode: "txcd_20060158", name: "Mobility" }),
    ]);
    const page = await (await runner.gatekeeperFetch("payments", new Request(checkout.url))).text();
    expect(page).toContain('name="country" required');
    expect((await payFrom(checkout.url)).status).toBe(400);
    // From Australia, where the fake provider is registered at 10%: 9900 - round(9900 / 1.1).
    expect((await payFrom(checkout.url, "AU")).status).toBe(303);
    await vi.waitFor(async () => expect((await view(order.id, order.token)).state).toBe("paid"), {
      timeout: 15_000,
    });
    const paid = (await invokeByName("order.get", { id: order.id }, staff(admin))) as {
      total: number;
      paid: number;
      taxAmount: number;
      taxCountry: string;
      lines: { taxAmount: number }[];
    };
    expect(paid).toMatchObject({ total: 9900, paid: 9900, taxAmount: 900, taxCountry: "AU" });
    expect(paid.lines[0]?.taxAmount).toBe(900);

    // From the United States, where it is not registered: no tax, and the order says zero.
    const elsewhere = await buyCourse();
    await payFrom(elsewhere.checkout.url, "US");
    await vi.waitFor(
      async () =>
        expect((await view(elsewhere.order.id, elsewhere.order.token)).state).toBe("paid"),
      { timeout: 15_000 },
    );
    expect(await invokeByName("order.get", { id: elsewhere.order.id }, staff(admin))).toMatchObject(
      { paid: 9900, taxAmount: 0, taxCountry: "US" },
    );

    // A refund records as before.
    const asked = (await invokeByName(
      "order.refund",
      { id: order.id, reason: "Changed mind" },
      staff(admin),
    )) as { refunds: { amount: number; pendingActionId: string }[] };
    expect(asked.refunds.map((r) => r.amount)).toEqual([9900]);
    await invokeByName(
      "approval.approve",
      { actionIds: [asked.refunds[0]?.pendingActionId] },
      staff(admin),
    );
    await vi.waitFor(
      async () => expect((await view(order.id, order.token)).state).toBe("refunded"),
      { timeout: 15_000 },
    );
  });
});
