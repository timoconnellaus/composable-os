// Agreements (stage 44 step 1, ADR 0610): a person with agreements:manage writes a document's
// working copy, publishes it, then publishes a changed version as "everyone agrees again". The
// document text is fixture text, not wording anyone should use.
import { expect, type Page, test } from "@playwright/test";
import { open, unique } from "./helpers.ts";

async function saveCopy(page: Page) {
  await page.getByRole("button", { name: "Save working copy" }).click();
  await expect(page.getByText("Working copy saved").first()).toBeVisible();
}

async function publish(page: Page, number: number) {
  await page.getByRole("button", { name: `Publish version ${number}` }).click();
  const confirm = page.getByRole("alertdialog");
  await expect(confirm).toContainText("cannot be changed or withdrawn");
  await confirm.getByRole("button", { name: "Publish" }).click();
  await expect(page.getByText(`Version ${number} published`).first()).toBeVisible();
}

test("staff write a document, publish it, then publish a changed version as agree again", async ({
  page,
}) => {
  const title = `Waiver ${unique("agr")}`;
  await open(page, "/settings/agreements");
  await page.getByLabel("Title").fill(title);
  await page.getByRole("button", { name: "Create draft" }).click();
  await expect(page).toHaveURL(/\/settings\/agreements\/agd_/);

  // Nothing can be published until the copy has a body and a tick label.
  await expect(page.getByTestId("publish-problems")).toContainText("The body has no text");
  await page.locator("#draft-body").click();
  await page.keyboard.type("Fixture text: not a real waiver.");
  await page.getByLabel("The words beside the box").fill("I have read the fixture");
  await saveCopy(page);
  await expect(page.getByTestId("publish-summary")).toContainText("This makes version 1");
  await publish(page, 1);
  await expect(page.getByTestId("agreement-versions")).toContainText("First version");

  // A changed copy: the publish shows what changed and asks what kind of change it is.
  await page.locator("#draft-body").click();
  await page.keyboard.press("End");
  await page.keyboard.type(" A second fixture sentence.");
  await saveCopy(page);
  await expect(page.getByTestId("publish-summary")).toContainText("Changed since version 1: body");
  await page.getByLabel(/Everyone agrees again/).check();
  await publish(page, 2);
  const versions = page.getByTestId("agreement-versions");
  await expect(versions).toContainText("Version 2");
  await expect(versions).toContainText("Everyone agrees again");
  await expect(versions.locator("li").first()).toContainText("in effect");

  await open(page, "/settings/agreements");
  await expect(page.getByTestId("agreement-list")).toContainText(title);
  await expect(page.getByTestId("agreement-list")).toContainText("Version 2");
});
