import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type FullConfig } from "@playwright/test";
import { TEST_USER } from "./test-user.ts";

const STORAGE_STATE = join(dirname(fileURLToPath(import.meta.url)), ".auth/user.json");

/** Shipped packs some spec installs (`extension.install` with `shipped: true`). */
// Content before Courses, which requires it (and Programs).
const E2E_PACKS = [
  "programs",
  "bookings",
  "content",
  "courses",
  "memberships",
  "ticketing",
  "forms",
  "knowledge",
];

/** The dev server, not the product, failed the call: no answer, or Vite's own error page. */
class DevServerBroke extends Error {}

async function waitForHealth(baseURL: string) {
  const until = Date.now() + 120_000;
  while (Date.now() < until) {
    const ok = await fetch(`${baseURL}/api/health`)
      .then((r) => r.ok)
      .catch(() => false);
    if (ok) return;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new DevServerBroke("the dev server did not come back within 120s");
}

async function installOnce(baseURL: string, cookie: string, id: string) {
  const response = await fetch(`${baseURL}/api/v1/op/extension.install`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: baseURL,
      cookie,
      "idempotency-key": crypto.randomUUID(),
    },
    body: JSON.stringify({ id, shipped: true }),
  }).catch((error: unknown) => {
    throw new DevServerBroke(`no answer (${String(error)})`);
  });
  const text = await response.text();
  if (!(response.headers.get("content-type") ?? "").includes("json")) {
    throw new DevServerBroke(`${response.status}, not JSON: ${text.slice(0, 120)}`);
  }
  if (!response.ok) throw new Error(`installing the ${id} pack: ${response.status} ${text}`);
}

/** Installs a shipped pack, retrying only when the dev server broke (never a product error). */
async function installPack(baseURL: string, cookie: string, id: string) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await installOnce(baseURL, cookie, id);
    } catch (error) {
      if (!(error instanceof DevServerBroke) || attempt === 3) throw error;
      console.warn(`[e2e] the dev server broke installing ${id} (${error.message}); retrying`);
      await waitForHealth(baseURL);
    }
  }
}

export default async function globalSetup(config: FullConfig) {
  const baseURL = config.projects[0]?.use.baseURL;
  if (!baseURL) throw new Error("baseURL is not set");
  const response = await fetch(`${baseURL}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: baseURL },
    body: JSON.stringify(TEST_USER),
  });
  // 422: the user exists from an earlier run.
  if (!response.ok && response.status !== 422) {
    throw new Error(`could not create the test user: ${response.status} ${await response.text()}`);
  }

  // Sign in once and save the session cookie for the signed-in projects.
  const signIn = await fetch(`${baseURL}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: baseURL },
    body: JSON.stringify({ email: TEST_USER.email, password: TEST_USER.password }),
  });
  if (!signIn.ok) throw new Error(`could not sign in the test user: ${signIn.status}`);
  const { hostname } = new URL(baseURL);
  const cookies = signIn.headers.getSetCookie().map((header) => {
    const [pair = "", ...attributes] = header.split(";").map((part) => part.trim());
    const [name = "", ...value] = pair.split("=");
    const flags = attributes.map((a) => a.toLowerCase());
    return {
      name,
      value: value.join("="),
      domain: hostname,
      path: "/",
      expires: -1,
      httpOnly: flags.includes("httponly"),
      secure: flags.includes("secure"),
      sameSite: "Lax" as const,
    };
  });
  mkdirSync(dirname(STORAGE_STATE), { recursive: true });
  writeFileSync(STORAGE_STATE, JSON.stringify({ cookies, origins: [] }, null, 2));

  // The packs the specs use, installed once here rather than first inside a test: installing a pack
  // the first time builds and type-checks it, the heaviest call the suite makes, and the one during
  // which the dev server's Workers runtime has crashed in CI. Here nothing else is running, and a
  // crash is retried once the dev server is back. A spec installing a pack again changes nothing.
  const cookie = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  for (const id of E2E_PACKS) await installPack(baseURL, cookie, id);

  // The first-run setup wizard opens for the first admin (stage 8). Skip it once here so the other
  // specs land where they navigate; setup-wizard.spec.ts reopens it from Settings → General.
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({ baseURL, storageState: STORAGE_STATE });
    const page = await context.newPage();
    await page.goto("/setup");
    await page.locator("html[data-hydrated]").waitFor({ state: "attached", timeout: 60_000 });
    // The wizard renders once setup.status loads, which on a cold `vite dev` can be well after
    // hydration: wait for the button rather than checking once.
    const skip = page.getByTestId("setup-skip");
    const shown = await skip
      .waitFor({ state: "visible", timeout: 60_000 })
      .then(() => true)
      .catch(() => false);
    if (shown) {
      await skip.click();
      await page.waitForURL((url) => url.pathname === "/", { timeout: 30_000 });
    }
  } finally {
    await browser.close();
  }
}
