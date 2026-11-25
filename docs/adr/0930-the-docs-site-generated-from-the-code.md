# ADR 0930: The docs site, generated from the code and checked in CI

Status: accepted, 2026-11-24 (the docs site's foundation, `feat/docs-site`; the owner decided its
address and that it carries no caveats the same day). Builds on ADRs
[0003](0003-operations-registry.md), [0401](0401-platform-packs-screens.md),
[0404](0404-behaviours-are-the-vocabulary.md), [0424](0424-blocks-as-built.md) and
[0465](0465-the-site-sells-a-built-and-maintained-product.md) (the look).

## Context
The platform grows by many pull requests a day, from sessions working in parallel. The only
technical description was `docs/architecture.md` and the stage specs: long, written once per
stage, and not checked against the code. A reader who wants to know what a pack's tools are, who
may call an operation or what a block calls had to read the source. Documentation written apart
from the code goes stale as soon as the code moves on.

## Decision
- **A technical documentation site, `apps/docs`**, built with Astro Starlight (the repository
  already builds `apps/marketing` with Astro), served at **docs.composableos.dev** (the owner's
  decision) by a Worker of static assets, `cos-docs`, deployed as the marketing site is: by a
  workflow on pushes to `main` that change it or its sources, with the marketing site's deploy
  secrets, skipped while they are not set. Its look is the marketing site's where Starlight allows:
  Poppins, navy and lime, a pale blue frame, light only.
- **Most of it is generated from the code.** `apps/docs/scripts/generate.mjs`, run with Node and
  no network, reads: every pack's manifest (objects and fields, relations, behaviours, tools with
  their description, audiences, risk and permission, roles and grants, screens, routine mail,
  settings, automations, what it requires), every block's `block.json` and its first file's header,
  every core operation in the registry (name, description, audiences, permission, risk, actors,
  input and output schemas as field tables), the behaviours an object may declare (`ObjectSpec` in
  the SDK), the gatekeepers' packages and contracts, the `cos` command's help, the products and
  the client template, the roadmap's stages and `CONTEXT.md`. The packs and the registry are
  TypeScript that imports `cloudflare:*`, so the generator bundles one entry with esbuild, stubs
  those modules and reads the definitions; nothing is run against a database.
- **The rest is written beside the code it describes**, so it changes in the same pull request:
  `packs/<id>/docs/overview.md` for a pack, `packages/<package>/src/<area>/docs/overview.md` for a
  core capability documented as a unit (Agreements first), and `docs/guides/*.md` for cross-cutting
  topics. An overview has front matter (title, summary, stage, spec, ADRs; for a capability its
  operation prefixes, blocks and behaviours) and the sections "What it is for", "Concepts", "How the
  pieces fit", "Main flows" and "What is built".
- **Generated pages are committed and never edited by hand.** The whole of
  `apps/docs/src/content/docs/`, `src/sidebar.json` and `public/llms.txt` are the generator's. A
  pull request shows what its change does to the documentation, and a reviewer sees it.
- **CI enforces it.** The generator's `--check` fails when a generated page differs from its
  sources, when a pack, block, core operation or gatekeeper has no reference page, when a pack has
  no overview and is not on the pending list (`apps/docs/docs.config.mjs`, which only shrinks),
  when an overview lacks a section or names an ADR or a spec that does not exist, when an internal link or
  anchor is broken, when a page names a client, or when hand-written text shows a price. It runs in
  the lint job, and the site's build (with a second link check over the built pages) in the
  typecheck job. The documents lane, which has no install, runs `--check --markdown-only`: the
  pages made from Markdown alone (guides, overviews, decisions, the glossary, Planned).
- **Words.** `CONTEXT.md` says to avoid "module" for a pack, so the site's units are **packs** and
  **capabilities**. A pack's pages are its overview, data model, operations and tools, permissions
  and roles, screens, messages, settings and decisions; a capability's are its overview,
  operations, permissions, behaviours, screens and decisions.
- **Only what is built.** A page documents what the code does, plainly, with no status badges or
  caveats (the owner's decision). A stage with a spec and no pack or capability pages is one line
  on the Planned page, linking its spec. The docs follow `main`; the versions page says so.
- **Search** is Starlight's (Pagefind, built with the site, nothing fetched from another origin).
  **`/llms.txt`** lists every page with its description, from the same page set.
- **No client's name, business details or prices.** A name in `docs.config.mjs` fails the check
  wherever a reader would see it, in any case and inside identifiers, except on the glossary and
  Planned, whose sources (`CONTEXT.md`, the roadmap) name a client: there it becomes "the first
  client". A price in hand-written text fails the check. Generated pages carry no
  repository-wide counts, which parallel pull requests would merge cleanly into a wrong number.

## Consequences
- A pull request that adds or changes a pack, a block or an operation runs
  `pnpm --filter @composable-os/docs generate` and updates the overview in the same pull request
  (AGENTS.md, CONTRIBUTING.md). Two pull requests changing the same generated page conflict there;
  either side is taken and the generator run again. Combining pull requests (a batch, or merging
  `main`) is followed by running the generator, even with no conflict.
- The nine packs without an overview carry generated pages that say so, until their overviews are
  written and they leave the pending list.
- The first deploy needs the marketing token to be allowed to make the `docs.composableos.dev`
  custom domain on its zone, which it already is for `composableos.dev`.
- Which release last shipped each pack is not recorded per pack, so the versions page does not
  give it.

## Amendment (2026-11-25): pictures of the screens

Every block's reference page, and each pack's and capability's Screens page, shows a picture of the
block drawn with dummy data. The pictures are drawn by `apps/screens`, not by hand:

- A block is mounted as a client app mounts it, with its pack's real hooks factory, over a fake
  client that answers each operation from the block's preview (`apps/screens/previews/<block>.tsx`).
  The answers are typed by the operations' outputs, so a contract change the dummy data no longer
  fits fails the typecheck. A query the preview does not answer fails the picture.
- Web blocks are drawn in the client template's look; native blocks through react-native-web on a
  phone's screen. The clock is fixed, so a picture changes only when its inputs do.
- The pictures are committed (`apps/docs/public/screens/`) with a manifest of each one's
  fingerprint: the block and the blocks it depends on, its pack's headless entry, the harness, its
  preview and the dummy data it imports. The docs check fails when a block has no preview or its
  picture is stale, so a pull request that changes a block runs
  `pnpm --filter @composable-os/screens shoot` in the same pull request. Pixels are not compared:
  fonts differ between machines, and a fingerprint says what a pixel comparison would, reliably.
- The owner chose web and native blocks alike, all in one pull request.
