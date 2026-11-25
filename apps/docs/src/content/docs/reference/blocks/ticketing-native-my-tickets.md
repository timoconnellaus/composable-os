---
title: "ticketing-native-my-tickets"
description: "A signed-in customer's tickets, for the mobile app's Tickets tab (stage 27)."
editUrl: false
---

A signed-in customer's tickets, for the mobile app's Tickets tab (stage 27). Which tickets are theirs, and what of them they may see, is the host's (`useMyTickets` reads through the seam).

<img class="cos-screen cos-screen-native" src="/screens/ticketing-native-my-tickets.png" alt="ticketing-native-my-tickets, drawn with dummy data" width="390" height="844" loading="lazy" decoding="async" />

Drawn with dummy data.

|  |  |
| --- | --- |
| Skin | native |
| Pack | [ticketing](/packs/ticketing/screens/) |
| Add it | `cos add ticketing-native-my-tickets` |
| Files | `my-tickets-screen.tsx`, `LICENSE` |
| Depends on | [native-base](/reference/blocks/native-base/) |
| Packages | `@composable-os/pack-ticketing` |

## Operations it calls

Through its hooks; the host decides what each caller may do.

- [`x.ticketing.myTickets`](/packs/ticketing/tools/#mytickets)

Source: [packs/ticketing/blocks/ticketing-native-my-tickets](https://github.com/timoconnellaus/composable-os/tree/main/packs/ticketing/blocks/ticketing-native-my-tickets).
