---
title: "native-account"
description: "My account (stage 48), for the mobile app's Account tab: the signed-in customer's own area, a list of sections, each opening on its own screen."
editUrl: false
---

My account (stage 48), for the mobile app's Account tab: the signed-in customer's own area, a list of sections, each opening on its own screen. The base sections come with it: Orders, Agreements, Family, Payment method (only for someone who pays a subscription), Your details, Contact preferences (stage 30) and Sign-in and devices. The packs' sections are passed in `sections`, each the pack's own screen, and take their place by `order` (a pack's come first). Money in the app is the website's (ADR 0490, ADR 0714): the app shows orders and subscriptions, and the card, cancelling and changing plan open the business's website account page in the browser (`websiteUrl`). No block here calls a billing operation. Which sections this customer has, in what order, and whether Payment method shows is the host's answer (me.portal, ADR 0710). `cos add native-account` copies the packs' section blocks and writes `../account-sections.gen.ts`, which names them; the tab passes them through `usePackSections(ACCOUNT_SECTIONS, react, api)`, so it names no pack. A pack's screen is given `onManage`, which opens the website account page. "Needs your attention" sits at the top (me.attention, ADR 0711), each item opening the section that deals with it. Changing the sign-in address (under Your details) and Delete my account work in the app; when the host asks for a recent sign-in, they sign the customer in again in place through `signIn` (ADR 0712). Once the account is deleted, the shell's `endSession` (the app's `session.signOut`) forgets this device's tokens at once; the app's `onDeleted` then goes back to sign-in. Money owed on an order opens the website, as the card does. A base section the host lists that this copy draws nothing for (added to the platform later) is left out (`portalSections`' `base`).

<img class="cos-screen cos-screen-native" src="/screens/native-account.png" alt="native-account, drawn with dummy data" width="390" height="844" loading="lazy" decoding="async" />

Drawn with dummy data.

|  |  |
| --- | --- |
| Skin | native |
| Pack | the base layer |
| Add it | `cos add native-account` |
| Files | `account-screen.tsx`, `LICENSE` |
| Depends on | [native-account-attention](/reference/blocks/native-account-attention/), [native-account-delete](/reference/blocks/native-account-delete/), [native-account-contact](/reference/blocks/native-account-contact/), [native-account-details](/reference/blocks/native-account-details/), [native-account-devices](/reference/blocks/native-account-devices/), [native-account-family](/reference/blocks/native-account-family/), [native-account-orders](/reference/blocks/native-account-orders/), [native-account-payment](/reference/blocks/native-account-payment/), [native-my-agreements](/reference/blocks/native-my-agreements/), [native-base](/reference/blocks/native-base/) |
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
- [`me.agreements.due`](/reference/operations/me/#meagreementsdue)
- [`me.agreements.list`](/reference/operations/me/#meagreementslist)
- [`me.agreements.get`](/reference/operations/me/#meagreementsget)
- [`me.agreements.accept`](/reference/operations/me/#meagreementsaccept)

Source: [blocks/native-account](https://github.com/timoconnellaus/composable-os/tree/main/blocks/native-account).
