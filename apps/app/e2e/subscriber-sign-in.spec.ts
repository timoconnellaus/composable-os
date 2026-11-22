// A new visitor starts a course plan with its free trial (ADR 0459), in a real browser against the
// real host: with "anyone starting a subscription" off, the visitor's address gets no code; an
// admin turns it on in Settings → Users; the visitor subscribes on the plan as a guest, is told the
// trial is for signed-in members, confirms their address with the code emailed to them there, goes
// on to the provider's (fake) page with the trial, pays, and holds every course. The subscribe
// block is the Courses pack's own web block, mounted at `/blocks` (development only), with the
// host's customer sign-in by code (`"signIn": "customer"`).
import { type APIRequestContext, expect, type Page, test } from "@playwright/test";
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
  const body = (await response.json()) as { data?: T; error?: unknown };
  if (ok) expect(response.status(), `${name}: ${JSON.stringify(body).slice(0, 300)}`).toBe(200);
  return (ok ? body.data : body.error) as T;
}

/** The code in the `count`th sign-in mail to `email`, once it has arrived. */
async function codeFor(page: Page, outbox: string, email: string, count: number) {
  let code = "";
  await expect
    .poll(
      async () => {
        const sent = (await sentMail(page.request, outbox)).filter((m) => m.to.includes(email));
        code = sent.length >= count ? (/\b(\d{6})\b/.exec(sent.at(-1)?.text ?? "")?.[1] ?? "") : "";
        return code;
      },
      { timeout: 30_000 },
    )
    .toMatch(/^\d{6}$/);
  return code;
}

const block = (name: string, component: string, props: Record<string, unknown> = {}) =>
  `/blocks?block=${name}&component=${component}&props=${encodeURIComponent(JSON.stringify(props))}`;

/** Courses on, the payments fake bound, and the host's mail sending sign-in codes at once. */
async function setUp(page: Page, origin: string): Promise<string> {
  for (const id of ["programs", "courses"]) {
    await op(page.request, "extension.install", { id, shipped: true }, false);
  }
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
  const outbox = fakeAddress("visitors");
  await openIntegrations(page);
  const mail = await connectFake(page, outbox, "org");
  await addFakeResource(page, mail, "Outbox", outbox);
  await op(page.request, "customer.settings.update", {
    signup: "invite_only",
    startingSubscription: false,
    emailConnectionId: await connectionId(mail),
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
  return outbox;
}

test("a new visitor confirms their address with a code and starts a course plan with its free trial", async ({
  page,
  browser,
  baseURL,
}) => {
  test.setTimeout(300_000);
  const origin = new URL(baseURL ?? "").origin;
  const outbox = await setUp(page, origin);
  const course = await op<{ id: string }>(page.request, "record.create", {
    object: "courses.course",
    values: { title: unique("Mobility "), price: 39 },
  });
  await op(page.request, "record.publish", { object: "courses.course", id: course.id });
  const title = unique("Every class ");
  const created = await op<{ id: string }>(page.request, "record.create", {
    object: "courses.plan",
    values: { title, price: 29, trialDays: 7 },
  });
  const email = `${unique("visitor")}@visitors.test`.toLowerCase();
  const visitor = await browser.newContext({ baseURL, storageState: { cookies: [], origins: [] } });
  try {
    // Off (the default): the visitor's address gets no code.
    const asked = await visitor.request.post("/api/customer-auth/email-otp/send-verification-otp", {
      data: { email, type: "sign-in" },
      headers: { origin },
    });
    expect(asked.status()).toBe(200);
    // An invited address asked after it does get one, so the mail is going out: none is coming
    // for the visitor.
    const invited = `${unique("member")}@visitors.test`.toLowerCase();
    await op(page.request, "customer.invite", { email: invited });
    await visitor.request.post("/api/customer-auth/email-otp/send-verification-otp", {
      data: { email: invited, type: "sign-in" },
      headers: { origin },
    });
    await expect
      .poll(
        async () => (await sentMail(page.request, outbox)).some((m) => m.to.includes(invited)),
        {
          timeout: 30_000,
        },
      )
      .toBe(true);
    expect((await sentMail(page.request, outbox)).some((m) => m.to.includes(email))).toBe(false);

    // An admin turns it on, where who can sign in is set.
    await open(page, "/settings/users");
    await page.getByRole("checkbox", { name: /Also anyone starting a subscription/ }).click();
    await expect(
      page.getByText("Customer sign-in: also anyone starting a subscription"),
    ).toBeVisible();

    // The visitor, on the plan: subscribing as a guest gives no trial, and says so.
    const tab = await visitor.newPage();
    await tab.goto(
      block("courses-subscribe", "Subscribe", {
        returnUrl: `${origin}/blocks`,
        signedIn: false,
        signIn: "customer",
      }),
    );
    const card = tab.getByRole("region", { name: "Subscribe" });
    const plan = card.locator('[data-slot="card"]').filter({ hasText: title });
    await expect(card.getByText(title)).toBeVisible();
    await plan.getByLabel("Your email").fill(email);
    await plan.getByRole("button", { name: "Subscribe" }).click();
    await expect(card.getByRole("status")).toContainText("The free trial is for signed-in members");

    // They confirm their address with the emailed code, on the plan, and go on with the trial.
    await card.getByRole("button", { name: "Email me a code for the free trial" }).click();
    await codeFor(page, outbox, email, 1);
    // A wrong code is refused, and a new one can be asked for there, without reloading.
    await card.getByLabel("The code we emailed you").fill("000000");
    await card.getByRole("button", { name: "Confirm and start my free trial" }).click();
    await expect(card.getByRole("alert")).toContainText("That code did not work");
    await card.getByRole("button", { name: "Send me a new code" }).click();
    const code = await codeFor(page, outbox, email, 2);
    await card.getByLabel("The code we emailed you").fill(code);
    await card.getByRole("button", { name: "Confirm and start my free trial" }).click();
    await expect(tab.getByRole("heading", { name: /Fake payment page/i })).toBeVisible({
      timeout: 30_000,
    });
    await expect(tab.getByText(/Nothing is charged until/)).toBeVisible();
    await tab.getByRole("button", { name: "Pay", exact: true }).click();

    // Once the provider confirms, every published course is theirs, through the subscription.
    await expect
      .poll(
        async () =>
          (
            await op<{ courses: { id: string; why: string }[] }>(
              visitor.request,
              "x.courses.myCourses",
              {},
            )
          ).courses.find((c) => c.id === course.id)?.why,
        { timeout: 30_000 },
      )
      .toBe("subscription");

    // With sign-up open to anyone, the stored switch is shown on and kept for later.
    await op(page.request, "customer.settings.update", { signup: "open" });
    await open(page, "/settings/users");
    await expect(page.getByTestId("starting-subscription-kept")).toContainText(
      "applies again if you change who can sign in back",
    );
    await expect(
      page.getByRole("checkbox", { name: /Also anyone starting a subscription/ }),
    ).toBeChecked();
  } finally {
    await visitor.close();
    // The plan goes to the Trash, so a later spec on this database offers only its own.
    await op(page.request, "record.delete", { object: "courses.plan", id: created.id }, false);
    await op(
      page.request,
      "outbound.setAutoApprove",
      { tag: "fake.signin", enabled: false },
      false,
    );
    await op(
      page.request,
      "customer.settings.update",
      { signup: "invite_only", startingSubscription: false },
      false,
    );
  }
});

test("a visitor whose record waits for staff is not stranded: they subscribe as a guest, and staff are told", async ({
  page,
  browser,
  baseURL,
}) => {
  test.setTimeout(300_000);
  const origin = new URL(baseURL ?? "").origin;
  const outbox = await setUp(page, origin);
  const title = unique("Every class ");
  const created = await op<{ id: string }>(page.request, "record.create", {
    object: "courses.plan",
    values: { title, price: 29, trialDays: 7 },
  });
  // On once the plan is on sale: a code request may reuse "is a plan on sale" for up to a minute,
  // so turning it on first, then putting a plan on sale, could keep codes back for that minute.
  await op(page.request, "customer.settings.update", { startingSubscription: true });
  expect(
    await op<{ startingSubscription: boolean; planOnSale: boolean }>(
      page.request,
      "customer.settings.get",
      {},
    ),
  ).toMatchObject({ startingSubscription: true, planOnSale: true });
  // One Person with two addresses, already signed in as a customer with the first: an account
  // for the second has to wait for staff (the Person has another account).
  const first = `${unique("known")}@visitors.test`.toLowerCase();
  const second = `${unique("known-too")}@visitors.test`.toLowerCase();
  await op(page.request, "person.create", {
    givenName: "Known",
    emails: [{ email: first, primary: true }, { email: second }],
  });
  const visitor = await browser.newContext({ baseURL, storageState: { cookies: [], origins: [] } });
  try {
    const member = await browser.newContext({
      baseURL,
      storageState: { cookies: [], origins: [] },
    });
    const asked = await member.request.post("/api/customer-auth/email-otp/send-verification-otp", {
      data: { email: first, type: "sign-in" },
      headers: { origin },
    });
    expect(asked.status(), await asked.text()).toBe(200);
    const signedIn = await member.request.post("/api/customer-auth/sign-in/email-otp", {
      data: { email: first, otp: await codeFor(page, outbox, first, 1) },
      headers: { origin },
    });
    expect(signedIn.status()).toBe(200);
    await member.close();

    const tab = await visitor.newPage();
    await tab.goto(
      block("courses-subscribe", "Subscribe", {
        returnUrl: `${origin}/blocks`,
        signedIn: false,
        signIn: "customer",
      }),
    );
    const card = tab.getByRole("region", { name: "Subscribe" });
    const plan = card.locator('[data-slot="card"]').filter({ hasText: title });
    await plan.getByLabel("Your email").fill(second);
    await plan.getByRole("button", { name: "Subscribe" }).click();
    await card.getByRole("button", { name: "Email me a code for the free trial" }).click();
    await card.getByLabel("The code we emailed you").fill(await codeFor(page, outbox, second, 1));
    await card.getByRole("button", { name: "Confirm and start my free trial" }).click();

    // Not stranded: told why, the email field back, and they can pay from today as a guest.
    await expect(card.getByRole("status")).toContainText("we need to sort out your record");
    await expect(plan.getByLabel("Your email")).toHaveValue(second);
    await plan.getByRole("button", { name: "Subscribe" }).click();
    await expect(tab.getByRole("heading", { name: /Fake payment page/i })).toBeVisible({
      timeout: 30_000,
    });
    await expect(tab.getByText(/Nothing is charged until/)).toHaveCount(0);

    // Staff are told the account needs a merge.
    const notices = await op<{ items: { title: string; body: string | null }[] }>(
      page.request,
      "notification.list",
      { limit: 50 },
    );
    expect(
      notices.items.some(
        (n) => n.title === "A customer account needs a merge" && Boolean(n.body?.includes(second)),
      ),
    ).toBe(true);
  } finally {
    await visitor.close();
    await op(page.request, "record.delete", { object: "courses.plan", id: created.id }, false);
    await op(
      page.request,
      "outbound.setAutoApprove",
      { tag: "fake.signin", enabled: false },
      false,
    );
    await op(
      page.request,
      "customer.settings.update",
      { signup: "invite_only", startingSubscription: false },
      false,
    );
  }
});
