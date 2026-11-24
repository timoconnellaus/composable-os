---
title: "web-account-devices"
description: "Sign-in and devices (stage 48), for the web: every place the signed-in customer is signed in (browsers and the app on their devices), when each began and was last used, and signing one out."
editUrl: false
---

Sign-in and devices (stage 48), for the web: every place the signed-in customer is signed in (browsers and the app on their devices), when each began and was last used, and signing one out. Which sessions are theirs is the host's (me.sessions.list, me.sessions.revoke): another customer's is never listed. Signing out of this browser is the web app's own route (`onSignOut`: the template posts to /auth/sign-out, which ends the session and its cookie).

|  |  |
| --- | --- |
| Skin | web |
| Pack | the base layer |
| Add it | `cos add web-account-devices` |
| Files | `devices.tsx`, `LICENSE` |
| Depends on | [ui-button](/reference/blocks/ui-button/) |
| Packages | `@composable-os/client` |

## Operations it calls

Through its hooks; the host decides what each caller may do.

- [`me.sessions.list`](/reference/operations/me/#mesessionslist)
- [`me.sessions.revoke`](/reference/operations/me/#mesessionsrevoke)

Source: [blocks/web-account-devices](https://github.com/timoconnellaus/composable-os/tree/main/blocks/web-account-devices).
