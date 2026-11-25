---
title: "web-sign-in"
description: "Sign-in with a code by email, for the web app, built on the web base layer."
editUrl: false
---

Sign-in with a code by email, for the web app, built on the web base layer. The host sends the code and makes the session; this form only posts to the web app's own /auth routes (the template's src/host.ts serves them) and says what happened.

<img class="cos-screen" src="/screens/web-sign-in.png" alt="web-sign-in, drawn with dummy data" width="440" height="158" loading="lazy" decoding="async" />

Drawn with dummy data.

|  |  |
| --- | --- |
| Skin | web |
| Pack | the base layer |
| Add it | `cos add web-sign-in` |
| Files | `sign-in-form.tsx`, `LICENSE` |
| Depends on | [ui-button](/reference/blocks/ui-button/), [ui-input](/reference/blocks/ui-input/), [ui-label](/reference/blocks/ui-label/) |
| Packages | none |

## Operations it calls

Through its hooks; the host decides what each caller may do.

None.

Source: [blocks/web-sign-in](https://github.com/timoconnellaus/composable-os/tree/main/blocks/web-sign-in).
