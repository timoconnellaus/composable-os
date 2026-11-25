---
title: "Daily checklists: screens"
sidebar:
  label: "Screens"
  order: 4
editUrl: false
---

Screens a shipped pack declares are built into the admin and shown to whoever could call every tool in `opens`. Blocks are the pack's screens for client apps, copied with `cos add`.

## Staff screens

| Screen | Label | Block | Navigation | Opens | On a record |
| --- | --- | --- | --- | --- | --- |
| `today` | Today's checklists | [dailychecks-today](/reference/blocks/dailychecks-today/) (`TodaysChecklists`) | Checklists, 10 | [today](/packs/dailychecks/tools/#today), [tick](/packs/dailychecks/tools/#tick) |   |
| `history` | Checklist history | [dailychecks-history](/reference/blocks/dailychecks-history/) (`ChecklistHistory`) | Checklists, 20 | [history](/packs/dailychecks/tools/#history) |   |

## Blocks

Each drawn with dummy data.

### dailychecks-history

Web. How each day went (ADR 0651), for those who manage checklists: every checklist done on its own, day by day, done (by whom, for whom, when, and whether after its due time) or missed (with the steps nobody ticked). [The block](/reference/blocks/dailychecks-history/).

<img class="cos-screen" src="/screens/dailychecks-history.png" alt="dailychecks-history, drawn with dummy data" width="1024" height="462" loading="lazy" decoding="async" />

### dailychecks-native-today

Native. Today's checklists in the app (ADR 0651): the same as the web's, over the native base. [The block](/reference/blocks/dailychecks-native-today/).

<img class="cos-screen cos-screen-native" src="/screens/dailychecks-native-today.png" alt="dailychecks-native-today, drawn with dummy data" width="390" height="844" loading="lazy" decoding="async" />

### dailychecks-today

Web. Today's checklists (ADR 0651): the checklists done on their own (opening, closing, cleaning) that are due today and that the viewer may do, each with when it is due by and its steps. [The block](/reference/blocks/dailychecks-today/).

<img class="cos-screen" src="/screens/dailychecks-today.png" alt="dailychecks-today, drawn with dummy data" width="720" height="1388" loading="lazy" decoding="async" />
