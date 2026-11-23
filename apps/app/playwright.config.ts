import { defineConfig, devices } from "@playwright/test";

// The e2e suite runs against `vite dev`: both Workers, local D1 and the hello Workflow.
// - `smoke` signs in through the UI itself, at desktop size.
// - `desktop` (1280 px) runs every app spec signed in, from the storage state global-setup saves.
// - `phone` (390 px) runs only the tests tagged `@phone`: `test("…", { tag: "@phone" }, …)`, on
//   each test (Biome refuses the option on a `test.describe`). Tag a test when its layout really
//   differs at phone width (the nav drawer, sheets, a reflowing table or grid, touch in place of
//   drag or hover, a phone-only assertion), not by default. See CONTRIBUTING.md (End-to-end tests).
// CI splits the run across runners with `--shard=N/4` (.github/workflows/ci.yml).
const PORT = Number(process.env.E2E_PORT ?? 5179);
const baseURL = `http://localhost:${PORT}`;
const storageState = "e2e/.auth/user.json";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  // One worker: specs share the local database and the org-wide approval policy.
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  // dev-server-reporter.ts names a failure that happened while the dev server crashed (not the
  // product's); dev-server.mjs, the web server, records the crashes.
  reporter: process.env.CI
    ? [["list"], ["html", { open: "never" }], ["./e2e/dev-server-reporter.ts"]]
    : [["list"], ["./e2e/dev-server-reporter.ts"]],
  globalSetup: "./e2e/global-setup.ts",
  // The first page load on a cold `vite dev` can take a while (dependency optimisation).
  expect: { timeout: 15_000 },
  timeout: 90_000,
  use: { baseURL, trace: "retain-on-failure" },
  projects: [
    { name: "smoke", testMatch: "smoke.spec.ts", use: { ...devices["Desktop Chrome"] } },
    {
      name: "desktop",
      testIgnore: ["smoke.spec.ts", "live/**"],
      use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 900 }, storageState },
    },
    {
      name: "phone",
      testIgnore: ["smoke.spec.ts", "live/**"],
      grep: /@phone/,
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
        storageState,
      },
    },
  ],
  webServer: {
    command: "node e2e/dev-server.mjs",
    env: { PORT: String(PORT) },
    url: `${baseURL}/api/health`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
