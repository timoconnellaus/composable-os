// Stage 27 end to end: a deployment with the Ticketing pack on (in local dev it is the org's own
// extension, scripts/dev-setup.mjs, installed by an admin as a product that lists the pack would
// have it), a guest buying two ticket types over the HTTP surface and paying on the payments
// gatekeeper's fake provider page, and a door-role account checking one of the tickets in.
import { expect, type Page, request as playwrightRequest, test } from "@playwright/test";
import { unique } from "./helpers.ts";

async function staffOp<T>(page: Page, name: string, input: unknown): Promise<T> {
  const response = await page.request.post(`/api/v1/op/${name}`, {
    data: input,
    headers: { "idempotency-key": crypto.randomUUID() },
  });
  const body = (await response.json()) as { data?: T; error?: unknown };
  expect(response.status(), `${name}: ${JSON.stringify(body).slice(0, 300)}`).toBe(200);
  return body.data as T;
}

test("a guest buys two ticket types and a door account checks one in", async ({
  page,
  baseURL,
  browser,
}) => {
  test.setTimeout(180_000);
  const origin = new URL(baseURL ?? "").origin;
  await staffOp(page, "extension.install", { id: "ticketing", shipped: true });
  await staffOp(page, "order.settings.update", { currency: "AUD", returnOrigins: [origin] });
  await staffOp(page, "integration.setVendor", { vendor: "payments", enabled: true });
  const connections = await staffOp<{ items: { id: string; vendor: string; status: string }[] }>(
    page,
    "connection.list",
    {},
  );
  let connectionId = connections.items.find(
    (c) => c.vendor === "payments" && c.status === "active",
  )?.id;
  if (!connectionId) {
    connectionId = (
      await staffOp<{ connection: { id: string } }>(page, "connection.create", {
        vendor: "payments",
        scope: "org",
      })
    ).connection.id;
  }
  await staffOp(page, "connection.bindResource", {
    id: connectionId,
    url: "payments://merchant/fake",
  });

  // Staff put an event on sale with two ticket types.
  const event = await staffOp<{ id: string }>(page, "record.create", {
    object: "ticketing.event",
    values: { name: unique("Gains "), places: 50 },
  });
  await staffOp(page, "record.update", {
    object: "ticketing.event",
    id: event.id,
    values: { status: "on_sale" },
  });
  const shared = await staffOp<{ id: string }>(page, "record.create", {
    object: "ticketing.tickettype",
    values: { event: event.id, name: "Shared room", price: 450 },
  });
  const single = await staffOp<{ id: string }>(page, "record.create", {
    object: "ticketing.tickettype",
    values: { event: event.id, name: "Single room", price: 650 },
  });

  // The guest, with no session: the event page's reads, then the order.
  const anonymous = await playwrightRequest.newContext({
    baseURL,
    storageState: { cookies: [], origins: [] },
  });
  const guestOp = async <T>(name: string, input: unknown): Promise<T> => {
    const response = await anonymous.post(`/api/v1/op/${name}`, {
      data: input,
      headers: { "idempotency-key": crypto.randomUUID() },
    });
    const body = (await response.json()) as { data?: T; error?: unknown };
    expect(response.status(), `${name}: ${JSON.stringify(body).slice(0, 300)}`).toBe(200);
    return body.data as T;
  };
  const onSale = await guestOp<{ events: { id: string; ticketTypes: { id: string }[] }[] }>(
    "x.ticketing.eventsOnSale",
    { event: event.id },
  );
  expect(onSale.events[0]?.ticketTypes.map((t) => t.id).sort()).toEqual(
    [shared.id, single.id].sort(),
  );
  const order = await guestOp<{ id: string; token: string; total: number }>(
    "x.ticketing.orderStart",
    {
      lines: [
        { ticketTypeId: shared.id, quantity: 2 },
        { ticketTypeId: single.id, quantity: 1 },
      ],
      email: `${unique("guest")}@buyers.test`.toLowerCase(),
    },
  );
  expect(order.total).toBe(155000);
  const checkout = await guestOp<{ url: string }>("order.checkout", {
    id: order.id,
    token: order.token,
    returnUrl: `${origin}/order/${order.id}?token=${order.token}`,
  });

  // The provider's own page (the fake one).
  const guestContext = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const guest = await guestContext.newPage();
  await guest.goto(checkout.url);
  await expect(guest.getByRole("heading", { name: /Fake payment page/i })).toBeVisible();
  await guest.getByRole("button", { name: "Pay", exact: true }).click();
  await expect
    .poll(
      async () =>
        (await guestOp<{ state: string }>("order.view", { id: order.id, token: order.token }))
          .state,
      {
        timeout: 30_000,
      },
    )
    .toBe("paid");

  const tickets = await staffOp<{ items: { values: { code: string; state: string } }[] }>(
    page,
    "record.list",
    { object: "ticketing.ticket", filter: { field: "order", op: "eq", value: order.id } },
  );
  expect(tickets.items).toHaveLength(3);
  expect(new Set(tickets.items.map((t) => t.values.code)).size).toBe(3);

  // A coach: a staff account given the door role by the admin.
  const email = `${unique("coach")}@example.com`;
  const password = "coach-password-not-secret";
  const signUp = await fetch(`${baseURL}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify({ name: "Coach", email, password }),
  });
  expect(signUp.ok).toBe(true);
  const users = await staffOp<{ items: { id: string }[] }>(page, "user.list", {
    filter: { field: "email", op: "eq", value: email },
  });
  const coachId = users.items[0]?.id as string;
  await staffOp(page, "user.setPackRole", { id: coachId, role: "ticketing.door" });
  const coach = await playwrightRequest.newContext({
    baseURL,
    storageState: { cookies: [], origins: [] },
  });
  const signedIn = await coach.post("/api/auth/sign-in/email", {
    data: { email, password },
    headers: { origin },
  });
  expect(signedIn.ok()).toBe(true);
  const coachOp = (name: string, input: unknown) =>
    coach.post(`/api/v1/op/${name}`, {
      data: input,
      headers: { "idempotency-key": crypto.randomUUID() },
    });
  const code = tickets.items[0]?.values.code as string;
  const scan = await coachOp("x.ticketing.checkIn", { code });
  expect(scan.status()).toBe(200);
  expect((await scan.json()).data).toMatchObject({ result: "accepted", accepted: true });
  const again = await coachOp("x.ticketing.checkIn", { code });
  expect((await again.json()).data).toMatchObject({ result: "already_used" });
  // The door account does nothing else.
  const people = await coachOp("person.list", {});
  expect((await people.json()).error).toMatchObject({ code: "forbidden" });

  await anonymous.dispose();
  await coach.dispose();
  await guestContext.close();
});
