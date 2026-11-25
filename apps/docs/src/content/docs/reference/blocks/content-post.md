---
title: "content-post"
description: "One post, for a site's /blog/&lt;slug&gt; page (stage 28): its title, date, cover and body, as the public reads it (`usePost`: the published version only, ADR 0442)."
editUrl: false
---

One post, for a site's /blog/&lt;slug&gt; page (stage 28): its title, date, cover and body, as the public reads it (`usePost`: the published version only, ADR 0442). An old address answers `redirect`: the page calls `onRedirect` with the address the post has now, so the site sends a 301 there. A preview link's token shows the working copy instead (`PostPreview`).

<img class="cos-screen" src="/screens/content-post.png" alt="content-post, drawn with dummy data" width="860" height="1449" loading="lazy" decoding="async" />

Drawn with dummy data.

|  |  |
| --- | --- |
| Skin | web |
| Pack | [content](/packs/content/screens/) |
| Add it | `cos add content-post` |
| Files | `post-page.tsx`, `LICENSE` |
| Depends on | [content-rich-text](/reference/blocks/content-rich-text/) |
| Packages | `@composable-os/pack-content` |

## Operations it calls

Through its hooks; the host decides what each caller may do.

- [`content.get`](/reference/operations/content/#contentget)
- [`content.preview`](/reference/operations/content/#contentpreview)

Source: [packs/content/blocks/content-post](https://github.com/timoconnellaus/composable-os/tree/main/packs/content/blocks/content-post).
