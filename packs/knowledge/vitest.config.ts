import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineWorkersTestConfig } from "@composable-os/config/vitest";
import { mergeConfig } from "vitest/config";

const dir = dirname(fileURLToPath(import.meta.url));
const here = (path: string) => join(dir, path);

// The block tests draw the blocks where they sit. Their sibling imports are as after `cos add`
// (`../ui-button/…`, `../native-base/…`, Content's `../content-rich-text/…`): joined here to the
// platform's `blocks/` and Content's `blocks/`, as the blocks' tsconfigs do with `rootDirs`. React
// Native is drawn with plain elements in its place (test/react-native-shim.tsx).
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
        {
          find: /^\.\.\/(content-rich-text|content-native-rich-text)\//,
          replacement: `${here("../content/blocks")}/$1/`,
        },
      ],
    },
  },
);
