// The docs site (ADR 0930): Astro Starlight, fully static (no adapter). dist/ is served by the
// cos-docs Worker as static assets, as the marketing site's is. Every page under
// src/content/docs, the sidebar (src/sidebar.json) and public/llms.txt are written by
// scripts/generate.mjs from the code and the Markdown beside it; nobody edits them by hand.
// The look follows the marketing site's (ADR 0465) where Starlight allows: Poppins, navy and
// lime, a pale blue page, light only.
import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";
import sidebar from "./src/sidebar.json" with { type: "json" };

export default defineConfig({
  site: "https://docs.composableos.dev",
  output: "static",
  trailingSlash: "ignore",
  devToolbar: { enabled: false },
  integrations: [
    starlight({
      title: "Composable OS docs",
      description:
        "Technical documentation for Composable OS, generated from the code and written beside it.",
      logo: { src: "./src/assets/mark.svg", alt: "" },
      favicon: "/favicon.svg",
      social: [
        {
          icon: "github",
          label: "The repository",
          href: "https://github.com/timoconnellaus/composable-os",
        },
      ],
      sidebar,
      customCss: ["./src/styles/fonts.css", "./src/styles/theme.css"],
      // Light only, as the marketing site is: no theme picker, and the page is always light.
      components: {
        ThemeProvider: "./src/components/ThemeProvider.astro",
        ThemeSelect: "./src/components/ThemeSelect.astro",
      },
      tableOfContents: { minHeadingLevel: 2, maxHeadingLevel: 3 },
      pagination: false,
    }),
  ],
});
