---
title: "ticketing-native-scanner"
description: "The door scanner, for the staff app (stage 27): the camera reads a code, the host checks it in, and the screen says clearly let in or not and why, with a haptic, and counts who was let in on this device."
editUrl: false
---

The door scanner, for the staff app (stage 27): the camera reads a code, the host checks it in, and the screen says clearly let in or not and why, with a haptic, and counts who was let in on this device. Whether a ticket is valid, used or void, and what is owed, is the host's (`useCheckIn`); the camera and haptics are the app's (for example `expo-camera` and `expo-haptics`), so this block needs neither package.

|  |  |
| --- | --- |
| Skin | native |
| Pack | [ticketing](/packs/ticketing/screens/) |
| Add it | `cos add ticketing-native-scanner` |
| Files | `door-scanner-screen.tsx`, `LICENSE` |
| Depends on | [native-base](/reference/blocks/native-base/) |
| Packages | `@composable-os/pack-ticketing` |

## Operations it calls

Through its hooks; the host decides what each caller may do.

- [`x.ticketing.checkIn`](/packs/ticketing/tools/#checkin)

Source: [packs/ticketing/blocks/ticketing-native-scanner](https://github.com/timoconnellaus/composable-os/tree/main/packs/ticketing/blocks/ticketing-native-scanner).
