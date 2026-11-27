// Agreements, step 5 (stage 44): the blocks, one test per journey. A member agrees on "Before you
// go on" and then books; a visitor pays for a class with a drawn waiver and a health form inline;
// a parent agrees for their child and books them; a new version ("agree again") is asked inline
// at the member's next booking; a member marked a minor is told a parent or guardian buys a pass;
// a member buying a course agrees to its terms inline on the course page (issue #292).
// The blocks are mounted where they sit (`/blocks`, development only), calling the host's HTTP
// surface from the browser as a client app would. Documents attach to the real packs' points
// (`booking`, `membership`, `course`) and are retired at the end of each test, so no other spec is asked
// for them. All document text is fixture text, not wording anyone should use.
//
// It retires every live document and changes the customer and order settings, so it runs only
// against the database its own dev server made: never a server it reuses (E2E_REUSE_SERVER=1)
// unless E2E_AGREEMENTS_REUSED=1 says that database may be changed. The settings it changes are
// put back as they were after each test.
import {
  type APIRequestContext,
  type Browser,
  expect,
  type Locator,
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

const HOUR = 3_600_000;

test.skip(
  process.env.E2E_REUSE_SERVER === "1" && process.env.E2E_AGREEMENTS_REUSED !== "1",
  "retires documents and changes settings: not run against a database it did not make " +
    "(set E2E_AGREEMENTS_REUSED=1 to allow it)",
);

/** The settings a test changes, as they were before it, to put back. */
interface Before {
  customer: { signup: string; emailConnectionId: string | null };
  order: { currency: string | null; returnOrigins: string[] };
}
let before: Before | null = null;

/** What a member's pass is in the bookings spec: a fixture holder the dev Bookings spends. */
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

/**
 * The packs on, the payments fake bound, and no other live document anywhere: what earlier specs
 * left attached would be asked too.
 */
async function setUp(page: Page, baseURL: string) {
  before = {
    customer: await op(page.request, "customer.settings.get", {}),
    order: await op(page.request, "order.settings.get", {}),
  };
  for (const id of ["bookings", "memberships"]) {
    await op(page.request, "extension.install", { id, shipped: true }, false);
  }
  await op(page.request, "extension.install", {
    id: "bkfixture",
    files: { "index.ts": FIXTURE_PASS },
  });
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
  await retireAll(page);
}

async function retireAll(page: Page) {
  const docs = await op<{ items: { id: string; state: string }[] }>(
    page.request,
    "agreement.list",
    {},
  );
  for (const doc of docs.items) {
    if (doc.state !== "retired") await op(page.request, "agreement.retire", { documentId: doc.id });
  }
}

const body = (text: string) => ({
  blocks: [
    { type: "heading", level: 1, content: [{ type: "text", text: "Fixture heading" }] },
    { type: "paragraph", content: [{ type: "text", text }] },
  ],
});

interface Doc {
  id: string;
  title: string;
  versionId: string;
}

/** A document published and attached to `points`. */
async function publish(
  page: Page,
  kind: "terms" | "waiver" | "health" | "guardian",
  points: string[],
  extra: Record<string, unknown> = {},
): Promise<Doc> {
  const title = `${kind} ${unique("doc")}`;
  const { id } = await op<{ id: string }>(page.request, "agreement.create", { title, kind });
  const saved = await op<{ hash: string; rev: number }>(page.request, "agreement.draft.save", {
    id,
    body: body("Fixture text: not a real document."),
    tickLabel: "I have read the fixture",
    ...extra,
  });
  const { version } = await op<{ version: { id: string } }>(page.request, "agreement.publish", {
    documentId: id,
    draftHash: saved.hash,
    draftRev: saved.rev,
    number: 1,
    change: "small",
  });
  await op(page.request, "agreement.attach", { documentId: id, points });
  return { id, title, versionId: version.id };
}

/** A new version of `doc` everyone must agree to again. */
async function agreeAgain(page: Page, doc: Doc) {
  const saved = await op<{ hash: string; rev: number }>(page.request, "agreement.draft.save", {
    id: doc.id,
    body: body(`Fixture text, changed ${unique()}.`),
  });
  const { version } = await op<{ version: { id: string } }>(page.request, "agreement.publish", {
    documentId: doc.id,
    draftHash: saved.hash,
    draftRev: saved.rev,
    number: 2,
    change: "agree_again",
  });
  doc.versionId = version.id;
}

/** A one-off class `startsIn` ms from now. */
async function oneOff(page: Page, startsIn: number, typeValues: Record<string, unknown> = {}) {
  const name = unique("Strength ");
  const classType = await op<{ id: string }>(page.request, "record.create", {
    object: "bookings.classtype",
    values: { name, ...typeValues },
  });
  const klass = await op<{ id: string }>(page.request, "record.create", {
    object: "bookings.class",
    values: {
      classType: classType.id,
      startsAt: new Date(Date.now() + startsIn).toISOString(),
      endsAt: new Date(Date.now() + startsIn + HOUR).toISOString(),
      timezone: "UTC",
      places: 6,
    },
  });
  return { id: klass.id, name };
}

async function newPerson(page: Page, label: string, uses = 0) {
  const email = `${unique(label)}@members.test`.toLowerCase();
  const person = await op<{ id: string }>(page.request, "person.create", {
    givenName: unique(label),
    emails: [{ email }],
  });
  if (uses) await givePass(page, person.id, uses);
  return { id: person.id, email };
}

async function givePass(page: Page, personId: string, uses: number) {
  await op(page.request, "record.create", {
    object: "bkfixture.pass",
    values: { name: unique("Pass "), person: personId, uses, per: "total" },
  });
}

/** A member signed in by the host's code, in a browser context of their own. */
async function signIn(page: Page, browser: Browser, baseURL: string, email: string) {
  const origin = new URL(baseURL).origin;
  const outbox = fakeAddress("agreeblocks");
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

async function cleanUp(page: Page) {
  await retireAll(page);
  await op(page.request, "outbound.setAutoApprove", { tag: "fake.signin", enabled: false }, false);
  if (before) {
    await op(
      page.request,
      "customer.settings.update",
      {
        signup: before.customer.signup,
        ...(before.customer.emailConnectionId
          ? { emailConnectionId: before.customer.emailConnectionId }
          : {}),
      },
      false,
    );
    await op(
      page.request,
      "order.settings.update",
      {
        ...(before.order.currency ? { currency: before.order.currency } : {}),
        returnOrigins: before.order.returnOrigins,
      },
      false,
    );
    before = null;
  }
}

/** Whether this run is the phone project's: a finger draws there, not a mouse. */
const onPhone = () => test.info().project.name === "phone";

/** Ticks the box, types the name and (for a drawn document) draws on the pad, then agrees. */
async function agree(form: Locator, name: string, button: string | RegExp = /^Agree/) {
  await form.getByRole("checkbox").check();
  await form.getByLabel(/Your (full )?name/).fill(name);
  const pad = form.getByRole("img", { name: "Your signature" });
  if (await pad.count()) {
    const box = await pad.boundingBox();
    if (!box) throw new Error("no signature pad");
    const at = (i: number) => ({
      x: box.x + box.width * (0.1 + i * 0.06),
      y: box.y + box.height * (i === 0 ? 0.6 : i % 2 ? 0.3 : 0.7),
    });
    if (onPhone()) {
      // A finger: real touch events, which the browser turns into touch pointer events.
      const cdp = await form.page().context().newCDPSession(form.page());
      await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [at(0)] });
      for (let i = 1; i <= 12; i++) {
        await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [at(i)] });
      }
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      await cdp.detach();
    } else {
      const mouse = form.page().mouse;
      await mouse.move(at(0).x, at(0).y);
      await mouse.down();
      for (let i = 1; i <= 12; i++) await mouse.move(at(i).x, at(i).y);
      await mouse.up();
    }
    await expect(form.getByText("Signature drawn.")).toBeVisible();
  }
  await form.getByRole("button", { name: button }).click();
}

const bookings = (page: Page, classId: string) =>
  op<{ items: { values: Record<string, unknown> }[] }>(page.request, "record.list", {
    object: "bookings.booking",
    filter: { field: "class", op: "eq", value: classId },
  });

test("a member agrees on Before you go on, then books a class", async ({
  page,
  browser,
  baseURL,
}) => {
  test.setTimeout(240_000);
  await setUp(page, baseURL ?? "");
  try {
    const waiver = await publish(page, "waiver", ["booking"]);
    const klass = await oneOff(page, 3 * HOUR);
    const member = await newPerson(page, "agreefirst", 3);
    const context = await signIn(page, browser, baseURL ?? "", member.email);
    const screen = await context.newPage();
    await screen.goto(block("web-agreements-due", "BeforeYouGoOn"));
    const region = screen.getByRole("region", { name: "Before you go on" });
    await expect(region.getByRole("heading", { name: "Before you go on" })).toBeVisible();
    const form = region.getByRole("form", { name: waiver.title });
    // The document's words, readable and scrollable, before the box.
    await expect(form.getByRole("region", { name: `${waiver.title}: the document` })).toContainText(
      "Fixture text: not a real document.",
    );
    // Agreeing with nothing given says what is missing, field by field, and records nothing.
    await form.getByRole("button", { name: "Agree" }).click();
    await expect(form.getByText("Tick the box to agree")).toBeVisible();
    await expect(form.getByText("Type your name")).toBeVisible();
    await agree(form, "Fixture Member");
    await expect(region.getByRole("heading", { name: "You are all set" })).toBeVisible();
    await expect(region.getByRole("status")).toContainText(
      `A copy is on its way to ${member.email}`,
    );

    await screen.goto(block("bookings-timetable", "Timetable"));
    const timetable = screen.getByRole("region", { name: "Timetable" });
    await timetable.getByRole("button", { name: `Book ${klass.name}` }).click();
    await expect(timetable.getByRole("status")).toContainText(`Booked: ${klass.name}`);
    expect((await bookings(page, klass.id)).items.map((b) => b.values)).toEqual([
      expect.objectContaining({ state: "booked", person: member.id }),
    ]);
    await context.close();
  } finally {
    await cleanUp(page);
  }
});

test("a visitor pays for a class, agreeing to a drawn waiver and a health form on the way", {
  tag: "@phone",
}, async ({ page, browser, baseURL }) => {
  test.setTimeout(240_000);
  await setUp(page, baseURL ?? "");
  try {
    const waiver = await publish(page, "waiver", ["booking"], { how: "drawn" });
    const health = await publish(page, "health", ["booking"], {
      questions: [
        { key: "q1", text: "Fixture question one?", noteOnYes: true },
        { key: "q2", text: "Fixture question two?", noteOnYes: false },
      ],
    });
    const klass = await oneOff(page, 5 * HOUR, { dropInPrice: 22 });
    const origin = new URL(baseURL ?? "").origin;
    const visitor = await browser.newContext({
      baseURL,
      storageState: { cookies: [], origins: [] },
      viewport: page.viewportSize() ?? undefined,
      hasTouch: onPhone(),
      isMobile: onPhone(),
    });
    const screen = await visitor.newPage();
    await screen.goto(
      block("bookings-drop-in", "DropIn", { signedIn: false, returnUrl: `${origin}/blocks` }),
    );
    await screen
      .getByRole("region", { name: "Pay for a class" })
      .getByRole("button", { name: `Pay for ${klass.name}` })
      .click();
    const email = `${unique("visitor").toLowerCase()}@dropin.test`;
    await screen.getByLabel("Your email").fill(email);
    await screen.getByRole("button", { name: "Pay", exact: true }).click();

    // The host refused "Pay" with what must be agreed to first: each in turn, inline.
    const step = screen.getByRole("region", { name: "Before you pay" });
    await expect(step).toContainText("2 things to agree to before you pay");
    const first = step.getByRole("form", { name: waiver.title });
    const pad = first.getByRole("img", { name: "Your signature" });
    // At phone width the pad fits the screen: nothing to scroll sideways to sign.
    const box = await pad.boundingBox();
    const width = screen.viewportSize()?.width ?? 0;
    expect(box && box.x >= 0 && box.x + box.width <= width).toBe(true);
    // Agreeing without drawing is refused here first: the host would refuse it too.
    await first.getByRole("checkbox").check();
    await first.getByLabel("Your full name").fill("Fixture Visitor");
    await first.getByRole("button", { name: "Agree" }).click();
    await expect(first.getByText("Draw your signature in the box", { exact: true })).toBeVisible();
    await agree(first, "Fixture Visitor");

    const second = step.getByRole("form", { name: health.title });
    await second.getByRole("radio", { name: "No" }).first().check();
    await second.getByRole("radio", { name: "No" }).nth(1).check();
    await agree(second, "Fixture Visitor", "Agree and pay");
    await expect(screen.getByRole("heading", { name: /Fake payment page/i })).toBeVisible({
      timeout: 30_000,
    });
    // Nothing of what they gave is in the address, or kept in the browser.
    expect(screen.url()).not.toContain("Fixture");
    const stored = await screen.evaluate(() =>
      JSON.stringify({ ...window.localStorage, ...window.sessionStorage }),
    );
    expect(stored).not.toContain("Fixture Visitor");
    await screen.getByRole("button", { name: "Pay", exact: true }).click();
    await expect
      .poll(async () => (await bookings(page, klass.id)).items.map((b) => b.values.state), {
        timeout: 30_000,
      })
      .toEqual(["booked"]);
    // Recorded with the order, as the visitor's own, and theirs once the payment settled.
    const person = (await bookings(page, klass.id)).items[0]?.values.person as string;
    const standing = await op<{ acceptances: { documentId: string; by: string }[] }>(
      page.request,
      "agreement.person",
      { personId: person },
    );
    expect(
      standing.acceptances
        .filter((a) => a.by === "guest")
        .map((a) => a.documentId)
        .sort(),
    ).toEqual([waiver.id, health.id].sort());
    await visitor.close();
  } finally {
    await cleanUp(page);
  }
});

test("a parent agrees for their child on My agreements, and books the child a class", async ({
  page,
  browser,
  baseURL,
}) => {
  test.setTimeout(240_000);
  await setUp(page, baseURL ?? "");
  try {
    const consent = await publish(page, "guardian", ["booking"], { forWhom: "dependants" });
    const klass = await oneOff(page, 3 * HOUR);
    const parent = await newPerson(page, "parent");
    const child = await op<{ id: string }>(page.request, "person.create", {
      givenName: unique("Child"),
    });
    await givePass(page, child.id, 3);
    await op(page.request, "person.link.add", { guardianId: parent.id, dependantId: child.id });
    const context = await signIn(page, browser, baseURL ?? "", parent.email);
    const screen = await context.newPage();
    await screen.goto(block("web-my-agreements", "MyAgreements"));
    const mine = screen.getByRole("region", { name: "My agreements" });
    const childSection = mine.locator(`[data-person="${child.id}"]`);
    const row = childSection.locator(`[data-due="${consent.id}"]`);
    await row.getByRole("button", { name: "Read and agree" }).click();
    const form = row.getByRole("form", { name: consent.title });
    await expect(form).toContainText("for ");
    await expect(form.getByLabel("Your name (as their parent or guardian)")).toBeVisible();
    await agree(form, "Fixture Parent", "Agree");
    await expect(mine.getByRole("status")).toContainText("A copy is on its way to");
    const agreed = childSection.getByRole("list", { name: "Agreed" });
    await expect(agreed).toContainText(`${consent.title}, version 1`);
    await expect(agreed).toContainText("Agreed by you, as their parent or guardian");
    await expect(agreed.getByRole("link", { name: "Download PDF" })).toHaveAttribute(
      "href",
      /\/api\/v1\/agreements\/acceptances\/aga_[A-Za-z0-9_-]+\.pdf$/,
    );

    // Then the child's booking goes through: the parent picks them on the timetable.
    await screen.goto(block("bookings-timetable", "Timetable"));
    const timetable = screen.getByRole("region", { name: "Timetable" });
    await timetable.getByLabel("Booking for").selectOption(child.id);
    await timetable.getByRole("button", { name: `Book ${klass.name}` }).click();
    await expect(timetable.getByRole("status")).toContainText("Booked for");
    expect((await bookings(page, klass.id)).items.map((b) => b.values)).toEqual([
      expect.objectContaining({ state: "booked", person: child.id }),
    ]);
    await context.close();
  } finally {
    await cleanUp(page);
  }
});

test("a new version to agree to again is asked inline at the member's next booking", async ({
  page,
  browser,
  baseURL,
}) => {
  test.setTimeout(240_000);
  await setUp(page, baseURL ?? "");
  try {
    const waiver = await publish(page, "waiver", ["booking"]);
    const first = await oneOff(page, 3 * HOUR);
    const next = await oneOff(page, 4 * HOUR);
    const member = await newPerson(page, "again", 5);
    const context = await signIn(page, browser, baseURL ?? "", member.email);
    await op(context.request, "me.agreements.accept", {
      versionId: waiver.versionId,
      typedName: "Fixture Member",
    });
    const screen = await context.newPage();
    await screen.goto(block("bookings-timetable", "Timetable"));
    const timetable = screen.getByRole("region", { name: "Timetable" });
    await timetable.getByRole("button", { name: `Book ${first.name}` }).click();
    await expect(timetable.getByRole("status")).toContainText(`Booked: ${first.name}`);

    // Staff publish version 2, which everyone must agree to again.
    await agreeAgain(page, waiver);
    await timetable.getByRole("button", { name: `Book ${next.name}` }).click();
    const step = timetable.getByRole("region", { name: "Before you go on" });
    const form = step.getByRole("form", { name: waiver.title });
    await expect(form).toContainText("Version 2");
    await expect(form).toContainText("This has changed since you agreed");
    await agree(form, "Fixture Member", "Agree and book");
    await expect(timetable.getByText(`Booked: ${next.name}`)).toBeVisible();
    // Where the copy went is said with it.
    await expect(timetable.getByText(`A copy is on its way to ${member.email}`)).toBeVisible();
    // The first booking stays booked: agree again is never retroactive.
    expect((await bookings(page, first.id)).items.map((b) => b.values.state)).toEqual(["booked"]);
    expect((await bookings(page, next.id)).items.map((b) => b.values.state)).toEqual(["booked"]);
    await context.close();
  } finally {
    await cleanUp(page);
  }
});

test("a member marked a minor is told a parent or guardian buys their pass", async ({
  page,
  browser,
  baseURL,
}) => {
  test.setTimeout(240_000);
  await setUp(page, baseURL ?? "");
  try {
    await publish(page, "terms", ["membership"], { who: "payer" });
    const title = unique("Five classes ");
    await op(page.request, "record.create", {
      object: "memberships.passtype",
      values: { title, price: 100, uses: 5, validDays: 60, status: "on_sale" },
    });
    const teen = await newPerson(page, "teen");
    await op(page.request, "agreement.setMinor", { personId: teen.id, minor: true });
    const origin = new URL(baseURL ?? "").origin;
    const context = await signIn(page, browser, baseURL ?? "", teen.email);
    const screen = await context.newPage();
    await screen.goto(
      block("memberships-passes", "Passes", { returnUrl: `${origin}/blocks`, signedIn: true }),
    );
    const card = screen
      .getByRole("region", { name: "Passes" })
      .locator("[data-slot=card]", { hasText: title });
    await card.getByRole("button", { name: "Buy" }).click();
    await expect(card.getByRole("alert")).toHaveText(
      "A parent or guardian needs to buy this for you.",
    );
    await context.close();
  } finally {
    await cleanUp(page);
  }
});

test("a member buying a course agrees to its terms on the course page, then pays", async ({
  page,
  browser,
  baseURL,
}) => {
  test.setTimeout(240_000);
  await setUp(page, baseURL ?? "");
  await op(page.request, "extension.install", { id: "courses", shipped: true }, false);
  try {
    const terms = await publish(page, "terms", ["course"]);
    const title = unique("Fixture course ");
    const course = await op<{ id: string }>(page.request, "record.create", {
      object: "courses.course",
      values: { title, price: 30 },
    });
    await op(page.request, "record.publish", { object: "courses.course", id: course.id });
    const { slug } = (
      await op<{ values: { slug: string } }>(page.request, "record.get", {
        object: "courses.course",
        id: course.id,
      })
    ).values;
    const member = await newPerson(page, "student");
    const context = await signIn(page, browser, baseURL ?? "", member.email);
    const origin = new URL(baseURL ?? "").origin;
    const screen = await context.newPage();
    await screen.goto(
      block("courses-course", "CoursePage", {
        slug,
        returnUrl: `${origin}/blocks`,
        signedIn: true,
      }),
    );
    await screen.getByRole("button", { name: /^Buy/ }).click();

    // The host refused "Buy" with the course's terms: shown inline, recorded as they agree.
    const step = screen.getByRole("region", { name: "Before you go on" });
    await expect(step).toContainText("One thing to agree to first.");
    await agree(step.getByRole("form", { name: terms.title }), "Fixture Student", "Agree and buy");
    await expect(screen.getByRole("heading", { name: /Fake payment page/i })).toBeVisible({
      timeout: 30_000,
    });
    await screen.getByRole("button", { name: "Pay", exact: true }).click();
    await expect
      .poll(
        async () =>
          (
            await op<{ courses: { id: string }[] }>(context.request, "x.courses.myCourses", {})
          ).courses.map((c) => c.id),
        { timeout: 30_000 },
      )
      .toContain(course.id);
    const standing = await op<{ acceptances: { documentId: string; by: string }[] }>(
      page.request,
      "agreement.person",
      { personId: member.id },
    );
    expect(standing.acceptances.map((a) => [a.documentId, a.by])).toEqual([[terms.id, "self"]]);
    await context.close();
  } finally {
    await cleanUp(page);
  }
});
