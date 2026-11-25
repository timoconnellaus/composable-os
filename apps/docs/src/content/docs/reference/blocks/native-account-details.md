---
title: "native-account-details"
description: "Your details (stage 48), for the mobile app: the signed-in customer's name and phone, to change, and the address they sign in with."
editUrl: false
---

Your details (stage 48), for the mobile app: the signed-in customer's name and phone, to change, and the address they sign in with. What is saved is the host's (me.get, me.update): only what changed is sent, and the host checks it again. A section's content: the shell gives it a screen. Their birthday, day and month only (stage 53: me.birthday.get, me.birthday.set), where the client holds them.

<img class="cos-screen cos-screen-native" src="/screens/native-account-details.png" alt="native-account-details, drawn with dummy data" width="390" height="844" loading="lazy" decoding="async" />

Drawn with dummy data.

|  |  |
| --- | --- |
| Skin | native |
| Pack | the base layer |
| Add it | `cos add native-account-details` |
| Files | `details.tsx`, `LICENSE` |
| Depends on | [native-base](/reference/blocks/native-base/) |
| Packages | `@composable-os/client` |

## Operations it calls

Through its hooks; the host decides what each caller may do.

- [`me.get`](/reference/operations/me/#meget)
- [`me.update`](/reference/operations/me/#meupdate)
- [`me.birthday.get`](/reference/operations/me/#mebirthdayget)
- [`me.birthday.set`](/reference/operations/me/#mebirthdayset)

Source: [blocks/native-account-details](https://github.com/timoconnellaus/composable-os/tree/main/blocks/native-account-details).
