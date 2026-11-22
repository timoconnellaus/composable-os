# apps/marketing

The site at [composableos.dev](https://composableos.dev) (ADR 0465): Zero BS AI builds a company's
own software on Composable OS and looks after it on one subscription. A static Astro site served
by the `cos-site` Worker, which also answers `POST /api/signup` (the call form) and stores
submissions in its own D1 database. No trackers: the build fails if any page loads anything from
another origin or mentions a known analytics tool (`scripts/check-static.mjs`).

**[`SITE.md`](SITE.md) says what the site claims, section by section.** Read it to see whether a
change elsewhere in the repository touches the site, and keep it true when the page changes
(`AGENTS.md`, "The site").

```sh
pnpm --filter @composable-os/marketing dev          # http://localhost:4321 (pages only, no form API)
pnpm --filter @composable-os/marketing build        # dist/, then the no-tracker check
pnpm --filter @composable-os/marketing test         # the form endpoint in workerd against local D1
pnpm --filter @composable-os/marketing preview      # build + local D1 migrations + wrangler dev
pnpm --filter @composable-os/marketing test:e2e     # Playwright against the built site and Worker
pnpm --filter @composable-os/marketing screenshots  # screenshots/{390,834,1280}.jpg, and gyms-<width>.jpg
pnpm --filter @composable-os/marketing og-image     # re-render public/og.png and the touch icon
```

## Layout

- `src/pages/index.astro` is the landing page; each section is a component in `src/components`,
  in page order: `Hero` (with the facts bar), `Problem`, `HowItWorks`, `Pieces`, `Inside`, `Care`,
  `Control`, `Developers`, `Faq`, `FinalCta` (with `CallForm`). `Page.astro` is the shell
  (metadata, fonts, the icon sprite, and the frame holding the header, the page and the footer).
- `src/pages/solutions/[slug].astro` is a solution's page (`/solutions/gyms/`), one per entry in
  `src/solutions.ts`, which also feeds the home page's `Solutions` section. Each has its own
  call form at `#call`. A new solution is an entry there plus its URL in `public/sitemap.xml`.
- `src/status.ts` holds the status words a piece can have (`StatusPill`); `SITE.md` defines them.
- `src/styles/base.css` holds the design tokens and shared pieces; `landing.css` the sections.
- `src/links.ts` holds the links and `CTA`, the label of the page's one action. `src/faq.ts` holds
  the questions, read by the section and by the page's FAQPage structured data.
- `src/scripts/site.ts` is the only client code: the header, the menu, reveal on scroll and the
  form's background post.
- Poppins is self-hosted from `@fontsource/poppins`, latin only, four weights.

## Rules

- **Follow the `landing-page-generator` skill** (`.claude/skills/landing-page-generator`) for any
  change to the page, and run its three checks on every built page that sells (the home page and
  each solution's). All must exit 0:

  ```sh
  pnpm --filter @composable-os/marketing build
  for page in index.html solutions/gyms/index.html; do
    python3 .claude/skills/landing-page-generator/scripts/cta_analyzer.py apps/marketing/dist/$page
    python3 .claude/skills/landing-page-generator/scripts/conversion_checklist.py apps/marketing/dist/$page
    python3 .claude/skills/landing-page-generator/scripts/page_speed_estimator.py apps/marketing/dist/$page
  done
  ```

  The checklist's "minimal navigation" line stays failed on purpose: this is a site page with a
  short menu, not a campaign page. Its proof lines stay failed until there is real proof.
- **One action.** Every button that asks for something says `CTA` ("Book a call") and leads to
  `#call`. A second action gets one other label, as a ghost button or a text link.
- **No invented proof.** No testimonial, logo, count or rating that can't be sourced. Ghetto's
  quote and case study go in after `Pieces` when they exist.
- **Light only.** There is no dark theme.
- **The page works without JavaScript.** Content is visible and the form posts normally: the
  Worker redirects to `/thanks/`.
- **Motion follows `.claude/skills/animate`:** transform and opacity only, strong ease-out curves,
  short UI durations, hover effects only on `(hover: hover) and (pointer: fine)`, and reduced
  motion keeps gentle fades but no movement.
- **Copy** follows [avoid-ai-writing](https://github.com/conorbronsdon/avoid-ai-writing): no em
  dashes, sentence-case headings. It is written for an owner or operations lead, so it stays
  non-technical until the developer section.
- The commands in `Developers.astro` match `docs/deploying.md` ("A company's own product").
- The endpoint still accepts a `waitlist` submission (the first site's forms, `src/team-size.ts`);
  the page no longer has one, and the rows already stored stay.

Deploys go through `.github/workflows/marketing.yml` on pushes to `main`, once the
`MARKETING_CLOUDFLARE_API_TOKEN` and `MARKETING_CLOUDFLARE_ACCOUNT_ID` secrets exist. Read
requests with `wrangler d1 execute cos-site --remote --command "SELECT * FROM marketing_signup WHERE kind = 'sales'"`.
