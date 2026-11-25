---
title: "native-sign-in"
description: "Sign-in with a code by email, for the mobile app."
editUrl: false
---

Sign-in with a code by email, for the mobile app. The host sends the code and makes the session; this screen only asks for the address and the code and calls what it is given. When a call fails (sign-in not switched on, too many tries, offline) it says so in plain words.

<img class="cos-screen cos-screen-native" src="/screens/native-sign-in.png" alt="native-sign-in, drawn with dummy data" width="390" height="844" loading="lazy" decoding="async" />

Drawn with dummy data.

|  |  |
| --- | --- |
| Skin | native |
| Pack | the base layer |
| Add it | `cos add native-sign-in` |
| Files | `sign-in-screen.tsx`, `LICENSE` |
| Depends on | [native-base](/reference/blocks/native-base/) |
| Packages | `@composable-os/client` |

## Operations it calls

Through its hooks; the host decides what each caller may do.

None.

Source: [blocks/native-sign-in](https://github.com/timoconnellaus/composable-os/tree/main/blocks/native-sign-in).
