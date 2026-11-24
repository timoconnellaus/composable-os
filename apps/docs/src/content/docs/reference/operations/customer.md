---
title: "customer.* operations"
description: "The core operations named customer.*"
sidebar:
  label: "customer"
editUrl: false
---

## customer.disable

Disable a customer account: it can no longer sign in, and every session it has ends at once. Its Person and records are kept. Undo with customer.enable. Admins only, humans only.

|  |  |
| --- | --- |
| Permission | `users:manage` |
| Risk | `write` |
| Audiences | `staff` |
| Actors | `human` |
| Also | not offered to MCP clients (`mcp.expose: false`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes | min length 1, max length 64 | Customer account id (cus_…) |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `personId` | string or null | yes |   |   |
| `email` | string | yes |   |   |
| `status` | `"active"`, `"disabled"` | yes |   |   |
| `linkState` | `"linked"`, `"needs_merge"` | yes |   |   |
| `createdAt` | string | yes |   |   |
| `lastSignInAt` | string or null | yes |   |   |
| `sessions` | number | yes |   |   |
| `sessionsEnded` | number | yes |   |   |

## customer.enable

Enable a disabled customer account, so it can sign in again (with a new code). Admins only, humans only.

|  |  |
| --- | --- |
| Permission | `users:manage` |
| Risk | `write` |
| Audiences | `staff` |
| Actors | `human` |
| Also | not offered to MCP clients (`mcp.expose: false`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes | min length 1, max length 64 | Customer account id (cus_…) |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `personId` | string or null | yes |   |   |
| `email` | string | yes |   |   |
| `status` | `"active"`, `"disabled"` | yes |   |   |
| `linkState` | `"linked"`, `"needs_merge"` | yes |   |   |
| `createdAt` | string | yes |   |   |
| `lastSignInAt` | string or null | yes |   |   |
| `sessions` | number | yes |   |   |
| `sessionsEnded` | number | yes |   |   |

## customer.invite

Invite an email address to sign up for a customer account while sign-up is invite only (renewing an earlier invite). Sends nothing: the person requests a sign-in code themselves. Refused for an erased person's address. Admins only, humans only.

|  |  |
| --- | --- |
| Permission | `users:manage` |
| Risk | `write` |
| Audiences | `staff` |
| Actors | `human` |
| Also | not offered to MCP clients (`mcp.expose: false`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `email` | string | yes | max length 320 | The address to invite |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `email` | string | yes |   |   |

## customer.list

List the org's customer accounts (people outside the org who can sign in to a client app), newest first: address, linked Person, status, when they last signed in and how many sessions are open. Filter by personId (a Person's account) or status. Admins only. Read-only.

|  |  |
| --- | --- |
| Permission | `users:manage` |
| Risk | `read` |
| Audiences | `staff` |
| Actors | `human` |
| Also | not offered to MCP clients (`mcp.expose: false`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `personId` | string |   | max length 64 | Only the account linked to this Person |
| `status` | `"active"`, `"disabled"` |   |   |   |
| `cursor` | string |   | max length 1000 |   |
| `limit` | integer |   | ≥ 1, ≤ 200, default `50` |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `items` | array of object | yes |   |   |
| `items[].id` | string | yes |   |   |
| `items[].personId` | string or null | yes |   |   |
| `items[].email` | string | yes |   |   |
| `items[].status` | `"active"`, `"disabled"` | yes |   |   |
| `items[].linkState` | `"linked"`, `"needs_merge"` | yes |   |   |
| `items[].createdAt` | string | yes |   |   |
| `items[].lastSignInAt` | string or null | yes |   |   |
| `items[].sessions` | number | yes |   |   |
| `nextCursor` | string or null | yes |   |   |

## customer.revokeSessions

Sign a customer out everywhere: every session of the account ends. The account stays active and can sign in again. Admins only, humans only.

|  |  |
| --- | --- |
| Permission | `users:manage` |
| Risk | `write` |
| Audiences | `staff` |
| Actors | `human` |
| Also | not offered to MCP clients (`mcp.expose: false`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes | min length 1, max length 64 | Customer account id (cus_…) |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `sessionsEnded` | number | yes |   |   |

## customer.settings.get

Get the customer account settings: whether customer sign-up is open or invite only, whether anyone starting a subscription may sign in too (and whether a plan is on sale), how many days staff have to action a deleted account's erase request, how many days ahead a customer's Needs your attention looks, which email connection the host's mail goes out from, and whether sign-in codes go out through it now (signInMail: not until an admin lets its sign-in kind apply without review). Read-only.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `read` |
| Audiences | `staff` |

### Input

No fields.

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `signup` | `"open"`, `"buyers"`, `"invite_only"` | yes |   | Who may sign in as a customer. invite_only (the default): an address staff invited or that has an account. buyers: those, and the buyer's address of any order that was paid (in full or in part, even if refunded since). open: anyone who verifies an email address. |
| `startingSubscription` | boolean | yes |   | On top of signup: anyone starting a subscription (default false). While the host has a subscription plan on sale to the public, any address with no account may get a sign-in code and so a customer account, to start the plan signed in with its free trial. In effect, anyone can make an account while a plan is on sale, including people already in the records (a contact, a past buyer), who then see their own orders, tickets and subscriptions. Sign-up opens the moment a plan goes on sale, whoever publishes or prices it; admins are told when it does. Kept when signup is open, and applies again if the mode changes back. |
| `eraseDueDays` | integer | yes | ≥ 1, ≤ 365 | Days staff have to erase the person or decline, after a customer deletes their account (default 30). Admins are notified daily about a request past it. |
| `attentionDays` | integer | yes | ≥ 1, ≤ 30 | account.attentionDays: how many days ahead a customer's Needs your attention (me.attention) lists a pass about to expire with uses left and a free trial about to end (default 7, 1 to 30). |
| `emailConnectionId` | string or null | yes |   | The org email-send connection (con_…) the host's mail goes out from: customer and staff sign-in codes, invite notices and a declined erase request. The host sends it itself, as no staff member. Null: nobody can sign in by code, and is told sign-in is not set up. |
| `signInMail` | object | yes |   |   |
| `signInMail.kind` | object or null | yes |   |   |
| `signInMail.kind.tag` | string | yes |   |   |
| `signInMail.kind.label` | string | yes |   |   |
| `signInMail.autoApproved` | boolean | yes |   |   |
| `signInMail.ready` | boolean | yes |   |   |
| `signInMail.problem` | string or null | yes |   |   |
| `planOnSale` | boolean | yes |   | A subscription plan is on sale to the public now, so startingSubscription lets new addresses sign in |

## customer.settings.update

Change whether customer sign-up is open or invite only, whether anyone starting a subscription may sign in too, the days staff have to action an erase request, the days ahead a customer's Needs your attention looks, or the email connection customer mail goes out from. Only what you pass changes. Admins only, and only a human can call it: AI assistants, MCP clients, automations and extensions are refused.

|  |  |
| --- | --- |
| Permission | `settings:manage` |
| Risk | `write` |
| Audiences | `staff` |
| Actors | `human` |
| Also | not offered to MCP clients (`mcp.expose: false`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `signup` | `"open"`, `"buyers"`, `"invite_only"` |   |   | Who may sign in as a customer. invite_only (the default): an address staff invited or that has an account. buyers: those, and the buyer's address of any order that was paid (in full or in part, even if refunded since). open: anyone who verifies an email address. |
| `startingSubscription` | boolean |   |   | On top of signup: anyone starting a subscription (default false). While the host has a subscription plan on sale to the public, any address with no account may get a sign-in code and so a customer account, to start the plan signed in with its free trial. In effect, anyone can make an account while a plan is on sale, including people already in the records (a contact, a past buyer), who then see their own orders, tickets and subscriptions. Sign-up opens the moment a plan goes on sale, whoever publishes or prices it; admins are told when it does. Kept when signup is open, and applies again if the mode changes back. |
| `eraseDueDays` | integer |   | ≥ 1, ≤ 365 | Days staff have to erase the person or decline, after a customer deletes their account (default 30). Admins are notified daily about a request past it. |
| `attentionDays` | integer |   | ≥ 1, ≤ 30 | account.attentionDays: how many days ahead a customer's Needs your attention (me.attention) lists a pass about to expire with uses left and a free trial about to end (default 7, 1 to 30). |
| `emailConnectionId` | string or null |   |   | The org email-send connection (con_…) the host's mail goes out from: customer and staff sign-in codes, invite notices and a declined erase request. The host sends it itself, as no staff member. Null: nobody can sign in by code, and is told sign-in is not set up. |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `signup` | `"open"`, `"buyers"`, `"invite_only"` | yes |   | Who may sign in as a customer. invite_only (the default): an address staff invited or that has an account. buyers: those, and the buyer's address of any order that was paid (in full or in part, even if refunded since). open: anyone who verifies an email address. |
| `startingSubscription` | boolean | yes |   | On top of signup: anyone starting a subscription (default false). While the host has a subscription plan on sale to the public, any address with no account may get a sign-in code and so a customer account, to start the plan signed in with its free trial. In effect, anyone can make an account while a plan is on sale, including people already in the records (a contact, a past buyer), who then see their own orders, tickets and subscriptions. Sign-up opens the moment a plan goes on sale, whoever publishes or prices it; admins are told when it does. Kept when signup is open, and applies again if the mode changes back. |
| `eraseDueDays` | integer | yes | ≥ 1, ≤ 365 | Days staff have to erase the person or decline, after a customer deletes their account (default 30). Admins are notified daily about a request past it. |
| `attentionDays` | integer | yes | ≥ 1, ≤ 30 | account.attentionDays: how many days ahead a customer's Needs your attention (me.attention) lists a pass about to expire with uses left and a free trial about to end (default 7, 1 to 30). |
| `emailConnectionId` | string or null | yes |   | The org email-send connection (con_…) the host's mail goes out from: customer and staff sign-in codes, invite notices and a declined erase request. The host sends it itself, as no staff member. Null: nobody can sign in by code, and is told sign-in is not set up. |
| `previous` | object | yes |   |   |
| `previous.signup` | `"open"`, `"buyers"`, `"invite_only"` | yes |   | Who may sign in as a customer. invite_only (the default): an address staff invited or that has an account. buyers: those, and the buyer's address of any order that was paid (in full or in part, even if refunded since). open: anyone who verifies an email address. |
| `previous.startingSubscription` | boolean | yes |   | On top of signup: anyone starting a subscription (default false). While the host has a subscription plan on sale to the public, any address with no account may get a sign-in code and so a customer account, to start the plan signed in with its free trial. In effect, anyone can make an account while a plan is on sale, including people already in the records (a contact, a past buyer), who then see their own orders, tickets and subscriptions. Sign-up opens the moment a plan goes on sale, whoever publishes or prices it; admins are told when it does. Kept when signup is open, and applies again if the mode changes back. |
| `previous.eraseDueDays` | integer | yes | ≥ 1, ≤ 365 | Days staff have to erase the person or decline, after a customer deletes their account (default 30). Admins are notified daily about a request past it. |
| `previous.attentionDays` | integer | yes | ≥ 1, ≤ 30 | account.attentionDays: how many days ahead a customer's Needs your attention (me.attention) lists a pass about to expire with uses left and a free trial about to end (default 7, 1 to 30). |
| `previous.emailConnectionId` | string or null | yes |   | The org email-send connection (con_…) the host's mail goes out from: customer and staff sign-in codes, invite notices and a declined erase request. The host sends it itself, as no staff member. Null: nobody can sign in by code, and is told sign-in is not set up. |
