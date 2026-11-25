---
title: "web-account"
description: "My account (stage 48), for the web: the signed-in customer's own area, one page of sections."
editUrl: false
---

My account (stage 48), for the web: the signed-in customer's own area, one page of sections. The base sections come with it: Orders, Agreements, Family, Payment method (only for someone who pays a subscription), Your details, Contact preferences (stage 30) and Sign-in and devices. The packs' sections are passed in `sections`, each the pack's own block, and take their place by `order` (a pack's come first). It decides nothing: which sections this customer has, in what order, and whether Payment method shows is the host's answer (me.portal, ADR 0710); what each section shows is the host's answer to the section's own call. `cos add web-account` copies the packs' section blocks and writes `../account-sections.gen.ts`, which names them; the page passes them through `usePackSections`: import { ACCOUNT_SECTIONS } from "../blocks/account-sections.gen.ts"; const react = { useQuery, useMutation, useState, useEffect }; // at module level: made once const sections = usePackSections(ACCOUNT_SECTIONS, react, api, returnUrl); &lt;MyAccount account={account} agreements={agreements} sections={sections} … /&gt; so the page names no pack. "Needs your attention" sits at the top (me.attention, ADR 0711), each item leading to the section that deals with it (money owed on an order: the order's row in Orders, which pays it with order.checkout). A base section the host lists that this copy draws nothing for (added to the platform later) is left out (`portalSections`' `base`). Changing the sign-in address (under Your details) and Delete my account need a recent sign-in: when the host asks for one, they sign the customer in again in place through `signIn` and carry on (ADR 0712).

<img class="cos-screen" src="/screens/web-account.png" alt="web-account, drawn with dummy data" width="1024" height="5878" loading="lazy" decoding="async" />

Drawn with dummy data.

|  |  |
| --- | --- |
| Skin | web |
| Pack | the base layer |
| Add it | `cos add web-account` |
| Files | `account.tsx`, `LICENSE` |
| Depends on | [web-account-attention](/reference/blocks/web-account-attention/), [web-account-delete](/reference/blocks/web-account-delete/), [web-account-contact](/reference/blocks/web-account-contact/), [web-account-details](/reference/blocks/web-account-details/), [web-account-devices](/reference/blocks/web-account-devices/), [web-account-family](/reference/blocks/web-account-family/), [web-account-orders](/reference/blocks/web-account-orders/), [web-account-payment](/reference/blocks/web-account-payment/), [web-my-agreements](/reference/blocks/web-my-agreements/), [ui-button](/reference/blocks/ui-button/) |
| Packages | `@composable-os/client` |

## Operations it calls

Through its hooks; the host decides what each caller may do.

- [`me.portal`](/reference/operations/me/#meportal)
- [`me.attention`](/reference/operations/me/#meattention)
- [`me.email.change`](/reference/operations/me/#meemailchange)
- [`me.email.confirm`](/reference/operations/me/#meemailconfirm)
- [`me.deleteAccount`](/reference/operations/me/#medeleteaccount)
- [`me.get`](/reference/operations/me/#meget)
- [`me.update`](/reference/operations/me/#meupdate)
- [`me.sessions.list`](/reference/operations/me/#mesessionslist)
- [`me.sessions.revoke`](/reference/operations/me/#mesessionsrevoke)
- [`me.contact.choices`](/reference/operations/me/#mecontactchoices)
- [`me.contact.setChoices`](/reference/operations/me/#mecontactsetchoices)
- [`me.family`](/reference/operations/me/#mefamily)
- [`my.list`](/reference/operations/my/#mylist)
- [`subscription.list`](/reference/operations/subscription/#subscriptionlist)
- [`subscription.portal`](/reference/operations/subscription/#subscriptionportal)
- [`order.checkout`](/reference/operations/order/#ordercheckout)
- [`me.agreements.due`](/reference/operations/me/#meagreementsdue)
- [`me.agreements.list`](/reference/operations/me/#meagreementslist)
- [`me.agreements.get`](/reference/operations/me/#meagreementsget)
- [`me.agreements.accept`](/reference/operations/me/#meagreementsaccept)

Source: [blocks/web-account](https://github.com/timoconnellaus/composable-os/tree/main/blocks/web-account).
