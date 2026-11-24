---
title: "Memberships: screens"
sidebar:
  label: "Screens"
  order: 4
editUrl: false
---

Screens a shipped pack declares are built into the admin and shown to whoever could call every tool in `opens`. Blocks are the pack's screens for client apps, copied with `cos add`.

## Staff screens

| Screen | Label | Block | Navigation | Opens | On a record |
| --- | --- | --- | --- | --- | --- |
| `holdings` | Memberships | [memberships-staff-holdings](/reference/blocks/memberships-staff-holdings/) (`PersonMemberships`) |   | [holdings](/packs/memberships/tools/#holdings), [givePass](/packs/memberships/tools/#givepass) | `person` |

## Blocks

| Block | Skin | What it shows |
| --- | --- | --- |
| [memberships-mine](/reference/blocks/memberships-mine/) | web | A member's memberships and passes on the gym's site (stage 32b): what each allows, when it stops or expires, and what is left this week, this month or in all, from the host's count (`x.memberships.mine`, `allowance.get`); and their membership subscriptions, with what they can do: cancel at the period's end, keep it going, change plan (the host decides: an upgrade now, its prorated charge on the card, or a downgrade from the next period), confirm a payment that waits on them, or open the payment provider's portal for their card and invoices. |
| [memberships-native-mine](/reference/blocks/memberships-native-mine/) | native | A member's memberships and passes in the gym's app (stage 32b), read only: what each allows, what is left this week, this month or in all (the host's count), when it stops or expires, and their membership's billing state in words, with a plan change or a pause waiting. |
| [memberships-passes](/reference/blocks/memberships-passes/) | web | Buying a pass on a gym's site (stage 32b): the pass types on sale (class packs, drop-ins, an intro offer) with the host's price, what each gives and how long it is valid, and a button that starts the order and opens the payment provider's page. |
| [memberships-plans](/reference/blocks/memberships-plans/) | web | Joining a gym on its site (stage 32b): the membership plans on sale with the host's price per month, what each allows and its trial, and a button that opens the payment provider's page. |
| [memberships-staff-holdings](/reference/blocks/memberships-staff-holdings/) | web | For staff (stage 32b): one person's memberships and passes, with what each allows and what is left, as the host counts it; giving a pass by hand or voiding one given by hand, with a reason; and pausing their membership for a set time or ending a pause (stage 32b, decision 10: the host holds the plan's shortest and longest pause and asks the provider; the membership shows paused once the provider confirms). |
