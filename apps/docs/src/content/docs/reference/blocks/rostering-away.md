---
title: "rostering-away"
description: "Everyone's time off (stage 45 step 7), for someone who rosters: by week, who said they cannot work, with their notes, and adding or ending someone's time off for them."
editUrl: false
---

Everyone's time off (stage 45 step 7), for someone who rosters: by week, who said they cannot work, with their notes, and adding or ending someone's time off for them. The host lets only someone who rosters read anyone else's, and only as a person at the screen (never an assistant), so this is shown only when the host says the reader rosters (`me.rosters`), and other staff never see that anyone is away. Notes are read on this screen only: kept in the app's cache no longer than they are shown, hidden when the page is left, and what was sent is forgotten once the call is over.

<img class="cos-screen" src="/screens/rostering-away.png" alt="rostering-away, drawn with dummy data" width="800" height="1037" loading="lazy" decoding="async" />

Drawn with dummy data.

|  |  |
| --- | --- |
| Skin | web |
| Pack | [rostering](/packs/rostering/screens/) |
| Add it | `cos add rostering-away` |
| Files | `away-list.tsx`, `LICENSE` |
| Depends on | [ui-button](/reference/blocks/ui-button/) |
| Packages | `@composable-os/pack-rostering` |

## Operations it calls

Through its hooks; the host decides what each caller may do.

- [`x.rostering.me`](/packs/rostering/tools/#me)
- [`x.rostering.awayList`](/packs/rostering/tools/#awaylist)
- [`x.rostering.awayFor`](/packs/rostering/tools/#awayfor)
- [`x.rostering.back`](/packs/rostering/tools/#back)
- [`x.rostering.people`](/packs/rostering/tools/#people)

Source: [packs/rostering/blocks/rostering-away](https://github.com/timoconnellaus/composable-os/tree/main/packs/rostering/blocks/rostering-away).
