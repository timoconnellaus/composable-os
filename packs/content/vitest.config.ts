import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineWorkersTestConfig } from "@composable-os/config/vitest";
import { mergeConfig } from "vitest/config";

const dir = dirname(fileURLToPath(import.meta.url));
const here = (path: string) => join(dir, path);

// The renderer test draws the blocks where they sit. Their base-layer imports are siblings, as
// after `cos add` (`../ui-button/…`, `../native-base/…`): joined here to the platform's `blocks/`,
// as the blocks' tsconfigs do with `rootDirs`. React Native is drawn with plain elements in its
// place (test/react-native-shim.tsx); nothing else in the pack imports it.
export default mergeConfig(
  defineWorkersTestConfig({
    workers: {
      miniflare: { compatibilityDate: "2026-10-01", compatibilityFlags: ["nodejs_compat"] },
    },
    include: ["test/**/*.test.ts", "test/**/*.test.tsx"],
  }),
  {
    resolve: {
      alias: [
        { find: "react-native", replacement: here("./test/react-native-shim.tsx") },
        {
          find: /^\.\.\/(ui-[a-z]+|native-base)\//,
          replacement: `${here("../../blocks")}/$1/`,
        },
      ],
    },
  },
);
