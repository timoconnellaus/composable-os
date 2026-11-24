---
title: "programs-native-history"
description: "A person's past sessions, for the mobile app (stage 41): newest first, each with its date, its name and how many of its sets were logged; pressing one shows it set by set, read-only, and a logged set can be corrected."
editUrl: false
---

A person's past sessions, for the mobile app (stage 41): newest first, each with its date, its name and how many of its sets were logged; pressing one shows it set by set, read-only, and a logged set can be corrected. For a member (their own) or a coach (`personId`, a client's). It holds no rules: whose sessions they are and what a correction may change are the host's (`x.programs.logUpdate`: the numbers done, effort and the note).

|  |  |
| --- | --- |
| Skin | native |
| Pack | [programs](/packs/programs/screens/) |
| Add it | `cos add programs-native-history` |
| Files | `history-screen.tsx`, `LICENSE` |
| Depends on | [native-base](/reference/blocks/native-base/) |
| Packages | `@composable-os/pack-programs` |

## Operations it calls

Through its hooks; the host decides what each caller may do.

- [`my.list`](/reference/operations/my/#mylist)
- [`record.list`](/reference/operations/record/#recordlist)
- [`x.programs.sessionGet`](/packs/programs/tools/#sessionget)
- [`x.programs.logUpdate`](/packs/programs/tools/#logupdate)

Source: [packs/programs/blocks/programs-native-history](https://github.com/timoconnellaus/composable-os/tree/main/packs/programs/blocks/programs-native-history).
