import { defineWorkersTestConfig } from "@composable-os/config/vitest";
import { TEST_PROPS_KEY, TEST_PROPS_KEY_PREVIOUS } from "@composable-os/db/testing/vitest";

export default defineWorkersTestConfig({
  // The Worker as deployed, from wrangler.jsonc, with the props keys the deploy engine sets as its
  // secrets (#515, S1 and S4): the one now and the one before a rotation.
  workers: async () => ({
    wrangler: { configPath: "./wrangler.jsonc" },
    miniflare: {
      bindings: {
        COS_PROPS_KEY: TEST_PROPS_KEY,
        COS_PROPS_KEY_PREVIOUS: TEST_PROPS_KEY_PREVIOUS,
        // The environment it serves, in every proof it accepts (review of #520, M4).
        COS_HOST_ENVIRONMENT: "live",
        // The keys again under names the Worker does not read, for the tests' own proofs.
        TEST_PROPS_KEY,
        TEST_PROPS_KEY_PREVIOUS,
      },
    },
  }),
});
