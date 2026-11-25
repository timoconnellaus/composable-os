---
title: "native-account-contact"
description: "Contact preferences (stage 30, ADR 0675), for the mobile app: each kind of message the signed-in customer may get, on each channel it goes by, and the same for each child they act for."
editUrl: false
---

Contact preferences (stage 30, ADR 0675), for the mobile app: each kind of message the signed-in customer may get, on each channel it goes by, and the same for each child they act for. A tap turns one channel on or off (news and offers: yes or no, with the words shown). What may change is the host's answer (me.contact.choices, me.contact.setChoices): a booking's or a payment's email is always sent and shows as such; a child is never asked about news and offers.

|  |  |
| --- | --- |
| Skin | native |
| Pack | the base layer |
| Add it | `cos add native-account-contact` |
| Files | `contact.tsx`, `LICENSE` |
| Depends on | [native-base](/reference/blocks/native-base/) |
| Packages | `@composable-os/client` |

## Operations it calls

Through its hooks; the host decides what each caller may do.

- [`me.contact.choices`](/reference/operations/me/#mecontactchoices)
- [`me.contact.setChoices`](/reference/operations/me/#mecontactsetchoices)

Source: [blocks/native-account-contact](https://github.com/timoconnellaus/composable-os/tree/main/blocks/native-account-contact).
