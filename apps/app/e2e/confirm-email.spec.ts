// Confirming your own address (ADR 0457), through the real app: the suite's admin signed up with a
// password, so their address is unconfirmed and sign-in by code cannot reach it. Settings → Users
// says so; with the host's sign-in mail on, the account menu's "Confirm your email" emails a code
// to the admin's own address, and entering it confirms the address.
import { expect, test } from "@playwright/test";
import { open } from "./helpers.ts";
import {
  addFakeResource,
  connectFake,
  fakeAddress,
  openIntegrations,
  sentMail,
} from "./integration-helpers.ts";
import { TEST_USER } from "./test-user.ts";

const escapeRe = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

test("an admin who signed up with a password confirms their own email", async ({ page }) => {
  test.setTimeout(120_000);
  const status = await page.request.post("/api/v1/op/user.emailStatus", { data: {} });
  const { data } = (await status.json()) as { data: { verified: boolean } };
  test.skip(data.verified, "The admin's address is already confirmed in this local database");

  const outbox = fakeAddress("confirm");
  await openIntegrations(page);
  const connection = await connectFake(page, outbox, "org");
  await addFakeResource(page, connection, "Outbox", outbox);
  await open(page, "/settings/users");
  await page.getByLabel("Mail connection").click();
  await page.getByRole("option", { name: new RegExp(escapeRe(outbox)) }).click();
  await expect(page.getByText("The host's mail connection is saved")).toBeVisible();
  const signInMail = page.getByTestId("sign-in-mail");
  if ((await signInMail.getAttribute("data-ready")) !== "true") {
    await signInMail.getByRole("switch").click();
    await page
      .getByRole("alertdialog")
      .getByRole("button", { name: "Send without review" })
      .click();
  }
  await expect(signInMail).toHaveAttribute("data-ready", "true");
  try {
    // Settings → Users tells the unconfirmed admin, plainly.
    await expect(page.getByTestId("unconfirmed-email")).toContainText(TEST_USER.email);

    // The account menu's action.
    await page.getByTestId("user-menu").click();
    await page.getByRole("menuitem", { name: "Confirm your email" }).click();
    const dialog = page.getByRole("dialog", { name: "Confirm your email" });
    await dialog.getByRole("button", { name: "Email me a code" }).click();
    let code = "";
    await expect
      .poll(
        async () => {
          const mail = await sentMail(page.request, outbox);
          const sent = mail.find((m) => m.to.includes(TEST_USER.email));
          code = /(\d{6})/.exec(sent?.text ?? "")?.[1] ?? "";
          return code;
        },
        { timeout: 30_000 },
      )
      .toMatch(/^\d{6}$/);
    await dialog.getByLabel("Code", { exact: true }).fill(code);
    await dialog.getByRole("button", { name: "Confirm" }).click();
    await expect(page.getByText(`${TEST_USER.email} is confirmed`)).toBeVisible();
    await expect(page.getByTestId("unconfirmed-email")).toHaveCount(0);
    await page.getByTestId("user-menu").click();
    await expect(page.getByRole("menuitem", { name: "Confirm your email" })).toHaveCount(0);
  } finally {
    await page.request.post("/api/v1/op/outbound.setAutoApprove", {
      data: { tag: "fake.signin", enabled: false },
      headers: { "idempotency-key": crypto.randomUUID() },
    });
  }
});
