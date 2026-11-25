---
title: "content-post-list"
description: "The published posts, newest first, for a site's /blog page (stage 28): each with its cover, title, date and excerpt, and a link to it."
editUrl: false
---

The published posts, newest first, for a site's /blog page (stage 28): each with its cover, title, date and excerpt, and a link to it. What is published is the host's (`usePosts`).

<img class="cos-screen" src="/screens/content-post-list.png" alt="content-post-list, drawn with dummy data" width="640" height="1871" loading="lazy" decoding="async" />

Drawn with dummy data.

|  |  |
| --- | --- |
| Skin | web |
| Pack | [content](/packs/content/screens/) |
| Add it | `cos add content-post-list` |
| Files | `post-list.tsx`, `LICENSE` |
| Depends on | [ui-button](/reference/blocks/ui-button/), [ui-card](/reference/blocks/ui-card/) |
| Packages | `@composable-os/pack-content` |

## Operations it calls

Through its hooks; the host decides what each caller may do.

- [`content.list`](/reference/operations/content/#contentlist)

Source: [packs/content/blocks/content-post-list](https://github.com/timoconnellaus/composable-os/tree/main/packs/content/blocks/content-post-list).
