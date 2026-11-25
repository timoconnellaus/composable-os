---
title: "bookings-drop-in"
description: "Paying for one class on a gym's site (stage 31a step 8, a drop-in): the week's classes for a visitor, each with \"Pay for this class\"."
editUrl: false
---

Paying for one class on a gym's site (stage 31a step 8, a drop-in): the week's classes for a visitor, each with "Pay for this class". The host holds a place while they pay, prices it, and books them when the payment provider confirms it; an unpaid order lets the place go after a few minutes. Whether a class can be paid for, its price, the places left and the rules are the host's: this shows its answers and sends the buyer to the provider's page. Web only: a native block never buys (the block lint). What must be agreed to first (a waiver, a health form: stage 44) is the host's answer too: when "Pay" is refused with it, the documents are shown inline (the web-agree block's step) and "Pay" is tried again. A visitor's agreements travel in the buying call and are recorded with the order; a member's are recorded as they agree. What a visitor typed, drew and answered is held in memory only until that call. A minor whose purchase needs the payer's agreement is told a parent or guardian buys it.

<img class="cos-screen" src="/screens/bookings-drop-in.png" alt="bookings-drop-in, drawn with dummy data" width="720" height="700" loading="lazy" decoding="async" />

Drawn with dummy data.

|  |  |
| --- | --- |
| Skin | web |
| Pack | [bookings](/packs/bookings/screens/) |
| Add it | `cos add bookings-drop-in` |
| Files | `drop-in.tsx`, `LICENSE` |
| Depends on | [ui-button](/reference/blocks/ui-button/), [ui-input](/reference/blocks/ui-input/), [ui-label](/reference/blocks/ui-label/), [web-agree](/reference/blocks/web-agree/) |
| Packages | `@composable-os/client`, `@composable-os/pack-bookings` |

## Operations it calls

Through its hooks; the host decides what each caller may do.

- [`x.bookings.timetable`](/packs/bookings/tools/#timetable)
- [`x.bookings.buy`](/packs/bookings/tools/#buy)
- [`order.checkout`](/reference/operations/order/#ordercheckout)
- [`me.agreements.due`](/reference/operations/me/#meagreementsdue)
- [`me.agreements.accept`](/reference/operations/me/#meagreementsaccept)
- [`agreement.guestVersions`](/reference/operations/agreement/#agreementguestversions)

Source: [packs/bookings/blocks/bookings-drop-in](https://github.com/timoconnellaus/composable-os/tree/main/packs/bookings/blocks/bookings-drop-in).
