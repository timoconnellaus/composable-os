---
title: "programs-builder"
description: "The coach's program builder (stage 41): weeks, sessions, blocks and items, by drag and by keyboard; exercises picked from the bank; typed sets; levels; notes, for coaches or shown to members; copying a week or a session; the working copy saved as the coach goes, with the host's faults shown where they are; versions, restoring one, publishing, and assigning."
editUrl: false
---

The coach's program builder (stage 41): weeks, sessions, blocks and items, by drag and by keyboard; exercises picked from the bank; typed sets; levels; notes, for coaches or shown to members; copying a week or a session; the working copy saved as the coach goes, with the host's faults shown where they are; versions, restoring one, publishing, and assigning. Built on the web base layer. It holds no rules: what a layout may hold is the host's schema (a refused save shows the host's words at the part it names), who may publish is the host's (the button is offered from what `user.me` says, and the host decides), and assigning makes its dates in the host. Editing is `layoutEdits` from the pack's client.

<img class="cos-screen" src="/screens/programs-builder.png" alt="programs-builder, drawn with dummy data" width="1024" height="2610" loading="lazy" decoding="async" />

Drawn with dummy data.

|  |  |
| --- | --- |
| Skin | web |
| Pack | [programs](/packs/programs/screens/) |
| Add it | `cos add programs-builder` |
| Files | `program-builder.tsx`, `LICENSE` |
| Depends on | [ui-button](/reference/blocks/ui-button/), [ui-card](/reference/blocks/ui-card/), [ui-input](/reference/blocks/ui-input/), [ui-label](/reference/blocks/ui-label/) |
| Packages | `@composable-os/pack-programs` |

## Operations it calls

Through its hooks; the host decides what each caller may do.

- [`record.get`](/reference/operations/record/#recordget)
- [`record.update`](/reference/operations/record/#recordupdate)
- [`record.list`](/reference/operations/record/#recordlist)
- [`record.create`](/reference/operations/record/#recordcreate)
- [`record.versions`](/reference/operations/record/#recordversions)
- [`record.publish`](/reference/operations/record/#recordpublish)
- [`record.restoreVersion`](/reference/operations/record/#recordrestoreversion)
- [`user.me`](/reference/operations/user/#userme)
- [`person.list`](/reference/operations/person/#personlist)
- [`x.programs.assign`](/packs/programs/tools/#assign)
- [`x.programs.draft`](/packs/programs/tools/#draft)
- [`x.programs.importText`](/packs/programs/tools/#importtext)

Source: [packs/programs/blocks/programs-builder](https://github.com/timoconnellaus/composable-os/tree/main/packs/programs/blocks/programs-builder).
