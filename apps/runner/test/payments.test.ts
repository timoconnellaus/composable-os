// Stage 25, the gatekeeper half, end to end through the real payments gatekeeper and its fake
// provider: a guest starts an order and opens the provider's page; coming back changes nothing;
// the provider's verified webhook makes it paid, once; an unverified one is refused; a refund
// waits for a person, is sent when approved, and the order is refunded only when the provider
// confirms it (acceptance criteria 4, 7 and 8, ADR 0429). What is sold is the box office fixture
// (packages/core/test/fixtures/boxoffice), installed as a runtime extension: its ticket type
// declares `sellable` (stage 27, ADR 0435), so the paid order grants a ticket per place, and the
// refund voids them.
import { env, exports } from "cloudflare:workers";
import { type ActingUser, invokeByName } from "@composable-os/core";
import { beforeAll, describe, expect, it, vi } from "vitest";
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
  await install(admin, ext, { "index.ts": boxOffice.replaceAll('"boxoffice', `"${ext}`) });
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
