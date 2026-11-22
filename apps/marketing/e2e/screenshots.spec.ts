// Full-page screenshots for PR descriptions: phone, tablet and desktop (the site is light only), saved under
// screenshots/: the home page as <width>.jpg, each solution's page as <slug>-<width>.jpg. Skipped unless SCREENSHOTS=1 (`pnpm --filter @composable-os/marketing screenshots`).
// Reduced motion shows every section without waiting for it to scroll into view.
import { fileURLToPath } from "node:url";
import { test } from "@playwright/test";
import { SOLUTIONS } from "../src/solutions.ts";

test.skip(!process.env.SCREENSHOTS, "set SCREENSHOTS=1 to save screenshots");

const dir = fileURLToPath(new URL("../screenshots/", import.meta.url));

const pages = [
  { path: "/", name: "" },
  ...SOLUTIONS.map((solution) => ({
    path: `/solutions/${solution.slug}/`,
    name: `${solution.slug}-`,
  })),
];

for (const { path, name } of pages)
  for (const width of [390, 834, 1280]) {
    test(`${path} at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.goto(path);
      await page.evaluate(async () => {
        for (const el of document.querySelectorAll(".reveal")) el.classList.add("seen");
        await document.fonts.ready;
      });
      await page.waitForTimeout(400);
      await page.screenshot({
        path: `${dir}${name}${width}.jpg`,
        fullPage: true,
        type: "jpeg",
        quality: 85,
      });
    });
  }
