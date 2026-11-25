---
title: "web-account-delete"
description: "Delete my account (stage 48), for the web."
editUrl: false
---

Delete my account (stage 48), for the web. Two steps, both the host's (me.deleteAccount, ADR 0713): first the host says what deleting will do, and the block shows all of it (each subscription they pay and how it ends, nothing refunded; their unpaid orders cancelled; what stays for the business to decide; by when their data is erased); then, deliberately, they type DELETE and confirm, and the host does exactly what it showed (the preview's `expect`). A preview that changed meanwhile is the host's conflict: the block asks for it again and shows the new one. Nothing is deleted by the block's own logic: without a preview there is nothing to confirm (`deleteConfirmInput`). The host keeps it to a sign-in within the last 15 minutes, the preview too. When it says `sign_in_again`, the block signs the customer in again in place (`SignInAgain`) and carries on. Once the host has deleted the account it has also ended every session, this browser's cookie with them. At once, `useDeleteAccount` forgets every query in the app's cache (when the app made the hooks with its `useQueryClient`: `createAccountHooks({ useQuery, useMutation, useQueryClient }, api)`), so nothing of the account stays in memory. What the app must still do, in `onDeleted`: leave the page (the template goes to its home page with a full load).

<img class="cos-screen" src="/screens/web-account-delete.png" alt="web-account-delete, drawn with dummy data" width="720" height="442" loading="lazy" decoding="async" />

Drawn with dummy data.

|  |  |
| --- | --- |
| Skin | web |
| Pack | the base layer |
| Add it | `cos add web-account-delete` |
| Files | `delete.tsx`, `LICENSE` |
| Depends on | [web-account-email](/reference/blocks/web-account-email/), [ui-button](/reference/blocks/ui-button/), [ui-input](/reference/blocks/ui-input/), [ui-label](/reference/blocks/ui-label/) |
| Packages | `@composable-os/client` |

## Operations it calls

Through its hooks; the host decides what each caller may do.

- [`me.get`](/reference/operations/me/#meget)
- [`me.deleteAccount`](/reference/operations/me/#medeleteaccount)

Source: [blocks/web-account-delete](https://github.com/timoconnellaus/composable-os/tree/main/blocks/web-account-delete).
