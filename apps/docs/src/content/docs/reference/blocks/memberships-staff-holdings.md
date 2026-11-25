---
title: "memberships-staff-holdings"
description: "For staff (stage 32b): one person's memberships and passes, with what each allows and what is left, as the host counts it; giving a pass by hand or voiding one given by hand, with a reason; and pausing their membership for a set time or ending a pause (stage 32b, decision 10: the host holds the plan's shortest and longest pause and asks the provider; the membership shows paused once the provider confirms)."
editUrl: false
---

For staff (stage 32b): one person's memberships and passes, with what each allows and what is left, as the host counts it; giving a pass by hand or voiding one given by hand, with a reason; and pausing their membership for a set time or ending a pause (stage 32b, decision 10: the host holds the plan's shortest and longest pause and asks the provider; the membership shows paused once the provider confirms). Both are a person's own act: the host refuses the assistant, an MCP client and an automation (the tools are human only), and staff without the memberships:passes permission.

<img class="cos-screen" src="/screens/memberships-staff-holdings.png" alt="memberships-staff-holdings, drawn with dummy data" width="720" height="1202" loading="lazy" decoding="async" />

Drawn with dummy data.

|  |  |
| --- | --- |
| Skin | web |
| Pack | [memberships](/packs/memberships/screens/) |
| Add it | `cos add memberships-staff-holdings` |
| Files | `holdings.tsx`, `LICENSE` |
| Depends on | [ui-button](/reference/blocks/ui-button/), [ui-card](/reference/blocks/ui-card/), [ui-input](/reference/blocks/ui-input/), [ui-label](/reference/blocks/ui-label/) |
| Packages | `@composable-os/pack-memberships` |

## Operations it calls

Through its hooks; the host decides what each caller may do.

- [`x.memberships.holdings`](/packs/memberships/tools/#holdings)
- [`x.memberships.givePass`](/packs/memberships/tools/#givepass)
- [`x.memberships.voidPass`](/packs/memberships/tools/#voidpass)
- [`subscription.list`](/reference/operations/subscription/#subscriptionlist)
- [`subscription.pause`](/reference/operations/subscription/#subscriptionpause)
- [`subscription.unpause`](/reference/operations/subscription/#subscriptionunpause)
- [`record.list`](/reference/operations/record/#recordlist)

Source: [packs/memberships/blocks/memberships-staff-holdings](https://github.com/timoconnellaus/composable-os/tree/main/packs/memberships/blocks/memberships-staff-holdings).
