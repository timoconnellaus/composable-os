// Rostering, step 4b (stage 45, ADR 0650): checklists, one test per journey. A rosterer writes a
// checklist in Settings → Checklists and picks it on a duty; the person on a shift of that duty
// ticks it off on "my shifts" and marks it done, and the rosterer sees it done; a colleague sees
// that the shift has a checklist and never how it went. Each person is in their own browser; the
// Rostering screens are mounted where they sit (`/blocks`, development only), as step 7's are.
// Every name here is invented.
//
// Clocks: a checklist is ticked from its shift's start until two hours after its end, by the
// host's clock, so the shift starts a few minutes before the test runs and every screen is opened
// on that shift's own local date: a run across midnight in the business's zone sees the same day.
//
// It installs Rostering and writes checklists, so it runs only against the database its own dev
// server made: never a server it reuses (E2E_REUSE_SERVER=1) unless E2E_ROSTERING_REUSED=1 says
// that database may be changed.
import {
  type APIRequestContext,
  type Browser,
  type BrowserContext,
  expect,
  type Page,
  test,
} from "@playwright/test";
import { expectNoHorizontalScroll, open, unique } from "./helpers.ts";

test.skip(
  process.env.E2E_REUSE_SERVER === "1" && process.env.E2E_ROSTERING_REUSED !== "1",
  "installs Rostering and writes checklists: not run against a database it did not make (set " +
    "E2E_ROSTERING_REUSED=1 to allow it)",
);

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const SHIFT = "rostering.shift";
const DUTY = "rostering.duty";

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
  return (ok ? body.data : { status: response.status(), ...body.error }) as T;
}

const block = (name: string, component: string, props: Record<string, unknown> = {}) =>
  `/blocks?block=${name}&component=${component}&props=${encodeURIComponent(JSON.stringify(props))}`;

/** Opens a block where it sits and waits until it has drawn (the page has no app shell). */
async function mount(page: Page, path: string): Promise<void> {
  await page.goto(path);
  await expect(page.locator("main[data-block] > *").first()).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0, { timeout: 30_000 });
}

let zone = "UTC";
const localDate = (at: number) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: zone }).format(new Date(at));

async function install(page: Page): Promise<void> {
  const installed = await op<{ status?: number; code?: string }>(
    page.request,
    "extension.install",
    { id: "rostering", shipped: true },
    false,
  );
  if (installed?.status && installed.status !== 200 && installed.code !== "conflict") {
    throw new Error(`installing Rostering: ${JSON.stringify(installed)}`);
  }
  zone = (await op<{ zone: string }>(page.request, "x.rostering.me", {})).zone;
}

interface Person {
  id: string;
  name: string;
  context: BrowserContext;
  page: Page;
}

/** A member of staff in their own browser: signed up, given a pack role by the admin, signed in. */
async function person(browser: Browser, admin: Page, baseURL: string, name: string) {
  const origin = new URL(baseURL).origin;
  const email = `${unique("listed")}@example.com`;
  const password = "listed-password-not-secret";
  const context = await browser.newContext({ baseURL, storageState: { cookies: [], origins: [] } });
  const signUp = await context.request.post("/api/auth/sign-up/email", {
    data: { name, email, password },
    headers: { origin },
  });
  expect(signUp.ok(), await signUp.text()).toBe(true);
  const users = await op<{ items: { id: string }[] }>(admin.request, "user.list", {
    filter: { field: "email", op: "eq", value: email },
  });
  const id = users.items[0]?.id as string;
  await op(admin.request, "user.setPackRole", { id, role: "rostering.team" });
  const signedIn = await context.request.post("/api/auth/sign-in/email", {
    data: { email, password },
    headers: { origin },
  });
  expect(signedIn.ok(), await signedIn.text()).toBe(true);
  return { id, name, context, page: await context.newPage() } satisfies Person;
}

/** A one-off shift of `duty`, an hour long, from `at`, worked by `staff`. */
async function shift(admin: Page, duty: string, at: number, staff: string) {
  return (
    await op<{ id: string }>(admin.request, "record.create", {
      object: SHIFT,
      values: {
        duty,
        startsAt: new Date(at).toISOString(),
        endsAt: new Date(at + HOUR).toISOString(),
        timezone: zone,
        staff,
      },
    })
  ).id;
}

/** Settings → Checklists: a new checklist of two steps, the second asking for a note. */
async function writeChecklist(page: Page, name: string): Promise<string> {
  await open(page, "/settings");
  // The settings page's own link (the sidebar also lists the rosterers' Checklists screen).
  await page.locator("#main").getByRole("link", { name: /Checklists/ }).click();
  await expect(page.getByRole("heading", { name: "Checklists" }).first()).toBeVisible();
  await page.getByTestId("checklist-new").click();
  const form = page.getByTestId("checklist-form");
  await form.getByTestId("checklist-name").fill(name);
  await form.getByRole("textbox", { name: "Step 1", exact: true }).fill("Empty the bins");
  await form.getByTestId("checklist-add-step").click();
  await form.getByRole("textbox", { name: "Step 2", exact: true }).fill("Count the towels");
  await form.getByRole("checkbox", { name: "Step 2 asks for a note" }).click();
  await form.getByTestId("checklist-save").click();
  const item = page.getByTestId("checklist-item").filter({ hasText: name });
  await expect(item).toBeVisible();
  await expectNoHorizontalScroll(page);
  return (await item.getAttribute("data-checklist")) as string;
}

test("a rosterer writes a checklist and picks it on a duty", async ({ page }) => {
  test.setTimeout(120_000);
  await install(page);
  const name = unique("Close-down ");
  const id = await writeChecklist(page, name);
  expect(id).toMatch(/^ckl_/);
  const saved = await op<{ steps: { text: string; note: boolean }[] }>(
    page.request,
    "checklist.get",
    { id },
  );
  expect(saved.steps).toEqual([
    { text: "Empty the bins", required: true, note: false },
    { text: "Count the towels", required: true, note: true },
  ]);
  // A duty's record: its Checklist field picks one in use.
  const duty = (
    await op<{ id: string }>(page.request, "record.create", {
      object: DUTY,
      values: { name: unique("Cleaning "), place: "Main floor" },
    })
  ).id;
  await open(page, `/x/${DUTY}/${duty}`);
  const card = page.locator("main");
  await card.getByRole("button", { name: /Edit/ }).first().click();
  await card.getByRole("combobox", { name: /^Checklist$/ }).click();
  await page.getByRole("option", { name, exact: true }).click();
  await card.getByRole("button", { name: "Save" }).first().click();
  await expect(card).toContainText(name);
  const stored = await op<{ values: { checklist: string } }>(page.request, "record.get", {
    object: DUTY,
    id: duty,
  });
  expect(stored.values.checklist).toBe(id);
});

/** A duty with a checklist of two steps (the second asks for a note), written by the admin. */
async function dutyWithChecklist(page: Page, name: string): Promise<string> {
  const checklist = (
    await op<{ id: string }>(page.request, "checklist.save", {
      name,
      steps: [{ text: "Unlock the doors" }, { text: "Check the first aid kit", note: true }],
    })
  ).id;
  return (
    await op<{ id: string }>(page.request, "record.create", {
      object: DUTY,
      values: { name: unique("Opening "), place: "Front door", checklist },
    })
  ).id;
}

test("the person on the shift ticks it off and the rosterer sees it done", async ({
  page,
  browser,
  baseURL,
}) => {
  test.setTimeout(180_000);
  await install(page);
  const name = unique("Opening up ");
  const duty = await dutyWithChecklist(page, name);
  const sam = await person(browser, page, baseURL ?? "", unique("Sam "));
  try {
    // Started a few minutes ago: open for ticking now, whatever the time of day.
    const at = Date.now() - 5 * MINUTE;
    const id = await shift(page, duty, at, sam.id);
    const date = localDate(at);

    // Sam's shifts, with the checklist under the shift.
    await mount(
      sam.page,
      block("rostering-checklist", "MyShiftsWithChecklist", { from: date, days: 2 }),
    );
    const mine = sam.page.locator(`[data-checklist-for="${id}"]`);
    await expect(mine).toContainText(name);
    await mine.getByRole("button", { name: new RegExp(`Open the checklist ${name}`) }).click();
    await mine.getByRole("button", { name: "Tick Unlock the doors done" }).click();
    await expect(mine.locator('[data-step="0"]')).toHaveAttribute("data-ticked", "done");
    await expect(mine.locator('[data-step="0"]')).toContainText(`Ticked by ${sam.name}`);
    // A step that asks for a note is not done without one: the host says so.
    await mine.getByRole("button", { name: "Tick Check the first aid kit done" }).click();
    await expect(mine.locator('[data-refusal="checklist_note_needed"]')).toBeVisible();
    await mine
      .getByRole("textbox", { name: "Note on Check the first aid kit" })
      .fill("Plasters low");
    await mine.getByRole("button", { name: "Tick Check the first aid kit done" }).click();
    await expect(mine.locator('[data-step="1"]')).toHaveAttribute("data-ticked", "done");
    await mine.getByRole("button", { name: `Mark the checklist ${name} done` }).click();
    await expect(mine.locator('[data-checklist-state="done"]')).toBeVisible();
    await expectNoHorizontalScroll(sam.page);
    // The note is on the screen only: never in the page's address or storage.
    expect(sam.page.url()).not.toContain("Plasters");
    const stored = await sam.page.evaluate(() =>
      JSON.stringify({ ...localStorage }).concat(JSON.stringify({ ...sessionStorage })),
    );
    expect(stored).not.toContain("Plasters");

    // The rosterer sees it done, with who ticked each step.
    await mount(page, block("rostering-checklists", "ChecklistRuns", { from: date, to: date }));
    const row = page.locator(`[data-record="${id}"]`);
    await expect(row).toHaveAttribute("data-state", "done");
    await expect(row).toContainText(sam.name);
    await mount(page, block("rostering-week", "RosterWeek", { from: date }));
    await expect(page.locator(`[data-shift="${id}"] [data-checklist="done"]`)).toBeVisible();
  } finally {
    await sam.context.close();
  }
});

test("a colleague sees that a shift has a checklist and never how it went", async ({
  page,
  browser,
  baseURL,
}) => {
  test.setTimeout(180_000);
  await install(page);
  const name = unique("Opening up ");
  const duty = await dutyWithChecklist(page, name);
  const sam = await person(browser, page, baseURL ?? "", unique("Sam "));
  const kit = await person(browser, page, baseURL ?? "", unique("Kit "));
  try {
    const at = Date.now() - 5 * MINUTE;
    const id = await shift(page, duty, at, sam.id);
    const date = localDate(at);
    // Sam ticks a step with a note, in their own browser.
    await mount(
      sam.page,
      block("rostering-checklist", "MyShiftsWithChecklist", { from: date, days: 2 }),
    );
    const mine = sam.page.locator(`[data-checklist-for="${id}"]`);
    await mine.getByRole("button", { name: new RegExp(`Open the checklist ${name}`) }).click();
    await mine
      .getByRole("textbox", { name: "Note on Check the first aid kit" })
      .fill("Plasters low");
    await mine.getByRole("button", { name: "Tick Check the first aid kit done" }).click();
    await expect(mine.locator('[data-step="1"]')).toHaveAttribute("data-ticked", "done");

    // Kit, a colleague: the roster says the shift has a checklist, never how it went.
    await mount(kit.page, block("rostering-week", "RosterWeek", { from: date }));
    const theirs = kit.page.locator(`[data-shift="${id}"]`);
    await expect(theirs).toContainText(name);
    await expect(theirs.locator('[data-checklist="hidden"]')).toBeVisible();
    const read = await op<{ status: number; code: string }>(
      kit.page.request,
      "x.rostering.checklist",
      { object: SHIFT, id },
      false,
    );
    expect(read.status).not.toBe(200);
    expect(JSON.stringify(read)).not.toContain("Plasters");
  } finally {
    await sam.context.close();
    await kit.context.close();
  }
});
