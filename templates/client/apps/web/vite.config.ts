// The server build (`vite build`, the default deploy): TanStack Start on the web app's Worker,
// reaching the host over HOST. The browser-only build of the same screens is
// vite.browser.config.ts (`pnpm build:browser`).
import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  server: { port: Number(process.env.PORT ?? 5180), strictPort: true },
  define: { __COS_BROWSER_BUILD__: "false", __COS_HOST_URL__: '""' },
  plugins: [
    cloudflare({ viteEnvironment: { name: "ssr" } }),
    tailwindcss(),
    tanstackStart(),
    viteReact(),
  ],
});
