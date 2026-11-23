// Shared steps for the signed-in e2e specs.
import {
  type APIRequestContext,
  type Browser,
  type BrowserContext,
  expect,
  type Locator,
  type Page,
} from "@playwright/test";

/** A short unique token, so specs can share the local database across runs. */
export function unique(prefix = ""): string {
  return `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** Opens a path and waits until React has hydrated (shortcuts and clicks work). */
export async function open(page: Page, path: string): Promise<void> {
  await page.goto(path);
  await expect(page.locator("html[data-hydrated]")).toBeAttached({ timeout: 30_000 });
}

/** Presses a shortcut until `target` shows (the first press can land before hydration ends). */
export async function pressUntil(page: Page, key: string, target: Locator): Promise<void> {
  await expect(async () => {
    if (!(await target.isVisible())) await page.keyboard.press(key);
    await expect(target).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 20_000 });
}

/** The page never scrolls sideways (wide tables scroll inside their own container). */
export async function expectNoHorizontalScroll(page: Page): Promise<void> {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

export function isPhone(page: Page): boolean {
  return (page.viewportSize()?.width ?? 1280) < 768;
}

/**
 * Opens a shipped pack's staff screen through the admin's own navigation (stage 47): its section
 * (`group`) and its link, as a person does, then waits until the screen has drawn.
 */
export async function openScreen(page: Page, group: string, label: string): Promise<void> {
  await open(page, "/");
  const link = page.getByTestId(`screens-nav-${group}`).getByRole("link", {
    name: label,
    exact: true,
  });
  if (isPhone(page)) await page.getByRole("button", { name: "Toggle navigation" }).click();
  await link.click();
  await waitForScreen(page);
}

/** Waits until the screen on the page has loaded its code and its data. */
export async function waitForScreen(page: Page): Promise<void> {
  await expect(page.locator("[data-screen]")).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('[data-screen] [aria-busy="true"]')).toHaveCount(0, {
    timeout: 30_000,
  });
}

/** Calls an operation on the host's HTTP surface as `request`'s session; its data, or throws. */
async function surface<T>(request: APIRequestContext, name: string, input: unknown): Promise<T> {
  const response = await request.post(`/api/v1/op/${name}`, {
    data: input,
    headers: { "idempotency-key": crypto.randomUUID() },
  });
  const body = (await response.json()) as { data?: T };
  expect(response.status(), `${name}: ${JSON.stringify(body).slice(0, 300)}`).toBe(200);
  return body.data as T;
}

export interface StaffAccount {
  id: string;
  name: string;
  context: BrowserContext;
  page: Page;
}

/**
 * A member of staff in their own browser: signed up, given a pack role and grants by the admin
 * (`admin`'s session), signed in. Close `context` when done.
 */
export async function staffAccount(
  browser: Browser,
  admin: Page,
  baseURL: string,
  name: string,
  options: { packRole?: string; grants?: string[]; timezoneId?: string } = {},
): Promise<StaffAccount> {
  const origin = new URL(baseURL).origin;
  const email = `${unique("staff")}@example.com`;
  const password = "staff-password-not-secret";
  const context = await browser.newContext({
    baseURL,
    storageState: { cookies: [], origins: [] },
    ...(options.timezoneId ? { timezoneId: options.timezoneId } : {}),
  });
  const signUp = await context.request.post("/api/auth/sign-up/email", {
    data: { name, email, password },
    headers: { origin },
  });
  expect(signUp.ok(), await signUp.text()).toBe(true);
  const users = await surface<{ items: { id: string }[] }>(admin.request, "user.list", {
    filter: { field: "email", op: "eq", value: email },
  });
  const id = users.items[0]?.id as string;
  if (options.packRole) {
    await surface(admin.request, "user.setPackRole", { id, role: options.packRole });
  }
  if (options.grants?.length) {
    await surface(admin.request, "user.setPermissions", { id, permissions: options.grants });
  }
  const signedIn = await context.request.post("/api/auth/sign-in/email", {
    data: { email, password },
    headers: { origin },
  });
  expect(signedIn.ok(), await signedIn.text()).toBe(true);
  return { id, name, context, page: await context.newPage() };
}

/**
 * A time zone where it is now between 02:00 and 21:59, so a class an hour or two from now is
 * today's there whatever time the suite runs: the host decides "today" by the class's zone.
 */
export function daytimeZone(): string {
  for (const zone of [
    "UTC",
    "Asia/Tokyo",
    "America/New_York",
    "Asia/Kolkata",
    "Pacific/Honolulu",
  ]) {
    const hour = Number(
      new Intl.DateTimeFormat("en-GB", {
        timeZone: zone,
        hour: "2-digit",
        hourCycle: "h23",
      }).format(new Date()),
    );
    if (hour >= 2 && hour <= 21) return zone;
  }
  return "UTC";
}

/**
 * Every call the page makes that the host refuses (a 403, or an operation's `forbidden`), from now
 * on: a fixed-role account's shell makes none (stage 47).
 */
export function watchRefusals(page: Page): { refused: string[]; settled: () => Promise<void> } {
  const refused: string[] = [];
  const reading: Promise<void>[] = [];
  page.on("response", (response) => {
    const url = new URL(response.url());
    if (url.origin !== new URL(page.url() || response.url()).origin) return;
    if (!url.pathname.startsWith("/_serverFn") && !url.pathname.startsWith("/api/")) return;
    if (response.status() === 403) {
      refused.push(url.pathname);
      return;
    }
    reading.push(
      response
        .text()
        .then((text) => {
          if (!/"forbidden"/.test(text)) return;
          // The operation the admin's server function was asked to call (its serialised input).
          const body = response.request().postData() ?? "";
          const asked = /"s":"([a-z][a-zA-Z0-9]*(?:\.[a-zA-Z0-9]+)+)"/.exec(body)?.[1];
          refused.push(`${asked ?? url.pathname} on ${new URL(page.url()).pathname}`);
        })
        .catch(() => undefined),
    );
  });
  return {
    refused,
    settled: async () => {
      await page.waitForLoadState("networkidle");
      await Promise.all(reading);
    },
  };
}

/**
 * Creates a person through the `c` dialog on People and waits for their record page. (On a record
 * page `c` adds a task, so this opens the list first.)
 */
export async function createPerson(
  page: Page,
  person: { given: string; family?: string; email?: string },
): Promise<string> {
  if (!/\/people\/?(\?.*)?$/.test(page.url())) await open(page, "/people");
  const dialog = page
    .getByRole("dialog", { name: "New person" })
    .and(page.locator("[data-state=open]"));
  await pressUntil(page, "c", dialog);
  await dialog.getByLabel("Given name").fill(person.given);
  if (person.family) await dialog.getByLabel("Family name").fill(person.family);
  if (person.email) await dialog.getByLabel("Email").fill(person.email);
  // "Create anyway" when the name matches someone already there (a duplicate warning).
  await dialog.getByRole("button", { name: /^Create (person|anyway)$/ }).click();
  await expect(page).toHaveURL(/\/people\/per_/);
  // Wait out the closing animation, so a following create cannot grab the closing dialog.
  // (data-state flips to closed before the animation ends, so wait for the element to go.)
  await expect(page.getByRole("dialog", { name: "New person" })).toHaveCount(0);
  const name = [person.given, person.family].filter(Boolean).join(" ");
  await expect(page.getByRole("heading", { level: 1, name })).toBeVisible();
  return page.url().split("/people/")[1]?.split("?")[0] ?? "";
}

/** The rows of the list table (excluding the header). */
export function tableRows(page: Page) {
  return page
    .getByRole("table", { name: "People" })
    .locator("tbody tr:not(:has([data-testid=empty-state]))");
}

/** Drags `source` onto `target`; on phones (touch) uses the card's own "Move to" menu instead. */
export async function moveCard(page: Page, source: Locator, target: Locator, menuChoice: string) {
  if (isPhone(page)) {
    // The menu can re-render while the board settles; reopen it until the choice takes.
    await expect(async () => {
      if (!(await page.getByRole("menuitem", { name: menuChoice }).isVisible())) {
        await source.getByRole("button", { name: /^Move / }).click();
      }
      await page.getByRole("menuitem", { name: menuChoice }).click({ timeout: 2_000 });
    }).toPass({ timeout: 20_000 });
    return;
  }
  await source.dragTo(target);
}
