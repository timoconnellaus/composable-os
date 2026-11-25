---
title: "native-base"
description: "The native base layer's look, in one place."
editUrl: false
---

The native base layer's look, in one place. Every text, icon and surface a native block draws takes its colour from here (the block lint refuses a colour of a block's own), so a dark theme is these values changed. The brand colours come from `../brand.ts`, which cos writes from product.ts (`mobile.app.colours`); the rest is the base layer's and may be edited.

<img class="cos-screen cos-screen-native" src="/screens/native-base.png" alt="native-base, drawn with dummy data" width="390" height="844" loading="lazy" decoding="async" />

Drawn with dummy data.

|  |  |
| --- | --- |
| Skin | native |
| Pack | the base layer |
| Add it | `cos add native-base` |
| Files | `theme.ts`, `screen.tsx`, `list.tsx`, `row.tsx`, `sheet.tsx`, `tab-bar.tsx`, `button.tsx`, `field.tsx`, `text.tsx`, `LICENSE` |
| Depends on | nothing |
| Packages | none |

## Operations it calls

Through its hooks; the host decides what each caller may do.

None.

Source: [blocks/native-base](https://github.com/timoconnellaus/composable-os/tree/main/blocks/native-base).
