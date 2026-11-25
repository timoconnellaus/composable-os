---
title: "bookings-timetable"
description: "The timetable for a gym's site (stage 31a): the week's classes, and for a signed-in member a Book or Cancel button on each."
editUrl: false
---

The timetable for a gym's site (stage 31a): the week's classes, and for a signed-in member a Book or Cancel button on each. A parent the gym linked to a child picks who they are booking for (ADR 0540); the child's own membership or pass pays. A member with nothing to spend on a class may pay for it instead (a drop-in, when the app passes `payReturnUrl`; web only). Whether booking is open, whether the gym books a class, the places left, whether a cancel is in time and what it spends are the host's: this shows its answers. What must be agreed to first (stage 44: a waiver, a health form, a new version to agree to again) is the host's answer too: when "Book" or "Pay" is refused with it, the documents are shown inline in the class's row (the web-agree block's step), then it is tried again. A child's are agreed to by the parent booking for them; a member a parent agrees for is told so.

<img class="cos-screen" src="/screens/bookings-timetable.png" alt="bookings-timetable, drawn with dummy data" width="720" height="777" loading="lazy" decoding="async" />

Drawn with dummy data.

|  |  |
| --- | --- |
| Skin | web |
| Pack | [bookings](/packs/bookings/screens/) |
| Add it | `cos add bookings-timetable` |
| Files | `timetable.tsx`, `LICENSE` |
| Depends on | [ui-button](/reference/blocks/ui-button/), [web-agree](/reference/blocks/web-agree/) |
| Packages | `@composable-os/client`, `@composable-os/pack-bookings` |

## Operations it calls

Through its hooks; the host decides what each caller may do.

- [`x.bookings.timetable`](/packs/bookings/tools/#timetable)
- [`x.bookings.mine`](/packs/bookings/tools/#mine)
- [`x.bookings.family`](/packs/bookings/tools/#family)
- [`x.bookings.book`](/packs/bookings/tools/#book)
- [`x.bookings.cancel`](/packs/bookings/tools/#cancel)
- [`x.bookings.buy`](/packs/bookings/tools/#buy)
- [`order.checkout`](/reference/operations/order/#ordercheckout)
- [`me.agreements.due`](/reference/operations/me/#meagreementsdue)
- [`me.agreements.accept`](/reference/operations/me/#meagreementsaccept)

Source: [packs/bookings/blocks/bookings-timetable](https://github.com/timoconnellaus/composable-os/tree/main/packs/bookings/blocks/bookings-timetable).
