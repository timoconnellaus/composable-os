// Stage 25 end to end (acceptance criterion 13): a guest starts an order with an email on the buy
// page, pays it on the payments gatekeeper's fake provider page, comes back to their order page,
// which shows it paid only once the provider's verified webhook has reached the host; staff then
// refund it, a person approves the refund, and the order shows refunded once the provider
// confirms. What is sold is a ticket type of the box office fixture extension
// (packages/core/test/fixtures/boxoffice), the org's own extension in local dev, installed first: it declares
// `sellable` (stage 27, ADR 0435), so the paid order grants a ticket, and the refund voids it.
import { readFileSync } from "node:fs";
import { expect, type Page, request as playwrightRequest, test } from "@playwright/test";
import { connectAdminApp, extensionId } from "./extension-authoring.ts";
import { open, unique } from "./helpers.ts";
import { call } from "./mcp.ts";

const BOX_OFFICE = readFileSync(
  new URL("../../../packages/core/test/fixtures/boxoffice/index.ts", import.meta.url),
  "utf8",
);

/** The tickets granted for an order, as staff list them. */
async function ticketsOf(page: Page, object: string, orderId: string) {
  const listed = await staffOp<{ items: { values: Record<string, unknown> }[] }>(
    page,
    "record.list",
    { object, filter: { field: "order", op: "eq", value: orderId } },
  );
  return listed.items.map((item) => item.values);
}

/** A staff call through the HTTP surface, with the suite's signed-in session. */
async function staffOp<T>(page: Page, name: string, input: unknown): Promise<T> {
  const response = await page.request.post(`/api/v1/op/${name}`, {
    data: input,
    headers: { "idempotency-key": crypto.randomUUID() },
  });
  const body = (await response.json()) as { data?: T; error?: unknown };
  expect(response.status(), `${name}: ${JSON.stringify(body).slice(0, 300)}`).toBe(200);
  return body.data as T;
}

test("a guest buys, pays on the provider's page, and staff refund it through approval", async ({
  page,
  baseURL,
  browser,
}) => {
  test.setTimeout(180_000);
  const origin = new URL(baseURL ?? "").origin;
  // Selling is a reviewed change: an extension written over MCP cannot declare `sellable`.
  const app = await connectAdminApp(page, baseURL ?? "");
  const runtimeId = extensionId("box");
  await call(app.client, "extension_write", {
    id: runtimeId,
    files: { "index.ts": BOX_OFFICE.replaceAll('"boxoffice', `"${runtimeId}`) },
    reason: "A box office to sell tickets from",
  });
  const checked = await call(app.client, "extension_check", { id: runtimeId });
  expect(checked.ok).toBe(false);
  expect(JSON.stringify(checked.issues)).toContain("objects.tickettype.sellable");
  // Something to sell: the box office, the org's own extension here (scripts/dev-setup.mjs),
  // installed by an admin.
  const ext = "boxoffice";
  await staffOp(page, "extension.install", { id: ext, shipped: true });

  // The deployment sells in one currency, back to its own pages, through a payment account.
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
    const created = await staffOp<{ connection: { id: string } }>(page, "connection.create", {
      vendor: "payments",
      scope: "org",
    });
    connectionId = created.connection.id;
  }
  await staffOp(page, "connection.bindResource", {
    id: connectionId,
    url: "payments://merchant/fake",
  });
  const event = await staffOp<{ id: string }>(page, "record.create", {
    object: `${ext}.event`,
    values: { name: unique("Camp "), places: 40 },
  });
  const ticketType = await staffOp<{ id: string }>(page, "record.create", {
    object: `${ext}.tickettype`,
    values: { name: "Camp place", price: 120, places: 20, event: event.id },
  });

  // The guest: a browser with no session.
  const guestContext = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const guest = await guestContext.newPage();
  // The public pages are outside the signed-in shell: their buttons wait for hydration.
  await guest.goto(`/buy?object=${ext}.tickettype&id=${ticketType.id}`);
  await expect(guest.getByTestId("buy-continue")).toBeEnabled({ timeout: 30_000 });
  await guest.getByLabel("Email").fill(`${unique("guest")}@buyers.test`.toLowerCase());
  await guest.getByTestId("buy-continue").click();
  await expect(guest).toHaveURL(/\/order\/ord_[^?]+\?token=[0-9a-f]{64}/);
  const orderUrl = guest.url();
  const orderId = new URL(orderUrl).pathname.split("/").pop() as string;
  await expect(guest.getByTestId("guest-order-state")).toHaveAttribute("data-state", "pending");

  // The provider's own page (the fake one): the card is typed there, never in the CRM.
  await expect(guest.getByTestId("guest-pay")).toBeEnabled({ timeout: 30_000 });
  await guest.getByTestId("guest-pay").click();
  await expect(guest).toHaveURL(/\/gatekeeper\/payments\/fake\/pay\/fcs_/);
  await expect(guest.getByRole("heading", { name: /Fake payment page/i })).toBeVisible();
  await guest.getByRole("button", { name: "Pay", exact: true }).click();

  // Back on the return page: paid once the verified webhook has been applied.
  await expect(guest).toHaveURL(orderUrl);
  await expect(guest.getByTestId("guest-order-state")).toHaveAttribute("data-state", "paid", {
    timeout: 30_000,
  });

  // Coming back to the page again changes nothing and needs no session.
  const anonymous = await playwrightRequest.newContext({
    baseURL,
    storageState: { cookies: [], origins: [] },
  });
  const token = new URL(orderUrl).searchParams.get("token");
  const viewed = await anonymous.post("/api/v1/op/order.view", {
    data: { id: orderId, token },
  });
  expect((await viewed.json()).data.state).toBe("paid");
  await anonymous.dispose();
  // Paid: the order granted its ticket, with the host's code.
  const tickets = await ticketsOf(page, `${ext}.ticket`, orderId);
  expect(tickets).toHaveLength(1);
  expect(tickets[0]).toMatchObject({ state: "valid", ticketType: ticketType.id });
  expect(String(tickets[0]?.code)).toMatch(/^[0-9A-Z]{26}$/);

  // Staff refund it: it waits for approval, then the provider confirms.
  await open(page, `/orders/${orderId}`);
  await expect(page.getByTestId("order-state")).toHaveAttribute("data-state", "paid");
  await page.getByTestId("order-refund").click();
  const dialog = page.getByTestId("refund-dialog");
  await dialog.getByTestId("refund-reason").fill("The camp was moved");
  await dialog.getByTestId("refund-submit").click();
  await expect(page.getByTestId("refund-requested")).toBeVisible();

  await open(page, "/approvals");
  const action = page
    .getByTestId("pending-action")
    .filter({ has: page.getByTestId("outbound-preview").filter({ hasText: orderId }) });
  await expect(action).toBeVisible();
  await expect(action.getByTestId("risk-badge")).toHaveText("outbound");
  const set = page.getByTestId("change-set").filter({ has: action });
  await set.getByRole("button", { name: "Approve", exact: true }).click();
  // Refunds are outbound and high risk: a second press confirms when the inbox asks for one.
  const confirm = set.getByRole("button", { name: /^Confirm|^Yes, /i });
  if (await confirm.isVisible().catch(() => false)) await confirm.click();
  await expect(action).toHaveAttribute("data-status", "applied", { timeout: 15_000 });

  await expect(async () => {
    await open(page, `/orders/${orderId}`);
    await expect(page.getByTestId("order-state")).toHaveAttribute("data-state", "refunded", {
      timeout: 2_000,
    });
  }).toPass({ timeout: 30_000 });
  // Refunded in full: the ticket is void.
  expect((await ticketsOf(page, `${ext}.ticket`, orderId))[0]).toMatchObject({ state: "void" });
  await expect(guest.getByTestId("guest-order-state")).toBeVisible();
  await guestContext.close();
});
