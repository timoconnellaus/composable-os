---
title: "programs-history"
description: "A person's past sessions (stage 41): newest first, each with its date, its name and how many of its sets were logged; one opened shows it set by set, read-only, with the target beside what was done, and a logged set can be corrected."
editUrl: false
---

A person's past sessions (stage 41): newest first, each with its date, its name and how many of its sets were logged; one opened shows it set by set, read-only, with the target beside what was done, and a logged set can be corrected. For a member (their own) or a coach (`personId`, a client's). Built on the web base layer. It holds no rules: which sessions are the person's, the sets on each and what a correction may change are the host's (the seam for a member, `x.programs.logUpdate` for both: the numbers done, effort and the note, never the target, the exercise or who recorded it).

|  |  |
| --- | --- |
| Skin | web |
| Pack | [programs](/packs/programs/screens/) |
| Add it | `cos add programs-history` |
| Files | `history.tsx`, `LICENSE` |
| Depends on | [ui-button](/reference/blocks/ui-button/), [ui-card](/reference/blocks/ui-card/), [ui-input](/reference/blocks/ui-input/) |
| Packages | `@composable-os/pack-programs` |

## Operations it calls

Through its hooks; the host decides what each caller may do.

- [`my.list`](/reference/operations/my/#mylist)
- [`record.list`](/reference/operations/record/#recordlist)
- [`x.programs.sessionGet`](/packs/programs/tools/#sessionget)
- [`x.programs.logUpdate`](/packs/programs/tools/#logupdate)

Source: [packs/programs/blocks/programs-history](https://github.com/timoconnellaus/composable-os/tree/main/packs/programs/blocks/programs-history).
