import { fileURLToPath } from "node:url";
import { defineWorkersTestConfig } from "@composable-os/config/vitest";
import { mergeConfig } from "vitest/config";

// The Workers target: the runtime, and a client generated against it, in workerd as a client's
// own Worker runs them. The generated client imports the runtime by its package name.
export default mergeConfig(
  defineWorkersTestConfig({
    workers: {
      miniflare: { compatibilityDate: "2026-10-01", compatibilityFlags: ["nodejs_compat"] },
    },
    include: ["test/**/*.test.ts"],
  }),
  {
    resolve: {
      alias: { "@composable-os/client": fileURLToPath(new URL("./src/index.ts", import.meta.url)) },
    },
  },
);
