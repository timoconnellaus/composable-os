---
title: "rostering-native-my-calendar"
description: "My calendar in the app (stage 45 step 7, over step 5's feed, ADR 0628): whether I have a private calendar address for my own shifts, making one (or a new one, which stops the old), and switching it off."
editUrl: false
---

My calendar in the app (stage 45 step 7, over step 5's feed, ADR 0628): whether I have a private calendar address for my own shifts, making one (or a new one, which stops the old), and switching it off. The address is shown once, as the host gives it, then copied (the app's own clipboard, passed as `copy`) or opened in the phone's calendar (`openUrl`, React Native's Linking.openURL, with the webcal address); it is never stored, and is cleared when the screen closes. A lost address is never shown again: make a new one. The same headless entry as the web's screen.

<img class="cos-screen cos-screen-native" src="/screens/rostering-native-my-calendar.png" alt="rostering-native-my-calendar, drawn with dummy data" width="390" height="844" loading="lazy" decoding="async" />

Drawn with dummy data.

|  |  |
| --- | --- |
| Skin | native |
| Pack | [rostering](/packs/rostering/screens/) |
| Add it | `cos add rostering-native-my-calendar` |
| Files | `my-calendar-screen.tsx`, `LICENSE` |
| Depends on | [native-base](/reference/blocks/native-base/) |
| Packages | `@composable-os/pack-rostering` |

## Operations it calls

Through its hooks; the host decides what each caller may do.

- [`x.rostering.feed`](/packs/rostering/tools/#feed)
- [`x.rostering.feedRotate`](/packs/rostering/tools/#feedrotate)
- [`x.rostering.feedRevoke`](/packs/rostering/tools/#feedrevoke)

Source: [packs/rostering/blocks/rostering-native-my-calendar](https://github.com/timoconnellaus/composable-os/tree/main/packs/rostering/blocks/rostering-native-my-calendar).
