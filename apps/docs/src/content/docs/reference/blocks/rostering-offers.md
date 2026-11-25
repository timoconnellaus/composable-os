---
title: "rostering-offers"
description: "Offered to me (stage 45 step 7), for every rostered person: the shifts others offered that the host says I could take now (I am qualified for the kind of work, free then, and it is before the cut-off), soonest first, and a button to take each."
editUrl: false
---

Offered to me (stage 45 step 7), for every rostered person: the shifts others offered that the host says I could take now (I am qualified for the kind of work, free then, and it is before the cut-off), soonest first, and a button to take each. Nobody approves a take; the person who offered it and whoever rosters are told. The host decides everything and this shows its answer: when I said I am away then, the host asks me to confirm (`unavailable_confirm`) and this asks the same; when someone else took it first, the host names them (`offer_taken`); a withdrawn or lapsed offer, one whose shift changed hands, one past the cut-off, a clash with a shift of mine, or a kind I am not qualified for each has its own state, and the list is refreshed.

<img class="cos-screen" src="/screens/rostering-offers.png" alt="rostering-offers, drawn with dummy data" width="720" height="472" loading="lazy" decoding="async" />

Drawn with dummy data.

|  |  |
| --- | --- |
| Skin | web |
| Pack | [rostering](/packs/rostering/screens/) |
| Add it | `cos add rostering-offers` |
| Files | `offers.tsx`, `LICENSE` |
| Depends on | [ui-button](/reference/blocks/ui-button/) |
| Packages | `@composable-os/pack-rostering` |

## Operations it calls

Through its hooks; the host decides what each caller may do.

- [`x.rostering.me`](/packs/rostering/tools/#me)
- [`x.rostering.offers`](/packs/rostering/tools/#offers)
- [`x.rostering.take`](/packs/rostering/tools/#take)

Source: [packs/rostering/blocks/rostering-offers](https://github.com/timoconnellaus/composable-os/tree/main/packs/rostering/blocks/rostering-offers).
