import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const dir = dirname(fileURLToPath(import.meta.url));

// The blocks drawn where they sit, in Node: React Native is drawn with plain elements in its place
// (test/react-native-shim.tsx). The template mobile app's Account tab imports its copied blocks
// as `./blocks/<block>/…` (src/blocks/ in a client repo, which cos create fills): read here from
// this folder, as its tsconfig.platform.json does; its own account-sections.gen.ts stays its own.
export default defineConfig({
  test: { include: ["test/**/*.test.tsx"], testTimeout: 30_000 },
  resolve: {
    alias: [
      { find: "react-native", replacement: join(dir, "test/react-native-shim.tsx") },
      { find: /^\.\/blocks\/((?:native|web)-[a-z-]+)\//, replacement: `${dir}/$1/` },
    ],
  },
});
