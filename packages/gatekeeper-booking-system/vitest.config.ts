import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// Kept in step with wrangler.fake.jsonc; a drift here tests a runtime the dev server does not run.
export default defineConfig({
  plugins: [
    cloudflareTest({
      main: "./__tests__/worker.ts",
      miniflare: {
        compatibilityDate: "2026-09-04",
        compatibilityFlags: ["allow_irrevocable_stub_storage"],
        modulesRules: [{ type: "Text", include: ["**/*.txt"] }],
        durableObjects: {
          FAKE_BOOKING_SITE: { className: "FakeBookingSite", useSQLite: true },
          // Reached only as a facet; declaring it registers it as a Durable Object class, so the
          // `ctx.exports.FakeBookingSystemGatekeeper({props})` the account hands out is one
          // `ctx.facets.get()` accepts.
          FAKE_BOOKING_SYSTEM_GATEKEEPER: {
            className: "FakeBookingSystemGatekeeper",
            useSQLite: true,
          },
          TEST_HOST: { className: "TestHost", useSQLite: true },
        },
      },
    }),
  ],
  // The agent-facing types are served from a `types.txt -> types.d.ts` symlink imported as a Text
  // module. Resolved through the link, Vite would load the `.d.ts` as an empty TS module instead.
  resolve: { preserveSymlinks: true },
  test: {
    include: ["__tests__/*.test.ts"],
    testTimeout: 20_000,
    setupFiles: ["@composable-os/gatekeeper-interface/testing/assert-workerd"],
    // As the accounting contract's: a wrapped method that rejects also surfaces as an unhandled
    // rejection marked `remote`, although the caller received the error and the test asserted it.
    onUnhandledError(error) {
      return (error as { remote?: unknown }).remote === true ? false : undefined;
    },
  },
});
