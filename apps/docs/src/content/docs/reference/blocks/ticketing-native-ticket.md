---
title: "ticketing-native-ticket"
description: "One ticket with its code, for the mobile app (stage 27): a QR carrying the code alone, large on a white card, with the screen at full brightness while it is shown and as it was afterwards."
editUrl: false
---

One ticket with its code, for the mobile app (stage 27): a QR carrying the code alone, large on a white card, with the screen at full brightness while it is shown and as it was afterwards. The app gives the QR drawing and the brightness control it uses (for example `react-native-qrcode-svg` and `expo-brightness`), so this block needs neither package.

|  |  |
| --- | --- |
| Skin | native |
| Pack | [ticketing](/packs/ticketing/screens/) |
| Add it | `cos add ticketing-native-ticket` |
| Files | `ticket-screen.tsx`, `LICENSE` |
| Depends on | [native-base](/reference/blocks/native-base/) |
| Packages | none |

## Operations it calls

Through its hooks; the host decides what each caller may do.

None.

Source: [packs/ticketing/blocks/ticketing-native-ticket](https://github.com/timoconnellaus/composable-os/tree/main/packs/ticketing/blocks/ticketing-native-ticket).
