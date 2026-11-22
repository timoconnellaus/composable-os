// The landing page and each solution's page in a real browser, against the built site served by
// the Worker: each says what it sells and asks for one action, the call form works with and
// without JavaScript, the layout holds at phone, tablet and desktop widths, and the metadata is
// served.
import { randomUUID } from "node:crypto";
import { expect, type Locator, test } from "@playwright/test";
import { SOLUTIONS } from "../src/solutions.ts";
import { STATUS } from "../src/status.ts";

const CTA = "Book a call";

// The Worker rate limits form posts per client IP; give each test its own address.
test.beforeEach(async ({ page }) => {
  await page.setExtraHTTPHeaders({ "cf-connecting-ip": `10.${randomUUID()}` });
  // MARKETING_E2E_NO_FONTS=1 runs the spec as a visitor whose font requests fail: the page must
  // hold in its fallback font.
  if (process.env.MARKETING_E2E_NO_FONTS) await page.route("**/*.woff2", (route) => route.abort());
});

test.describe("the page", () => {
  test("says what it sells and asks for one action", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(
      "A head start on custom software to fit your business",
    );
    expect(await page.getByRole("heading", { level: 1 }).count()).toBe(1);
    // The one action, worded the same in the header, the hero, mid-page and the close.
    const actions = page.locator("a.btn:not(.ghost), button.btn");
    expect(await actions.count()).toBeGreaterThanOrEqual(4);
    for (const label of await actions.allTextContents()) expect(label.trim()).toBe(CTA);
    for (const link of await page.locator("a.btn:not(.ghost)").all()) {
      await expect(link).toHaveAttribute("href", "#call");
    }
    // The hero's action is on the first screen.
    await expect(page.locator(".hero").getByRole("link", { name: CTA })).toBeInViewport();
    // No hosted plans, prices or waitlist.
    await expect(page.getByText(/waitlist|\$\d|per month/i)).toHaveCount(0);
  });

  test("the header menu jumps to its sections", async ({ page }) => {
    await page.goto("/");
    const main = page.getByRole("navigation", { name: "Main" });
    for (const [label, id] of [
      ["How it works", "how"],
      ["What can go in", "pieces"],
      ["Solutions", "solutions"],
      ["Looked after", "care"],
      ["For developers", "developers"],
    ] as const) {
      await main.getByRole("link", { name: label }).click();
      await expect(page.locator(`#${id}`)).toBeInViewport();
    }
  });

  test("the questions are also structured data", async ({ page }) => {
    await page.goto("/");
    const schema = JSON.parse(
      (await page.locator('script[type="application/ld+json"]').textContent()) ?? "{}",
    );
    expect(schema["@type"]).toBe("FAQPage");
    const asked = await page.locator(".faq summary").allTextContents();
    expect(schema.mainEntity.map((q: { name: string }) => q.name)).toEqual(
      asked.map((text) => text.trim()),
    );
  });
});

test.describe("the call form", () => {
  test("sends in place with JavaScript", async ({ page }) => {
    await page.goto("/#call");
    const form = page.locator("form[data-form]");
    await form.getByLabel("Your name").fill("Ada Lovelace");
    await form.getByLabel("Work email").fill(`call-${randomUUID()}@example.com`);
    await form.getByLabel("Company").fill("Analytical Engines");
    await form.getByLabel("What you need").fill("Orders, roasting and deliveries in one place.");
    const response = page.waitForResponse("**/api/signup");
    await form.getByRole("button", { name: CTA }).click();
    expect(await (await response).json()).toEqual({ ok: true });
    await expect(form.locator(".done")).toBeVisible();
    await expect(form.locator(".done")).toBeFocused();
    await expect(form.getByLabel("Work email")).toBeHidden();
    expect(new URL(page.url()).pathname).toBe("/");
  });

  test("an invalid address shows the browser's own validation, and nothing is sent", async ({
    page,
  }) => {
    await page.goto("/#call");
    let posted = false;
    page.on("request", (request) => {
      if (request.url().endsWith("/api/signup")) posted = true;
    });
    const form = page.locator("form[data-form]");
    await form.getByLabel("Work email").fill("not-an-email");
    await form.getByRole("button", { name: CTA }).click();
    await page.waitForTimeout(300);
    expect(posted).toBe(false);
    await expect(form.locator(".done")).toBeHidden();
  });

  test.describe("without JavaScript", () => {
    test.use({ javaScriptEnabled: false });

    test("the form posts and lands on the thanks page", async ({ page }) => {
      await page.goto("/");
      const form = page.locator("form[data-form]");
      await form.getByLabel("Work email").fill(`nojs-${randomUUID()}@example.com`);
      await form.getByLabel("What you need").fill("A product for our bookings.");
      await form.getByRole("button", { name: CTA }).click();
      await page.waitForURL("**/thanks/");
      await expect(page.getByRole("heading", { level: 1 })).toHaveText("Thanks");
    });

    test("the page reads well: every section is visible", async ({ page }) => {
      await page.goto("/");
      for (const heading of ["The problem", "How it works", "Looked after", "Questions"]) {
        await expect(page.getByText(heading, { exact: true }).first()).toBeVisible();
      }
      const card = page.locator(".grid .card").first();
      await card.scrollIntoViewIfNeeded();
      await expect(card).toHaveCSS("opacity", "1");
      await expect(page.getByRole("link", { name: CTA }).first()).toBeVisible();
    });
  });
});

test.describe("layout", () => {
  const paths = ["/", ...SOLUTIONS.map((solution) => `/solutions/${solution.slug}/`)];
  for (const path of paths)
    for (const [width, height] of [
      [320, 640],
      [360, 740],
      [390, 844],
      [740, 360],
      [834, 1100],
      [1280, 900],
    ] as const) {
      test(`no horizontal overflow on ${path} at ${width}x${height}`, async ({ page }) => {
        await page.setViewportSize({ width, height });
        await page.goto(path);
        // html and body clip overflow, so check every element against the viewport, skipping
        // anything inside a container that scrolls or clips on purpose (the frame's rounded sheet,
        // the product picture, the commands).
        const offenders = await page.evaluate(() => {
          const vw = document.documentElement.clientWidth;
          const clipped = (el: Element) => {
            for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
              if (p.classList.contains("frame")) continue;
              if (getComputedStyle(p).overflowX !== "visible") return true;
            }
            return false;
          };
          const out: string[] = [];
          for (const el of document.body.querySelectorAll("*")) {
            const style = getComputedStyle(el);
            if (style.display === "none" || style.visibility === "hidden") continue;
            if (el.closest(".sr, .skip") || clipped(el)) continue;
            const r = el.getBoundingClientRect();
            if (r.width === 0 || r.height === 0) continue;
            if (r.right > vw + 1 || r.left < -1) out.push(`${el.tagName}.${el.className}`);
          }
          return out;
        });
        expect(offenders).toEqual([]);
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
          width,
        );
      });
    }

  test("on a phone the action stays in the bar, and the menu opens and closes", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");
    await expect(page.locator("header").getByRole("link", { name: CTA })).toBeVisible();
    // The hero's action is on the first screen (the skill's checklist: visible without scrolling).
    await expect(page.locator(".hero").getByRole("link", { name: CTA })).toBeInViewport();
    const button = page.getByRole("button", { name: "Open menu" });
    const link = page.locator("#mm").getByRole("link", { name: "Looked after" });
    await expect(link).toBeHidden();
    await button.click();
    await expect(page.getByRole("button", { name: "Close menu" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    await expect(link).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(link).toBeHidden();
    await expect(page.getByRole("button", { name: "Open menu" })).toBeFocused();
  });

  test("the page is light whatever the system colour scheme", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "dark" });
    await page.goto("/");
    expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe(
      "rgb(234, 243, 254)",
    );
  });
});

test("metadata, robots.txt and sitemap.xml are served", async ({ page, request }) => {
  await page.goto("/");
  await expect(page).toHaveTitle(/Composable OS/);
  await expect(page.locator('meta[property="og:image"]')).toHaveAttribute(
    "content",
    "https://composableos.dev/og.png",
  );
  for (const path of [
    "/robots.txt",
    "/sitemap.xml",
    "/og.png",
    "/favicon.svg",
    "/privacy/",
    ...SOLUTIONS.map((solution) => `/solutions/${solution.slug}/`),
  ]) {
    expect((await request.get(path)).status(), path).toBe(200);
  }
});

test("the header's links and its action do not overlap just above the menu's width", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1000, height: 800 });
  await page.goto("/");
  const links = await page.getByRole("navigation", { name: "Main" }).boundingBox();
  const action = await page.locator("header").getByRole("link", { name: CTA }).boundingBox();
  expect(links && action && links.x + links.width).toBeLessThanOrEqual(action?.x ?? 0);
});

test.describe("a solution's page", () => {
  for (const solution of SOLUTIONS) {
    const path = `/solutions/${solution.slug}/`;

    test(`${solution.label}: is linked from the home page`, async ({ page }) => {
      await page.goto("/");
      await page.locator("#solutions").getByRole("link", { name: solution.label }).click();
      await expect(page).toHaveURL(new RegExp(`${path}$`));
      await expect(page.getByRole("heading", { level: 1 })).toHaveText(solution.heading);
    });

    test(`${solution.label}: one action, kept on the page, and every piece's status in the site's words`, async ({
      page,
    }) => {
      await page.goto(path);
      await expect(page).toHaveTitle(solution.title);
      await expect(page.locator('meta[name="description"]')).toHaveAttribute(
        "content",
        solution.description,
      );
      expect(await page.getByRole("heading", { level: 1 }).count()).toBe(1);
      const actions = page.locator("a.btn:not(.ghost), button.btn");
      expect(await actions.count()).toBeGreaterThanOrEqual(4);
      for (const label of await actions.allTextContents()) expect(label.trim()).toBe(CTA);
      for (const link of await page.locator("a.btn:not(.ghost)").all()) {
        await expect(link).toHaveAttribute("href", "#call");
      }
      await expect(page.locator(".hero").getByRole("link", { name: CTA })).toBeInViewport();
      const words: string[] = Object.values(STATUS);
      const pills = await page.locator("#pieces .soon").allTextContents();
      expect(pills).toHaveLength(solution.pieces.built.length + solution.pieces.notYet.length);
      for (const pill of pills) expect(words).toContain(pill.trim());
      // No hosted plans, prices or signup waitlist ("waitlists" for classes is a feature).
      await expect(page.getByText(/\bwaitlist\b|\$\d|per month/i)).toHaveCount(0);
      const schema = JSON.parse(
        (await page.locator('script[type="application/ld+json"]').textContent()) ?? "{}",
      );
      expect(schema.mainEntity.map((q: { name: string }) => q.name)).toEqual(
        solution.questions.map((item) => item.q),
      );
    });

    test(`${solution.label}: the call form sends in place`, async ({ page }) => {
      await page.goto(`${path}#call`);
      const form = page.locator("form[data-form]");
      await form.getByLabel("Work email").fill(`solution-${randomUUID()}@example.com`);
      const response = page.waitForResponse("**/api/signup");
      await form.getByRole("button", { name: CTA }).click();
      expect(await (await response).json()).toEqual({ ok: true });
      await expect(form.locator(".done")).toBeVisible();
    });
  }
});

test("the header fits a narrow phone", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 740 });
  await page.goto("/");
  const menu = await page.getByRole("button", { name: "Open menu" }).boundingBox();
  expect(menu && menu.x + menu.width).toBeLessThanOrEqual(360);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
});

// What a thumb needs on a phone: nothing in the header overlaps, every control is at least 44px
// tall, form fields are at least 16px (or iOS zooms in on focus), and the commands wrap instead of
// scrolling out of sight.
test.describe("on a phone", () => {
  const paths = ["/", ...SOLUTIONS.map((solution) => `/solutions/${solution.slug}/`)];
  for (const path of paths)
    for (const width of [320, 360, 390])
      for (const font of ["Poppins", "a wide fallback font"]) {
        test(`${path} at ${width}px in ${font}: the header's logo, action and menu sit side by side, 44px tall`, async ({
          page,
        }) => {
          await page.setViewportSize({ width, height: 740 });
          await page.goto(path);
          // Before Poppins loads, or where it never does, a system font shows; DejaVu Sans (Linux)
          // and Verdana are among the widest, so the bar has to hold with them too.
          if (font !== "Poppins")
            await page.addStyleTag({
              content: ':root { --font: Verdana, "DejaVu Sans", sans-serif; }',
            });
          // Wait for the name's face itself (fonts.ready can settle before a swap face is asked
          // for), then see what is actually drawing the name: Poppins only if its face loaded and
          // the name's computed font starts with it.
          const poppins = await page.evaluate(async () => {
            const name = document.querySelector("header .logo-name");
            if (!name) return false;
            const style = getComputedStyle(name);
            const spec = `${style.fontWeight} ${style.fontSize} "Poppins"`;
            const faces = await document.fonts.load(spec).catch(() => []);
            await document.fonts.ready;
            return (
              faces.length > 0 &&
              document.fonts.check(spec) &&
              /^"?Poppins"?\b/.test(getComputedStyle(name).fontFamily)
            );
          });
          if (font === "Poppins" && !process.env.MARKETING_E2E_NO_FONTS) expect(poppins).toBe(true);
          const header = page.locator("header.site");
          const box = async (locator: Locator) => {
            const found = await locator.boundingBox();
            if (!found) throw new Error("not rendered");
            return found;
          };
          const logo = await box(header.locator(".logo"));
          const action = await box(header.getByRole("link", { name: CTA }));
          const menu = await box(header.getByRole("button", { name: "Open menu" }));
          // In every font: nothing spills out of the logo or under the action, and both of the
          // bar's controls are thumb-sized.
          expect(
            await header.locator(".logo").evaluate((el) => el.scrollWidth <= el.clientWidth),
          ).toBe(true);
          expect(logo.x + logo.width).toBeLessThanOrEqual(action.x);
          expect(action.x + action.width).toBeLessThanOrEqual(menu.x);
          expect(menu.x + menu.width).toBeLessThanOrEqual(width);
          expect(action.height).toBeGreaterThanOrEqual(44);
          expect(menu.height).toBeGreaterThanOrEqual(44);
          const name = header.locator(".logo-name");
          if (poppins) {
            // In Poppins the whole name shows, with room to spare for wider text rendering.
            expect(await name.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
          } else {
            // In a fallback the name may be cut, but only with an ellipsis, never clipped bare.
            await expect(name).toHaveCSS("text-overflow", "ellipsis");
            await expect(name).toHaveCSS("overflow-x", "hidden");
          }
        });
      }

  test("the call form's fields are 16px text and 44px targets, with the right keyboards", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 360, height: 740 });
    await page.goto("/#call");
    const form = page.locator("form[data-form]");
    for (const control of await form.locator("input:visible, textarea, button").all()) {
      const box = await control.boundingBox();
      expect(box?.height).toBeGreaterThanOrEqual(44);
      const size = await control.evaluate((el) => Number.parseFloat(getComputedStyle(el).fontSize));
      expect(size).toBeGreaterThanOrEqual(16);
    }
    const email = form.getByLabel("Work email");
    await expect(email).toHaveAttribute("type", "email");
    await expect(email).toHaveAttribute("autocomplete", "email");
    await expect(email).toHaveAttribute("autocapitalize", "off");
    await expect(form.getByLabel("Your name")).toHaveAttribute("autocomplete", "name");
    await expect(form.getByLabel("Company")).toHaveAttribute("autocomplete", "organization");
  });

  test("the footer's links are 44px targets", async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 740 });
    await page.goto("/");
    for (const link of await page
      .getByRole("navigation", { name: "Footer" })
      .getByRole("link")
      .all())
      expect((await link.boundingBox())?.height).toBeGreaterThanOrEqual(44);
  });

  test("the commands wrap instead of scrolling sideways", async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 640 });
    await page.goto("/");
    const term = page.locator(".term");
    expect(await term.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    // Copying the block still gives one command per line.
    // biome-ignore lint/performance/useDomNodeTextContent: the lines are blocks; only the rendered text has their line breaks.
    expect((await term.innerText()).split("\n")[1]).toBe(
      '$ npm create composable-os harbour -- --label "Harbour Roasters"',
    );
  });
});
