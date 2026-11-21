// A guest buyer signs in later and sees their tickets (ADR 0458), in a real browser and against
// the real host: an admin lets buyers sign in, a guest buys on the fake provider's page and is
// sent back to the company's own site (another origin, which the page's form must be allowed to
// redirect to), then asks for a code with the address they bought with, signs in natively and
// reads their tickets. An address that only started a checkout gets no code.
import { createServer } from "node:http";
import { expect, type Page, request as playwrightRequest, test } from "@playwright/test";
import { unique } from "./helpers.ts";
import {
  addFakeResource,
  connectFake,
  fakeAddress,
  openIntegrations,
  sentMail,
} from "./integration-helpers.ts";

async function staffOp<T>(page: Page, name: string, input: unknown): Promise<T> {
  const response = await page.request.post(`/api/v1/op/${name}`, {
    data: input,
    headers: { "idempotency-key": crypto.randomUUID() },
  });
  const body = (await response.json()) as { data?: T; error?: unknown };
  expect(response.status(), `${name}: ${JSON.stringify(body).slice(0, 300)}`).toBe(200);
  return body.data as T;
}

/** The company's own site, on another origin: where the provider sends the buyer back. */
async function companySite() {
  const server = createServer((request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end(`<h1>Thanks for your order</h1><p>${request.url}</p>`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return { origin: `http://127.0.0.1:${port}`, close: () => server.close() };
}

test("a guest buys, is sent back to the site, then signs in and sees the tickets", async ({
  page,
  baseURL,
  browser,
}) => {
  test.setTimeout(180_000);
  const site = await companySite();
  try {
    const host = new URL(baseURL ?? "").origin;
    // Staff: ticketing on, the fake provider, the company's site as a return origin.
    await staffOp(page, "extension.install", { id: "ticketing", shipped: true });
    await staffOp(page, "order.settings.update", {
      currency: "AUD",
      returnOrigins: [host, site.origin],
    });
    await staffOp(page, "integration.setVendor", { vendor: "payments", enabled: true });
    const connections = await staffOp<{ items: { id: string; vendor: string; status: string }[] }>(
      page,
      "connection.list",
      {},
    );
    let payments = connections.items.find(
      (c) => c.vendor === "payments" && c.status === "active",
    )?.id;
    if (!payments) {
      payments = (
        await staffOp<{ connection: { id: string } }>(page, "connection.create", {
          vendor: "payments",
          scope: "org",
        })
      ).connection.id;
    }
    await staffOp(page, "connection.bindResource", {
      id: payments,
      url: "payments://merchant/fake",
    });

    // The host's mail, and buyers may sign in (Settings → Users, as an admin chooses).
    const outbox = fakeAddress("buyers");
    await openIntegrations(page);
    const mail = await connectFake(page, outbox, "org");
    await addFakeResource(page, mail, "Outbox", outbox);
    const mailId = (await mail.getAttribute("data-connection")) as string;
    await staffOp(page, "customer.settings.update", { emailConnectionId: mailId });
    await staffOp(page, "outbound.setAutoApprove", { tag: "fake.signin", enabled: true });
    await page.goto("/settings/users");
    await page.getByRole("radio", { name: /anyone who has bought/ }).click();
    await expect(
      page.getByText(/Customer sign-in: People you invite, and anyone who has bought/),
    ).toBeVisible();

    const event = await staffOp<{ id: string }>(page, "record.create", {
      object: "ticketing.event",
      values: { name: unique("Open night "), places: 20 },
    });
    await staffOp(page, "record.update", {
      object: "ticketing.event",
      id: event.id,
      values: { status: "on_sale" },
    });
    const ticketType = await staffOp<{ id: string }>(page, "record.create", {
      object: "ticketing.tickettype",
      values: { event: event.id, name: "Entry", price: 300 },
    });

    // The guest buys, with no session.
    const anonymous = await playwrightRequest.newContext({
      baseURL,
      storageState: { cookies: [], origins: [] },
    });
    const guestOp = async <T>(name: string, input: unknown): Promise<T> => {
      const response = await anonymous.post(`/api/v1/op/${name}`, {
        data: input,
        headers: { "idempotency-key": crypto.randomUUID() },
      });
      const body = (await response.json()) as { data?: T };
      expect(response.status(), `${name}: ${JSON.stringify(body).slice(0, 300)}`).toBe(200);
      return body.data as T;
    };
    const email = `${unique("buyer")}@buyers.test`.toLowerCase();
    const order = await guestOp<{ id: string; token: string }>("x.ticketing.orderStart", {
      lines: [{ ticketTypeId: ticketType.id, quantity: 2 }],
      email,
    });
    // Someone else only starts a checkout.
    const abandoned = `${unique("abandoned")}@buyers.test`.toLowerCase();
    await guestOp("x.ticketing.orderStart", {
      lines: [{ ticketTypeId: ticketType.id, quantity: 1 }],
      email: abandoned,
    });
    const checkout = await guestOp<{ url: string }>("order.checkout", {
      id: order.id,
      token: order.token,
      returnUrl: `${site.origin}/thanks?order=${order.id}`,
    });

    // The provider's page, in a browser: Pay, and back on the company's own site.
    const guestContext = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    const guest = await guestContext.newPage();
    await guest.goto(checkout.url);
    await guest.getByRole("button", { name: "Pay", exact: true }).click();
    await expect(guest).toHaveURL(`${site.origin}/thanks?order=${order.id}`);
    await expect(guest.getByRole("heading", { name: "Thanks for your order" })).toBeVisible();
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

    // Later, the buyer signs in with the address they bought with. The answer is the same for
    // the address that only started a checkout, and it gets no code.
    const ask = async (address: string) => {
      const response = await anonymous.post("/api/v1/auth/customer/code", {
        data: { email: address },
      });
      return { status: response.status(), body: await response.json() };
    };
    expect(await ask(abandoned)).toEqual(await ask(email));
    let code = "";
    await expect
      .poll(
        async () => {
          const sent = (await sentMail(page.request, outbox)).find((m) => m.to.includes(email));
          code = /(\d{6})/.exec(sent?.text ?? "")?.[1] ?? "";
          return code;
        },
        { timeout: 30_000 },
      )
      .toMatch(/^\d{6}$/);
    expect((await sentMail(page.request, outbox)).some((m) => m.to.includes(abandoned))).toBe(
      false,
    );
    const signedIn = await anonymous.post("/api/v1/auth/customer/sign-in", {
      data: { email, code, deviceName: "Buyer's phone" },
    });
    expect(signedIn.status(), await signedIn.text()).toBe(200);
    const { accessToken } = (await signedIn.json()).data as { accessToken: string };
    const mine = await anonymous.post("/api/v1/op/x.ticketing.myTickets", {
      data: {},
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(mine.status(), await mine.text()).toBe(200);
    expect(((await mine.json()).data as { items: unknown[] }).items).toHaveLength(2);
    await guestContext.close();
    await anonymous.dispose();
  } finally {
    site.close();
    await staffOp(page, "customer.settings.update", { signup: "invite_only" }).catch(() => {});
    await staffOp(page, "outbound.setAutoApprove", { tag: "fake.signin", enabled: false }).catch(
      () => {},
    );
  }
});
