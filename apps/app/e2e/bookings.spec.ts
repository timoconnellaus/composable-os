// Stage 31a steps 3, 6, 7 and 8 end to end, one test per journey (a visitor paying for a class
// on the drop-in block is the last): a member books a class from the
// timetable and cancels it in time, with the membership's use given back; staff book a walk-in
// into a class type only staff book, paid at the desk; and staff link a parent to a child on the
// parent's page, and the parent books the child a class with the child's own pass. The blocks are the pack's own web blocks, mounted
// where they sit (`/blocks`, development only), calling the host's HTTP surface from the browser
// as a client app would. In local dev Programs and Bookings are the org's own extensions
// (scripts/dev-setup.mjs). The Memberships pack (stage 32b) is built beside this step, so the
// member's pass is a fixture holder (`bkfixture.pass`, a runtime extension installed here, never
// the real pack's id, so the Memberships spec can share the database in either order); local
// dev's Bookings is a variant whose `paidBy` also names the fixture (dev-setup.mjs). Step 4
// replaces it with the real pack.
import { type APIRequestContext, type Browser, expect, type Page, test } from "@playwright/test";
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

const HOUR = 3_600_000;

/** The fixture holder: what the Memberships pack's pass will be. */
const FIXTURE_PASS = `import { defineExtension } from "@composable-os/sdk";
export default defineExtension({
  id: "bkfixture",
  version: "0.0.1",
  contractVersion: 1,
  label: "Passes (fixture)",
  permissions: { modules: [] },
  objects: {
    pass: {
      label: "Pass", plural: "Passes", titleField: "name",
      fields: {
        name: { type: "text", label: "Name" },
        person: { type: "relation", label: "Person", to: "person", required: true },
        uses: { type: "number", label: "Uses" },
        per: { type: "select", label: "Per", options: [
          { value: "total", label: "Total" }, { value: "week", label: "Week" },
        ] },
      },
      allowance: {
        holds: { person: "person", uses: "uses", per: { field: "per" }, spendsOn: { object: "bookings.booking" } },
      },
    },
  },
});
`;

async function setUp(page: Page) {
  for (const id of ["programs", "bookings"]) {
    await op(page.request, "extension.install", { id, shipped: true }, false);
  }
  await op(page.request, "extension.install", {
    id: "bkfixture",
    files: { "index.ts": FIXTURE_PASS },
  });
}

/** A one-off class `startsIn` ms from now, of a new class type. */
async function oneOff(page: Page, startsIn: number, typeValues: Record<string, unknown> = {}) {
  const name = unique("Strength ");
  const classType = await op<{ id: string }>(page.request, "record.create", {
    object: "programs.classtype",
    values: { name, ...typeValues },
  });
  const startsAt = new Date(Date.now() + startsIn).toISOString();
  const klass = await op<{ id: string }>(page.request, "record.create", {
    object: "bookings.class",
    values: {
      classType: classType.id,
      startsAt,
      endsAt: new Date(Date.now() + startsIn + HOUR).toISOString(),
      timezone: "UTC",
      places: 6,
    },
  });
  return { id: klass.id, name, startsAt };
}

/** A member signed in by the host's code, as a client app signs one in. */
async function signInMember(page: Page, browser: Browser, baseURL: string, email: string) {
  const origin = new URL(baseURL).origin;
  const outbox = fakeAddress("members");
  await openIntegrations(page);
  const connection = await connectFake(page, outbox, "org");
  await addFakeResource(page, connection, "Outbox", outbox);
  await op(page.request, "customer.settings.update", {
    signup: "open",
    emailConnectionId: await connectionId(connection),
  });
  // The host's sign-in mail goes out without review, as the courses spec turns it on.
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

test("a member books a class from the timetable and cancels it in time", async ({
  page,
  browser,
  baseURL,
}) => {
  test.setTimeout(180_000);
  await setUp(page);
  const email = `${unique("member")}@members.test`.toLowerCase();
  const person = await op<{ id: string }>(page.request, "person.create", {
    givenName: unique("Member"),
    emails: [{ email }],
  });
  // Their pass: 3 classes a week (in the Memberships pack this is a membership or a pass).
  const pass = await op<{ id: string }>(page.request, "record.create", {
    object: "bkfixture.pass",
    values: { name: unique("Pass "), person: person.id, uses: 3, per: "week" },
  });
  // In 3 hours: open (7 days before, the organisation's default) and in time to cancel (late
  // from an hour before).
  const klass = await oneOff(page, 3 * HOUR);
  const left = async () =>
    (
      await op<{ values: { left: number } }>(page.request, "record.get", {
        object: "bkfixture.pass",
        id: pass.id,
      })
    ).values.left;
  expect(await left()).toBe(3);

  try {
    const member = await signInMember(page, browser, baseURL ?? "", email);
    const memberPage = await member.newPage();
    await memberPage.goto(block("bookings-timetable", "Timetable"));
    const timetable = memberPage.getByRole("region", { name: "Timetable" });
    await timetable.getByRole("button", { name: `Book ${klass.name}` }).click();
    await expect(timetable.getByRole("status")).toContainText(`Booked: ${klass.name}`);
    await expect.poll(left).toBe(2);

    // Cancel: the host says it is in time, then cancels it, and the use is back.
    await timetable.getByRole("button", { name: `Cancel ${klass.name}` }).click();
    await expect(timetable.getByText("Cancelling now is in time")).toBeVisible();
    await timetable.getByRole("button", { name: "Confirm cancel" }).click();
    await expect(timetable.getByRole("status")).toContainText("The class is back");
    await expect.poll(left).toBe(3);
    const bookings = await op<{ items: { values: { state: string; person: string } }[] }>(
      page.request,
      "record.list",
      {
        object: "bookings.booking",
        filter: { field: "class", op: "eq", value: klass.id },
      },
    );
    expect(bookings.items.map((b) => b.values)).toEqual([
      expect.objectContaining({ state: "cancelled", person: person.id }),
    ]);
    // And they can book it again from the timetable.
    await expect(timetable.getByRole("button", { name: `Book ${klass.name}` })).toBeVisible();
    await member.close();
  } finally {
    await op(
      page.request,
      "outbound.setAutoApprove",
      { tag: "fake.signin", enabled: false },
      false,
    );
    await op(page.request, "customer.settings.update", { signup: "invite_only" }, false);
  }
});

test("staff book a walk-in into a class only staff book, paid at the desk", async ({ page }) => {
  test.setTimeout(120_000);
  await setUp(page);
  const klass = await oneOff(page, 2 * HOUR, { "bookings.staffOnly": true });
  const date = klass.startsAt.slice(0, 10);
  await page.goto(block("bookings-desk", "Desk", { date, timeZone: "UTC" }));
  const desk = page.getByRole("region", { name: "Front desk" });
  await expect(desk.getByText(klass.name).first()).toBeVisible();
  await expect(desk.getByText(/booked by staff/).first()).toBeVisible();
  const form = desk.getByRole("form", { name: "Book someone in" });
  await form.getByLabel("Class").selectOption(klass.id);
  const given = unique("Walk");
  await form.getByLabel(/Given name/).fill(given);
  await expect(form.getByLabel(/Paid at the desk/)).toBeChecked();
  await form.getByRole("button", { name: "Book walk-in" }).click();
  await expect(form.getByRole("status")).toHaveText("Booked in.");
  const bookings = await op<{ items: { values: Record<string, unknown> }[] }>(
    page.request,
    "record.list",
    { object: "bookings.booking", filter: { field: "class", op: "eq", value: klass.id } },
  );
  expect(bookings.items.map((b) => b.values)).toEqual([
    expect.objectContaining({ state: "booked", paidOtherwise: true }),
  ]);
  const after = await op<{ values: { taken: number } }>(page.request, "record.get", {
    object: "bookings.class",
    id: klass.id,
  });
  expect(after.values.taken).toBe(1);
});

// Step 7: the coach's list. A class about to start, someone booked; the list block ticks them,
// and a second tick of the same name (another coach a moment later) is told who was first.
test("a coach ticks who came on a class's list", async ({ page }) => {
  test.setTimeout(120_000);
  await setUp(page);
  const klass = await oneOff(page, 30 * 60_000);
  const person = await op<{ id: string }>(page.request, "person.create", {
    givenName: unique("Ticked"),
  });
  const name = (await op<{ displayName: string }>(page.request, "person.get", { id: person.id }))
    .displayName;
  const made = await op<{ result: string; bookingId: string }>(page.request, "x.bookings.bookFor", {
    classId: klass.id,
    personId: person.id,
    paidAtDesk: true,
  });
  expect(made.result).toBe("booked");
  await page.goto(block("bookings-class-list", "ClassList", { classId: klass.id }));
  const list = page.getByRole("region", { name: "Class list" });
  await expect(list.getByText(`${name} · Booked`)).toBeVisible();
  await list.getByRole("button", { name: `Tick ${name}` }).click();
  await expect(list.getByRole("status")).toHaveText("Ticked: they came.");
  await expect(list.getByRole("button", { name: `Untick ${name}` })).toBeVisible();
  // The same name ticked again: once, and the second is told who was first.
  const again = await op<{ result: string; message: string }>(
    page.request,
    "x.bookings.markAttended",
    { bookingId: made.bookingId },
  );
  expect(again.result).toBe("already");
  expect(again.message).toMatch(/^Already ticked as come by /);
  const booking = await op<{ values: Record<string, unknown> }>(page.request, "record.get", {
    object: "bookings.booking",
    id: made.bookingId,
  });
  expect(booking.values).toMatchObject({ state: "attended" });
});

test("staff link a parent to their child, and the parent books the child a class", async ({
  page,
  browser,
  baseURL,
}) => {
  test.setTimeout(180_000);
  await setUp(page);
  const email = `${unique("parent")}@members.test`.toLowerCase();
  const parent = await op<{ id: string }>(page.request, "person.create", {
    givenName: unique("Parent"),
    emails: [{ email }],
  });
  // The child has no email and no account; their own pass pays for their classes.
  const childName = unique("Kid");
  const child = await op<{ id: string }>(page.request, "person.create", { givenName: childName });
  const pass = await op<{ id: string }>(page.request, "record.create", {
    object: "bkfixture.pass",
    values: { name: unique("Kids pass "), person: child.id, uses: 3, per: "week" },
  });
  const klass = await oneOff(page, 3 * HOUR);
  const left = async () =>
    (
      await op<{ values: { left: number } }>(page.request, "record.get", {
        object: "bkfixture.pass",
        id: pass.id,
      })
    ).values.left;

  // At the desk: staff link the parent to the child on the parent's page.
  await open(page, `/people/${parent.id}`);
  const family = page.getByTestId("family-card");
  await family.getByRole("button", { name: "Add a family link" }).click();
  await family.getByRole("button", { name: /Family member/ }).click();
  await page.getByPlaceholder("Search people…").fill(childName);
  await page.getByRole("option", { name: new RegExp(childName) }).click();
  await family.getByRole("button", { name: "Link", exact: true }).click();
  await expect(family.getByRole("link", { name: childName })).toBeVisible();

  try {
    const member = await signInMember(page, browser, baseURL ?? "", email);
    const memberPage = await member.newPage();
    await memberPage.goto(block("bookings-timetable", "Timetable"));
    const timetable = memberPage.getByRole("region", { name: "Timetable" });
    await timetable.getByLabel("Booking for").selectOption({ label: childName });
    await timetable.getByRole("button", { name: `Book ${klass.name}` }).click();
    await expect(timetable.getByRole("status")).toContainText(
      `Booked for ${childName}: ${klass.name}`,
    );
    // The child's pass paid: the booking is the child's, made by the parent.
    await expect.poll(left).toBe(2);
    const bookings = await op<{ items: { values: Record<string, unknown> }[] }>(
      page.request,
      "record.list",
      { object: "bookings.booking", filter: { field: "class", op: "eq", value: klass.id } },
    );
    expect(bookings.items.map((b) => b.values)).toEqual([
      expect.objectContaining({ state: "booked", person: child.id, madeBy: parent.id }),
    ]);
    // Seen as the child's: Cancel shows for the child, Book for the parent themselves.
    await expect(timetable.getByRole("button", { name: `Cancel ${klass.name}` })).toBeVisible();
    await timetable.getByLabel("Booking for").selectOption({ label: "Me" });
    await expect(timetable.getByRole("button", { name: `Book ${klass.name}` })).toBeVisible();
    await member.close();
  } finally {
    await op(
      page.request,
      "outbound.setAutoApprove",
      { tag: "fake.signin", enabled: false },
      false,
    );
    await op(page.request, "customer.settings.update", { signup: "invite_only" }, false);
  }
});

// Stage 31a step 8 (ADR 0560): a visitor pays for one class on the drop-in block, on the payments
// gatekeeper's fake provider, and is booked once the payment is verified.
test("a visitor pays for a class on the website and is booked", async ({
  page,
  browser,
  baseURL,
}) => {
  await setUp(page);
  const origin = new URL(baseURL ?? "http://localhost").origin;
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
  const klass = await oneOff(page, 5 * HOUR, { "bookings.dropInPrice": 22 });
  // A visitor: no account, no cookies.
  const visitor = await browser.newContext({ baseURL, storageState: { cookies: [], origins: [] } });
  const visitorPage = await visitor.newPage();
  await visitorPage.goto(
    block("bookings-drop-in", "DropIn", { signedIn: false, returnUrl: `${origin}/blocks` }),
  );
  const list = visitorPage.getByRole("region", { name: "Pay for a class" });
  await list.getByRole("button", { name: `Pay for ${klass.name}` }).click();
  const email = `${unique("visitor").toLowerCase()}@dropin.test`;
  await visitorPage.getByLabel("Your email").fill(email);
  await visitorPage.getByRole("button", { name: "Pay", exact: true }).click();
  await expect(visitorPage.getByRole("heading", { name: /Fake payment page/i })).toBeVisible({
    timeout: 30_000,
  });
  // Held while they pay: the class shows the place taken out.
  const held = await op<{ values: Record<string, unknown> }>(page.request, "record.get", {
    object: "bookings.class",
    id: klass.id,
  });
  expect(held.values).toMatchObject({ held: 1 });
  await visitorPage.getByRole("button", { name: "Pay", exact: true }).click();
  // Once the provider confirms it, the host books them: the place is taken, nothing held.
  await expect
    .poll(
      async () => {
        const bookings = await op<{ items: { values: Record<string, unknown> }[] }>(
          page.request,
          "record.list",
          { object: "bookings.booking", filter: { field: "class", op: "eq", value: klass.id } },
        );
        return bookings.items.map((b) => b.values.state);
      },
      { timeout: 30_000 },
    )
    .toEqual(["booked"]);
  await visitor.close();
});
