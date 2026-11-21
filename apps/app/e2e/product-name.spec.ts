// Issue #155: an anonymous visitor's pages render, and name the product, whether or not the
// deployment has a label (COS_PRODUCT_LABEL). The name comes from the server's own render, never
// from a call an anonymous visitor could be refused. Run it with E2E_PRODUCT_LABEL set to the
// label in apps/app/.dev.vars to check the label; unset, it checks the build's own name.
import { expect, test } from "@playwright/test";

const NAME = process.env.E2E_PRODUCT_LABEL || "CRM";

test("an anonymous visitor's sign-in and guest order pages render and name the product", async ({
  browser,
}) => {
  const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const page = await context.newPage();
  const failed: string[] = [];
  page.on("response", (response) => {
    if (response.status() === 401) failed.push(response.url());
  });

  await page.goto("/sign-in");
  await expect(page.getByText(`Sign in to ${NAME}`, { exact: true })).toBeVisible();
  await expect(page).toHaveTitle(NAME);
  await expect(page.locator('meta[name="cos-product-name"]')).toHaveAttribute("content", NAME);

  // A guest's order page with a link that opens nothing: it still renders, and says so.
  await page.goto("/order/ord_01NOSUCHORDER0000000000000?token=" + "0".repeat(64));
  await expect(page.locator('meta[name="cos-product-name"]')).toHaveAttribute("content", NAME);
  await expect(page.locator("body")).not.toContainText("unauthorized");

  // Nothing the pages asked for on their own was refused to an anonymous visitor.
  expect(failed.filter((url) => !url.includes("/api/v1/op/"))).toEqual([]);
  if (NAME !== "CRM") await expect(page.locator("body")).not.toContainText("CRM");
  await context.close();
});
