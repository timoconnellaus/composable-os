#!/usr/bin/env node
// Draws every block's preview and saves its picture for the docs site:
// apps/docs/public/screens/<block>.png, and screens.json beside them (each picture's size and the
// fingerprint of what it was drawn from, scripts/blocks.mjs).
//
//   pnpm --filter @composable-os/screens shoot                 every block whose picture is stale
//   pnpm --filter @composable-os/screens shoot <block> …       those blocks, stale or not
//   pnpm --filter @composable-os/screens shoot --all           every block
//   pnpm --filter @composable-os/screens check                 fail on a missing or stale picture
//
// The page runs on Vite's dev server, in Chromium with the clock fixed to the previews' day
// (src/fake.ts: TODAY, NOW, TIME_ZONE). A preview that does not answer a query its block makes, or
// a block that throws, fails the run, naming it.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  allBlocks,
  fingerprint,
  MANIFEST,
  OUT,
  PREVIEWS,
  problems,
  ROOT,
  readManifest,
  screenBlocks,
} from "./blocks.mjs";

const args = process.argv.slice(2);

if (args.includes("--check")) {
  const found = problems();
  if (found.length) {
    console.error(`The screen pictures are out of date:\n${found.map((p) => `  ${p}`).join("\n")}`);
    process.exit(1);
  }
  console.log("Every block's picture is current.");
  process.exit(0);
}

const fake = readFileSync(join(ROOT, "apps/screens/src/fake.ts"), "utf8");
const constant = (name) => {
  const match = fake.match(new RegExp(`export const ${name} = [\`"]([^\`"]+)[\`"]`));
  if (!match) throw new Error(`src/fake.ts has no ${name}`);
  return match[1];
};
const NOW = constant("NOW");
const TIME_ZONE = constant("TIME_ZONE");

// Fingerprints are worked out over every block (a picture's deps include ui-utils), as --check does.
const every = allBlocks();
const blocks = screenBlocks();
const manifest = readManifest();
const named = args.filter((a) => !a.startsWith("--"));
for (const name of named) {
  if (!blocks.some((b) => b.name === name)) throw new Error(`No block ${name}`);
}
const todo = blocks.filter((b) => {
  if (!existsSync(join(PREVIEWS, `${b.name}.tsx`))) return false;
  if (named.length) return named.includes(b.name);
  if (args.includes("--all")) return true;
  const shot = manifest[b.name];
  return (
    !shot || shot.fingerprint !== fingerprint(b, every) || !existsSync(join(OUT, `${b.name}.png`))
  );
});

if (!todo.length) {
  console.log("Every picture is current.");
  process.exit(0);
}

const { createServer } = await import("vite");
const { chromium } = await import("@playwright/test");

const server = await createServer({
  configFile: join(ROOT, "apps/screens/vite.config.ts"),
  root: join(ROOT, "apps/screens"),
  // No reloads mid-picture when a preview is saved meanwhile.
  server: { port: 0, strictPort: false, hmr: false, watch: null },
  logLevel: "warn",
});
await server.listen();
const address = server.httpServer?.address();
const base = `http://localhost:${typeof address === "object" && address ? address.port : 4323}`;

const browser = await chromium.launch();
mkdirSync(OUT, { recursive: true });
const failed = [];

// Fixed with no zone offset: the browser reads it in TIME_ZONE, so the clock shows NOW there.
const nowInZone = (() => {
  const guess = new Date(`${NOW}Z`);
  const shown = new Date(guess.toLocaleString("en-US", { timeZone: TIME_ZONE }));
  const utc = new Date(guess.toLocaleString("en-US", { timeZone: "UTC" }));
  return new Date(guess.getTime() - (shown.getTime() - utc.getTime()));
})();

/** A picture standing in for one on the host: a gradient whose hue comes from its id. */
function placeholder(url) {
  const id = decodeURIComponent(new URL(url).pathname.split("/").pop() ?? "");
  // FNV-1a, spread round the colour wheel by the golden angle: ids a letter apart look apart.
  let h = 0x811c9dc5;
  for (const c of id) h = Math.imul(h ^ c.charCodeAt(0), 0x01000193) >>> 0;
  const hue = Math.round((h % 97) * 137.508) % 360;
  const a = `hsl(${hue} 45% 72%)`;
  const b = `hsl(${(hue + 40) % 360} 50% 52%)`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="900" viewBox="0 0 1600 900"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs><rect width="1600" height="900" fill="url(#g)"/><circle cx="1180" cy="300" r="220" fill="#fff" fill-opacity="0.18"/><circle cx="420" cy="700" r="320" fill="#fff" fill-opacity="0.12"/></svg>`;
}

try {
  for (const block of todo) {
    const native = block.skin === "native";
    const context = await browser.newContext({
      viewport: native ? { width: 390, height: 844 } : { width: 1280, height: 900 },
      deviceScaleFactor: native ? 2 : 1,
      timezoneId: TIME_ZONE,
      locale: "en-GB",
      reducedMotion: "reduce",
    });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(String(error)));
    await page.clock.setFixedTime(nowInZone);
    // Pictures on the host: a soft placeholder, its colour from the id.
    // On the site's own route (/api/media/<id>, the web blocks') or the host's (/api/v1/media/<id>).
    await page.route(/\/api\/(v1\/)?media\//, (route) =>
      route.fulfill({ contentType: "image/svg+xml", body: placeholder(route.request().url()) }),
    );
    try {
      await page.goto(`${base}/?block=${encodeURIComponent(block.name)}`);
      const settle = async () => {
        await page.waitForFunction(
          () =>
            document.body.dataset.ready === "1" || (globalThis.__screenProblems?.length ?? 0) > 0,
          null,
          { timeout: 20_000 },
        );
      };
      await settle();
      const clicks = await page.evaluate(() => globalThis.__screenClick ?? []);
      for (const target of clicks) {
        const element =
          typeof target === "string"
            ? page.getByText(target, { exact: false })
            : page.getByRole(target.role, { name: target.name });
        await element.first().click();
        await page.waitForTimeout(50);
        await settle();
      }
      const fills = await page.evaluate(() => globalThis.__screenFill ?? []);
      for (const [label, text] of fills) {
        const byLabel = page.getByLabel(label, { exact: false });
        const field = (await byLabel.count()) ? byLabel : page.getByPlaceholder(label);
        await field.first().fill(text);
        await settle();
      }
      // No caret or focus ring in the picture.
      await page.evaluate(() => document.activeElement?.blur?.());
      await page.evaluate(() => document.fonts.ready);
      const found = await page.evaluate(() => globalThis.__screenProblems ?? []);
      if (found.length || errors.length) throw new Error([...found, ...errors].join("\n"));
      const frame = page.locator("#frame");
      const box = await frame.boundingBox();
      if (!box) throw new Error("The frame was not drawn");
      await frame.screenshot({ path: join(OUT, `${block.name}.png`), animations: "disabled" });
      manifest[block.name] = {
        skin: block.skin,
        width: Math.round(box.width),
        height: Math.round(box.height),
        fingerprint: fingerprint(block, every),
      };
      console.log(`  ${block.name}`);
    } catch (error) {
      failed.push(`${block.name}: ${String(error instanceof Error ? error.message : error)}`);
      console.error(`✗ ${block.name}`);
    } finally {
      await context.close();
    }
  }
} finally {
  await browser.close();
  await server.close();
  // Re-read before writing: another run may have drawn other blocks meanwhile.
  const latest = readManifest();
  for (const block of todo) if (manifest[block.name]) latest[block.name] = manifest[block.name];
  const sorted = Object.fromEntries(Object.entries(latest).sort(([a], [b]) => a.localeCompare(b)));
  writeFileSync(MANIFEST, `${JSON.stringify(sorted, null, 2)}\n`);
}

if (failed.length) {
  console.error(
    `\n${failed.length} preview(s) failed:\n${failed.map((f) => `  ${f}`).join("\n\n")}`,
  );
  process.exit(1);
}
