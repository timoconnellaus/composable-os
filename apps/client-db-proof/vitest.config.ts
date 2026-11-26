import { defineWorkersTestConfig } from "@composable-os/config/vitest";
import {
  clientDbQueriesBinding,
  clientDbWorker,
  TEST_PROPS_KEY,
} from "@composable-os/db/testing/vitest";

export default defineWorkersTestConfig({
  workers: async () => ({
    // The Worker as deployed: its D1 database, its bindings and vars, from wrangler.jsonc; and,
    // beside it, the Worker its clients' databases are in, as deploy.mjs deploys apps/client-db.
    wrangler: { configPath: "./wrangler.jsonc" },
    miniflare: {
      bindings: {
        PROOF_KEY: "test-proof-key",
        // The props key deploy.mjs sets as both Workers' secret, and the binding's props (S1).
        COS_PROPS_KEY: TEST_PROPS_KEY,
        COS_HOST_ENVIRONMENT: "live",
        COS_TIMING_RUNS: process.env.COS_TIMING_RUNS ?? "",
      },
      serviceBindings: {
        CLIENT_DB_QUERIES: clientDbQueriesBinding("cos-app", "cos-client-db-proof-db"),
      },
      workers: [await clientDbWorker("cos-client-db-proof-db")],
    },
  }),
});
