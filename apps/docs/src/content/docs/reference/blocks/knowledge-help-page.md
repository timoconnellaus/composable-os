---
title: "knowledge-help-page"
description: "One help page (stage 38 step 6, ADR 0708), for a site's /help/&lt;address&gt; page: its title, summary and body as the public reads it (`useHelpPage`: the published version only, ADR 0442), and its related pages."
editUrl: false
---

One help page (stage 38 step 6, ADR 0708), for a site's /help/&lt;address&gt; page: its title, summary and body as the public reads it (`useHelpPage`: the published version only, ADR 0442), and its related pages. An old address answers `redirect`: the page links to the address it has now and, once it has drawn in the browser, calls `onRedirect` with it once (never while rendering). A site that sends a 301 does it in its route's loader on the server, from the same `content.get` answer. A link to a section (`#<anchor>`, from search) lands on its heading: the renderer gives each heading the host's anchor as its id. The body is drawn by the Content pack's renderer only (`content-rich-text`): React elements, never HTML, links as the host checked them, pictures from the site's media route, which serves only pictures a published page shows.

<img class="cos-screen" src="/screens/knowledge-help-page.png" alt="knowledge-help-page, drawn with dummy data" width="860" height="557" loading="lazy" decoding="async" />

Drawn with dummy data.

|  |  |
| --- | --- |
| Skin | web |
| Pack | [knowledge](/packs/knowledge/screens/) |
| Add it | `cos add knowledge-help-page` |
| Files | `help-page.tsx`, `LICENSE` |
| Depends on | [content-rich-text](/reference/blocks/content-rich-text/) |
| Packages | `@composable-os/pack-knowledge` |

## Operations it calls

Through its hooks; the host decides what each caller may do.

- [`content.get`](/reference/operations/content/#contentget)
- [`content.list`](/reference/operations/content/#contentlist)

Source: [packs/knowledge/blocks/knowledge-help-page](https://github.com/timoconnellaus/composable-os/tree/main/packs/knowledge/blocks/knowledge-help-page).
