---
title: "native-account-devices"
description: "Sign-in and devices (stage 48), for the mobile app: every place the signed-in customer is signed in, when each began and was last used, and signing one out."
editUrl: false
---

Sign-in and devices (stage 48), for the mobile app: every place the signed-in customer is signed in, when each began and was last used, and signing one out. Which sessions are theirs is the host's (me.sessions.list, me.sessions.revoke). Signing out of this device is the app's own (`onSignOut`: the template's session.signOut, which ends the tokens and forgets them).

|  |  |
| --- | --- |
| Skin | native |
| Pack | the base layer |
| Add it | `cos add native-account-devices` |
| Files | `devices.tsx`, `LICENSE` |
| Depends on | [native-base](/reference/blocks/native-base/) |
| Packages | `@composable-os/client` |

## Operations it calls

Through its hooks; the host decides what each caller may do.

- [`me.sessions.list`](/reference/operations/me/#mesessionslist)
- [`me.sessions.revoke`](/reference/operations/me/#mesessionsrevoke)

Source: [blocks/native-account-devices](https://github.com/timoconnellaus/composable-os/tree/main/blocks/native-account-devices).
