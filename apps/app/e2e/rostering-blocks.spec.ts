// Rostering, step 7 (stage 45): the blocks, one test per journey. A rosterer builds a week and puts
// someone on a shift; a team member offers a shift and a qualified colleague takes it; a person
// marks time away and the rosterer sees the warning while a colleague does not; someone who
// handles pay totals, locks and exports a period, and the person counted sees their own hours
// for it; someone who does not roster cannot change who is on a shift. The blocks are mounted where they sit (`/blocks`, development only), calling the
// host's HTTP surface from the browser as a client app would, each person in their own browser.
// Every name here is invented.
//
// Clocks: the host decides "today" (its own clock and the business's zone), which a test cannot
// pin, so every shift is placed well away from today (9 to 12 days ahead, the pay period two
// weeks back and more) and the week blocks are opened on an explicit date: a run across midnight
// in the business's zone sees the same weeks.
//
// It installs Rostering, changes the pay period settings and locks a pay period for good, so it
// runs only against the database its own dev server made: never a server it reuses
// (E2E_REUSE_SERVER=1) unless E2E_ROSTERING_REUSED=1 says that database may be changed.
import {
  type APIRequestContext,
  type Browser,
  type BrowserContext,
  expect,
  type Page,
  test,
} from "@playwright/test";
import { expectNoHorizontalScroll, unique } from "./helpers.ts";

test.skip(
  process.env.E2E_REUSE_SERVER === "1" && process.env.E2E_ROSTERING_REUSED !== "1",
  "installs Rostering, changes the pay settings and locks a pay period: not run against a " +
    "database it did not make (set E2E_ROSTERING_REUSED=1 to allow it)",
);

const DAY = 86_400_000;
const HOUR = 3_600_000;
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

/** Rostering on, the business's zone read, and a duty of this test's own. */
async function setUp(page: Page): Promise<{ duty: string; dutyName: string }> {
  const installed = await op<{ status?: number; code?: string; message?: string }>(
    page.request,
    "extension.install",
    { id: "rostering", shipped: true },
    false,
  );
  // Installed now, or already (an earlier test of this file).
  if (installed?.status && installed.status !== 200 && installed.code !== "conflict") {
    throw new Error(`installing Rostering: ${JSON.stringify(installed)}`);
  }
  const me = await op<{ zone: string; rosters: boolean }>(page.request, "x.rostering.me", {});
  expect(me.rosters).toBe(true);
  zone = me.zone;
  const dutyName = unique("Close-down clean ");
  const duty = (await op<{ id: string }>(page.request, "record.create", {
    object: DUTY,
    values: { name: dutyName, place: "Main floor" },
  })) as { id: string };
  return { duty: duty.id, dutyName };
}

interface Person {
  id: string;
  name: string;
  context: BrowserContext;
  page: Page;
}

/** A member of staff in their own browser: signed up, given a role by the admin, signed in. */
async function person(
  browser: Browser,
  admin: Page,
  baseURL: string,
  name: string,
  packRole: string | null,
): Promise<Person> {
  const origin = new URL(baseURL).origin;
  const email = `${unique("rostered")}@example.com`;
  const password = "rostered-password-not-secret";
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
  if (packRole) await op(admin.request, "user.setPackRole", { id, role: packRole });
  const signedIn = await context.request.post("/api/auth/sign-in/email", {
    data: { email, password },
    headers: { origin },
  });
  expect(signedIn.ok(), await signedIn.text()).toBe(true);
  return { id, name, context, page: await context.newPage() };
}

/** A one-off duty shift, an hour long, starting `at` (ms since the epoch). */
async function shift(admin: Page, duty: string, at: number, staff: string | null) {
  return (
    await op<{ id: string }>(admin.request, "record.create", {
      object: SHIFT,
      values: {
        duty,
        startsAt: new Date(at).toISOString(),
        endsAt: new Date(at + HOUR).toISOString(),
        timezone: zone,
        ...(staff ? { staff } : {}),
      },
    })
  ).id;
}

/** A time well inside a day `days` ahead (or back), on the hour, away from any day's edge. */
const around = (days: number) => {
  const d = new Date(Date.now() + days * DAY);
  d.setUTCMinutes(0, 0, 0);
  return d.getTime();
};

const qualify = (admin: Page, account: string, duty: string) =>
  op(admin.request, "x.rostering.qualify", { account, kind: { object: DUTY, id: duty } });

test("a rosterer builds a week and puts someone on a shift", { tag: "@phone" }, async ({
  page,
  browser,
  baseURL,
}) => {
  test.setTimeout(120_000);
  const { duty, dutyName } = await setUp(page);
  const ann = await person(browser, page, baseURL ?? "", unique("Ann "), "rostering.team");
  try {
    await qualify(page, ann.id, duty);
    const at = around(9);
    const id = await shift(page, duty, at, null);
    await mount(page, block("rostering-week", "RosterWeek", { from: localDate(at) }));
    const card = page.locator(`[data-shift="${id}"]`);
    await expect(card).toBeVisible();
    // Uncovered: marked, and warned about (a rosterer's read).
    await expect(card).toHaveAttribute("data-uncovered", "true");
    await expect(card).toHaveAccessibleName(new RegExp(`${dutyName}.*Nobody on it`));
    await expect(card.locator('[data-warning="uncovered"]')).toBeVisible();
    await expectNoHorizontalScroll(page);
    // From the shift: the people who could take it first, then put Ann on it.
    await card.click();
    const panel = page.getByRole("complementary");
    await expect(panel.getByRole("region", { name: "Could take it" })).toContainText(ann.name);
    await panel.getByRole("button", { name: `Put ${ann.name} on it` }).click();
    await expect(panel.getByRole("status")).toContainText(`${ann.name} is on it now.`);
    await expect(card).toContainText(ann.name);
    await expect(card).not.toHaveAttribute("data-uncovered", "true");
    // The host's write: Ann is on it.
    const stored = await op<{ values: { staff: string } }>(page.request, "record.get", {
      object: SHIFT,
      id,
    });
    expect(stored.values.staff).toBe(ann.id);
    // Ann's own roster in her browser shows it as hers, with no assign controls.
    await mount(ann.page, block("rostering-week", "RosterWeek", { from: localDate(at) }));
    const hers = ann.page.locator(`[data-shift="${id}"]`);
    await expect(hers).toHaveAttribute("data-mine", "true");
    await expect(ann.page.locator(`button[data-shift="${id}"]`)).toHaveCount(0);
  } finally {
    await ann.context.close();
  }
});

test("a team member offers a shift and a qualified colleague takes it", async ({
  page,
  browser,
  baseURL,
}) => {
  test.setTimeout(120_000);
  const { duty, dutyName } = await setUp(page);
  const ann = await person(browser, page, baseURL ?? "", unique("Ann "), "rostering.team");
  const ben = await person(browser, page, baseURL ?? "", unique("Ben "), "rostering.team");
  try {
    await qualify(page, ann.id, duty);
    await qualify(page, ben.id, duty);
    const id = await shift(page, duty, around(10), ann.id);
    // Ann offers it from My shifts: it stays hers until someone takes it.
    await mount(ann.page, block("rostering-my-shifts", "MyShifts"));
    const mine = ann.page.locator(`[data-shift="${id}"]`);
    await expect(mine).toContainText(dutyName);
    await mine.getByRole("button", { name: `Offer ${dutyName} for someone else to take` }).click();
    await expect(ann.page.getByRole("status")).toContainText("It stays yours until someone does.");
    await expect(mine).toContainText("Offered: still yours");
    // Ben sees it offered to him and takes it: nobody approves.
    await mount(ben.page, block("rostering-offers", "OffersToMe"));
    const offered = ben.page.locator("[data-offer]").filter({ hasText: dutyName });
    await expect(offered).toContainText(`Offered by ${ann.name}`);
    await offered.getByRole("button", { name: `Take ${dutyName}` }).click();
    await expect(ben.page.getByRole("status")).toContainText("is yours now.");
    expect(
      (await op<{ values: { staff: string } }>(page.request, "record.get", { object: SHIFT, id }))
        .values.staff,
    ).toBe(ben.id);
    // It is gone from Ann's shifts.
    await ann.page.reload();
    await expect(ann.page.locator(`[data-shift="${id}"]`)).toHaveCount(0);
    // Ben adds his shifts to his phone's calendar: the address is shown once, works, holds the
    // shift he took, is in no URL of the app, and is gone once he leaves the page.
    await mount(ben.page, block("rostering-my-calendar", "MyCalendar"));
    await ben.page.getByRole("button", { name: "Make my calendar address" }).click();
    const shown = ben.page.getByLabel("Your calendar address (shown this once)");
    await expect(shown).toHaveValue(/\/api\/v1\/staffing\/feed\/[^/]+\.ics$/);
    const address = await shown.inputValue();
    expect(ben.page.url()).not.toContain(new URL(address).pathname);
    await expect(ben.page.getByRole("link", { name: "Add to calendar" })).toHaveAttribute(
      "href",
      address.replace(/^https?:/, "webcal:"),
    );
    // The dev server is plain http: the feed is fetched there by its path.
    const fetched = await ben.context.request.get(new URL(address).pathname);
    expect(fetched.status()).toBe(200);
    expect(await fetched.text()).toContain("BEGIN:VCALENDAR");
    await ben.page.reload();
    await expect(ben.page.locator('[data-feed="on"]')).toBeVisible();
    await expect(ben.page.getByTestId("feed-address")).toHaveCount(0);
    // Switched off, the address no longer answers.
    await ben.page.getByRole("button", { name: "Switch it off…" }).click();
    await ben.page
      .getByRole("alertdialog", { name: "Switch it off" })
      .getByRole("button", { name: "Switch it off" })
      .click();
    await expect(ben.page.locator('[data-feed="off"]')).toBeVisible();
    expect((await ben.context.request.get(new URL(address).pathname)).status()).toBe(404);
  } finally {
    await ann.context.close();
    await ben.context.close();
  }
});

test("a person marks time away; the rosterer sees the warning and a colleague does not", async ({
  page,
  browser,
  baseURL,
}) => {
  test.setTimeout(120_000);
  const { duty } = await setUp(page);
  const ann = await person(browser, page, baseURL ?? "", unique("Ann "), "rostering.team");
  const ben = await person(browser, page, baseURL ?? "", unique("Ben "), "rostering.team");
  try {
    const at = around(11);
    const day = localDate(at);
    const id = await shift(page, duty, at, ann.id);
    // Ann says she is away that whole day, with a note only she and whoever rosters see.
    await mount(ann.page, block("rostering-my-availability", "MyAvailability"));
    const form = ann.page.getByRole("form", { name: "Add time off" });
    await form.getByLabel("From (date)").fill(day);
    await form.getByLabel("From (time)").fill("00:00");
    await form.getByLabel("Until (date)").fill(localDate(at + DAY));
    await form.getByLabel("Until (time)").fill("00:00");
    await form.getByLabel(/^Note/).fill("A family thing");
    await form.getByRole("button", { name: "Add time off" }).click();
    await expect(ann.page.getByRole("region", { name: "Your shifts then" })).toContainText(
      "You are on 1 shift then",
    );
    await expect(ann.page.getByRole("region", { name: "My time off" })).toContainText(
      "A family thing",
    );
    // The note typed is gone from the form once sent.
    await expect(form.getByLabel(/^Note/)).toHaveValue("");
    // The rosterer's week warns about it.
    await mount(page, block("rostering-week", "RosterWeek", { from: day }));
    await expect(page.locator(`[data-shift="${id}"] [data-warning="unavailable"]`)).toBeVisible();
    // Ben's week shows the shift and nothing of Ann's time off: no warning at all.
    await mount(ben.page, block("rostering-week", "RosterWeek", { from: day }));
    const seen = ben.page.locator(`[data-shift="${id}"]`);
    await expect(seen).toContainText(ann.name);
    await expect(ben.page.locator("[data-warning]")).toHaveCount(0);
    await expect(ben.page.getByText("Away")).toHaveCount(0);
    // Nor can he ask for it.
    const refused = await op<{ status: number }>(
      ben.page.request,
      "x.rostering.awayList",
      {},
      false,
    );
    expect(refused.status).toBe(403);
    // The everyone's-time-off screen is not shown to him, and reveals nothing.
    await mount(ben.page, block("rostering-away", "TimeOff", { from: day }));
    await expect(ben.page.locator('[data-refusal="rostering"]')).toBeVisible();
    await expect(ben.page.getByText("A family thing")).toHaveCount(0);
  } finally {
    await ann.context.close();
    await ben.context.close();
  }
});

test("someone who handles pay totals, locks and exports a period", async ({
  page,
  browser,
  baseURL,
}, testInfo) => {
  test.setTimeout(150_000);
  const { duty, dutyName } = await setUp(page);
  const ann = await person(browser, page, baseURL ?? "", unique("Ann "), "rostering.team");
  // A weekly period that has ended, its own on each attempt: a retry (after a lock, which holds
  // for good) takes the next week, which has ended too and comes after the locked one.
  const back = localDate(Date.now() - (21 - 7 * Math.min(testInfo.retry, 1)) * DAY);
  const [y, m, d] = back.split("-").map(Number) as [number, number, number];
  const weekday = (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
  const start = new Date(Date.UTC(y, m - 1, d - weekday)).toISOString().slice(0, 10);
  try {
    await op(page.request, "extensionSettings.update", {
      extension: "rostering",
      values: { payPeriod: "weekly", payPeriodStart: start },
    });
    // Ann counted by time from before the period; one hour on its Wednesday.
    await op(page.request, "x.rostering.payBasis", {
      account: ann.id,
      basis: "by_time",
      from: start,
    });
    const wednesday = Date.parse(`${start}T00:00:00Z`) + 2 * DAY + 12 * HOUR;
    await shift(page, duty, wednesday, ann.id);
    await mount(page, block("rostering-pay", "Pay"));
    const period = page.locator(`[data-start="${start}"]`);
    await expect(period).toHaveAccessibleName(/ended, open$/);
    await period.click();
    const rows = page.getByRole("table", { name: "Hours and shifts per person" });
    await expect(rows.getByRole("row").filter({ hasText: ann.name })).toContainText("1.00");
    await expect(page.getByRole("status").first()).toContainText("A preview");
    // Lock it, confirmed.
    await page.getByRole("button", { name: "Lock…" }).click();
    await page
      .getByRole("alertdialog", { name: "Lock this period" })
      .getByRole("button", { name: "Lock the period" })
      .click();
    await expect(page.getByText("Locked.", { exact: true })).toBeVisible();
    // After the lock, a change to Ann's shift in it is refused by the host.
    const lines = await op<{ lines: { id: string; title: string }[] }>(
      page.request,
      "x.rostering.periodTotals",
      { start },
    );
    const line = lines.lines.find((l) => l.title === dutyName);
    expect(line).toBeTruthy();
    const refused = await op<{ status: number; details?: { details?: { rule?: string } } }>(
      page.request,
      "x.rostering.assign",
      { object: SHIFT, id: line?.id, account: null },
      false,
    );
    expect(JSON.stringify(refused)).toContain("pay_period_locked");
    // The export: a CSV with Ann's hours, handed over as a file.
    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: "Export CSV" }).click();
    const file = await download;
    expect(file.suggestedFilename()).toMatch(/\.csv$/);
    const text = await (await file.createReadStream()).toArray();
    const csv = Buffer.concat(text).toString("utf8");
    expect(csv).toContain(ann.name);
    expect(csv).toContain("1.00");
    // Ann sees her own hours under My shifts (the owner's decision of 2026-11-24): the period's
    // locked figures, the same 1.00, fetched only once she picks the period.
    await mount(ann.page, block("rostering-my-shifts", "MyShifts"));
    const hours = ann.page.getByRole("region", { name: "My hours" });
    await expect(hours.getByText("All my hours")).toHaveCount(0);
    await hours.locator(`[data-start="${start}"]`).click();
    await expect(hours.locator('[data-state="locked"]')).toBeVisible();
    await expect(hours.getByRole("table", { name: "My hours and shifts" })).toContainText("1.00");
    await expect(hours.getByText("All my hours: 1.00")).toBeVisible();
    // Someone who does not handle pay is shown nothing of the business's pay.
    await mount(ann.page, block("rostering-pay", "Pay"));
    await expect(ann.page.locator('[data-refusal="forbidden"]')).toBeVisible();
    await expect(ann.page.getByText("1.00")).toHaveCount(0);
  } finally {
    // Back to the defaults this database had (a database of its own: see the top of this file).
    await op(
      page.request,
      "extensionSettings.update",
      { extension: "rostering", values: { payPeriod: null, payPeriodStart: null } },
      false,
    );
    await ann.context.close();
  }
});

test("someone who does not roster cannot change who is on a shift", async ({
  page,
  browser,
  baseURL,
}) => {
  test.setTimeout(120_000);
  const { duty } = await setUp(page);
  const ann = await person(browser, page, baseURL ?? "", unique("Ann "), "rostering.team");
  const max = await person(browser, page, baseURL ?? "", unique("Max "), null);
  try {
    const at = around(12);
    const id = await shift(page, duty, at, ann.id);
    for (const who of [ann, max]) {
      await mount(who.page, block("rostering-week", "RosterWeek", { from: localDate(at) }));
      await expect(who.page.locator(`[data-shift="${id}"]`)).toBeVisible();
      // Read only: no shift opens the assign panel, and no warnings are shown.
      await expect(who.page.locator(`button[data-shift]`)).toHaveCount(0);
      await expect(who.page.getByText("Choose a shift to put someone on it")).toHaveCount(0);
      // The host refuses the rosterers' tools, and a direct write of who is on the shift.
      const assign = await op<{ status: number }>(
        who.page.request,
        "x.rostering.assign",
        { object: SHIFT, id, account: who.id },
        false,
      );
      expect(assign.status).toBe(403);
      const direct = await op<{ status: number }>(
        who.page.request,
        "record.update",
        { object: SHIFT, id, values: { staff: who.id } },
        false,
      );
      expect(direct.status).toBeGreaterThanOrEqual(400);
    }
    expect(
      (await op<{ values: { staff: string } }>(page.request, "record.get", { object: SHIFT, id }))
        .values.staff,
    ).toBe(ann.id);
    // The regular week and the qualifications are a rosterer's: Max is told so, and sees none.
    await mount(max.page, block("rostering-patterns", "Patterns"));
    await expect(max.page.locator('[data-refusal="rostering"]')).toBeVisible();
    await mount(max.page, block("rostering-qualifications", "Qualifications"));
    await expect(max.page.locator('[data-refusal="rostering"]')).toBeVisible();
    await expect(max.page.getByRole("checkbox")).toHaveCount(0);
  } finally {
    await ann.context.close();
    await max.context.close();
  }
});
