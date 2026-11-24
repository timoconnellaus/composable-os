import { readFileSync } from "node:fs";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// Kept in step with wrangler.jsonc; a drift here tests a runtime we do not deploy. The tests run
// the Worker through test/worker.ts, which adds a host-like harness.

// wrangler.jsonc's Text rule, for the Vite module graph the tests load the Worker through.
const textModules = {
  name: "text-modules",
  enforce: "pre" as const,
  load(id: string) {
    if (!id.endsWith(".txt")) return null;
    return `export default ${JSON.stringify(readFileSync(id, "utf8"))};`;
  },
};

export default defineConfig({
  plugins: [
    textModules,
    cloudflareTest({
      main: "./test/worker.ts",
      miniflare: {
        compatibilityDate: "2026-09-04",
        compatibilityFlags: ["allow_irrevocable_stub_storage"],
        durableObjects: {
          TEXT_EVENTS: { className: "TextEvents", useSQLite: true },
          FAKE_TEXT_LEDGER: { className: "FakeTextLedger", useSQLite: true },
          // Production reaches this class only as a facet; declaring it registers the class.
          TEXT_GATEKEEPER: { className: "TextGatekeeper", useSQLite: true },
          TEST_HOST: { className: "TestHost", useSQLite: true },
        },
        bindings: {
          BASE_URL: "https://crm.example.com/gatekeeper/text",
          TEXT_PROVIDER: "fake",
          TEXT_SENDER_NUMBER: "+61400000999",
          // The fake runs off localhost only with its own secret.
          FAKE_WEBHOOK_SECRET: "fake-text-test-secret",
        },
      },
    }),
  ],
  // The agent-facing types are served from a `types.txt -> types.d.ts` symlink imported as a Text
  // module. Resolved through the link, Vite would load the `.d.ts` as an empty TS module instead.
  resolve: { preserveSymlinks: true },
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 20_000,
    setupFiles: ["@composable-os/gatekeeper-interface/testing/assert-workerd"],
    // As the other gatekeepers': a wrapped method's rejection the RPC caller received also
    // surfaces as an unhandled rejection marked `remote`.
    onUnhandledError(error) {
      return (error as { remote?: unknown }).remote === true ? false : undefined;
    },
  },
});
