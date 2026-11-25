---
title: "content-rich-text"
description: "Rich text for the web (stage 28, ADR 0440): a post's body drawn block by block with React elements, never as HTML."
editUrl: false
---

Rich text for the web (stage 28, ADR 0440): a post's body drawn block by block with React elements, never as HTML. Every block type and mark of the platform's schema has its element here; restyle them with the classes, or pass `components` to use the app's own for any of them. Nothing is injected as markup: text is React text (escaped by React), a link's address is the host's checked one, a picture is the host's media route, and a video is played from YouTube's or Vimeo's own player address built from the id, never from the raw URL. An embed that is neither is a link.

<img class="cos-screen" src="/screens/content-rich-text.png" alt="content-rich-text, drawn with dummy data" width="760" height="943" loading="lazy" decoding="async" />

Drawn with dummy data.

|  |  |
| --- | --- |
| Skin | web |
| Pack | [content](/packs/content/screens/) |
| Add it | `cos add content-rich-text` |
| Files | `rich-text.tsx`, `LICENSE` |
| Depends on | [ui-button](/reference/blocks/ui-button/) |
| Packages | `@composable-os/pack-content` |

## Operations it calls

Through its hooks; the host decides what each caller may do.

None.

Source: [packs/content/blocks/content-rich-text](https://github.com/timoconnellaus/composable-os/tree/main/packs/content/blocks/content-rich-text).
