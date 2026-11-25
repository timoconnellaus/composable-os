---
title: "content-native-post"
description: "One post, for the mobile app (stage 28): its title, date, cover and body as the public reads it (`usePost`: the published version only)."
editUrl: false
---

One post, for the mobile app (stage 28): its title, date, cover and body as the public reads it (`usePost`: the published version only). An old address goes to the post's address now.

<img class="cos-screen cos-screen-native" src="/screens/content-native-post.png" alt="content-native-post, drawn with dummy data" width="390" height="844" loading="lazy" decoding="async" />

Drawn with dummy data.

|  |  |
| --- | --- |
| Skin | native |
| Pack | [content](/packs/content/screens/) |
| Add it | `cos add content-native-post` |
| Files | `post-screen.tsx`, `LICENSE` |
| Depends on | [content-native-rich-text](/reference/blocks/content-native-rich-text/), [native-base](/reference/blocks/native-base/) |
| Packages | `@composable-os/pack-content` |

## Operations it calls

Through its hooks; the host decides what each caller may do.

- [`content.get`](/reference/operations/content/#contentget)

Source: [packs/content/blocks/content-native-post](https://github.com/timoconnellaus/composable-os/tree/main/packs/content/blocks/content-native-post).
