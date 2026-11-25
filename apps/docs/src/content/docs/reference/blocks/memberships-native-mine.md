---
title: "memberships-native-mine"
description: "A member's memberships and passes in the gym's app (stage 32b), read only: what each allows, what is left this week, this month or in all (the host's count), when it stops or expires, and their membership's billing state in words, with a plan change or a pause waiting."
editUrl: false
---

A member's memberships and passes in the gym's app (stage 32b), read only: what each allows, what is left this week, this month or in all (the host's count), when it stops or expires, and their membership's billing state in words, with a plan change or a pause waiting. Joining, buying a pass, cancelling, resuming, changing plan and the card are on the web only (`noPurchase`: the block lint refuses a billing operation or a purchase here). Cooling off (stage 44 step 7, ADR 0647) too: while the host says a new member may end their membership for a full refund, the app says until when and that it is done on the website; a membership ended that way says where its refund is. The window is the host's, never the app's.

<img class="cos-screen cos-screen-native" src="/screens/memberships-native-mine.png" alt="memberships-native-mine, drawn with dummy data" width="390" height="844" loading="lazy" decoding="async" />

Drawn with dummy data.

|  |  |
| --- | --- |
| Skin | native |
| Pack | [memberships](/packs/memberships/screens/) |
| Add it | `cos add memberships-native-mine` |
| Files | `mine-screen.tsx`, `LICENSE` |
| Depends on | [native-base](/reference/blocks/native-base/) |
| Packages | `@composable-os/pack-memberships` |

## Operations it calls

Through its hooks; the host decides what each caller may do.

- [`x.memberships.mine`](/packs/memberships/tools/#mine)
- [`subscription.list`](/reference/operations/subscription/#subscriptionlist)
- [`subscription.coolingOff`](/reference/operations/subscription/#subscriptioncoolingoff)

Source: [packs/memberships/blocks/memberships-native-mine](https://github.com/timoconnellaus/composable-os/tree/main/packs/memberships/blocks/memberships-native-mine).
