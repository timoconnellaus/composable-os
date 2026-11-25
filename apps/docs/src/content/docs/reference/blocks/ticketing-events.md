---
title: "ticketing-events"
description: "The events on sale, and one event's details, for a site's events page (stage 27)."
editUrl: false
---

The events on sale, and one event's details, for a site's events page (stage 27). Built on the web base layer. What is on sale, the prices and the places left are the host's (`useEventsOnSale`); this lays them out.

<img class="cos-screen" src="/screens/ticketing-events.png" alt="ticketing-events, drawn with dummy data" width="720" height="930" loading="lazy" decoding="async" />

Drawn with dummy data.

|  |  |
| --- | --- |
| Skin | web |
| Pack | [ticketing](/packs/ticketing/screens/) |
| Add it | `cos add ticketing-events` |
| Files | `event-list.tsx`, `LICENSE` |
| Depends on | [ui-button](/reference/blocks/ui-button/), [ui-card](/reference/blocks/ui-card/) |
| Packages | `@composable-os/pack-ticketing` |

## Operations it calls

Through its hooks; the host decides what each caller may do.

- [`x.ticketing.eventsOnSale`](/packs/ticketing/tools/#eventsonsale)

Source: [packs/ticketing/blocks/ticketing-events](https://github.com/timoconnellaus/composable-os/tree/main/packs/ticketing/blocks/ticketing-events).
