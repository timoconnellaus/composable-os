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

Each drawn with dummy data.

### memberships-mine

Web. A member's memberships and passes on the gym's site (stage 32b), and their section of My account (stage 48): what each allows, when it stops or expires, and what is left this week, this month or in all, from the host's count (`x.memberships.mine`, `allowance.get`); a child's the gym linked to them too (decision 8: a parent sees a child's memberships and passes), each under the child's name; and their membership subscriptions, through My account's one subscriptions part (`web-account-subscriptions`): cancel at the period's end, keep it going, confirm a payment that waits on them, and here a change of plan (the host decides: an upgrade now, its prorated charge on the card, or a downgrade from the next period). [The block](/reference/blocks/memberships-mine/).

<img class="cos-screen" src="/screens/memberships-mine.png" alt="memberships-mine, drawn with dummy data" width="720" height="832" loading="lazy" decoding="async" />

### memberships-native-mine

Native. A member's memberships and passes in the gym's app (stage 32b), and their section of the app's My account (stage 48), read only: what each allows, what is left this week, this month or in all (the host's count), when it stops or expires, a child's the gym linked to them under the child's name (decision 8), and their membership's billing state in words through My account's one subscriptions part (`native-account-subscriptions`), with a plan change or a pause waiting and "Manage on the website" (`onManage`, which the account shell gives). [The block](/reference/blocks/memberships-native-mine/).

<img class="cos-screen cos-screen-native" src="/screens/memberships-native-mine.png" alt="memberships-native-mine, drawn with dummy data" width="390" height="844" loading="lazy" decoding="async" />

### memberships-passes

Web. Buying a pass on a gym's site (stage 32b): the pass types on sale (class packs, drop-ins, an intro offer) with the host's price, what each gives and how long it is valid, and a button that starts the order and opens the payment provider's page. [The block](/reference/blocks/memberships-passes/).

<img class="cos-screen" src="/screens/memberships-passes.png" alt="memberships-passes, drawn with dummy data" width="720" height="610" loading="lazy" decoding="async" />

### memberships-plans

Web. Joining a gym on its site (stage 32b): the membership plans on sale with the host's price per month, what each allows and its trial, and a button that opens the payment provider's page. [The block](/reference/blocks/memberships-plans/).

<img class="cos-screen" src="/screens/memberships-plans.png" alt="memberships-plans, drawn with dummy data" width="720" height="710" loading="lazy" decoding="async" />

### memberships-staff-holdings

Web. For staff (stage 32b): one person's memberships and passes, with what each allows and what is left, as the host counts it; giving a pass by hand or voiding one given by hand, with a reason; and pausing their membership for a set time or ending a pause (stage 32b, decision 10: the host holds the plan's shortest and longest pause and asks the provider; the membership shows paused once the provider confirms). [The block](/reference/blocks/memberships-staff-holdings/).

<img class="cos-screen" src="/screens/memberships-staff-holdings.png" alt="memberships-staff-holdings, drawn with dummy data" width="720" height="1202" loading="lazy" decoding="async" />
