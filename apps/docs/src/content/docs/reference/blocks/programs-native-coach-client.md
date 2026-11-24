---
title: "programs-native-coach-client"
description: "The coach's view of one client, for the staff app (stage 41): their sessions, newest first; pressing one opens it to log on their behalf (`onOpen`, to the session screen with `personId`)."
editUrl: false
---

The coach's view of one client, for the staff app (stage 41): their sessions, newest first; pressing one opens it to log on their behalf (`onOpen`, to the session screen with `personId`). Logging for a client is the host's; the row records the coach.

|  |  |
| --- | --- |
| Skin | native |
| Pack | [programs](/packs/programs/screens/) |
| Add it | `cos add programs-native-coach-client` |
| Files | `coach-client-screen.tsx`, `LICENSE` |
| Depends on | [native-base](/reference/blocks/native-base/) |
| Packages | `@composable-os/pack-programs` |

## Operations it calls

Through its hooks; the host decides what each caller may do.

- [`record.list`](/reference/operations/record/#recordlist)

Source: [packs/programs/blocks/programs-native-coach-client](https://github.com/timoconnellaus/composable-os/tree/main/packs/programs/blocks/programs-native-coach-client).
