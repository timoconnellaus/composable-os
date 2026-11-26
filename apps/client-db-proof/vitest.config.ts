import { defineWorkersTestConfig } from "@composable-os/config/vitest";

export default defineWorkersTestConfig({
  workers: async () => ({
    // The Worker as deployed: its D1 database, its ClientDb class and vars, from wrangler.jsonc.
    wrangler: { configPath: "./wrangler.jsonc" },
    miniflare: {
      bindings: {
        PROOF_KEY: "test-proof-key",
        COS_TIMING_RUNS: process.env.COS_TIMING_RUNS ?? "",
      },
    },
  }),
});
