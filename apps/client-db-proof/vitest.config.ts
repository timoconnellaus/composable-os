import { defineWorkersTestConfig } from "@composable-os/config/vitest";
import { clientDbWorker } from "@composable-os/db/testing/vitest";

export default defineWorkersTestConfig({
  workers: async () => ({
    // The Worker as deployed: its D1 database, its bindings and vars, from wrangler.jsonc; and,
    // beside it, the Worker its clients' databases are in, as deploy.mjs deploys apps/client-db.
    wrangler: { configPath: "./wrangler.jsonc" },
    miniflare: {
      bindings: {
        PROOF_KEY: "test-proof-key",
        COS_TIMING_RUNS: process.env.COS_TIMING_RUNS ?? "",
      },
      workers: [await clientDbWorker("cos-client-db-proof-db")],
    },
  }),
});
