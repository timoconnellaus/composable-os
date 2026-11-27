// Stage 31a steps 3, 6, 7 and 8 end to end, one test per journey (a visitor paying for a class
// on the drop-in block is the last): a member books a class from the
// timetable and cancels it in time, with the membership's use given back; staff book a walk-in
// into a class type only staff book, paid at the desk; and staff link a parent to a child on the
// parent's page, and the parent books the child a class with the child's own pass. The members'
// blocks are the pack's own web blocks, mounted where they sit (`/blocks`, development only),
// calling the host's HTTP surface from the browser as a client app would; the staff's (the desk,
// a coach's class list) are its screens in the admin, opened from its navigation (stage 47). In local dev Programs and Bookings are the org's own extensions
// (scripts/dev-setup.mjs). The Memberships pack (stage 32b) is built beside this step, so the
// member's pass is a fixture holder (`bkfixture.pass`, a runtime extension installed here, never
// the real pack's id, so the Memberships spec can share the database in either order); local
// dev's Bookings is a variant whose `paidBy` also names the fixture (dev-setup.mjs). Step 4
// replaces it with the real pack.
import {
  type Response as Answer,
  type APIRequestContext,
  type Browser,
  expect,
  type Page,
  test,
} from "@playwright/test";
import { daytimeZone, open, openScreen, staffAccount, unique, watchRefusals } from "./helpers.ts";
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
  for (const id of ["bookings"]) {
    await op(page.request, "extension.install", { id, shipped: true }, false);
  }
  await op(page.request, "extension.install", {
    id: "bkfixture",
    files: { "index.ts": FIXTURE_PASS },
  });
}

/** A one-off class `startsIn` ms from now, of a new class type, in `timezone`. */
async function oneOff(
  page: Page,
  startsIn: number,
  typeValues: Record<string, unknown> = {},
  timezone = "UTC",
) {
  const name = unique("Strength ");
  const classType = await op<{ id: string }>(page.request, "record.create", {
    object: "bookings.classtype",
    values: { name, ...typeValues },
  });
  const startsAt = new Date(Date.now() + startsIn).toISOString();
  const klass = await op<{ id: string }>(page.request, "record.create", {
    object: "bookings.class",
    values: {
      classType: classType.id,
      startsAt,
      endsAt: new Date(Date.now() + startsIn + HOUR).toISOString(),
      timezone,
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
  // Their pass: 3 classes in all (in the Memberships pack this is a membership or a pass). Not
  // "a week": a class three hours ahead late on a Sunday is in next week, and `left` reads this
  // week's, so a weekly pass made the test fail at that hour.
  const pass = await op<{ id: string }>(page.request, "record.create", {
    object: "bkfixture.pass",
    values: { name: unique("Pass "), person: person.id, uses: 3, per: "total" },
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

// Stage 47: the desk in the admin, opened from its navigation (no `/blocks`); and the class's list
// as a tab on the class's own page.
test("staff book a walk-in into a class only staff book, paid at the desk", async ({ page }) => {
  test.setTimeout(120_000);
  await setUp(page);
  const klass = await oneOff(page, 2 * HOUR, { staffOnly: true });
  await openScreen(page, "Bookings", "Front desk");
  // The day the class is on, where this browser is: the desk shows its own zone's days.
  const zone = await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone);
  const date = new Intl.DateTimeFormat("en-CA", { timeZone: zone }).format(
    new Date(klass.startsAt),
  );
  await page.getByLabel("Day").fill(date);
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
  // The class's page lists its list as a tab, for staff who may use it.
  await open(page, `/x/bookings.class/${klass.id}`);
  await page.getByRole("tab", { name: "Class list" }).click();
  await expect(page.getByRole("region", { name: "Class list" })).toContainText(given);
});

// Step 7 and stage 47: a coach (the coach role, nothing else) signs in to the admin and gets its
// small shell: today's class list and nothing else, no call refused. It ticks the member booked,
// and a second tick of the same name (another coach a moment later) is told who was first.
// Granted the desk, it has the desk too; the grant removed, the desk is gone and "not found".
test("a coach signs in to the admin, opens today's list and ticks who came", async ({
  page,
  browser,
  baseURL,
}) => {
  test.setTimeout(150_000);
  await setUp(page);
  // A zone where the class is today's whatever time this runs: the host's "today" is its zone's.
  const zone = daytimeZone();
  const klass = await oneOff(page, 30 * 60_000, {}, zone);
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
  const coach = await staffAccount(browser, page, baseURL ?? "", unique("Coach "), {
    packRole: "bookings.coach",
    timezoneId: zone,
  });
  try {
    const watch = watchRefusals(coach.page);
    await open(coach.page, "/");
    await expect(coach.page.locator('[data-shell="fixed-role"]')).toBeVisible();
    // Its whole shell: Bookings' class list, and the screens every staff account has of the packs
    // installed: Knowledge's (the global setup installs it), and Daily checklists' Today's
    // checklists when a spec has installed that (read from the host just before comparing).
    const screens = coach.page.locator('[data-testid^="screens-nav-"] a');
    const listed = await op<{ screens: { pack: string; nav?: unknown }[] }>(
      coach.page.request,
      "screens.mine",
      {},
    );
    const checklists = listed.screens.some((s) => s.pack === "dailychecks" && s.nav)
      ? ["Today's checklists"]
      : [];
    const theirs = (bookings: string[]) => [...bookings, ...checklists, "Procedures", "To read"];
    await expect(screens).toHaveText(theirs(["Class list"]));
    // No search, assistant, notifications or records in its shell.
    await expect(coach.page.getByTestId("open-palette")).toHaveCount(0);
    await expect(coach.page.getByTestId("open-assistant")).toHaveCount(0);
    await openScreen(coach.page, "Bookings", "Class list");
    await coach.page
      .getByRole("list", { name: "Today's classes" })
      .getByRole("button", { name: new RegExp(klass.name) })
      .click();
    const list = coach.page.getByRole("region", { name: "Class list" });
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
    // Every other page of the admin is "not found" for it.
    for (const path of [
      "/people",
      `/people/${person.id}`,
      "/settings",
      "/dashboards",
      "/s/bookings/desk",
    ]) {
      await coach.page.goto(path);
      await expect(coach.page.getByTestId("not-found"), path).toBeVisible();
    }
    // The class's own page (a notice's link) opens the record screen the host lists for it on a
    // class instead: its Class list, for that class (ADR 0708).
    await coach.page.goto(`/x/bookings.class/${klass.id}`);
    await expect(coach.page).toHaveURL(new RegExp(`/s/bookings/classList\\?record=${klass.id}$`));
    await expect(coach.page.getByRole("region", { name: "Class list" })).toBeVisible();
    await watch.settled();
    expect(watch.refused).toEqual([]);

    // Granted the desk: the desk is its screen too.
    await op(page.request, "user.setPermissions", {
      id: coach.id,
      permissions: ["bookings:desk"],
    });
    await open(coach.page, "/");
    await expect(screens).toHaveText(theirs(["Front desk", "Class list"]));
    await openScreen(coach.page, "Bookings", "Front desk");
    await expect(coach.page.getByRole("region", { name: "Front desk" })).toBeVisible();
    // The grant removed: gone on the next load, and its address is "not found".
    await op(page.request, "user.setPermissions", { id: coach.id, permissions: [] });
    await open(coach.page, "/");
    await expect(screens).toHaveText(theirs(["Class list"]));
    await coach.page.goto("/s/bookings/desk");
    await expect(coach.page.getByTestId("not-found")).toBeVisible();
  } finally {
    await coach.context.close();
  }
});

// Stage 47 (second review of PR #303): the pack-role guard on server functions, through TanStack
// Start's real path. An admin's browser calls two of `system.ts`'s server functions (the health
// read and the hello workflow); the coach's own browser sends the same requests, from its own page,
// and both are refused by the function middleware (`refusesFixedRole`, start.ts) before their
// handlers run: the health read checks no role, so only the guard can refuse it.
test("a coach's browser is refused a server function its role does not reach", async ({
  page,
  browser,
  baseURL,
}) => {
  await setUp(page);
  await open(page, "/status");
  type Call = {
    button: string;
    url: string;
    method: string;
    headers: Record<string, string>;
    body: string | null;
  };
  const calls: Call[] = [];
  // Each button's own call (Refresh also asks for the session, which a coach may).
  const theirs: [string, (r: Answer) => Promise<boolean>][] = [
    [
      "Refresh",
      async (r) => r.request().method() === "GET" && /schemaVersion/.test(await r.text()),
    ],
    ["Run workflow", async (r) => r.request().method() === "POST"],
  ];
  for (const [button, mine] of theirs) {
    const [response] = await Promise.all([
      page.waitForResponse(
        async (r) => new URL(r.url()).pathname.startsWith("/_serverFn/") && (await mine(r)),
      ),
      page.getByRole("button", { name: button }).click(),
    ]);
    expect(response.status(), button).toBe(200);
    const request = response.request();
    // What the page itself sets; the coach's browser adds its own cookie, origin and fetch site.
    const headers = Object.fromEntries(
      Object.entries(request.headers()).filter(
        ([name]) =>
          !/^(sec-|cookie$|origin$|referer$|user-agent$|host$|content-length$)/.test(name),
      ),
    );
    calls.push({
      button,
      url: request.url(),
      method: request.method(),
      headers,
      body: request.postData(),
    });
  }
  const replay = (from: Page, call: Call) =>
    from.evaluate(async ({ url, method, headers, body }) => {
      const r = await fetch(url, { method, headers, ...(body === null ? {} : { body }) });
      return await r.text();
    }, call);
  // The same replay from an account with no pack role reads the health: the request is sound.
  const plain = await staffAccount(browser, page, baseURL ?? "", unique("Plain "));
  const coach = await staffAccount(browser, page, baseURL ?? "", unique("Coach "), {
    packRole: "bookings.coach",
  });
  try {
    await open(plain.page, "/");
    expect(await replay(plain.page, calls[0] as Call)).toContain("schemaVersion");
    await open(coach.page, "/");
    await expect(coach.page.locator('[data-shell="fixed-role"]')).toBeVisible();
    for (const call of calls) {
      const answer = { text: await replay(coach.page, call) };
      // TanStack Start sends a thrown error as a serialised `Error` (with a 200): the guard's,
      // not the handler's own refusal, and none of the handler's output.
      expect(answer.text, call.button).toContain("$TSR/Error");
      expect(answer.text, call.button).toContain("This account's role does not reach this");
      expect(answer.text, call.button).not.toContain("schemaVersion");
      expect(answer.text, call.button).not.toContain("Only an admin starts the hello workflow");
    }
  } finally {
    await plain.context.close();
    await coach.context.close();
  }
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
    // In all, not a week: as above, a class booked late on a Sunday counts in next week.
    values: { name: unique("Kids pass "), person: child.id, uses: 3, per: "total" },
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
    // A cancel the parent starts for themselves is not carried over to the child's booking of
    // the same class: switching whom they book for asks again.
    await op(page.request, "record.create", {
      object: "bkfixture.pass",
      values: { name: unique("Parent pass "), person: parent.id, uses: 3, per: "total" },
    });
    await timetable.getByRole("button", { name: `Book ${klass.name}` }).click();
    await expect(timetable.getByRole("status")).toContainText(`Booked: ${klass.name}`);
    await timetable.getByRole("button", { name: `Cancel ${klass.name}` }).click();
    await expect(timetable.getByRole("button", { name: "Confirm cancel" })).toBeVisible();
    await timetable.getByLabel("Booking for").selectOption({ label: childName });
    await expect(timetable.getByRole("button", { name: `Cancel ${klass.name}` })).toBeVisible();
    await expect(timetable.getByRole("button", { name: "Confirm cancel" })).toHaveCount(0);
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
// Issue #258 (ADR 0600): coaches and the front desk are the same people. An admin ticks the desk
// permission for a coach on Settings → Users; the coach, signed in with their own account, books a
// walk-in on the desk screen into a class two days ahead (not today: the desk's reach, not the
// coach role's).
test("an admin gives a coach the desk, and the coach books a walk-in", async ({
  page,
  browser,
  baseURL,
}) => {
  test.setTimeout(120_000);
  await setUp(page);
  const klass = await oneOff(page, 48 * HOUR);
  const origin = new URL(baseURL ?? "").origin;
  const email = `${unique("deskcoach")}@example.com`;
  const password = "coach-password-not-secret";
  // The coach's own browser: signing up there leaves the admin's session alone.
  const coach = await browser.newContext({ baseURL, storageState: { cookies: [], origins: [] } });
  const signUp = await coach.request.post("/api/auth/sign-up/email", {
    data: { name: "Desk Coach", email, password },
    headers: { origin },
  });
  expect(signUp.ok(), await signUp.text()).toBe(true);
  const users = await op<{ items: { id: string }[] }>(page.request, "user.list", {
    filter: { field: "email", op: "eq", value: email },
  });
  const coachId = users.items[0]?.id as string;
  await op(page.request, "user.setPackRole", { id: coachId, role: "bookings.coach" });
  const signedIn = await coach.request.post("/api/auth/sign-in/email", {
    data: { email, password },
    headers: { origin },
  });
  expect(signedIn.ok(), await signedIn.text()).toBe(true);
  // Without the desk: the coach cannot book anyone.
  const refused = await op<{ code: string }>(
    coach.request,
    "x.bookings.bookFor",
    { classId: klass.id, newPerson: { givenName: "Not yet" }, paidAtDesk: true },
    false,
  );
  expect(refused.code).toBe("forbidden");

  // The admin's one tick, in plain words.
  await open(page, "/settings/users");
  const row = page.getByTestId("user-row").filter({ hasText: email });
  const desk = row.getByLabel(/Front desk: find people; book, cancel and move classes/);
  await expect(desk).not.toBeChecked();
  await desk.click();
  await expect(desk).toBeChecked();
  await expect
    .poll(async () => {
      const listed = await op<{ items: { permissions?: string[] }[] }>(page.request, "user.list", {
        filter: { field: "email", op: "eq", value: email },
      });
      return listed.items[0]?.permissions;
    })
    .toEqual(["bookings:desk"]);

  // The coach books a walk-in two days ahead on the desk, opened from the admin's navigation.
  const screen = await coach.newPage();
  await openScreen(screen, "Bookings", "Front desk");
  const zone = await screen.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone);
  await screen
    .getByLabel("Day")
    .fill(new Intl.DateTimeFormat("en-CA", { timeZone: zone }).format(new Date(klass.startsAt)));
  const front = screen.getByRole("region", { name: "Front desk" });
  await expect(front.getByText(klass.name).first()).toBeVisible();
  const form = front.getByRole("form", { name: "Book someone in" });
  await form.getByLabel("Class").selectOption(klass.id);
  await form.getByLabel(/Given name/).fill(unique("Walk"));
  await expect(form.getByLabel(/Paid at the desk/)).toBeChecked();
  await form.getByRole("button", { name: "Book walk-in" }).click();
  await expect(form.getByRole("status")).toHaveText("Booked in.");
  const bookings = await op<{ items: { values: Record<string, unknown> }[] }>(
    page.request,
    "record.list",
    { object: "bookings.booking", filter: { field: "class", op: "eq", value: klass.id } },
  );
  expect(bookings.items.map((b) => b.values)).toEqual([
    expect.objectContaining({ state: "booked", paidOtherwise: true, bookedBy: coachId }),
  ]);
  // Still a coach: another day's list is not theirs.
  const roster = await op<unknown>(
    coach.request,
    "x.bookings.roster",
    { classId: klass.id },
    false,
  );
  expect(JSON.stringify(roster)).toContain("not_found");
  await coach.close();
});

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
  const klass = await oneOff(page, 5 * HOUR, { dropInPrice: 22 });
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
