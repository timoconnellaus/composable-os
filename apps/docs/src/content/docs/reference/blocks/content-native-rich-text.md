---
title: "content-native-rich-text"
description: "Rich text for the mobile app (stage 28, ADR 0440): a post's body drawn block by block with React Native's own components, from the same structured data the web block draws."
editUrl: false
---

Rich text for the mobile app (stage 28, ADR 0440): a post's body drawn block by block with React Native's own components, from the same structured data the web block draws. Every block type and mark has its element here; its look is the native base layer's theme. Pass `components` to use the app's own for a block type, and `openUrl` (React Native's `Linking.openURL`, or the app's in-app browser) for links, buttons and videos. No web view: an embed is a tappable card that opens the video (or the link) outside the app.

|  |  |
| --- | --- |
| Skin | native |
| Pack | [content](/packs/content/screens/) |
| Add it | `cos add content-native-rich-text` |
| Files | `rich-text-view.tsx`, `LICENSE` |
| Depends on | [native-base](/reference/blocks/native-base/) |
| Packages | `@composable-os/pack-content` |

## Operations it calls

Through its hooks; the host decides what each caller may do.

None.

Source: [packs/content/blocks/content-native-rich-text](https://github.com/timoconnellaus/composable-os/tree/main/packs/content/blocks/content-native-rich-text).
