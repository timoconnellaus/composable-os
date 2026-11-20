// A fully static build (no adapter): dist/ is served by the cos-site Worker as static assets.
// The site has its own "soft chrome" styles (src/styles); the app demo reuses the app's shadcn
// neutral values. Stylesheets are inlined (one page, no render-blocking CSS request) and the only
// client code is two small vanilla modules (src/scripts).
import { defineConfig } from "astro/config";

export default defineConfig({
  site: "https://composableos.dev",
  output: "static",
  trailingSlash: "ignore",
  build: { inlineStylesheets: "always" },
  // No Astro dev toolbar or telemetry-backed extras in the page.
  devToolbar: { enabled: false },
});
