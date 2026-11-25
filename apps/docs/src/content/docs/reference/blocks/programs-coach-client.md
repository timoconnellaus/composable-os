---
title: "programs-coach-client"
description: "The coach's view of one client (stage 41): their sessions, newest first, each opened to see what was logged and to log on their behalf, and their progress."
editUrl: false
---

The coach's view of one client (stage 41): their sessions, newest first, each opened to see what was logged and to log on their behalf, and their progress. Built on the web base layer and the session and progress blocks. Logging for a client is the host's (`logAdd` with the session's person; the row records the coach).

|  |  |
| --- | --- |
| Skin | web |
| Pack | [programs](/packs/programs/screens/) |
| Add it | `cos add programs-coach-client` |
| Files | `coach-client.tsx`, `LICENSE` |
| Depends on | [programs-session](/reference/blocks/programs-session/), [programs-progress](/reference/blocks/programs-progress/), [ui-button](/reference/blocks/ui-button/) |
| Packages | `@composable-os/pack-programs` |

## Operations it calls

Through its hooks; the host decides what each caller may do.

- [`record.list`](/reference/operations/record/#recordlist)

Source: [packs/programs/blocks/programs-coach-client](https://github.com/timoconnellaus/composable-os/tree/main/packs/programs/blocks/programs-coach-client).
