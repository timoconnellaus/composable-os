// Checklists on their own (ADR 0651), one test for the journey: the owner gives a checklist set
// days in Settings → Checklists; a member of staff, in their own browser, opens Today's
// checklists from the admin's navigation and ticks it off, and their last tick finishes it; the
// owner sees the day done, by whom and when, in Checklist history. No Rostering is needed. Every
// name here is invented.
//
// Clocks: a day's checklist is ticked on its day in the business's zone, by the host's clock; the
// screens read today from the host.
//
// It installs Daily checklists and writes checklists, so it runs only against the database its own
// dev server made: never a server it reuses (E2E_REUSE_SERVER=1) unless E2E_CHECKLISTS_REUSED=1
// says that database may be changed.
import { type APIRequestContext, expect, test } from "@playwright/test";
import { expectNoHorizontalScroll, open, openScreen, unique } from "./helpers.ts";

test.skip(
  process.env.E2E_REUSE_SERVER === "1" && process.env.E2E_CHECKLISTS_REUSED !== "1",
  "installs Daily checklists and writes checklists: not run against a database it did not make " +
    "(set E2E_CHECKLISTS_REUSED=1 to allow it)",
);

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

test("the owner sets a checklist's days, a member ticks today's off, and the owner sees it done", async ({
  page,
  browser,
  baseURL,
}) => {
  test.setTimeout(180_000);
  const installed = await op<{ status?: number; code?: string }>(
    page.request,
    "extension.install",
    { id: "dailychecks", shipped: true },
    false,
  );
  if (installed?.status && installed.status !== 200 && installed.code !== "conflict") {
    throw new Error(`installing Daily checklists: ${JSON.stringify(installed)}`);
  }

  // The owner: Settings → Checklists, a checklist done on its own, every day, by everyone on staff.
  const name = unique("Opening up ");
  await open(page, "/settings/checklists");
  await page.getByTestId("checklist-new").click();
  const form = page.getByTestId("checklist-form");
  await form.getByTestId("checklist-name").fill(name);
  await form.getByRole("textbox", { name: "Step 1", exact: true }).fill("Unlock the doors");
  await form.getByTestId("checklist-add-step").click();
  await form.getByRole("textbox", { name: "Step 2", exact: true }).fill("Lights on");
  await form.getByTestId("checklist-on-own").click();
  await form.getByTestId("checklist-due-by").fill("23:59");
  await expect(form.getByTestId("checklist-who")).toHaveValue("staff");
  await form.getByTestId("checklist-save").click();
  const item = page.getByTestId("checklist-item").filter({ hasText: name });
  await expect(item.getByTestId("checklist-schedule")).toContainText("Every day, by 23:59");
  await expectNoHorizontalScroll(page);
  const id = (await item.getAttribute("data-checklist")) as string;

  // A member of staff, in their own browser, from the admin's navigation.
  const origin = new URL(baseURL ?? "").origin;
  const email = `${unique("opener")}@example.com`;
  const password = "opener-password-not-secret";
  const who = unique("Robin ");
  const context = await browser.newContext({ baseURL, storageState: { cookies: [], origins: [] } });
  try {
    const signUp = await context.request.post("/api/auth/sign-up/email", {
      data: { name: who, email, password },
      headers: { origin },
    });
    expect(signUp.ok(), await signUp.text()).toBe(true);
    const signedIn = await context.request.post("/api/auth/sign-in/email", {
      data: { email, password },
      headers: { origin },
    });
    expect(signedIn.ok(), await signedIn.text()).toBe(true);
    const member = await context.newPage();
    await openScreen(member, "Checklists", "Today's checklists");
    const card = member.locator(`[data-day-checklist="${id}"]`);
    await expect(card).toContainText(name);
    await expect(card).toHaveAttribute("data-state", "not_started");
    await card.getByRole("button", { name: "Tick Unlock the doors done" }).click();
    await expect(card.locator('[data-step="0"]')).toHaveAttribute("data-ticked", "done");
    await expect(card.locator('[data-step="0"]')).toContainText(`Ticked by ${who}`);
    // The last tick finishes it: final.
    await card.getByRole("button", { name: "Tick Lights on done" }).click();
    await expect(card).toHaveAttribute("data-state", "done");
    await expect(card.locator('[data-finished="true"]')).toContainText(`Done by ${who}`);
    await expect(card.getByRole("button", { name: /Tick .* done/ })).toHaveCount(0);
    await expectNoHorizontalScroll(member);
    // How every day went is not a member's: no Checklist history, and its address is not found.
    await expect(
      member.getByTestId("screens-nav-Checklists").getByRole("link", { name: "Checklist history" }),
    ).toHaveCount(0);
    await member.goto("/s/dailychecks/history");
    await expect(member.getByTestId("not-found")).toBeVisible();
  } finally {
    await context.close();
  }

  // The owner sees the day done, by whom.
  await openScreen(page, "Checklists", "Checklist history");
  const row = page.locator("[data-history-run]").filter({ hasText: name });
  await expect(row).toHaveAttribute("data-state", "done");
  await expect(row).toContainText(`by ${who}`);
});
