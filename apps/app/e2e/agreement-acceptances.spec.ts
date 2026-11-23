// Agreements, step 2 (stage 44, ADRs 0642 and 0643), one test per journey: a member agrees to a
// document; a parent agrees for their child; staff record a paper form; and a health "yes" is
// read by staff with the health permission while a coach sees only the mark. Members call the
// host's HTTP surface as a client app would (the Agree block is step 5); the staff side is the
// Person page's Agreements tab. Documents attach to a fixture extension's agreement point (the
// packs declare theirs in step 3). All text is fixture text, not wording anyone should use.
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

const POINT = "agrfixture";
const FIXTURE = `import { defineExtension } from "@composable-os/sdk";
export default defineExtension({
  id: "agrfixture",
  version: "0.0.1",
  contractVersion: 1,
  label: "Agreement point (fixture)",
  permissions: { modules: [] },
  objects: {
    plan: {
      label: "Plan", plural: "Plans", titleField: "name",
      fields: { name: { type: "text", label: "Name" } },
      agreements: { point: "${POINT}", label: "Starting a fixture plan" },
    },
  },
});
`;

const body = (text: string) => ({
  blocks: [{ type: "paragraph", content: [{ type: "text", text }] }],
});

/** A published document attached to the fixture point. */
async function document(
  page: Page,
  kind: "waiver" | "guardian" | "health",
  extra: Record<string, unknown> = {},
) {
  await op(page.request, "extension.install", { id: "agrfixture", files: { "index.ts": FIXTURE } }, false);
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
  await op(page.request, "agreement.attach", { documentId: id, points: [POINT] });
  return { id, title, versionId: version.id };
}

/** A member signed in by the host's code, as a client app signs one in. */
async function signIn(page: Page, browser: Browser, baseURL: string, email: string) {
  const origin = new URL(baseURL).origin;
  const outbox = fakeAddress("agree");
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

async function newMember(page: Page, label: string) {
  const email = `${unique(label)}@members.test`.toLowerCase();
  const given = unique(label);
  const person = await op<{ id: string }>(page.request, "person.create", {
    givenName: given,
    emails: [{ email }],
  });
  return { id: person.id, email, given };
}

type Due = { people: { personId: string; due: { documentId: string; version: { id: string } }[] }[] };

async function agreementsTab(page: Page, personId: string) {
  await open(page, `/people/${personId}?tab=agreements`);
  return page.getByTestId("person-agreements");
}

test("a member agrees to a document, and staff see it on their Agreements tab", async ({
  page,
  browser,
  baseURL,
}) => {
  test.setTimeout(180_000);
  const doc = await document(page, "waiver");
  const member = await newMember(page, "agree");
  const client = await signIn(page, browser, baseURL ?? "", member.email);
  const due = await op<Due>(client.request, "me.agreements.due", {});
  const mine = due.people.find((p) => p.personId === member.id);
  expect(mine?.due.map((d) => d.documentId)).toContain(doc.id);
  await op(client.request, "me.agreements.accept", {
    versionId: doc.versionId,
    typedName: "Fixture Member",
  });
  const after = await op<Due>(client.request, "me.agreements.due", {});
  expect(after.people[0]?.due.map((d) => d.documentId)).not.toContain(doc.id);

  const tab = await agreementsTab(page, member.id);
  await expect(tab.getByTestId("agreement-documents")).toContainText(doc.title);
  const history = tab.getByTestId("agreement-history");
  await expect(history).toContainText(`${doc.title}, version 1`);
  await expect(history).toContainText("Agreed by themselves");
  await history.getByRole("button", { name: "Open" }).first().click();
  await expect(page.getByTestId("acceptance-detail")).toContainText("Fixture Member");
  await client.close();
});

test("a parent agrees for their child", async ({ page, browser, baseURL }) => {
  test.setTimeout(180_000);
  const doc = await document(page, "guardian", { forWhom: "dependants" });
  const parent = await newMember(page, "parent");
  const child = await op<{ id: string }>(page.request, "person.create", {
    givenName: unique("Child"),
  });
  await op(page.request, "person.link.add", { guardianId: parent.id, dependantId: child.id });
  const client = await signIn(page, browser, baseURL ?? "", parent.email);
  const due = await op<Due>(client.request, "me.agreements.due", {});
  expect(due.people.find((p) => p.personId === child.id)?.due.map((d) => d.documentId)).toContain(
    doc.id,
  );
  await op(client.request, "me.agreements.accept", {
    versionId: doc.versionId,
    forPersonId: child.id,
    typedName: "Fixture Parent",
  });
  const history = (await agreementsTab(page, child.id)).getByTestId("agreement-history");
  await expect(history).toContainText(`Agreed by ${parent.given}`);
  await expect(history).toContainText("for them");
  await expect(page.getByTestId("minor-state")).toContainText("A child of a family link");
  await client.close();
});

test("staff record a paper form, shown as recorded from paper", async ({ page }) => {
  test.setTimeout(120_000);
  const doc = await document(page, "waiver");
  const person = await op<{ id: string }>(page.request, "person.create", {
    givenName: unique("Paper"),
  });
  const tab = await agreementsTab(page, person.id);
  const row = tab.getByTestId("agreement-documents").locator("li", { hasText: doc.title });
  await expect(row).toContainText("Due");
  await row.getByRole("button", { name: "Record paper" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Name on the form").fill("Fixture Paper Name");
  await dialog.getByLabel("Signed by (for a child)").fill("Fixture parent");
  await dialog.getByRole("button", { name: "Record paper form" }).click();
  await expect(page.getByText("Paper form recorded").first()).toBeVisible();
  const history = tab.getByTestId("agreement-history");
  await expect(history).toContainText("Recorded from paper by");
  await expect(history).not.toContainText("Agreed by themselves");
  await expect(row).toContainText("Agreed");
});

test("staff with the health permission read a health yes; a coach sees only the mark", async ({
  page,
  browser,
  baseURL,
}) => {
  test.setTimeout(240_000);
  const note = `Fixture note ${unique()}`;
  const doc = await document(page, "health", {
    questions: [{ key: "heart", text: "Fixture question?", noteOnYes: true }],
  });
  const member = await newMember(page, "health");
  const client = await signIn(page, browser, baseURL ?? "", member.email);
  await op(client.request, "me.agreements.accept", {
    versionId: doc.versionId,
    typedName: "Fixture Health",
    answers: [{ key: "heart", yes: true, note }],
  });
  await client.close();

  // Staff with agreements:health (an admin): the mark, then the answers behind "Show answers".
  const tab = await agreementsTab(page, member.id);
  await expect(tab.getByTestId("person-health-note")).toBeVisible();
  await expect(tab).not.toContainText(note);
  await tab.getByTestId("agreement-history").getByRole("button", { name: "Open" }).first().click();
  await page.getByRole("button", { name: "Show answers" }).click();
  await expect(page.getByTestId("health-answers")).toContainText(note);
  await expect(page.getByTestId("health-answers")).toContainText("Yes");

  // A coach (an account with the coach role) on a class the member is booked on: the mark, and
  // nothing of the form.
  for (const id of ["programs", "bookings"]) {
    await op(page.request, "extension.install", { id, shipped: true }, false);
  }
  const classType = await op<{ id: string }>(page.request, "record.create", {
    object: "programs.classtype",
    values: { name: unique("Strength ") },
  });
  const startsAt = Date.now() + 30 * 60_000;
  const klass = await op<{ id: string }>(page.request, "record.create", {
    object: "bookings.class",
    values: {
      classType: classType.id,
      startsAt: new Date(startsAt).toISOString(),
      endsAt: new Date(startsAt + 3_600_000).toISOString(),
      timezone: "UTC",
      places: 6,
    },
  });
  await op(page.request, "x.bookings.bookFor", {
    classId: klass.id,
    personId: member.id,
    paidAtDesk: true,
  });
  const origin = new URL(baseURL ?? "").origin;
  const email = `${unique("coach")}@example.com`;
  const password = "coach-password-not-secret";
  const coach = await browser.newContext({ baseURL, storageState: { cookies: [], origins: [] } });
  const signUp = await coach.request.post("/api/auth/sign-up/email", {
    data: { name: "Fixture Coach", email, password },
    headers: { origin },
  });
  expect(signUp.ok(), await signUp.text()).toBe(true);
  const users = await op<{ items: { id: string }[] }>(page.request, "user.list", {
    filter: { field: "email", op: "eq", value: email },
  });
  await op(page.request, "user.setPackRole", {
    id: users.items[0]?.id as string,
    role: "bookings.coach",
  });
  const signedIn = await coach.request.post("/api/auth/sign-in/email", {
    data: { email, password },
    headers: { origin },
  });
  expect(signedIn.ok(), await signedIn.text()).toBe(true);
  const roster = await op<{ bookings: { person: { id: string } | null; healthNote: boolean | null }[] }>(
    coach.request,
    "x.bookings.roster",
    { classId: klass.id },
  );
  expect(roster.bookings.find((b) => b.person?.id === member.id)?.healthNote).toBe(true);
  expect(JSON.stringify(roster)).not.toContain(note);
  // The coach's own screen: the mark beside the name.
  const screen = await coach.newPage();
  await screen.goto(
    `/blocks?block=bookings-class-list&component=ClassList&props=${encodeURIComponent(JSON.stringify({ classId: klass.id }))}`,
  );
  const list = screen.getByRole("region", { name: "Class list" });
  await expect(list.getByTestId("health-note")).toBeVisible();
  await expect(list).not.toContainText(note);
  // And the answers themselves are refused to the coach.
  const refused = await op<{ code: string }>(
    coach.request,
    "agreement.person",
    { personId: member.id },
    false,
  );
  expect(refused.code).toBe("forbidden");
  await coach.close();
});
