---
title: "bookings-desk"
description: "The front desk, for staff (stage 31a): one day's classes, and booking someone into one, a member on file or a walk-in."
editUrl: false
---

The front desk, for staff (stage 31a): one day's classes, and booking someone into one, a member on file or a walk-in. Staff are not bound by the booking windows or by "booked by staff only"; a class that was cancelled or is over, the places, one booking per person per class, what a booking spends and whether a walk-in is already on file are the host's, and this shows its answers.

<img class="cos-screen" src="/screens/bookings-desk.png" alt="bookings-desk, drawn with dummy data" width="720" height="728" loading="lazy" decoding="async" />

Drawn with dummy data.

|  |  |
| --- | --- |
| Skin | web |
| Pack | [bookings](/packs/bookings/screens/) |
| Add it | `cos add bookings-desk` |
| Files | `desk.tsx`, `LICENSE` |
| Depends on | [ui-button](/reference/blocks/ui-button/), [ui-input](/reference/blocks/ui-input/), [ui-label](/reference/blocks/ui-label/) |
| Packages | `@composable-os/pack-bookings` |

## Operations it calls

Through its hooks; the host decides what each caller may do.

- [`x.bookings.day`](/packs/bookings/tools/#day)
- [`x.bookings.bookFor`](/packs/bookings/tools/#bookfor)
- [`x.bookings.findPeople`](/packs/bookings/tools/#findpeople)

Source: [packs/bookings/blocks/bookings-desk](https://github.com/timoconnellaus/composable-os/tree/main/packs/bookings/blocks/bookings-desk).
