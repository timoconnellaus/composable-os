// Stage 42, build step 1, end to end (ADR 0479): a human admin turns tax at checkout on in
// Settings → Orders, a guest buys a ticket for an event held in New Zealand, gives a billing
// country on the payments gatekeeper's fake provider page (which taxes as Stripe Tax does, at its
// own fixed registrations), and the order shows the provider's tax inside the price. Tax is turned
// off again at the end: the suite runs one spec at a time on one database.
import { expect, type Page, request as playwrightRequest, test } from "@playwright/test";
import { open, unique } from "./helpers.ts";

async function staffOp<T>(page: Page, name: string, input: unknown): Promise<T> {
  const response = await page.request.post(`/api/v1/op/${name}`, {
    data: input,
    headers: { "idempotency-key": crypto.randomUUID() },
  });
  const body = (await response.json()) as { data?: T; error?: unknown };
  expect(response.status(), `${name}: ${JSON.stringify(body).slice(0, 300)}`).toBe(200);
  return body.data as T;
}

test("an admin turns tax on; a guest's ticket is taxed where the event is, inside the price", async ({
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

  try {
    // The admin's switch, off until turned on.
    await open(page, "/settings/orders");
    const tax = page.getByTestId("tax-settings");
    await expect(tax.getByText("Off: no tax is calculated")).toBeVisible();
    await expect(tax.getByLabel(/Ticket type/)).toHaveValue("txcd_50010001");
    await tax.getByRole("switch").click();
    await expect(tax.getByText("On: the provider calculates tax")).toBeVisible();

    // An event in New Zealand, on sale, with a ticket type.
    const event = await staffOp<{ id: string }>(page, "record.create", {
      object: "ticketing.event",
      values: { name: unique("Camp "), places: 20, taxCountry: "NZ", taxRegion: "Otago" },
    });
    await staffOp(page, "record.update", {
      object: "ticketing.event",
      id: event.id,
      values: { status: "on_sale" },
    });
    const type = await staffOp<{ id: string }>(page, "record.create", {
      object: "ticketing.tickettype",
      values: { event: event.id, name: "Camp place", price: 45 },
    });

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
    const order = await guestOp<{ id: string; token: string; total: number }>(
      "x.ticketing.orderStart",
      {
        lines: [{ ticketTypeId: type.id }],
        email: `${unique("guest")}@buyers.test`.toLowerCase(),
      },
    );
    // The price is what the buyer pays: tax does not add to it.
    expect(order.total).toBe(4500);
    const checkout = await guestOp<{ url: string; amount: number }>("order.checkout", {
      id: order.id,
      token: order.token,
      returnUrl: `${origin}/order/${order.id}?token=${order.token}`,
    });
    expect(checkout.amount).toBe(4500);

    // The provider's page asks for the billing address; the buyer is in Australia.
    const guestContext = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    const guest = await guestContext.newPage();
    await guest.goto(checkout.url);
    await expect(guest.getByText("Prices include tax")).toBeVisible();
    await guest.getByLabel("Billing country").selectOption("AU");
    await guest.getByRole("button", { name: "Pay", exact: true }).click();
    // Taxed where the event is: 4500 - round(4500 / 1.15) = 587, inside the 45.00.
    await expect
      .poll(
        async () =>
          await guestOp<{ state: string; paid: number; taxAmount: number }>("order.view", {
            id: order.id,
            token: order.token,
          }),
        { timeout: 30_000 },
      )
      .toMatchObject({ state: "paid", paid: 4500, taxAmount: 587 });
    await guestContext.close();
    await anonymous.dispose();
  } finally {
    await staffOp(page, "order.settings.update", { tax: false });
  }
});
