import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const dir = dirname(fileURLToPath(import.meta.url));
const here = (path: string) => join(dir, path);

// The blocks driven in a DOM (`*.dom.test.tsx` here): clicked, as a person does, in happy-dom
// under Node; workerd, where the other tests run, has no DOM. The blocks' sibling imports are
// joined as in the pack's vitest.config.ts.
export default defineConfig({
  test: {
    environment: "happy-dom",
    include: ["test/**/*.dom.test.tsx"],
  },
  resolve: {
    alias: [
      { find: "react-native", replacement: here("./react-native-shim.tsx") },
      {
        find: /^\.\.\/(ui-[a-z]+|native-base)\//,
        replacement: `${here("../../../blocks")}/$1/`,
      },
      {
        find: /^\.\.\/(content-rich-text|content-native-rich-text)\//,
        replacement: `${here("../../content/blocks")}/$1/`,
      },
    ],
  },
});
