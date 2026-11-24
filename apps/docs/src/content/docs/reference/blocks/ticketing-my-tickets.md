---
title: "ticketing-my-tickets"
description: "A signed-in customer's tickets, for a site (stage 27)."
editUrl: false
---

A signed-in customer's tickets, for a site (stage 27). Which tickets are theirs, and what of them they may see, is the host's (`useMyTickets` reads through the seam).

|  |  |
| --- | --- |
| Skin | web |
| Pack | [ticketing](/packs/ticketing/screens/) |
| Add it | `cos add ticketing-my-tickets` |
| Files | `my-tickets.tsx`, `LICENSE` |
| Depends on | nothing |
| Packages | `@composable-os/pack-ticketing` |

## Operations it calls

Through its hooks; the host decides what each caller may do.

- [`x.ticketing.myTickets`](/packs/ticketing/tools/#mytickets)

Source: [packs/ticketing/blocks/ticketing-my-tickets](https://github.com/timoconnellaus/composable-os/tree/main/packs/ticketing/blocks/ticketing-my-tickets).
