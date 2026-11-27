// My account (stage 48), one test per journey (step 8): a member sees what needs their attention
// and deals with it; a member changes their sign-in address with a code sent to the new one; a
// member deletes their account after reading what it will do; a parent sees a child's item and
// cancels the child's booking from the Bookings section; and (the review of #467) a member
// finishes paying an order from its attention item, and fills in a form they were asked to. The shell (`web-account`) is mounted where
// it sits (`/blocks`, development only) with the packs' sections the host lists, calling the
// host's HTTP surface from the browser as a client app would, signed in as a member by the host's
// code. Documents are fixture text, retired at the end of each test.
//
// It retires every live document and changes the customer settings, so it runs only against the
// database its own dev server made, as the agreement blocks' spec does (E2E_AGREEMENTS_REUSED=1
// allows a reused one). The settings are put back after each test.
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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

/** My account, as a client app mounts it: the shell with the app's sign-in. */
const account = (origin: string) =>
  `/blocks?block=web-account&component=MyAccount&props=${encodeURIComponent(
    JSON.stringify({ signIn: "customer", returnUrl: `${origin}/blocks` }),
  )}`;

const HOUR = 3_600_000;

test.skip(
  process.env.E2E_REUSE_SERVER === "1" && process.env.E2E_AGREEMENTS_REUSED !== "1",
  "retires documents and changes settings: not run against a database it did not make " +
    "(set E2E_AGREEMENTS_REUSED=1 to allow it)",
);

/** A pass a booking spends: a fixture holder, as the agreement blocks' spec uses. */
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

let before: { signup: string; emailConnectionId: string | null } | null = null;
/** This test's fake mailbox, which every member's mail goes to, read by address. */
let outbox = "";

async function setUp(page: Page) {
  before = await op(page.request, "customer.settings.get", {});
  for (const id of ["bookings", "memberships"]) {
    await op(page.request, "extension.install", { id, shipped: true }, false);
  }
  await op(page.request, "extension.install", {
    id: "bkfixture",
    files: { "index.ts": FIXTURE_PASS },
  });
  await retireAll(page);
  outbox = fakeAddress("myaccount");
  // The host's sign-in mail: the codes and the notice of a changed address go out at once.
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

async function cleanUp(page: Page) {
  await retireAll(page);
  if (before) {
    await op(
      page.request,
      "customer.settings.update",
      {
        signup: before.signup,
        ...(before.emailConnectionId ? { emailConnectionId: before.emailConnectionId } : {}),
      },
      false,
    );
    before = null;
  }
}

/** A document published and attached to `points`. */
async function publish(page: Page, kind: string, points: string[], extra = {}) {
  const title = `${kind} ${unique("doc")}`;
  const { id } = await op<{ id: string }>(page.request, "agreement.create", { title, kind });
  const saved = await op<{ hash: string; rev: number }>(page.request, "agreement.draft.save", {
    id,
    body: {
      blocks: [{ type: "paragraph", content: [{ type: "text", text: "Fixture text: not real." }] }],
    },
    tickLabel: "I have read the fixture",
    ...extra,
  });
  await op(page.request, "agreement.publish", {
    documentId: id,
    draftHash: saved.hash,
    draftRev: saved.rev,
    number: 1,
    change: "small",
  });
  await op(page.request, "agreement.attach", { documentId: id, points });
  return { id, title };
}

/** A one-off class `startsIn` ms from now. */
async function oneOff(page: Page, startsIn: number) {
  const name = unique("Strength ");
  const classType = await op<{ id: string }>(page.request, "record.create", {
    object: "bookings.classtype",
    values: { name },
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

/** The newest six-digit code mailed to `email`. */
async function codeFor(page: Page, email: string, subject?: RegExp): Promise<string> {
  let code: string | undefined;
  await expect
    .poll(
      async () => {
        const mail = (await sentMail(page.request, outbox)).filter(
          (m) => m.to.includes(email) && (!subject || subject.test(m.subject)),
        );
        code = /\b(\d{6})\b/.exec(mail.at(-1)?.text ?? "")?.[1];
        return code;
      },
      { timeout: 30_000 },
    )
    .toMatch(/^\d{6}$/);
  return code ?? "";
}

/** A member signed in by the host's code, in a browser context of their own. */
async function signIn(page: Page, browser: Browser, baseURL: string, email: string) {
  const origin = new URL(baseURL).origin;
  const member = await browser.newContext({ baseURL, storageState: { cookies: [], origins: [] } });
  const asked = await member.request.post("/api/customer-auth/email-otp/send-verification-otp", {
    data: { email, type: "sign-in" },
    headers: { origin },
  });
  expect(asked.status(), await asked.text()).toBe(200);
  const code = await codeFor(page, email);
  const signedIn = await member.request.post("/api/customer-auth/sign-in/email-otp", {
    data: { email, otp: code },
    headers: { origin },
  });
  expect(signedIn.status(), await signedIn.text()).toBe(200);
  return member;
}

test("a member sees what needs their attention and deals with it", async ({
  page,
  browser,
  baseURL,
}) => {
  test.setTimeout(240_000);
  await setUp(page);
  try {
    const origin = new URL(baseURL ?? "").origin;
    const waiver = await publish(page, "waiver", ["booking"]);
    const member = await newPerson(page, "attention");
    const context = await signIn(page, browser, baseURL ?? "", member.email);
    const screen = await context.newPage();
    await screen.goto(account(origin));
    const attention = screen.getByTestId("needs-attention");
    const item = attention.locator("li[data-kind=agree]", { hasText: waiver.title });
    await expect(item).toContainText(`Agree to ${waiver.title}`);
    // Their own: no name on it.
    await expect(item).toHaveAttribute("data-person", "self");
    // It leads to the Agreements section, where they agree.
    await item.getByRole("button", { name: "Read and agree" }).click();
    const agreements = screen.locator("section[data-section=agreements]");
    await expect(agreements).toBeInViewport();
    const row = agreements.locator(`[data-due="${waiver.id}"]`);
    await row.getByRole("button", { name: "Read and agree" }).click();
    const form = row.getByRole("form", { name: waiver.title });
    await form.getByRole("checkbox").check();
    await form.getByLabel(/Your (full )?name/).fill("Fixture Member");
    await form.getByRole("button", { name: /^Agree/ }).click();
    await expect(agreements.getByRole("status")).toContainText("A copy is on its way to");
    // The host says it is dealt with: the item goes.
    await screen.reload();
    await expect(screen.getByTestId("needs-attention")).toBeVisible();
    await expect(
      screen.getByTestId("needs-attention").locator("li[data-kind=agree]", {
        hasText: waiver.title,
      }),
    ).toHaveCount(0);
    await context.close();
  } finally {
    await cleanUp(page);
  }
});

test("a member changes their sign-in address with a code sent to the new one", async ({
  page,
  browser,
  baseURL,
}) => {
  test.setTimeout(240_000);
  await setUp(page);
  try {
    const origin = new URL(baseURL ?? "").origin;
    const member = await newPerson(page, "moving");
    const context = await signIn(page, browser, baseURL ?? "", member.email);
    const screen = await context.newPage();
    await screen.goto(account(origin));
    const details = screen.locator("section[data-section=details]");
    await expect(details.getByTestId("sign-in-email")).toHaveText(member.email);
    await details.getByRole("button", { name: "Change sign-in address" }).click();
    const ask = details.getByRole("form", { name: "Change sign-in address" });
    const moved = `${unique("moved")}@members.test`.toLowerCase();
    await ask.getByLabel("New sign-in address").fill(moved);
    await ask.getByRole("button", { name: "Email me a code" }).click();
    const enter = details.getByRole("form", { name: "Enter the code" });
    // Nothing changed yet: they still sign in with the old address.
    await expect(enter).toContainText(`you still sign in with ${member.email}`);
    // The code went to the new address, never the old one.
    const code = await codeFor(page, moved, /new/i);
    await enter.getByLabel("The code we emailed to the new address").fill(code);
    await enter.getByRole("button", { name: "Change my sign-in address" }).click();
    await expect(details.getByTestId("sign-in-email-changed")).toContainText(
      `You now sign in with ${moved}`,
    );
    await expect(details.getByTestId("sign-in-email")).toHaveText(moved);
    const me = await op<{ signInEmail: string; primaryEmail: string }>(
      context.request,
      "me.get",
      {},
    );
    expect(me).toMatchObject({ signInEmail: moved, primaryEmail: moved });
    // The old address is told, naming the new one only in part.
    await expect
      .poll(
        async () =>
          (await sentMail(page.request, outbox)).filter(
            (m) => m.to.includes(member.email) && /changed/i.test(m.subject),
          ).length,
        { timeout: 30_000 },
      )
      .toBe(1);
    const notice = (await sentMail(page.request, outbox)).find(
      (m) => m.to.includes(member.email) && /changed/i.test(m.subject),
    );
    expect(notice?.text ?? "").not.toContain(moved);
    await context.close();
  } finally {
    await cleanUp(page);
  }
});

test("a member deletes their account after reading what it will do", async ({
  page,
  browser,
  baseURL,
}) => {
  test.setTimeout(240_000);
  await setUp(page);
  try {
    const origin = new URL(baseURL ?? "").origin;
    const klass = await oneOff(page, 30 * HOUR);
    const member = await newPerson(page, "leaving", 2);
    const context = await signIn(page, browser, baseURL ?? "", member.email);
    await op(context.request, "x.bookings.book", { classId: klass.id });
    const screen = await context.newPage();
    await screen.goto(account(origin));
    const section = screen.locator("section[data-section=delete]");
    await section.getByRole("button", { name: "See what deleting my account does" }).click();
    const form = section.getByRole("form", { name: "Delete my account" });
    // The host's preview, all of it, before anything can be confirmed.
    const what = form.getByRole("region", { name: "What deleting your account does" });
    await expect(what).toContainText("You pay no subscription: nothing is ended.");
    await expect(what.getByRole("list", { name: "Left for the business" })).toContainText(": 1");
    await expect(what).toContainText("You are signed out everywhere at once");
    // Deliberate: nothing to press until the word is typed.
    const remove = form.getByRole("button", { name: "Delete my account" });
    await expect(remove).toBeDisabled();
    await form.getByLabel("To confirm, type DELETE").fill("delete");
    await remove.click();
    await expect(section.getByRole("status")).toContainText("Your account is deleted");
    // The account is disabled and signed out; the erase request is staff's.
    const accounts = await op<{
      items: { status: string; sessions: number; eraseRequest: { dueAt: string } | null }[];
    }>(page.request, "customer.list", { personId: member.id, limit: 1 });
    expect(accounts.items[0]).toMatchObject({ status: "disabled", sessions: 0 });
    expect(accounts.items[0]?.eraseRequest?.dueAt).toBeTruthy();
    const after = await context.request.post("/api/v1/op/me.get", { data: {} });
    // Signed out: the host no longer answers this browser as the member.
    expect(after.ok()).toBe(false);
    // The booking stays for staff to decide at erase.
    const kept = await op<{ items: { values: Record<string, unknown> }[] }>(
      page.request,
      "record.list",
      { object: "bookings.booking", filter: { field: "class", op: "eq", value: klass.id } },
    );
    expect(kept.items.map((b) => b.values)).toEqual([
      expect.objectContaining({ state: "booked", person: member.id }),
    ]);
    await context.close();
  } finally {
    await cleanUp(page);
  }
});

test("a parent sees their child's item and cancels the child's booking", async ({
  page,
  browser,
  baseURL,
}) => {
  test.setTimeout(240_000);
  await setUp(page);
  try {
    const origin = new URL(baseURL ?? "").origin;
    const consent = await publish(page, "guardian", ["booking"], { forWhom: "dependants" });
    const klass = await oneOff(page, 3 * HOUR);
    const parent = await newPerson(page, "parent");
    const childName = unique("Child");
    const child = await op<{ id: string }>(page.request, "person.create", {
      givenName: childName,
    });
    await givePass(page, child.id, 3);
    await op(page.request, "person.link.add", { guardianId: parent.id, dependantId: child.id });
    const context = await signIn(page, browser, baseURL ?? "", parent.email);
    const screen = await context.newPage();
    await screen.goto(account(origin));
    // The child's document is the parent's to agree to, and says whose it is.
    const item = screen
      .getByTestId("needs-attention")
      .locator(`li[data-person="${child.id}"]`, { hasText: consent.title });
    await expect(item).toContainText(`For ${childName}`);
    await item.getByRole("button", { name: "Read and agree" }).click();
    const agreements = screen.locator("section[data-section=agreements]");
    const row = agreements
      .locator(`[data-person="${child.id}"]`)
      .locator(`[data-due="${consent.id}"]`);
    await row.getByRole("button", { name: "Read and agree" }).click();
    const form = row.getByRole("form", { name: consent.title });
    await form.getByRole("checkbox").check();
    await form.getByLabel(/Your (full )?name/).fill("Fixture Parent");
    await form.getByRole("button", { name: /^Agree/ }).click();
    await expect(agreements.getByRole("status")).toContainText("A copy is on its way to");

    // The parent books the child; the Bookings section appears for the child's booking.
    await op(context.request, "x.bookings.book", { classId: klass.id, forPersonId: child.id });
    await screen.reload();
    const bookings = screen.locator("section[data-section='bookings.bookings']");
    await expect(bookings).toBeVisible({ timeout: 30_000 });
    // The family the section offers is the host's (me.family): the child, by name.
    await bookings.getByLabel("Booking for").selectOption(child.id);
    await bookings.getByRole("button", { name: `Cancel ${klass.name}` }).click();
    await bookings.getByRole("button", { name: "Confirm cancel" }).click();
    await expect(bookings.getByRole("status")).toContainText(klass.name);
    const after = await op<{ items: { values: Record<string, unknown> }[] }>(
      page.request,
      "record.list",
      { object: "bookings.booking", filter: { field: "class", op: "eq", value: klass.id } },
    );
    expect(after.items.map((b) => b.values)).toEqual([
      expect.objectContaining({ person: child.id, state: expect.stringMatching(/cancelled/) }),
    ]);
    await context.close();
  } finally {
    await cleanUp(page);
  }
});

/** Card payments on, through the fake provider, coming back to this host (as buyer-sign-in.spec). */
async function paymentsOn(page: Page, origin: string) {
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

// The review of #467, F5: money owed on an order leads somewhere the member can pay it. One order
// start: they are limited per account.
test("a member finishes paying an order from what needs their attention", async ({
  page,
  browser,
  baseURL,
}) => {
  test.setTimeout(240_000);
  await setUp(page);
  try {
    const origin = new URL(baseURL ?? "").origin;
    await op(page.request, "extension.install", { id: "ticketing", shipped: true }, false);
    await paymentsOn(page, origin);
    const event = await op<{ id: string }>(page.request, "record.create", {
      object: "ticketing.event",
      values: { name: unique("Open night "), places: 20 },
    });
    await op(page.request, "record.update", {
      object: "ticketing.event",
      id: event.id,
      values: { status: "on_sale" },
    });
    const entry = await op<{ id: string }>(page.request, "record.create", {
      object: "ticketing.tickettype",
      values: { event: event.id, name: "Entry", price: 300 },
    });
    const member = await newPerson(page, "paying");
    const context = await signIn(page, browser, baseURL ?? "", member.email);
    // They started buying a ticket and did not pay: the place is held for them.
    const order = await op<{ id: string }>(context.request, "x.ticketing.orderStart", {
      lines: [{ ticketTypeId: entry.id, quantity: 1 }],
    });

    const screen = await context.newPage();
    await screen.goto(account(origin));
    const item = screen.getByTestId("needs-attention").locator("li[data-kind=finish_paying]");
    await expect(item).toBeVisible();
    // It opens at the order itself, in Orders, where it is paid.
    await item.getByRole("button", { name: "Finish paying" }).click();
    const row = screen.locator(`#account-order-${order.id}`);
    await expect(row).toBeInViewport();
    await row.getByRole("button", { name: "Pay now" }).click();
    // The provider's own page for this order (the fake one), which the host opened for it.
    await expect(screen.getByRole("heading", { name: /Fake payment page/i })).toBeVisible();
    await screen.getByRole("button", { name: "Pay", exact: true }).click();
    // Paid: once the provider's confirmation is in, the item goes.
    await expect
      .poll(
        async () => {
          await screen.goto(account(origin));
          await expect(screen.getByTestId("needs-attention")).toBeVisible();
          await expect(screen.getByTestId("needs-attention").getByRole("heading")).toBeVisible();
          return screen.locator("li[data-kind=finish_paying]").count();
        },
        { timeout: 60_000 },
      )
      .toBe(0);
    await context.close();
  } finally {
    await cleanUp(page);
  }
});

const APP = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * A personal link for `personId` to the form `formId`, as routine mail makes one when the email
 * that carries it goes (as forms.spec makes one, ADR 0723).
 */
function personalLink(personId: string, formId: string) {
  const token = randomBytes(32).toString("base64url");
  const id = `ilk_${randomBytes(13).toString("hex").toUpperCase().slice(0, 26)}`;
  const now = new Date();
  const later = new Date(now.getTime() + 7 * 86_400_000);
  const sql =
    `INSERT INTO core_intake_link (id, person_id, form_object, form_id, record_object, record_id, made_for, expires_at, created_at) VALUES ('${id}', '${personId}', 'forms.form', '${formId}', 'person', '${personId}', 'e2e:${id}', '${later.toISOString()}', '${now.toISOString()}');` +
    `INSERT INTO core_intake_link_token (token_hash, link_id, sent_to, created_at) VALUES ('${createHash("sha256").update(token).digest("hex")}', '${id}', '${personId}', '${now.toISOString()}');`;
  execFileSync("pnpm", ["exec", "wrangler", "d1", "execute", "DB", "--local", "--command", sql], {
    cwd: APP,
    stdio: "pipe",
    env: { ...process.env, CI: "true" },
  });
  return id;
}

// form_to_fill (ADR 0728): a client app with Forms passes the shell `onFillForm(linkId)`, opening
// the Forms block's `LinkedFormBlock` with that id; the development page does the same.
test("a member fills in a form they were asked to, from what needs their attention", async ({
  page,
  browser,
  baseURL,
}) => {
  test.setTimeout(240_000);
  await setUp(page);
  try {
    const origin = new URL(baseURL ?? "").origin;
    await op(page.request, "extension.install", { id: "forms", shipped: true }, false);
    const title = unique("How was the class ");
    const form = await op<{ id: string }>(page.request, "record.create", {
      object: "forms.form",
      values: {
        title,
        receipt: false,
        answeredBy: "links",
        kind: "feedback",
        questions: {
          items: [
            { kind: "text", key: "why", label: "Anything to tell us?", long: true, required: true },
          ],
        },
      },
    });
    await op(page.request, "record.update", {
      object: "forms.form",
      id: form.id,
      values: { status: "open" },
    });
    await op(page.request, "record.publish", { object: "forms.form", id: form.id });
    const member = await newPerson(page, "asked");
    personalLink(member.id, form.id);
    const context = await signIn(page, browser, baseURL ?? "", member.email);
    const screen = await context.newPage();
    await screen.goto(account(origin));
    const item = screen
      .getByTestId("needs-attention")
      .locator("li[data-kind=form_to_fill]", { hasText: title });
    await expect(item).toContainText(`Fill in ${title}`);
    await item.getByRole("button", { name: "Fill it in" }).click();
    // The Forms block, opened by the link's id: the member's own form.
    await expect(screen).toHaveURL(/component=LinkedFormBlock/);
    await expect(screen.getByRole("heading", { name: title })).toBeVisible();
    await screen.getByLabel("Anything to tell us?").fill("Great class");
    await screen.getByRole("button", { name: "Send" }).click();
    await expect(screen.getByRole("status")).toBeVisible();
    // Answered: the item goes.
    await screen.goto(account(origin));
    await expect(screen.getByTestId("needs-attention").getByRole("heading")).toBeVisible();
    await expect(screen.locator("li[data-kind=form_to_fill]", { hasText: title })).toHaveCount(0);
    await context.close();
  } finally {
    await cleanUp(page);
  }
});
