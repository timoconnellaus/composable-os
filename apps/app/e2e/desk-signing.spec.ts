// Signing at the desk (stage 44 step 6, ADR 0649) on the enrolled device (stage 51 step 1, ADR
// 0780), one test per journey:
//   - an admin enrols a tablet: Settings, Devices gives a code, typed at the desk origin's /enrol
//     on the tablet; the tablet shows Enter code; the admin revokes it and the tablet is refused;
//   - a member signs at the desk on a tablet-width page: staff start a session on the Person page,
//     the tablet types its code, the member agrees, and the Person's history says how it was made.
// The desk origin is its own hostname (desk.localhost locally), with its own cookies; the staff
// origin serves none of its pages, and it serves none of the admin's. All text is fixture text.
import { type APIRequestContext, type Browser, expect, type Page, test } from "@playwright/test";
import { open, unique } from "./helpers.ts";

const PORT = Number(process.env.E2E_PORT ?? 5179);
const DESK = `http://desk.localhost:${PORT}`;
const TABLET = { width: 820, height: 1180 };

test.skip(
  process.env.E2E_REUSE_SERVER === "1" && process.env.E2E_AGREEMENTS_REUSED !== "1",
  "retires documents: not run against a database it did not make " +
    "(set E2E_AGREEMENTS_REUSED=1 to allow it)",
);

async function op<T>(request: APIRequestContext, name: string, input: unknown): Promise<T> {
  const response = await request.post(`/api/v1/op/${name}`, {
    data: input,
    headers: { "idempotency-key": crypto.randomUUID() },
  });
  const body = (await response.json()) as { data?: T; error?: unknown };
  expect(response.status(), `${name}: ${JSON.stringify(body).slice(0, 300)}`).toBe(200);
  return body.data as T;
}

/** A browser on the desk origin, at tablet width, with no sign-in of anyone's. */
async function tablet(browser: Browser) {
  const context = await browser.newContext({
    baseURL: DESK,
    viewport: TABLET,
    hasTouch: true,
    storageState: { cookies: [], origins: [] },
  });
  return { context, page: await context.newPage() };
}

async function enrolOn(page: Page, code: string, name: string) {
  await page.goto("/enrol");
  await page.getByLabel("Enrolment code").fill(code);
  await page.getByRole("button", { name: "Enrol" }).click();
  await expect(
    page.getByRole("heading", { name: `This device is enrolled as ${name}` }),
  ).toBeVisible();
}

const POINT = "deskfixture";
const FIXTURE = `import { defineExtension } from "@composable-os/sdk";
export default defineExtension({
  id: "deskfixture",
  version: "0.0.1",
  contractVersion: 1,
  label: "Desk agreement point (fixture)",
  permissions: { modules: [] },
  objects: {
    plan: {
      label: "Plan", plural: "Plans", titleField: "name",
      fields: {
        name: { type: "text", label: "Name" },
        person: { type: "relation", label: "Person", to: "person" },
        state: { type: "select", label: "State", options: [
          { value: "open", label: "Open" }, { value: "done", label: "Done" },
        ] },
      },
      states: { field: "state", initial: "open", moves: [{ from: "open", to: "done", by: ["staff"] }] },
      agreements: { point: "${POINT}", label: "Starting a fixture plan", enter: ["open"], person: "person" },
    },
  },
});
`;

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

test("an admin enrols a tablet at the desk origin, sees it in Settings, Devices, and revokes it", async ({
  page,
  browser,
}) => {
  const name = unique("Front desk tablet ");
  await open(page, "/settings/devices");
  await page.getByRole("button", { name: "Enrol a device" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Name").fill(name);
  await dialog.getByRole("button", { name: "Enrol" }).click();
  const code = (await dialog.getByTestId("enrol-code").textContent())?.trim() ?? "";
  expect(code).toMatch(/^[A-Z0-9]{10}$/);
  await dialog.getByRole("button", { name: "Done" }).click();

  const desk = await tablet(browser);
  await enrolOn(desk.page, code, name);
  // The credential is the desk origin's own cookie, HttpOnly: the page never sees it.
  const cookies = await desk.context.cookies(DESK);
  const device = cookies.find((c) => c.name === "__Host-cos-desk-device");
  expect(device).toMatchObject({ httpOnly: true, secure: true, sameSite: "Strict" });
  expect(await desk.page.evaluate(() => document.cookie)).toBe("");
  await desk.page.goto("/desk");
  await expect(desk.page.getByRole("heading", { name: "Enter code" })).toBeVisible();

  // The admin sees it enrolled, and revokes it.
  await page.reload();
  const card = page
    .getByTestId("devices")
    .locator("[data-testid^='device-']")
    .filter({ hasText: name });
  await expect(card.getByText("Enrolled", { exact: true })).toBeVisible();
  await card.getByRole("button", { name: "Revoke" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Revoke" }).click();
  await expect(card.getByText("Revoked", { exact: true })).toBeVisible();
  await desk.page.reload();
  await expect(
    desk.page.getByRole("heading", { name: "This device is not enrolled" }),
  ).toBeVisible();

  // Each origin serves only its own pages.
  expect((await desk.page.request.get("/people")).status()).toBe(404);
  expect((await page.request.get("/desk")).status()).toBe(404);
  await desk.context.close();
});

test("a member signs at the desk on a tablet-width page", async ({ page, browser }) => {
  await retireAll(page);
  await op(page.request, "extension.install", {
    id: "deskfixture",
    files: { "index.ts": FIXTURE },
  });
  const title = `Waiver ${unique("doc")}`;
  const { id: documentId } = await op<{ id: string }>(page.request, "agreement.create", {
    title,
    kind: "waiver",
  });
  const saved = await op<{ hash: string; rev: number }>(page.request, "agreement.draft.save", {
    id: documentId,
    body: { blocks: [{ type: "paragraph", content: [{ type: "text", text: "Fixture text." }] }] },
    tickLabel: "I have read the fixture",
  });
  await op(page.request, "agreement.publish", {
    documentId,
    draftHash: saved.hash,
    draftRev: saved.rev,
    number: 1,
    change: "small",
  });
  await op(page.request, "agreement.attach", { documentId, points: [POINT] });
  const member = await op<{ id: string }>(page.request, "person.create", {
    givenName: "Robin",
    familyName: unique("Desk"),
    emails: [{ email: `${unique("robin")}@example.com` }],
  });

  // A tablet enrolled by an admin (as in the journey above, here through the host).
  const deviceName = unique("Desk iPad ");
  const enrolled = await op<{ code: string }>(page.request, "device.enrol", {
    name: deviceName,
    use: "signing",
  });
  const desk = await tablet(browser);
  await enrolOn(desk.page, enrolled.code, deviceName);

  // Staff start the session on the Person page.
  await open(page, `/people/${member.id}?tab=agreements`);
  await page.getByRole("button", { name: "Sign at the desk" }).click();
  const panel = page.getByTestId("sign-at-desk");
  await expect(panel).toContainText(title);
  await panel.getByLabel(new RegExp(deviceName)).check();
  await panel.getByRole("button", { name: "Start" }).click();
  const code = (await page.getByTestId("desk-code").textContent())?.trim() ?? "";
  expect(code).toMatch(/^[A-Z0-9]{8}$/);

  // The member, on the tablet.
  await desk.page.goto("/desk");
  await desk.page.getByRole("textbox", { name: "Code" }).fill(code);
  await desk.page.getByRole("button", { name: "Continue" }).click();
  await expect(desk.page.getByRole("heading", { name: "Documents for Robin" })).toBeVisible();
  await expect(desk.page.getByText(/a copy goes to r•••@e•••\.com/)).toBeVisible();
  const form = desk.page.getByRole("form", { name: title });
  await form.getByRole("checkbox").check();
  await form.getByLabel(/Your (full )?name/).fill("Robin Fixture");
  await form.getByRole("button", { name: "Agree" }).click();
  await expect(
    desk.page.getByRole("heading", { name: "All done: please hand the device back" }),
  ).toBeVisible();
  // Nothing of what was typed stays on the tablet.
  expect(
    await desk.page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage })),
  ).not.toContain("Robin Fixture");
  expect(desk.page.url()).not.toContain("Robin");

  // The staff screen says it finished; the history says how it was made.
  await expect(page.getByTestId("desk-state")).toContainText("Done: they finished on the tablet");
  await page.reload();
  await expect(page.getByTestId("agreement-history")).toContainText(
    `Agreed at the desk on the device enrolled as ${deviceName}`,
  );
  await retireAll(page);
  await desk.context.close();
});
