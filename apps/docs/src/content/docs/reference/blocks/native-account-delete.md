---
title: "native-account-delete"
description: "Delete my account (stage 48), for the mobile app: the same two steps as the web's (`web-account-delete`), in the app (ADR 0714: deleting is not money, so it works here)."
editUrl: false
---

Delete my account (stage 48), for the mobile app: the same two steps as the web's (`web-account-delete`), in the app (ADR 0714: deleting is not money, so it works here). First the host says what deleting will do and the block shows all of it; then, deliberately, they type DELETE and confirm, and the host does exactly what it showed (the preview's `expect`). A preview that changed meanwhile is shown again. Nothing is deleted by the block's own logic: without a preview there is nothing to confirm (`deleteConfirmInput`). The amounts shown are the subscriptions that end, as the host gave them; nothing here takes a payment. When the host says `sign_in_again`, the block signs the customer in again in place and asks for the preview again. Once the host has deleted the account (and ended every session), the block calls `endSession` at once (the app's `session.signOut`: it forgets the tokens in the secure store), and the hooks forget the app's query cache when made with its `useQueryClient`. What the app must still do, in `onDeleted`: go back to its sign-in screen (the device is already signed out).

<img class="cos-screen cos-screen-native" src="/screens/native-account-delete.png" alt="native-account-delete, drawn with dummy data" width="390" height="844" loading="lazy" decoding="async" />

Drawn with dummy data.

|  |  |
| --- | --- |
| Skin | native |
| Pack | the base layer |
| Add it | `cos add native-account-delete` |
| Files | `delete.tsx`, `LICENSE` |
| Depends on | [native-account-email](/reference/blocks/native-account-email/), [native-base](/reference/blocks/native-base/) |
| Packages | `@composable-os/client` |

## Operations it calls

Through its hooks; the host decides what each caller may do.

- [`me.get`](/reference/operations/me/#meget)
- [`me.deleteAccount`](/reference/operations/me/#medeleteaccount)

Source: [blocks/native-account-delete](https://github.com/timoconnellaus/composable-os/tree/main/blocks/native-account-delete).
