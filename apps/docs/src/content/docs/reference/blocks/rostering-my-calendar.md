---
title: "rostering-my-calendar"
description: "My calendar (stage 45 step 7, over step 5's feed, ADR 0628), for every rostered person: whether I have a private calendar address for my own shifts, making one (or a new one, which stops the old), and switching it off."
editUrl: false
---

My calendar (stage 45 step 7, over step 5's feed, ADR 0628), for every rostered person: whether I have a private calendar address for my own shifts, making one (or a new one, which stops the old), and switching it off. The address is shown once, as the host gives it: copied, or opened in a calendar app ("Add to calendar", a webcal link), on the host the screen's client talks to; it is never stored here, never put in a URL of this app, and cleared when the page is left or brought back from the back-forward cache. The host keeps only its hash, so a lost address is never shown again: the person makes a new one. Everything is the host's: whether a feed exists, the address, who may make one (the person themselves), and each refusal, including a retried request whose answer the host never keeps (`address_lost`: a new address was made but cannot be shown; make another).

|  |  |
| --- | --- |
| Skin | web |
| Pack | [rostering](/packs/rostering/screens/) |
| Add it | `cos add rostering-my-calendar` |
| Files | `my-calendar.tsx`, `LICENSE` |
| Depends on | [ui-button](/reference/blocks/ui-button/) |
| Packages | `@composable-os/pack-rostering` |

## Operations it calls

Through its hooks; the host decides what each caller may do.

- [`x.rostering.feed`](/packs/rostering/tools/#feed)
- [`x.rostering.feedRotate`](/packs/rostering/tools/#feedrotate)
- [`x.rostering.feedRevoke`](/packs/rostering/tools/#feedrevoke)

Source: [packs/rostering/blocks/rostering-my-calendar](https://github.com/timoconnellaus/composable-os/tree/main/packs/rostering/blocks/rostering-my-calendar).
