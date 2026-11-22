// Stage 32b end to end, one test per journey: a member subscribes to a membership on the payments
// gatekeeper's fake provider and sees their classes left; a member buys a class pack and sees it;
// the intro offer is refused the second time. The blocks are the pack's own web blocks, mounted
// where they sit (`/blocks`, development only), calling the host's HTTP surface from the browser
// as a client app would. In local dev Memberships and Programs are the org's own extensions
// (scripts/dev-setup.mjs).
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
  const body = (await response.json()) as { data?: T; error?: { code?: string } };
  if (ok) expect(response.status(), `${name}: ${JSON.stringify(body).slice(0, 300)}`).toBe(200);
  return (ok ? body.data : body.error) as T;
}

const block = (name: string, component: string, props: Record<string, unknown> = {}) =>
  `/blocks?block=${name}&component=${component}&props=${encodeURIComponent(JSON.stringify(props))}`;

/** Both packs on, the orders' currency and the payments fake bound. */
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
}

/** A member signed in by an emailed code, in a browser context of their own. */
async function signInMember(page: Page, browser: Browser, baseURL: string): Promise<BrowserContext> {
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
  const email = `${unique("member")}@members.test`.toLowerCase();
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

async function resetSignUp(page: Page): Promise<void> {
  await op(page.request, "outbound.setAutoApprove", { tag: "fake.signin", enabled: false }, false);
  await op(page.request, "customer.settings.update", { signup: "invite_only" }, false);
}

/** Buys a pass type on the passes block and pays on the fake provider's page. */
async function buyPass(memberPage: Page, origin: string, title: string) {
  await memberPage.goto(
    block("memberships-passes", "Passes", { returnUrl: `${origin}/blocks`, signedIn: true }),
  );
  const card = memberPage.getByRole("region", { name: "Passes" }).locator("[data-slot=card]", {
    hasText: title,
  });
  await card.getByRole("button", { name: "Buy" }).click();
  return card;
}

test("a member subscribes to a membership on the fake provider and sees their classes left", async ({
  page,
  browser,
  baseURL,
}) => {
  test.setTimeout(300_000);
  const origin = new URL(baseURL ?? "").origin;
  await setUp(page, baseURL ?? "");
  const title = unique("Three a week ");
  await op(page.request, "record.create", {
    object: "memberships.plan",
    values: { title, price: 45, uses: 3, per: "week", trialDays: 7, status: "on_sale" },
  });
  try {
    const member = await signInMember(page, browser, baseURL ?? "");
    const memberPage = await member.newPage();
    await memberPage.goto(
      block("memberships-plans", "Plans", { returnUrl: `${origin}/blocks`, signedIn: true }),
    );
    const plans = memberPage.getByRole("region", { name: "Memberships" });
    await expect(plans.getByText(title)).toBeVisible();
    await plans.getByRole("button", { name: "Start your 7-day free trial" }).first().click();
    await expect(memberPage.getByRole("heading", { name: /Fake payment page/i })).toBeVisible({
      timeout: 30_000,
    });
    await memberPage.getByRole("button", { name: "Pay", exact: true }).click();

    // Once the provider confirms, the host has granted the membership: 3 classes this week.
    await expect
      .poll(
        async () => {
          await memberPage.goto(
            block("memberships-mine", "MyMemberships", { returnUrl: `${origin}/blocks` }),
          );
          return memberPage
            .getByRole("region", { name: "My memberships" })
            .getByTestId("holding-left")
            .first()
            .textContent({ timeout: 10_000 })
            .catch(() => null);
        },
        { timeout: 60_000 },
      )
      .toBe("3 of 3 left this week");
    const mine = memberPage.getByRole("region", { name: "My memberships" });
    await expect(mine.getByText(title).first()).toBeVisible();
    await expect(mine.getByTestId("subscription-status").first()).toContainText("Free until");
    await member.close();

    // Staff see the member among those on trial.
    await open(page, "/subscriptions?view=trials");
    await expect(page.getByRole("link", { name: title })).toBeVisible();
  } finally {
    await resetSignUp(page);
  }
});

test("a member buys a class pack and sees what it gives", async ({ page, browser, baseURL }) => {
  test.setTimeout(300_000);
  const origin = new URL(baseURL ?? "").origin;
  await setUp(page, baseURL ?? "");
  const title = unique("Five classes ");
  await op(page.request, "record.create", {
    object: "memberships.passtype",
    values: { title, price: 100, uses: 5, validDays: 60, status: "on_sale" },
  });
  try {
    const member = await signInMember(page, browser, baseURL ?? "");
    const memberPage = await member.newPage();
    await buyPass(memberPage, origin, title);
    await expect(memberPage.getByRole("heading", { name: /Fake payment page/i })).toBeVisible({
      timeout: 30_000,
    });
    await memberPage.getByRole("button", { name: "Pay", exact: true }).click();
    await expect
      .poll(
        async () => {
          await memberPage.goto(
            block("memberships-mine", "MyMemberships", { returnUrl: `${origin}/blocks` }),
          );
          return memberPage
            .getByRole("region", { name: "My memberships" })
            .locator("[data-kind=pass]", { hasText: title })
            .getByTestId("holding-left")
            .textContent({ timeout: 10_000 })
            .catch(() => null);
        },
        { timeout: 60_000 },
      )
      .toBe("5 of 5 left");
    await expect(
      memberPage.getByRole("region", { name: "My memberships" }).getByText(/^Expires /).first(),
    ).toBeVisible();
    await member.close();
  } finally {
    await resetSignUp(page);
  }
});

test("the intro offer is one per person: refused the second time", async ({
  page,
  browser,
  baseURL,
}) => {
  test.setTimeout(300_000);
  const origin = new URL(baseURL ?? "").origin;
  await setUp(page, baseURL ?? "");
  const title = unique("Intro week ");
  await op(page.request, "record.create", {
    object: "memberships.passtype",
    values: { title, price: 20, uses: 3, validDays: 7, onePerPerson: true, status: "on_sale" },
  });
  try {
    const member = await signInMember(page, browser, baseURL ?? "");
    const memberPage = await member.newPage();
    await buyPass(memberPage, origin, title);
    await expect(memberPage.getByRole("heading", { name: /Fake payment page/i })).toBeVisible({
      timeout: 30_000,
    });
    await memberPage.getByRole("button", { name: "Pay", exact: true }).click();
    await expect
      .poll(
        async () =>
          (
            await op<{ holdings: { title: string | null }[] }>(
              member.request,
              "x.memberships.mine",
              {},
            )
          ).holdings.some((h) => h.title === title),
        { timeout: 60_000 },
      )
      .toBe(true);

    // The second time, the host refuses it, and the block says why.
    const card = await buyPass(memberPage, origin, title);
    await expect(card.getByRole("alert")).toContainText("you have had yours");
    await member.close();
  } finally {
    await resetSignUp(page);
  }
});
