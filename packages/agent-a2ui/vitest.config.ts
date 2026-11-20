import { defineWorkersTestConfig } from "@composable-os/config/vitest";

export default defineWorkersTestConfig({
  include: ["test/**/*.test.{ts,tsx}"],
  workers: {
    miniflare: { compatibilityDate: "2026-10-01", compatibilityFlags: ["nodejs_compat"] },
  },
});
