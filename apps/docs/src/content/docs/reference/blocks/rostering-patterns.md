---
title: "rostering-patterns"
description: "The regular week (stage 45 step 7), for someone who rosters: every class series' coach and duty series' regular person, day by day, and changing who works one from a date."
editUrl: false
---

The regular week (stage 45 step 7), for someone who rosters: every class series' coach and duty series' regular person, day by day, and changing who works one from a date. The shifts from that date follow, except those that keep their own person; a change that would put someone on two shifts at once on any date is refused whole by the host, naming the dates, and shown so. Shown only when the host says the reader rosters (`me.rosters`): nobody else's screen asks for the patterns. Everything shown is the host's answer.

<img class="cos-screen" src="/screens/rostering-patterns.png" alt="rostering-patterns, drawn with dummy data" width="1280" height="598" loading="lazy" decoding="async" />

Drawn with dummy data.

|  |  |
| --- | --- |
| Skin | web |
| Pack | [rostering](/packs/rostering/screens/) |
| Add it | `cos add rostering-patterns` |
| Files | `patterns.tsx`, `LICENSE` |
| Depends on | [ui-button](/reference/blocks/ui-button/) |
| Packages | `@composable-os/pack-rostering` |

## Operations it calls

Through its hooks; the host decides what each caller may do.

- [`x.rostering.me`](/packs/rostering/tools/#me)
- [`x.rostering.patterns`](/packs/rostering/tools/#patterns)
- [`x.rostering.people`](/packs/rostering/tools/#people)
- [`x.rostering.setPattern`](/packs/rostering/tools/#setpattern)

Source: [packs/rostering/blocks/rostering-patterns](https://github.com/timoconnellaus/composable-os/tree/main/packs/rostering/blocks/rostering-patterns).
