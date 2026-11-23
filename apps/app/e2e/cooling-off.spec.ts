// Stage 44 step 7 (ADR 0647) end to end, one test per journey: a new member joins a membership on
// the payments gatekeeper's fake provider, ends it inside the business's cooling-off period from
// the Memberships web block, and sees it ended with a full refund owed; and a member who cools off
// is refused the second time (once per member), the block naming why and offering no button. The
// block is the pack's own, mounted where it sits (`/blocks`, development only), calling the host's
// HTTP surface from the browser as a client app would.
//
// Clocks: the window is the host's (14 days from the provider's confirmation, to the end of the
// last day in the business's zone), so a member who joins now is inside it whatever the day or
// time of the run. The host's clock cannot be moved from a browser, so the closing instant (both
// sides of it, across a change of clocks) is tested in packages/core/test/subscription-cooling-off.
// test.ts, not here.
//
// It sets the Memberships cooling-off setting and puts it back after, so it runs only against the
// database its own dev server made: never a server it reuses (E2E_REUSE_SERVER=1) unless
// E2E_COOLING_OFF_REUSED=1 says that database may be changed. Every name and figure is invented.
import {
  type APIRequestContext,
  type Browser,
  type BrowserContext,
  expect,
  type Page,
  test,
} from "@playwright/test";
import { open, unique } from "./helpers.ts";
import {
  addFakeResource,
  connectFake,
  connectionId,
  fakeAddress,
  openIntegrations,
  sentMail,
} from "./integration-helpers.ts";

test.skip(
  process.env.E2E_REUSE_SERVER === "1" && process.env.E2E_COOLING_OFF_REUSED !== "1",
  "changes the Memberships cooling-off setting: not run against a database it did not make " +
    "(set E2E_COOLING_OFF_REUSED=1 to allow it)",
);

async function op<T>(
  request: APIRequestContext,
  name: string,
  input: unknown,
  ok = true,
): Promise<T> {
  const response = await request.post(`/api/v1/op/${name}`, {
    data: input,
    headers: { "idempotency-key": crypto.randomUUID() },
  });
  const body = (await response.json()) as {
    data?: T;
    error?: { code?: string; details?: unknown };
  };
  if (ok) expect(response.status(), `${name}: ${JSON.stringify(body).slice(0, 300)}`).toBe(200);
  return (ok ? body.data : body.error) as T;
}

const block = (name: string, component: string, props: Record<string, unknown> = {}) =>
  `/blocks?block=${name}&component=${component}&props=${encodeURIComponent(JSON.stringify(props))}`;

/** Both packs on, the orders' currency, the payments fake bound, 14 days of cooling off. */
async function setUp(page: Page, baseURL: string): Promise<void> {
  for (const id of ["programs", "memberships"]) {
    await op(page.request, "extension.install", { id, shipped: true }, false);
  }
  const origin = new URL(baseURL).origin;
  await op(page.request, "order.settings.update", { currency: "AUD", returnOrigins: [origin] });
  await op(page.request, "integration.setVendor", { vendor: "payments", enabled: true });
  const connections = await op<{ items: { id: string; vendor: string; status: string }[] }>(
    page.request,
    "connection.list",
    {},
  );
  let payments = connections.items.find(
    (c) => c.vendor === "payments" && c.status === "active",
  )?.id;
  if (!payments) {
    payments = (
      await op<{ connection: { id: string } }>(page.request, "connection.create", {
        vendor: "payments",
        scope: "org",
      })
    ).connection.id;
  }
  await op(page.request, "connection.bindResource", {
    id: payments,
    url: "payments://merchant/fake",
  });
  await op(page.request, "extensionSettings.update", {
    extension: "memberships",
    values: { coolingOffDays: 14 },
  });
}

/** Puts the setting and sign-up back as they were. */
async function tearDown(page: Page): Promise<void> {
  await op(
    page.request,
    "extensionSettings.update",
    { extension: "memberships", values: { coolingOffDays: null } },
    false,
  );
  await op(page.request, "outbound.setAutoApprove", { tag: "fake.signin", enabled: false }, false);
  await op(page.request, "customer.settings.update", { signup: "invite_only" }, false);
}

/** A member signed in by an emailed code, in a browser context of their own. */
async function signInMember(
  page: Page,
  browser: Browser,
  baseURL: string,
): Promise<BrowserContext> {
  const origin = new URL(baseURL).origin;
  const outbox = fakeAddress("members");
  await openIntegrations(page);
  const connection = await connectFake(page, outbox, "org");
  await addFakeResource(page, connection, "Outbox", outbox);
  await op(page.request, "customer.settings.update", {
    signup: "open",
    emailConnectionId: await connectionId(connection),
  });
  await open(page, "/settings/users");
  const signInMail = page.getByTestId("sign-in-mail");
  if ((await signInMail.getAttribute("data-ready")) !== "true") {
    await signInMail.getByRole("switch").click();
    await page
      .getByRole("alertdialog")
      .getByRole("button", { name: "Send without review" })
      .click();
  }
  await expect(signInMail).toHaveAttribute("data-ready", "true");
  const email = `${unique("cooler")}@members.test`.toLowerCase();
  const member = await browser.newContext({ baseURL, storageState: { cookies: [], origins: [] } });
  const asked = await member.request.post("/api/customer-auth/email-otp/send-verification-otp", {
    data: { email, type: "sign-in" },
    headers: { origin },
  });
  expect(asked.status(), await asked.text()).toBe(200);
  let code: string | undefined;
  await expect
    .poll(
      async () => {
        const mail = (await sentMail(page.request, outbox)).filter((m) => m.to.includes(email));
        code = /\b(\d{6})\b/.exec(mail.at(-1)?.text ?? "")?.[1];
        return code;
      },
      { timeout: 30_000 },
    )
    .toMatch(/^\d{6}$/);
  const signedIn = await member.request.post("/api/customer-auth/sign-in/email-otp", {
    data: { email, otp: code },
    headers: { origin },
  });
  expect(signedIn.status(), await signedIn.text()).toBe(200);
  return member;
}

/** A member subscribed to `title`'s plan (no trial), paid on the fake provider's page. */
async function joined(memberPage: Page, origin: string, title: string): Promise<string> {
  await memberPage.goto(
    block("memberships-plans", "Plans", { returnUrl: `${origin}/blocks`, signedIn: true }),
  );
  const plans = memberPage.getByRole("region", { name: "Memberships" });
  await plans
    .locator("[data-slot=card]", { hasText: title })
    .getByRole("button", { name: "Join" })
    .click();
  await expect(memberPage.getByRole("heading", { name: /Fake payment page/i })).toBeVisible({
    timeout: 30_000,
  });
  await memberPage.getByRole("button", { name: "Pay", exact: true }).click();
  let id = "";
  await expect
    .poll(
      async () => {
        const found = (
          await op<{ items: { id: string; planTitle: string; state: string }[] }>(
            memberPage.request,
            "subscription.list",
            {},
          )
        ).items.find((s) => s.planTitle === title && s.state === "active");
        id = found?.id ?? "";
        return found?.state ?? null;
      },
      { timeout: 60_000 },
    )
    .toBe("active");
  return id;
}

const mine = (origin: string) =>
  block("memberships-mine", "MyMemberships", { returnUrl: `${origin}/blocks` });

test("a new member ends their membership in the cooling-off period and sees a full refund owed", async ({
  page,
  browser,
  baseURL,
}) => {
  test.setTimeout(300_000);
  const origin = new URL(baseURL ?? "").origin;
  await setUp(page, baseURL ?? "");
  const title = unique("Cool three a week ");
  await op(page.request, "record.create", {
    object: "memberships.plan",
    values: { title, price: 41.5, uses: 3, per: "week", status: "on_sale" },
  });
  try {
    const member = await signInMember(page, browser, baseURL ?? "");
    const memberPage = await member.newPage();
    const id = await joined(memberPage, origin, title);
    // The provider's paid period arrives: the host offers cooling off, with its last day.
    const card = memberPage
      .getByRole("region", { name: "My memberships" })
      .locator("[data-slot=card]", { hasText: title })
      .filter({ has: memberPage.getByTestId("subscription-status") });
    await expect
      .poll(
        async () => {
          await memberPage.goto(mine(origin));
          return card
            .getByRole("button", { name: "Cancel for a full refund" })
            .isVisible({ timeout: 10_000 })
            .catch(() => false);
        },
        { timeout: 60_000 },
      )
      .toBe(true);
    await expect(card.getByTestId("cooling-off")).toContainText(
      "You can cancel for a full refund until the end of",
    );
    memberPage.once("dialog", (dialog) => {
      expect(dialog.message()).toContain("full refund of");
      void dialog.accept();
    });
    await card.getByRole("button", { name: "Cancel for a full refund" }).click();
    await expect(
      memberPage.getByRole("region", { name: "My memberships" }).getByRole("status"),
    ).toContainText("A full refund of");
    // The fake provider ends it and says so: the host shows it ended, with the refund owed.
    const ended = memberPage
      .getByRole("region", { name: "My memberships" })
      .locator("[data-kind=cooled-off]", { hasText: title });
    await expect
      .poll(
        async () => {
          await memberPage.goto(mine(origin));
          return ended
            .getByTestId("cooling-off")
            .textContent({ timeout: 10_000 })
            .catch(() => null);
        },
        { timeout: 60_000 },
      )
      .toMatch(/^Ended in the cooling-off period\. A full refund of .+ is owed/);
    await expect(ended.getByTestId("subscription-status")).toContainText("Ended");
    await member.close();

    // Staff see it on the subscription's page, the refund waiting for approval.
    await open(page, `/subscriptions/${id}`);
    await expect(page.getByTestId("subscription-cooling-off")).toContainText(
      "Ended in its cooling-off period",
    );
  } finally {
    await tearDown(page);
  }
});

test("a member who cooled off once is refused the second time, and told why", async ({
  page,
  browser,
  baseURL,
}) => {
  test.setTimeout(300_000);
  const origin = new URL(baseURL ?? "").origin;
  await setUp(page, baseURL ?? "");
  const first = unique("Cool first ");
  const second = unique("Cool second ");
  for (const title of [first, second]) {
    await op(page.request, "record.create", {
      object: "memberships.plan",
      values: { title, price: 33, uses: 2, per: "week", status: "on_sale" },
    });
  }
  try {
    const member = await signInMember(page, browser, baseURL ?? "");
    const memberPage = await member.newPage();
    const id = await joined(memberPage, origin, first);
    await expect
      .poll(
        async () =>
          (
            await op<{ items: { offered: boolean }[] }>(
              memberPage.request,
              "subscription.coolingOff",
              { ids: [id] },
            )
          ).items[0]?.offered ?? false,
        { timeout: 60_000 },
      )
      .toBe(true);
    await op(memberPage.request, "subscription.coolOff", { id });
    const again = await joined(memberPage, origin, second);
    // The host refuses it: the block offers no button and says why.
    const card = memberPage
      .getByRole("region", { name: "My memberships" })
      .locator("[data-slot=card]", { hasText: second })
      .filter({ has: memberPage.getByTestId("subscription-status") });
    await expect
      .poll(
        async () => {
          await memberPage.goto(mine(origin));
          return card
            .getByTestId("cooling-off")
            .textContent({ timeout: 10_000 })
            .catch(() => null);
        },
        { timeout: 60_000 },
      )
      .toContain("once per member");
    await expect(card.getByRole("button", { name: "Cancel for a full refund" })).toHaveCount(0);
    // Asked directly, the host refuses it too.
    const refused = await op<{ code: string; details: { reason?: string } }>(
      memberPage.request,
      "subscription.coolOff",
      { id: again },
      false,
    );
    expect(refused).toMatchObject({ code: "conflict", details: { reason: "used" } });
    await member.close();
  } finally {
    await tearDown(page);
  }
});
