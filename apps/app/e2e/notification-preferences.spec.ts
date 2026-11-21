// Stage 6b, AC6 (notification delivery per preference), the part only a browser can prove: an admin
// connects a fake outbox for the org and picks it under Settings → Notifications → Delivery, and
// the user turns email on and off for "Approvals waiting" under Settings → Notifications, the
// choice kept across a reload. What the minute cron then does with it (the notice by email,
// waiting in Approvals, sent once approved; nothing when it is off) is covered without the 30 s
// delivery lag by apps/runner/test/notification-preferences.test.ts.
import { expect, type Page, test } from "@playwright/test";
import { expectNoHorizontalScroll, open } from "./helpers.ts";
import {
  addFakeResource,
  connectFake,
  fakeAddress,
  openIntegrations,
} from "./integration-helpers.ts";

/** Picks the email connection on the Delivery page (null: Off) and saves. */
async function setEmailDelivery(page: Page, address: string | null): Promise<void> {
  await open(page, "/settings/notification-delivery");
  await expect(
    page.getByRole("heading", { level: 1, name: "Notification delivery" }),
  ).toBeVisible();
  await page.getByLabel("Email connection").click();
  await page
    .getByRole(
      "option",
      address ? { name: new RegExp(address.replace(/[.]/g, "\\.")) } : { name: "Off" },
    )
    .click();
  const saveBar = page.getByTestId("save-bar");
  if (await saveBar.isVisible()) {
    await saveBar.getByRole("button", { name: "Save" }).click();
    await expect(saveBar).toHaveCount(0);
  }
}

const approvalEmail = (page: Page) =>
  page.getByRole("checkbox", { name: "Approvals waiting by Email" });

/** Sets "Approvals waiting by Email" on Settings → Notifications. */
async function setApprovalEmail(page: Page, on: boolean): Promise<void> {
  await open(page, "/settings/notifications");
  const box = approvalEmail(page);
  await expect(box).toBeEnabled();
  if ((await box.getAttribute("aria-checked")) !== String(on)) await box.click();
  await expect(box).toHaveAttribute("aria-checked", String(on));
}

test("a notification preference is set and kept", async ({ page }) => {
  const address = fakeAddress("notify");

  // The org outbox and the delivery setting.
  await openIntegrations(page);
  const connection = await connectFake(page, address, "org");
  await addFakeResource(page, connection, "Outbox", address);
  await setEmailDelivery(page, address);
  await expect(page.getByTestId("auto-approve-hint")).toContainText(
    "Outbound action auto-approval",
  );
  await expectNoHorizontalScroll(page);

  try {
    // The user's preference: approvals waiting also by email, kept across a reload.
    await setApprovalEmail(page, true);
    await expect(page.getByTestId("notification-preferences")).not.toContainText(
      "Email is not set up yet",
    );
    await expectNoHorizontalScroll(page);
    await page.reload();
    await expect(approvalEmail(page)).toHaveAttribute("aria-checked", "true");

    // Email off again, also kept.
    await setApprovalEmail(page, false);
    await page.reload();
    await expect(approvalEmail(page)).toHaveAttribute("aria-checked", "false");
  } finally {
    // Leave delivery off for the other specs.
    await setEmailDelivery(page, null);
  }
});
