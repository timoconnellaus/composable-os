---
title: "user.* operations"
description: "The core operations named user.*"
sidebar:
  label: "user"
editUrl: false
---

## user.confirmEmail

Confirm your own email address with the code user.sendEmailConfirmation sent to it. A wrong code counts one of three tries. Your own account only; a person only.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `write` |
| Audiences | `staff` |
| Actors | `human` |
| Also | bookkeeping, never queued for review; not offered to MCP clients (`mcp.expose: false`) |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `code` | string | yes | pattern `^\d{6}$` |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `confirmed` | boolean | yes |   |   |
| `email` | string | yes |   |   |

## user.deactivate

Deactivate a person who left: they can no longer sign in or act, and every automation bound to one of their connections is paused (its binding revoked) with a notice to the admins. Admins only; people only. You cannot deactivate yourself or the last admin. Someone on future shifts or regular patterns is refused with their count (rule deactivate_confirm) and the list: pass confirm with that count and they are taken off each (now with nobody on it), their open offers are cancelled and the rosterers are told. Past shifts keep them.

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
| `id` | string | yes | min length 1, max length 64 | User id (usr_…) |
| `confirm` | integer |   | ≥ 0, ≤ 9007199254740991 | Their future shifts and patterns, as the refusal counted them |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `deactivatedAt` | string or null | yes |   |   |
| `pausedAutomations` | array of string | yes |   |   |
| `roster` | object | yes |   |   |
| `roster.shifts` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |
| `roster.patterns` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |
| `roster.offers` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |

## user.emailStatus

Your own email address, whether it is confirmed, and whether sign-in codes can be sent now. Sign-in by an emailed code (and `cos content import --email`) works only for a confirmed address. Read-only, your own account only.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `read` |
| Audiences | `staff` |
| Actors | `human` |
| Also | not offered to MCP clients (`mcp.expose: false`) |

### Input

No fields.

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `email` | string | yes |   |   |
| `verified` | boolean | yes |   |   |
| `signInMail` | object | yes |   |   |
| `signInMail.ready` | boolean | yes |   |   |
| `signInMail.problem` | string or null | yes |   |   |

## user.grantablePermissions

List the permissions an admin can grant a staff account one by one, on top of its role: publishing versions of programs and other publishable records, refunding orders, and the tool permissions installed packs declare grantable. An account with a pack's fixed role may be granted the packs' permissions only (forFixedRole). Read-only.

|  |  |
| --- | --- |
| Permission | `users:manage` |
| Risk | `read` |
| Audiences | `staff` |
| Also | not offered to MCP clients (`mcp.expose: false`) |

### Input

No fields.

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `items` | array of object | yes |   |   |
| `items[].permission` | string | yes |   |   |
| `items[].label` | string | yes |   |   |
| `items[].from` | string | yes |   |   |
| `items[].forFixedRole` | boolean | yes |   | Whether an account with a pack's fixed role may be granted it (ADR 0600) |
| `items[].restricted` | boolean | yes |   | Held by admins and by grant only: no member holds it otherwise, and nobody grants it to themselves (ADR 0625) |

## user.invite

Invite a person to a staff account by email, with the role, and optionally the pack role and permissions, the account will hold from the start. With the built-in sign-in they accept by signing in with a code emailed to that address; under Cloudflare Access, by their first visit once Access lets them in. Sign-up stays closed to everyone else. An address with an account cannot be invited; inviting an address again replaces its pending invite. Expires in 7 days. Admins only, and only a human can call it.

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
| `email` | string | yes | min length 3, max length 254 | Their email address |
| `role` | `"admin"`, `"member"`, `"viewer"` |   | default `"member"` | The account's role: admin, member or viewer |
| `packRole` | string or null |   | default `null` | A pack's fixed role (`ticketing.door`), or null. Makes the role viewer. |
| `permissions` | array of string |   | at most 20, default `[]` | Permissions granted one by one (user.grantablePermissions lists them) |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `email` | string | yes |   |   |
| `role` | `"admin"`, `"member"`, `"viewer"` | yes |   |   |
| `packRole` | string or null | yes |   |   |
| `permissions` | array of string | yes |   |   |
| `invitedBy` | string | yes |   |   |
| `createdAt` | string | yes |   |   |
| `expiresAt` | string | yes |   |   |
| `status` | `"pending"`, `"expired"` | yes |   |   |
| `signIn` | `"code"`, `"access"` | yes |   |   |
| `invitationEmail` | `"sent"`, `"pending"`, `"not_sent"`, `"not_needed"` | yes |   |   |

## user.invites

List the invites for staff accounts that have not been accepted or revoked, with the role, pack role and permissions each will give, and whether it has expired. Admins only. Read-only.

|  |  |
| --- | --- |
| Permission | `users:manage` |
| Risk | `read` |
| Audiences | `staff` |
| Actors | `human` |
| Also | not offered to MCP clients (`mcp.expose: false`) |

### Input

No fields.

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `items` | array of object | yes |   |   |
| `items[].id` | string | yes |   |   |
| `items[].email` | string | yes |   |   |
| `items[].role` | `"admin"`, `"member"`, `"viewer"` | yes |   |   |
| `items[].packRole` | string or null | yes |   |   |
| `items[].permissions` | array of string | yes |   |   |
| `items[].invitedBy` | string | yes |   |   |
| `items[].createdAt` | string | yes |   |   |
| `items[].expiresAt` | string | yes |   |   |
| `items[].status` | `"pending"`, `"expired"` | yes |   |   |

## user.list

List the CRM's users (people who can sign in) with their role: admin, member or viewer. Use it to find a user id for an owner or assignee. Filter with structured filter JSON over id, name, email, role and createdAt; sort by any of them (default name). Read-only.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `read` |
| Audiences | `staff` |

### Input

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `filter` | any |   |   | Structured filter: { and \| or: [...] } of { field, op, value }. |
| `sort` | object |   |   | Sort field and direction. Defaults per object. |
| `sort.field` | string | yes | min length 1, max length 64 |   |
| `sort.direction` | `"asc"`, `"desc"` |   | default `"asc"` |   |
| `cursor` | string |   | max length 1000 | nextCursor from the previous page. |
| `limit` | integer |   | ≥ 1, ≤ 200, default `50` |   |
| `fields` | array of string |   | at most 100 | Return only these fields of each item (id is always included). |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `items` | array of object | yes |   |   |
| `items[].id` | string | yes |   |   |
| `items[].name` | string |   |   |   |
| `items[].email` | string |   |   |   |
| `items[].role` | `"admin"`, `"member"`, `"viewer"` |   |   |   |
| `items[].packRole` | string or null |   |   |   |
| `items[].permissions` | array of string |   |   |   |
| `items[].image` | string or null |   |   |   |
| `items[].createdAt` | string |   |   |   |
| `nextCursor` | string or null | yes |   |   |

## user.me

The signed-in staff account: id, name, role, the permissions granted to it one by one, and every permission it holds (its role's and its grants). For an app to offer what the account may do (publish a program); the host still decides each call. Read-only.

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
| `id` | string | yes |   |   |
| `name` | string | yes |   |   |
| `role` | `"admin"`, `"member"`, `"viewer"` | yes |   |   |
| `granted` | array of string | yes |   |   |
| `permissions` | array of string | yes |   |   |

## user.packRoles

List the fixed staff roles the installed packs declare that an admin can give to a staff account (for example Ticketing's door role: check tickets in and read events, ticket types and tickets, nothing else), with what each holds. Read-only.

|  |  |
| --- | --- |
| Permission | `users:manage` |
| Risk | `read` |
| Audiences | `staff` |
| Also | not offered to MCP clients (`mcp.expose: false`) |

### Input

No fields.

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `items` | array of object | yes |   |   |
| `items[].name` | string | yes |   |   |
| `items[].label` | string | yes |   |   |
| `items[].description` | string | yes |   |   |
| `items[].permissions` | array of string | yes |   |   |
| `items[].read` | array of string | yes |   |   |

## user.reactivate

Let a deactivated person sign in again. Bindings revoked when they were deactivated stay revoked: automations need their connections bound again. Admins only; people only.

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
| `id` | string | yes | min length 1, max length 64 |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `deactivatedAt` | string or null | yes |   |   |
| `pausedAutomations` | array of string | yes |   |   |
| `roster` | object | yes |   |   |
| `roster.shifts` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |
| `roster.patterns` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |
| `roster.offers` | integer | yes | ≥ -9007199254740991, ≤ 9007199254740991 |   |

## user.revokeInvite

Revoke a pending staff invite: its address can no longer get a sign-in code or an account from it. Admins only, and only a human can call it.

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
| `id` | string | yes | min length 1, max length 64 | Invite id (uin_…) |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `revokedAt` | string | yes |   |   |

## user.sendEmailConfirmation

Email a six-digit code to your own address, to confirm it (user.confirmEmail). Sent as the host's sign-in mail, so it needs that to be set up. Your own account only; a person only.

|  |  |
| --- | --- |
| Permission | `records:read` |
| Risk | `write` |
| Audiences | `staff` |
| Actors | `human` |
| Also | bookkeeping, never queued for review; not offered to MCP clients (`mcp.expose: false`) |

### Input

No fields.

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `sentTo` | string | yes |   |   |
| `expiresAt` | string | yes |   |   |

## user.setPackRole

Give a staff account one fixed role a pack declares (user.packRoles lists them), or take it away with role null. While an account holds one, it may do exactly what the role lists, and what the pack permissions granted to it open (user.setPermissions), and nothing else, whatever its own role; its role is set to viewer. An admin cannot be given one (change their role first), nor an account granted a core permission (take it away first). Admins only, and only a human can call it. Returns the user.

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
| `id` | string | yes | min length 1, max length 64 | User id (usr_…) |
| `role` | string or null | yes |   | The pack role, `<pack>.<role>` (`ticketing.door`), or null to remove it |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `name` | string | yes |   |   |
| `email` | string | yes |   |   |
| `role` | `"admin"`, `"member"`, `"viewer"` | yes |   |   |
| `packRole` | string or null | yes |   |   |
| `permissions` | array of string | yes |   |   |
| `image` | string or null | yes |   |   |
| `createdAt` | string | yes |   |   |
| `previousPackRole` | string or null | yes |   |   |

## user.setPermissions

Set the permissions a staff account is granted one by one, on top of its role (user.grantablePermissions lists them; an empty list takes them all away). A member granted records:publish publishes programs; one granted orders:refund approves refunds. A grant never lets an AI assistant or MCP client do what only a person may. An account with a pack's fixed role may be granted the packs' permissions (a coach given the Bookings desk) and agreements:desk only, which add up with the role. Admins only, and only a human can call it. Returns the user.

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
| `id` | string | yes | min length 1, max length 64 | User id (usr_…) |
| `permissions` | array of string | yes | at most 20 |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `name` | string | yes |   |   |
| `email` | string | yes |   |   |
| `role` | `"admin"`, `"member"`, `"viewer"` | yes |   |   |
| `packRole` | string or null | yes |   |   |
| `permissions` | array of string | yes |   |   |
| `image` | string or null | yes |   |   |
| `createdAt` | string | yes |   |   |
| `previousPermissions` | array of string | yes |   |   |

## user.updateInvite

Change what a pending staff invite will give: its role, pack role and permissions (checked as user.setPackRole and user.setPermissions check them). Admins only, and only a human can call it. Returns the invite.

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
| `id` | string | yes | min length 1, max length 64 | Invite id (uin_…) |
| `role` | `"admin"`, `"member"`, `"viewer"` |   | default `"member"` | The account's role: admin, member or viewer |
| `packRole` | string or null |   | default `null` | A pack's fixed role (`ticketing.door`), or null. Makes the role viewer. |
| `permissions` | array of string |   | at most 20, default `[]` | Permissions granted one by one (user.grantablePermissions lists them) |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `email` | string | yes |   |   |
| `role` | `"admin"`, `"member"`, `"viewer"` | yes |   |   |
| `packRole` | string or null | yes |   |   |
| `permissions` | array of string | yes |   |   |
| `invitedBy` | string | yes |   |   |
| `createdAt` | string | yes |   |   |
| `expiresAt` | string | yes |   |   |
| `status` | `"pending"`, `"expired"` | yes |   |   |

## user.updateRole

Change a user's role: admin (everything, including erase, users and the approval policy), member (read and write records) or viewer (read only). Admins only, and only a human can call it. The last admin cannot be demoted. Returns the user.

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
| `id` | string | yes | min length 1, max length 64 | User id (usr_…) |
| `role` | `"admin"`, `"member"`, `"viewer"` | yes |   |   |

### Output

| Field | Type | Required | Limits | Description |
| --- | --- | --- | --- | --- |
| `id` | string | yes |   |   |
| `name` | string | yes |   |   |
| `email` | string | yes |   |   |
| `role` | `"admin"`, `"member"`, `"viewer"` | yes |   |   |
| `packRole` | string or null | yes |   |   |
| `permissions` | array of string | yes |   |   |
| `image` | string or null | yes |   |   |
| `createdAt` | string | yes |   |   |
| `previousRole` | `"admin"`, `"member"`, `"viewer"` | yes |   |   |
