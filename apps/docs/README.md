# apps/docs

The technical documentation for Composable OS, at docs.composableos.dev
([ADR 0930](../../docs/adr/0930-the-docs-site-generated-from-the-code.md)): an Astro Starlight
site whose reference pages are generated from the code, and whose overviews and guides are
written beside the code they describe. A static build served by the `cos-docs` Worker (static
assets only). Search is Starlight's (Pagefind, built with the site); nothing is loaded from
another origin.

```sh
pnpm --filter @composable-os/docs generate   # write src/content/docs, src/sidebar.json, public/llms.txt
pnpm --filter @composable-os/docs check      # fail on anything stale, missing or broken (CI's lint job)
pnpm --filter @composable-os/docs dev        # http://localhost:4322
pnpm --filter @composable-os/docs build      # check, astro build, then the links over dist/
pnpm --filter @composable-os/docs preview    # build, then wrangler dev on http://localhost:4322
pnpm --filter @composable-os/docs test       # the generator's tests (node --test)
```

## Where each page comes from

| Pages | Source |
| --- | --- |
| Home, Versions | `content/index.md`, `content/versions.md` (by hand) |
| Guides | `docs/guides/*.md` (by hand) |
| A pack's overview and decisions | `packs/<id>/docs/overview.md` (by hand) |
| A pack's data model, tools, permissions, screens, messages, settings | its manifest, `packs/<id>/index.ts` |
| A capability's overview, decisions and screens | `packages/<pkg>/src/<area>/docs/overview.md` (by hand; its front matter names its operations, blocks and behaviours) |
| A capability's operations, permissions, behaviours | the core registry and the SDK |
| Core operations | the registry (`coreRegistry` in `packages/core`) |
| Behaviours | `ObjectSpec` in `packages/sdk/src/contract.ts` |
| Blocks | each `block.json` and its first file's header comment |
| Screen pictures | `public/screens/`, drawn with dummy data by [`apps/screens`](../screens/README.md) |
| Gatekeepers | each `packages/gatekeeper-*` package and its `src/types.d.ts` |
| The cos command | `HELP` in `packages/create-composable-os/src/main.ts` |
| Solutions | `products/*/product.ts` and the client template |
| Glossary | `CONTEXT.md` |
| Planned | `docs/roadmap.md`: stages with a spec and no pages here |

`scripts/extract.mjs` reads the code: it bundles one entry with esbuild (the packs and the registry
are TypeScript that imports `cloudflare:*`, stubbed here, as nothing runs) and turns definitions
into data. `scripts/sources.mjs` reads the files with Node alone, so the documents lane checks the
pages made from Markdown with no install (`--check --markdown-only`). `scripts/pages.mjs` builds
the pages; `scripts/generate.mjs` writes or checks them.

## Rules

- **Nothing under `src/content/docs/`, `src/sidebar.json` or `public/llms.txt` is edited by hand.**
  Change the source and run `generate`.
- **A pack without an overview** is on `overviewsPending` in `docs.config.mjs`. The list only
  shrinks: a new pack gets its overview in the PR that adds it, and a pack whose overview is written
  leaves the list in the same PR.
- **An overview** has front matter (`title`, `summary`, `stage`, `spec`, `adrs`) and the sections
  "What it is for", "Concepts", "How the pieces fit", "Main flows" and "What is built", in that
  order. It documents what the code does, plainly: no status badges or caveats.
- **No client's name, business details or prices.** A name in `privateNames`, in any case and
  inside identifiers, fails the check, except on the glossary and Planned, whose sources
  (`CONTEXT.md`, the roadmap) name a client: there it becomes "the first client". A price in
  hand-written text (a currency sign or code, or "dollars") fails the check.
- **Every block has a picture**, current: the check fails on a block with no preview in
  `apps/screens/previews/` or a picture drawn before its block or preview last changed. Draw them
  with `pnpm --filter @composable-os/screens shoot` and commit what it writes; `public/screens/` is
  never edited by hand either.
- **No repository-wide counts** on generated pages: two pull requests that each add an operation
  would both write the same new number, which merges cleanly and leaves the page stale.
- **The look** follows the marketing site (ADR 0465) where Starlight allows: Poppins, navy and
  lime, the pale blue frame, light only (`src/styles/theme.css`, the two theme components).

Deploys go through `.github/workflows/docs.yml` on pushes to `main` that change the site or its
sources, with the marketing site's `MARKETING_CLOUDFLARE_API_TOKEN` and
`MARKETING_CLOUDFLARE_ACCOUNT_ID` secrets; without them the deploy is skipped.
