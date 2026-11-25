---
title: "ticketing-my-tickets"
description: "A signed-in customer's tickets, for a site (stage 27)."
editUrl: false
---

A signed-in customer's tickets, for a site (stage 27). Which tickets are theirs, and what of them they may see, is the host's (`useMyTickets` reads through the seam).

<img class="cos-screen" src="/screens/ticketing-my-tickets.png" alt="ticketing-my-tickets, drawn with dummy data" width="640" height="256" loading="lazy" decoding="async" />

Drawn with dummy data.

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
