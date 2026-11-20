// Local config (upstream's also wires the error reporter and tail worker that the modules we do
// not vendor need). `nodejs_als` is what observability-context.ts requires.
import { defineWorkersTestConfig } from "@composable-os/config/vitest";

export default defineWorkersTestConfig({
  workers: {
    miniflare: {
      compatibilityDate: "2026-09-04",
      compatibilityFlags: ["nodejs_als"],
    },
  },
  include: ["__tests__/*.test.ts"],
  setupFiles: ["@composable-os/gatekeeper-interface/testing/assert-workerd"],
});
