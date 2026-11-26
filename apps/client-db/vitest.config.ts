import { defineWorkersTestConfig } from "@composable-os/config/vitest";

export default defineWorkersTestConfig({
  // The Worker as deployed, from wrangler.jsonc.
  workers: async () => ({ wrangler: { configPath: "./wrangler.jsonc" } }),
});
