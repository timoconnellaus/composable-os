// The web app's own tests (test/): the browser build and the screens' ScreenHost, in Node. Its own
// config, so vitest does not load the server build's plugins (vite.config.ts).
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // The browser build test makes two builds.
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
