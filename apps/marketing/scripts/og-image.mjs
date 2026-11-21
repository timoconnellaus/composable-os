#!/usr/bin/env node
// Renders public/og.png (1200x630, the social card) and public/apple-touch-icon.png (180x180) in
// headless Chromium, with the site's own fonts and colours. The PNGs are committed; run this again
// after changing the brand or the headline:
//   pnpm --filter @composable-os/marketing og-image
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const require = createRequire(import.meta.url);
const font = (weight) =>
  `data:font/woff2;base64,${readFileSync(require.resolve(`@fontsource/poppins/files/poppins-latin-${weight}-normal.woff2`)).toString("base64")}`;

const MARK = `<svg viewBox="0 0 34 22" fill="#14161b"><rect width="21" height="22" rx="9"/><path d="M19 0h8.6a6 6 0 0 1 5.8 7.6l-2.7 10A6 6 0 0 1 24.9 22H15z"/></svg>`;

const base = `
  @font-face { font-family: Poppins; src: url(${font(400)}) format("woff2"); font-weight: 400; }
  @font-face { font-family: Poppins; src: url(${font(600)}) format("woff2"); font-weight: 600; }
  @font-face { font-family: Poppins; src: url(${font(700)}) format("woff2"); font-weight: 700; }
  * { margin: 0; box-sizing: border-box; }
  body { width: 100vw; height: 100vh; overflow: hidden; position: relative;
    background: #f9fbff; color: #14161b; font-family: Poppins, sans-serif; }
  .arch { position: absolute; bottom: 0; border-radius: 999px 999px 0 0;
    background: linear-gradient(180deg, #5aa2ff, #d6e6ff); }
`;

const og = `<style>${base}
  .wrap { position: absolute; inset: 0; padding: 72px 80px; display: flex; flex-direction: column; }
  .logo { display: flex; gap: 16px; align-items: center; font: 600 32px Poppins; letter-spacing: -.01em; }
  .logo svg { width: 62px; height: 40px; }
  h1 { margin-top: auto; font: 700 74px/1.08 Poppins; letter-spacing: -.02em; max-width: 13ch; }
  p { margin-top: 24px; font: 400 27px Poppins; color: #475066; max-width: 26ch; }
  .a { right: 300px; width: 150px; height: 300px; background: linear-gradient(180deg, #1f6bff, #5aa2ff); }
  .b { right: 170px; width: 190px; height: 520px; opacity: .6; }
  .c { right: 60px; width: 140px; height: 380px; }
  .dot { position: absolute; right: 80px; top: 72px; background: #d7f75b; border-radius: 99px;
    padding: 14px 30px; font: 600 24px Poppins; }
</style>
<i class="arch b"></i><i class="arch a"></i><i class="arch c"></i>
<div class="dot">Book a call</div>
<div class="wrap">
  <div class="logo">${MARK}Composable OS</div>
  <h1>A head start on custom software to fit your business</h1>
  <p>Built from parts that already work, then looked after for you.</p>
</div>`;

const icon = `<style>${base}
  body { display: grid; place-items: center; background: #eaf3fe; }
  svg { width: 124px; height: 80px; }
</style>${MARK}`;

const out = (name) => fileURLToPath(new URL(`../public/${name}`, import.meta.url));

const browser = await chromium.launch();
try {
  for (const [html, width, height, file] of [
    [og, 1200, 630, "og.png"],
    [icon, 180, 180, "apple-touch-icon.png"],
  ]) {
    const page = await browser.newPage({ viewport: { width, height } });
    await page.setContent(html);
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: out(file) });
    await page.close();
    console.log(`og-image: wrote public/${file}`);
  }
} finally {
  await browser.close();
}
