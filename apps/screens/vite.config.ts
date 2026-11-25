// The preview page's build: the blocks are read where they sit (packs/<id>/blocks/<block>/ and
// blocks/), their base-layer sibling imports joined to blocks/ as the admin's build joins them
// (apps/app/pack-blocks-plugin.ts), and React Native drawn by react-native-web.
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { packBlocks } from "../app/pack-blocks-plugin.ts";

// The blocks sit outside this package, so react-native-web is named by where it is installed here.
const RN_WEB = dirname(createRequire(import.meta.url).resolve("react-native-web/package.json"));
const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

export default defineConfig({
  plugins: [packBlocks(REPO_ROOT), tailwindcss(), react()],
  resolve: {
    alias: [{ find: /^react-native$/, replacement: RN_WEB }],
    extensions: [".web.tsx", ".web.ts", ".web.js", ".tsx", ".ts", ".mjs", ".js", ".jsx", ".json"],
  },
  define: { __DEV__: "false" },
  server: { fs: { allow: [REPO_ROOT] } },
  build: { outDir: "dist", emptyOutDir: true },
});
